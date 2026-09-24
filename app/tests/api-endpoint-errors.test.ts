// 代理端口解析 + 上游错误解释（2026-09-26）。
// 回归背景：火山方舟 coding 端点（/api/coding/v3）的 CORS 不放行 Authorization，WebView 必须走
// App 内本地代理；而热更新是"换资源目录 + 页面内重载"，不会重建 Activity → MainActivity 注入的
// window.__PROXY_PORT__ 丢失。原生侧为此把端口持久化到 localStorage('__proxyPort')，
// 但 JS 侧此前读的键名是 devProxyPort（不一致）→ 兜底失效 → 重载后所有请求绕过代理，
// 方舟这类端点就报"（端点跨域受限或网络不可达）"。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveProxyPort, pickProxyUrl } from '../src/domain/api';
import { explainUpstreamError } from '../src/domain/modelcompat';

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
});
