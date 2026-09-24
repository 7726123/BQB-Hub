// SettingSyncManager：临时世界书（overlay）+ 待裁决表的存储与落盘引擎——**只服务比奇**。
// 「Agent 设定同步」插件（自动 delta 块 + 攒批二审）已删除（用户要求只留比奇），
// 所以这里只测保留下来的部分：按书/按模式隔离、合并视图、待裁决与 applyApproved 落盘语义、
// mergeEntryContent、resetAll；以及"没有比奇时不生效"。
import { beforeEach, describe, it, expect } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import { PluginManager } from '../src/domain/plugins'; // P3-A：plugins 不再挂全局，直接 import 真实实例
import { SettingSyncManager, mergeEntryContent } from '../src/domain/settingsync';

const SM = () => (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;
import { WorldBookManager as WBM } from '../src/domain/worldbook';
const PM = PluginManager;

function resetAll() {
  SM().remove('worldBooks');
  SM().remove('activeWorldBookId');
  SM().remove('localPlugins');
  SM().remove('pluginEnabled:biqi');
  SM().remove('pluginEnabled:agent-setting-sync');
  SM().remove('pluginEnabled:agent-sync');
  // 按书隔离键：测试书 id 未知时先清 none 分桶
  for (const k of ['settingDeltaPending_none', 'settingOverlay_none', 'settingDeltaLog_none', 'settingOverlaySnaps_none']) {
    SM().remove(k);
  }
}

function seedBook() {
  const wb = WBM.createBook('测试书');
  WBM.addEntry(wb.id, { type: '世界观', name: '铁剑', content: '主角的武器是铁剑。' });
  WBM.addEntry(wb.id, { type: '角色', name: '阿诺', content: '沉默的剑士。' });
  // 清掉新建书产生的隔离键（createBook 后 activeId 已确定，重清一次保证干净）
  for (const k of ['settingDeltaPending_' + wb.id, 'settingOverlay_' + wb.id, 'settingDeltaLog_' + wb.id, 'settingOverlaySnaps_' + wb.id]) {
    SM().remove(k);
  }
  return wb;
}

// 启用内置插件「比奇」：临时世界书现在只由比奇维护，门控就是"比奇开着吗"。
function installAgent() {
  PM.setEnabled('biqi', true);
}

beforeEach(resetAll);

describe('SettingSyncManager 门控与合并视图', () => {
  it('没开比奇时 isEnabled 为 false（临时世界书不参与）', () => {
    seedBook();
    expect(SettingSyncManager.isEnabled()).toBe(false);
    expect(SettingSyncManager.isActive()).toBe(false);
  });

  it('开了比奇后 isEnabled/isActive 为 true，关掉回落', () => {
    seedBook();
    installAgent();
    expect(SettingSyncManager.isEnabled()).toBe(true);
    expect(SettingSyncManager.isActive()).toBe(true);
    PM.setEnabled('biqi', false);
    expect(SettingSyncManager.isEnabled()).toBe(false);
  });

  it('启用后 isEnabled 为 true，关闭后回落', () => {
    seedBook();
    installAgent();
    expect(SettingSyncManager.isEnabled()).toBe(true);
    PM.setEnabled('biqi', false);
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

describe('SettingSyncManager 重置（resetBook 联动语义）', () => {
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
    expect(SettingSyncManager.getSnapshots()).toEqual([]);
    expect(JSON.stringify(WBM.getActive()!.entries)).toBe(before);
  });
});

describe('SettingSyncManager 二审契约', () => {

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
