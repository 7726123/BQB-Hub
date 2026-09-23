// 反馈页（用户侧）：
//   · 300 字在客户端就卡死（按**码点**计，emoji 算 1），到上限提示"可以再发一条"；
//   · **只有服务端 2xx 才弹感谢**——429（限流）/网络失败要说实话，且输入内容保留；
//   · 不暂存、不静默补发；本机留最近 3 条（防重复提交）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/infra/storage';
import { Feedback, cpLen, FEEDBACK_MAX_LEN } from '../src/domain/feedback';
import { ensureInstallId } from '../src/domain/stats';   // 与匿名统计共用的随机标识

const g = globalThis as unknown as Record<string, any>;
const SM = () => (globalThis as unknown as { StorageManager: any }).StorageManager;

function makeEl(id: string): any {
  const store: any = {
    id, textContent: '', value: '', innerHTML: '', disabled: false, style: {},
    classList: { add: () => undefined, remove: () => undefined, toggle: () => undefined, contains: () => false },
    addEventListener: () => undefined, focus: () => undefined,
  };
  return store;
}

let els: Record<string, any> = {};
const toasts: string[] = [];
// 惰性取元素（与 feedback.ts 里 getElementById 的行为一致，避免"还没创建就赋值"）
const el = (id: string): any => (els[id] ||= makeEl(id));

beforeEach(() => {
  els = {};
  toasts.length = 0;
  g.document = { getElementById: (id: string) => (els[id] ||= makeEl(id)), addEventListener: () => undefined, querySelectorAll: () => [] };
  g.App = { toast: (m: string) => toasts.push(String(m)) };
  g.window = { Capacitor: { getPlatform: () => 'android' } };
  SM().set('communityServer', 'https://srv.test');
  for (const k of ['usageInstallId', 'feedbackMine']) SM().remove(k);
  Feedback._sending = false;
});

function mockFetch(impl: (url: string, init: any) => any) {
  const calls: Array<{ url: string; init: any }> = [];
  g.fetch = vi.fn(async (url: string, init: any) => { calls.push({ url: String(url), init }); return impl(String(url), init); });
  return calls;
}
const okRes = () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
const errRes = (status: number, error: string) => ({ ok: false, status, json: async () => ({ error }) });

describe('字数口径（码点）', () => {
  it('300 个 emoji 算 300 字，不是 600', () => {
    expect(cpLen('🙂'.repeat(300))).toBe(300);
    expect(cpLen('🙂'.repeat(301))).toBe(301);
    expect(FEEDBACK_MAX_LEN).toBe(300);
  });
});

describe('提交：三种结果分得清，且只有成功才感谢', () => {
  it('成功：请求打到 {server}/api/feedback，带安装标识与版本；清空输入 + 感谢 toast + 本机留档', async () => {
    el('fbText').value = '希望能加章节字数统计';
    const calls = mockFetch(okRes);
    const r = await Feedback.submit();
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://srv.test/api/feedback');
    const body = JSON.parse(calls[0].init.body);
    expect(body.text).toBe('希望能加章节字数统计');
    expect(body.plat).toBe('android');
    expect(body.id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);          // 与匿名统计共用同一个随机标识
    expect(body.id).toBe(ensureInstallId());
    expect(el('fbText').value).toBe('');                       // 成功后清空
    expect(toasts.some((t) => t.includes('谢谢'))).toBe(true);
    expect(Feedback.getMine().length).toBe(1);
  });

  it('限流（429）：不感谢、不清空，提示服务端给的文案', async () => {
    el('fbText').value = '再提一条';
    mockFetch(() => errRes(429, '提得太频繁了，请过一分钟再试'));
    const r = await Feedback.submit();
    expect(r.ok).toBe(false);
    expect(r.kind).toBe('rate');
    expect(toasts.length).toBe(0);                              // 没有感谢
    expect(el('fbText').value).toBe('再提一条');                // 内容还在
    expect(el('fbStatus').textContent).toContain('一分钟');
  });

  it('网络失败：不感谢、不清空，提示内容仍可复制留存', async () => {
    el('fbText').value = '断网时写的';
    mockFetch(() => { throw new Error('Failed to fetch'); });
    const r = await Feedback.submit();
    expect(r.kind).toBe('network');
    expect(toasts.length).toBe(0);
    expect(el('fbText').value).toBe('断网时写的');
    expect(el('fbStatus').textContent).toContain('没发出去');
  });

  it('服务器 5xx：按服务器错误处理，同样不感谢', async () => {
    el('fbText').value = '服务端炸了';
    mockFetch(() => errRes(500, 'store fail'));
    const r = await Feedback.submit();
    expect(r.kind).toBe('server');
    expect(toasts.length).toBe(0);
    expect(el('fbText').value).toBe('服务端炸了');
  });

  it('空内容 / 超 300 字：本地就拦住，不发请求', async () => {
    const calls = mockFetch(okRes);
    el('fbText').value = '   ';
    expect((await Feedback.submit()).kind).toBe('invalid');
    el('fbText').value = '字'.repeat(301);
    expect((await Feedback.submit()).kind).toBe('invalid');
    expect(el('fbStatus').textContent).toContain('300');
    expect(calls.length).toBe(0);
  });

  it('重复点击：提交中第二次调用直接返回，不会发两条', async () => {
    el('fbText').value = '连点测试';
    let release: any;
    const gate = new Promise((r) => { release = r; });
    const calls = mockFetch(async () => { await gate; return okRes(); });
    const p1 = Feedback.submit();
    const r2 = await Feedback.submit();
    expect(r2.ok).toBe(false);
    expect(r2.message).toContain('正在提交');
    release();
    expect((await p1).ok).toBe(true);
    expect(calls.length).toBe(1);
  });
});

describe('本机留档与计数器', () => {
  it('最多留 3 条、最新的在最前（换设备/清数据即消失）', async () => {
    const calls = mockFetch(okRes);
    for (const t of ['第一条', '第二条', '第三条', '第四条']) {
      el('fbText').value = t;
      await Feedback.submit();
    }
    expect(calls.length).toBe(4);
    expect(Feedback.getMine().map((m) => m.text)).toEqual(['第四条', '第三条', '第二条']);
  });

  it('计数器与到上限提示：满 300 才显示提示', () => {
    el('fbText').value = '字'.repeat(299);
    Feedback.onInput();
    expect(el('fbCount').textContent).toContain('299 / 300');
    expect(el('fbLimitHint').style.display).toBe('none');
    el('fbText').value = '字'.repeat(300);
    Feedback.onInput();
    expect(el('fbLimitHint').style.display).toBe('block');
  });

  it('本机留档渲染对内容做转义（不把用户输入当 HTML）', () => {
    SM().set('feedbackMine', [{ text: '<img src=x onerror=alert(1)>', at: Date.now() }]);
    Feedback.renderMine();
    expect(el('fbMine').innerHTML).toContain('&lt;img');
    expect(el('fbMine').innerHTML).not.toContain('<img');
  });
});
