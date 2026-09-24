// 代理端口解析 + 上游错误解释（2026-09-26）。
// 回归背景：火山方舟 coding 端点（/api/coding/v3）的 CORS 不放行 Authorization，WebView 必须走
// App 内本地代理；而热更新是"换资源目录 + 页面内重载"，不会重建 Activity → MainActivity 注入的
// window.__PROXY_PORT__ 丢失。原生侧为此把端口持久化到 localStorage('__proxyPort')，
// 但 JS 侧此前读的键名是 devProxyPort（不一致）→ 兜底失效 → 重载后所有请求绕过代理，
// 方舟这类端点就报"（端点跨域受限或网络不可达）"。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveProxyPort, pickProxyUrl } from '../src/domain/api';
import { explainUpstreamError, isContextOverflowError, parseContextOverflowCap, contextOverflowHint } from '../src/domain/modelcompat';
import { APIHandler, contextCapFor } from '../src/domain/api';

const g = globalThis as unknown as Record<string, any>;

// 迷你 localStorage（测试环境没有）
function installLS(init: Record<string, string> = {}) {
  const store: Record<string, string> = { ...init };
  g.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
  return store;
}

beforeEach(() => { delete g.__PROXY_PORT__; delete g.localStorage; });
afterEach(() => { delete g.__PROXY_PORT__; delete g.localStorage; });

describe('resolveProxyPort：注入的全局 → 原生持久化的 __proxyPort → 调试约定', () => {
  it('页面内重载后（注入丢失）仍能从 localStorage.__proxyPort 拿到端口 —— 这是本次修的 bug', () => {
    installLS({ __proxyPort: '51321' });
    expect(resolveProxyPort()).toBe(51321);
    // 真的会被用上：https 地址改写成 127.0.0.1 转发
    expect(pickProxyUrl('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', resolveProxyPort()))
      .toBe('http://127.0.0.1:51321/ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
  });

  it('注入的 window.__PROXY_PORT__ 优先于持久化值（Activity 重建后端口可能已变）', () => {
    installLS({ __proxyPort: '1111' });
    g.__PROXY_PORT__ = 2222;
    expect(resolveProxyPort()).toBe(2222);
  });

  it('两处都没有 → 0（保持直连，不误改成死端口）', () => {
    installLS({});
    expect(resolveProxyPort()).toBe(0);
    expect(pickProxyUrl('https://api.example.com/v1/chat/completions', 0)).toBe('https://api.example.com/v1/chat/completions');
  });

  it('旧调试键 devProxyPort 仍然认（桌面调试约定没人动过）', () => {
    installLS({ devProxyPort: '3333' });
    expect(resolveProxyPort()).toBe(3333);
  });

  it('端口值非法（NaN/空/负数）一律当 0', () => {
    installLS({ __proxyPort: 'abc' });
    expect(resolveProxyPort()).toBe(0);
    installLS({ __proxyPort: '' });
    expect(resolveProxyPort()).toBe(0);
  });
});

describe('explainUpstreamError：把上游 4xx 翻译成一句能懂的话', () => {
  it('模型不在套餐/端点里（方舟 coding 套餐的 404 UnsupportedModel）', () => {
    expect(explainUpstreamError(404, '{"error":{"code":"UnsupportedModel","message":"The requested model does not support the coding plan"}}'))
      .toContain('不在该端点/套餐里');
  });
  it('模型或入口没权限（标准 /api/v3 用 coding 套餐 key）', () => {
    expect(explainUpstreamError(404, '{"error":{"code":"InvalidEndpointOrModel.NotFound"}}')).toContain('没权限');
  });
  it('模型名不识别', () => {
    expect(explainUpstreamError(400, '{"error":{"message":"The model foo does not exist"}}')).toContain('模型名不被识别');
  });
  it('key/频率类状态码', () => {
    expect(explainUpstreamError(401, '')).toContain('API Key 无效');
    expect(explainUpstreamError(403, '')).toContain('无权访问');
    expect(explainUpstreamError(429, '')).toContain('频繁或额度');
  });
  it('不认识的错误不加戏（返回空串，原文照旧显示）', () => {
    expect(explainUpstreamError(500, 'oops')).toBe('');
    expect(explainUpstreamError(400, '{"error":{"code":"InvalidParameter"}}')).toBe('');
  });
  it('401/403 顺带提醒认证头形式（只发 Bearer，Azure/Anthropic 系不吃）', () => {
    expect(explainUpstreamError(401, '')).toContain('Bearer');
    expect(explainUpstreamError(403, '')).toContain('认证头');
  });
});

// 2026-09-26：窗口按「模型可用上下文」算（默认 80 万），换到 128k/256k 的渠道会把请求撑爆。
// 这类报错必须被认出来（不能当参数问题去降级），并抽出发的上限供窗口自动收窄。
describe('上下文超长：识别 + 抽上限 + 提示', () => {
  it('认出各家方言', () => {
    expect(isContextOverflowError("This model's maximum context length is 131072 tokens. However, your messages resulted in 200000 tokens.")).toBe(true);
    expect(isContextOverflowError('{"error":{"code":"context_length_exceeded","message":"Input is too long"}}')).toBe(true);
    expect(isContextOverflowError('输入过长：超出最大上下文长度')).toBe(true);
    expect(isContextOverflowError('too many tokens in the prompt')).toBe(true);
    expect(isContextOverflowError('{"error":{"code":"InvalidParameter","message":"temperature must be <= 2"}}')).toBe(false);
  });
  it('抽上限：优先"上限是 N"句式，抽不到就取最小的大数（不会是 result 那个大数）', () => {
    expect(parseContextOverflowCap("This model's maximum context length is 131072 tokens. However, your messages resulted in 200000 tokens.")).toBe(131072);
    expect(parseContextOverflowCap('maximum context length is 262,144 tokens')).toBe(262144);
    expect(parseContextOverflowCap('Requested 300000 tokens, but the context limit is 128000')).toBe(128000);
    expect(parseContextOverflowCap('the context window is 128000 tokens')).toBe(128000);
    expect(parseContextOverflowCap('your messages resulted in 456789 tokens and exceeded the context window')).toBe(456789);
    expect(parseContextOverflowCap('something else entirely')).toBe(0);
  });
  it('提示里带上上限与"已自动收窄、重发即可"', () => {
    const h = contextOverflowHint(131072);
    expect(h).toContain('131072');
    expect(h).toContain('再发送一次');
    expect(contextOverflowHint(0)).toContain('模型可用上下文');
  });
  it('生成遇到上下文超长：报清楚 + 把上限学进端点档案（窗口下次据此收窄），且不串端点', async () => {
    const store: Record<string, any> = {};
    const prevSM = g.StorageManager;
    const prevFetch = g.fetch;
    g.StorageManager = { get: (k: string, d: any) => (k in store ? store[k] : d), set: (k: string, v: any) => { store[k] = v; } };
    const overflowBody = JSON.stringify({ error: { code: 'context_length_exceeded', message: "This model's maximum context length is 131072 tokens. However, your messages resulted in 200000 tokens." } });
    g.fetch = async () => ({ ok: false, status: 400, text: async () => overflowBody });
    const ep = 'https://ark.example/api/coding/v3', md = 'doubao-seed-2-1-lite';
    expect(contextCapFor(ep, md)).toBe(0);
    let errMsg = '';
    try {
      await APIHandler.fetchCompletions(
        [{ role: 'user', content: 'x' }], () => {}, () => {},
        (e: any) => { errMsg = String(e); },
        { apiConfig: { endpoint: ep, apiKey: 'k', model: md }, timeout: 0, idleTimeout: 0 } as never
      );
    } catch (e) { /* onError 已收进 errMsg；这里只是兜住不吞异常 */ }
    expect(errMsg).toContain('131072');
    expect(errMsg).toContain('上下文上限');
    expect(errMsg).toContain('再发送一次');            // 自愈说明：重发即可
    expect(contextCapFor(ep, md)).toBe(131072);        // 学进档案（断言放在恢复桩之前）
    expect(APIHandler.endpointContextCap(ep, md)).toBe(131072);
    expect(contextCapFor('https://other.example/v1', md)).toBe(0);   // 不同端点不串
    g.StorageManager = prevSM;
    g.fetch = prevFetch;
  });
});
