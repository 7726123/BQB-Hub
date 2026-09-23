// 真实 AI 端到端：写卡运行时 + 真实 API（deepseek-v4-flash）
// 用户粘一小段酒馆 JSON → 期望 agent 主动调 read_adapter_doc + adapt_tavern_lorebook → 报告念给用户。
// 配置从环境变量读（BQB_TEST_ENDPOINT / BQB_TEST_KEY / BQB_TEST_MODEL），不落盘。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

const anyG = globalThis as unknown as Record<string, unknown>;

// ---------- 模块顶层建全局桩（早于动态 import cardwriter） ----------
anyG.WorldBookManager = { getActiveId: () => null, getAll: () => [], getActive: () => null, saveAll: () => undefined, getActiveWorldBook: () => null, isEnabled: () => false };
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
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
  // 真实配置从环境变量读
  anyG.PresetManager = {
    getActiveAPIConfig: () => ({
      endpoint: process.env.BQB_TEST_ENDPOINT || '',
      apiKey: process.env.BQB_TEST_KEY || '',
      model: process.env.BQB_TEST_MODEL || '',
    }),
  };
  // 先加载 api 模块（挂全局 APIHandler，cardwriter 裸标识符依赖它）
  await import('../src/domain/api');
  await import('../src/domain/cardwriter');
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

// 小型酒馆 JSON（含各分类特征：角色/世界观/数值系统/输出指令/分隔占位/模糊条目）
const SAMPLE_JSON = JSON.stringify({
  name: '测试世界书',
  entries: {
    '0': { uid: 0, key: ['林晚'], comment: '角色:林晚', content: '{{char}}是个怕黑的女高中生。{{user}}是她的同桌。', order: 10 },
    '1': { uid: 1, key: ['小镇'], comment: '世界观:小镇与世界', content: '雨城是常年下雨的南方小镇，全镇被一条河分成东西两岸。', order: 20 },
    '2': { uid: 2, key: [], comment: '[InitVar]变量初始化', content: '时间: 2030年4月\n地点: 雨城\n林晚:\n  好感度: 0\n  心情: 平静\n  关系: 同桌', order: 30 },
    '3': { uid: 3, key: [], comment: '====CG系统====_开始', content: '', order: 5 },
    '4': { uid: 4, key: [], comment: '[mvu_plot]CG触发', content: '当剧情触发时，必须在正文插入插画标签！！', order: 40 },
    '5': { uid: 5, key: [], comment: '身份之谜', content: '林晚的母亲在十年前失踪，她从不提起。但有一件事：\n她房间的抽屉里锁着一本写满陌生城市名的日记。', order: 50 },
  },
});

describe('真实 AI 端到端：粘酒馆 JSON → agent 适配', () => {
  it('agent 主动读文档 + 调适配工具 + 输出报告（真实 API）', async () => {
    if (!process.env.BQB_TEST_KEY) { console.log('SKIP: 未提供 BQB_TEST_KEY'); return; }
    const c = Cw();
    c.messages = [];
    c._isSending = false;
    c._toolsHandled = false;
    c._wbWritten = false;
    c._repeatKey = null;
    c._repeatCount = 0;
    c._fixCount = 0;
    c._draft = { entries: [], characters: [] };
    c.refreshContext = () => {};
    c._syncDraftFromWorldbook = () => {};
    c._context = null;

    (document.getElementById('cardwriterInput') as any).value = '这是酒馆的世界书 JSON，帮我改成适配本软件的版本：\n' + SAMPLE_JSON;
    const started = Date.now();
    c.sendMessage();
    // 等待 agent 循环结束（真实 API，最多 4 分钟）
    await viWait(() => expect(c._isSending).toBe(false), 240000);
    console.log('耗时(ms):', Date.now() - started);

    // 收集消息轨迹
    const trace = (c.messages || []).map((m: any) => {
      if (m.role === 'tool') return '  [tool] ' + String(m.content || '').slice(0, 120);
      if (m.tool_calls) return '  [assistant→tools] ' + m.tool_calls.map((t: any) => t.function.name).join(', ');
      return '  [' + m.role + '] ' + String(m.content || '').slice(0, 200);
    });
    console.log('===== 消息轨迹 (' + (c.messages || []).length + ' 条) =====\n' + trace.join('\n'));

    const allNames = (c._lastTurnTools || []).join(',');
    console.log('===== 最后轮工具: ' + (allNames || '（无）'));
    expect(c._isSending).toBe(false);
  }, 300000);
});

// 简易 waitFor（避免引入额外依赖）
function viWait(cond: () => void, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      try { cond(); resolve(); } catch (e) {
        if (Date.now() - t0 > timeoutMs) reject(new Error('waitFor 超时: ' + String(e)));
        else setTimeout(tick, 1000);
      }
    };
    tick();
  });
}