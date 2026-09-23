// 后台不计时（C1）：切到别的应用/锁屏时，请求超时不该继续走。
// 回归背景：后台会节流甚至冻结 WebView 的 JS，定时器不按时触发；回到前台的瞬间
// 逾时的定时器集体触发 → 还在跑的流式请求被误判成「请求超时/输出中断」并失败。
// 现在：总超时只累计"前台可见"时长；空闲超时在隐藏期间挂起，回到前台重新开始计。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/preset';
import '../src/domain/modelcompat';
import { APIHandler, createVisibleBudget, pageVisible } from '../src/domain/api';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const origDoc = g.document;
g.App = { toast: () => {}, getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 }) };

const CFG = { endpoint: 'https://ep.example/v1', apiKey: 'k1', model: 'm1', maxTokens: 8000, temperature: 0.9, topK: 40 };

// 读到第一帧后挂住的流（模拟"系统把网线拔了"）：把 signal 接到流上，
// 这样"超时 abort → 读流报 AbortError"这条真实链路在测试里也能走通
// （手工构造的 ReadableStream 不会自己理会 signal，必须显式接线）。
function pendingStreamResponse(signal?: AbortSignal): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"部分"}}]}\n\n'));
      if (signal) signal.addEventListener('abort', () => { try { c.error(new DOMException('Aborted', 'AbortError')); } catch (e) { /* 已关闭 */ } });
    }
  });
  return new Response(body, { status: 200 });
}
function stubFetch() {
  g.fetch = vi.fn((_url: string, init?: { signal?: AbortSignal }) => Promise.resolve(pendingStreamResponse(init && init.signal)));
}

// 可控 document：visibilityState + 事件分发
function installDoc(state: string) {
  const handlers: Record<string, Array<() => void>> = {};
  g.document = {
    visibilityState: state,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (ev: string, fn: () => void) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    removeEventListener: (ev: string, fn: () => void) => { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
  };
  const fire = (state: string) => {
    g.document.visibilityState = state;
    (handlers.visibilitychange || []).slice().forEach((f) => f());
  };
  return {
    hide() { fire('hidden'); },
    show() { fire('visible'); },
    listenerCount() { return (handlers.visibilitychange || []).length; },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  g.document = origDoc;
});

describe('createVisibleBudget：只累计可见时长', () => {
  it('可见时增长，隐藏期间冻结，回来接着算', () => {
    const b = createVisibleBudget(0, true);
    expect(b.elapsed(3000)).toBe(3000);
    b.hide(3000);
    expect(b.elapsed(90000)).toBe(3000);   // 隐藏 87s 不计
    b.show(90000);
    expect(b.elapsed(90500)).toBe(3500);
    b.hide(90500);
    expect(b.elapsed(200000)).toBe(3500);
  });

  it('可见性没变化时重复调用不重复累计', () => {
    const b = createVisibleBudget(0, true);
    b.hide(1000); b.hide(5000);
    expect(b.elapsed(9000)).toBe(1000);
    b.show(9000); b.show(12000);
    expect(b.elapsed(13000)).toBe(1000 + 4000);
  });
});

describe('pageVisible：无 document 的环境按可见处理', () => {
  it('node 环境（无 visibilityState）→ true', () => {
    const saved = g.document;
    g.document = { getElementById: () => null };
    expect(pageVisible()).toBe(true);
    g.document = saved;
  });

  it('跟随 document.visibilityState', () => {
    const doc = installDoc('hidden');
    expect(pageVisible()).toBe(false);
    doc.show();
    expect(pageVisible()).toBe(true);
  });
});

describe('fetchCompletions：切后台不消耗超时预算', () => {
  it('总超时：隐藏期间不触发，回到前台按剩余预算继续计', async () => {
    const doc = installDoc('visible');
    stubFetch();
    const errors: string[] = [];
    void APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, (e: string) => errors.push(e),
      { apiConfig: CFG, timeout: 5000, idleTimeout: 0 });

    await vi.advanceTimersByTimeAsync(1000);   // 可见 1s（预算剩 4s）
    doc.hide();
    await vi.advanceTimersByTimeAsync(60000);  // 后台 60s：不该超时
    expect(errors).toEqual([]);
    doc.show();
    await vi.advanceTimersByTimeAsync(3000);   // 又可见 3s（共 4s，仍未到 5s）
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(2500);   // 越过 5s 预算
    expect(errors[0]).toContain('请求超时');
  });

  it('空闲超时：隐藏期间挂起，回到前台重新给一个完整窗口', async () => {
    const doc = installDoc('visible');
    stubFetch();
    const errors: string[] = [];
    void APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, (e: string) => errors.push(e),
      { apiConfig: CFG, timeout: 0, idleTimeout: 5000 });

    await vi.advanceTimersByTimeAsync(200);
    doc.hide();
    await vi.advanceTimersByTimeAsync(120000);  // 后台 2 分钟：不该判"无响应"
    expect(errors).toEqual([]);
    doc.show();
    await vi.advanceTimersByTimeAsync(4000);    // 回来 4s 无数据：仍在窗口内
    expect(errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1500);
    expect(errors[0]).toContain('长时间无响应');
  });

  it('请求结束后摘掉可见性监听（不留悬挂 handler）', async () => {
    const doc = installDoc('visible');
    stubFetch();
    const errors: string[] = [];
    void APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, (e: string) => errors.push(e),
      { apiConfig: CFG, timeout: 1000, idleTimeout: 0 });
    expect(doc.listenerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(50);      // 先让响应头到达（进入读流阶段）
    doc.hide();
    doc.show();                                 // 回前台：按剩余预算重新计时
    await vi.advanceTimersByTimeAsync(1500);    // 超时 → 请求结束 → 监听摘掉
    expect(errors).toHaveLength(1);
    expect(doc.listenerCount()).toBe(0);
  });

  it('隐藏时长不计入总超时：同一次请求可见满 3s 才超时（无论中间隐藏多久）', async () => {
    const doc = installDoc('visible');
    stubFetch();
    const errors: string[] = [];
    void APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, (e: string) => errors.push(e),
      { apiConfig: CFG, timeout: 3000, idleTimeout: 0 });
    doc.hide();
    await vi.advanceTimersByTimeAsync(300000);  // 后台 5 分钟
    expect(errors).toEqual([]);
    doc.show();
    await vi.advanceTimersByTimeAsync(2500);
    expect(errors).toEqual([]);                 // 可见累计 2.5s < 3s
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors[0]).toContain('请求超时');
  });
});
