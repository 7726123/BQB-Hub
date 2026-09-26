// 世界书「变量」（一个条目 = 一个变量）：解析/剥离/流式过滤（lib/status-block）、
// 注入与收集（domain/statusvars）、以及小说/对话两条生成链的整链收口。
// 产品模型：条目 名称=变量名、内容=给模型的讲解、注入开关=启用/停用；
// 模型每轮在正文之后按软件给定的格式回报「变量名：值」，软件剥掉块、把值收进「变量」面板。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import { parseStatusBlock, stripStatusBlocks, createStatusStreamFilter } from '../src/lib/status-block';
import { StatusVars } from '../src/domain/statusvars';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { SettingSyncManager } from '../src/domain/settingsync';
import { VariableManager } from '../src/lib/variables';
import { ChatMode } from '../src/domain/chatmode';
import { APIHandler } from '../src/domain/api';

// 真实 App 模块（import 时把 App 挂到 globalThis）；小说模式整链用例用它
await import('../src/domain/app');

const G = globalThis as any;

// ---------- 迷你 DOM（宽容 Proxy：未列出的属性返回空函数，避免 null 解引用） ----------
function makeEl(id = 'el'): any {
  const store: any = {
    id, tagName: 'DIV', innerHTML: '', outerHTML: '', textContent: '', value: '', checked: false,
    disabled: false, style: {}, dataset: {}, children: [], childNodes: [],
    selectionStart: 0, selectionEnd: 0, scrollHeight: 10, clientHeight: 10, scrollTop: 0,
    offsetHeight: 10, offsetWidth: 10, files: [], className: '',
    classList: { add: () => {}, remove: () => {}, toggle: () => false, contains: () => false },
  };
  const noop = () => undefined;
  return new Proxy(store, {
    get(t, p) {
      if (typeof p === 'symbol') return (t as any)[p];
      if (p in t) return t[p];
      return noop;
    },
    set(t, p, v) { (t as any)[p] = v; return true; },
  });
}
const els: Record<string, any> = {};
const el = (id: string) => (els[id] ||= makeEl(id));

beforeEach(() => {
  G.document = {
    getElementById: (id: string) => el(id),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl('new'),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    visibilityState: 'visible',
  };
  ['worldBooks', 'activeWorldBookId', 'statusVars', 'presets', 'currentPresetId', 'wbVariables'].forEach(k => {
    try { G.StorageManager.remove(k); } catch (e) { /* ignore */ }
  });
  // 比奇（临时世界书）默认关：变量条目取原书那份
  G.PluginManager = { isEnabled: () => false };
});

// =====================================================================================
describe('变量回报块：解析与剥离（纯函数）', () => {
  const NAMES = ['任务数量', '金钱', '目标进度'];

  it('标签块：一行一个变量，多行值写在键行下面', () => {
    const src = '苏黎把门推开。\n\n<status>\n任务数量：7\n金钱：120\n目标进度：\n- 找到钥匙\n- 问出名字\n</status>\n';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits.map(h => h.name + '=' + h.value)).toEqual(['任务数量=7', '金钱=120', '目标进度=- 找到钥匙\n- 问出名字']);
    expect(r.text).not.toContain('<status>');
    expect(r.text).not.toContain('任务数量');
    expect(r.text).toContain('苏黎把门推开。');
  });

  it('容错：标签变体 / 半角冒号 / 加粗 / 项目符号 / 同名取最后一次', () => {
    const src = '正文。\n<StatusBar>\n**任务数量**：3\n- 金钱: 5\n【任务数量】：9\n</StatusBar>';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits).toHaveLength(2);                       // 任务数量重复 → 只保留最后一次
    expect(r.hits.find(h => h.name === '任务数量')!.value).toBe('9');
    expect(r.hits.find(h => h.name === '金钱')!.value).toBe('5');
    expect(r.text).toBe('正文。\n');
  });

  it('块里出现没登记的键（模型自己加的字段）→ 进 extra，不并进上一个变量的多行值', () => {
    const src = '正文。<status>\n任务数量：6\n心情：不错\n</status>';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits.map(h => h.name + '=' + h.value)).toEqual(['任务数量=6']);
    expect(r.extra.map(h => h.name + '=' + h.value)).toEqual(['心情=不错']);
    expect(r.text).toBe('正文。');
  });

  it('块里的散文行（带句末标点）不被当野变量收进来', () => {
    const src = '正文。<status>\n任务数量：6\n她看了我一眼：没说话。\n</status>';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.extra).toEqual([]);
    expect(r.hits.map(h => h.name + '=' + h.value)).toEqual(['任务数量=6\n她看了我一眼：没说话。']);
  });

  it('中文标签 <状态栏> 与漏闭标记（剥到文末）', () => {
    const src = '正文。\n<状态栏>\n任务数量：1\n金钱：2';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits).toHaveLength(2);
    expect(r.text).toBe('正文。\n');
  });

  it('兜底：模型漏写标签时，文末连续的「变量名：值」行簇也能收上并从正文里去掉', () => {
    const src = '苏黎接过钥匙。\n\n任务数量：7\n金钱：120\n';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits.map(h => h.name + '=' + h.value)).toEqual(['任务数量=7', '金钱=120']);
    expect(r.text.trim()).toBe('苏黎接过钥匙。');
  });

  it('兜底：紧挨行簇上方的「【状态栏】」表头一起剥掉', () => {
    const src = '正文。\n\n【状态栏】\n任务数量：7\n';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits).toHaveLength(1);
    expect(r.text.trim()).toBe('正文。');
  });

  it('安全边界：正文里提到变量名（不是「名字：值」行）→ 一个字符都不动', () => {
    const src = '她数了数任务数量：还剩不少。\n这句话里的 任务数量 不是回报行。';
    expect(parseStatusBlock(src, NAMES)).toBeNull();
    expect(stripStatusBlocks(src, NAMES)).toBe(src);
  });

  it('非启用中的名字不收集；空值不算命中（块照剥，值保留旧值）', () => {
    const src = '正文。<status>\n心情：好\n任务数量：\n</status>';
    const r = parseStatusBlock(src, NAMES)!;
    expect(r.hits).toEqual([]);
    expect(r.text).toBe('正文。');
  });

  it('没有变量名时报 null（完全直通）', () => {
    expect(parseStatusBlock('正文。<status>任务数量：1</status>', [])).toBeNull();
    expect(parseStatusBlock('', NAMES)).toBeNull();
  });
});

describe('变量块流式过滤器（跨分片、绝不丢字）', () => {
  it('开标记被劈开：半个标记不上屏，也不丢正文', () => {
    const f = createStatusStreamFilter();
    expect(f.feed('正文。<sta')).toBe('正文。');
    expect(f.feed('tus>\n任务数量：7\n</status>')).toBe('');
    expect(f.release()).toBe('');
  });

  it('闭标记被劈开：仍能认出（丢弃态里保留尾部窗口）', () => {
    const f = createStatusStreamFilter();
    expect(f.feed('正文<status>任务数量：7</sta')).toBe('正文');
    expect(f.feed('tus>\n后面还有正文')).toBe('\n后面还有正文');
  });

  it('漏闭标记：块内容不吐出来（收口点会再剥一次）', () => {
    const f = createStatusStreamFilter();
    expect(f.feed('正文<status>任务数量：7')).toBe('正文');
    expect(f.release()).toBe('');
  });

  it('孤立的 < 与 <笑 这类正文不会被吃掉', () => {
    const f = createStatusStreamFilter();
    expect(f.feed('a<')).toBe('a');
    expect(f.feed('笑')).toBe('<笑');
    expect(f.feed('，还有 <b>加粗</b>')).toBe('，还有 <b>加粗</b>');
    expect(f.release()).toBe('');
  });

  it('reset 后重新开始（新一轮生成互不影响）', () => {
    const f = createStatusStreamFilter();
    f.feed('<status>任务数量：7');
    f.reset();
    expect(f.feed('新的一轮正文')).toBe('新的一轮正文');
  });
});

// =====================================================================================
describe('StatusVars：条目读取 / 注入块 / 收集落盘', () => {
  function seed(vars: any[], opts: { other?: any[] } = {}) {
    WBM.saveAll([]);
    const b = WBM.createBook('变量书');
    const all = WBM.getAll();
    all.find(w => w.id === b.id)!.entries = (vars || []).concat(opts.other || []);
    WBM.saveAll(all);
    WBM.setActiveId(b.id);
    return b.id;
  }
  const V1 = { id: 'v1', type: '变量', name: '任务数量', content: '每月 10 次；用完为止；月底没做完判失败。' };
  const V2 = { id: 'v2', type: '变量', name: '金钱', content: '身上的现金（日元）。' };

  it('启用规则：只认 type=变量 + inject!==false + 名称与内容都非空', () => {
    seed([V1, V2, { id: 'v3', type: '变量', name: '停用的', content: 'x', inject: false },
      { id: 'v4', type: '变量', name: '空内容', content: '   ' },
      { id: 'v5', type: '变量', name: '  ', content: 'y' },
      { id: 'w1', type: '世界观', name: '任务数量', content: '同名的世界观条目不算变量' }]);
    expect(StatusVars.names('novel')).toEqual(['任务数量', '金钱']);
    expect(StatusVars.count('novel')).toBe(2);
    expect(StatusVars.enabled('novel')).toBe(true);
  });

  it('注入块：软件给定格式契约（按启用中的名字生成）+ 讲解 + 当前值', () => {
    seed([V1, V2]);
    const blk = StatusVars.block('novel');
    expect(blk).toContain('【变量（每轮必须回报）】');
    expect(blk).toContain('<status>\n任务数量：xx\n金钱：xx\n</status>');
    expect(blk).toContain('每个都要写');
    expect(blk).toContain('### 任务数量\n每月 10 次；用完为止；月底没做完判失败。');
    expect(blk).toContain('当前值：（还没有回报过');    // 首轮：让模型给出初始值
  });

  it('没有启用中的变量条目 → 注入块为空串（对不使用该功能的书零变化）', () => {
    seed([{ id: 'w1', type: '世界观', name: '学校', content: '天台锁着。' }]);
    expect(StatusVars.block('novel')).toBe('');
    expect(StatusVars.enabled('novel')).toBe(false);
    const src = '正文。<status>\n任务数量：7\n</status>';
    expect(StatusVars.capture('novel', src)).toBe(src);   // 不剥（模型可能自己写了这个名字）
  });

  it('capture：块剥掉、值按名字落盘；第二轮注入块带上当前值', () => {
    seed([V1, V2]);
    const out = StatusVars.capture('novel', '正文一段。\n\n<status>\n任务数量：7\n金钱：120\n</status>\n');
    expect(out.trim()).toBe('正文一段。');
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');
    const blk2 = StatusVars.block('novel');
    expect(blk2).toContain('当前值：7');
    expect(blk2).toContain('当前值：120');
  });

  it('本轮漏写某个变量 → 那一条保留旧值；写了没登记的键 → 进「未登记」', () => {
    seed([V1, V2]);
    StatusVars.capture('novel', '<status>\n任务数量：7\n金钱：120\n</status>');
    StatusVars.capture('novel', '<status>\n任务数量：6\n心情：不错\n</status>');
    expect(StatusVars.values('novel')['任务数量'].v).toBe('6');
    expect(StatusVars.values('novel')['金钱'].v).toBe('120');   // 本轮没写 → 保留
    expect(StatusVars.unregistered('novel').map(u => u.name)).toEqual(['心情']);
  });

  it('按「书 × 模式」隔离：小说/对话各一份，换书互不影响', () => {
    const bookA = seed([V1]);
    StatusVars.capture('novel', '<status>\n任务数量：7\n</status>');
    StatusVars.capture('chat', '<status>\n任务数量：3\n</status>');
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');
    expect(StatusVars.values('chat')['任务数量'].v).toBe('3');
    // 换一本书：值是空的
    const b2 = WBM.createBook('另一本');
    WBM.saveAll(WBM.getAll());
    WBM.setActiveId(b2.id);
    expect(StatusVars.values('novel')).toEqual({});
    WBM.setActiveId(bookA);
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');
  });

  it('快照/回滚：撤回式整书回滚（生成前没有值 → 回滚后整键删掉）', () => {
    const wbId = seed([V1]);
    const before = StatusVars.snapshotBook();
    StatusVars.capture('novel', '<status>\n任务数量：7\n</status>');
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');
    StatusVars.restoreBook(wbId, before!);
    expect(StatusVars.values('novel')).toEqual({});
    // 模式级快照（对话撤回用）
    const m0 = StatusVars.snapshotMode('chat');
    expect(m0).toBeNull();
    StatusVars.capture('chat', '<status>\n任务数量：3\n</status>');
    const m1 = StatusVars.snapshotMode('chat')!;
    expect(m1.values['任务数量'].v).toBe('3');
    StatusVars.restoreMode('chat', m0);
    expect(StatusVars.values('chat')).toEqual({});
    StatusVars.restoreMode('chat', m1);
    expect(StatusVars.values('chat')['任务数量'].v).toBe('3');
  });

  it('clear(模式) 与 reset(整书)', () => {
    seed([V1]);
    StatusVars.capture('novel', '<status>\n任务数量：7\n</status>');
    StatusVars.capture('chat', '<status>\n任务数量：3\n</status>');
    StatusVars.clear('chat');
    expect(StatusVars.values('chat')).toEqual({});
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');
    StatusVars.reset();
    expect(StatusVars.values('novel')).toEqual({});
  });

  it('{{getvar::变量名}} 能取到面板里的当前值（老 wbVariables 表优先）', () => {
    seed([V1]);
    StatusVars.capture('novel', '<status>\n任务数量：7\n</status>');
    G.SettingSyncManager = { mode: () => 'novel' };
    expect(VariableManager.get('任务数量')).toBe('7');
    VariableManager.set('任务数量', '99');            // 老表里同名 → 老表优先（语义不变）
    expect(VariableManager.get('任务数量')).toBe('99');
  });

  it('migrateEntryTypes 保留「变量」类型（否则下次启动被改成「其他」）', () => {
    seed([V1], { other: [{ id: 'w1', type: '前端', name: '旧类型', content: 'x' }] });
    WBM.migrateEntryTypes();
    const es = WBM.getActive()!.entries;
    expect(es.find((e: any) => e.id === 'v1')!.type).toBe('变量');
    expect(es.find((e: any) => e.id === 'w1')!.type).toBe('其他');
  });

  it('比奇生效时读「生效条目」，且读完把模式切回原样（不许把比奇面板的模式改掉）', () => {
    seed([V1]);
    const SSM: any = SettingSyncManager;
    const orig = { isActive: SSM.isActive, getEffectiveEntries: SSM.getEffectiveEntries, mode: SSM.mode, setMode: SSM.setMode };
    const calls: string[] = [];
    SSM.isActive = () => true;
    SSM.getEffectiveEntries = () => [
      { id: 'ov1', type: '变量', name: '临时变量', content: '比奇临时加的' },
      { id: 'ov2', type: '变量', name: '被停用的', content: 'x', inject: false },
    ];
    SSM.mode = () => 'novel';
    SSM.setMode = (m: string) => { calls.push(m); };
    try {
      expect(StatusVars.names('chat')).toEqual(['临时变量']);
      expect(calls).toEqual(['chat', 'novel']);     // 切过去读 → 立刻切回
      calls.length = 0;
      expect(StatusVars.names('novel')).toEqual(['临时变量']);
      expect(calls).toEqual([]);                     // 模式本来就对 → 一次都不切
    } finally { Object.assign(SSM, orig); }
  });
});

// =====================================================================================
describe('对话模式整链：注入 → 回报 → 剥块 → 落盘 → 撤回回滚', () => {
  function seedVars() {
    WBM.saveAll([]);
    const b = WBM.createBook('演出书');
    const all = WBM.getAll();
    all.find(w => w.id === b.id)!.entries = [
      { id: 'v1', type: '变量', name: '任务数量', content: '每月 10 次；用完为止。' },
    ];
    WBM.saveAll(all);
    WBM.setActiveId(b.id);
    return b.id;
  }

  beforeEach(() => {
    G.htmlEscape = undefined;
    G.App = {
      toast: vi.fn(), getProtagonist: () => ({ name: '林叶' }), thinkingLevel: () => 'off',
      saveCurrentChapter: vi.fn(), _modelContextTokens: () => 32000,
    };
    G.EditorManager = { insertAtCursor: vi.fn(() => true) };
    G.UIManager = { viewAvatar: vi.fn(), pickAvatar: vi.fn(), refreshVarBadge: vi.fn() };
    (APIHandler as any).abort = vi.fn();
    ChatMode._sending = false; ChatMode._acc = ''; ChatMode._streamBookId = ''; ChatMode._loadedBookId = '';
    ChatMode._window = 120; ChatMode._status = ''; ChatMode._reasoningChars = 0; ChatMode._scrollOnce = true;
    (ChatMode as any)._lastInstruction = '';
  });

  it('buildUser 注入变量块，且位置在【格式】之前（保命契约留在最末尾）', () => {
    seedVars();
    const user = ChatMode.buildUser('');
    expect(user).toContain('【变量（每轮必须回报）】');
    expect(user).toContain('### 任务数量');
    expect(user.indexOf('【变量（每轮必须回报）】')).toBeLessThan(user.indexOf('【格式】'));
    expect(user.indexOf('### 任务数量')).toBeLessThan(user.indexOf('【格式】'));
  });

  it('没有变量条目 → 提示词里一个字都不多', () => {
    WBM.saveAll([]);
    const b = WBM.createBook('空书');
    WBM.saveAll(WBM.getAll());
    WBM.setActiveId(b.id);
    expect(ChatMode.buildUser('')).not.toContain('【变量');
  });

  it('演出回报：块不进演出记录、值收进面板；撤回这一轮 → 值回退到上一轮', async () => {
    seedVars();
    const calls: any[] = [];
    const outs = [
      '林薇：「你怎么才来。」\n白：天暗了下来。\n\n<status>\n任务数量：7\n</status>',
      '林薇：「别问了。」\n\n<status>\n任务数量：6\n</status>',
    ];
    let turn = 0;
    (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any) => {
      calls.push(msgs);
      const txt = outs[Math.min(turn++, outs.length - 1)];
      onDelta(txt); onOk(txt, false, '');
    };
    await ChatMode.generate('');
    const ai1 = ChatMode.log().filter(m => m.kind === 'ai');
    expect(ai1).toHaveLength(1);
    expect(ai1[0].raw).not.toContain('<status>');
    expect(ai1[0].raw).not.toContain('任务数量');
    expect(ai1[0].raw).toContain('林薇：「你怎么才来。」');
    expect(StatusVars.values('chat')['任务数量'].v).toBe('7');
    // 第二轮：注入块带上当前值；回报 6
    await ChatMode.generate('');
    expect(String(calls[1][1].content)).toContain('当前值：7');
    expect(StatusVars.values('chat')['任务数量'].v).toBe('6');
    // 撤回第 2 轮：演出记录回到 1 条，变量回到第 1 轮的值（不是清空）
    ChatMode.undoLast();
    expect(ChatMode.log().filter(m => m.kind === 'ai')).toHaveLength(1);
    expect(StatusVars.values('chat')['任务数量'].v).toBe('7');
  });

  it('流式显示副本：回报块不上屏（落盘才收）', () => {
    seedVars();
    ChatMode._acc = '林薇：「好的。」\n<status>\n任务数量：7\n</status>';
    const shown = ChatMode._displayRaw(ChatMode._acc);
    expect(shown).not.toContain('<status>');
    expect(shown).toContain('林薇：「好的。」');
  });
});

// =====================================================================================
describe('小说模式整链：注入 → 回报 → 剥块 → 值落盘（editor 上屏内容不含块）', () => {
  const G2 = globalThis as any;
  const App = G2.App;
  const inserted: string[] = [];

  function tolerant<T extends object>(impl: T): T {
    return new Proxy(impl, {
      get(t, p) {
        if (typeof p === 'symbol') return (t as any)[p];
        if (p in t) return (t as any)[p];
        return () => '';
      },
      set(t, p, v) { (t as any)[p] = v; return true; },
    }) as T;
  }

  beforeEach(() => {
    inserted.length = 0;
    G2.App = App;                                 // 前面的对话模式用例会把 globalThis.App 换成桩，这里换回真实对象
    el('streamingOutput').checked = false;
    G2.EditorManager = tolerant({
      getContent: () => '', getPlainText: () => '', startStreaming: () => {}, appendStreaming: () => {},
      finishStreaming: () => {}, cancelStreaming: () => {}, appendReasoning: () => {}, stripThinking: (s: string) => s,
      insertAtCursor: (html: string) => { inserted.push(String(html)); }, _thinkingRequired: false,
    });
    G2.PresetManager = tolerant({
      getActiveAPIConfig: () => ({ apiKey: 'k', model: 'test-model', endpoint: 'http://x/v1', temperature: 0.9 }),
      getCurrentPreset: () => null, getActiveSystemPrompt: () => '', tailText: () => '',
    });
    G2.Waterline = tolerant({ update: () => ({ frozen: '', x: 0, head: 0, blockCount: 0 }), clear: () => {} });
    G2.ArchiveStore = tolerant({ initStorage: () => Promise.resolve(), count: () => 0 });
    App.isGenerating = false;
    App.getNovelData = () => ({});
    App.getProtagonist = () => ({ name: '苏黎' });
    App.thinkingLevel = () => 'off';
    App.saveCurrentChapter = () => {};
    App._uploadAdminTrace = () => {};
    App._bumpContinuationCount = () => {};
    App.fillMemoryTable = () => Promise.resolve(0);
    App.reviewSettingDelta = () => {};
    App.getPricingConfig = () => ({ input: 0, cached: 0, output: 0 });
    App.toast = () => {};
    // 世界书：一条变量条目（名称=变量名，内容=讲解）
    WBM.saveAll([]);
    const b = WBM.createBook('变量小说');
    const all = WBM.getAll();
    all.find(w => w.id === b.id)!.entries = [
      { id: 'v1', type: '变量', name: '任务数量', content: '每月 10 次；用完为止。' },
    ];
    WBM.saveAll(all);
    WBM.setActiveId(b.id);
  });

  it('提示词带格式契约与讲解；正文里的回报块被剥掉；值落盘；第二轮带当前值', async () => {
    const calls: any[] = [];
    G2.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _onChunk: any, onDone: any) => {
        calls.push(msgs);
        const txt = '苏黎站在塔顶的梯口。\n\n<status>\n任务数量：7\n</status>\n';
        onDone(txt, false, '');
      }),
    };
    await App.generate('autoContinue');
    await new Promise(r => setTimeout(r, 0));

    const lastUser = String(calls[0][calls[0].length - 1].content);
    expect(lastUser).toContain('【变量（每轮必须回报）】');
    expect(lastUser).toContain('<status>\n任务数量：xx\n</status>');
    expect(lastUser).toContain('### 任务数量\n每月 10 次；用完为止。');
    expect(inserted.join('\n')).toContain('苏黎站在塔顶的梯口。');
    expect(inserted.join('\n')).not.toContain('<status>');
    expect(inserted.join('\n')).not.toContain('任务数量');
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');

    await App.generate('autoContinue');
    await new Promise(r => setTimeout(r, 0));
    expect(String(calls[1][calls[1].length - 1].content)).toContain('当前值：7');
  });

  it('撤回续写：变量一起回滚（生成前没有值 → 回滚后为空）', async () => {
    G2.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (_msgs: any, _onChunk: any, onDone: any) => {
        onDone('苏黎点头。\n\n<status>\n任务数量：7\n</status>', false, '');
      }),
    };
    await App.generate('autoContinue');
    await new Promise(r => setTimeout(r, 0));
    expect(StatusVars.values('novel')['任务数量'].v).toBe('7');
    // 撤回路径：generate 第一步存快照（含 statusVars），撤回时 _restoreVarSnapshot 整表回滚
    expect((App as any)._varSnapshot.status).toEqual({});      // 生成前这本书没有值
    (App as any)._restoreVarSnapshot();
    expect(StatusVars.values('novel')).toEqual({});
    // 反向：生成前已有值 → 回滚回那一份，而不是清空
    StatusVars.capture('novel', '<status>\n任务数量：5\n</status>');
    (App as any)._saveVarSnapshot();
    StatusVars.capture('novel', '<status>\n任务数量：1\n</status>');
    (App as any)._restoreVarSnapshot();
    expect(StatusVars.values('novel')['任务数量'].v).toBe('5');
  });
});
