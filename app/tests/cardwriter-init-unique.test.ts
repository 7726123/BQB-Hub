// 「初始」条目唯一性（写卡工具层）：
// - upsert_entry(type=初始)：已有初始条目时无论 name 是否相同一律更新，不新增第二条
// - set_entry_type → 初始：顶替掉原初始条目（同层改类型 / 角色迁回 两条路径）
// - _doWriteToWorldbook 直写：内容存在多条初始时只保留一条（兜底去重）
// 注：cardwriter.ts 模块顶层即执行 init()（裸读 WorldBookManager 等全局），
// 因此必须模块级先建全局桩 + beforeAll 动态 import（import 早于 it）。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;

// ---------- 模块顶层建桩（早于动态 import cardwriter；P3-B 后覆写真实 WBM 方法） ----------
let WB_BOOKS: { id: string; name: string; entries: any[]; chapters?: any[] }[] = [];
let WB_ACTIVE: string | null = 'wb1';
const wbm = WBM as unknown as Record<string, any>;
wbm.getActiveId = () => WB_ACTIVE;
wbm.getAll = () => WB_BOOKS;
wbm.getActive = () => WB_BOOKS[0] || null;
wbm.saveAll = (arr: any[]) => { WB_BOOKS = arr; };
wbm.setActiveId = (id: string | null) => { WB_ACTIVE = id; };
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.CharacterManager = { getByWorldBook: () => [] };
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
  // 原始实现快照：文件内更早的用例会把单例的 refreshContext 覆盖为 no-op，
  // refreshContext 自身的回归用例需先还原再调用。
  (anyG as { _realRefreshContext?: unknown })._realRefreshContext = (anyG.CardWriterChat as { refreshContext: unknown }).refreshContext;
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
  WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
  WB_ACTIVE = 'wb1';
});

const Cw = (): any => anyG.CardWriterChat;

function initIdx(draft: any): number {
  return (draft.entries || []).findIndex((x: any) => x.type === '初始');
}

function countInit(entries: any[]): number {
  return entries.filter((e) => e.type === '初始').length;
}

describe('upsert_entry：初始条目唯一', () => {
  it('已有初始条目（同名）→ 更新，不新增', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '初始', name: '故事起始', content: '开头A' }], deleted: [] };
    const r = c._executeTool({ name: 'upsert_entry', arguments: { type: '初始', name: '故事起始', content: '开头B' } });
    expect(String(r)).toBe('更新初始条目：故事起始');
    expect(c._draft.entries).toHaveLength(1);
    expect(c._draft.entries[0]).toEqual({ type: '初始', name: '故事起始', content: '开头B', status: 'confirmed', origin: 'user' });
  });

  it('已有初始条目但 AI 传了不同条目名 → 仍更新原条目，不新增第二条（本次 bug 场景）', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '初始', name: '世界初始', content: '旧内容' }], deleted: [] };
    const r = c._executeTool({ name: 'upsert_entry', arguments: { type: '初始', name: '初始状态', content: '新内容' } });
    expect(String(r)).toBe('更新初始条目：初始状态');
    expect(countInit(c._draft.entries)).toBe(1);
    expect(c._draft.entries[0]).toEqual({ type: '初始', name: '初始状态', content: '新内容', status: 'confirmed', origin: 'user' });
  });

  it('草稿无初始条目 → 新增第一条', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '世界观', name: '力量体系', content: 'X' }], deleted: [] };
    const r = c._executeTool({ name: 'upsert_entry', arguments: { type: '初始', name: '故事起点', content: '开局内容' } });
    expect(String(r)).toBe('新增初始条目：故事起点');
    expect(countInit(c._draft.entries)).toBe(1);
  });

  it('普通条目 upsert 仍按 同类型同名 匹配（不受影响）', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '其他', name: '道具', content: 'A' }], deleted: [] };
    c._executeTool({ name: 'upsert_entry', arguments: { type: '其他', name: '武器', content: 'B' } });
    expect(countInit(c._draft.entries)).toBe(0);
    expect(c._draft.entries).toHaveLength(2); // 不同名 → 正常新增
  });
});

describe('set_entry_type → 初始：顶替原初始', () => {
  it('同层改类型：把「其他」条目改成初始 → 原初始被顶替删除，只剩一条', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '初始', name: '旧初始', content: '旧' }, { type: '其他', name: '补充', content: 'C' }], deleted: [] };
    const r = c._executeTool({ name: 'set_entry_type', arguments: { name: '补充', type: '初始' } });
    expect(String(r)).toContain('改为「初始」');
    expect(countInit(c._draft.entries)).toBe(1);
    expect(c._draft.entries[0].name).toBe('补充');
  });

  it('角色卡迁回初始：原初始被顶替，只剩一条', () => {
    const c = Cw();
    c._draft = { characters: [{ name: '林晚', content: '人设' }], entries: [{ type: '初始', name: '旧初始', content: '旧' }], deleted: [] };
    const r = c._executeTool({ name: 'set_entry_type', arguments: { name: '林晚', type: '初始' } });
    expect(String(r)).toContain('迁回普通条目');
    expect(countInit(c._draft.entries)).toBe(1);
    expect(c._draft.characters).toHaveLength(0);
  });
});

describe('_doWriteToWorldbook：直写去重兜底', () => {
  it('内容存在两条初始 → 直写后世界书只有一条（保留最后一条）', () => {
    const c = Cw();
    c._draft = {
      characters: [],
      entries: [
        { type: '初始', name: '初始A', content: 'A内容' },
        { type: '初始', name: '初始B', content: 'B内容' },
        { type: '世界观', name: '力量体系', content: 'X' },
      ],
      deleted: [],
    };
    c._getTargetId = () => 'wb1';
    c._snapshotNow = () => {};
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    (anyG.UIManager as { renderWBEntries: () => void }).renderWBEntries = () => {};
    (anyG.UIManager as { renderWorldBooks: () => void }).renderWorldBooks = () => {};
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('已写入世界书');
    expect(countInit(WB_BOOKS[0].entries)).toBe(1);
    const init = WB_BOOKS[0].entries.find((e) => e.type === '初始');
    expect(init.name).toBe('初始B');
    expect(init.content).toBe('B内容');
  });

  it('存量世界书已有多条初始（历史数据）→ 下次直写自动收敛为一条', () => {
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [
      { id: 'a', type: '初始', name: '旧1', content: 'c1' },
      { id: 'b', type: '初始', name: '旧2', content: 'c2' },
    ] }];
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '初始', name: '新初始', content: '新内容' }], deleted: [] };
    c._getTargetId = () => 'wb1';
    c._snapshotNow = () => {};
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    c._doWriteToWorldbook();
    expect(countInit(WB_BOOKS[0].entries)).toBe(1);
    expect(WB_BOOKS[0].entries.find((e: any) => e.type === '初始').content).toBe('新内容');
  });
});

describe('写卡预设：只做设计不写正文 + 分块升级', () => {
  it('默认 base 明确禁止在写卡里写正文，并引导去「写作」页试写', () => {
    const b = Cw()._defaultBlocks();
    expect(b.base).toContain('只做设计，不写正文');
    expect(b.base).toContain('「写作」页');
    expect(b.base).toContain('初始');
    expect(b.method).toContain('引导用户去「写作」页试写');
    expect(b.base).toContain('最多给一两句示例对白'); // 卡面语料仍允许，避免把示例对话也禁掉
  });

  it('分块升级（旧版本 → 当前默认）：base/method 换新默认，用户改过的 selfcheck/亲密/其他 原样保留', () => {
    const store: Record<string, any> = {
      cwPresetBlocks: {
        base: '我的旧base', method: '我的旧method',
        selfcheck: '我的自检', nsfw: '我的亲密方法论', handgun: '',
        __version: 17
      },
      cwNsfw: true, cwHandgun: false
    };
    (globalThis as unknown as Record<string, unknown>).StorageManager = {
      get: (k: string, d: unknown) => (k in store ? store[k] : d),
      set: (k: string, v: unknown) => { store[k] = v; },
      remove: (k: string) => { delete store[k]; }
    };
    const b = (Cw() as any)._loadBlocks();
    expect(b.base).toContain('只做设计，不写正文');   // 系统维护段：升级后拿到新版
    expect(b.method).toContain('引导用户去「写作」页试写');
    expect(b.selfcheck).toBe('我的自检');             // 个人偏好段：用户改过的不动
    expect(b.nsfw).toBe('我的亲密方法论');
    expect(b.handgun).toBe('');
    // 断言"升级到了当前默认版本"，不写死数字：默认规则每次升版都递增，
    // 写死会让这条测试在每次改提示词时无谓地失败（真正的回归是"没升级"，即仍是 17）
    expect(b.__version).toBe(Cw()._defaultBlocks().__version);
    expect(b.__version).toBeGreaterThan(17);
  });
});

describe('直写：删除即时生效 / 无变化不重建', () => {
  it('副本清空（用户删光条目）→ 世界书条目一并清掉（不被「没有可写入内容」拦下）', () => {
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [{ id: 'a', type: '世界观', name: '世界背景', content: 'X' }] }];
    const c = Cw();
    c._draft = { characters: [], entries: [], deleted: [] };
    c._getTargetId = () => 'wb1';
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('已写入世界书');
    expect(WB_BOOKS[0].entries).toHaveLength(0);
  });

  it('副本与世界书都空 → 明确返回「没有可写入内容」，不动世界书', () => {
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
    const c = Cw();
    c._draft = { characters: [], entries: [], deleted: [] };
    c._getTargetId = () => 'wb1';
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('没有可写入的已确认内容');
    expect(WB_BOOKS[0].entries).toHaveLength(0);
  });

  it('内容与世界书一致 → 判为「已是最新」，不重建条目（id 不变）', () => {
    const existing = { id: 'keep_me', type: '世界观', name: '世界背景', content: 'X' };
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [existing] }];
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '世界观', name: '世界背景', content: 'X', status: 'confirmed' }], deleted: [] };
    c._getTargetId = () => 'wb1';
    const r = c._doWriteToWorldbook(true);
    expect(String(r)).toContain('已是最新');
    expect(WB_BOOKS[0].entries[0].id).toBe('keep_me');
  });
});

describe('写入前验收（status/origin 数据层）', () => {
  it('proposed（讨论中）不写入：角色与条目都留在待办，只写 confirmed', () => {
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
    const c = Cw();
    c._draft = {
      characters: [
        { name: '林晚', content: '正式人设…', status: 'confirmed', origin: 'user' },
        { name: '构想角色', content: '讨论中的想法', status: 'proposed', origin: 'ai' },
      ],
      entries: [
        { type: '世界观', name: '世界背景', content: 'X', status: 'confirmed', origin: 'user' },
        { type: '其他', name: '备用想法', content: 'Y', status: 'proposed', origin: 'ai' },
      ],
      deleted: [],
    };
    c._getTargetId = () => 'wb1';
    c._snapshotNow = () => {};
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('已写入世界书');
    expect(String(r)).toContain('2 条讨论中想法未写入');
    const wbNames = WB_BOOKS[0].entries.map((e: any) => e.name);
    expect(wbNames).toContain('林晚');
    expect(wbNames).toContain('世界背景');
    expect(wbNames).not.toContain('构想角色');
    expect(wbNames).not.toContain('备用想法');
    // 讨论中想法仍留在草稿
    expect(c._draft.characters).toHaveLength(2);
    expect(c._draft.entries).toHaveLength(2);
  });

  it('confirmed 范围重名 → 阻断写入，不写任何内容', () => {
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
    const c = Cw();
    c._draft = {
      characters: [
        { name: '林晚', content: '人设A', status: 'confirmed' },
        { name: '林晚', content: '人设B', status: 'confirmed' },
      ],
      entries: [],
      deleted: [],
    };
    c._getTargetId = () => 'wb1';
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('验收未通过');
    expect(String(r)).toContain('角色重名');
    expect(WB_BOOKS[0].entries).toHaveLength(0);
  });

  it('短角色卡（<30字）不阻断写入，但返回验收提示', () => {
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
    const c = Cw();
    c._draft = {
      characters: [
        { name: '小不点', content: '很矮', status: 'confirmed' },
        { name: '林晚', content: '这是一段足够长的人设内容，超过三十个字，包含性别年龄外貌性格背景关系完整主干', status: 'confirmed' },
      ],
      entries: [],
      deleted: [],
    };
    c._getTargetId = () => 'wb1';
    c._snapshotNow = () => {};
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('已写入世界书');
    expect(String(r)).toContain('验收提示');
    expect(WB_BOOKS[0].entries).toHaveLength(2);
  });

  it('propose_setting 只记录不写入：proposed 条目不进入世界书', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [], deleted: [] };
    const r = c._executeTool({ name: 'propose_setting', arguments: { type: '角色', name: '构想角色', content: '讨论中的想法' } });
    expect(String(r)).toContain('未写入');
    expect(c._draft.characters[0].status).toBe('proposed');
    // 手动编辑讨论中条目 = 用户认可 → 提升为 confirmed
    c.editDraftName(0, '构想角色');
    expect(c._draft.characters[0].status).toBe('confirmed');
    expect(c._draft.characters[0].origin).toBe('user');
  });

  it('自主构建轮：写入工具未显式传 origin → 默认标 ai（程序兜底）', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [], deleted: [] };
    c._autoBuildTurn = true; // 用户说「帮我构建好…」时 sendMessage 会置位
    let r = c._executeTool({ name: 'apply_character', arguments: { name: '林晚', content: '人设' } });
    expect(String(r)).toContain('新增角色');
    expect(c._draft.characters[0].origin).toBe('ai');
    expect(c._draft.characters[0].status).toBe('confirmed');
    r = c._executeTool({ name: 'upsert_entry', arguments: { type: '世界观', name: '世界背景', content: 'X' } });
    expect(c._draft.entries[0].origin).toBe('ai');
    // 显式传 origin=user 则尊重用户指定
    c._executeTool({ name: 'apply_character', arguments: { name: '沈夜', content: '人设', origin: 'user' } });
    expect(c._draft.characters[1].origin).toBe('user');
  });

  it('propose crossref 想法 → 用户认可转 confirmed 时保留 crossref（不误标 user）', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [], deleted: [] };
    c._executeTool({ name: 'propose_setting', arguments: { type: '角色', name: '构想角色', content: '参考其他书的想法', origin: 'crossref' } });
    expect(c._draft.characters[0].origin).toBe('crossref');
    // 用户认可 → apply_character 转 confirmed（未传 origin，应保留 crossref）
    c._executeTool({ name: 'apply_character', arguments: { name: '构想角色', content: '正式人设' } });
    expect(c._draft.characters[0].status).toBe('confirmed');
    expect(c._draft.characters[0].origin).toBe('crossref');
    // 自主构建轮下迁移也保留来源（不误标 ai/user）
    c._autoBuildTurn = true;
    c._draft.entries.push({ type: '世界观', name: '地理', content: '参考设定', origin: 'crossref', status: 'confirmed' });
    c._executeTool({ name: 'set_entry_type', arguments: { name: '地理', type: '角色' } });
    const migrated = c._draft.characters.find((x: any) => x.name === '地理');
    expect(migrated.origin).toBe('crossref');
    expect(migrated.status).toBe('confirmed');
  });

  it('_recentHistory 40 轮窗口：超长历史只带最近 40 轮，不足则全量', () => {
    const c = Cw();
    // 250 轮（500 条消息）：应只保留最后 40 轮（80 条）
    const msgs: any[] = [];
    for (let i = 0; i < 250; i++) msgs.push({ role: 'user', content: 'u' + i }, { role: 'assistant', content: 'a' + i });
    c.messages = msgs;
    const h = c._recentHistory();
    expect(h).toHaveLength(80);
    expect(h[0].role).toBe('user');
    expect(h[0].content).toBe('u210'); // 第 211 轮起（最后 40 轮 = 250-40 = 210）
    // 不足 40 轮 → 全量
    c.messages = msgs.slice(0, 4);
    expect(c._recentHistory()).toHaveLength(4);
  });
});
// ===== refreshContext：目标书引用失效不再抛错（v1.5.46 打开即弹窗 bug 的回归锁）=====
describe('refreshContext：null 守卫顺序 + 失效引用自愈', () => {
  function restore(): void { (Cw() as any).refreshContext = (anyG as { _realRefreshContext?: unknown })._realRefreshContext; }

  it('当前书 id 指向已删除的书 → 自愈重指现有书，不抛错、下拉正常选中', () => {
    const c = Cw();
    restore();
    c._targetBookId = null;
    WB_ACTIVE = 'wb-gone'; // 残留引用：指向已不存在的书
    expect(() => c.refreshContext()).not.toThrow();
    expect(WB_ACTIVE).toBe('wb1'); // 自愈：重新指向第一本现有书
    const sel = els.get('cwBookSelect');
    expect(String(sel.innerHTML)).toContain('__new__');
    expect(String(sel.innerHTML)).toContain('selected');
    expect(c._context.bookName).toBe('测试书');
  });

  it('一本世界书都没有 → 优雅降级：默认选中「全新世界书」，不抛错', () => {
    const c = Cw();
    restore();
    c._targetBookId = null;
    WB_ACTIVE = null;
    WB_BOOKS = [];
    expect(() => c.refreshContext()).not.toThrow();
    const sel = els.get('cwBookSelect');
    expect(String(sel.innerHTML)).toContain('__new__');
    expect(sel.value).toBe('__new__');
    expect(els.get('cwContextInfo').textContent).toBe('暂无当前书');
    expect(c._context).toBeNull();
  });

  it('正常路径：当前书存在 → 上下文与下拉选中正常', () => {
    const c = Cw();
    restore();
    c._targetBookId = null;
    WB_ACTIVE = 'wb1';
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [{ type: '世界观', name: '世界观', content: '设定' }] }];
    expect(() => c.refreshContext()).not.toThrow();
    expect(String(els.get('cwBookSelect').innerHTML)).toContain('selected');
    expect(els.get('cwContextInfo').textContent).toContain('世界观✓');
    expect(c._context.bookName).toBe('测试书');
  });
});
describe('_handleTools：参数 JSON 解析失败显式回传', () => {
  it('argsError → ok=false 且带根因信息，不执行工具、草稿不动', () => {
    const c = Cw();
    c._draft = { characters: [], entries: [{ type: '初始', name: '故事起始', content: '开头' }], deleted: [] };
    const before = JSON.stringify(c._draft);
    const r = c._handleTools([{ id: 'call_x', name: 'upsert_entry', arguments: {}, argsError: 'Unexpected token n in JSON at position 0' }], '');
    expect(r).toHaveLength(1);
    // 结果统一为结构化 JSON（此前 argsError 分支回的是裸字符串，与提示词承诺的
    // {"ok":true/false,"message":"..."} 不一致，模型收到的不是 JSON）
    const parsed = JSON.parse(String(r[0]));
    expect(parsed.ok).toBe(false);
    expect(String(parsed.message).startsWith('失败：工具参数不是合法 JSON')).toBe(true);
    expect(String(parsed.message)).toContain('Unexpected token'); // 模型能看到解析错误原文
    expect(c._lastToolResults[0].ok).toBe(false);
    expect(JSON.stringify(c._draft)).toBe(before); // 草稿未被改动
  });
});
