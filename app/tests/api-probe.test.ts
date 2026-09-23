// 工具能力探测（probeToolsSupport）通道测试：必须与 fetchCompletions 同通道——
// HTTPS 端点走本地代理改写；直连被 CORS 拦时走 CapacitorHttp 原生兜底。
// 回归背景：opencode.ai 不带 CORS 头，旧版探测直连 fetch 被拦 → 误报「不支持工具」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { APIHandler } from '../src/domain/api';

const anyG = globalThis as unknown as Record<string, unknown>;

function probe(apiConfig: Record<string, string>, g: Partial<typeof globalThis> = {}) {
  return APIHandler.probeToolsSupport({ apiConfig } as never);
}

function toolCallsBody() {
  return {
    choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'x', type: 'function', function: { name: 'ping', arguments: '{}' } }] } }],
  };
}

function textBody() {
  return { choices: [{ message: { role: 'assistant', content: '好的' } }] };
}

beforeEach(() => {
  (APIHandler as unknown as { _toolsSupport: null })._toolsSupport = null;
  (APIHandler as unknown as { _toolsSupportKey: string })._toolsSupportKey = '';
  delete anyG.__PROXY_PORT__;
  delete anyG.Capacitor;
  anyG.fetch = vi.fn();
});

afterEach(() => {
  delete anyG.__PROXY_PORT__;
  delete anyG.Capacitor;
  delete anyG.fetch;
});

describe('probeToolsSupport 代理通道', () => {
  it('有 __PROXY_PORT__：探测请求走 localhost 代理，返回 tool_calls → true', async () => {
    anyG.__PROXY_PORT__ = 45678;
    const fetchMock = globalThis.fetch as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => toolCallsBody(),
    });
    const ok = await probe({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4-flash' });
    expect(ok).toBe(true);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('http://127.0.0.1:45678/opencode.ai/zen/go/v1/chat/completions');
    const sent = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
    expect(sent.tools[0].function.name).toBe('ping');
  });

  it('无代理 + fetch 被 CORS 拦（抛错）→ CapacitorHttp 原生兜底 → true', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'));
    anyG.Capacitor = { Plugins: { CapacitorHttp: { request: vi.fn().mockResolvedValue({ status: 200, data: toolCallsBody() }) } } };
    const ok = await probe({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4-flash' });
    expect(ok).toBe(true);
    const cap = (anyG.Capacitor as { Plugins: { CapacitorHttp: { request: ReturnType<typeof vi.fn> } } }).Plugins.CapacitorHttp;
    expect(cap.request).toHaveBeenCalledTimes(1);
    const args = cap.request.mock.calls[0][0] as { url: string; data: Record<string, unknown> };
    expect(args.url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
    expect((args.data as { tools: unknown[] }).tools).toHaveLength(1);
  });

  it('无代理 + fetch 被 CORS 拦 + 无 CapacitorHttp → false（不误判 true，也不抛）', async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError('Failed to fetch'));
    const ok = await probe({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4-flash' });
    expect(ok).toBe(false);
  });

  it('有代理但响应无 tool_calls（纯文字回复）→ false', async () => {
    anyG.__PROXY_PORT__ = 45678;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => textBody(),
    });
    const ok = await probe({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4-flash' });
    expect(ok).toBe(false);
  });

  it('HTTP 401 → false', async () => {
    anyG.__PROXY_PORT__ = 45678;
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401 });
    const ok = await probe({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'bad', model: 'deepseek-v4-flash' });
    expect(ok).toBe(false);
  });

  it('未配 Key → false（不发出请求）', async () => {
    const ok = await probe({ endpoint: 'https://opencode.ai/zen/go/v1', apiKey: '', model: 'deepseek-v4-flash' });
    expect(ok).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});