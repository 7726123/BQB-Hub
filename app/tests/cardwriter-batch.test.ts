// 写卡 agent 的批量能力与主角占位符规则（本次改动的主线）：
// - 批量参数：delete_entry/delete_character/update_worldview 的 names[]、upsert_entry/apply_character/set_entry_type 的 items[]
//   背景：提示词原本限「单条回复最多 5 个调用 × 8 轮循环 = 45 次」，清一张 200 条的卡必然撞墙；
//   批量参数让一次调用携带多个条目（删除类 ≤50 个名字、写入类 ≤10 条）。
// - 单条 name 形态必须保持既有语义（delete_entry 仍只删第一条同名）——向后兼容。
// - {{user}}/{user} 是主角占位符：写卡侧必须保留、残留判据不得误判（曾把正常条目判成残留诱导重写）。
// - read_current_book_json 的 names/分页读全文：改造大卡时不再只能看 300 字摘要。
// 注：cardwriter.ts 模块顶层即执行 init()（裸读 WorldBookManager 等全局），
// 因此必须模块级先建全局桩 + beforeAll 动态 import（import 早于 it）。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;

// ---------- 模块顶层建桩（早于动态 import cardwriter；覆写真实 WBM 方法） ----------
let WB_BOOKS: any[] = [];
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
  // 原始实现快照：本文件早先的用例会把单例的 _syncDraftFromWorldbook 覆盖成 no-op 桩，
  // 镜像同步自己的用例需要先还原（与 cardwriter-init-unique 的 _realRefreshContext 同款做法）
  (anyG as { _realSyncDraft?: unknown })._realSyncDraft = (anyG.CardWriterChat as { _syncDraftFromWorldbook: unknown })._syncDraftFromWorldbook;
  // 同上：长按用例里有把 _beginSelect 换桩计数的，后面用真实现的用例要先还原
  (anyG as { _realBeginSelect?: unknown })._realBeginSelect = (anyG.CardWriterChat as { _beginSelect: unknown })._beginSelect;
});

const els = new Map<string, any>();
beforeEach(() => {
  els.clear();
  anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), getElementsByClassName: () => [], body: el(),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
  };
  anyG.StorageManager = { get: (_k: string, d: unknown) => d, set: () => undefined, remove: () => undefined };
  anyG.App = { toast() {}, resetChatInput() {}, getBackendAPIConfig() { return null; }, thinkingLevel() { return 'auto'; } };
  WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
  WB_ACTIVE = 'wb1';
});

const Cw = (): any => anyG.CardWriterChat;

// 一批删除/写入用例：给单例打上"不真的落盘/重绘"的桩，只观察草稿与返回文本
function prime(): any {
  const c = Cw();
  c._getTargetId = () => 'wb1';
  c._saveDraft = () => {};
  c.renderDraft = () => {};
  c.refreshContext = () => {};
  c._snapshotNow = () => {};
  c._toolsHandled = false;
  c._toolsOk = false;
  return c;
}

function entry(name: string, type = '其他', content = '内容'): any {
  return { type, name, content };
}

function okOf(jsonText: string): any {
  return JSON.parse(String(jsonText));
}

describe('批量删除：delete_entry 的 names 数组', () => {
  it('一次删掉多个条目并回报数量；同名多处一并删净', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('甲'), entry('乙'), entry('丙'), entry('乙', '世界观')], deleted: [] };
    const r = c._executeToolResult({ name: 'delete_entry', arguments: { names: ['甲', '乙', '丙'] } });
    expect(r.ok).toBe(true);
    expect(r.message).toBe('批量删除：成功 3 项 / 共 3 项。');
    // 「乙」有两条（不同类型）——批量删除按名字删净，这是大卡清理的预期语义
    expect(c._draft.entries).toHaveLength(0);
    const tomb = c._draft.deleted.map((d: any) => d.type + ':' + d.name);
    expect(tomb).toHaveLength(4);
    expect(tomb).toContain('其他:甲');
    expect(tomb).toContain('其他:乙');
    expect(tomb).toContain('世界观:乙');
    expect(tomb).toContain('其他:丙');
  });

  it('单条 name 形态仍只删第一条同名（向后兼容，不改既有语义）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('乙'), entry('乙', '世界观')], deleted: [] };
    const r = c._executeTool({ name: 'delete_entry', arguments: { name: '乙' } });
    expect(String(r)).toBe('删除条目：乙');
    expect(c._draft.entries).toHaveLength(1); // 只删掉第一条
  });

  it('未找到的名字进 failed 明细，已成功的项保留（模型据此只补做失败项）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('甲')], deleted: [] };
    const r = c._executeToolResult({ name: 'delete_entry', arguments: { names: ['甲', '不存在的名字'] } });
    expect(r.ok).toBe(false); // 有任何一项失败 → ok=false
    expect(r.message).toContain('成功 1 项，失败 1 项 / 共 2 项');
    expect(r.message).toContain('不存在的名字');
    expect(r.message).toContain('已成功的项不要重做');
    expect((r.failed || []).map((f: any) => f.name)).toEqual(['不存在的名字']);
    expect(c._draft.entries).toHaveLength(0); // 成功的那一项确实删掉了
  });

  it('超过 50 个名字 → 直接拒绝，草稿不动（防输出被截断导致整批作废）', () => {
    const c = prime();
    const names = Array.from({ length: 51 }, (_v, i) => '条目' + i);
    c._draft = { characters: [], entries: names.slice(0, 1).map((n) => entry(n)), deleted: [] };
    const before = JSON.stringify(c._draft);
    const r = c._executeToolResult({ name: 'delete_entry', arguments: { names } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('一次最多 50 个');
    expect(JSON.stringify(c._draft)).toBe(before);
  });

  it('可选 type 过滤：只删该类型的同名条目', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('乙'), entry('乙', '世界观')], deleted: [] };
    const r = c._executeToolResult({ name: 'delete_entry', arguments: { names: ['乙'], type: '世界观' } });
    expect(r.ok).toBe(true);
    expect(c._draft.entries).toHaveLength(1);
    expect(c._draft.entries[0].type).toBe('其他');
  });
});

describe('批量删除：delete_character 与 update_worldview', () => {
  it('delete_character names 批量删角色', () => {
    const c = prime();
    c._draft = { characters: [{ name: '林晚', content: 'x' }, { name: '沈夜', content: 'y' }], entries: [], deleted: [] };
    const r = c._executeToolResult({ name: 'delete_character', arguments: { names: ['林晚', '沈夜'] } });
    expect(r.ok).toBe(true);
    expect(c._draft.characters).toHaveLength(0);
    expect(c._draft.deleted.map((d: any) => d.type)).toEqual(['角色', '角色']);
  });

  it('update_worldview 批量删除必须显式传 delete:true，否则拒绝（防止把 names 误当批量改写）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('世界背景', '世界观')], deleted: [] };
    const bad = c._executeToolResult({ name: 'update_worldview', arguments: { names: ['世界背景'] } });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain('delete:true');
    expect(c._draft.entries).toHaveLength(1);
    const good = c._executeToolResult({ name: 'update_worldview', arguments: { names: ['世界背景'], delete: true } });
    expect(good.ok).toBe(true);
    expect(c._draft.entries).toHaveLength(0);
  });

  it('update_worldview 批量删除只动世界观类型，不误删同名的其他条目', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('甲', '其他'), entry('甲', '世界观')], deleted: [] };
    const r = c._executeToolResult({ name: 'update_worldview', arguments: { names: ['甲'], delete: true } });
    expect(r.ok).toBe(true);
    expect(c._draft.entries).toHaveLength(1);
    expect(c._draft.entries[0].type).toBe('其他');
  });
});

describe('批量写入：items 数组', () => {
  it('upsert_entry items 一次写入多条，返回聚合结果', () => {
    const c = prime();
    c._draft = { characters: [], entries: [], deleted: [] };
    const r = c._executeToolResult({
      name: 'upsert_entry',
      arguments: { items: [{ type: '世界观', name: '世界背景', content: 'A' }, { type: '其他', name: '势力', content: 'B' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.message).toContain('批量写入：成功 2 项 / 共 2 项');
    expect(c._draft.entries.map((e: any) => e.name)).toEqual(['世界背景', '势力']);
  });

  it('apply_character items 一次写入多个角色', () => {
    const c = prime();
    c._draft = { characters: [], entries: [], deleted: [] };
    const r = c._executeToolResult({
      name: 'apply_character',
      arguments: { items: [{ name: '林晚', content: '姓名：林晚' }, { name: '沈夜', content: '姓名：沈夜' }] },
    });
    expect(r.ok).toBe(true);
    expect(c._draft.characters).toHaveLength(2);
  });

  it('超过 10 项 → 拒绝，草稿不动', () => {
    const c = prime();
    c._draft = { characters: [], entries: [], deleted: [] };
    const items = Array.from({ length: 11 }, (_v, i) => ({ type: '其他', name: '条' + i, content: 'x' }));
    const r = c._executeToolResult({ name: 'upsert_entry', arguments: { items } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('一次最多 10 个');
    expect(c._draft.entries).toHaveLength(0);
  });

  it('names 用在非删除类工具上 → 拒绝并指路 items', () => {
    const c = prime();
    c._draft = { characters: [], entries: [], deleted: [] };
    const r = c._executeToolResult({ name: 'upsert_entry', arguments: { names: ['甲'] } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('items');
  });
});

describe('批量结果回传模型：结构化 JSON 与 failed 明细', () => {
  it('_handleTools 回传 ok=false + failed 数组，且草稿里的成功项保留', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('甲'), entry('乙')], deleted: [] };
    const out = c._handleTools([{ id: 'call_1', name: 'delete_entry', arguments: { names: ['甲', '幽灵条目'] } }], '');
    expect(out).toHaveLength(1);
    const parsed = okOf(out[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('成功 1 项，失败 1 项');
    expect(parsed.failed).toHaveLength(1);
    expect(parsed.failed[0].name).toBe('幽灵条目');
    expect(c._draft.entries.map((e: any) => e.name)).toEqual(['乙']);
  });

  it('_toolsOk：有成功调用时置位、全失败时保持 false（收尾文案据此不说谎）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('甲')], deleted: [] };
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [entry('甲')] }];
    expect(c._toolsOk).toBe(false);
    c._handleTools([{ id: 'call_ok', name: 'delete_entry', arguments: { names: ['甲'] } }], '');
    expect(c._toolsOk).toBe(true); // 真的写入过 → 轮数用尽时该说「已写入的变更都保留着」

    const c2 = prime();
    c2._draft = { characters: [], entries: [entry('乙')], deleted: [] };
    c2._handleTools([{ id: 'call_bad', name: 'delete_entry', arguments: { names: ['幽灵条目'] } }], '');
    expect(c2._toolsOk).toBe(false); // 一条都没成功 → 不能说「已写入」
  });

  it('单条调用仍走既有的 {ok,message} 形状，且删除真的写进世界书', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('甲')], deleted: [] };
    // 夹具要与真实情况一致：草稿是世界书的镜像，草稿里有的世界书里也有
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [entry('甲')] }];
    const out = c._handleTools([{ id: 'call_2', name: 'delete_entry', arguments: { name: '甲' } }], '');
    const parsed = okOf(out[0]);
    expect(parsed.ok).toBe(true);
    expect(parsed.message).toBe('删除条目：甲');
    expect(parsed.failed).toBeUndefined();
    expect(WB_BOOKS[0].entries).toHaveLength(0); // 直写生效：世界书里的条目真的被删了
  });

  it('批量删除不逐条落盘：墓碑写入过程中 _saveDraft 不被反复调用', () => {
    const c = prime();
    let saves = 0;
    c._saveDraft = () => { saves++; };
    c._draft = { characters: [], entries: Array.from({ length: 30 }, (_v, i) => entry('条' + i)), deleted: [] };
    c._executeToolResult({ name: 'delete_entry', arguments: { names: Array.from({ length: 30 }, (_v, i) => '条' + i) } });
    // 旧实现每删一条 _markDeleted 都会 _saveDraft（30 次 localStorage 写）
    expect(saves).toBe(0);
    expect(c._draft.deleted).toHaveLength(30);
  });
});

describe('主角 / user：从零写卡不引入（用户 2026-09-25 明确要求）', () => {
  it('base 明确：从零写卡没有主角概念，不要问、不要单开条目、不要挂靠', () => {
    const b = Cw()._defaultBlocks();
    const base = String(b.base);
    expect(base).toContain('【主角 / user：从零写卡不需要，不要主动引入');
    expect(base).toContain('不要问「谁是主角');
    expect(base).toContain('用户自己会扮演卡里任意角色');
    expect(base).toContain('从零写卡时不要主动写');
    expect(base).toContain('明确要求');
    expect(b.__version).toBeGreaterThanOrEqual(22);
  });

  it('改造场景的保留规则仍在（{{user}} 不许删、不许写死人名）', () => {
    const base = String(Cw()._defaultBlocks().base);
    expect(base).toContain('【主角占位符');
    expect(base).toContain('必须原样保留');
    expect(base).toContain('禁止改写成具体人名');
  });

  it('角色卡渲染用中性「关系：」，不再写「与主角关系：」', () => {
    const txt = String((Cw() as unknown as { _charsToText: (a: unknown, b: unknown) => string })
      ._charsToText([{ name: '林晚', gender: '女', age: 17, relation: '同班同学' }], []));
    expect(txt).toContain('关系：同班同学');
    expect(txt).not.toContain('与主角关系');
  });
});

describe('对话示例（可选）：AI 先给候选让用户挑，角色不该死板', () => {
  it('method 默认文案含【对话示例】：候选形式、可选不追问、原话写回、克制', () => {
    const b = Cw()._defaultBlocks();
    const m = String(b.method);
    expect(m).toContain('【对话示例');
    expect(m).toContain('2~3 组候选台词');
    expect(m).toContain('跳过');                    // 明确可选
    expect(m).toContain('不要再追问');
    expect(m).toContain('说话方式·例句');           // 写回位置
    expect(m).toContain('原文一字不改');
    expect(m).toContain('一轮只问一个角色');
    expect(m).toContain('对话示例（可选，AI 先给候选让用户挑）');   // 写卡流程里也记了这一步
  });

  it('apply_character 的工具描述里也提到「说话方式·例句」（模型看得到）', () => {
    const tools = String(JSON.stringify((Cw() as unknown as { _tools?: () => unknown })._tools ? (Cw() as unknown as { _tools: () => unknown })._tools() : []));
    expect(tools).toContain('说话方式·例句');
  });

  it('规则靠版本升级推给老用户（v20 → v21 起）', () => {
    const b = Cw()._defaultBlocks();
    expect(b.__version).toBeGreaterThanOrEqual(21);
  });
});

describe('主角占位符：写卡侧规则与残留判据', () => {
  it('默认 base 含「{{user}}/{user} 必须原样保留」规则（改造时不许删、不许写死人名）', () => {
    const b = Cw()._defaultBlocks();
    expect(b.base).toContain('【主角占位符');
    expect(b.base).toContain('必须原样保留');
    expect(b.base).toContain('禁止改写成具体人名');
    expect(b.base).toContain('{{char}}'); // {{char}} 也不是残留：说明换成条目名
    expect(b.__version).toBeGreaterThanOrEqual(20); // 规则靠版本升级推给老用户的自定义 base
  });

  it('适配文档不再教模型删除 {{user}}，且与机械清洗的实际行为一致', () => {
    const doc = String(Cw()._readAdapterDoc());
    expect(doc).toContain('主角占位符例外');
    expect(doc).toContain('{{user}}');
    expect(doc).not.toContain('删后句子可能变碎');
    expect(doc).not.toContain('写入前用主角名替换');
  });

  it('残留判据：含 {{user}}/{user} 的条目不算残留，真宏/标签仍算', () => {
    const big = 'x'.repeat(40 * 1024); // 撑过 60KB 阈值 → 走压缩视图（hasTavernResidue 在此暴露）
    WB_BOOKS = [{
      id: 'wb1', name: '大书', characters: [],
      entries: [
        entry('甲', '其他', '{{user}} 与 月宫绾音 见面。' + big),
        entry('乙', '其他', '{{getvar::好感度}}' + big),
      ],
    }];
    const c = prime();
    const compact = JSON.parse(String(c._readCurrentBookJson()));
    const byName: Record<string, any> = {};
    compact.entries.forEach((e: any) => { byName[e.name] = e; });
    expect(byName['甲'].hasTavernResidue).toBe(false); // 主角占位符 ≠ 残留
    expect(byName['乙'].hasTavernResidue).toBe(true);  // 取值宏 = 残留
  });
});

describe('read_current_book_json：按名读全文 / 分页读全文', () => {
  beforeEach(() => {
    WB_BOOKS = [{
      id: 'wb1', name: '测试书', characters: [{ name: '林晚', content: '林晚的完整人设' }],
      entries: [entry('甲', '其他', '甲的完整内容'), entry('乙', '世界观', '乙的完整内容')],
    }];
  });

  it('names → 返回指定条目/角色的全文，并列出没找到的名字', () => {
    const c = prime();
    const r = String(c._readCurrentBookJson({ names: ['甲', '林晚', '不存在'] }));
    expect(r).toContain('甲的完整内容');
    expect(r).toContain('林晚的完整人设');
    expect(r).toContain('【没有找到】不存在');
  });

  it('offset/limit → 逐页读全文并给出下一批的 offset', () => {
    const c = prime();
    const r = String(c._readCurrentBookJson({ offset: 0, limit: 2 }));
    expect(r).toContain('第 0~1 项 / 共 3 项');
    expect(r).toContain('【下一批】');
    expect(r).toContain('offset=2');
    const last = String(c._readCurrentBookJson({ offset: 2, limit: 2 }));
    expect(last).toContain('（已到末页）');
  });

  it('不带参数且书不大 → 仍是原来的完整 JSON（老行为不变）', () => {
    const c = prime();
    const r = String(c._readCurrentBookJson());
    expect(r).toContain('"entries"');
    expect(r).toContain('甲的完整内容');
    expect(r).not.toContain('hasTavernResidue');
  });
});

describe('read_current_book_json：压缩视图给多少正文（不再一律砍到 300 字）', () => {
  it('条目不多时把典型条目整条带出来（800 字的条目不截断），只有超长条目才标 truncated', () => {
    WB_BOOKS = [{
      id: 'wb1', name: '大书',
      entries: [
        entry('巨型', '其他', 'x'.repeat(70 * 1024)),
        entry('普通甲', '其他', 'y'.repeat(800)),
        entry('普通乙', '世界观', 'z'.repeat(600)),
      ],
    }];
    const c = prime();
    const j = JSON.parse(String(c._readCurrentBookJson()));
    const by: Record<string, any> = {};
    j.entries.forEach((e: any) => { by[e.name] = e; });
    expect(by['普通甲'].truncated).toBe(false);   // 典型条目（300~1000 字）整条可见
    expect(by['普通甲'].head).toHaveLength(800);
    expect(by['普通乙'].truncated).toBe(false);
    expect(by['巨型'].truncated).toBe(true);      // 超长条目才截断
    expect(by['巨型'].head.length).toBeLessThanOrEqual(1500); // 单条上限
  });

  it('条目上百条时逐条变短（总量有界），但至少 300 字且显式标记 truncated', () => {
    WB_BOOKS = [{
      id: 'wb1', name: '大书',
      entries: Array.from({ length: 80 }, (_v, i) => entry('条' + i, '其他', 'c'.repeat(900))),
    }];
    const c = prime();
    const j = JSON.parse(String(c._readCurrentBookJson()));
    const e0 = j.entries[0];
    expect(e0.truncated).toBe(true);
    expect(e0.head.length).toBeGreaterThanOrEqual(300);
    expect(e0.head.length).toBeLessThan(900);
    // 视图必须点明"完整正文已在【世界书内容】里"，否则模型会把片段当全部
    expect(String(j._compact)).toContain('完整正文');
  });
});

// 写卡上下文注入**不依赖任何开关**（v1.5.97.8）：
// 背景：写卡页曾有一个「世界观」复选框（cwInjectWorld），但它早已不参与任何判断——
// 注入段（【当前书】/【世界书内容】）本来就是无条件的，复选框只剩"看起来能关、其实关不掉"。
// 已连同存储读写一起删除。这里锁住两点：① 源码/页面里不再有该开关；② 即便存储里残留 false 也照常注入。
describe('写卡上下文注入：每次都注入，无开关', () => {
  function primeForSend(c: any): void {
    c._getTargetId = () => 'wb1';
    c._saveDraft = () => {};
    c.renderDraft = () => {};
    c.renderMessages = () => {};
    c._snapshotNow = () => {};
    c._syncDraftFromWorldbook = () => {};
    c._recentHistory = () => [];
    c.refreshContext = function () { (this as any)._context = { wb: { id: 'wb1' }, bookName: '测试书', charsText: '', charCount: 0, worldSetting: true, wbParts: [] }; };
    c._draft = { characters: [], entries: [entry('世界观', '世界观', '这是一个剑与魔法的世界')] };
  }

  it('无条件注入当前书与世界书内容（即便存储里残留 cwInjectWorld=false）', async () => {
    const c = Cw();
    primeForSend(c);
    // 模拟老用户设备里残留的旧开关值：代码不应读它，更不该因此不注入
    anyG.StorageManager = {
      get: (k: string, d: unknown) => (k === 'cwInjectWorld' ? false : d),
      set: () => undefined, remove: () => undefined,
    };
    let captured: any = null;
    anyG.APIHandler = {
      fetchCompletions: (msgs: any, _onChunk: any, onDone: any) => {
        captured = msgs;
        onDone('', false, '');
        return Promise.resolve();
      },
    };

    await c._callAPI('看一下设定');

    const sys = String((captured && captured[0] && captured[0].content) || '');
    expect(sys).toContain('【当前书】《测试书》');
    expect(sys).toContain('【世界书内容】');
    expect(sys).toContain('这是一个剑与魔法的世界');
  });

  it('源码与页面里都不再读写该开关（防死 UI 复活）', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const root = path.resolve(__dirname, '..', '..');
    const cw = fs.readFileSync(path.join(root, 'app', 'src', 'domain', 'cardwriter.ts'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
    expect(html).not.toContain('cwInjectWorld');           // 复选框已删
    expect(cw).not.toMatch(/SM\(\)\.get[^)]*cwInjectWorld/); // 不再从存储读它
    // 旁边两个开关仍然有效（别误删）
    expect(html).toContain('id="cwNsfw"');
    expect(html).toContain('id="cwHandgun"');
    expect(cw).toMatch(/SM\(\)\.get[^)]*cwNsfw/);
    expect(cw).toMatch(/SM\(\)\.get[^)]*cwHandgun/);
  });
});

// 轮次门控（2026-09-25 用户）：「设计阶段只输出设计，不要多轮循环、也不要直接写入」。
// 实现在前端：设计轮**完全不给工具**（模型无从调用 → 一轮结束），操作轮才给。
// 另：「一按发送就显示正在写入」的状态文案已下线，只有真的执行写入时才提示。
describe('轮次门控：设计轮不给工具、操作轮才给', () => {
  function prime(c: any): void {
    c._getTargetId = () => 'wb1';
    c._saveDraft = () => {};
    c.renderDraft = () => {};
    c.renderMessages = () => {};
    c._snapshotNow = () => {};
    c._syncDraftFromWorldbook = () => {};
    c._recentHistory = () => [];
    c._save = () => {};
    c.refreshContext = function () { (this as any)._context = { wb: { id: 'wb1' }, bookName: '测试书', charsText: '', charCount: 0, worldSetting: true, wbParts: [] }; };
    c._draft = { characters: [], entries: [], deleted: [] };
    els.set('cardwriterInput', Object.assign(el(), { value: '' }));
  }
  function stubApi(): any {
    const box: any = { ov: null, msgs: null };
    anyG.APIHandler = {
      probeToolsSupport: () => Promise.resolve(true),
      abort: () => undefined,
      fetchCompletions: (msgs: any, _onChunk: any, onDone: any, _onErr: any, o: any) => {
        box.msgs = msgs; box.ov = o;
        onDone('回复', false, '');
        return Promise.resolve();
      },
    };
    return box;
  }

  it('意图判定：讨论/构思/征询 → 设计轮；写入/修改/整理/跑批 → 操作轮', () => {
    const c = Cw();
    const design = [
      '帮我想想这个角色怎么样', '要不要给他加个妹妹？', '先看看现在的设定',
      '我们讨论一下世界观的方向', '你觉得呢', '我想做一个新角色：女高中生，怕黑',
      '目前已经定了林晚，下一步呢',
    ];
    const act = [
      '写入吧', '就这样', '按这个改', '帮我构建好整套设定', '把林晚改成男高中生',
      '整理一下这本书的条目', '继续', '适配这张酒馆卡', '把多余的条目删掉', '给陈默加个设定',
    ];
    design.forEach((t) => expect(c._hasWriteIntent(t), t).toBe(false));
    act.forEach((t) => expect(c._hasWriteIntent(t), t).toBe(true));
    // 「继续说说」带讨论词 → 仍是设计轮（大卡跑批的「继续」单独一句才是操作轮）
    expect(c._hasWriteIntent('继续说说')).toBe(false);
  });

  it('设计轮：请求里没有 tools，末尾附「本轮：设计轮」；等待文案不是「正在写入…」', async () => {
    const c = Cw();
    prime(c);
    const box = stubApi();
    els.get('cardwriterInput').value = '帮我想想这个新角色怎么样';
    await c.sendMessage();
    expect(c._designTurn).toBe(true);
    expect(c._statusText).not.toContain('正在写入');
    expect(box.ov.tools).toBeUndefined();                       // 一个工具都不给
    expect(String(box.msgs[box.msgs.length - 1].content)).toContain('【本轮：设计轮');
    expect(box.msgs.filter((m: any) => m.role === 'assistant' && m.tool_calls).length).toBe(0);
  });

  it('操作轮：工具齐全、不附设计轮说明', async () => {
    const c = Cw();
    prime(c);
    const box = stubApi();
    els.get('cardwriterInput').value = '写入吧';
    await c.sendMessage();
    expect(c._designTurn).toBe(false);
    expect(Array.isArray(box.ov.tools)).toBe(true);
    expect(box.ov.tools.length).toBeGreaterThan(5);
    expect(String(box.msgs[box.msgs.length - 1].content)).not.toContain('【本轮：设计轮');
  });

  it('变更工具的 schema 里不再有 status/origin 标记参数', () => {
    const names = Cw()._tools().map((t: any) => t.function.name);
    expect(names).toContain('apply_character');
    expect(names).not.toContain('propose_setting');
    const blob = JSON.stringify(Cw()._tools());
    expect(blob).not.toContain("'origin'");
    expect(blob).not.toContain('crossref');
  });
});

// 长按选择（2026-09-25 用户）：① 阈值放宽到 800ms、滑动/滚动取消；
// ② 系统那条「复制/全选」菜单不要再出现、也不许"一点就全选中"——
//    消息区永远 user-select:none，选区完全自绘：长按不动 = 选中手指下那一句，
//    按住拖动 = 从按下那个字开始按字扩选，浮条「全选」= 整条（复制是原文切片，不受 DOM 影响）。
describe('长按选择：自绘选区（不碰原生选择）', () => {
  function prime(c: any): void {
    c._isSending = false;
    c._multiMode = false;
    c._selIdx = -1;
    const realBegin = (anyG as { _realBeginSelect?: any })._realBeginSelect;
    if (realBegin) c._beginSelect = realBegin;   // 还原被前面用例换过的桩
    c._selDrag = null;
    c._selMoveHandler = null;   // 别把上一条用例绑的拖动监听带进来
    c._pressTimer = null;
    c._positionSelBar = () => {};
    c._paintSel = () => {};
    c.messages = [{ role: 'assistant', content: '她说：器材室门口。然后就走了。' }];
  }

  it('阈值 800ms：550ms 不触发、800ms 进入自绘选区（且不创建原生选区）', () => {
    vi.useFakeTimers();
    try {
      const c = Cw();
      prime(c);
      let begun: any = null;
      const getSel = vi.fn(() => null);
      (globalThis as any).window = { getSelection: getSel, innerWidth: 360, innerHeight: 640 };
      c._beginSelect = (i: any, x: any, y: any) => { begun = { i: i, x: x, y: y }; };
      c.msgPressStart({ clientX: 10, clientY: 20, target: { closest: () => null } }, 0);
      vi.advanceTimersByTime(550);
      expect(begun, '550ms 不该触发').toBe(null);
      vi.advanceTimersByTime(250);
      expect(begun).toEqual({ i: 0, x: 10, y: 20 });
      expect(getSel, '不创建原生选区（系统菜单就无从出现）').not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('长按不动选中手指下那一句；按住拖动按字扩选（含区间反转）', () => {
    const c = Cw();
    prime(c);
    c._offsetAt = () => 6;                       // 手指落在「器材室门口。」那一句里
    c._beginSelect(0, 0, 0);
    expect(c._selText).toBe('她说：器材室门口。');   // 长按不动 = 手指下那一句（到句末标点为止）
    expect(c._selDrag.moved).toBe(false);
    c._selDrag.cur = 10; c._selDrag.moved = true; c._applySel();   // 拖到下标 10 → 从按下的第 6 字起
    expect(c._selText).toBe('门口。然');
    c._selDrag.cur = 3; c._applySel();                            // 反向拖回按下点之前 → 区间反转
    expect(c._selText).toBe('器材室');
  });

  it('「全选」= 整条气泡的所有字；浮条复制文案带字数', () => {
    const c = Cw();
    prime(c);
    const labels: string[] = [];
    c._copyText = (t: string, okMsg?: string) => { labels.push(String(okMsg || '')); };
    c.selectMessage(0);
    expect(c._selText).toBe('她说：器材室门口。然后就走了。');
    expect(c._selDrag.all).toBe(true);
    c.selBarAction('copy');
    expect(labels[0]).toContain('字');
  });

  it('拖动用 touchmove/pointermove（触摸滚动时 pointermove 会被 cancel），松手停监听', () => {
    const c = Cw();
    prime(c);
    const added: string[] = [], removed: string[] = [];
    const doc: any = (globalThis as any).document;
    const origAdd = doc.addEventListener, origRemove = doc.removeEventListener;
    doc.addEventListener = (t: string) => added.push(t);
    doc.removeEventListener = (t: string) => removed.push(t);
    try {
      c._offsetAt = () => 0;
      c._beginSelect(0, 0, 0);
      expect(added).toContain('touchmove');
      expect(added).toContain('pointermove');
      c.msgPressEnd();
      expect(removed).toContain('touchmove');
      expect(removed).toContain('pointermove');
    } finally { doc.addEventListener = origAdd; doc.removeEventListener = origRemove; }
  });

  it('页面：消息区永远不可选 + 浮条有「全选」+ 自绘高亮层（防回归）', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
    expect(html).toMatch(/#cardwriterMessages\{[^}]*user-select:none/);
    expect(html).toMatch(/\.cw-msg-text\{[^}]*user-select:none/);
    // 原生放开选择的分支必须不存在（它会让系统「复制/全选」菜单回来 —— 1.5.99 的真实故障）
    expect(html).not.toContain('cw-native-sel-off');
    expect(html).toContain('cw-sel-layer');
    expect(html).toContain("selBarAction('all')");
    expect(html).toContain('id="cardwriterMessages" onscroll="CardWriterChat.msgPressCancel()"');
  });
});

describe('写卡工作副本 = 世界书镜像（以世界书为准）', () => {
  function prime(c: any): void {
    const real = (anyG as { _realSyncDraft?: any })._realSyncDraft;
    if (real) c._syncDraftFromWorldbook = real;   // 还原被前面用例覆盖掉的实现
    c._getTargetId = () => 'wb1';
    c._saveDraft = () => {};
    c.renderDraft = () => {};
    c._snapshotNow = () => {};
  }

  it('世界书改过内容/删过条目/改过类型 → 副本整份对齐（旧实现只补缺，改与删都不同步）', () => {
    const c = Cw();
    prime(c);
    const saves: number[] = [];
    c._saveDraft = () => saves.push(1);
    WB_BOOKS = [{
      id: 'wb1', name: '测试书', entries: [
        { id: 'e1', type: '角色', name: '林薇', content: '【世界书里改过的新内容】' },
        { id: 'e2', type: '世界观', name: '学校', content: '市立三中。' },
        { id: 'e3', type: '其他', name: '旧条目', content: 'x' },
      ],
    }];
    c._draft = {
      characters: [{ name: '林薇', content: '旧内容' }, { name: '已被删掉的角色', content: 'y' }],
      entries: [{ type: '其他', name: '旧条目', content: 'x' }, { type: '世界观', name: '已删条目', content: 'z' }],
      deleted: [{ type: '其他', name: '墓碑' }],
    };
    c._syncDraftFromWorldbook();
    expect(c._draft.characters).toEqual([{ name: '林薇', content: '【世界书里改过的新内容】' }]);
    expect(c._draft.entries).toEqual([
      { type: '世界观', name: '学校', content: '市立三中。' },
      { type: '其他', name: '旧条目', content: 'x' },
    ]);
    expect(c._draft.deleted).toEqual([]);            // 墓碑清掉（同步以世界书为准）
    expect(saves.length).toBe(1);
  });

  it('内容一致时是纯比较：不落盘、不重绘（直写会触发本函数，不能成环）', () => {
    const c = Cw();
    prime(c);
    let saves = 0, renders = 0;
    c._saveDraft = () => { saves++; };
    c.renderDraft = () => { renders++; };
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [
      { id: 'e1', type: '角色', name: '林薇', content: 'A' },
      { id: 'e2', type: '其他', name: '乙', content: 'B' },
    ] }];
    c._draft = { characters: [{ name: '林薇', content: 'A' }], entries: [{ type: '其他', name: '乙', content: 'B' }], deleted: [] };
    c._syncDraftFromWorldbook();
    c._syncDraftFromWorldbook();
    expect(saves).toBe(0);
    expect(renders).toBe(0);
  });

  it('副本里正在新加的"无名空行"保留（还没写进世界书是正常的）', () => {
    const c = Cw();
    prime(c);
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [{ id: 'e1', type: '其他', name: '甲', content: 'A' }] }];
    c._draft = { characters: [], entries: [{ type: '其他', name: '甲', content: 'A' }, { type: '其他', name: '', content: '' }], deleted: [] };
    c._syncDraftFromWorldbook();
    expect(c._draft.entries).toEqual([{ type: '其他', name: '甲', content: 'A' }, { type: '其他', name: '', content: '' }]);
  });

});

// 「对话模式注入的条目」与「世界书 / 写卡里的世界书」是不是同一份（用户 2026-09-25 要求检查）。
// 结论断言：写卡工作副本 = 世界书条目；对话模式的稳定注入块 = 世界书里可注入的条目（逐字节相同）；
// 写卡刚写进去的条目，对话模式下一轮就能看到同样的内容；inject:false / 初始 按各自规则处理。
describe('对话注入 ↔ 世界书 ↔ 写卡：同一本书的三处视图', () => {
  const Chat = (): any => (globalThis as any).ChatMode;

  function seed(entries: any[]): void {
    WB_BOOKS = [{ id: 'wb1', name: '一致性书', entries: entries }];
    WB_ACTIVE = 'wb1';
    const c = Cw();
    c._getTargetId = () => 'wb1';
    c._saveDraft = () => {};
    c.renderDraft = () => {};
    c._snapshotNow = () => {};
    c._draft = { characters: [], entries: [], deleted: [] };
  }

  it('写卡写入的条目 → 世界书 → 对话注入：内容逐字节一致（含中文与换行）', async () => {
    const { ChatMode: CM } = await import('../src/domain/chatmode');
    seed([
      { id: 'e1', type: '角色', name: '林薇', content: '说话直接。', inject: true },
      { id: 'e2', type: '世界观', name: '学校', content: '市立三中。\n天台锁着。', inject: true },
      { id: 'e3', type: '其他', name: '不注入的条目', content: '内部备注。', inject: false },
      { id: 'e4', type: '初始', name: '初始状态', content: '开学第二周。', inject: true },
    ]);
    // 写卡侧：镜像拉取后写入一条新角色（等于在写卡里新增）
    const c = Cw();
    c._syncDraftFromWorldbook();
    expect(c._draft.characters.map((x: any) => x.name)).toContain('林薇');
    expect(c._draft.entries.map((x: any) => x.name)).toContain('学校');
    c._executeTool({ name: 'apply_character', arguments: { name: '陈亦', content: '话少，会弹吉他。' } });
    c._doWriteToWorldbook(true);
    // 世界书里有了
    const book = WB_BOOKS[0].entries;
    expect(book.some((e: any) => e.name === '陈亦' && e.content === '话少，会弹吉他。')).toBe(true);
    // 对话模式注入：可注入的都出现、内容一致；inject:false 与「初始」不进稳定块
    const sys = CM.buildSystem();
    expect(sys).toContain('### [角色] 林薇\n说话直接。');
    expect(sys).toContain('### [角色] 陈亦\n话少，会弹吉他。');
    expect(sys).toContain('### [世界观] 学校\n市立三中。\n天台锁着。');
    expect(sys).not.toContain('不注入的条目');
    // 「初始」不进稳定世界书块（它是开局状态，走下面那个专用段）：
    // 取「世界书条目」段到「故事初始状态」段之间的内容来断言
    const wbSec = sys.slice(sys.indexOf('## 世界书条目'), sys.indexOf('## 故事初始状态') >= 0 ? sys.indexOf('## 故事初始状态') : undefined);
    expect(wbSec).not.toContain('初始状态');
    expect(sys).toContain('## 故事初始状态');          // 演出记录与正文都空 → 开局状态注入一次
    // 名单同样来自同一本书
    expect(CM.roster()).toEqual(expect.arrayContaining(['林薇', '陈亦']));
  });

  it('「初始」条目：演出记录与正文都空时按整条注入（开局状态）', async () => {
    const { ChatMode: CM } = await import('../src/domain/chatmode');
    seed([
      { id: 'e4', type: '初始', name: '初始状态', content: '开学第二周，还没开始写正文。', inject: true },
      { id: 'e2', type: '世界观', name: '学校', content: '市立三中。', inject: true },
    ]);
    expect(CM.buildSystem()).toContain('## 故事初始状态');
    expect(CM.buildSystem()).toContain('开学第二周，还没开始写正文。');
  });

  it('空名条目：写卡不写它、对话也不注入它（不会出现「### [其他] undefined」）', async () => {
    const { ChatMode: CM } = await import('../src/domain/chatmode');
    seed([
      { id: 'e1', type: '角色', name: '林薇', content: '说话直接。', inject: true },
      { id: 'e6', type: '其他', name: '', content: '导入卡里的空名条目', inject: true },
    ]);
    const sys = CM.buildSystem();
    expect(sys).toContain('林薇');
    expect(sys).not.toContain('undefined');
    expect(sys).not.toContain('导入卡里的空名条目');
    // 写卡侧也不会把它写进世界书（写入前按 name 过滤）
    const c = Cw();
    c._syncDraftFromWorldbook();
    c._doWriteToWorldbook(true);
    expect(WB_BOOKS[0].entries.some((e: any) => !String(e.name || '').trim())).toBe(false);
  });

  // 2026-09-25 查出的老 bug：_doWriteToWorldbook 之前是**原地改** old.content，而"无需写入"判据
  // 又拿 old.content 跟新内容比 —— 比较永远相等 → 只改内容的编辑被判成"已是最新"，saveAll 都不调
  // （于是改动只活在内存缓存里，可能永远不落盘）。现在改成复制旧对象再改，判据才准。
  it('只改内容也必须真写并落盘（id 与注入开关保留）；原样重写才判「已是最新」', () => {
    seed([
      { id: 'e1', type: '角色', name: '林薇', content: '旧内容', inject: false },
      { id: 'e2', type: '世界观', name: '学校', content: '市立三中。', inject: true },
    ]);
    const c = Cw();
    c._syncDraftFromWorldbook();
    const saves: number[] = [];
    const orig = (WBM as any).saveAll;
    (WBM as any).saveAll = (arr: any) => { saves.push(1); WB_BOOKS = arr; };
    try {
      c._draft.characters[0].content = '新内容，加长了。'.repeat(3);
      const r = String(c._doWriteToWorldbook(true));
      expect(r).toContain('已写入世界书');
      expect(saves.length).toBe(1);                                   // 真的落盘了
      const e1 = WB_BOOKS[0].entries.find((e: any) => e.id === 'e1');
      expect(e1.content).toContain('新内容');
      expect(e1.inject).toBe(false);                                  // 手动关掉的注入没被打开
      expect(String(c._doWriteToWorldbook(true))).toContain('已是最新');  // 内容一致 → 不白写
      expect(saves.length).toBe(1);
    } finally { (WBM as any).saveAll = orig; }
  });

  it('世界书页删掉的条目 → 对话注入里也没有（三处同时消失）', async () => {
    const { ChatMode: CM } = await import('../src/domain/chatmode');
    seed([
      { id: 'e1', type: '角色', name: '林薇', content: '说话直接。', inject: true },
      { id: 'e5', type: '世界观', name: '要被删的', content: 'x', inject: true },
    ]);
    expect(CM.buildSystem()).toContain('要被删的');
    // 世界书页删除（ui 走 WorldBookManager.deleteEntry → saveAll → 通知写卡对齐）
    (WBM as any).deleteEntry('wb1', 'e5');
    expect(CM.buildSystem()).not.toContain('要被删的');
    const c = Cw();
    c._syncDraftFromWorldbook();
    expect(c._draft.entries.some((x: any) => x.name === '要被删的')).toBe(false);
  });
});

// 比奇的「临时修订」与写卡/世界书的一致性（2026-09-25 一致性检查的第二轮）：
// ① 写卡重写了某条 → 针对旧原文做的临时修订会被清掉（否则它会在对话模式里把新内容盖住）；
// ② 原书里已被删/改名的条目，它的临时修订/停用标记不再塞进提示词（孤儿记录）。
describe('比奇临时修订 ↔ 写卡写入：不再互相盖住', () => {
  function seedBook(entries: any[]): void {
    WB_BOOKS = [{ id: 'wb1', name: '一致性书', entries: entries }];
    WB_ACTIVE = 'wb1';
    const c = Cw();
    c._getTargetId = () => 'wb1';
    c._saveDraft = () => {};
    c.renderDraft = () => {};
    c._snapshotNow = () => {};
    c._draft = { characters: [], entries: [], deleted: [] };
  }
  // 把临时世界书的存储层换成内存对象，才能同时用真实实现（dropModified / overlayCtx）
  let getOv: () => any = () => ({ modified: {}, disabled: [], added: [] });
  async function withOverlay(ov: any, fn: (SS: any) => void | Promise<void>) {
    const SSmod = await import('../src/domain/settingsync');
    const SS: any = SSmod.SettingSyncManager;
    const orig = { isActive: SS.isActive, getOverlay: SS.getOverlay, saveOverlay: SS.saveOverlay, _saveOverlay: SS._saveOverlay };
    let cur = ov;
    getOv = () => cur;                      // 回调里读当前 overlay（不能直接用外部 const：TDZ）
    SS.isActive = () => true;
    SS.getOverlay = () => cur;
    SS.saveOverlay = (o: any) => { cur = o; };
    SS._saveOverlay = (o: any) => { cur = o; };
    try { await fn(SS); } finally {
      Object.keys(orig).forEach((k) => { SS[k] = (orig as any)[k]; });
    }
  }

  it('写卡改动某条 → 该条的对话临时修订被清掉；内容没变则不动比奇的修订', async () => {
    seedBook([
      { id: 'e1', type: '世界观', name: '学校', content: '旧原文。', inject: true },
      { id: 'e2', type: '角色', name: '林薇', content: '说话直接。', inject: true },
    ]);
    const { ChatMode: CM } = await import('../src/domain/chatmode');
    await withOverlay(
      { modified: { e1: { content: '比奇的临时修订。' }, e2: { content: '林薇的临时修订。' } }, disabled: [], added: [] },
      (SS: any) => {
        expect(CM.overlayCtx()).toContain('比奇的临时修订。');
        const c = Cw();
        c._syncDraftFromWorldbook();
        // 只改「学校」这条（比奇对它的修订应被清掉）；「林薇」原样重写（修订保留）
        const idx = c._draft.entries.findIndex((x: any) => x.name === '学校');
        c._draft.entries[idx].content = '写卡写的新原文。';
        const calls: any[] = [];
        const realDrop = SS.dropModified;
        SS.dropModified = (ids: any) => { calls.push(ids); return realDrop.call(SS, ids); };
        const savedAt: number[] = [];
        const origSaveAll = (WBM as any).saveAll;
        (WBM as any).saveAll = (arr: any) => { savedAt.push(1); WB_BOOKS = arr; };
        const wr = c._doWriteToWorldbook(true);
        expect(String(wr)).toContain('已写入世界书');      // 只改内容也必须真的写（见下方的原地改 bug）
        expect(calls.length).toBeGreaterThan(0);           // 并且把该条的临时修订清掉
        SS.dropModified = realDrop;
        (WBM as any).saveAll = origSaveAll;
        expect(savedAt.length).toBeGreaterThan(0);          // 真的落盘了
        expect(WB_BOOKS[0].entries.find((e: any) => e.id === 'e1').content).toBe('写卡写的新原文。');
        expect(getOv().modified.e1).toBeUndefined();
        expect(getOv().modified.e2).toBeTruthy();
        expect(CM.overlayCtx()).not.toContain('比奇的临时修订。');
        expect(CM.overlayCtx()).toContain('林薇的临时修订。');
        expect(CM.buildSystem()).toContain('写卡写的新原文。');   // 稳定块里是新内容
      });
  });

  it('原书里已不存在的条目：它的临时修订/停用标记不会以内部 id 当名字塞进提示词', async () => {
    seedBook([{ id: 'e1', type: '世界观', name: '学校', content: '原文。', inject: true }]);
    const { ChatMode: CM } = await import('../src/domain/chatmode');
    await withOverlay(
      { modified: { e1: { content: '有效修订。' }, e9: { content: '孤儿内容。' } }, disabled: ['e8'], added: [] },
      () => {
        const ovCtx = CM.overlayCtx();
        expect(ovCtx).toContain('有效修订。');
        expect(ovCtx).not.toContain('孤儿内容。');
        expect(ovCtx).not.toContain('e9');
        expect(ovCtx).not.toContain('e8');
      });
  });
});

// =====================================================================================
// 世界书「变量」条目（一个条目 = 一个变量）：写卡 agent 必须能建、能改类型、名称要合法。
// 变量条目的含义（2026-09-26 定案）：名称=变量名、内容=给模型的讲解、注入开关=启用/停用；
// 软件每轮把讲解与当前值发给模型并在正文之后收回报值，所以**内容里不能写输出格式**。
describe('写卡支持「变量」条目', () => {
  it('upsert_entry 支持 type=变量；同名更新、不同名新增（type 原样保留）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [], deleted: [] };
    const r1 = c._executeToolResult({ name: 'upsert_entry', arguments: { type: '变量', name: '任务数量', content: '每月 10 次；用完为止。' } });
    expect(r1.ok).toBe(true);
    expect(c._draft.entries).toHaveLength(1);
    expect(c._draft.entries[0]).toMatchObject({ type: '变量', name: '任务数量' });
    const r2 = c._executeToolResult({ name: 'upsert_entry', arguments: { type: '变量', name: '任务数量', content: '每月 12 次。' } });
    expect(r2.ok).toBe(true);
    expect(c._draft.entries).toHaveLength(1);
    expect(c._draft.entries[0].content).toBe('每月 12 次。');
  });

  it('变量名带冒号/换行 → 拒收（回报格式按「名称：值」走），草稿不变', () => {
    const c = prime();
    c._draft = { characters: [], entries: [], deleted: [] };
    for (const bad of ['任务：数量', '任务:数量', '任务\n数量']) {
      const r = c._executeToolResult({ name: 'upsert_entry', arguments: { type: '变量', name: bad, content: 'x' } });
      expect(r.ok).toBe(false);
      expect(r.message).toContain('变量名');
    }
    expect(c._draft.entries).toHaveLength(0);
  });

  it('set_entry_type 能改成「变量」（并同样校验变量名）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [entry('状态', '其他', '好感度会变。')], deleted: [] };
    const ok = c._executeToolResult({ name: 'set_entry_type', arguments: { name: '状态', type: '变量' } });
    expect(ok.ok).toBe(true);
    expect(c._draft.entries[0].type).toBe('变量');
    const bad = c._executeToolResult({ name: 'set_entry_type', arguments: { name: '状态', type: '变量' } });
    expect(bad.ok).toBe(true);   // 已是变量：同级改类型不报错（既有语义）
    const c2 = prime();
    c2._draft = { characters: [], entries: [entry('甲：乙', '其他', 'x')], deleted: [] };
    const r = c2._executeToolResult({ name: 'set_entry_type', arguments: { name: '甲：乙', type: '变量' } });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('变量名');
  });

  it('工具 schema：类型枚举里都有「变量」（upsert_entry / delete_entry / set_entry_type）', () => {
    const tools = Cw()._tools();
    const byName = (n: string) => tools.find((t: any) => t.function.name === n);
    const enumsOf = (n: string): string[] => {
      const props = byName(n).function.parameters.properties;
      const out: string[] = [];
      if (props.type && props.type.enum) out.push(...props.type.enum);
      const itemType = props.items && props.items.properties && props.items.properties.type;
      if (itemType && itemType.enum) out.push(...itemType.enum);
      return out;
    };
    expect(enumsOf('upsert_entry')).toContain('变量');
    expect(enumsOf('delete_entry')).toContain('变量');
    expect(enumsOf('set_entry_type')).toContain('变量');
    expect(enumsOf('set_entry_type')).toContain('角色');
  });

  it('base 提示词说清「变量」是什么，并明确禁止在内容里写输出格式', () => {
    const base = String(Cw()._defaultBlocks().base || '');
    expect(base).toContain('「变量」条目 = **一个条目一个变量**');
    expect(base).toContain('内容里绝不要写输出格式');
    expect(base).toContain('不能带冒号或换行');
    expect(base).toContain('支持「世界观」「其他」「初始」「变量」四种类型');
    expect(base).toContain('本软件里是**有效宏**');   // {{getvar::}} 的保留/清理规则
  });

  it('直写世界书：变量条目原样落库（类型不丢、注入开关默认开）', () => {
    const c = prime();
    c._draft = {
      characters: [],
      entries: [{ type: '变量', name: '金钱', content: '身上的现金（日元）。' }, entry('学校', '世界观', '天台锁着。')],
      deleted: [],
    };
    c._getTargetId = () => 'wb1';
    c._snapshotNow = () => {};
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('已写入世界书');
    const v = WB_BOOKS[0].entries.find((e: any) => e.type === '变量');
    expect(v).toBeTruthy();
    expect(v.name).toBe('金钱');
    expect(v.content).toBe('身上的现金（日元）。');
    expect(v.inject).toBe(true);
    // 类型排序：变量排最后（世界观→角色→其他→初始→变量），不影响既有可视化顺序
    expect(WB_BOOKS[0].entries[WB_BOOKS[0].entries.length - 1].type).toBe('变量');
  });
});

// 类型降级回归（用户报过"原本是变量条目，变成了其他条目"）：
// 写卡是"以草稿为准整表重建"，任何"没写类型就默认成其他"的路径都会悄悄改掉世界书里那条的类型。
describe('条目类型不许被悄悄降级', () => {
  it('直写世界书：草稿那行没写类型 → 沿用世界书里同名条目的类型（变量不会被写成其他）', () => {
    const c = prime();
    WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [{ id: 'v1', type: '变量', name: '手里的现金（日元）', content: '现金。', inject: true }] }];
    c._draft = { characters: [], entries: [{ name: '手里的现金（日元）', content: '现金（日元）。' }], deleted: [] };   // 注意：没写 type
    c._getTargetId = () => 'wb1';
    c._snapshotNow = () => {};
    c._saveDraft = () => {};
    c.refreshContext = () => {};
    const r = c._doWriteToWorldbook();
    expect(String(r)).toContain('已写入世界书');
    const v = WB_BOOKS[0].entries.find((e: any) => e.name === '手里的现金（日元）');
    expect(v.type).toBe('变量');                       // 降级前会是「其他」
    expect(v.content).toBe('现金（日元）。');
  });

  it('upsert_entry 没传 type：按名字更新原条目并沿用它的类型（不另建同名「其他」）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [{ type: '变量', name: '任务数量', content: '每月 10 次。' }], deleted: [] };
    const r = c._executeToolResult({ name: 'upsert_entry', arguments: { name: '任务数量', content: '每月 12 次。' } });
    expect(r.ok).toBe(true);
    expect(String(r.message)).toContain('沿用类型「变量」');
    expect(c._draft.entries).toHaveLength(1);           // 没有多出一条同名的「其他」
    expect(c._draft.entries[0]).toMatchObject({ type: '变量', name: '任务数量', content: '每月 12 次。' });
  });

  it('upsert_entry 显式传 type：以显式类型为准（改类型是明确意图）', () => {
    const c = prime();
    c._draft = { characters: [], entries: [{ type: '变量', name: '任务数量', content: 'x' }], deleted: [] };
    const r = c._executeToolResult({ name: 'upsert_entry', arguments: { type: '其他', name: '任务数量', content: 'y' } });
    expect(r.ok).toBe(true);
    expect(c._draft.entries.map((e: any) => e.type)).toEqual(['变量', '其他']);   // 显式类型不同 → 新旧各一条（既有语义）
  });
});
