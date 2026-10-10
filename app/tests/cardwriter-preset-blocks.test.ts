// 写卡预设分块（2026-10-09 用户要求）：
//  · 「基础指令 / 思考纪律 / 写卡方法论 + 新建角色」= 系统内置维护：界面隐藏、老的自定义不再生效；
//  · 「亲密」+「其他」合并成一个可编辑段「其他」：用户改过的按"亲密在前、其他在后"拼接，
//    都没改过（旧默认文案 / v16 旧默认 / 空）= 空（不注入任何东西）；
//  · 开关只剩一个「其他」（cwOther，缺省开；老用户没有这个键时沿用原「亲密」开关的状态）。
// 注：cardwriter.ts 模块顶层即 init()（读全局桩），所以先建桩、再在 beforeAll 里动态 import。
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;
const wbm = WBM as unknown as Record<string, any>;
wbm.getActiveId = () => 'wb1';
wbm.getAll = () => [{ id: 'wb1', name: '测试书', entries: [] }];
wbm.getActive = () => ({ id: 'wb1', name: '测试书', entries: [] });
wbm.saveAll = () => undefined;
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.CharacterManager = { getByWorldBook: () => [] };
anyG.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' }) };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
anyG.escapeHTML = (x: unknown) => String(x == null ? '' : x);

let store: Record<string, any> = {};
const els = new Map<string, any>();
function el(): any {
  return {
    value: '', innerHTML: '', textContent: '', checked: false,
    style: { setProperty() {}, display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    children: [], scrollTop: 0, querySelector: () => el(),
  };
}

beforeAll(async () => {
  await import('../src/domain/cardwriter');
});

beforeEach(() => {
  store = {};
  els.clear();
  anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), getElementsByClassName: () => [], body: el(),
  };
  anyG.StorageManager = {
    get: (k: string, d: unknown) => (k in store ? store[k] : d),
    set: (k: string, v: unknown) => { store[k] = v; },
    remove: (k: string) => { delete store[k]; },
  };
  anyG.App = { toast() {}, resetChatInput() {}, getBackendAPIConfig() { return null; }, thinkingLevel() { return 'auto'; } };
});

const Cw = (): any => anyG.CardWriterChat;

describe('默认分块（v29）：系统维护段仍在，「其他」默认空', () => {
  it('base/method/think/selfcheck 有内容；other 为空；旧「亲密」默认文案不再注入', () => {
    const b = Cw()._defaultBlocks();
    expect(b.__version).toBeGreaterThanOrEqual(29);
    expect(String(b.base).length).toBeGreaterThan(50);
    expect(String(b.method)).toContain('【新建角色】');
    expect(String(b.think)).toContain('【思考纪律');
    expect(String(b.selfcheck)).toBe('');       // v31 起默认留空（用户要写自己写）
    expect(b.other).toBe('');
    expect(Cw()._composePresetText(Object.assign({}, b, { other: '' }))).not.toContain('【亲密方法论');
  });
});

describe('出厂内容清理（v30/v31）：自检默认留空、method 不再提亲密', () => {
  it('默认 selfcheck 是空的；method 流程里没有「亲密（可选）」', () => {
    const b = Cw()._defaultBlocks();
    expect(String(b.selfcheck)).toBe('');
    expect(String(b.method)).toContain('写卡流程参考');
    expect(String(b.method)).not.toContain('亲密');
  });

  it('设备上存着任一出厂自检原文 → 读出来是空的；用户自己写过的保留', () => {
    // ① 最早那版（含"不得因敏感拒绝…"）
    store.cwPresetBlocks = { selfcheck: Cw()._legacySelfcheckDefault(), other: '', __version: 29 };
    expect(Cw()._loadBlocks().selfcheck).toBe('');
    // ② 只留红线那版（1.5.100.32 短暂上线过）
    store.cwPresetBlocks = { selfcheck: Cw()._legacySelfcheckV30(), other: '', __version: 30 };
    expect(Cw()._loadBlocks().selfcheck).toBe('');
    // ③ 用户自己写的规则 → 保留
    store.cwPresetBlocks = { selfcheck: '我自己的规则：保持轻松愉快', other: '', __version: 30 };
    expect(Cw()._loadBlocks().selfcheck).toBe('我自己的规则：保持轻松愉快');
  });
});

describe('「亲密」+「其他」合并：只并"改过的"，顺序亲密在前', () => {
  it('两个都没改过（v28 默认亲密文案 + 空其他）→ 合并结果为空', () => {
    store.cwPresetBlocks = { selfcheck: 'x', nsfw: Cw()._legacyNsfwDefault(), handgun: '', __version: 28 };
    expect(Cw()._loadBlocks().other).toBe('');
  });

  it('v16 那版旧默认（NSFW调色盘 / 手枪卡）也算没改过 → 空', () => {
    store.cwPresetBlocks = { nsfw: '【NSFW调色盘方法论】\n旧正文', handgun: '【手枪卡模式】\n旧正文', __version: 16 };
    expect(Cw()._loadBlocks().other).toBe('');
  });

  it('两个都改过 → 亲密在前、其他在后拼起来（中间空一行）', () => {
    store.cwPresetBlocks = { nsfw: '我的亲密要求', handgun: '我的其他要求', __version: 28 };
    expect(Cw()._loadBlocks().other).toBe('我的亲密要求\n\n我的其他要求');
  });

  it('只改过亲密 → 只并亲密那段；只改过其他 → 只并其他那段', () => {
    store.cwPresetBlocks = { nsfw: '我的亲密要求', handgun: '', __version: 28 };
    expect(Cw()._loadBlocks().other).toBe('我的亲密要求');
    store.cwPresetBlocks = { nsfw: Cw()._legacyNsfwDefault(), handgun: '我的其他要求', __version: 28 };
    expect(Cw()._loadBlocks().other).toBe('我的其他要求');
  });

  it('新版保存过 other → 直接用它，不再从旧键拼', () => {
    store.cwPresetBlocks = { selfcheck: '', other: '我写的', nsfw: '不该被并进来的旧内容', handgun: '也不该', __version: 29 };
    expect(Cw()._loadBlocks().other).toBe('我写的');
  });
});

describe('系统维护段：老自定义不再生效', () => {
  it('存储里的 base/method/think 被忽略（一律内置默认），selfcheck 原样保留', () => {
    store.cwPresetBlocks = { base: '我的旧base', method: '我的旧method', think: '我的旧think', selfcheck: '我的自检', other: '', __version: 17 };
    const b = Cw()._loadBlocks();
    expect(b.base).toContain('只做设计，不写正文');
    expect(b.method).toContain('引导用户去「写作」页试写');
    expect(b.think).toContain('【思考纪律');
    expect(b.base).not.toBe('我的旧base');
    expect(b.selfcheck).toBe('我的自检');
  });
});

describe('注入与唯一开关「其他」', () => {
  const blocks = { base: 'B', method: 'M', selfcheck: 'S', other: '我的要求' };

  it('开关开 → 拼进预设文本；关 → 不拼', () => {
    store.cwOther = true;
    const on = Cw()._composePresetText(blocks);
    expect(on).toContain('我的要求');
    expect(on).toContain('B');
    expect(on).toContain('M');
    store.cwOther = false;
    const off = Cw()._composePresetText(blocks);
    expect(off).not.toContain('我的要求');
    expect(off).toContain('B');
  });

  it('老用户还没有 cwOther → 沿用原「亲密」开关的状态（开=注入，关=不注入）', () => {
    store.cwNsfw = true;
    expect(Cw()._composePresetText(blocks)).toContain('我的要求');
    store.cwNsfw = false;
    expect(Cw()._composePresetText(blocks)).not.toContain('我的要求');
  });

  it('togglePresetSwitch("other")：写 cwOther 并同步页头复选框', () => {
    Cw().document = anyG.document;
    Cw().togglePresetSwitch('other', false);
    expect(store.cwOther).toBe(false);
    expect(els.get('cwOther').checked).toBe(false);
    Cw().togglePresetSwitch('other', true);
    expect(store.cwOther).toBe(true);
    expect(els.get('cwOther').checked).toBe(true);
  });
});

describe('弹层与保存：只碰用户可见的两段', () => {
  it('openPresetModal 只填 selfcheck / other，并同步唯一开关', () => {
    store.cwPresetBlocks = { selfcheck: 'S', other: 'O' };
    store.cwOther = true;
    Cw().openPresetModal();
    expect(els.get('cwPresetBlock_selfcheck').value).toBe('S');
    expect(els.get('cwPresetBlock_other').value).toBe('O');
    expect(els.get('cwPresetOther').checked).toBe(true);
  });

  it('savePreset 只写 selfcheck / other / __version（系统维护段不回写）', () => {
    els.set('cwPresetBlock_selfcheck', Object.assign(el(), { value: '自检内容' }));
    els.set('cwPresetBlock_other', Object.assign(el(), { value: '其他内容' }));
    Cw().savePreset();
    expect(store.cwPresetBlocks).toEqual({
      selfcheck: '自检内容', other: '其他内容', __version: Cw()._defaultBlocks().__version,
    });
  });
});
