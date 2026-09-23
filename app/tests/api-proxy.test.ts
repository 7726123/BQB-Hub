// 本地 CORS 代理 URL 改写：任意 https 端点有 __PROXY_PORT__ 时走 localhost 转发
// 回归要点：本地代理（LocalProxyServer）只放行 POST，GET /models 会被代理 405 拦下——因此
// fetchModels 的 Capacitor 原生回退必须用【真实 https URL】绕开代理，否则所有渠道都会拉不到模型。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { APIHandler, pickProxyPort, pickProxyUrl } from '../src/domain/api';

const anyG = globalThis as unknown as Record<string, unknown>;

describe('pickProxyPort', () => {
  afterEach(() => { delete anyG.__PROXY_PORT__; });

  it('window.__PROXY_PORT__ 存在（Java 注入）→ 返回端口', () => {
    anyG.__PROXY_PORT__ = 45678;
    expect(pickProxyPort()).toBe(45678);
  });

  it('未注入（web/测试环境）→ 0', () => {
    expect(pickProxyPort()).toBe(0);
  });

  it('注入非法值 → 0', () => {
    anyG.__PROXY_PORT__ = 'abc';
    expect(pickProxyPort()).toBe(0);
  });
});

describe('pickProxyUrl', () => {
  it('有代理端口：任意 https 端点（不限方舟）→ localhost 转发', () => {
    expect(pickProxyUrl('https://opencode.ai/zen/go/v1/chat/completions', 45678))
      .toBe('http://127.0.0.1:45678/opencode.ai/zen/go/v1/chat/completions');
    expect(pickProxyUrl('https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions', 45678))
      .toBe('http://127.0.0.1:45678/ark.cn-beijing.volces.com/api/coding/v3/chat/completions');
    expect(pickProxyUrl('https://api.deepseek.com/v1/chat/completions', 45678))
      .toBe('http://127.0.0.1:45678/api.deepseek.com/v1/chat/completions');
  });

  it('无代理端口 → 原样直连', () => {
    const u = 'https://opencode.ai/zen/go/v1/chat/completions';
    expect(pickProxyUrl(u, 0)).toBe(u);
  });

  it('http 端点保持直连（LocalProxyServer 只直连 443）', () => {
    const u = 'http://localhost:11434/v1/chat/completions';
    expect(pickProxyUrl(u, 45678)).toBe(u);
  });
});

describe('fetchModels（渠道模型列表）', () => {
  it('GET {endpoint}/models 返回 data 数组 → 提取模型 id 列表', async () => {
    anyG.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4' }, { id: 'deepseek-r1' }] }),
    });
    const r = await APIHandler.fetchModels({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    expect(r.models).toEqual(['deepseek-v4-flash', 'deepseek-v4', 'deepseek-r1']);
    expect(r.status).toBe(200);
  });

  it('响应 JSON 是 {models: [...]} 结构 → 同样解析', async () => {
    anyG.fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ models: ['a', 'b'] }),
    });
    const r = await APIHandler.fetchModels({ endpoint: 'https://x.com/v1', apiKey: 'k' });
    expect(r.models).toEqual(['a', 'b']);
    expect(r.status).toBe(200);
  });

  it('有 __PROXY_PORT__ 时模型请求走本地代理（与续写同一通道）', async () => {
    anyG.__PROXY_PORT__ = 45678;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [{ id: 'm1' }] }) });
    anyG.fetch = fetchMock;
    const r = await APIHandler.fetchModels({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k' });
    const calledUrl = (fetchMock.mock.calls[0] as [string])[0];
    expect(calledUrl).toBe('http://127.0.0.1:45678/opencode.ai/zen/go/v1/models');
    expect(r.models).toEqual(['m1']);
    delete anyG.__PROXY_PORT__;
  });

  it('404/401 → 返回空数组并携带状态码（调用方据此提示密钥无效/不支持）', async () => {
    anyG.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const r = await APIHandler.fetchModels({ endpoint: 'https://x.com/v1', apiKey: 'k' });
    expect(r.models).toEqual([]);
    expect(r.status).toBe(404);
    anyG.fetch = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const r2 = await APIHandler.fetchModels({ endpoint: 'https://x.com/v1', apiKey: 'k' });
    expect(r2.models).toEqual([]);
    expect(r2.status).toBe(401);
  });

  it('fetch 抛错且无 Capacitor → 空数组不抛异常', async () => {
    anyG.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    delete anyG.Capacitor;
    const r = await APIHandler.fetchModels({ endpoint: 'https://x.com/v1', apiKey: 'k' });
    expect(r.models).toEqual([]);
    expect(r.status).toBe(0);
  });

  it('【关键回归】本地代理只放行 POST：GET /models 被代理 405 → Capacitor 原生回退必须用真实 https URL（绕开代理）拉取成功', async () => {
    anyG.__PROXY_PORT__ = 45678;
    // 代理通道返回 405（GET 被拒）
    anyG.fetch = vi.fn().mockResolvedValue({ ok: false, status: 405 });
    const called: string[] = [];
    anyG.Capacitor = { Plugins: { CapacitorHttp: {
      request: vi.fn().mockImplementation(async (opts: { url: string; method: string }) => {
        called.push(opts.url);
        return { status: 200, data: { data: [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4' }] } };
      }),
    } } };
    const r = await APIHandler.fetchModels({ endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'k' });
    expect(r.models).toEqual(['deepseek-v4-flash', 'deepseek-v4']);
    expect(r.status).toBe(200);
    // 原生回退必须用真实 https URL，而不是被代理改写的 localhost 地址
    expect(called[0]).toBe('https://api.siliconflow.cn/v1/models');
    delete anyG.__PROXY_PORT__;
    delete anyG.Capacitor;
  });
});