// 原生流式通道（B）：lib/nativestream.ts 的包装语义 + 在 fetchCompletions 里的接线
// ① 包装：2xx → 可读流（base64 → 字节，顺序不乱）；非 2xx → 状态 + 错误体；头前失败 → 抛错；取消 → close + AbortError
// ② 接线：fetch 被 CORS 拦下时优先走 B（真流式）；B 不可用/失败 → 原样回退老的整段缓冲兜底
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nativeStreamAvailable, nativeStreamFetch, b64ToBytes } from '../src/lib/nativestream';
import { APIHandler } from '../src/domain/api';

const anyG = globalThis as unknown as Record<string, unknown>;
const CFG = { endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'm' };
const tick = () => new Promise((r) => setTimeout(r, 0));

interface FakeOpts { status?: number; frames?: string[]; errorAfter?: string; rejectOpen?: string; noHead?: boolean }

/** 假插件：open 返回 {id,status}；随后把 frames 逐片推成 chunk 事件，最后 done / error。 */
function fakePlugin(o: FakeOpts) {
  const listeners: Record<string, Array<(d: any) => void>> = {};
  const state = { closed: 0, opened: 0 };
  const emit = (ev: string, d: any) => { (listeners[ev] || []).forEach((cb) => cb(d)); };
  const api: any = {
    addListener(ev: string, cb: (d: any) => void) { (listeners[ev] = listeners[ev] || []).push(cb); return Promise.resolve(); },
    async open() {
      state.opened++;
      if (o.rejectOpen) throw new Error(o.rejectOpen);
      const status = o.status == null ? 200 : o.status;
      setTimeout(() => {
        void (async () => {
          for (const f of (o.frames || [])) { emit('chunk', { id: 's1', b64: Buffer.from(f, 'utf8').toString('base64') }); await tick(); }
          if (o.errorAfter) emit('error', { id: 's1', message: o.errorAfter });
          else emit('done', { id: 's1' });
        })();
      }, 0);
      return { id: 's1', status };
    },
    async close() { state.closed++; }
  };
  return { api, state };
}

function install(plugin: any | null): void {
  anyG.Capacitor = { isNativePlatform: () => true, Plugins: plugin ? { NativeStream: plugin } : {} };
}

beforeEach(() => { install(null); });
afterEach(() => { delete (anyG as any).Capacitor; });

describe('nativestream：可用性与字节解码', () => {
  it('没有 Capacitor / 没有插件 / 非原生 → 都算不可用（老 APK 无感降级）', () => {
    delete (anyG as any).Capacitor;
    expect(nativeStreamAvailable()).toBe(false);
    install(null);
    expect(nativeStreamAvailable()).toBe(false);
    anyG.Capacitor = { isNativePlatform: () => false, Plugins: { NativeStream: { open: () => {}, close: () => {} } } };
    expect(nativeStreamAvailable()).toBe(false);
    install({ open: () => {}, close: () => {} });
    expect(nativeStreamAvailable()).toBe(true);
  });

  it('base64 → 字节（含多字节 UTF-8 原样还原）', () => {
    const src = 'data: 林晚\n\n';
    const out = b64ToBytes(Buffer.from(src, 'utf8').toString('base64'));
    expect(new TextDecoder('utf-8').decode(out)).toBe(src);
    expect(b64ToBytes('不是base64!!!').length).toBe(0);
  });
});

describe('nativestream：一次请求的包装语义', () => {
  it('2xx → 可读流按序给出字节（分片不乱）', async () => {
    const { api } = fakePlugin({ frames: ['a1', 'b2', 'c3'] });
    install(api);
    const r = await nativeStreamFetch({ url: 'https://x/y', headers: {}, body: '{}' });
    expect(r.status).toBe(200);
    const reader = (r as any).stream.getReader();
    const dec = new TextDecoder('utf-8');
    let text = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
    expect(text).toBe('a1b2c3');
  });

  it('非 2xx → 返回状态 + 收齐的错误体（交给上层按 HTTP 错误报）', async () => {
    const body = JSON.stringify({ error: { message: '模型不在套餐里' } });
    const { api, state } = fakePlugin({ status: 404, frames: [body] });
    install(api);
    const r = await nativeStreamFetch({ url: 'https://x/y', headers: {}, body: '{}' });
    expect(r.status).toBe(404);
    expect(String((r as any).bodyText)).toContain('模型不在套餐里');
    expect(state.closed).toBeGreaterThan(0);      // 收完就把原生连接关掉
  });

  it('头都没拿到（连不上/超时）→ 抛错（调用方据此回退老通道）', async () => {
    const { api } = fakePlugin({ rejectOpen: 'SocketTimeoutException: Read timed out' });
    install(api);
    await expect(nativeStreamFetch({ url: 'https://x/y', headers: {}, body: '{}' })).rejects.toThrow(/原生流式/);
  });

  it('取消（signal abort）→ 调原生 close，并把流 error 成 AbortError（与 fetch 取消语义一致）', async () => {
    const { api, state } = fakePlugin({ frames: ['x'] });
    install(api);
    const ac = new AbortController();
    const r = await nativeStreamFetch({ url: 'https://x/y', headers: {}, body: '{}', signal: ac.signal });
    const reader = (r as any).stream.getReader();
    await reader.read();                            // 拿到第一片
    ac.abort();
    let name = '';
    try { for (;;) { const { done } = await reader.read(); if (done) break; } }
    catch (e: any) { name = String(e && e.name); }
    expect(name).toBe('AbortError');
    expect(state.closed).toBeGreaterThan(0);
  });
});

describe('接线：fetch 被 CORS 拦下时优先走原生流式（B）', () => {
  // 这一组会走 api.ts 的直连重试退避（1.5s + 3s）：用**假定时器**把时钟推进走，
  // 测试不再真等 4.5 秒——走的是同一条代码路径，不是把等待删掉。
  let store: Record<string, any>;
  const savedProfiles = () => Object.values(store).filter((v: any) => v && typeof v === 'object');
  beforeEach(() => {
    vi.useFakeTimers();
    store = {};
    anyG.StorageManager = { get: (k: string, d: any) => (k in store ? store[k] : d), set: (k: string, v: any) => { store[k] = v; } };
    anyG.fetch = async () => { throw new TypeError('Failed to fetch'); };
    anyG.Capacitor = { isNativePlatform: () => true, Plugins: {} };
    delete (anyG as any).__PROXY_PORT__;
  });
  afterEach(() => { vi.useRealTimers(); });

  /** 跑一次请求，并把假时钟推过所有退避/节流定时器（30s 足够覆盖 1.5s+3s 与 25ms 分帧节流） */
  async function drive<T>(p: Promise<T>): Promise<T> {
    await vi.advanceTimersByTimeAsync(30000);
    return p;
  }

  it('B 可用 → 走它解析 SSE（正文 + 思维链都能到），不再走整段缓冲', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"reasoning_content":"想一下"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文一"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"正文二"}}]}\n\n',
      'data: [DONE]\n\n'
    ];
    let bufHttp = 0;
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => { bufHttp++; return { status: 200, data: '' }; } };
    const { api, state } = fakePlugin({ frames: sse });
    (anyG as any).Capacitor.Plugins.NativeStream = api;

    let chunks = '', done: string | null = null, reasoning = '';
    await drive(APIHandler.fetchCompletions(
      [{ role: 'user', content: 'yo' }],
      (c: string) => { chunks += c; },
      (full: string | null, _aborted: boolean, r?: string) => { done = full; reasoning = String(r || ''); },
      (e: any) => { throw new Error('不应走 onError: ' + e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    ));
    expect(done).toContain('正文一');
    expect(done).toContain('正文二');
    expect(chunks).toContain('正文一');
    expect(reasoning).toContain('想一下');
    expect(bufHttp).toBe(0);                        // 没有落到"整段缓冲"那条老通道
    expect(state.opened).toBe(1);
    // B 成功 → 记进端点档案（下一次就不用再白等直连重试了）
    expect(savedProfiles().some((p: any) => p.fetchFails === true)).toBe(true);
  });

  it('B 拿不到头（拒绝）→ 自动回退整段缓冲兜底（老设备/老通道行为不变）', async () => {
    (anyG as any).Capacitor.Plugins.CapacitorHttp = {
      request: async () => ({ status: 200, data: 'data: {"choices":[{"delta":{"content":"兜底正文"}}]}\n\ndata: [DONE]\n\n' })
    };
    const { api } = fakePlugin({ rejectOpen: 'boom' });
    (anyG as any).Capacitor.Plugins.NativeStream = api;

    let done: string | null = null;
    await drive(APIHandler.fetchCompletions(
      [{ role: 'user', content: 'yo' }], () => {},
      (full: string | null) => { done = full; },
      (e: any) => { throw new Error('不应走 onError: ' + e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    ));
    expect(done).toContain('兜底正文');
  });

  it('B 报到非 2xx → 直接报真实状态码（不再多跑一次缓冲兜底）', async () => {
    let bufHttp = 0;
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => { bufHttp++; return { status: 200, data: '' }; } };
    const body = JSON.stringify({ error: { code: 'UnsupportedModel', message: 'The requested model does not support the coding plan' } });
    const { api } = fakePlugin({ status: 404, frames: [body] });
    (anyG as any).Capacitor.Plugins.NativeStream = api;

    let errMsg = '';
    await drive(APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }], () => {}, () => {},
      (e: any) => { errMsg = String(e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    ));
    expect(errMsg).toContain('404');
    expect(errMsg).toContain('UnsupportedModel');
    expect(bufHttp).toBe(0);
  });

  // ---------- 档案学习：同一个端点只白等一次（2026-10-13）----------
  const sseOne = ['data: {"choices":[{"delta":{"content":"一"}}]}\n\n', 'data: [DONE]\n\n'];

  async function runOnce(): Promise<string> {
    let done = '';
    await drive(APIHandler.fetchCompletions(
      [{ role: 'user', content: 'yo' }], () => {},
      (f: string | null) => { done = String(f || ''); },
      (e: any) => { throw new Error('不应走 onError: ' + e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    ));
    return done;
  }

  it('学过之后：第二次请求一次直连都不试，直接走 B（省掉 1.5s+3s）', async () => {
    let fetchCalls = 0;
    anyG.fetch = async () => { fetchCalls++; throw new TypeError('Failed to fetch'); };
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => ({ status: 200, data: '' }) };
    (anyG as any).Capacitor.Plugins.NativeStream = fakePlugin({ frames: sseOne }).api;

    expect(await runOnce()).toContain('一');
    expect(fetchCalls).toBe(3);                     // 第一次：直连重试 3 次（1 + 2 次重试）后走 B
    expect(savedProfiles().some((p: any) => p.fetchFails === true)).toBe(true);

    expect(await runOnce()).toContain('一');         // 第二次：档案命中
    expect(fetchCalls).toBe(3);                     // 一次直连都没有再试
  });

  it('B 与缓冲兜底都不行 → 清掉档案标记（下次重新直连，能自愈）', async () => {
    let fetchCalls = 0;
    anyG.fetch = async () => { fetchCalls++; throw new TypeError('Failed to fetch'); };
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => { throw new Error('native down'); } };
    (anyG as any).Capacitor.Plugins.NativeStream = fakePlugin({ rejectOpen: 'boom' }).api;

    // 第一次：直连失败 → B 失败 → 兜底失败 → 报网络错误，并把档案里那条"直连会被拦"清掉
    let errMsg = '';
    await drive(APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }], () => {}, () => {},
      (e: any) => { errMsg = String(e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    ));
    expect(errMsg).toContain('网络错误');
    expect(savedProfiles().some((p: any) => p.fetchFails === true)).toBe(false);

    // 第二次：因为没有标记，仍然会重新尝试直连（fetchCalls 继续涨）
    const before = fetchCalls;
    await drive(APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }], () => {}, () => {},
      () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    ));
    expect(fetchCalls).toBeGreaterThan(before);
  });

  it('学习时没代理、后来才有代理 → 不吃档案（代理可能让直连成功，仍要试 fetch）', async () => {
    let fetchCalls = 0;
    anyG.fetch = async () => { fetchCalls++; throw new TypeError('Failed to fetch'); };
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => ({ status: 200, data: '' }) };
    (anyG as any).Capacitor.Plugins.NativeStream = fakePlugin({ frames: sseOne }).api;

    await runOnce();                                 // 第一次：无代理 → 学上 fetchFails=true, fetchFailsPp=false
    expect(savedProfiles().some((p: any) => p.fetchFails === true && p.fetchFailsPp === false)).toBe(true);

    (anyG as any).__PROXY_PORT__ = 18899;             // 后来有了代理（换装系统版 APK / 注入端口）
    const before = fetchCalls;
    expect(await runOnce()).toContain('一');
    expect(fetchCalls).toBeGreaterThan(before);      // 仍会重新试直连（代理通道不能被旧档案跳过）
  });

  it('学习时就有代理（代理也救不了这个端点）→ 照样跳过直连重试（省掉 4.5 秒）', async () => {
    (anyG as any).__PROXY_PORT__ = 18899;             // 线上实测：系统版有代理端口，端点仍走 B
    let fetchCalls = 0;
    anyG.fetch = async () => { fetchCalls++; throw new TypeError('Failed to fetch'); };
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => ({ status: 200, data: '' }) };
    (anyG as any).Capacitor.Plugins.NativeStream = fakePlugin({ frames: sseOne }).api;

    await runOnce();
    expect(savedProfiles().some((p: any) => p.fetchFails === true && p.fetchFailsPp === true)).toBe(true);

    const before = fetchCalls;
    expect(await runOnce()).toContain('一');
    expect(fetchCalls).toBe(before);                 // 一次直连都不再试
  });
});
