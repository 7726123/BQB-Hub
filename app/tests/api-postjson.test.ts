// APIHandler.postJSON（非流式通用网关）：端点净化 / 代理改写 / 非 2xx 分类 / 原生兜底
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIHandler, resolveProxyPort } from '../src/domain/api';

const g = globalThis as unknown as Record<string, any>;
const realFetch = g.fetch;

function jsonResponse(ok: boolean, status: number, body: unknown) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  g.__PROXY_PORT__ = undefined;
  g.Capacitor = undefined;
  g.CapacitorHttp = undefined;
});

afterEach(() => {
  g.fetch = realFetch;
  g.__PROXY_PORT__ = undefined;
  g.Capacitor = undefined;
  g.CapacitorHttp = undefined;
});

describe('APIHandler.postJSON（非流式通用网关）', () => {
  it('直连成功：Bearer 头 + JSON 响应解析', async () => {
    g.fetch = vi.fn(async () => jsonResponse(true, 200, { choices: [{ message: { content: 'OK' } }] }));
    const r = await APIHandler.postJSON('https://ep.example/v1', '/chat/completions', { model: 'm' }, { auth: 'k1' });
    expect(r.ok).toBe(true);
    expect((r.json as { choices: { message: { content: string } }[] }).choices[0].message.content).toBe('OK');
    const [url, init] = g.fetch.mock.calls[0];
    expect(url).toBe('https://ep.example/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer k1');
  });

  it('端点净化：全角冒号/空格/零宽字符剔除', async () => {
    g.fetch = vi.fn(async () => jsonResponse(true, 200, {}));
    await APIHandler.postJSON('https：//ep.example /v1', '/chat/completions', {});
    expect(g.fetch.mock.calls[0][0]).toBe('https://ep.example/v1/chat/completions');
  });

  it('代理改写：__PROXY_PORT__ 存在时 https 端点走 127.0.0.1', async () => {
    g.__PROXY_PORT__ = 9876;
    g.fetch = vi.fn(async () => jsonResponse(true, 200, {}));
    await APIHandler.postJSON('https://ep.example/v1', '/chat/completions', {});
    expect(g.fetch.mock.calls[0][0]).toBe('http://127.0.0.1:9876/ep.example/v1/chat/completions');
  });

  it('resolveProxyPort：注入端口 → URL ?proxy= → devProxyPort 依次取优先级', () => {
    expect(resolveProxyPort()).toBe(0);
    g.__PROXY_PORT__ = 1111;
    expect(resolveProxyPort()).toBe(1111);
  });

  it('非 2xx：返回 ok=false 且 error 含服务端 message', async () => {
    g.fetch = vi.fn(async () => jsonResponse(false, 429, { error: { message: 'rate limited' } }));
    const r = await APIHandler.postJSON('https://ep.example/v1', '/chat/completions', {});
    expect(r.ok).toBe(false);
    expect(r.status).toBe(429);
    expect(r.error).toContain('rate limited');
  });

  it('auth 缺省不带 Authorization 头，path 为空直接请求 endpoint', async () => {
    g.fetch = vi.fn(async () => jsonResponse(true, 200, {}));
    await APIHandler.postJSON('https://api.search.example/search', '', { api_key: 'k', query: 'q' });
    const [url, init] = g.fetch.mock.calls[0];
    expect(url).toBe('https://api.search.example/search');
    expect(init.headers['Authorization']).toBeUndefined();
  });

  it('原生兜底：fetch 被 CORS 拦截时 CapacitorHttp 直达真实 https', async () => {
    g.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const request = vi.fn(async (o: { url: string }) => ({ status: 200, data: { ok: 1 } }));
    g.Capacitor = { isNativePlatform: () => true, Plugins: { CapacitorHttp: { request } } };
    const r = await APIHandler.postJSON('https://ep.example/v1', '/chat/completions', {});
    expect(r.ok).toBe(true);
    expect((r.json as { ok: number }).ok).toBe(1);
    expect(request.mock.calls[0][0].url).toBe('https://ep.example/v1/chat/completions');
    expect(request.mock.calls[0][0].url).not.toContain('127.0.0.1');
  });

  it('非原生环境 fetch 失败：返回 ok=false 不抛异常', async () => {
    g.fetch = vi.fn(async () => { throw new TypeError('Failed to fetch'); });
    const r = await APIHandler.postJSON('https://ep.example/v1', '/chat/completions', {});
    expect(r.ok).toBe(false);
    expect(r.error).toContain('Failed to fetch');
  });
});
