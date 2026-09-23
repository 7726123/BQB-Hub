// 匿名使用统计上报（domain/stats.ts）：安装标识的生成与复用、启动上报、前台心跳、
// 离线补报标记、失败静默（只有服务器明确报错才留一条诊断）。
//
// 隐私相关断言也在本文件：上报体只允许四个字段（id/v/w/plat），不能多也不能少——
// 这是这个功能的红线，改动上报体必须先改这里的用例。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { UsagePing, HEARTBEAT_MS, newInstallId, validInstallId } from '../src/domain/stats';
import { ClientLog } from '../src/domain/clientlog';
import { setWebVersion } from '../src/lib/webver';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;

function resetPing(): void {
  UsagePing._started = false;
  UsagePing._bound = false;   // 否则只有第一个用例能捕获到 visibilitychange/online 处理器
  if (UsagePing._timer) clearInterval(UsagePing._timer);
  UsagePing._timer = null;
  UsagePing._appVersion = '';
  try { localStorage.clear(); } catch (e) { /* ignore */ }
}

/** Node 里 navigator/addEventListener 是只读全局，必须用 defineProperty 覆盖 */
function setGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

let sent: Any[] = [];
function stubFetch(impl?: (url: string, init: Any) => Promise<Any>): void {
  sent = [];
  g.fetch = vi.fn((url: string, init: Any) => {
    sent.push({ url: String(url), body: JSON.parse(String(init && init.body || '{}')) });
    return impl ? impl(url, init) : Promise.resolve({ ok: true, status: 200 });
  });
}

beforeEach(() => {
  resetPing();
  sent = [];
  setWebVersion('');
  g.window = globalThis;
  g.Capacitor = { getPlatform: () => 'android' };
  g.StorageManager = { get: (_k: string, d?: unknown) => d, set: () => undefined };
  stubFetch();
  vi.spyOn(ClientLog, 'note').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  resetPing();
  delete g.Capacitor;
});

describe('安装标识', () => {
  it('首次调用生成、之后复用同一个（不随重启变化）', () => {
    const a = UsagePing.id();
    expect(validInstallId(a)).toBe(true);
    expect(UsagePing.id()).toBe(a);
  });

  it('格式满足服务端校验（8–64 位字母数字下划线连字符）', () => {
    for (let i = 0; i < 20; i++) {
      const id = newInstallId();
      expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
      expect(validInstallId(id)).toBe(true);
    }
  });

  it('crypto 不可用时退化为 Math.random，仍然是合法标识', () => {
    const id = newInstallId({} as Any);
    expect(validInstallId(id)).toBe(true);
    expect(id).toHaveLength(32);
  });

  it('两份不同的标识几乎不可能相同（16 字节随机）', () => {
    const set = new Set(Array.from({ length: 50 }, () => newInstallId()));
    expect(set.size).toBe(50);
  });

  it('本地存的是垃圾值（例如被手改）时重新生成合法标识', () => {
    localStorage.setItem('usageInstallId', '带中文的值');
    expect(validInstallId(UsagePing.id())).toBe(true);
  });
});

describe('上报', () => {
  it('启动上报：只带 id/v/w/plat 四个字段，不含任何内容或设备信息', async () => {
    UsagePing.init('1.5.97');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(1);
    expect(sent[0].url).toContain('/api/app/ping');
    expect(Object.keys(sent[0].body).sort()).toEqual(['id', 'plat', 'v', 'w']);
    expect(sent[0].body.v).toBe('1.5.97');
    expect(sent[0].body.plat).toBe('android');
    expect(sent[0].body.w).toBe('');            // 未用热更新 → 空（服务端记「内置」）
    expect(sent[0].body.id).toBe(UsagePing.id());
  });

  it('热更新生效时带上网页包版本（管理员能看到热更新有没有落地）', async () => {
    setWebVersion('1.5.97w2');
    UsagePing.init('1.5.97');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].body.w).toBe('1.5.97w2');
  });

  it('前台心跳：每 3 分钟一次（服务端 5 分钟内算在线）', async () => {
    vi.useFakeTimers();
    UsagePing.init('1.5.97');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sent.length).toBe(2);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS * 2);
    expect(sent.length).toBe(4);
  });

  it('重复 init 不会重复起心跳（热更新后重新 init 也不叠加）', async () => {
    vi.useFakeTimers();
    UsagePing.init('1.5.97');
    UsagePing.init('1.5.97');
    UsagePing.init('1.5.97');
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.length).toBe(1);
    await vi.advanceTimersByTimeAsync(HEARTBEAT_MS);
    expect(sent.length).toBe(2);
  });

  it('明确离线时不发请求，只留待上报标记；网络恢复后补上', async () => {
    setGlobal('navigator', { onLine: false });
    UsagePing.init('1.5.97');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(0);
    expect(UsagePing.pending()).toBe(true);

    setGlobal('navigator', { onLine: true });
    UsagePing.ping('online');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(1);
    expect(UsagePing.pending()).toBe(false);
  });

  it('网络异常：静默留标记、不抛错、不写诊断（离线是常态）', async () => {
    stubFetch(() => Promise.reject(new Error('offline')));
    expect(() => UsagePing.ping('start')).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(UsagePing.pending()).toBe(true);
    expect(ClientLog.note).not.toHaveBeenCalled();
  });

  it('服务器明确报错：留一条诊断（便于自查标识格式/限流问题），不抛错', async () => {
    stubFetch(() => Promise.resolve({ ok: false, status: 400 }));
    UsagePing.ping('start');
    await new Promise((r) => setTimeout(r, 0));
    expect(ClientLog.note).toHaveBeenCalled();
    expect(String((ClientLog.note as Any).mock.calls[0][1])).toContain('400');
  });

  it('切回前台立刻补一次（后台期间定时器被冻，回来要尽快恢复在线状态）', async () => {
    const handlers: Record<string, () => void> = {};
    const doc = (globalThis as Any).document;
    doc.addEventListener = (ev: string, fn: () => void) => { handlers[ev] = fn; };
    doc.hidden = true;
    setGlobal('addEventListener', (ev: string, fn: () => void) => { handlers[ev] = fn; });
    UsagePing.init('1.5.97');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(1);

    doc.hidden = false;
    expect(typeof handlers['visibilitychange']).toBe('function');
    handlers['visibilitychange']();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(2);

    handlers['online']();   // 网络恢复事件同样触发补报
    await new Promise((r) => setTimeout(r, 0));
    expect(sent.length).toBe(3);
  });

  it('上报地址跟随用户配置的社区服务器', async () => {
    g.StorageManager = { get: (k: string, d?: unknown) => (k === 'communityServer' ? 'http://my.server:1234/' : d), set: () => undefined };
    UsagePing.ping('start');
    await new Promise((r) => setTimeout(r, 0));
    expect(sent[0].url).toContain('http://my.server:1234/api/app/ping');
  });
});
