// APIHandler 原生 CORS 降级测试：fetch 被跨域拦截（TypeError）→ 自动走 CapacitorHttp 原生请求
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { APIHandler } from '../src/domain/api';

const anyG = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  await import('../src/domain/api');
});

const CFG = { endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'm' };

// 构造 SSE 文本（含 reasoning_content + content + [DONE]）
function sseText(body: string): string {
  return 'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning_content":"开始思考"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"正文一"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"正文二"}}]}\n\n' +
    'data: [DONE]\n\n' +
    'data: {"choices":[]}\n\n' + body;
}

describe('APIHandler 原生 CORS 降级（_nativeHttpFallback）', () => {
  beforeEach(() => {
    // 默认：fetch 抛 CORS 类错误（WebView 对无 CORS 头端点的行为）
    anyG.fetch = async () => { throw new TypeError('Failed to fetch'); };
    anyG.Capacitor = { isNativePlatform: () => true, Plugins: {} };
    (anyG as any).Capacitor.Plugins.CapacitorHttp = {
      request: async (opts: any) => ({ status: 200, data: sseText(''), options: opts }),
    };
  });

  it('fetch 被拒 → CapacitorHttp 原生请求 → onDone 收到完整正文', async () => {
    let chunks = ''; let done = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'yo' }],
      (c: string) => { chunks += c; },
      (full: string | null) => { done = full || ''; },
      (e: any) => { throw new Error('不应走 onError: ' + e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    expect(done).toContain('正文一');
    expect(done).toContain('正文二');
    expect(chunks).toContain('正文一'); // 节流后 onChunk 也被喂
  });

  // 2026-09-26：原生兜底拿到上游 4xx 时，必须报上游真实状态码 + 可读解释，
  // 不能再用"（端点跨域受限或网络不可达）"盖住——方舟 coding 套餐选到不含的模型会 404
  // UnsupportedModel，旧提示会让人一直去查网络。
  it('原生兜底拿到上游 404（模型不在套餐里）→ 报真实状态码 + 中文解释，不再甩锅 CORS', async () => {
    const body = JSON.stringify({ error: { code: 'UnsupportedModel', message: 'The requested model does not support the coding plan...' } });
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => ({ status: 404, data: body }) };
    let errMsg = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }], () => {}, () => {},
      (e: any) => { errMsg = String(e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    expect(errMsg).toContain('404');
    expect(errMsg).toContain('UnsupportedModel');
    expect(errMsg).toContain('不在该端点/套餐里');
    expect(errMsg).not.toContain('端点跨域受限');
  });

  // 2026-10-11：这条通道是"整段取回 + 本地回放"，abort 掐不断上游请求，但必须能**立刻停止回放**
  // 并按"已中止"收尾——否则用户点了停止，字还在一段段往外冒、最后还会被当成正常完成。
  it('回放途中 abort → 立刻停止回放，onDone(null, true)（不再继续吐字/不再当成功）', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"一"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"二"}}]}\n\n'
      + 'data: {"choices":[{"delta":{"content":"三"}}]}\n\n'
      + 'data: [DONE]\n\n';
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => ({ status: 200, data: sse }) };
    const chunks: string[] = [];
    let full: any = 'unset';
    let aborted: any = null;
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'yo' }],
      (c: string) => { chunks.push(String(c)); APIHandler.abort(); },   // 第一片后就点「停止」
      (f: string | null, a: boolean) => { full = f; aborted = a; },
      (e: any) => { throw new Error('不应走 onError: ' + e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    expect(chunks.length).toBe(1);          // 后面的段落不再回放
    expect(full).toBe(null);
    expect(aborted).toBe(true);             // 如实告诉上层"这是被中止的"
  });

  it('进兜底之前就已经 abort → 连请求都不发，直接 onDone(null, true)', async () => {
    let called = 0;
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => { called++; return { status: 200, data: '' }; } };
    let full: any = 'unset'; let aborted: any = null;
    // 先让 fetch 抛（进 CORS 分支），但在进入兜底前把 signal 置为已取消：用 abort() 抢在微任务里
    const p = APIHandler.fetchCompletions(
      [{ role: 'user', content: 'yo' }], () => {},
      (f: string | null, a: boolean) => { full = f; aborted = a; },
      () => { /* 网络错误路径也可能走到，忽略 */ },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    APIHandler.abort();
    await p;
    expect(called).toBe(0);
    expect(full).toBe(null);
    expect(aborted).toBe(true);
  });

  it('原生兜底也失败（网络层）→ 仍报原来的跨域提示', async () => {
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => { throw new Error('boom'); } };
    let errMsg = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }], () => {}, () => {},
      (e: any) => { errMsg = String(e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    expect(errMsg).toContain('端点跨域受限或网络不可达');
  });

  it('reasoning 收集进 onDone 第三参', async () => {
    let reasoningOut = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }],
      () => {},
      (_f: string | null, _a: boolean, reasoning?: string) => { reasoningOut = reasoning || ''; },
      () => { throw new Error('err'); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    expect(reasoningOut).toContain('开始思考');
  });

  it('工具调用（写卡 agent 场景）通过 onTools 交接', async () => {
    const tf = (part: any) => 'data: ' + JSON.stringify({ choices: [{ delta: part }] }) + '\n\n';
    const toolSSE = tf({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'upsert_entry', arguments: '{"type":"初始"' } }] }) +
      tf({ tool_calls: [{ index: 0, function: { arguments: ',"name":"x"}' } }] }) +
      'data: [DONE]\n\n';
    (anyG as any).Capacitor.Plugins.CapacitorHttp = { request: async () => ({ status: 200, data: toolSSE }) };
    let tools: any[] | null = null;
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '写' }],
      () => {},
      () => {},
      () => { throw new Error('err'); },
      { apiConfig: CFG, tools: [{ type: 'function', function: { name: 'upsert_entry', description: 'x', parameters: { type: 'object', properties: {} } } }], onTools: (c: any[]) => { tools = c; }, timeout: 0, idleTimeout: 0 }
    );
    expect(tools).toHaveLength(1);
    expect(tools![0].name).toBe('upsert_entry');
    expect(tools![0].arguments).toEqual({ type: '初始', name: 'x' });
  });

  it('CapacitorHttp 不可用（web 测试环境）→ 报网络错误，不白屏', async () => {
    anyG.Capacitor = undefined; anyG.CapacitorHttp = undefined;
    let err = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }],
      () => {},
      () => {},
      (e: any) => { err = String(e); },
      { apiConfig: CFG, timeout: 0, idleTimeout: 0 }
    );
    expect(err).toContain('网络错误');
  });
});