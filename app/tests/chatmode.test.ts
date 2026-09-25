// 对话模式（domain/chatmode.ts）：按书隔离、提示词组装、流式缓冲、落库与诊断。
// 覆盖用户明确要求的三件事：① 记录按书分开（切书自动切换、生成途中切书不串台）；
// ② 两种模式共用同一份世界书（不读小说模式的临时 overlay）；③ 提示词里指定字数（不让 AI 自己分配）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import '../src/infra/storage';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { PresetManager } from '../src/domain/preset';
import { APIHandler } from '../src/domain/api';
import { SettingSyncManager } from '../src/domain/settingsync';
import { PluginManager } from '../src/domain/plugins';
import { parseBubbles } from '../src/lib/bubble';
import { UsageStats } from '../src/lib/usage';
import { ChatMode } from '../src/domain/chatmode';

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, any>;

// ---- 迷你 DOM（只实现被测代码用到的成员）----
function makeEl(id: string): any {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const classes = new Set<string>();
  return {
    id, style: {}, innerHTML: '', textContent: '', value: '', placeholder: '',
    scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    classList: {
      add: (c: string) => { classes.add(c); },
      remove: (c: string) => { classes.delete(c); },
      toggle: (c: string, on?: boolean) => { const want = on === undefined ? !classes.has(c) : !!on; if (want) classes.add(c); else classes.delete(c); return want; },
      contains: (c: string) => classes.has(c),
    },
    addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    _fire: (t: string, e: any = {}) => (listeners[t] || []).forEach(fn => fn(e)),
  };
}
const els: Record<string, any> = {};
function setupDom() {
  ['chatStream', 'chatInput', 'chatSendBtn', 'chatStopBtn', 'chatUndoBtn', 'chatStatus', 'chatScrollBottom',
    'chatProfileModal', 'chatProfileBody', 'chatProfileTitle',
    'chatBg', 'chatStreamWrap', 'chatBgBtn']
    .forEach(id => { els[id] = makeEl(id); });
}
globalThis.document = {
  getElementById: (id: string) => els[id] || null,
} as any;

// ---- 预设 / 世界书 / 全局桩 ----
const PRESET_ID = 'p_chat_test';
function setupPreset(lengthWords: number | null, opts: { overlayEntries?: any[] } = {}) {
  const mods: any[] = [
    { id: 'm_style', name: '文风', content: '# 文风\n- 克制。', enabled: true, role: 'system', order: 8 },
    { id: 'm_pov', name: '视角·第一人称', content: '# 视角\n- 主角用「我」。', enabled: true, role: 'system', order: 9 },
    { id: 'm_off', name: '关掉的模块', content: '# 不该出现\n- 这段话不能被注入。', enabled: false, role: 'system', order: 10 },
  ];
  if (lengthWords) mods.push({ id: 'm_len', name: '字数·' + lengthWords, content: '# 字数\n\n- 本次输出约 ' + lengthWords + ' 字。', enabled: true, role: 'system', order: 15 });
  PresetManager.savePresets([{ id: PRESET_ID, name: '测试预设', prompts: [], promptModules: mods, systemPromptId: 'sp_default', isDefault: false, createdAt: 1 } as any]);
  PresetManager.setCurrentPresetId(PRESET_ID);
  // 小说模式的临时 overlay：对话模式必须**不读**它（用户要求两种模式各存各的）
  if (opts.overlayEntries) {
    g.SettingSyncManager = { isActive: () => true, getEffectiveEntries: () => opts.overlayEntries };
  } else {
    delete g.SettingSyncManager;
  }
}

function seedBooks() {
  WBM.saveAll([]);
  const a = WBM.createBook('甲书');
  WBM.saveAll(WBM.getAll());
  const b = WBM.createBook('乙书');
  WBM.saveAll(WBM.getAll());
  // 甲书：三个角色 + 一条世界观（含头像）；乙书：一个角色
  const all = WBM.getAll();
  all.find(w => w.id === a.id)!.entries = [
    { id: 'e1', type: '角色', name: '林薇', content: '说话直接，讨厌被同情。', avatar: 'data:image/jpeg;base64,AAAA' },
    { id: 'e2', type: '角色', name: '陈亦', content: '话少，会弹吉他。' },
    { id: 'e3', type: '角色', name: '林薇（副）', content: '学生会副会长。', inject: true },
    { id: 'e4', type: '世界观', name: '学校与天台', content: '天台平时锁着。' },
  ];
  all.find(w => w.id === b.id)!.entries = [{ id: 'f1', type: '角色', name: '苏老师', content: '班主任。' }];
  WBM.saveAll(all);
  WBM.setActiveId(a.id);
  return { a: a.id, b: b.id };
}

const apiCalls: any[] = [];
function stubApp() {
  g.htmlEscape = undefined;
  g.App = {
    toast: vi.fn(),
    getProtagonist: () => ({ name: '林叶' }),
    thinkingLevel: () => 'off',
    saveCurrentChapter: vi.fn(),
  };
  g.confirm = () => true;   // 撤回覆盖输入框前的确认
  g.EditorManager = { insertAtCursor: vi.fn(() => true) };
  g.UIManager = { viewAvatar: vi.fn(), pickAvatar: vi.fn() };
  // chatmode 走 ES import 拿 APIHandler（不是全局），所以桩要打在真实对象的方法上
  (APIHandler as any).abort = vi.fn();
  (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any, _onErr: any, ov: any) => {
    apiCalls.push({ msgs, ov });
    onDelta('林薇：「你怎么才来。」\n林叶：我把笔帽扣上。\n白：天暗了下来。');
    onOk('林薇：「你怎么才来。」\n林叶：我把笔帽扣上。\n白：天暗了下来。', false, '思考内容');
  };
}

beforeEach(() => {
  setupDom();
  stubApp();
  apiCalls.length = 0;
  ['worldBooks', 'activeWorldBookId', 'presets', 'currentPresetId', 'chatInputMode'].forEach(k => {
    try { g.StorageManager.remove(k); } catch (e) { /* ignore */ }
  });
  ChatMode._sending = false; ChatMode._acc = ''; ChatMode._streamBookId = ''; ChatMode._loadedBookId = '';
  ChatMode._window = 120; ChatMode._status = ''; ChatMode._reasoningChars = 0; ChatMode._scrollOnce = true;
  // 用量记账的会话状态归零：上一个用例若中途结束，beginSession 的"不抢已开会话"守卫会挡住新会话
  (UsageStats as unknown as { _sessionStartIndex: number | null; _sessionStartTime: number | null })._sessionStartIndex = null;
  (UsageStats as unknown as { _sessionStartIndex: number | null; _sessionStartTime: number | null })._sessionStartTime = null;
});

describe('按书隔离', () => {
  it('记录挂在自己的书上：切换当前书 → log() 跟着换', () => {
    const { a, b } = seedBooks();
    ChatMode.append('ai', '甲书的第一轮');
    WBM.setActiveId(b);
    expect(ChatMode.log()).toHaveLength(0);
    ChatMode.append('ai', '乙书的第一轮');
    WBM.setActiveId(a);
    expect(ChatMode.log().map(m => m.raw)).toEqual(['甲书的第一轮']);
  });

  // 用户 2026-09-25：清空后输入框里还留着上一句（旧实现只清演出记录），且用的系统 confirm、
  // 跟小说模式「重置本书」的应用内确认框不一致。现在两者都对齐。
  it('清空：演出记录 + 输入栏 + 当轮状态一起清（同款应用内确认框）', () => {
    seedBooks();
    ChatMode.append('ai', '第一轮演出');
    ChatMode.append('author', '没发出去的一句', { hidden: true } as any);
    els['chatInput'].value = '没发出去的一句';
    ChatMode._acc = '半截流式缓冲';
    ChatMode._status = '正在思考…';
    ChatMode.clearAll();
    expect(ChatMode.log()).toHaveLength(0);                     // 记录清掉
    expect(els['chatInput'].value).toBe('');                    // 输入栏也清掉（本次修复的重点）
    expect(ChatMode._acc).toBe('');
    expect(ChatMode._status).toBe('');
    expect(ChatMode._lastInstruction).toBe('');
  });

  it('生成途中切书：结果落回开始的哪本书，不串台', () => {
    const { a, b } = seedBooks();
    ChatMode._appendToBook(a, 'ai', '属于甲书');
    WBM.setActiveId(b);
    ChatMode._appendToBook(a, 'ai', '也属于甲书');
    expect(ChatMode.log()).toHaveLength(0);
    WBM.setActiveId(a);
    expect(ChatMode.log().map(m => m.raw)).toEqual(['属于甲书', '也属于甲书']);
  });

  it('存储上限：超出后丢最早的，条数不涨', () => {
    const { a } = seedBooks();
    const wb = WBM.getAll().find(w => w.id === a)!;
    wb.chatLog = Array.from({ length: 1200 }, (_, i) => ({ id: 'x' + i, kind: 'ai', raw: '第' + i, at: i }));
    WBM.saveAll(WBM.getAll());
    ChatMode._appendToBook(a, 'ai', '最后一条');
    const log = ChatMode.log();
    expect(log).toHaveLength(1200);
    expect(log[log.length - 1].raw).toBe('最后一条');
    expect(log[0].raw).toBe('第1');   // 最早的「第0」被丢掉
  });
});

describe('提示词组装（同一份世界书 + 指定字数）', () => {
  it('system：启用模块按 order 注入，含世界书与格式块，禁用模块不出现', () => {
    seedBooks();
    setupPreset(1500);
    const sys = ChatMode.buildSystem();
    expect(sys.indexOf('# 文风')).toBeGreaterThan(-1);
    expect(sys.indexOf('# 视角')).toBeGreaterThan(-1);
    expect(sys.indexOf('不该出现')).toBe(-1);
    expect(sys.indexOf('## 世界书条目')).toBeGreaterThan(-1);
    expect(sys.indexOf('林薇')).toBeGreaterThan(-1);
    expect(sys.indexOf('对话演出（本模式唯一的输出格式）')).toBeGreaterThan(-1);
    expect(sys.indexOf('林薇、陈亦')).toBeGreaterThan(-1);        // 名单 = 世界书「角色」条目名…
    expect(sys.indexOf('、林叶')).toBeGreaterThan(-1);             // …+ 主角名
    expect(sys.indexOf('本次输出约 1500 字')).toBeGreaterThan(-1);
    expect(sys.indexOf('深度思考已关闭')).toBeGreaterThan(-1);      // thinkingLevel=off
  });

  it('读对话模式自己的临时世界书，不读小说模式那份（各存各的）', () => {
    seedBooks();
    setupPreset(1500);
    // chatmode 走 ES import 拿 SettingSyncManager（不是全局），桩要打在真实对象上
    const SS = SettingSyncManager as any;
    const orig = { isActive: SS.isActive, setMode: SS.setMode, getEffectiveEntries: SS.getEffectiveEntries, getOverlay: SS.getOverlay };
    let mode = 'novel';
    SS.isActive = () => true;
    SS.setMode = (m: string) => { mode = m; };
    const chatOverlay = {
      modified: { e1: { content: '说话直接。【对话模式改过】' } },
      disabled: ['e4'],
      added: [{ id: 'c1', type: '角色', name: '对话模式新增', content: '只存在于对话模式 overlay' }],
    };
    const novelOverlay = {
      modified: {}, disabled: [],
      added: [{ id: 'n1', type: '角色', name: '小说模式新增', content: '只存在于小说模式 overlay' }],
    };
    SS.getEffectiveEntries = () => (mode === 'chat'
      ? [{ id: 'e1', type: '角色', name: '林薇', content: '说话直接。【对话模式改过】' }, chatOverlay.added[0]]
      : [{ id: 'e1', type: '角色', name: '林薇', content: '说话直接。【小说模式改过】' }, novelOverlay.added[0]]);
    SS.getOverlay = () => (mode === 'chat' ? chatOverlay : novelOverlay);
    try {
      const sys = ChatMode.buildSystem();
      expect(mode).toBe('chat');                                  // 组装前已切到对话模式
      const user = ChatMode.buildUser('接着演');
      // 稳定块（system）只放原书原文：比奇改过的那条，前缀里仍是原文（改了前缀字节，缓存就断了）
      expect(sys.indexOf('说话直接')).toBeGreaterThan(-1);
      expect(sys.indexOf('【对话模式改过】')).toBe(-1);
      expect(sys.indexOf('【小说模式改过】')).toBe(-1);
      // 对话模式的改动/新增进 user 区尾部的「临时修订」块，小说模式那份不参与
      expect(user.indexOf('临时修订')).toBeGreaterThan(-1);
      expect(user.indexOf('说话直接。【对话模式改过】')).toBeGreaterThan(-1);
      expect(user.indexOf('只存在于对话模式 overlay')).toBeGreaterThan(-1);
      expect(user.indexOf('小说模式新增')).toBe(-1);
      expect(user.indexOf('小说模式 overlay')).toBe(-1);
      expect(ChatMode.roster()).toContain('对话模式新增');           // 新增角色也进名单（有气泡有头像）
    } finally {
      SS.isActive = orig.isActive; SS.setMode = orig.setMode;
      SS.getEffectiveEntries = orig.getEffectiveEntries; SS.getOverlay = orig.getOverlay;
    }
  });

  // 二轮整改（2026-09-25）：演出记录改成 append-only 水位线。旧实现取"最后 6000 字"，
  // 块首每轮往后滑一点 → 整个 user 消息（含演出记录）永远 miss（实测真机就是这种情况）。
  describe('演出记录：append-only 水位线（缓存）', () => {
    // 目标长度在生产里由「模型可用上下文」算出（chatmode._ctxChars）；这里钉死一个小值，
    // 水位线推进才可断言（否则默认 20 万字上限，攒十几轮根本推不动）。
    const TARGET = 6000;
    const origCtxChars = (ChatMode as any)._ctxChars;
    beforeEach(() => { (ChatMode as any)._ctxChars = () => TARGET; });
    afterEach(() => { (ChatMode as any)._ctxChars = origCtxChars; });
    it('只追加：上一轮的演出记录是本轮的纯前缀', () => {
      seedBooks();
      setupPreset(null);
      ChatMode.append('ai', '第一轮演出。'.repeat(40));
      const ctx1 = ChatMode.recentContext();
      ChatMode.append('ai', '第二轮演出。'.repeat(40));
      const ctx2 = ChatMode.recentContext();
      expect(ctx2.startsWith(ctx1)).toBe(true);
      expect(ctx2.length).toBeGreaterThan(ctx1.length);
    });

    it('攒到 1.5 倍上限才推进水位线：推进后长度回到目标值附近，之后又是纯追加', () => {
      const { a } = seedBooks();
      setupPreset(null);
      for (let i = 0; i < 12; i++) ChatMode.append('ai', '第' + i + '轮：' + '她把伞收起来。'.repeat(120));
      const ctx1 = ChatMode.recentContext();
      // 反复调用不推进（同一个水位线 → 字节不变，这一轮和第二轮完全一致）
      expect(ChatMode.recentContext()).toBe(ctx1);
      expect(a).toBe(WBM.getActiveId());
      const from1 = Number(g.StorageManager.get('chatCtxFrom_' + a, 0));
      // 再攒几轮 → 超过 1.5 倍 → 水位线前移一次
      for (let i = 12; i < 20; i++) ChatMode.append('ai', '第' + i + '轮：' + '她把伞收起来。'.repeat(120));
      const ctx2 = ChatMode.recentContext();
      const from2 = Number(g.StorageManager.get('chatCtxFrom_' + a, 0));
      expect(from2).toBeGreaterThan(from1);
      expect(ctx1.startsWith(ctx2)).toBe(false);      // 推进那一轮本来就重写（前缀断在这里）
      expect(ctx2.length).toBeLessThanOrEqual(TARGET);
      // 推进之后又恢复纯追加
      ChatMode.append('ai', '推进之后的新一轮。');
      expect(ChatMode.recentContext().startsWith(ctx2)).toBe(true);
    });

    it('水位线按书隔离：切书各自从自己的起点开始', () => {
      const { a, b } = seedBooks();
      setupPreset(null);
      for (let i = 0; i < 12; i++) ChatMode.append('ai', ('甲书第' + i + '轮。').repeat(200));
      ChatMode.recentContext();
      expect(Number(g.StorageManager.get('chatCtxFrom_' + a, 0))).toBeGreaterThan(0);
      WBM.setActiveId(b);
      expect(Number(g.StorageManager.get('chatCtxFrom_' + b, 0))).toBe(0);
      ChatMode.append('ai', '乙书第一轮');
      expect(ChatMode.recentContext()).toBe('乙书第一轮');
    });

    it('撤回（日志变短）不会让水位线越界：越界值夹回 0 后按正常规则重算', () => {
      const { a } = seedBooks();
      setupPreset(null);
      for (let i = 0; i < 12; i++) ChatMode.append('ai', '第' + i + '轮：' + '她把伞收起来。'.repeat(120));
      ChatMode.recentContext();
      expect(Number(g.StorageManager.get('chatCtxFrom_' + a, 0))).toBeGreaterThan(0);
      g.StorageManager.set('chatCtxFrom_' + a, 999);   // 比日志还长（模拟撤回后日志变短）→ 夹回 0 再按阈值重算
      const ctx = ChatMode.recentContext();
      expect(ctx.length).toBeGreaterThan(0);
      expect(ctx.length).toBeLessThanOrEqual(TARGET);             // 仍受目标长度约束
      const w = Number(g.StorageManager.get('chatCtxFrom_' + a, 0));
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(ChatMode.log().length);      // 水位线永远落在日志范围内
      expect(ChatMode.recentContext()).toBe(ctx);                // 稳定：同一水位线 → 字节不变
    });
  });

  // 演出记录目标长度：原来写死 6000 字（"上下文只有 20 万 token"时代的遗留），
  // 2026-09-26 起按「模型可用上下文」算（命中价便宜 50 倍 → 常驻历史几乎免费），
  // 但留 20 万字上限：大前缀每轮都要重读一遍，实测 35 万 token 的首字延迟 3.8s、1.1 万只要 1.5s。
  describe('演出记录目标长度：按模型可用上下文算', () => {
    let prevTokens: any;
    beforeEach(() => { prevTokens = g.App && g.App._modelContextTokens; });
    afterEach(() => { if (g.App) g.App._modelContextTokens = prevTokens; });

    it('随上下文放大：小上下文给中等长度，大上下文封顶 20 万字', () => {
      seedBooks(); setupPreset(null);
      g.App._modelContextTokens = () => 64000;
      const small = ChatMode._ctxChars();
      expect(small).toBeGreaterThanOrEqual(6000);   // 不低于优化前的口径
      expect(small).toBeLessThan(200000);
      g.App._modelContextTokens = () => 800000;     // 1M 模型的建议值
      expect(ChatMode._ctxChars()).toBe(200000);    // 上限（保护首字延迟）
    });

    it('拿不到预算（老桩/异常）时退回兜底值，不影响出演出', () => {
      seedBooks(); setupPreset(null);
      g.App._modelContextTokens = () => { throw new Error('boom'); };
      expect(ChatMode._ctxChars()).toBe(60000);
      delete g.App._modelContextTokens;
      expect(ChatMode._ctxChars()).toBe(60000);
    });
  });

  // 2026-09-24 用户要求：作者输入**不显示**在演出流里，也要从模型历史上拿掉——
  // 读者只看到 AI 演的版本（像小说模式那样），模型只在本轮的【作者】行拿到要求。
  it('user：带演出记录、【作者】与【本轮目标】——字数写在这里（实测只写 system 会掉到 65–80%）', () => {
    seedBooks();
    setupPreset(1500);
    ChatMode.append('ai', '林薇：「你怎么才来。」');
    ChatMode.append('author', '演到她说出理由');
    ChatMode.append('director', '推进到放学');
    const user = ChatMode.buildUser('接着演');
    expect(user.indexOf('演出记录')).toBeGreaterThan(-1);
    expect(user.indexOf('林薇：「你怎么才来。」')).toBeGreaterThan(-1);
    expect(user.indexOf('演到她说出理由')).toBe(-1);           // 作者输入不进历史上下文
    expect(user.indexOf('推进到放学')).toBe(-1);
    expect(user.indexOf('【作者】接着演')).toBeGreaterThan(-1);   // 本轮要求只在末尾这一行
    expect(/【本轮目标】约 1500 字/.test(user)).toBe(true);   // 预设写了字数 → 用户消息末尾重申一次
    expect(user.indexOf('【格式】')).toBeGreaterThan(user.indexOf('【作者】'));   // 格式重申贴在指令之后
  });

  it('作者输入只存不显（hidden）：记录还在（撤回要用），但演出流里看不到', () => {
    seedBooks();
    setupPreset(null);
    const sent = ChatMode.append('author', '你别拆。', { hidden: true });
    expect(sent.kind).toBe('author');
    expect(sent.hidden).toBe(true);
    expect(ChatMode.log().some(m => m.id === sent.id)).toBe(true);
  });

  it('user 里的顺序：演出记录 → 临时修订 → 【作者】→【本轮目标】（修订块排在指令前、记录后）', () => {
    seedBooks();
    setupPreset(1500);
    const SS = SettingSyncManager as any;
    const orig = { isActive: SS.isActive, setMode: SS.setMode, getOverlay: SS.getOverlay };
    SS.isActive = () => true; SS.setMode = () => {};
    SS.getOverlay = () => ({ modified: { e2: { content: '话少，会弹吉他。【改】' } }, disabled: ['e4'], added: [] });
    try {
      ChatMode.append('ai', '第一轮演出内容');
      const user = ChatMode.buildUser('接着演');
      const at = (s: string) => user.indexOf(s);
      expect(at('演出记录')).toBeGreaterThan(-1);
      expect(at('临时修订')).toBeGreaterThan(at('演出记录'));
      expect(at('话少，会弹吉他。【改】')).toBeGreaterThan(at('临时修订'));
      expect(at('本条已临时停用')).toBeGreaterThan(at('临时修订'));     // 停用只写说明，原文留在 system 里
      expect(at('【作者】接着演')).toBeGreaterThan(at('临时修订'));
      expect(at('【本轮目标】')).toBeGreaterThan(at('【作者】接着演'));
    } finally {
      SS.isActive = orig.isActive; SS.setMode = orig.setMode; SS.getOverlay = orig.getOverlay;
    }
  });

  it('字数只认预设：预设写了就取它，没写就返回 null（不兜底、不注入数字）', () => {
    seedBooks();
    setupPreset(2500);
    expect(ChatMode.lengthWords()).toBe(2500);
    setupPreset(null);
    expect(ChatMode.lengthWords()).toBe(null);
    expect(ChatMode.buildUser('接着演').indexOf('【本轮目标】')).toBe(-1);   // 预设没写 → 不注入字数行
    expect(ChatMode.buildSystem().indexOf('本次输出约')).toBe(-1);
  });

  it('没设主角时名单里补上「我」：否则格式块的名单约束会把主角的台词挡掉', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => null;                 // 本例：世界书里没设主角
    expect(ChatMode.roster()).toEqual(['林薇', '陈亦', '林薇（副）', '我']);
    // 没设主角名时，「我」「主角」「user」都是同一个人的写法，统一收敛到「我」：
    // 不收敛的话模型写「主角：」会多出一条叫「主角」的右侧气泡（同一个人两个身份）
    expect(ChatMode.aliases()).toEqual({ '我': '我', '主角': '我', 'user': '我' });
    expect(parseBubbles('主角：「谁的。」', ChatMode.parseOpts())[0].speaker).toBe('我');
    // 设了主角：名单带主角名，「我」通过别名映射到主角身上
    g.App.getProtagonist = () => ({ name: '林叶' });
    expect(ChatMode.roster()).toEqual(['林薇', '陈亦', '林薇（副）', '林叶']);
    expect(ChatMode.aliases()).toEqual({ '我': '林叶', '主角': '林叶', 'user': '林叶' });
    expect(parseBubbles('我：「谁的。」', ChatMode.parseOpts())[0].speaker).toBe('林叶');
  });

  // 用户 2026-09-25：卡片常用 user 当主角占位符，主角名完全自定义（不在世界书里、或干脆就叫 user）。
  // 模型把条目里的 user 照抄成说话人时，不能多出一个叫 user 的陌生人气泡。
  it('user 占位符也是主角：模型写 user：/User：都渲染成主角本人（靠右、不是名单外角色）', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '阿柒' });        // 自定义主角名，世界书里没有这个角色
    expect(parseBubbles('user：「我在食堂等你。」', ChatMode.parseOpts())[0]).toMatchObject({ speaker: '阿柒', known: true });
    ChatMode.append('ai', 'user：「我在食堂等你。」\nUser：我把伞收起来。\n林薇：「行。」', { words: 30 });
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('>user<')).toBe(-1);                 // 不再有叫 user 的说话人
    expect((html.match(/chat-name">/g) || []).length).toBe(2);   // user/User 合成一条 + 林薇
    expect((html.match(/chat-row-me/g) || []).length).toBe(1);   // 主角靠右，只出现一次
    expect((html.match(/chat-name">阿柒<\/div>/g) || []).length).toBe(1);
  });

  it('世界书里真有叫 User/user 的角色时，user 不当作主角（那是正经角色名）', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '阿柒' });
    const wb = WBM.getAll().find(w => w.id === ChatMode.bookId())!;
    wb.entries = wb.entries.concat([{ id: 'eU', type: '角色', name: 'User', content: '这是本书里的一个角色。' }]);
    WBM.saveAll(WBM.getAll());
    expect(ChatMode.aliases()['user']).toBeUndefined();
    expect(parseBubbles('User：我在。', ChatMode.parseOpts())[0]).toMatchObject({ speaker: 'User', known: true });
  });

  // 模型偶尔把占位符原样写进输出：花括号不是名字形状，解析器不认这行，字面量会显示给读者。
  it('输出里的 {{user}} 字面量在渲染前换成主角名（花括号不给读者看）', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '阿柒' });
    ChatMode.append('ai', '{{user}}：「我在食堂等你。」\n{{char}} 站在门口。', { words: 20 });
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('{{')).toBe(-1);
    expect(html.indexOf('chat-name">阿柒')).toBeGreaterThan(-1);
    expect(html.indexOf('其他角色')).toBeGreaterThan(-1);
  });

  // 用户报告：扮演温水和彦时对话里"多出一个角色"——模型用姓/名单独称呼主角（甚至并成
  // 「温水与和彦」），解析不认 → 当成名单外的新人物另起一个头像气泡。别名把简写收回主角名下。
  it('主角名的姓/名简写与并列写法都归到主角本人（不再多出一个角色）', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '温水和彦' });
    const opts = ChatMode.parseOpts();
    expect(ChatMode.aliases()['温水']).toBe('温水和彦');       // 姓
    expect(ChatMode.aliases()['和彦']).toBe('温水和彦');       // 名
    for (const label of ['温水', '和彦', '温水君', '温水与和彦', '温水和彦']) {
      const b = parseBubbles(label + '：我把门推开。', opts);
      expect(b[0].speaker, label).toBe('温水和彦');
      expect(b[0].known, label).toBe(true);
    }
    // 世界书里真有同名角色时以名单为准（别名只是兜底，不抢名单）
    const wb = WBM.getAll().find(w => w.id === ChatMode.bookId())!;
    wb.entries = wb.entries.concat([{ id: 'e9', type: '角色', name: '温水', content: '别的角色。' }]);
    WBM.saveAll(WBM.getAll());
    expect(parseBubbles('温水：我在。', ChatMode.parseOpts())[0].speaker).toBe('温水');
  });

  it('格式块：主角标注「作者本人·主角」，并写明主角=作者、不许分身', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '温水和彦' });
    const sys = ChatMode.buildSystem();
    expect(sys.indexOf('温水和彦（作者本人·主角）')).toBeGreaterThan(-1);
    expect(sys.indexOf('主角就是作者本人')).toBeGreaterThan(-1);
    expect(sys.indexOf('主角只有一个人，不许分身')).toBeGreaterThan(-1);
    // 没设主角：同样写死「主角=作者的第一人称」，且不给半个名字
    g.App.getProtagonist = () => null;
    const sys2 = ChatMode.buildSystem();
    expect(sys2.indexOf('主角就是作者本人')).toBeGreaterThan(-1);
    expect(sys2.indexOf('作者本人·主角）')).toBe(-1);
  });

  it('占位符里不再写具体人名（换书/换世界书后不会误导），也不再由 JS 改写', () => {
    const html = readFileSync(resolve(here, '../../web/index.html'), 'utf8');
    const hit = /id="chatInput"[^>]*placeholder="([^"]*)"/.exec(html);
    expect(hit).toBeTruthy();
    expect(hit![1].indexOf('「我」')).toBeGreaterThan(-1);
    expect(hit![1].indexOf('主角')).toBe(-1);
    // chatmode 不再**改写**占位符：以前它把主角名塞进提示语，切到别的书还留着上一本的名字
    // （注释里提到 placeholder 不算，看的是有没有 `placeholder =` 赋值）
    const src = readFileSync(resolve(here, '../src/domain/chatmode.ts'), 'utf8');
    expect(src.indexOf('.placeholder =')).toBe(-1);
  });

  it('生成请求：system 带格式块，user 带本轮目标；请求参数用大 max_tokens（推理模型思考会吃额度）', async () => {
    seedBooks();
    setupPreset(1000);
    await ChatMode.generate('放学后的教室，林薇把一封信放在我桌上');
    expect(apiCalls).toHaveLength(1);
    const call = apiCalls[0];
    expect(call.msgs[0].role).toBe('system');
    expect(call.msgs[0].content.indexOf('对话演出')).toBeGreaterThan(-1);
    expect(call.msgs[1].content.indexOf('【本轮目标】约 1000 字')).toBeGreaterThan(-1);
    expect(call.ov.maxTokens).toBe(65535);
    expect(call.ov.callLabel).toBe('chat');
    expect(typeof call.ov.onReasoning).toBe('function');
  });
});

describe('落库与诊断', () => {
  it('正常一轮：作者指令 + AI 演出各一条，字数已统计，状态复位', async () => {
    seedBooks();
    setupPreset(1000);
    const ta = els['chatInput'];
    ta.value = ' 演到她说出理由 ';
    ChatMode.send();
    await vi.waitFor(() => expect(ChatMode._sending).toBe(false));
    const log = ChatMode.log();
    expect(log.map(m => m.kind)).toEqual(['author', 'ai']);
    expect(log[0].raw).toBe('演到她说出理由');
    expect(log[1].words).toBeGreaterThan(10);
    expect(log[1].truncated).toBe(false);
    expect(ta.value).toBe('');            // 输入框已清空
  });

  it('作者输入没有模式开关：按内容自动分（戏里的一句 → 主角气泡；长句要求 → 淡色一行）', async () => {
    seedBooks();
    setupPreset(1000);
    els['chatInput'].value = '哈？你在说什么啊！';
    ChatMode.send();
    await vi.waitFor(() => expect(ChatMode._sending).toBe(false));
    expect(ChatMode.log()[0].kind).toBe('author');           // 统一记 author
    expect(ChatMode.authorLooksInCharacter('哈？你在说什么啊！')).toBe(true);   // 有标点/语气 → 戏里的一句
    expect(ChatMode.authorLooksInCharacter('（站起来。）')).toBe(true);
    expect(ChatMode.authorLooksInCharacter('我：随便你。')).toBe(true);
    expect(ChatMode.authorLooksInCharacter('林薇：你走开')).toBe(true);
    expect(ChatMode.authorLooksInCharacter('演到她说出理由，停在主角回答之前，别提前收尾')).toBe(false);
    expect(ChatMode.authorLooksInCharacter('【当前场景】放学后的教室')).toBe(false);
  });

  it('空正文不落库，只提示（绝不渲染空气泡）', () => {
    seedBooks();
    setupPreset(1000);
    (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any) => { onOk('', false, '只有思考'); };
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._finish('   ', false, 'stop');
    expect(ChatMode.log()).toHaveLength(0);
    expect(g.App.toast).toHaveBeenCalled();
  });

  // 用户问「思考中被截断，是不是 token 限制太少」：推理模型的思考与正文共用同一个输出额度，
  // 思考跑满就写不出正文。这里守住"把话说清楚"：文案要指出额度被思考吃掉多少。
  it('空正文 + finish_reason=length + 思考很长 → 提示额度被思考吃满（不是笼统的"没拿到内容"）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._reasoningChars = 7342;
    ChatMode._finish('', false, 'length');
    const msg = (g.App.toast as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(msg).toContain('额度被思考吃满');
    expect(msg).toContain('7342');
    expect(ChatMode.log()).toHaveLength(0);
  });

  it('被截断（finish_reason=length）与格式漂移都会标记出来，截断文案带思考字数', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode._reasoningChars = 1200;
    ChatMode._finish('林薇：「一」', false, 'length');
    let last = ChatMode.log().slice(-1)[0];
    expect(last.truncated).toBe(true);
    expect(last.reasoning).toBe(1200);                       // 落库带着思考字数
    expect(ChatMode._bubbleHtml(last)).toContain('思考已用掉约 1200 字额度');
    // 整段散文（没有任何说话人前缀）→ 漂移
    ChatMode._finish('她把信放在桌上。'.repeat(10), false, 'stop');
    last = ChatMode.log().slice(-1)[0];
    expect(last.drift).toBe(true);
    // 正常演出 → 不报漂移、不带思考字数
    ChatMode._reasoningChars = 0;
    ChatMode._finish('林薇：「你怎么才来。」\n林叶：我把笔帽扣上。', false, 'stop');
    last = ChatMode.log().slice(-1)[0];
    expect(last.drift).toBe(false);
    // 诊断不显示给用户（2026-09-25 用户要求去掉「这一轮的格式没走对…」那条提示）
    ChatMode.render();
    expect(els['chatStream'].innerHTML).not.toContain('格式没走对');
    expect(last.reasoning).toBe(undefined);
  });
});

describe('头像与角色简介（自动聚合）', () => {
  it('头像优先取世界书角色条目的 avatar，缺省用首字色块且颜色稳定', () => {
    seedBooks();
    // 渲染层拿到的是**短地址**（blob:），不是原 data URL：流式时每 200ms 重画整屏气泡，
    // 塞原图会把 JS 线程占满（卡死 + 之后一次性补字），见 lib/avatarurl.ts
    const av = ChatMode.avatar('林薇').src;
    expect(String(av).startsWith('blob:')).toBe(true);
    expect(String(av).startsWith('data:')).toBe(false);
    expect(String(av).length).toBeLessThan(80);
    // 同一份头像数据每次都是同一个地址（缓存命中，不重复解码）
    expect(ChatMode.avatar('林薇').src).toBe(av);
    const a1 = ChatMode.avatar('陈亦'), a2 = ChatMode.avatar('陈亦');
    expect(a1.src).toBe(null);
    expect(a1.initial).toBe('陈');
    expect(a1.color).toBe(a2.color);
    expect(ChatMode.avatar('白').initial).toBe('白');
  });

  it('简介聚合：精确名 + 去尊称 + 包含匹配，一个角色的多条设定都列出来', () => {
    seedBooks();
    expect(ChatMode.profile('林薇').map(e => e.name)).toEqual(['林薇', '林薇（副）']);
    expect(ChatMode.profile('林薇小姐')[0].name).toBe('林薇');
    expect(ChatMode.profile('不存在的人')).toEqual([]);
  });

  it('打开简介：把命中的条目渲染进弹窗（含换头像入口）', () => {
    seedBooks();
    ChatMode.openProfile('林薇');
    const html = els['chatProfileBody'].innerHTML;
    expect(html.indexOf('学生会副会长')).toBeGreaterThan(-1);
    expect(html.indexOf('换头像')).toBeGreaterThan(-1);
    expect(els['chatProfileModal'].style.display).toBe('flex');
    ChatMode.closeProfile();
    expect(els['chatProfileModal'].style.display).toBe('none');
  });

  // 用户反馈：换完头像要切到别的页面再回来才加载。真因：气泡/简介都是渲染时按角色名现查条目，
  // 头像写进条目后没人重画。现在 onAvatarPicked 会调 refreshAvatars()。
  it('换完头像立刻生效：气泡流重画 + 打开着的简介按名字重开', () => {
    seedBooks();
    ChatMode.openProfile('林薇');                     // 弹窗开着（里面是旧头像）
    expect(ChatMode._profileName).toBe('林薇');
    els['chatStream'].innerHTML = '旧的渲染结果';
    ChatMode.refreshAvatars();
    expect(els['chatStream'].innerHTML).not.toBe('旧的渲染结果');   // 气泡流已重画
    expect(els['chatProfileModal'].style.display).toBe('flex');     // 弹窗仍开着
    expect(els['chatProfileBody'].innerHTML.indexOf('学生会副会长')).toBeGreaterThan(-1);
    ChatMode.closeProfile();
    expect(ChatMode._profileName).toBe('');
  });

  it('简介弹窗没开着时 refreshAvatars 不去重开它', () => {
    seedBooks();
    els['chatProfileModal'].style.display = 'none';
    ChatMode.refreshAvatars();
    expect(els['chatProfileModal'].style.display).toBe('none');
  });
});

describe('渲染与流式', () => {
  it('作者输入默认不显示（hidden）：演出流里只有 AI 演出来的内容', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '林薇：「你怎么才来。」');
    ChatMode.append('author', '我：「谁的。」', { hidden: true });
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('你怎么才来')).toBeGreaterThan(-1);
    expect(html.indexOf('谁的')).toBe(-1);          // 作者原话不出现（由 AI 演出来）
    expect(html.indexOf('chat-row-me')).toBe(-1);   // 也不再单独渲染成主角气泡
  });

  it('空记录 → 空状态；有记录 → 气泡；作者戏里的一句靠右（撤回已不在气泡上）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.render();
    expect(els['chatStream'].innerHTML.indexOf('还没有演出记录')).toBeGreaterThan(-1);
    ChatMode.append('ai', '林薇：「你怎么才来。」\n林叶：我把笔帽扣上。', { words: 21 });
    ChatMode.append('author', '我：「谁的。」');
    ChatMode.append('author', '演到她说出理由');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('chat-bubble')).toBeGreaterThan(-1);
    expect(html.indexOf('chat-say')).toBeGreaterThan(-1);
    expect(html.indexOf('chat-act')).toBeGreaterThan(-1);
    // 撤回挪到输入行左侧的 ↩（与写作页一致）：气泡上不再挂按钮
    expect(html.indexOf('ChatMode.undo(')).toBe(-1);
    expect(html.indexOf('→正文')).toBe(-1);
    expect(html.indexOf('重演')).toBe(-1);
    expect(html.indexOf('删除')).toBe(-1);
    expect(html.indexOf('chat-row-me')).toBeGreaterThan(-1);           // 「我：…」→ 主角气泡靠右
    expect(html.indexOf('演到她说出理由')).toBeGreaterThan(-1);         // 长句要求仍在
    expect(html.indexOf('chat-note')).toBeGreaterThan(-1);             // …但渲染成淡色一行，不是气泡
    expect(html.indexOf('21 字')).toBeGreaterThan(-1);                  // 字数标签还在
  });

  // 用户 2026-09-25："说话的内容和非说话的内容要分段，不要直接连着"（此前两人连排，同一行里颜色
  // 从深变淡，看着像染色出错）；标点不能成为新行的第一个字（1.5.97.36 报过）。
  it('说话与非说话分段：类型切换处换行，标点跟着台词走不另起行', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '林薇：「今天的风有点大呢」，她把手插进口袋里。', { words: 20 });
    ChatMode.append('ai', '林薇：「今天的风有点大呢。」\n她把手插进口袋里。', { words: 20 });
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    // 「，」收进台词块，动作另起一行（不再和台词连排）
    expect(html.indexOf('今天的风有点大呢，</span><br><span class="chat-act">她把手插进口袋里。')).toBeGreaterThan(-1);
    // 不再出现"标点紧跟在 <br> 之后"的形态
    expect(/<br>\s*[，。、；：！？]/.test(html)).toBe(false);
    // 模型自己写的换行仍然换行（nl2br 照旧）
    expect(html.indexOf('今天的风有点大呢。</span><br><span class="chat-act">她把手插进口袋里。')).toBeGreaterThan(-1);
  });

  // 用户 2026-09-25："现在有部分非对话内容也用了深色……引号内部并不一定是对话内容"。
  it('引号里的非对话内容（被强调的词/招牌字）渲染成淡色，不拆行', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '白：她把「就一次」说得很重，重得像在给我划界限。', { words: 20 });
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('chat-say')).toBe(-1);                       // 整行没有台词色
    expect(html.indexOf('她把就一次说得很重')).toBeGreaterThan(-1);   // 也没被拆成多行
    expect(html.indexOf('<br>')).toBe(-1);
  });

  // 用户反馈：第一轮一点发送就挂一段「（这一轮没有内容）」，看着像这一轮白跑了。
  // 真相：那是**流式占位**——推理模型先思考几十秒，这段时间正文还没吐出来；不是空回复。
  it('流式占位显示思考状态，不是「这一轮没有内容」', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode._sending = true;
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._acc = '';
    ChatMode._status = '正在思考…（已想 128 字）';
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('（这一轮没有内容）')).toBe(-1);      // 不能吓人
    expect(html.indexOf('chat-waiting')).toBeGreaterThan(-1);
    expect(html.indexOf('正在思考…（已想 128 字）')).toBeGreaterThan(-1);
    // 正文到达后占位消失，正常出气泡
    ChatMode._acc = '林薇：「你怎么才来。」';
    ChatMode.render();
    const html2 = els['chatStream'].innerHTML;
    expect(html2.indexOf('chat-waiting')).toBe(-1);
    expect(html2.indexOf('你怎么才来')).toBeGreaterThan(-1);
    ChatMode._sending = false; ChatMode._acc = ''; ChatMode._streamBookId = '';
  });

  it('真的空回复（已落库、非流式）才显示「这一轮没有内容」', () => {
    seedBooks();
    setupPreset(1000);
    const m = ChatMode.append('ai', '   ');
    ChatMode.render();
    expect(els['chatStream'].innerHTML.indexOf('（这一轮没有内容）')).toBeGreaterThan(-1);
    expect(m.kind).toBe('ai');
  });

  it('旁白不带「白」头像与名字，直接一行淡色文字', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '白：教室后门开着，值日生把扫帚往墙边一放。\n林薇：「给你的。」');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('chat-narr')).toBeGreaterThan(-1);
    expect(html.indexOf('>白<')).toBe(-1);                 // 没有「白」这个名字标签
    expect(html.split('chat-av').length - 1).toBe(1);      // 只有一个头像（林薇的）
  });

  it('同一角色的连续输出合并成一个气泡（不再一句一条）；主角靠右、其他角色与旁白靠左', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => null;      // 没设主角 → 主角以「我」发言
    ChatMode.append('ai', '林薇：「一。」\n林薇：她抬手把窗帘拉上。\n林薇：「二。」\n我：我把笔放下。\n白：灯亮了。\n白：走廊空了。');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect((html.match(/class="chat-row/g) || []).length).toBe(2);   // 林薇 / 我（旁白走 .chat-narr，不算气泡行）
    expect((html.match(/class="chat-narr"/g) || []).length).toBe(1); // 两行旁白合并成一段
    expect(html.indexOf('一。')).toBeGreaterThan(-1);
    expect(html.indexOf('二。')).toBeGreaterThan(-1);
    const rowOf = (needle: string) => {
      const i = html.indexOf(needle);
      return html.slice(html.lastIndexOf('<div class="chat-row', i), html.indexOf('</div></div>', i));
    };
    expect(rowOf('我把笔放下')).toContain('chat-row-me');            // 主角（我）靠右
    expect(rowOf('她抬手把窗帘拉上')).not.toContain('chat-row-me');   // 其他角色靠左
    expect(html.indexOf('走廊空了')).toBeGreaterThan(-1);               // 旁白在页面里，但没有气泡行/头像
  });

  it('设了主角时按主角名靠右（只有主角那一条）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '林叶：我把信折好。\n林薇：「随便你。」');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.split('chat-row-me').length - 1).toBe(1);
    const i = html.indexOf('我把信折好');
    expect(html.slice(html.lastIndexOf('<div class="chat-row', i), i)).toContain('chat-row-me');
  });

  // 用户要求：流式输出不许自己滚动，完全按用户自己的滑动来。
  it('流式增量渲染不动滚动位置（页面不会跟着输出往下跑）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '林薇：「第一轮。」');
    const stream = els['chatStream'];
    stream.scrollHeight = 2000; stream.clientHeight = 400;
    stream.scrollTop = 120;                      // 用户滑到中间看旧内容
    ChatMode._scrollOnce = false;                 // 发送时的那一次贴底已经用掉了
    ChatMode._sending = true;
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._acc = '林薇：「新的一句话。」';      // 流式吐字
    ChatMode.render();
    expect(stream.scrollTop).toBe(120);           // 位置纹丝不动
    ChatMode._acc += '\n她抬手把窗帘拉上。';
    ChatMode.render();
    expect(stream.scrollTop).toBe(120);
    ChatMode._sending = false; ChatMode._acc = ''; ChatMode._streamBookId = '';
  });

  it('只有用户主动动作才贴一次底（发一条 / 撤回 / 换书）', () => {
    seedBooks();
    setupPreset(1000);
    const stream = els['chatStream'];
    ChatMode.append('ai', '林薇：「一。」');
    stream.scrollHeight = 2000; stream.clientHeight = 400;
    stream.scrollTop = 9999;
    ChatMode._scrollOnce = true;                  // 发一条时置位（generate 里）
    ChatMode.render();
    expect(ChatMode._scrollOnce).toBe(false);     // 一次用完就清
    expect(stream.scrollTop).toBe(2000);          // 贴到底
    stream.scrollTop = 300;
    ChatMode.render();                            // 后续渲染不再贴底
    expect(stream.scrollTop).toBe(300);
  });

  it('回到最下面：离底部远了才显示按钮，点一下滚到底（不恢复自动跟随）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '林薇：「一。」');
    const stream = els['chatStream'];
    stream.scrollHeight = 2000; stream.clientHeight = 400;
    stream.scrollTop = 100;                                  // 停在上面 → 按钮出现
    ChatMode.onScroll();
    expect(els['chatScrollBottom'].classList.contains('show')).toBe(true);
    stream.scrollTop = 1598;                                 // 滚到底（gap 2）→ 按钮收起
    ChatMode.onScroll();
    expect(els['chatScrollBottom'].classList.contains('show')).toBe(false);
    ChatMode._scrollOnce = false;
    ChatMode.scrollToBottomAnimated();                        // 点按钮：缓动滚到底
    expect(ChatMode._scrollOnce).toBe(false);                 // 不恢复"自动跟随"
  });

  it('载入更早：按插入前后的高度差补 scrollTop（正在看的那条不被顶走）', () => {
    seedBooks();
    setupPreset(1000);
    const stream = els['chatStream'];
    stream.scrollHeight = 1000; stream.clientHeight = 400;
    stream.scrollTop = 50;
    // render 之后 scrollHeight 变高（模拟上面插入了更早的消息）
    const origRender = ChatMode.render;
    ChatMode.render = function () { stream.scrollHeight = 1600; };
    ChatMode.loadMore();
    ChatMode.render = origRender;
    expect(stream.scrollTop).toBe(650);                       // 50 + (1600-1000)
  });

  it('流式：末尾半截说话人前缀先扣住，不画进上一个气泡', () => {
    seedBooks();
    setupPreset(1000);
    expect(ChatMode._streamTail('林薇：「你好。」\n林')).toBe('林薇：「你好。」\n');
    expect(ChatMode._streamTail('林薇：「你好。」\n林薇：「你也好。」')).toBe('林薇：「你好。」\n林薇：「你也好。」');
    expect(ChatMode._streamTail('林薇：「你好。」\n她在门口停下')).toBe('林薇：「你好。」\n她在门口停下');
  });

  it('转正文：剥掉说话人前缀、保留「」台词，可整段或多条拼接', () => {
    seedBooks();
    setupPreset(1000);
    const m1 = ChatMode.append('ai', '林薇：「你怎么才来。」\n她把伞收起来。');
    const m2 = ChatMode.append('ai', '林叶：我把笔帽扣上。');
    expect(ChatMode.toProseText(m1.id)).toBe('「你怎么才来。」\n她把伞收起来。');
    expect(ChatMode.toProseText()).toBe('「你怎么才来。」\n她把伞收起来。\n\n我把笔帽扣上。');
  });
});

describe('重演 / 删除 / 换书', () => {
  it('撤回：本轮演出整条去掉，作者当轮写的要求放回输入框（上一轮的字不被覆盖丢）', async () => {
    seedBooks();
    setupPreset(1000);
    await ChatMode.generate('第一轮要求');
    const log1 = ChatMode.log();
    expect(log1).toHaveLength(2);
    const ta = els['chatInput'];
    ta.value = '这是没发出去的新内容';
    ChatMode.undo(log1[1].id);
    // 输入框有内容时会先确认；测试里 confirm 返回 true（见 stub）→ 覆盖为被撤回那轮的要求
    expect(ChatMode.log()).toHaveLength(0);
    expect(ta.value).toBe('第一轮要求');
  });

  it('撤回空指令的一轮：只去掉演出，不动输入框', async () => {
    seedBooks();
    setupPreset(1000);
    await ChatMode.generate('');
    expect(ChatMode.log()).toHaveLength(1);
    const ta = els['chatInput'];
    ta.value = '';
    ChatMode.undo(ChatMode.log()[0].id);
    expect(ChatMode.log()).toHaveLength(0);
    expect(ta.value).toBe('');
  });

  it('输入行左侧的 ↩（undoLast）：撤回最近一轮，当轮要求回到输入框；没演出时只提示', async () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.undoLast();
    expect(g.App.toast).toHaveBeenCalled();                 // 没有可撤回的轮次 → 提示，不动记录
    await ChatMode.generate('第一轮要求');
    await ChatMode.generate('第二轮要求');
    expect(ChatMode.log().map(m => m.kind)).toEqual(['author', 'ai', 'author', 'ai']);
    els['chatInput'].value = '';
    ChatMode.undoLast();
    expect(ChatMode.log().map(m => m.raw)).toEqual(['第一轮要求', '林薇：「你怎么才来。」\n林叶：我把笔帽扣上。\n白：天暗了下来。']);
    expect(els['chatInput'].value).toBe('第二轮要求');
  });

  it('生成中：发送换成红色停止键（与写作页同一对按钮、同一个位置）', async () => {
    seedBooks();
    setupPreset(1000);
    // 异步返回，抢在回调前看按钮状态
    (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any) => {
      setTimeout(() => { onDelta('林薇：「一。」'); onOk('林薇：「一。」', false, ''); }, 0);
    };
    const p = ChatMode.generate('演一段');
    expect(els['chatSendBtn'].style.display).toBe('none');
    expect(els['chatStopBtn'].style.display).toBe('flex');
    await p;
    expect(els['chatSendBtn'].style.display).toBe('flex');
    expect(els['chatStopBtn'].style.display).toBe('none');
  });

  it('换书改当前书并重载（用真实的 BookManager）', () => {
    const { a, b } = seedBooks();
    ChatMode.append('ai', '甲书的内容');
    expect(WBM.getActiveId()).toBe(a);
    ChatMode.switchBook(b);
    expect(WBM.getActiveId()).toBe(b);
    expect(ChatMode.log()).toHaveLength(0);       // 乙书还没有记录
  });

  it('演出进归档（记忆参与）：剥掉说话人前缀、增量只写一次、新消息再补', () => {
    seedBooks();
    setupPreset(1000);
    const calls: Array<{ chunks: string[]; max: number }> = [];
    g.ArchiveStore = { addBlocks: (chunks: string[], max: number) => calls.push({ chunks, max }) };
    ChatMode.append('ai', '林薇：「一。」\n白：灯亮了。');
    ChatMode.syncArchive();
    expect(calls).toHaveLength(1);
    expect(calls[0].chunks.join('\n')).toContain('灯亮了。');
    expect(calls[0].chunks.join('\n')).not.toContain('林薇：');   // 前缀已剥掉，归档里是连续文本
    expect(calls[0].max).toBe(900);
    ChatMode.syncArchive();                                      // 幂等：没有新消息不再写
    expect(calls).toHaveLength(1);
    ChatMode.append('ai', '林叶：我把信折好。');
    ChatMode.syncArchive();
    expect(calls).toHaveLength(2);
    expect(calls[1].chunks.join('\n')).toContain('我把信折好。');
    delete g.ArchiveStore;
  });
});

// 用户要求：两种模式共用顶部的「书名 ▾」选书，对话模式不再自带标题与选书栏。
// 这里是结构守卫（源文件级）：删掉/加回都要在这个测试里说清楚。
describe('共用顶部选书（对话模式不再自带标题与选书栏）', () => {
  const html = readFileSync(resolve(here, '../../web/index.html'), 'utf8');
  const chatSrc = readFileSync(resolve(here, '../src/domain/chatmode.ts'), 'utf8');
  const uiSrc = readFileSync(resolve(here, '../src/domain/ui.ts'), 'utf8');

  it('对话页只剩比奇/清空两个动作，没有书名与选书下拉', () => {
    const head = html.slice(html.indexOf('id="tab-chat"'), html.indexOf('id="chatBody"'));
    expect(head.indexOf('chatBookSelect')).toBe(-1);
    expect(head.indexOf('chatBookTitle')).toBe(-1);
    expect(head.indexOf('chatBiqiBtn')).toBeGreaterThan(-1);
    expect(head.indexOf('clearAll()')).toBeGreaterThan(-1);
    expect(html.indexOf('id="wbSwitchList"')).toBeGreaterThan(-1);   // 顶部共用的选书入口还在
  });

  it('对话页有"回到最下面"按钮（与写作页同款），chatmode 也不再渲染选书', () => {
    expect(html.indexOf('id="chatScrollBottom"')).toBeGreaterThan(-1);
    expect(html.indexOf('ChatMode.scrollToBottomAnimated()')).toBeGreaterThan(-1);
    expect(chatSrc.indexOf('chatBookSelect')).toBe(-1);
    expect(chatSrc.indexOf('renderBooks')).toBe(-1);                 // 已下线（顶部选书接手）
  });

  it('切世界书时同步对话模式（共用入口的唯一同步点）', () => {
    const i = uiSrc.indexOf('switchWorldBook(bookId: any)');
    expect(i).toBeGreaterThan(-1);
    expect(uiSrc.slice(i, i + 1200).indexOf('ChatMode.reload()')).toBeGreaterThan(-1);
  });
});

// 用户报「续写的用量统计不计算（可能只有对话模式）」：对话模式以前根本没有
// UsageStats.beginSession/endSession，演出轮跑完不留任何记录（token/费用全丢）。
describe('演出轮记进用量统计', () => {
  it('一轮演出产生一条用量记录（label=chat，含 tokens/命中率/字数）', async () => {
    seedBooks();
    setupPreset(1000);
    const raw = APIHandler as unknown as { _apiCalls: unknown[]; fetchCompletions: unknown };
    raw._apiCalls = [];                                  // 真实记账在 APIHandler 内部，这里手工模拟
    raw.fetchCompletions = (msgs: any[], onDelta: any, onOk: any) => {
      raw._apiCalls.push({ label: 'chat', promptTokens: 1200, cachedTokens: 900, completionTokens: 300, cost: 0.002 });
      onDelta('林薇：「一。」');
      onOk('林薇：「一。」', false, '');
    };
    const before = UsageStats.getHistory().length;
    await ChatMode.generate('演一段');
    const history = UsageStats.getHistory();
    expect(history.length).toBe(before + 1);
    expect(history[0].apiCalls).toBe(1);
    expect(history[0].promptTokens).toBe(1200);
    expect(history[0].cachedTokens).toBe(900);
    expect(history[0].hitRate).toBe('75.0');
    expect(history[0].byLabel['chat'].count).toBe(1);
    expect(history[0].wordCount).toBeGreaterThan(0);
  });

  it('请求失败也收尾（不留开着没人结束的会话，免得挡住下一轮的记账）', async () => {
    seedBooks();
    setupPreset(1000);
    const raw = APIHandler as unknown as { _apiCalls: unknown[]; fetchCompletions: unknown };
    raw._apiCalls = [];
    raw.fetchCompletions = (msgs: any[], _onDelta: any, _onOk: any, onErr: any) => { onErr('网络错误'); };
    const before = UsageStats.getHistory().length;
    await ChatMode.generate('演一段');
    const st = UsageStats as unknown as { _sessionStartIndex: number | null };
    expect(st._sessionStartIndex).toBeNull();            // 会话已结束（没调用 → 不产生记录，但状态干净）
    expect(UsageStats.getHistory().length).toBe(before); // 失败轮不产生记录
  });

  // 作者输入不再显示在演出流里 → 失败时若不回填，用户会以为自己写的没了（也没有可撤回的一轮）
  it('请求失败：把作者刚才那句放回输入框（输入框已有内容时不覆盖）', async () => {
    seedBooks();
    setupPreset(1000);
    const raw = APIHandler as unknown as { fetchCompletions: unknown };
    raw.fetchCompletions = (msgs: any[], _onDelta: any, _onOk: any, onErr: any) => { onErr('网络错误'); };
    els['chatInput'].value = '';
    await ChatMode.generate('演到她说出理由');
    expect(els['chatInput'].value).toBe('演到她说出理由');
    els['chatInput'].value = '我自己正在打的字';
    await ChatMode.generate('另一句要求');
    expect(els['chatInput'].value).toBe('我自己正在打的字');   // 不覆盖用户正在写的内容
  });
});

// 用户 2026-09-25：「如果当前也希望让一些不存在世界书的角色说话，比如可能会引入一些路人，
// 或者"同学a"这样的」——渲染层一直支持（名单外的名字照样开气泡、首字色块头像），这里守的是
// 新加的三条链路：① 读写临时世界书时模式安全；② 龙套能登记成临时「角色」条目（进名单、能挂头像）
// 且 inject=false 不占提示词；③ 同名条目即使类型不是「角色」也能挂上头像。
// 用户 2026-09-25：把书的封面自动当对话背景（气泡有底色不挡字）；没封面就不设；顶部给个开关。
describe('封面背景（2026-09-25）', () => {
  it('默认开启；有封面才真正设背景，没封面就清掉', () => {
    seedBooks(); setupPreset(null);
    expect(ChatMode.bgEnabled()).toBe(true);                     // 默认开
    expect(ChatMode.coverUrl()).toBe('');                        // 甲书的角色有头像，但书本身没封面
    ChatMode.render();
    expect(els['chatBg'].classList.contains('on')).toBe(false);
    expect(els['chatBg'].style.backgroundImage).toBeFalsy();
    expect(els['chatBgBtn'].style.display).toBe('none');          // 没封面不显示开关
    // 给书设一张封面（书列表那边也叫 cover）
    const SS2 = WBM as unknown as { setCover: (id: string, url: string) => void };
    SS2.setCover(WBM.getActiveId()!, 'data:image/png;base64,AAAA');
    ChatMode.render();
    expect(String(els['chatBg'].style.backgroundImage)).toContain('data:image/png;base64,AAAA');
    expect(els['chatBg'].classList.contains('on')).toBe(true);
    expect(els['chatBgBtn'].style.display).toBe('');              // 有封面才显示
    expect(els['chatBgBtn'].textContent).toBe('背景：开');
    expect(els['chatStreamWrap'].classList.contains('chat-has-bg')).toBe(true);
  });

  it('开关：关掉后清掉背景并记住（切书/重画都不再设），再开回来恢复', () => {
    seedBooks(); setupPreset(null);
    (WBM as unknown as { setCover: (id: string, url: string) => void }).setCover(WBM.getActiveId()!, 'data:image/png;base64,BBBB');
    ChatMode.render();
    expect(els['chatBg'].classList.contains('on')).toBe(true);
    ChatMode.toggleBg();                                          // 关
    expect(ChatMode.bgEnabled()).toBe(false);
    expect(els['chatBg'].classList.contains('on')).toBe(false);
    expect(String(els['chatBg'].style.backgroundImage)).toBe('');
    expect(els['chatBgBtn'].textContent).toBe('背景：关');
    expect(els['chatStreamWrap'].classList.contains('chat-has-bg')).toBe(false);
    ChatMode.render();                                            // 重画不会自己开回来
    expect(els['chatBg'].classList.contains('on')).toBe(false);
    ChatMode.toggleBg();                                          // 再开
    expect(ChatMode.bgEnabled()).toBe(true);
    expect(els['chatBg'].classList.contains('on')).toBe(true);
  });

  // 截图实测发现：同一角色的连续气泡合并后，模型"各自一行"的输出被挤到同一行
  //（`林薇：她把手插回兜里。` + `林薇：「人家让我转交…」`）——合并时要在接缝处补一个分段。
  it('同一角色连续气泡合并时保留换行（旁白与台词不挤在一行）', () => {
    seedBooks(); setupPreset(null);
    ChatMode.append('ai', '林薇：她把手插回兜里。\n林薇：「人家让我转交，我就转了。」', { words: 20 });
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect((html.match(/class="chat-row/g) || []).length).toBe(1);                 // 还是一个气泡
    expect(html.indexOf('她把手插回兜里。</span><br><span class="chat-say">')).toBeGreaterThan(-1);
  });

  it('只认图片 data URL（脏数据不当背景用）', () => {
    seedBooks(); setupPreset(null);
    (WBM as unknown as { setCover: (id: string, url: string) => void }).setCover(WBM.getActiveId()!, 'https://example.com/a.png');
    expect(ChatMode.coverUrl()).toBe('');
  });
});

describe('龙套角色（路人/同学A）：登记、名单与头像（2026-09-25）', () => {
  function stubSS(opts: { overlay?: any; effective?: (mode: string) => any[] }) {
    const SS = SettingSyncManager as any;
    const orig: Record<string, any> = {};
    ['isActive', 'mode', 'setMode', 'getEffectiveEntries', 'getOverlay', 'withMode', 'addTempEntry', 'setTempAvatar']
      .forEach(k => { orig[k] = SS[k]; });
    let mode = 'novel';                        // 小说生成之后模式就停在这里（app.generate 开头设置）
    const calls: any[] = [];
    const blank = { modified: {}, disabled: [], added: [] };
    SS.isActive = () => true;
    SS.mode = () => mode;
    SS.setMode = (m: string) => { mode = m; };
    SS.withMode = (m: string, fn: any) => { const prev = mode; mode = m; try { return fn(); } finally { mode = prev; } };
    SS.getOverlay = () => ((mode === 'chat' && opts.overlay) ? opts.overlay : blank);
    SS.getEffectiveEntries = () => (opts.effective
      ? opts.effective(mode)
      : (mode === 'chat' && opts.overlay ? opts.overlay.added : []));
    SS.addTempEntry = (e: any) => { calls.push({ e, mode }); return 'tmp_id'; };
    return { calls, modeOf: () => mode, restore: () => { Object.keys(orig).forEach(k => { SS[k] = orig[k]; }); } };
  }

  it('parseOpts 带上 narrator（主角名）：主角气泡里的第一人称长动作句才能按叙述着色', () => {
    seedBooks(); setupPreset(null);
    expect(ChatMode.parseOpts().narrator).toBe('林叶');
    expect(ChatMode.parseOpts().roster).toContain('林薇');
  });

  it('模式停在 novel 时，读名单/简介也走对话那份临时世界书（读完还原，不给小说留副作用）', () => {
    seedBooks(); setupPreset(null);
    const s = stubSS({ effective: (m) => (m === 'chat' ? [{ id: 'c1', type: '角色', name: '对话模式的龙套', content: 'x', inject: true }] : []) });
    try {
      expect(ChatMode.roster()).toContain('对话模式的龙套');
      expect(s.modeOf()).toBe('novel');
    } finally { s.restore(); }
  });

  it('临时登记的龙套进名单、能挂头像；inject=false 的那条不进提示词', () => {
    seedBooks(); setupPreset(1500);
    const overlay = {
      modified: {}, disabled: [], added: [
        { id: 'x1', type: '角色', name: '同学A', content: '（临时登记，只为头像）', inject: false },
        { id: 'x2', type: '角色', name: '书店老板', content: '书店老板，话少。', inject: true },
      ],
    };
    const s = stubSS({ overlay });
    try {
      expect(ChatMode.roster()).toContain('同学A');
      expect(ChatMode.roster()).toContain('书店老板');
      const user = ChatMode.buildUser('接着演');
      expect(user.indexOf('（临时登记，只为头像）')).toBe(-1);          // 只为头像登记的不占提示词
      expect(user.indexOf('书店老板，话少。')).toBeGreaterThan(-1);      // 有内容的照常进「临时修订」块
    } finally { s.restore(); }
  });

  it('ensureTempCharacter：同名「角色」条目直接复用；没有才登记（角色类型、inject=false、chat 模式）', () => {
    seedBooks(); setupPreset(null);
    PluginManager.setEnabled('biqi', true);          // 临时世界书由比奇门控
    const s = stubSS({});
    try {
      expect(ChatMode.ensureTempCharacter('林薇')).toBe('e1');     // 原书已有 → 复用它的 id
      expect(s.calls).toHaveLength(0);
      expect(ChatMode.ensureTempCharacter('同学A')).toBe('tmp_id');
      expect(s.calls[0].mode).toBe('chat');
      expect(s.calls[0].e.type).toBe('角色');
      expect(s.calls[0].e.inject).toBe(false);
      expect(ChatMode.ensureTempCharacter('白')).toBe(null);       // 旁白不是角色，不给登记
    } finally { s.restore(); }
  });

  it('比奇关着时：不静默写一个看不到的条目，而是明确提示去开比奇', () => {
    seedBooks(); setupPreset(null);
    PluginManager.setEnabled('biqi', false);
    const s = stubSS({});
    const ui = g.UIManager as any;
    const origPick = ui.pickAvatar;
    const toast = vi.fn();
    const origToast = g.App.toast;
    ui.pickAvatar = vi.fn();
    g.App.toast = toast;
    try {
      ChatMode.pickAvatarFor('同学A');
      expect(ui.pickAvatar).not.toHaveBeenCalled();            // 不写看不到的东西
      expect(s.calls).toHaveLength(0);
      expect(String(toast.mock.calls.map((c: any[]) => c[0]).join(' '))).toContain('开启比奇');
      expect(ChatMode.ensureTempCharacter('同学A')).toBe(null);
    } finally { ui.pickAvatar = origPick; g.App.toast = origToast; s.restore(); }
  });

  it('pickAvatarFor：先登记成临时角色，再开世界书头像选择器（写到那个 id 上）', () => {
    seedBooks(); setupPreset(null);
    PluginManager.setEnabled('biqi', true);
    const s = stubSS({});
    const ui = g.UIManager as any;
    const origPick = ui.pickAvatar;
    const picked: any[] = [];
    ui.pickAvatar = (type: string, id: string) => { picked.push({ type, id }); };
    try {
      ChatMode.pickAvatarFor('同学A');
      expect(picked).toEqual([{ type: 'wb', id: 'tmp_id' }]);
    } finally { ui.pickAvatar = origPick; s.restore(); }
  });

  it('简介弹窗：世界书里没有的龙套给「给 TA 设头像」入口；临时条目带「临时新增」标记', () => {
    seedBooks(); setupPreset(null);
    const overlay = { modified: {}, disabled: [], added: [{ id: 'x1', type: '角色', name: '同学A', content: '同班。', inject: false }] };
    const s = stubSS({ overlay });
    try {
      // ① 完全没条目的名字：给出登记入口（点了才会建临时角色，不是自动建）
      ChatMode.openProfile('路过的邻居');
      let html = els['chatProfileBody'].innerHTML;
      expect(html).toContain('给 TA 设头像');
      expect(html).toContain('临时世界书');
      // ② 临时新增的条目：标出来"这是临时的"，换头像按钮照旧在
      ChatMode.openProfile('同学A');
      html = els['chatProfileBody'].innerHTML;
      expect(html).toContain('临时新增');
      expect(html).toContain("UIManager.pickAvatar('wb','x1')");
    } finally { s.restore(); }
  });

  it('同名条目是「其他」类型时，头像也能挂上（不再只有简介有内容、头像空着）', () => {
    seedBooks(); setupPreset(null);
    const s = stubSS({ effective: () => [{ id: 't1', type: '其他', name: '同学A', content: '同班。', avatar: 'data:image/jpeg;base64,AAAA', inject: true }] });
    try {
      expect(String(ChatMode.avatar('同学A').src).startsWith('blob:')).toBe(true);
      expect(ChatMode.profile('同学A').map(e => e.name)).toEqual(['同学A']);
    } finally { s.restore(); }
  });
});
