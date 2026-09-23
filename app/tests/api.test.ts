import { describe, it, expect, beforeEach, vi, afterAll } from 'vitest';
import '../src/infra/storage';
import '../src/domain/preset';
import '../src/domain/modelcompat';
import { normalizeOutgoingMessages } from '../src/domain/api';

const API = (globalThis as unknown as { APIHandler: typeof import('../src/domain/api').APIHandler }).APIHandler;
type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;

// App 桩：价格表（input/cached/output 每百万 token 单价）
(globalThis as unknown as Record<string, unknown>).App = {
  toast: () => {},
  getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 })
};

// SSE 流 mock：frames -> ReadableStream
function sseResponse(frames: (object | string)[] | string, init?: { status?: number; body?: string }): Response {
  const chunks = Array.isArray(frames)
    ? frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
    : [frames];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach((x) => c.enqueue(encoder.encode(x))); c.close(); }
  });
  return new Response(body, { status: init?.status ?? 200 });
}

describe('APIHandler.fetchCompletions（SSE 流式）', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    sm().set('apiConfig', { endpoint: 'https://t/v1', apiKey: 'k', model: 'm' });
    API._apiCalls = [];
    API.abortController = null;
  });

  it('无 API Key 直接报错', async () => {
    sm().set('apiConfig', { endpoint: 'x', apiKey: '' });
    const err = vi.fn();
    await API.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, err);
    expect(err).toHaveBeenCalledWith('请先在高级设置中配置 API Key');
  });

  it('流式增量累积 + onDone 全文', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '你好' } }] },
      { choices: [{ delta: { content: '，世界' } }] },
      '[DONE]'
    ]));
    const chunks: string[] = [];
    const done = vi.fn();
    await API.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), done, vi.fn());
    expect(chunks).toEqual(['你好', '，世界']);
    expect(done).toHaveBeenCalledWith('你好，世界', false, '');
  });

  it('reasoning 多格式兼容累积（不进 onChunk）', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '正文' } }] },
      { choices: [{ delta: { reasoning_content: '思考A' } }] },
      { choices: [{ delta: { reasoning: '思考B' } }] },
      { choices: [{ delta: { thinking: { text: '思考C' } } }] },
      '[DONE]'
    ]));
    const chunks: string[] = [];
    const done = vi.fn();
    await API.fetchCompletions([{ role: 'user', content: 'x' }], (c) => chunks.push(c), done, vi.fn());
    expect(chunks).toEqual(['正文']);
    expect(done).toHaveBeenCalledWith('正文', false, '思考A思考B思考C');
  });

  it('尾帧无换行也不丢失正文', async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"尾部"}}]}')); c.close(); } });
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(new Response(body));
    const done = vi.fn();
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, done, vi.fn());
    expect(done).toHaveBeenCalledWith('尾部', false, '');
  });

  it('usage 记账：cached_tokens 与成本估算', async () => {
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: 'x' } }] },
      { usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 400 } } },
      '[DONE]'
    ]));
    const done = vi.fn();
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, done, vi.fn(), { callLabel: 'generate' });
    const log = API._apiCalls.at(-1)!;
    expect(log.label).toBe('generate');
    expect(log.promptTokens).toBe(1000);
    expect(log.cachedTokens).toBe(400);
    expect(log.completionTokens).toBe(50);
    // 600*1 + 400*0.1 + 50*2 = 740（每百万 token 单位）
    expect(log.cost).toBeCloseTo(600 * 1 + 400 * 0.1 + 50 * 2);
  });

  it('工具调用增量拼装 → onTools（JSON 碎片合并）', async () => {
    const f1 = { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'update', arguments: '{\"表\":' } }] } }] };
    const f2 = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '\"角色档案\"}' } }] } }] };
    const onTools = vi.fn();
    const start = vi.fn();
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(sseResponse([f1, f2, '[DONE]']));
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn(), { onTools, onToolCallStart: start });
    expect(start).toHaveBeenCalled();
    expect(onTools).toHaveBeenCalledWith([{ id: 'call_1', name: 'update', arguments: { '表': '角色档案' } }]);
  });

  it('深度思考关闭（SM 存储 false）：opencode/deepseek 端点带 thinking.disabled + reasoning_effort:none', async () => {
    sm().set('deepseekThinking', false);
    sm().set('apiConfig', { endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4-flash' });
    let bodySent: Record<string, unknown> | null = null;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodySent = JSON.parse(String(init.body || '{}'));
      return sseResponse([{ choices: [{ delta: { content: 'Hi' } }] }, '[DONE]']);
    });
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn());
    expect(bodySent).not.toBeNull();
    expect((bodySent as unknown as Record<string, unknown>).thinking).toEqual({ type: 'disabled' });
    expect((bodySent as unknown as Record<string, unknown>).reasoning_effort).toBe('none');
  });

  it('深度思考开启（默认）：不发 thinking 禁用参数', async () => {
    sm().set('deepseekThinking', true);
    sm().set('apiConfig', { endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k', model: 'deepseek-v4-flash' });
    let bodySent: Record<string, unknown> | null = null;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodySent = JSON.parse(String(init.body || '{}'));
      return sseResponse([{ choices: [{ delta: { content: 'Hi' } }] }, '[DONE]']);
    });
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn());
    expect(bodySent).not.toBeNull();
    expect((bodySent as unknown as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('思考强度 off：未知端点也尝试发 reasoning_effort:none（400 时降级摘除）', async () => {
    sm().set('deepseekThinking', 'off');
    sm().set('apiConfig', { endpoint: 'https://some-unknown.com/v1', apiKey: 'k', model: 'm' });
    let bodySent: Record<string, unknown> | null = null;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodySent = JSON.parse(String(init.body || '{}'));
      return sseResponse([{ choices: [{ delta: { content: 'Hi' } }] }, '[DONE]']);
    });
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn());
    expect(bodySent).not.toBeNull();
    expect((bodySent as unknown as Record<string, unknown>).reasoning_effort).toBe('none');
  });

  it('思考强度 off + 模型拒绝参数（400）→ 降级摘除后重试成功，无思考参数', async () => {
    sm().set('deepseekThinking', 'off');
    sm().set('apiConfig', { endpoint: 'https://some-unknown.com/v1', apiKey: 'k', model: 'm' });
    const bodies: Record<string, unknown>[] = [];
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      const b = JSON.parse(String(init.body || '{}'));
      bodies.push(b);
      if (b.reasoning_effort) {
        return new Response('{"error":{"message":"unknown parameter"}}', { status: 400 });
      }
      return sseResponse([{ choices: [{ delta: { content: 'Hi' } }] }, '[DONE]']);
    });
    const done = vi.fn();
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, done, vi.fn());
    expect(bodies).toHaveLength(2); // 第一次带参 400 → 第二次摘参
    expect(bodies[0].reasoning_effort).toBe('none');
    expect(bodies[1].reasoning_effort).toBeUndefined();
    expect(done).toHaveBeenCalledWith('Hi', false, '');
  });

  it('思考强度 auto（默认）：不发任何思考参数', async () => {
    sm().set('deepseekThinking', 'auto');
    sm().set('apiConfig', { endpoint: 'https://some-unknown.com/v1', apiKey: 'k', model: 'm' });
    let bodySent: Record<string, unknown> | null = null;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodySent = JSON.parse(String(init.body || '{}'));
      return sseResponse([{ choices: [{ delta: { content: 'Hi' } }] }, '[DONE]']);
    });
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn());
    expect(bodySent).not.toBeNull();
    expect((bodySent as unknown as Record<string, unknown>).reasoning_effort).toBeUndefined();
    expect((bodySent as unknown as Record<string, unknown>).thinking).toBeUndefined();
  });

  it('思考强度 medium：发 reasoning_effort:medium', async () => {
    sm().set('deepseekThinking', 'medium');
    sm().set('apiConfig', { endpoint: 'https://some-unknown.com/v1', apiKey: 'k', model: 'm' });
    let bodySent: Record<string, unknown> | null = null;
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (_url: string, init: RequestInit) => {
      bodySent = JSON.parse(String(init.body || '{}'));
      return sseResponse([{ choices: [{ delta: { content: 'Hi' } }] }, '[DONE]']);
    });
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn());
    expect((bodySent as unknown as Record<string, unknown>).reasoning_effort).toBe('medium');
  });

  afterAll(() => { (globalThis as unknown as { fetch: unknown }).fetch = realFetch; });
});
describe('normalizeOutgoingMessages（协议标准化）', () => {
  it('纯文本消息原样通过', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'user', content: 'hi' }],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    expect(out).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('空 system 丢弃，多条 system 保留', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'system', content: '' }, { role: 'system', content: 'a' }, { role: 'user', content: 'hi' }],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    expect(out).toEqual([{ role: 'system', content: 'a' }, { role: 'user', content: 'hi' }]);
  });

  it('assistant content+tool_calls 同体 → 拆成纯文本 + 纯 tool_calls 两条', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'assistant', content: '我先查一下', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] }],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'assistant', content: '我先查一下' });
    expect(out[1].role).toBe('assistant');
    expect(out[1].tool_calls).toHaveLength(1);
    expect(out[1].tool_calls[0].function.name).toBe('lookup');
  });

  it('deepseek（needsRC）纯文本 assistant → 补 reasoning_content 空串', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'assistant', content: '回答' }],
      { needsReasoningContentOnAssistant: true, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    expect(out[0].reasoning_content).toBe('');
    expect(out[0].content).toBe('回答');
  });

  it('deepseek（needsRC）assistant 带 reasoning → 转 reasoning_content', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'assistant', content: '回答', reasoning: '我的思考' }],
      { needsReasoningContentOnAssistant: true, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    expect(out[0].reasoning_content).toBe('我的思考');
  });

  it('qwen（requiresBridge）tool 结果后跟 user → 插占位 assistant', () => {
    const out = normalizeOutgoingMessages(
      [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'user', content: '继续' },
      ],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: true, supportsDeveloperRole: false }
    );
    const roles = out.map((m: any) => m.role);
    expect(roles).toEqual(['assistant', 'tool', 'assistant', 'user']);
    expect(out[2].content).toBe('I have processed the tool results.');
  });

  it('非 bridge 端点 tool 后直接跟 user → 不插', () => {
    const out = normalizeOutgoingMessages(
      [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'user', content: '继续' },
      ],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    const roles = out.map((m: any) => m.role);
    expect(roles).toEqual(['assistant', 'tool', 'user']);
  });

  it('空 assistant（无内容无工具）→ 丢弃', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'assistant', content: '' }],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false }
    );
    expect(out).toEqual([]);
  });

  it('supportsDeveloperRole → 第一条 system 转 developer', () => {
    const out = normalizeOutgoingMessages(
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
      { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: true }
    );
    expect(out[0]).toEqual({ role: 'developer', content: 'sys' });
  });
});

describe('length 截断 toast 门控', () => {
  it('generate 截断 → 弹提示', async () => {
    const toasts: string[] = [];
    (globalThis as unknown as Record<string, unknown>).App = { toast: (m: string) => toasts.push(m), getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 }) };
    sm().set('apiConfig', { endpoint: 'https://t/v1', apiKey: 'k', model: 'm' });
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '正文' }, finish_reason: 'length' }] },
      '[DONE]'
    ]));
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn(), { callLabel: 'generate' });
    expect(toasts.some((m) => m.includes('输出上限'))).toBe(true);
    (globalThis as unknown as Record<string, unknown>).App = { toast: () => {}, getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 }) };
  });

  it('后台任务（fillMemoryTable）截断 → 不弹提示（正文已完成的误报根因）', async () => {
    const toasts: string[] = [];
    (globalThis as unknown as Record<string, unknown>).App = { toast: (m: string) => toasts.push(m), getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 }) };
    sm().set('apiConfig', { endpoint: 'https://t/v1', apiKey: 'k', model: 'm' });
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockResolvedValue(sseResponse([
      { choices: [{ delta: { content: '后台结果' }, finish_reason: 'length' }] },
      '[DONE]'
    ]));
    await API.fetchCompletions([{ role: 'user', content: 'x' }], () => {}, () => {}, vi.fn(), { callLabel: 'fillMemoryTable' });
    expect(toasts.some((m) => m.includes('最大输出'))).toBe(false);
    (globalThis as unknown as Record<string, unknown>).App = { toast: () => {}, getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 }) };
  });
});
