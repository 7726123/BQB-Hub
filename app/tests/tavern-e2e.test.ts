// 写卡运行时端到端（离线闭环）：在 CardWriterChat 真实运行时里调用
// read_adapter_doc / adapt_tavern_lorebook，验证用户粘酒馆 JSON 后
// 在写卡界面实际看到的报告效果 + decisions 二次调用闭环。
// 注：不调外部 API——工具方法本身是纯本地执行，这正是写卡工具层的行为。
// 语料：第三方酒馆世界书 JSON 不进 git（与 ab-chunking 同约定），默认读本机
// Downloads，BQB_TAVERN_JSON 可覆盖；文件不存在时依赖该语料的用例跳过
// （read_adapter_doc / set_entry_type 等不依赖语料的用例始终运行）。
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { WorldBookManager as RealWBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;
const rwbm = RealWBM as unknown as Record<string, any>;

const TAVERN_JSON = process.env.BQB_TAVERN_JSON
  ?? 'C:/Users/a7726/Downloads/新宿拯救计划 - 3.0.json';
const tavernAvailable = existsSync(TAVERN_JSON);

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

describe('写卡运行时：酒馆适配工具端到端（离线）', () => {
  // 依赖第三方语料：无文件时跳过（CI 无该 JSON），其余用例照常运行
  const maybe = tavernAvailable ? it : it.skip;
  let shinjuku = '';
  if (tavernAvailable) shinjuku = readFileSync(TAVERN_JSON, 'utf8');

  it('read_adapter_doc 返回指南全文（agent 需要时自读）', () => {
    const doc = Cw()._readAdapterDoc();
    expect(doc).toContain('酒馆世界书 → 本软件适配指南');
    expect(doc).toContain('数值/状态系统（不询问用户）');
    expect(doc).toContain('直接丢弃');
  });

  maybe('第一轮：粘 JSON 后 agent 调 adapt_tavern_lorebook → 结构化报告文本', () => {
    const report = Cw()._executeAdaptTavern({ json_text: shinjuku });
    // 报告头部：来源/总数
    expect(report).toContain('【酒馆适配报告】');
    expect(report).toContain('共 43 条');
    // 分类统计行
    expect(report).toContain('可直接保留');
    expect(report).toContain('AI 转述（数值系统，不询问）');
    expect(report).toContain('需你拍板 2 条');
    // 数值系统区块：19 条 rewrite 提示
    expect(report).toContain('【需 AI 转述');
    expect(report).toContain('软件无法保存数值/变量');
    // kept 列表
    expect(report).toContain('【将保留 6 条】');
    expect(report).toContain('TomorrowsGirlfriend');
    expect(report).toContain('御千院家族');
    // 需拍板条目逐条列出
    expect(report).toContain('【需要你拍板 2 条】');
    expect(report).toContain('御千院琉璃身份隐藏');
    expect(report).toContain('故事基调');
    // 批量选项（>3 条才给，这里 2 条 → 不出现）
    expect(report).not.toContain('【批量处理】');
  });

  maybe('第二轮：用户拍板后带 decisions 重跑 → 全部已决定', () => {
    const decisions = [
      { uid: 18, action: 'keep', target_type: '角色' },
      { uid: 24, action: 'keep', target_type: '世界观' },
    ];
    const report = Cw()._executeAdaptTavern({ json_text: shinjuku, decisions });
    expect(report).toContain('【已按你的决定处理 2 条】');
    expect(report).toContain('uid 18');
    expect(report).toContain('uid 24');
    expect(report).toContain('【全部已决定】');
    expect(report).not.toContain('【需要你拍板');
  });

  maybe('数值系统条目不会出现在"需要你拍板"里（已分流到 AI 转述）', () => {
    const report = Cw()._executeAdaptTavern({ json_text: shinjuku });
    // 月宫绾音告白（含 getvar 数值条件）应在 AI 转述区，不在 needs_user
    expect(report).toContain('月宫绾音告白');
    const needsSection = report.split('【需要你拍板')[1] || '';
    expect(needsSection).not.toContain('月宫绾音告白');
  });

  it('不传 json_text：从当前书留存的酒馆原文读（v1.5.88 起不要求模型回吐 JSON）', () => {
    // 打桩真实模块（cardwriter 用 ES 导入，改全局桩无效）
    const old = { getAll: rwbm.getAll, getActiveId: rwbm.getActiveId };
    rwbm.getAll = () => [{
      id: 'wb1', name: '导入的书', entries: [],
      tavernSource: { cards: [{ name: '卡', spec: 'chara_card_v3', character_book: { name: '内嵌世界书', entries: [{ id: 0, comment: '角色:林晚', keys: [], content: '姓名：林晚\n怕黑。', enabled: true }] } }] },
    }];
    rwbm.getActiveId = () => 'wb1';
    try {
      const r = Cw()._executeAdaptTavern({});
      expect(r).toContain('书内留存的酒馆原文');
      expect(r).toContain('林晚');
      expect(r).not.toContain('参数无效');
    } finally { rwbm.getAll = old.getAll; rwbm.getActiveId = old.getActiveId; }
  });

  it('不传 json_text 且书里没有酒馆数据 → 给出可操作的指引（不是沉默失败）', () => {
    const old = { getAll: rwbm.getAll, getActiveId: rwbm.getActiveId };
    rwbm.getAll = () => [];
    rwbm.getActiveId = () => null;
    try {
      const r = Cw()._executeAdaptTavern({});
      expect(r).toContain('没有可适配的酒馆数据');
      expect(r).toContain('导入角色卡');
    } finally { rwbm.getAll = old.getAll; rwbm.getActiveId = old.getActiveId; }
  });

  it('set_entry_type：普通条目 → 角色（迁移为角色卡）', () => {
    const c = Cw();
    c._draft = { entries: [{ type: '其他', name: '林晚', content: '怕黑的高中女生。' }], characters: [] };
    const r = c._executeTool({ name: 'set_entry_type', arguments: { name: '林晚', type: '角色' } });
    expect(r).toContain('迁移为角色卡');
    expect(c._draft.entries).toHaveLength(0);
    expect(c._draft.characters).toHaveLength(1);
    expect(c._draft.characters[0].name).toBe('林晚');
    expect(c._draft.characters[0].content).toContain('怕黑');
  });

  it('set_entry_type：角色卡 → 普通条目（迁回 entries）', () => {
    const c = Cw();
    c._draft = { entries: [], characters: [{ name: '陈默', content: '冷淡的旧书店老板。' }] };
    const r = c._executeTool({ name: 'set_entry_type', arguments: { name: '陈默', type: '其他' } });
    expect(r).toContain('迁回普通条目');
    expect(c._draft.characters).toHaveLength(0);
    expect(c._draft.entries).toHaveLength(1);
    expect(c._draft.entries[0].type).toBe('其他');
  });

  it('set_entry_type：同层改类型（世界观 → 初始）', () => {
    const c = Cw();
    c._draft = { entries: [{ type: '世界观', name: '雨城', content: '南方小镇。' }], characters: [] };
    const r = c._executeTool({ name: 'set_entry_type', arguments: { name: '雨城', type: '初始' } });
    expect(r).toContain('从「世界观」改为「初始」');
    expect(c._draft.entries[0].type).toBe('初始');
  });

  it('set_entry_type：错误分支（不存在 / 非法类型 / 缺名）', () => {
    const c = Cw();
    c._draft = { entries: [], characters: [] };
    expect(c._executeTool({ name: 'set_entry_type', arguments: { name: '不存在', type: '角色' } })).toContain('未找到条目');
    expect(c._executeTool({ name: 'set_entry_type', arguments: { name: 'x', type: '地点' } })).toContain('type 必须是');
    expect(c._executeTool({ name: 'set_entry_type', arguments: { type: '角色' } })).toContain('缺少条目名');
    const c2 = Cw();
    c2._draft = null;
    expect(c2._executeTool({ name: 'set_entry_type', arguments: { name: 'x', type: '角色' } })).toContain('草稿不存在');
  });
});