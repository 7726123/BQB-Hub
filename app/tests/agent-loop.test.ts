// 工具调用（agent 循环）自动化测试：
// A. APIHandler 原生工具协议解析（流式 tool_calls 拼装 / onTools 交接 / 无工具→正文）
// B. 写卡 agent 循环契约（工具回灌 role:'tool' / 循环终止 / 8 轮上限）
// 注：cardwriter.ts 模块顶层即执行 init()（裸读 WorldBookManager 等全局），
// 因此必须模块级先建全局桩 + beforeAll 动态 import（import 早于 it）。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { APIHandler } from '../src/domain/api';

const anyG = globalThis as unknown as Record<string, unknown>;

// ---------- 模块顶层建全局桩（早于动态 import cardwriter） ----------
anyG.WorldBookManager = { getActiveId: () => null, getAll: () => [], getActive: () => null, saveAll: () => undefined, getActiveWorldBook: () => null, isEnabled: () => false };
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' }) };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
anyG.escapeHTML = (x: unknown) => String(x == null ? '' : x);

function el(): any {
  return {
    value: '', innerHTML: '', textContent: '', style: { setProperty() {}, display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    children: [], scrollTop: 0, checked: false,
    querySelector: () => el(),
  };
}

beforeAll(async () => {
  await import('../src/domain/cardwriter'); // 顶层 init() 会读全局桩
});

const els = new Map<string, any>();
beforeEach(() => {
  els.clear();
  anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), getElementsByClassName: () => [], body: el(),
  };
  anyG.StorageManager = { get: (_k: string, d: unknown) => d, set: () => undefined };
  anyG.App = { toast() {}, resetChatInput() {}, getBackendAPIConfig() { return null; }, thinkingLevel() { return 'auto'; } };
});

const Cw = (): any => anyG.CardWriterChat;

// ---------- 工具：SSE 响应构造 ----------
function sseResponse(events: Record<string, unknown>[]): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      events.forEach((e) => controller.enqueue(enc.encode('data: ' + JSON.stringify(e) + '\n\n')));
      controller.enqueue(enc.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body as unknown as ReadableStream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}
const delta = (d: Record<string, unknown>) => ({ choices: [{ delta: d }] });
const TOOLS = [{ type: 'function', function: { name: 'upsert_entry', description: '写入条目', parameters: { type: 'object', properties: {} } } }];
const CFG = { endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' };

describe('A. APIHandler 工具协议（真代码 + 假 SSE）', () => {
  let bodies: Record<string, unknown>[] = [];
  beforeEach(() => { bodies = []; });

  it('流式 tool_calls 拼装并交给 onTools（参数 JSON 跨 chunk 累积）', async () => {
    const events = [
      delta({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: 'call_1', function: { name: 'upsert_entry', arguments: '' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"type":"初始"' } }] }),
      delta({ tool_calls: [{ index: 0, function: { arguments: ',"name":"x","content":"y"}' } }] }),
    ];
    anyG.fetch = async () => sseResponse(events);
    let tools: { id: string; name: string; arguments: Record<string, unknown> }[] | null = null;
    let done = false;
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '写入' }],
      () => {}, (full: string | null) => { done = true; void full; },
      () => {},
      { apiConfig: CFG, tools: TOOLS, onTools: (c: { id: string; name: string; arguments: Record<string, unknown> }[]) => { tools = c; }, timeout: 0, idleTimeout: 0 }
    );
    expect(tools).toHaveLength(1);
    expect(tools![0].name).toBe('upsert_entry');
    expect(tools![0].id).toBe('call_1');
    expect(tools![0].arguments).toEqual({ type: '初始', name: 'x', content: 'y' });
    expect(done).toBe(false); // 有工具调用时不走 onDone
  });

  it('无工具调用 → onDone 拿到正文，onTools 不触发', async () => {
    anyG.fetch = async () => sseResponse([delta({ content: '好的，这是设计建议。' })]);
    let toolsCalled = false;
    let final = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '讨论' }],
      () => {}, (full: string | null) => { final = full || ''; },
      () => {},
      { apiConfig: CFG, tools: TOOLS, onTools: () => { toolsCalled = true; }, timeout: 0, idleTimeout: 0 }
    );
    expect(toolsCalled).toBe(false);
    expect(final).toContain('好的');
  });

  it('工具参数 JSON 非法 → arguments 容错为空对象 + argsError 带解析错误原文，仍交接给 onTools', async () => {
    const events = [delta({ tool_calls: [{ index: 0, id: 'c2', function: { name: 'upsert_entry', arguments: 'not-json{{' } }] })];
    anyG.fetch = async () => sseResponse(events);
    let got: { arguments: Record<string, unknown>; argsError?: string } | null = null;
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '写' }],
      () => {}, () => {},
      () => {},
      { apiConfig: CFG, tools: TOOLS, onTools: (c: { arguments: Record<string, unknown>; argsError?: string }[]) => { got = c[0]; }, timeout: 0, idleTimeout: 0 }
    );
    expect(got!.arguments).toEqual({});
    expect(String(got!.argsError || '')).toContain('JSON'); // 模型能看到根因（区别于「缺少参数」）
  });

  it('合法 JSON → 不带 argsError', async () => {
    const events = [delta({ tool_calls: [{ index: 0, id: 'c3', function: { name: 'upsert_entry', arguments: '{"type":"初始"}' } }] })];
    anyG.fetch = async () => sseResponse(events);
    let got: { argsError?: string } | null = null;
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '写' }],
      () => {}, () => {},
      () => {},
      { apiConfig: CFG, tools: TOOLS, onTools: (c: { argsError?: string }[]) => { got = c[0]; }, timeout: 0, idleTimeout: 0 }
    );
    expect(got!.argsError).toBeUndefined();
  });

  it('请求体携带 tools 且 stream=true', async () => {
    anyG.fetch = async (_u: RequestInfo | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return sseResponse([delta({ content: 'x' })]);
    };
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: 'x' }],
      () => {}, () => {},
      () => {},
      { apiConfig: CFG, tools: TOOLS, timeout: 0, idleTimeout: 0 }
    );
    expect(bodies[0].tools).toBeDefined();
    expect(bodies[0].stream).toBe(true);
  });

  it('流式 reasoning_content → onReasoning 逐段回调，不混入正文，onDone 附带完整思维链', async () => {
    const events = [
      delta({ role: 'assistant', content: null, reasoning_content: '分析需求…' }),
      delta({ reasoning_content: '确定方案。' }),
      delta({ content: '这是结论。' }),
    ];
    anyG.fetch = async () => sseResponse(events);
    const rcChunks: string[] = [];
    let bodyText = '';
    let doneReasoning = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '讨论' }],
      (c: string) => { bodyText += c; },
      (_full: string | null, _aborted: boolean, reasoning?: string) => { doneReasoning = reasoning || ''; },
      () => {},
      { apiConfig: CFG, tools: TOOLS, timeout: 0, idleTimeout: 0, onReasoning: (c: string) => rcChunks.push(c) }
    );
    expect(rcChunks).toEqual(['分析需求…', '确定方案。']);
    expect(bodyText).toBe('这是结论。');
    expect(doneReasoning).toBe('分析需求…确定方案。');
  });

  it('网关流式每帧带 usage → 一次请求只入账一条用量记录（修复几千次虚高）', async () => {
    // 模拟 opencode router：每个 SSE 帧都附 usage 字段
    const frames: Record<string, unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      frames.push({ choices: [{ delta: { content: '段' } }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
    }
    anyG.fetch = async () => sseResponse(frames);
    (APIHandler as unknown as { _apiCalls: { label: string }[] })._apiCalls.length = 0;
    let final = '';
    await APIHandler.fetchCompletions(
      [{ role: 'user', content: '续写' }],
      () => {}, (full: string | null) => { final = full || ''; },
      () => {},
      { apiConfig: CFG, callLabel: 'generate', timeout: 0, idleTimeout: 0 }
    );
    const gen = (APIHandler as unknown as { _apiCalls: { label: string; promptTokens: number }[] })._apiCalls.filter((c) => c.label === 'generate');
    expect(gen.length).toBe(1); // 20 帧 × usage ≠ 20 次调用，只入账一条
    expect(final).toBe('段'.repeat(20));
    expect(gen[0].promptTokens).toBe(100);
  });
});

describe('B. 写卡 agent 循环契约', () => {
  let calls: { messages: unknown[]; overrides: Record<string, unknown> }[];
  let toolRounds: number;

  function stubLoop(mode: 'two' | 'cap') {
    // two: 第 1 轮工具、第 2 轮正文；cap: 连续 25 轮工具（要盖过 24 轮上限，
    // 否则是桩自己收尾、测不到上限终止）
    const target = mode === 'cap' ? 25 : 1;
    calls = [];
    toolRounds = 0;
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = (
      messages: unknown[], _chunk: () => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      toolRounds++;
      if (toolRounds <= target) {
        (overrides.onTools as (t: { id: string; name: string; arguments: Record<string, unknown> }[]) => void)([
          { id: 'call_' + toolRounds, name: 'upsert_entry', arguments: { type: '初始', name: 'x', content: 'y' } },
        ]);
      } else {
        onDone('已写入并落库', false, '');
      }
    };
  }

  function setupCard() {
    const c = Cw();
    // 写工具成功 → 同步置 _writeOk（真实现里由 _handleTools 置位；假「已写入」兜底依赖它）
    c._handleTools = (tools: { name: string }[]) => tools.map((t) => {
      c._toolsOk = true; // 真实现：任意一条调用 ok=true 就置位（含只读工具）
      if (['apply_character', 'delete_character', 'update_worldview', 'upsert_entry', 'delete_entry', 'set_entry_type'].indexOf(t.name) >= 0) c._writeOk = true;
      return '{"ok":true,"message":"ok"}';
    });
    c.refreshContext = () => {};
    c._syncDraftFromWorldbook = () => {};
    c._context = null;
    c._draft = null;
    c.messages = [];
    c._isSending = false;
    c._toolsHandled = false;
    c._writeOk = false;
    c._toolsOk = false;
    c._toolRounds = 0;
    c._wbWritten = false;
    c._repeatKey = null;
    c._repeatCount = 0;
    c._fixCount = 0;
  }

  it('工具轮 → 回灌 role:"tool" → 下一轮收到执行结果 → 最终正文（两轮闭环）', async () => {
    stubLoop('two');
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '帮我写入设定：林晚，怕黑。';
    Cw().sendMessage();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    const round2 = calls[1].messages as { role: string; content?: string; tool_call_id?: string }[];
    const toolMsg = round2.find((m) => m.role === 'tool' && m.tool_call_id === 'call_1');
    expect(toolMsg).toBeDefined();
    expect(String((toolMsg as { content?: string }).content || '')).toContain('"ok":true');
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    expect(calls.length).toBe(2);
  });

  it('单轮多工具 → 回灌为标准形：一条 assistant 携带全部 tool_calls + 逐条 tool 结果（不重复 N 份文字）', async () => {
    calls = [];
    toolRounds = 0;
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = (
      messages: unknown[], _chunk: () => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      toolRounds++;
      if (toolRounds === 1) {
        (overrides.onTools as (t: { id: string; name: string; arguments: Record<string, unknown> }[]) => void)([
          { id: 'call_a', name: 'upsert_entry', arguments: { type: '初始', name: 'x', content: 'y' } },
          { id: 'call_b', name: 'apply_character', arguments: { name: '林晚', content: '姓名：林晚' } },
          { id: 'call_c', name: 'update_worldview', arguments: { name: '世界背景', content: 'c' } },
        ]);
      } else {
        onDone('已写入并落库', false, '');
      }
    };
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '直接写入这些设定';
    Cw().sendMessage();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    const round2 = calls[1].messages as { role: string; content?: string; tool_calls?: { id: string }[]; tool_call_id?: string }[];
    const assistants = round2.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    expect(assistants).toHaveLength(1); // 合并为一条 assistant
    expect(assistants[0].tool_calls!.map((t) => t.id)).toEqual(['call_a', 'call_b', 'call_c']);
    const toolMsgs = round2.filter((m) => m.role === 'tool');
    expect(toolMsgs.map((m) => m.tool_call_id)).toEqual(['call_a', 'call_b', 'call_c']); // 逐条结果、顺序对应
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
  });

  it('24 轮上限：模型连续调工具 ≥25 次 → 循环终止不卡死', async () => {
    stubLoop('cap');
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '帮我构建好整套设定，直接写入';
    Cw().sendMessage();
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(25));
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    // round 0..24 后 round=25 > 24 终止，不再发请求。
    // 上限从 8 提到 24：8 轮时「5 调用/轮 × 9 轮」清不完上百条的大卡。
    expect(calls.length).toBe(25);
  });

  // ---- 2026-09-26 用户：写卡常出现「AI 报已写入但实际没写入」----
  // 根因：前端按关键词判定"要不要给工具"，判漏（用户其实是要写入）时模型手里根本没工具，
  // 却照提示词输出「已写入」。工具改为常开；设计阶段只软约束 + 一轮上限。
  it('设计轮仍带 tools：关键词判漏时模型能真的写进去（不是只说不做）', async () => {
    stubLoop('two');
    setupCard();
    // 这句话会被判成设计轮（含"我想做一个新角色"这类构思语气）
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '我想做一个新角色：女高中生，怕黑';
    Cw().sendMessage();
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    expect(calls[0].overrides.tools).toBeDefined();          // 设计轮也有工具（旧实现这里是 undefined）
    const names = (calls[0].overrides.tools as { function: { name: string } }[]).map((t) => t.function.name);
    expect(names).toContain('upsert_entry');
    expect(calls.length).toBe(2);                             // 工具轮 + 收尾文字轮都跑完
    expect(Cw()._designTurn).toBe(true);
    expect(Cw()._writeOk).toBe(true);                         // 工具真的执行了
  });

  it('设计轮收尾：提交过一轮后注入「不要再调工具」，轮数收在 2 轮内（不像操作轮磨到 24 轮）', async () => {
    calls = [];
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = (
      messages: unknown[], onChunk: (c: string) => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages: (messages as unknown[]).slice(), overrides }); // 快照：messages 数组随后还会被追加
      if (calls.length <= 2) {
        (overrides.onTools as (t: { id: string; name: string; arguments: Record<string, unknown> }[]) => void)([
          { id: 'call_' + calls.length, name: 'upsert_entry', arguments: { type: '其他', name: 'x', content: 'y' } },
        ]);
      } else {
        onChunk('剩下的我下次再提交。'); // 第三次请求：模型改用文字
        onDone('剩下的我下次再提交。', false, '');
      }
    };
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '我想做一个新角色：女高中生，怕黑';
    Cw().sendMessage();
    // 设计轮 = 1 轮提交 + 1 轮收尾文字（第 3 次请求在拒绝后再给一轮），总之不会磨到 24 轮
    await vi.waitFor(() => expect(calls.length).toBe(3)); // 用重试等待：微任务里的后续轮次可能晚于 _isSending 翻转
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    const round1 = calls[1].messages as { role: string; content?: string }[];
    const nudge = round1.filter((m) => m.role === 'system' && String(m.content || '').includes('【设计轮·收尾】'));
    expect(nudge).toHaveLength(1);
    expect(Cw()._toolRounds).toBe(2); // 模型连着调了两轮工具（第 2 轮在 _handleTools 里被拒，见批量用例）
  });

  it('假「已写入」兜底：一次写工具都没调却说已写入 → 气泡里点破（世界书没有变化）', async () => {
    calls = [];
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = (
      messages: unknown[], onChunk: (c: string) => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      expect(overrides.tools).toBeDefined(); // 工具确实给了——模型是自己没调，不是没工具
      onChunk('已写入：林晚（新增）、世界背景（新增）。');
      onDone('已写入：林晚（新增）、世界背景（新增）。', false, '');
    };
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '写入吧';
    Cw().sendMessage();
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    // 收尾核对在循环返回后的几个微任务里跑 → 用重试等待它落笔（不要抢在它前面读）
    await vi.waitFor(() => expect(String(((Cw().messages as { content?: string }[]).slice(-1)[0]).content)).toContain('系统核对'));
    expect(Cw()._writeOk).toBe(false);
    const ai = (Cw().messages as { content?: string }[]).slice(-1)[0];
    expect(String(ai.content)).toContain('已写入：林晚');      // 模型原话保留（用户能看到它说了什么）
    expect(String(ai.content)).toContain('世界书没有变化');
  });

  it('只读工具（read_current_book_json）成功不算写过：说「已写入」仍会被点破', async () => {
    calls = [];
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = (
      messages: unknown[], onChunk: (c: string) => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      if (calls.length === 1) {
        (overrides.onTools as (t: { id: string; name: string; arguments: Record<string, unknown> }[]) => void)([
          { id: 'call_read', name: 'read_current_book_json', arguments: { names: ['林晚'] } },
        ]);
      } else {
        onChunk('已经读取并写入完成。'); // 只读工具 success，却声称写完了
        onDone('已经读取并写入完成。', false, '');
      }
    };
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '看一下当前卡再写入';
    Cw().sendMessage();
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    await vi.waitFor(() => expect(String(((Cw().messages as { content?: string }[]).slice(-1)[0]).content)).toContain('系统核对'));
    expect(Cw()._toolsOk).toBe(true);   // 只读工具成功
    expect(Cw()._writeOk).toBe(false);  // 但没有任何写工具成功
    const ai = (Cw().messages as { content?: string }[]).slice(-1)[0];
    expect(String(ai.content)).toContain('系统核对');
  });

  it('深度思考：流式实时显示 → 正文首字折叠归档进消息，渲染折叠思维链块', async () => {
    const fakeFetch: unknown = (
      messages: unknown[], onChunk: (c: string) => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      setTimeout(() => {
        (overrides.onReasoning as (c: string) => void)('先分析用户需求…');
        (overrides.onReasoning as (c: string) => void)('确定角色方向。');
        onChunk('好的');
        onChunk('，已经想清楚了。');
        setTimeout(() => onDone(null, false), 0);
      }, 0);
      return Promise.resolve();
    };
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = fakeFetch;
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '帮我聊聊主角设定';
    Cw().sendMessage();
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    const msgs = Cw().messages as { role: string; content?: string; reasoning?: string; reasoningLive?: string }[];
    const ai = msgs[msgs.length - 1];
    expect(ai.role).toBe('assistant');
    expect(ai.content).toBe('好的，已经想清楚了。');
    expect(ai.reasoning).toBe('先分析用户需求…确定角色方向。'); // 折叠归档
    expect(ai.reasoningLive || '').toBe(''); // 实时区已清空
    // 渲染：折叠思维链块 + 正文；不再有"思考中"实时态
    const html = (document.getElementById('cardwriterMessages') as unknown as { innerHTML: string }).innerHTML;
    expect(html).toContain('cw-think');
    expect(html).toContain('已深度思考');
    expect(html).toContain('先分析用户需求…');
    expect(html).not.toContain('<div class="cw-think open">');
  });

  it('纯思考轮（无正文直接调工具）→ 思考也归档，不丢失', async () => {
    let round = 0;
    const fakeFetch2: unknown = (
      messages: unknown[], _onChunk: (c: string) => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      round++;
      if (round === 1) {
        setTimeout(() => {
          (overrides.onReasoning as (c: string) => void)('需要先写入条目。');
          // 真实时序：SSE 先出 tool_calls 增量（onToolCallStart），流结束才交 onTools
          (overrides.onToolCallStart as () => void)();
          (overrides.onTools as (t: { id: string; name: string; arguments: Record<string, unknown> }[]) => void)([
            { id: 'call_t1', name: 'upsert_entry', arguments: { type: '其他', name: '备注', content: 'x' } },
          ]);
        }, 0);
      } else {
        setTimeout(() => {
          (overrides.onReasoning as (c: string) => void)('写入完成，汇报结果。');
          _onChunk('已写入：备注');
          setTimeout(() => onDone(null, false), 0);
        }, 0);
      }
      return Promise.resolve();
    };
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = fakeFetch2;
    setupCard();
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '直接写入一个备注';
    Cw().sendMessage();
    await vi.waitFor(() => expect(Cw()._isSending).toBe(false));
    const msgs = Cw().messages as { reasoning?: string }[];
    const ai = msgs[msgs.length - 1];
    expect(ai.reasoning).toContain('需要先写入条目。');
    expect(ai.reasoning).toContain('写入完成，汇报结果。'); // 两轮思考都归档
  });

  it('思维链折叠块：toggleThink 展开/收起，重建后状态不丢（修复"点不开"）', () => {
    const c = Cw();
    c._isSending = false;
    c._pressMsgIdx = -1;
    c.messages = [{ role: 'assistant', content: '这是结论。', reasoning: '一段比较长的思考内容，可能上千字。' }];
    c.renderMessages();
    const box = document.getElementById('cardwriterMessages') as unknown as { innerHTML: string };
    expect(box.innerHTML).toContain('<details class="cw-think">'); // 默认折叠
    expect(box.innerHTML).not.toContain('<details class="cw-think" open');
    expect(box.innerHTML).toContain('toggleThink(event,0)'); // summary 绑定手动 toggle
    // 模拟点击 summary（inline onclick → toggleThink）
    const ev = () => ({ preventDefault: () => {}, stopPropagation: () => {} });
    c.toggleThink(ev(), 0);
    expect(box.innerHTML).toContain('<details class="cw-think" open>'); // 展开
    expect(box.innerHTML).toContain('一段比较长的思考内容');
    // 重建（如全局 click 收菜单触发的 renderMessages）不丢展开状态
    c.renderMessages();
    expect(box.innerHTML).toContain('<details class="cw-think" open>');
    c.toggleThink(ev(), 0);
    expect(box.innerHTML).not.toContain('<details class="cw-think" open'); // 收起
  });

  it('流式渲染节流：密集增量只触发少量 UI 重建（防主线程打满页面卡死）', async () => {
    const fakeFetch3: unknown = (
      messages: unknown[], onChunk: (c: string) => void, onDone: (...a: unknown[]) => void, _err: (...a: unknown[]) => void, overrides: Record<string, unknown>
    ) => {
      calls.push({ messages, overrides });
      // 同一 tick 内密集倾倒：60 次思考增量 + 30 次正文增量（真实场景的极端化）
      for (let i = 0; i < 60; i++) (overrides.onReasoning as (c: string) => void)('思');
      for (let i = 0; i < 30; i++) onChunk('文');
      setTimeout(() => onDone(null, false), 50);
      return Promise.resolve();
    };
    (APIHandler as unknown as { fetchCompletions: unknown }).fetchCompletions = fakeFetch3;
    setupCard();
    const c = Cw();
    const renderCount = { n: 0 };
    const orig = (c.renderMessages as (...a: unknown[]) => unknown).bind(c);
    c.renderMessages = function (...a: unknown[]) { renderCount.n++; return orig(...a); };
    (document.getElementById('cardwriterInput') as unknown as { value: string }).value = '压测';
    c.sendMessage(); // 同步阶段：push user/assistant 各渲染 1 次
    const baseline = renderCount.n; // ≈2
    expect(baseline).toBeGreaterThanOrEqual(1);
    // 90 个增量全部到达后 120ms 内：节流后最多再渲染 1 帧
    await new Promise((r) => setTimeout(r, 110));
    const duringStream = renderCount.n - baseline;
    expect(duringStream).toBeLessThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 300)); // 等完成
    expect(c._isSending).toBe(false);
    const ai = c.messages[c.messages.length - 1];
    expect(ai.content).toBe('文文文文文文文文文文文文文文文文文文文文文文文文文文文文文文');
    expect(ai.reasoning).toBe('思'.repeat(60));
  });
});