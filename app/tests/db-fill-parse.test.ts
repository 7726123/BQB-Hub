// 记忆数据库「填表结果解析/写库」的回归测试。
// 背景（2026-09-22 用户报「数据库插件根本用不了 / 续写后没更新 / 手动点了很久也只说无更新」）：
// 这条链路的失败只写 console.warn（手机看不到）+ 提示语把几种完全不同的原因都说成「无更新」，
// 于是故障无从定位。实测发现三个能静默吃掉整次填表的坑，这里逐条护栏：
//   ① markdown 二级标题（## 角色档案）此前不匹配表名标题 → 整段被丢 → 白跑两次请求；
//   ② 主键是占位词（[未知]/[无]）的行会被 upsertRecord 拒收 → 解析出 N 行却 0 更新；
//   ③ 解析成功但写库前被「代际检查」丢弃时，状态留空 → 界面说「无更新」（app 侧已改为只有撤回才作废）。
// 注：database.ts / app.ts 均以 ES import 取 PluginManager，全局桩无效，必须 patch 真实模块对象。
import { describe, it, expect } from 'vitest';
import '../src/infra/storage';
import '../src/domain/app';
import { DatabaseManager as DBM } from '../src/domain/database';
import { PluginManager as PM } from '../src/domain/plugins';

const g = globalThis as unknown as Record<string, any>;
const App = () => g.App as any;
const DB = DBM as unknown as Record<string, any>;

const DB_PLUGIN = {
  id: 'db-classic-tables', name: '经典记忆数据库', version: '1.0.0', type: 'database',
  data: {
    tables: [
      { id: 'plot_summary', name: '剧情摘要', columns: ['#主线摘要', '#支线摘要'] },
      { id: 'character_profile', name: '角色档案', columns: ['角色名', '年龄', '性别', '身份', '性格', '当前位置', '周围角色', '生理', '人际关系', '着装', '待办事项', '约定'] },
      { id: 'item_tracking', name: '物品追踪', columns: ['物品名称', '物品描述', '物品位置', '持有者', '状态', '备注'] },
      { id: 'world_setting', name: '世界设定', columns: ['设定名', '类型', '详细说明', '影响范围'] },
    ],
  },
};
(PM as unknown as Record<string, any>).getActiveDatabasePlugin = () => DB_PLUGIN;
(PM as unknown as Record<string, any>).getEnabledByType = (t: string) => (t === 'database' ? [DB_PLUGIN] : []);
g.BookManager = { getActive: () => ({ id: 'bk1' }) };

function parseAndApply(output: string) {
  DB.clear();
  const parsed = App()._parseDBFillResult(output);
  const applied = App()._applyDBFillResult(parsed);
  return { parsed, applied, skipped: App()._dbFillSkipped, records: DB.getDB().records };
}

describe('记忆数据库填表：解析与写库', () => {
  it('提示词里的标准格式 → 解析出行并真的写进对应表', () => {
    const r = parseAndApply('<Memory>\n#角色档案\n[林晚]|年龄：23|性别：女|身份：编辑|当前位置：城东·公寓\n#物品追踪\n[旧怀表]|物品描述：银色|持有者：林晚\n</Memory>');
    expect(r.parsed.length).toBe(2);
    expect(r.applied).toBe(2);
    expect(r.skipped).toBe(0);
    expect(r.records.character_profile.length).toBe(1);
    expect(r.records.character_profile[0].values['角色名']).toBe('林晚');
    expect(r.records.item_tracking.length).toBe(1);
  });

  it('markdown 二级标题（## 角色档案）也能认——此前整段被静默丢弃', () => {
    const r = parseAndApply('<Memory>\n## 角色档案\n[林晚]|年龄：23|性别：女\n</Memory>');
    expect(r.parsed.length).toBe(1);
    expect(r.applied).toBe(1);
  });

  it('三级标题（### 小标题）不重置当前表，避免把后续行误判成新表', () => {
    const r = parseAndApply('<Memory>\n#角色档案\n### 备注\n[林晚]|年龄：23\n</Memory>');
    expect(r.parsed.length).toBe(1);
    expect(r.applied).toBe(1);
  });

  it('主键是占位词的行被跳过并计数（不再只剩一句「无更新」）', () => {
    const r = parseAndApply('<Memory>\n#角色档案\n[未知]|年龄：23\n[无]|性别：女\n</Memory>');
    expect(r.parsed.length).toBe(2);
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(2); // 界面据此提示"识别到 2 行但主键为空被跳过"
  });

  it('表名简称/带后缀仍能匹配（模糊兜底没被破坏）', () => {
    // 模糊兜底是"包含关系"：物品 ⊂ 物品追踪、角色档案（人物）⊃ 角色档案；「人物」这类对不上的简称仍会失败（设计如此）
    const a = parseAndApply('<Memory>\n#物品\n[旧怀表]|持有者：林晚\n</Memory>');
    expect(a.applied).toBe(1);
    const b = parseAndApply('<Memory>\n#角色档案（人物）\n[林晚]|年龄：23\n</Memory>');
    expect(b.applied).toBe(1);
  });

  it('剧情摘要行计入更新数（走 appendPlotLine）', () => {
    const r = parseAndApply('<Memory>\n#剧情摘要\n主线摘要：[3月5日] 林晚去了城东。\n</Memory>');
    expect(r.applied).toBe(1);
    expect(String(r.records.plot_summary[0].values['主线摘要'])).toContain('林晚去了城东');
  });

  it('完全对不上格式的输出 → 解析 0 行（走「失败」分支，不再是谎报的「无更新」）', () => {
    const r = parseAndApply('<Memory>\n{"table":"角色","changes":[{"姓名":"林晚"}]}\n</Memory>');
    expect(r.parsed.length).toBe(0);
    expect(r.applied).toBe(0);
  });
});

// 剧情摘要「内容换行写在冒号之后」——用户报「只有一个未命名且内容为空的摘要、其他都没有」的直接原因：
// 这行被解析成空文本，写库函数因空文本什么都没写，却仍被计为一次更新（提示说更新了、库里是空的，
// 而且因为计数 > 0 连诊断都不上报）。
describe('剧情摘要：换行内容与空/重复行的计数', () => {
  it('「主线摘要：」后换行写内容 → 内容真的写进摘要，且计为 1 次写入', () => {
    const r = parseAndApply('<Memory>\n#剧情摘要\n主线摘要：\n[3月5日] 林晚去了城东。\n</Memory>');
    expect(r.parsed.length).toBe(1);
    expect(r.applied).toBe(1);
    expect(String(r.records.plot_summary[0].values['主线摘要'])).toContain('林晚去了城东');
  });

  it('多行内容拼成一条；切到下一张表前先把待收摘要落地', () => {
    const r = parseAndApply('<Memory>\n#剧情摘要\n主线摘要：\n[3月5日] 林晚去了城东。\n[3月6日] 沈夜来访。\n#角色档案\n[林晚]|年龄：23\n</Memory>');
    expect(r.applied).toBe(2);
    const s = String(r.records.plot_summary[0].values['主线摘要']);
    expect(s).toContain('林晚去了城东');
    expect(s).toContain('沈夜来访');
    expect(r.records.character_profile.length).toBe(1);
  });

  it('只有空摘要标签（冒号后无内容、后续也没内容）→ 不产生行，不再谎报"更新了"', () => {
    const r = parseAndApply('<Memory>\n#剧情摘要\n主线摘要：\n</Memory>');
    expect(r.parsed.length).toBe(0); // 不再造出一条空文本的摘要行
    expect(r.applied).toBe(0);
    expect(r.skipped).toBe(0);
  });

  it('与已有内容完全重复的摘要不重复写入、也不算更新（幂等追加）', () => {
    DB.clear();
    const first = App()._parseDBFillResult('<Memory>\n#剧情摘要\n主线摘要：[3月5日] 林晚去了城东。\n</Memory>');
    expect(App()._applyDBFillResult(first)).toBe(1);
    const second = App()._parseDBFillResult('<Memory>\n#剧情摘要\n主线摘要：[3月5日] 林晚去了城东。\n</Memory>');
    expect(App()._applyDBFillResult(second)).toBe(0); // 重复 → 没有新写入
    expect(App()._dbFillSkipped).toBe(1);
  });
});

// 代际语义（本次主修复）：填表结果只在「撤回」时作废。
// 旧行为：generate() 也自增 _dbEpoch → 填表请求还在飞的时候用户继续续写，结果就被丢掉，
// 而界面只说「无更新」——这是用户报"续写后根本没有更新"的主因。
describe('记忆数据库填表：作废语义', () => {
  const MEM = '<Memory>\n#角色档案\n[林晚]|年龄：23\n</Memory>';

  function primeFill(onFetch: (done: (t: string) => void) => void) {
    DB.clear();
    g.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'sk-test', model: 'm' }) };
    g.APIHandler = { fetchCompletions: (_m: any, _c: any, onDone: any) => onFetch(onDone) };
  }

  it('真实表结构下的快乐路径：解析出行 → 写进角色档案（此前该用例只有 stub 表、恒为 0）', async () => {
    primeFill((done) => setTimeout(() => done(MEM), 0));
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(1);
    expect(App()._dbFillStatus).toBe('ok');
    expect((DB.getDB().records.character_profile || []).length).toBe(1);
    // 注：「填表期间又续写了一轮不作废」不再用模拟自增来测——generate() 侧已不再自增 _dbEpoch
    // （见字段注释），撤销自增点只剩 undoLastGeneration，所以这里只需保证不动它时结果必落地。
  });

  it('填表期间发生撤回 → 结果作废并明确说明（不再是「无更新」）', async () => {
    primeFill((done) => {
      App()._dbEpoch = (App()._dbEpoch || 0) + 1; // 撤回会自增
      setTimeout(() => done(MEM), 0);
    });
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(0);
    expect(App()._dbFillStatus).toBe('undone');
    expect((DB.getDB().records.character_profile || []).length).toBe(0);
  });

  it('没有可用 API Key → 状态 nokey（不再说成「正文太少」）', async () => {
    DB.clear();
    g.PresetManager = { getActiveAPIConfig: () => ({ endpoint: '', apiKey: '', model: '' }) };
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(0);
    expect(App()._dbFillStatus).toBe('nokey');
  });
});
