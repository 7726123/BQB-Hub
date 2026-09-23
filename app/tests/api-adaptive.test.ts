// API 自适应层：400/422 参数降级阶梯 / 响应形态（无空格 data:、整段 JSON、NDJSON）/ 端点能力档案
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/preset';
import '../src/domain/modelcompat';
import { APIHandler, parseRejectedParams, pickNonSseContent, readEndpointProfile, DEFAULT_MAX_TOKENS } from '../src/domain/api';

const g = globalThis as unknown as Record<string, any>;
const realFetch = g.fetch;
type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;

g.App = { toast: () => {}, getPricingConfig: () => ({ input: 1, cached: 0.1, output: 2 }) };

const CFG = { endpoint: 'https://ep.example/v1', apiKey: 'k1', model: 'm1', maxTokens: 8000, temperature: 0.9, topK: 40 };

function sseResponse(frames: (object | string)[] | string, init?: { status?: number }): Response {
  const chunks = Array.isArray(frames)
    ? frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`)
    : [frames];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach((x) => c.enqueue(encoder.encode(x))); c.close(); }
  });
  return new Response(body, { status: init?.status ?? 200 });
}
function rawResponse(text: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(encoder.encode(text)); c.close(); }
  });
  return new Response(body, { status: 200 });
}
function errResponse(status: number, message: string): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) { c.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message } }))); c.close(); }
  });
  return new Response(body, { status });
}

function clearProfiles() {
  const ls = globalThis.localStorage as unknown as { key(i: number): string | null; length: number };
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k && k.includes('endpointProfile_')) keys.push(k.replace(/^lnw_/, ''));
  }
  keys.forEach((k) => sm().remove(k));
}

describe('parseRejectedParams：错误文本 → 参数动作', () => {
  it('点名参数（引号/裸词）→ drop；max_tokens → rename', () => {
    expect(parseRejectedParams("Unsupported parameter: 'top_k' is not supported with this model.", { top_k: 40, temperature: 1 }))
      .toEqual([{ key: 'top_k', action: 'drop' }]);
    expect(parseRejectedParams('Unrecognized request argument supplied: stream_options', { stream_options: {}, messages: [] }))
      .toEqual([{ key: 'stream_options', action: 'drop' }]);
    expect(parseRejectedParams('"max_tokens" is not supported with this model. Use "max_completion_tokens" instead.', { max_tokens: 8000 }))
      .toEqual([{ key: 'max_tokens', action: 'rename_max_tokens' }]);
    expect(parseRejectedParams('不支持的参数: temperature', { temperature: 0.9 }))
      .toEqual([{ key: 'temperature', action: 'drop' }]);
  });
  it('定位不到参数 → 空数组（调用方回退摘思考参数）', () => {
    expect(parseRejectedParams('unknown parameter', { temperature: 1, max_tokens: 100 })).toEqual([]);
    expect(parseRejectedParams('', { top_p: 1 })).toEqual([]);
  });
  it('思考参数取值非法（枚举报错）→ 取端点允许的最小档重试，而不是摘掉参数', () => {
    // 真实案例（commandcode + deepseek-v4.1-flash）：端点只接受 low/medium/high/xhigh/max，
    // 生产发的是 reasoning_effort:'none'（想关思考）→ 400。摘掉参数 = 思考全开，必须改成降档。
    const err = JSON.stringify({ error: { message: 'Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"', type: 'invalid_request_error', param: 'reasoning_effort' } });
    expect(parseRejectedParams(err, { reasoning_effort: 'none', max_tokens: 6000 }))
      .toEqual([{ key: 'reasoning_effort', action: 'set_value', value: 'low' }]);
    // 其他措辞：must be one of / supported values are（取允许集合里"最关思考"的一档）
    expect(parseRejectedParams('reasoning_effort must be one of: minimal, low, high', { reasoning_effort: 'none' }))
      .toEqual([{ key: 'reasoning_effort', action: 'set_value', value: 'minimal' }]);
    expect(parseRejectedParams('Unsupported value for reasoning_effort: supported values are "none", "medium", "high"', { reasoning_effort: 'x' }))
      .toEqual([{ key: 'reasoning_effort', action: 'set_value', value: 'none' }]);
    // thinking 方言：值是对象（{type:'disabled'}），形状不确定 → 保守摘除，不猜形状
    expect(parseRejectedParams('thinking: invalid option, expected one of "disabled"|"enabled"', { thinking: { type: 'disabled' } }))
      .toEqual([{ key: 'thinking', action: 'drop' }]);
  });
  it('取值非法但解析不出可选集合 → 仍回退摘除（不猜值）；非思考参数一律摘除', () => {
    expect(parseRejectedParams('reasoning_effort has an invalid value', { reasoning_effort: 'none' }))
      .toEqual([{ key: 'reasoning_effort', action: 'drop' }]);
    expect(parseRejectedParams('top_k: invalid option, expected one of "1"|"40"', { top_k: 40 }))
      .toEqual([{ key: 'top_k', action: 'drop' }]);
  });
});

describe('参数降级阶梯（400/422 → 摘除/改名 → 重试 + 能力档案）', () => {
  beforeEach(() => { clearProfiles(); APIHandler._apiCalls = []; APIHandler.abortController = null; APIHandler._toolsSupport = null; APIHandler._toolsSupportKey = ''; });
  afterEach(() => { g.fetch = realFetch; });

  it('top_k 被拒 → 第二次请求不再带 top_k，且档案记住（第三次调用首个请求就不带）', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if ('top_k' in b) return errResponse(400, "Unsupported parameter: 'top_k' is not supported with this model.");
      return sseResponse([{ choices: [{ delta: { content: '好' } }] }, '[DONE]']);
    });
    const chunks: string[] = [];
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('好');
    expect(bodies.length).toBe(2);
    expect('top_k' in bodies[0]).toBe(true);
    expect('top_k' in bodies[1]).toBe(false);
    expect(readEndpointProfile(CFG.endpoint, CFG.model).drop).toContain('top_k');

    // 再发一次：首个请求就不带 top_k（档案生效）
    bodies.length = 0;
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(bodies.length).toBe(1);
    expect('top_k' in bodies[0]).toBe(false);
  });

  it('思考参数取值被拒 → 降到端点允许的最小档（不摘除），档案记住档位', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if (b.reasoning_effort === 'none') {
        // 真实报文形态：Invalid option + 允许集合 + param 字段
        return new Response(JSON.stringify({ error: { message: 'Invalid option: expected one of "low"|"medium"|"high"|"xhigh"|"max"', type: 'invalid_request_error', param: 'reasoning_effort' } }), { status: 400 });
      }
      return sseResponse([{ choices: [{ delta: { content: '好' } }] }, '[DONE]']);
    });
    const cfg = { ...CFG, deepseekThinking: 'off' };
    const chunks: string[] = [];
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), () => {}, () => {}, { apiConfig: cfg, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('好');
    expect(bodies.length).toBe(2);
    expect(bodies[0].reasoning_effort).toBe('none');   // 生产原本发的是 none
    expect(bodies[1].reasoning_effort).toBe('low');    // 降级后仍带参数（思考被压到最低档），而不是摘掉
    expect(readEndpointProfile(CFG.endpoint, CFG.model).thinkingOverride).toEqual({ reasoning_effort: 'low' });

    // 再发一次：首个请求就带 low（档案生效，不再踩 400）
    bodies.length = 0;
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {}, { apiConfig: cfg, timeout: 0, idleTimeout: 0 });
    expect(bodies.length).toBe(1);
    expect(bodies[0].reasoning_effort).toBe('low');
  });

  it('max_tokens 被拒 → 改名 max_completion_tokens（保留值），档案标记', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if ('max_tokens' in b) return errResponse(400, '"max_tokens" is not supported with this model. Use "max_completion_tokens" instead.');
      return sseResponse(['[DONE]']);
    });
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(bodies.length).toBe(2);
    // 值不因改名而变：默认发 api.ts 的最大值（不再读 apiConfig.maxTokens）
    expect(bodies[1].max_completion_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect('max_tokens' in bodies[1]).toBe(false);
    expect(readEndpointProfile(CFG.endpoint, CFG.model).useMaxCompletionTokens).toBe(true);
  });

  it('max_tokens 太大 → 下调到报错里的允许值（不摘除、不改名），档案记住上限', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      const v = b.max_tokens ?? b.max_completion_tokens;
      if (typeof v === 'number' && v > 8192) {
        return errResponse(400, 'Invalid max_tokens: ' + v + '. This model supports at most 8192 completion tokens.');
      }
      return sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
    });
    const chunks: string[] = [];
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('ok');
    expect(bodies.length).toBe(2);
    expect(bodies[1].max_tokens).toBe(8192);            // 取报错里给的允许值
    expect('max_completion_tokens' in bodies[1]).toBe(false); // 不是"名字不对"，不该改名
    expect(readEndpointProfile(CFG.endpoint, CFG.model).maxTokensCap).toBe(8192);

    // 第二次调用：档案已记住上限 → 首个请求就带 8192，不再踩一次 400
    const bodies2: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      bodies2.push(JSON.parse(init.body));
      return sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
    });
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(bodies2.length).toBe(1);
    expect(bodies2[0].max_tokens).toBe(8192);
  });

  it('max_tokens 太大但报错里没有数字 → 按阶梯下调一档（65535→32768），仍然不摘除', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      const v = b.max_tokens ?? b.max_completion_tokens;
      if (typeof v === 'number' && v > 32768) return errResponse(400, 'max_tokens is too large');
      return sseResponse([{ choices: [{ delta: { content: 'ok' } }] }, '[DONE]']);
    });
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(bodies.length).toBe(2);
    expect(bodies[1].max_tokens).toBe(32768);
    expect(readEndpointProfile(CFG.endpoint, CFG.model).maxTokensCap).toBe(32768);
  });

  it('stream_options 被拒 → 摘除并标记"用量不可用"，正文照常返回', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if ('stream_options' in b) return errResponse(400, 'Unrecognized request argument supplied: stream_options');
      return sseResponse([{ choices: [{ delta: { content: '正文' } }] }, '[DONE]']);
    });
    const chunks: string[] = [];
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), () => {}, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('正文');
    expect('stream_options' in bodies[1]).toBe(false);
    expect(readEndpointProfile(CFG.endpoint, CFG.model).usageUnavailable).toBe(true);
  });

  it('tools 被拒 → 摘除 + 档案标记；probeToolsSupport 之后不再探测（零 fetch）', async () => {
    const bodies: any[] = [];
    g.fetch = vi.fn(async (_url: string, init: any) => {
      const b = JSON.parse(init.body);
      bodies.push(b);
      if ('tools' in b) return errResponse(400, "Unsupported parameter: 'tools'");
      return sseResponse(['[DONE]']);
    });
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {}, {
      apiConfig: CFG, timeout: 0, idleTimeout: 0, tools: [{ type: 'function', function: { name: 'ping', parameters: { type: 'object', properties: {} } } }],
    });
    expect(readEndpointProfile(CFG.endpoint, CFG.model).toolsUnsupported).toBe(true);
    g.fetch = vi.fn(async () => { throw new Error('不应发起探测'); });
    const has = await APIHandler.probeToolsSupport({ apiConfig: CFG });
    expect(has).toBe(false);
    expect(g.fetch).not.toHaveBeenCalled();
  });
});

describe('响应形态自适应', () => {
  beforeEach(() => { clearProfiles(); APIHandler._apiCalls = []; APIHandler.abortController = null; });
  afterEach(() => { g.fetch = realFetch; });

  it('data: 无空格（SSE 规范允许）也能解析', async () => {
    g.fetch = vi.fn(async () => rawResponse('data:{"choices":[{"delta":{"content":"甲"}}]}\n\ndata:{"choices":[{"delta":{"content":"乙"}}]}\n\ndata:[DONE]\n\n'));
    const chunks: string[] = [];
    let full: string | null = null;
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), (f) => { full = f; }, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('甲乙');
    expect(full).toBe('甲乙');
  });

  it('整段 JSON（中转忽略 stream:true）也能取到正文', async () => {
    g.fetch = vi.fn(async () => rawResponse(JSON.stringify({ choices: [{ message: { content: '一次性正文' }, finish_reason: 'stop' }] })));
    const chunks: string[] = [];
    let full: string | null = null;
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), (f) => { full = f; }, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('一次性正文');
    expect(full).toBe('一次性正文');
  });

  it('NDJSON（Ollama 原生 message.content）逐行解析', async () => {
    g.fetch = vi.fn(async () => rawResponse(
      JSON.stringify({ message: { role: 'assistant', content: '第一' } }) + '\n' +
      JSON.stringify({ message: { role: 'assistant', content: '段' }, done: true }) + '\n'
    ));
    const chunks: string[] = [];
    let full: string | null = null;
    await APIHandler.fetchCompletions([{ role: 'user', content: 'hi' }], (c) => chunks.push(c), (f) => { full = f; }, () => {}, { apiConfig: CFG, timeout: 0, idleTimeout: 0 });
    expect(chunks.join('')).toBe('第一段');
    expect(full).toBe('第一段');
  });

  it('pickNonSseContent：OpenAI 兼容与 Ollama 两种形态', () => {
    expect(pickNonSseContent({ choices: [{ delta: { content: 'a' } }] }).content).toBe('a');
    expect(pickNonSseContent({ choices: [{ message: { content: 'b', reasoning_content: 'r' } }] })).toEqual({ content: 'b', reasoning: 'r' });
    expect(pickNonSseContent({ message: { content: 'c' } }).content).toBe('c');
    expect(pickNonSseContent({ response: 'd' }).content).toBe('d');
    expect(pickNonSseContent({}).content).toBeUndefined();
  });
});
