import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/book';
import '../src/domain/database';

// 数据库模板来自内置插件「经典记忆数据库」（四表定义见 src/domain/plugins.ts BUILTIN_PLUGINS），
// 这里只需把内置项打开——database.ts 经 import 使用真实 PluginManager。
(function () {
  const s = (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;
  s.set('pluginEnabled:db-classic-tables', true);
})();

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { DatabaseManager as DB } from '../src/domain/database';

describe('DatabaseManager 记忆表格', () => {
  beforeEach(() => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    sm().remove('memoryTableDB'); sm().remove('memoryTableEnabled'); sm().remove('memoryTableSettings');
    WBM.createBook('书');
  });

  it('getDB 默认结构：四张表 + 激活表 + 剧情空记录惰性创建', () => {
    const db = DB.getDB();
    expect(db.version).toBe(1);
    expect(db.tables.map((t) => t.name)).toEqual(['剧情摘要', '角色档案', '物品追踪', '世界设定']);
    expect(db.activeTableId).toBe('character_profile');
    const plot = DB.ensurePlotRecord();
    expect(plot.id).toBe('rec_plot_main');
  });

  it('按书隔离：切书后各自独立', () => {
    DB.upsertRecord('character_profile', { '角色名': 'A', '年龄': '17' });
    WBM.createBook('书2');
    expect(DB.getRecords('character_profile')).toHaveLength(0);
    WBM.setActiveId(WBM.getAll()[0].id);
    expect(DB.getRecords('character_profile')).toHaveLength(1);
  });

  it('upsertRecord：新建 + 普通列覆盖 + 追加列（#）按行拼接去重', () => {
    DB.upsertRecord('character_profile', { '角色名': '夏洛', '年龄': '16', '性格': '傲娇' });
    DB.upsertRecord('character_profile', { '角色名': '夏洛', '年龄': '17', '性格': '傲娇', '当前位置': '教室' });
    const recs = DB.getRecords('character_profile');
    expect(recs).toHaveLength(1); // 同主键合并
    expect(recs[0].values['年龄']).toBe('17'); // 覆盖
    // 追加列：plot_summary 的 #主线摘要
    DB.appendPlotLine('主线摘要', '[3月1日] 事件A');
    DB.appendPlotLine('主线摘要', '[3月2日] 事件B');
    DB.appendPlotLine('主线摘要', '[3月2日] 事件B'); // 重复行跳过
    const plot = DB.ensurePlotRecord();
    const lines = plot.values['主线摘要'].split('\n');
    expect(lines).toHaveLength(2);
  });

  it('别名合并：「A|B」与后续「B」视为同一记录并并回主键', () => {
    DB.upsertRecord('character_profile', { '角色名': '小雪|雪酱', '年龄': '16' });
    DB.upsertRecord('character_profile', { '角色名': '雪酱', '当前位置': '天台' });
    const recs = DB.getRecords('character_profile');
    expect(recs).toHaveLength(1);
    expect(recs[0].values['角色名']).toBe('小雪|雪酱'); // 第一段保持主名
    expect(recs[0].values['当前位置']).toBe('天台');
  });

  it('追加列末行去重：同值不重复拼接', () => {
    // world_setting 无追加列，用 plot_summary 测试
    DB.appendPlotLine('支线摘要', '事件X');
    DB.appendPlotLine('支线摘要', '事件X');
    expect(DB.ensurePlotRecord().values['支线摘要'].split('\n')).toEqual(['事件X']);
  });

  it('appendPlotLine 日期感知排序 + 滚动窗口裁剪', () => {
    DB.appendPlotLine('主线摘要', '[2021年5月2日] 后来的事');
    DB.appendPlotLine('主线摘要', '[2021年5月1日] 先前的事');
    DB.appendPlotLine('主线摘要', '没有日期的一行');
    const lines = DB.ensurePlotRecord().values['主线摘要'].split('\n');
    expect(lines[0]).toContain('5月1日');
    expect(lines[1]).toContain('5月2日');
    expect(lines[2]).toBe('没有日期的一行'); // 无日期垫底

    // 滚动窗口
    for (let i = 0; i < DB.PLOT_MAX_LINES + 10; i++) {
      DB.appendPlotLine('主线摘要', `[2021年5月3日] 事件${i}号`);
    }
    const final = DB.ensurePlotRecord().values['主线摘要'].split('\n');
    expect(final.length).toBeLessThanOrEqual(DB.PLOT_MAX_LINES);
  });

  it('updateRecord 手动编辑覆盖；deleteRecord 删除', () => {
    const rec = DB.upsertRecord('item_tracking', { '物品名称': '青铜钥匙', '物品位置': '腰间' })!;
    expect(DB.updateRecord('item_tracking', rec.id, { '物品位置': '口袋' })).toBe(true);
    expect(DB.getRecords('item_tracking')[0].values['物品位置']).toBe('口袋');
    DB.deleteRecord('item_tracking', rec.id);
    expect(DB.getRecords('item_tracking')).toHaveLength(0);
  });

  it('getTableDump 全表导出格式', () => {
    DB.upsertRecord('character_profile', { '角色名': '夏洛', '年龄': '16' });
    const dump = DB.getTableDump();
    expect(dump).toContain('#角色档案');
    expect(dump).toContain('[夏洛]|年龄：16');
    expect(dump).toContain('#物品追踪');
    expect(dump).toContain('（暂无记录）');
  });

  it('填表 API 配置：custom 模式且配置完整才启用', () => {
    expect(DB.getApiConfig()).toBeNull(); // 默认 main
    DB.saveSettings({ mode: 'custom', endpoint: '', apiKey: '', model: '' });
    expect(DB.getApiConfig()).toBeNull();
    DB.saveSettings({ mode: 'custom', endpoint: 'https://x/v1', apiKey: 'k', model: 'm2' });
    expect(DB.getApiConfig()).toEqual({ endpoint: 'https://x/v1', apiKey: 'k', model: 'm2' });
  });

  it('clear 清空当前书', () => {
    DB.upsertRecord('world_setting', { '设定名': '魔法体系' });
    DB.clear();
    expect(DB.getRecords('world_setting')).toHaveLength(0);
  });
});