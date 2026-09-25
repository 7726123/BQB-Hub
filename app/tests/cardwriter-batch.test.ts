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
  return { type, name, content, status: 'confirmed', origin: 'user' };
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
