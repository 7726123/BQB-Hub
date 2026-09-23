import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import { SettingSyncManager, mergeEntryContent } from '../src/domain/settingsync';
import { PluginManager } from '../src/domain/plugins'; // P3-A：plugins 不再挂全局，直接 import 真实实例

const SM = () => (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;
import { WorldBookManager as WBM } from '../src/domain/worldbook';
const PM = PluginManager;

function resetAll() {
  SM().remove('worldBooks');
  SM().remove('activeWorldBookId');
  SM().remove('localPlugins');
  SM().remove('pluginEnabled:agent-setting-sync');
  SM().remove('pluginEnabled:agent-sync');
  // 按书隔离键：测试书 id 未知时先清 none 分桶
  for (const k of ['settingDeltaPending_none', 'settingOverlay_none', 'settingDeltaLog_none', 'settingOverlaySnaps_none', 'settingDeltaMeta_none']) {
    SM().remove(k);
  }
}

function seedBook() {
  const wb = WBM.createBook('测试书');
  WBM.addEntry(wb.id, { type: '世界观', name: '铁剑', content: '主角的武器是铁剑。' });
  WBM.addEntry(wb.id, { type: '角色', name: '阿诺', content: '沉默的剑士。' });
  // 清掉新建书产生的隔离键（createBook 后 activeId 已确定，重清一次保证干净）
  for (const k of ['settingDeltaPending_' + wb.id, 'settingOverlay_' + wb.id, 'settingDeltaLog_' + wb.id, 'settingOverlaySnaps_' + wb.id, 'settingDeltaMeta_' + wb.id]) {
    SM().remove(k);
  }
  return wb;
}

// 启用内置插件「Agent 设定同步」（引擎文案/阈值全部来自代码）。
// 传 legacyData 时改为写入一条存储里的第三方条目——模拟老用户手里下载过的旧 manifest。
function installAgent(legacyData?: any) {
  if (legacyData) {
    SM().set('localPlugins', [{ id: 'agent-sync', name: 'Agent 设定同步', version: '1.0', type: 'widget', shell: 'agent', data: legacyData }]);
    PM.setEnabled('agent-sync', true);
    return;
  }
  PM.setEnabled('agent-setting-sync', true);
}

beforeEach(resetAll);

describe('SettingSyncManager 解析/剥离', () => {
  it('正常块解析出条目', () => {
    const text = '正文正文\n[SETTING_DELTA][{"op":"add","target":"断剑","content":"铁剑已断。","reason":"剧情","quote":"咔嚓一声"}][/SETTING_DELTA]';
    expect(SettingSyncManager.hasDeltaBlock(text)).toBe(true);
    const ops = SettingSyncManager.parseDeltaBlock(text);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('add');
    expect(ops[0].target).toBe('断剑');
  });

  it('空数组返回空', () => {
    expect(SettingSyncManager.parseDeltaBlock('正文[SETTING_DELTA][][/SETTING_DELTA]')).toEqual([]);
  });

  it('非法 JSON 静默丢弃（不抛错）', () => {
    const ops = SettingSyncManager.parseDeltaBlock('正文[SETTING_DELTA][{坏}][/SETTING_DELTA]');
    expect(ops).toEqual([]);
  });

  it('无块返回空；非法 op/空 target 被过滤', () => {
    expect(SettingSyncManager.parseDeltaBlock('纯正文')).toEqual([]);
    const ops = SettingSyncManager.parseDeltaBlock('[SETTING_DELTA][{"op":"xxx","target":"a","content":"b"},{"op":"add","target":"","content":"c"},{"op":"del","target":"阿诺","content":"","reason":"死了","quote":"他倒下了"}][/SETTING_DELTA]');
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('del');
  });

  it('strip 剥干净且不伤正文', () => {
    const clean = SettingSyncManager.stripDeltaBlock('第一段\n[SETTING_DELTA][{"op":"add","target":"x","content":"y"}][/SETTING_DELTA]\n第二段');
    expect(clean).toContain('第一段');
    expect(clean).toContain('第二段');
    expect(clean).not.toContain('SETTING_DELTA');
  });

  it('残缺块（未闭合/半截）也被剥离，不留格式进正文', () => {
    // 模型漏写闭标签 / 输出被截断
    const c1 = SettingSyncManager.stripDeltaBlock('正文推进中[SETTING_DELTA][{"op":"add","target":"x","content":"y"}');
    expect(c1).not.toContain('SETTING_DELTA');
    expect(c1).toContain('正文推进中');
    // 只有开头标记
    const c2 = SettingSyncManager.stripDeltaBlock('正文[SETTING_DELTA]');
    expect(c2).not.toContain('SETTING_DELTA');
    expect(c2).toContain('正文');
    // 孤立闭标签
    const c3 = SettingSyncManager.stripDeltaBlock('正文[/SETTING_DELTA]尾');
    expect(c3).not.toContain('SETTING_DELTA');
    expect(c3).toContain('正文');
    expect(c3).toContain('尾');
  });

  // 线上问题：模型把标记写成变体（复数 SETTINGS_DELTA / 误写 SERIES_DELTA / 大小写 / 空格），
  // 字面量匹配整块漏剥 → 格式上屏、规则文字进正文。容错识别必须覆盖这些变体。
  it('标记变体（SETTINGS_DELTA / SERIES_DELTA）同样解析', () => {
    const v1 = SettingSyncManager.parseDeltaBlock('[SETTINGS_DELTA][{"op":"add","target":"断剑","content":"已断"}][/SETTINGS_DELTA]');
    expect(v1).toHaveLength(1);
    expect(v1[0].target).toBe('断剑');
    const v2 = SettingSyncManager.parseDeltaBlock('正文\n[SERIES_DELTA][{"op":"mod","target":"铁剑","content":"只剩剑柄"}][/SETTINGS_DELTA]');
    expect(v2).toHaveLength(1);
    expect(v2[0].op).toBe('mod');
    // 大小写混乱
    const v3 = SettingSyncManager.parseDeltaBlock('[setting_delta][{"op":"del","target":"阿诺","content":"","reason":"战死","quote":"他倒下了"}][/Setting_Delta]');
    expect(v3).toHaveLength(1);
    expect(v3[0].op).toBe('del');
  });

  it('标记变体同样被剥离干净（不含变体标签文本）', () => {
    const c1 = SettingSyncManager.stripDeltaBlock('第一段\n[SETTINGS_DELTA][{"op":"add","target":"x","content":"y"}][/SETTINGS_DELTA]\n第二段');
    expect(c1).toContain('第一段');
    expect(c1).toContain('第二段');
    expect(c1).not.toMatch(/DELTA/i);
    // 变体 + 漏闭 + 半截 JSON → 整段剥掉，不留残片
    const c2 = SettingSyncManager.stripDeltaBlock('正文结束。[SERIES_DELTA][{"op":"add","target":"x","content":"y"}');
    expect(c2).toContain('正文结束。');
    expect(c2).not.toMatch(/DELTA/i);
    expect(c2).not.toContain('"content"');
    // 截断的 JSON 里含中文（content 值被切断）→ 同样整段剥掉，中文残片不漏进正文
    const c2b = SettingSyncManager.stripDeltaBlock('正文结束。[SETTING_DELTA][{"op":"add","target":"断剑","content":"铁剑已断');
    expect(c2b).toContain('正文结束。');
    expect(c2b).not.toMatch(/DELTA/i);
    expect(c2b).not.toContain('铁剑已断');
    // 半截块后若紧跟正文（非 JSON 载荷）→ 只删标记，不吞正文
    const c2c = SettingSyncManager.stripDeltaBlock('甲段。[SETTING_DELTA]\n乙段继续叙事。');
    expect(c2c).toContain('甲段。');
    expect(c2c).toContain('乙段继续叙事。');
    expect(c2c).not.toMatch(/DELTA/i);
    // 漏闭但 JSON 完整、其后还有正文 → 只剥块，正文保留
    const c2d = SettingSyncManager.stripDeltaBlock('甲段。[SETTING_DELTA][{"op":"add","target":"x","content":"y"}]乙段继续。');
    expect(c2d).toContain('甲段。');
    expect(c2d).toContain('乙段继续。');
    expect(c2d).not.toMatch(/DELTA/i);
    expect(c2d).not.toContain('"content"');
    // 变体空块
    const c3 = SettingSyncManager.stripDeltaBlock('甲[SERIES_DELTA][][/SETTINGS_DELTA]乙');
    expect(c3).toContain('甲');
    expect(c3).toContain('乙');
    expect(c3).not.toMatch(/DELTA/i);
  });

  it('hasDeltaMarker 覆盖变体与漏闭；hasDeltaBlock 仍只认完整块', () => {
    const variant = '正文[SERIES_DELTA][{"op":"add","target":"a","content":"b"}]';
    expect(SettingSyncManager.hasDeltaBlock(variant)).toBe(false); // 无闭标签
    expect(SettingSyncManager.hasDeltaMarker(variant)).toBe(true); // 但必须走剥离链路
    expect(SettingSyncManager.hasDeltaMarker('纯正文，无标记')).toBe(false);
    // 正文里的方括号言论不误判（中文/无 DELTA 词根）
    expect(SettingSyncManager.hasDeltaMarker('他喊道：「[注意] 前面有埋伏！」')).toBe(false);
  });

  it('正文中的普通方括号内容不被剥离（不误伤）', () => {
    const c = SettingSyncManager.stripDeltaBlock('他写下备注[重要]明天出发，又补了一句「[笑]」。');
    expect(c).toContain('[重要]');
    expect(c).toContain('「[笑]」');
  });
});

describe('SettingSyncManager 门控与合并视图', () => {
  it('未启用插件时 isEnabled 为 false', () => {
    seedBook();
    expect(SettingSyncManager.isEnabled()).toBe(false);
  });

  it('启用后 isEnabled 为 true，关闭后回落', () => {
    seedBook();
    installAgent();
    expect(SettingSyncManager.isEnabled()).toBe(true);
    PM.setEnabled('agent-setting-sync', false);
    expect(SettingSyncManager.isEnabled()).toBe(false);
  });

  it('getEffectiveEntries：关闭时等于原书；overlay 生效 modified/disabled/added', () => {
    const wb = seedBook();
    installAgent();
    const iron = WBM.getActive()!.entries.find(e => e.name === '铁剑')!;
    const arno = WBM.getActive()!.entries.find(e => e.name === '阿诺')!;
    // 先采纳一条 add + 一条 mod + 一条 del
    SettingSyncManager.addPending([
      { id: 'p1', op: 'add', target: '断剑', content: '铁剑已断。', reason: '', quote: '', round: 1, status: 'pending' },
      { id: 'p2', op: 'mod', target: '铁剑', content: '铁剑已断，只剩剑柄。', reason: '', quote: '咔嚓', round: 1, status: 'pending' },
      { id: 'p3', op: 'del', target: '阿诺', content: '', reason: '战死', quote: '他倒下了', round: 1, status: 'pending' },
    ]);
    const r = SettingSyncManager.applyApproved([
      { id: 'p1', decision: 'accept' },
      { id: 'p2', decision: 'accept' },
      { id: 'p3', decision: 'accept' },
    ]);
    expect(r.accepted).toBe(3);
    const eff = SettingSyncManager.getEffectiveEntries();
    // 阿诺被软删除 → 不在合并视图
    expect(eff.some(e => e.name === '阿诺')).toBe(false);
    // 铁剑被修改 → 内容为新值，原书未动
    expect(eff.find(e => e.name === '铁剑')!.content).toContain('只剩剑柄');
    expect(WBM.getActive()!.entries.find(e => e.id === iron.id)!.content).toContain('铁剑。');
    // 断剑新增
    expect(eff.some(e => e.name === '断剑')).toBe(true);
    // entryStatus 打标
    expect(SettingSyncManager.entryStatus(iron.id)).toBe('modified');
    expect(SettingSyncManager.entryStatus(arno.id)).toBe('disabled');
    void wb;
  });

  it('删除只软删除：原书条目本体保留，可恢复', () => {
    seedBook();
    installAgent();
    const arno = WBM.getActive()!.entries.find(e => e.name === '阿诺')!;
    SettingSyncManager.addPending([{ id: 'p1', op: 'del', target: '阿诺', content: '', reason: '', quote: '倒下', round: 1, status: 'pending' }]);
    SettingSyncManager.applyApproved([{ id: 'p1', decision: 'accept' }]);
    // 原书本体还在
    expect(WBM.getActive()!.entries.some(e => e.id === arno.id)).toBe(true);
    // 回滚恢复
    expect(SettingSyncManager.rollback()).toBe(true);
    expect(SettingSyncManager.getEffectiveEntries().some(e => e.name === '阿诺')).toBe(true);
  });
});

describe('SettingSyncManager 触发阈值', () => {
  it('满 5 条触发 count；不足 5 条不触发', () => {
    seedBook();
    installAgent();
    for (let i = 0; i < 4; i++) {
      SettingSyncManager.addPending([{ id: 'p' + i, op: 'add', target: '条' + i, content: 'c', reason: '', quote: '', round: i, status: 'pending' }]);
    }
    expect(SettingSyncManager.shouldTriggerReview()).toBeNull();
    SettingSyncManager.addPending([{ id: 'p4', op: 'add', target: '条4', content: 'c', reason: '', quote: '', round: 4, status: 'pending' }]);
    expect(SettingSyncManager.shouldTriggerReview()).toBe('count');
  });

  it('超 10 轮超时结算 timeout', () => {
    seedBook();
    installAgent();
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: '孤条', content: 'c', reason: '', quote: '', round: 1, status: 'pending' }]);
    for (let i = 0; i < 9; i++) SettingSyncManager.bumpRound();
    expect(SettingSyncManager.shouldTriggerReview()).toBeNull();
    expect(SettingSyncManager.bumpRound()).toBe('timeout');
  });

  it('超 20 条强制 overflow；切章标记优先 chapter', () => {
    seedBook();
    installAgent();
    for (let i = 0; i < 20; i++) {
      SettingSyncManager.addPending([{ id: 'q' + i, op: 'add', target: '爆' + i, content: 'c', reason: '', quote: '', round: 1, status: 'pending' }]);
    }
    expect(SettingSyncManager.shouldTriggerReview()).toBe('overflow');
    SettingSyncManager.requestChapterReview();
    expect(SettingSyncManager.shouldTriggerReview()).toBe('chapter');
  });
});

describe('SettingSyncManager 引擎强制规则（事件不入世界书）', () => {
  it('reviewSystem 始终用引擎内置默认 + 强制规则（插件旧 data.reviewPrompt 不再覆盖）', () => {
    seedBook();
    // 历史遗留第三方条目：data.reviewPrompt 必须被引擎忽略
    installAgent({ reviewPrompt: '你是旧版法官，默认拒绝，只接受证据确凿的变更。' });
    const cfg = SettingSyncManager.getConfig();
    // 旧插件固化文案不再生效（曾因 pickText 优先 data 覆盖掉新版宽松策略 → 老是拒绝）
    expect(cfg.reviewSystem).not.toContain('旧版法官');
    expect(cfg.reviewSystem).not.toContain('默认拒绝');
    // 内置宽松策略 + 强制规则生效
    expect(cfg.reviewSystem).toContain('能救则救');
    expect(cfg.reviewSystem).toContain('引擎强制规则');
    expect(cfg.reviewSystem).toContain('一次性情节事件');
  });

  it('buildTailInstruction 用引擎内置模板（插件旧 data.tailInstruction 不再覆盖）', () => {
    seedBook();
    // 历史遗留第三方条目：data.tailInstruction 必须被引擎忽略
    installAgent({ tailInstruction: '自定义尾巴' });
    const t = SettingSyncManager.buildTailInstruction();
    expect(t).not.toContain('自定义尾巴');
    expect(t).toContain('引擎强制');
    expect(t).toContain('情节事件');
  });

  it('引擎强制规则含角色字段模板（姓名/性别/年龄/外貌/性格/背景…）', () => {
    seedBook();
    installAgent();
    const cfg = SettingSyncManager.getConfig();
    expect(cfg.reviewSystem).toContain('姓名：xxx');
    expect(cfg.reviewSystem).toContain('性别：xxx');
    expect(cfg.reviewSystem).toContain('性格：xxx');
    expect(cfg.reviewSystem).toContain('背景：xxx');
    expect(cfg.reviewSystem).toContain('merge 重排成该格式');
    expect(SettingSyncManager.buildTailInstruction()).toContain('字段清单格式');
  });
});

describe('SettingSyncManager 漏报自愈（missStreak 补交提醒）', () => {

  it('同条目提案合并：同一目标只保留最新一条（含跨轮与 op 变化）', () => {
    seedBook();
    // 一轮内同一条目提两次修改
    SettingSyncManager.addPending([
      { id: 'a1', op: 'mod', target: '铁剑', content: '出现裂纹', reason: 'r1', quote: 'q1', round: 1, status: 'pending' },
      { id: 'a2', op: 'mod', target: '铁剑', content: '断成两截', reason: 'r2', quote: 'q2', round: 1, status: 'pending' },
    ], 1);
    let pend = SettingSyncManager.getPending();
    expect(pend.filter(p => p.target === '铁剑')).toHaveLength(1);
    expect(pend[0].content).toBe('断成两截');      // 最新内容生效
    expect(pend[0].reason).toBe('r2');
    expect(pend[0].id).toBe('a1');                 // 保留原 id（在途二审快照对得上）
    expect(pend[0].mergedCount).toBe(2);

    // 跨轮再改同一条目：仍然只有一条
    SettingSyncManager.addPending([{ id: 'a3', op: 'mod', target: '铁剑', content: '被熔成铁水', reason: 'r3', quote: 'q3', round: 2, status: 'pending' }], 2);
    pend = SettingSyncManager.getPending();
    expect(pend.filter(p => p.target === '铁剑')).toHaveLength(1);
    expect(pend[0].content).toBe('被熔成铁水');
    expect(pend[0].round).toBe(2);
    expect(pend[0].mergedCount).toBe(3);

    // op 变化：后来的 del 取代先前的 mod（最终意图为准）
    SettingSyncManager.addPending([{ id: 'a4', op: 'del', target: '铁剑', content: '', reason: '角色死亡', quote: '', round: 3, status: 'pending' }], 3);
    pend = SettingSyncManager.getPending();
    const iron = pend.filter(p => p.target === '铁剑');
    expect(iron).toHaveLength(1);
    expect(iron[0].op).toBe('del');

    // 不同条目互不影响
    SettingSyncManager.addPending([{ id: 'a5', op: 'mod', target: '阿诺', content: '断了条手臂', reason: '', quote: '', round: 3, status: 'pending' }], 3);
    pend = SettingSyncManager.getPending();
    expect(pend).toHaveLength(2);
    expect(pend.map(p => p.target).sort()).toEqual(['铁剑', '阿诺']);   // JS 默认按 UTF-16 码位排序
  });

  it('待裁决为空时连续 2 轮无 delta 痕迹 → 提醒出现一次并清零', () => {
    seedBook();
    installAgent();
    // 第 1 轮无输出 → miss 1
    SettingSyncManager.noteDeltaResult(0);
    expect(SettingSyncManager.buildReminderText()).toBe('');
    // 第 2 轮无输出 → miss 2 → 提醒
    SettingSyncManager.noteDeltaResult(0);
    const r1 = SettingSyncManager.buildReminderText();
    expect(r1).toContain('设定补交');
    expect(r1).toContain('新登场的重要角色');
    // 提醒后清零：再查为空
    expect(SettingSyncManager.buildReminderText()).toBe('');
  });

  it('模型输出过 delta 块（哪怕空）不算 miss；有提议立即清 0', () => {
    seedBook();
    installAgent();
    SettingSyncManager.noteDeltaResult(1); // 有空块
    SettingSyncManager.noteDeltaResult(1);
    expect(SettingSyncManager.buildReminderText()).toBe('');
    // 有提议产出 → 清 0
    SettingSyncManager.noteDeltaResult(0);
    SettingSyncManager.noteDeltaResult(3);
    SettingSyncManager.noteDeltaResult(0);
    expect(SettingSyncManager.buildReminderText()).toBe('');
  });

  it('有待裁决时不提醒', () => {
    seedBook();
    installAgent();
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: '条', content: 'c', reason: '', quote: '', round: 1, status: 'pending' }]);
    SettingSyncManager.noteDeltaResult(0);
    SettingSyncManager.noteDeltaResult(0);
    expect(SettingSyncManager.buildReminderText()).toBe('');
  });
});

describe('SettingSyncManager 重置（resetBook 联动语义）', () => {
  it('resetAll 清 overlay+待裁决+快照+meta（含 missStreak），原书零触碰', () => {
    seedBook();
    installAgent();
    const before = JSON.stringify(WBM.getActive()!.entries);
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: 'x', content: 'c', reason: '', quote: '', round: 1, status: 'pending' }]);
    SettingSyncManager.applyApproved([{ id: 'p1', decision: 'accept' }]);
    SettingSyncManager.noteDeltaResult(0);
    SettingSyncManager.noteDeltaResult(0);
    expect(SettingSyncManager.overlayCount()).toBeGreaterThan(0);
    SettingSyncManager.resetAll();
    expect(SettingSyncManager.overlayCount()).toBe(0);
    expect(SettingSyncManager.getPending()).toEqual([]);
    expect(SettingSyncManager.getSnapshots()).toEqual([]);
    expect(SettingSyncManager.buildReminderText()).toBe(''); // missStreak 已清
    expect(JSON.stringify(WBM.getActive()!.entries)).toBe(before);
  });
});

describe('SettingSyncManager 二审契约', () => {
  it('buildReviewUserText 列出各目标条目当前完整内容（AI 整合底稿）+ 正文', () => {
    seedBook();
    installAgent();
    SettingSyncManager.addPending([{ id: 'p1', op: 'mod', target: '铁剑', content: '断了', reason: '剧情', quote: '咔嚓', round: 1, status: 'pending' }]);
    const t = SettingSyncManager.buildReviewUserText('最近正文……咔嚓……');
    expect(t).toContain('铁剑');
    expect(t).toContain('咔嚓'); // 正文
    // 铁剑在原书存在 → user 里列出其当前完整内容（AI 整合底稿）
    expect(t).toContain('主角的武器是铁剑');
    expect(t).toContain('[原书条]铁剑');
    // 缺失条目 → 标注不存在
    SettingSyncManager.addPending([{ id: 'p2', op: 'add', target: '幽灵', content: 'c', reason: '', quote: '', round: 1, status: 'pending' }]);
    const t2 = SettingSyncManager.buildReviewUserText('x');
    expect(t2).toContain('幽灵：（不存在，属全新条目）');
  });

  it('parseReviewResult 非 JSON 返回 null；合法解析', () => {
    expect(SettingSyncManager.parseReviewResult('胡言乱语')).toBeNull();
    const ds = SettingSyncManager.parseReviewResult('[{"id":"p1","decision":"accept"},{"id":"p2","decision":"reject","reason":"证据不足"}]');
    expect(ds).toHaveLength(2);
    expect(ds![0].decision).toBe('accept');
    expect(ds![1].reason).toBe('证据不足');
  });

  it('parseReviewResult 容忍 ```json fence 与前后解释文字', () => {
    // fence 包裹
    const ds1 = SettingSyncManager.parseReviewResult('```json\n[{"id":"p1","decision":"accept"}]\n```');
    expect(ds1 && ds1.length).toBe(1);
    expect(ds1![0].decision).toBe('accept');
    // 解释文字 + 数组（截取 [ ] 之间）
    const ds2 = SettingSyncManager.parseReviewResult('好的，以下是裁决结果：\n[{"id":"p1","decision":"merge","content":"新版"},{"id":"p2","decision":"reject"}]\n以上。');
    expect(ds2 && ds2.length).toBe(2);
    expect(ds2![0].content).toBe('新版');
  });

  it('reject 保留待裁决外条目；merge 用新内容', () => {
    seedBook();
    installAgent();
    SettingSyncManager.addPending([
      { id: 'p1', op: 'add', target: '新村', content: '旧描述', reason: '', quote: '', round: 1, status: 'pending' },
      { id: 'p2', op: 'add', target: '旧镇', content: 'c', reason: '', quote: '', round: 1, status: 'pending' },
    ]);
    const r = SettingSyncManager.applyApproved([
      { id: 'p1', decision: 'merge', content: '新描述' },
      { id: 'p2', decision: 'reject', reason: '重复' },
    ]);
    expect(r.accepted).toBe(1);
    expect(r.rejected).toBe(1);
    expect(SettingSyncManager.getEffectiveEntries().find(e => e.name === '新村')!.content).toBe('新描述');
    // 拒绝的不落盘；未裁决的压根没传 decision → 保留在待裁决
    expect(SettingSyncManager.getPending()).toEqual([]);
  });

  it('resetAll 清 overlay+待裁决+快照，原书零触碰', () => {
    seedBook();
    installAgent();
    const before = JSON.stringify(WBM.getActive()!.entries);
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: 'x', content: 'c', reason: '', quote: '', round: 1, status: 'pending' }]);
    SettingSyncManager.applyApproved([{ id: 'p1', decision: 'accept' }]);
    expect(SettingSyncManager.overlayCount()).toBeGreaterThan(0);
    SettingSyncManager.resetAll();
    expect(SettingSyncManager.overlayCount()).toBe(0);
    expect(SettingSyncManager.getPending()).toEqual([]);
    expect(JSON.stringify(WBM.getActive()!.entries)).toBe(before);
  });

  it('parseReviewResult 透出 retarget 字段', () => {
    const ds = SettingSyncManager.parseReviewResult('[{"id":"p1","decision":"accept","retarget":"剑客阿诺"}]');
    expect(ds).toHaveLength(1);
    expect(ds![0].retarget).toBe('剑客阿诺');
  });

  it('add 标题纠错：内容对但 target 错 → retarget 按正确名新增', () => {
    seedBook();
    installAgent();
    // 内容其实讲「断剑」（正文依据），但 target 误写成「铁剑」
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: '铁剑', content: '断剑是把通体漆黑的剑。', reason: '新道具登场', quote: '他拔出那把通体漆黑的剑', round: 1, status: 'pending' }]);
    const r = SettingSyncManager.applyApproved([
      { id: 'p1', decision: 'accept', retarget: '断剑' },
    ]);
    expect(r.accepted).toBe(1);
    const eff = SettingSyncManager.getEffectiveEntries();
    // 正确名「断剑」新增成功
    expect(eff.some(e => e.name === '断剑')).toBe(true);
    // 原书「铁剑」未被误改（内容没盖到铁剑上）
    expect(eff.find(e => e.name === '铁剑')!.content).toContain('主角的武器是铁剑');
    // 没有叫「铁剑」的新增残留（原书铁剑仍在，新增的用的是断剑名）
    expect(eff.filter(e => e.name === '铁剑')).toHaveLength(1);
  });

  it('mod 标题纠错：retarget 指向原书实际该改的条目', () => {
    seedBook();
    installAgent();
    // 内容实际在讲「阿诺」的剑术精进，target 却写成「铁剑」
    SettingSyncManager.addPending([{ id: 'p1', op: 'mod', target: '铁剑', content: '阿诺的剑术已臻化境。', reason: '实力变化', quote: '剑光如龙', round: 1, status: 'pending' }]);
    const r = SettingSyncManager.applyApproved([
      { id: 'p1', decision: 'accept', retarget: '阿诺' },
    ]);
    expect(r.accepted).toBe(1);
    const eff = SettingSyncManager.getEffectiveEntries();
    // 阿诺条目被改（overlay modified）
    const arno = WBM.getActive()!.entries.find(e => e.name === '阿诺')!;
    expect(SettingSyncManager.entryStatus(arno.id)).toBe('modified');
    expect(SettingSyncManager.getDisplayEntry(arno).content).toContain('剑术已臻化境');
    // 铁剑原内容未被误改
    expect(eff.find(e => e.name === '铁剑')!.content).toContain('主角的武器是铁剑');
  });

  it('add 目标已存在 → 并入已有条目，不重复建条（原书已有一条阿诺）', () => {
    seedBook();
    installAgent();
    // 模型该报 mod 却报 add：内容讲「阿诺」新增的剑术境界，target 误写「铁剑」，retarget 纠正回阿诺
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: '铁剑', content: '阿诺剑术臻至「无我」之境。', reason: '实力变化', quote: '剑光如龙', round: 1, status: 'pending' }]);
    const r = SettingSyncManager.applyApproved([
      { id: 'p1', decision: 'accept', retarget: '阿诺' },
    ]);
    expect(r.accepted).toBe(1);
    const eff = SettingSyncManager.getEffectiveEntries();
    // 阿诺只有一条（不重复建条），内容并入
    expect(eff.filter(e => e.name === '阿诺')).toHaveLength(1);
    const arno = WBM.getActive()!.entries.find(e => e.name === '阿诺')!;
    expect(SettingSyncManager.entryStatus(arno.id)).toBe('modified');
    expect(SettingSyncManager.getDisplayEntry(arno).content).toContain('无我');
    // 铁剑未被误改
    expect(eff.find(e => e.name === '铁剑')!.content).toContain('主角的武器是铁剑');
  });

  it('add 目标已存在且是临时新增条 → 覆盖该临时条，不重复 push', () => {
    seedBook();
    installAgent();
    // 先有一条临时新增「断剑」
    SettingSyncManager.addPending([{ id: 'p0', op: 'add', target: '断剑', content: '初版描述', reason: '', quote: '', round: 1, status: 'pending' }]);
    SettingSyncManager.applyApproved([{ id: 'p0', decision: 'accept' }]);
    expect(SettingSyncManager.getEffectiveEntries().filter(e => e.name === '断剑')).toHaveLength(1);
    // 又来一条 add 断剑（目标已存在于临时层）
    SettingSyncManager.addPending([{ id: 'p1', op: 'add', target: '断剑', content: '新版描述', reason: '', quote: '', round: 2, status: 'pending' }]);
    SettingSyncManager.applyApproved([{ id: 'p1', decision: 'accept' }]);
    const eff = SettingSyncManager.getEffectiveEntries();
    expect(eff.filter(e => e.name === '断剑')).toHaveLength(1);
    expect(eff.find(e => e.name === '断剑')!.content).toContain('新版描述');
  });

  it('AI 给了完整最终 content → 整体写入（AI 自主整合，系统不二次拼接）', () => {
    seedBook();
    installAgent();
    // 阿诺条目已存在；AI 基于旧全文+新设定自主整合出完整最终版（保留了旧性格、更新了年龄）
    SettingSyncManager.addPending([{ id: 'p1', op: 'mod', target: '阿诺', content: '年龄：18', reason: '长大了', quote: '他十八岁', round: 1, status: 'pending' }]);
    const r = SettingSyncManager.applyApproved([
      { id: 'p1', decision: 'accept', content: '姓名：阿诺\n性别：男\n年龄：18\n性格：沉默寡言\n背景：边境村出身' },
    ]);
    expect(r.accepted).toBe(1);
    const eff = SettingSyncManager.getEffectiveEntries();
    const arno = WBM.getActive()!.entries.find(e => e.name === '阿诺')!;
    // 整体写入 AI 整合版（不是代码拼接，也没有把旧散文"沉默的剑士。"追加进来）
    expect(SettingSyncManager.getDisplayEntry(arno).content).toBe('姓名：阿诺\n性别：男\n年龄：18\n性格：沉默寡言\n背景：边境村出身');
    expect(eff.filter(e => e.name === '阿诺')).toHaveLength(1);
  });

  it('引擎强制规则含 retarget 标题纠错说明', () => {
    seedBook();
    installAgent();
    const cfg = SettingSyncManager.getConfig();
    expect(cfg.reviewSystem).toContain('retarget');
    expect(SettingSyncManager.buildTailInstruction()).toContain('target 标题必须与 content 内容归属一致');
  });

  it('宽松策略：可修正的瑕疵不得整条拒绝（能救则救）', () => {
    seedBook();
    installAgent();
    const cfg = SettingSyncManager.getConfig();
    // 不再"默认拒绝/措辞微调一律拒绝"
    expect(cfg.reviewSystem).not.toContain('默认拒绝');
    expect(cfg.reviewSystem).not.toContain('措辞微调一律拒绝');
    // 明确"能救则救"，reject 仅限内容本质错误
    expect(cfg.reviewSystem).toContain('能救则救');
    expect(cfg.reviewSystem).toContain('不该收录');
    // 强制规则六：散文/越界 mod → merge 修正而非拒绝
    expect(cfg.reviewSystem).toContain('merge 重排成该格式');
    expect(cfg.reviewSystem).toContain('修正后采纳');
  });
});

describe('mergeEntryContent（并入已有条目，不覆盖丢失原内容）', () => {
  it('字段清单：同名字段新值覆盖、未提及字段保留、新字段追加', () => {
        const oldC = '姓名：阿诺\n性别：男\n年龄：16\n性格：沉默寡言\n背景：边境村出身';
    const newC = '姓名：阿诺\n年龄：17\n关系：与主角（同门师兄）';
    const out = mergeEntryContent(oldC, newC);
    expect(out).toContain('姓名：阿诺');
    expect(out).toContain('性别：男');          // 未提及 → 保留
    expect(out).toContain('年龄：17');          // 同名 → 新值覆盖
    expect(out).not.toContain('年龄：16');
    expect(out).toContain('性格：沉默寡言');     // 保留
    expect(out).toContain('背景：边境村出身');   // 保留
    expect(out).toContain('关系：与主角（同门师兄）'); // 新字段追加
  });

  it('散文：新段追加且去重，不整体覆盖', () => {
        const out = mergeEntryContent('主角的武器是铁剑。', '铁剑已经断了。');
    expect(out).toContain('主角的武器是铁剑。');
    expect(out).toContain('铁剑已经断了。');
    // 已包含 → 不重复追加
    const out2 = mergeEntryContent('他沉默寡言。', '沉默寡言');
    expect(out2).toBe('他沉默寡言。');
  });

  it('旧内容为空 → 直接用新内容；新内容为空 → 保留旧内容', () => {
        expect(mergeEntryContent('', '新内容')).toBe('新内容');
    expect(mergeEntryContent('旧内容', '')).toBe('旧内容');
  });
});
