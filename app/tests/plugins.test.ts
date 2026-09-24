import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { PluginManager, type PluginManifest } from '../src/domain/plugins';

const SM = () => (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;

function resetPlugins() {
  SM().remove('localPlugins');
  SM().remove('pluginEnabled:db-classic-tables');
  SM().remove('pluginEnabled:biqi');
  SM().remove('pluginEnabled:agent-setting-sync');
  SM().remove('pluginEnabled:db-legacy-third-party');
}

beforeEach(resetPlugins);

describe('PluginManager（全部内置，无安装入口）', () => {
  it('内置插件常驻：数据库模板 + 比奇，均带 builtin 标记', () => {
    const all = PluginManager.getAll();
    expect(all.map(p => p.id)).toEqual(['db-classic-tables', 'biqi']);
    expect(all.every(p => p.builtin === true)).toBe(true);
    const db = PluginManager.get('db-classic-tables')!;
    expect(db.type).toBe('database');
    expect(db.data.tables.map((t: any) => t.name)).toEqual(['剧情摘要', '角色档案', '物品追踪', '世界设定']);
    const biqi = PluginManager.get('biqi')!;
    expect(biqi.type).toBe('widget');
    expect(biqi.shell).toBe('biqi');
    expect(biqi.name).toBe('比奇');
  });

  it('默认全部关闭；开关只记录状态，不写入插件清单', () => {
    expect(PluginManager.getActiveDatabasePlugin()).toBeNull();
    expect(PluginManager.getActiveWidgetPlugin('biqi')).toBeNull();
    PluginManager.setEnabled('db-classic-tables', true);
    expect(PluginManager.getActiveDatabasePlugin()!.id).toBe('db-classic-tables');
    PluginManager.setEnabled('biqi', true);
    expect(PluginManager.getActiveWidgetPlugin('biqi')!.id).toBe('biqi');
    // 悬浮球插件已不再内置：任何 shell='option-ball' 都取不到
    expect(PluginManager.getActiveWidgetPlugin('option-ball')).toBeNull();
  });

  // 互斥组随「Agent 设定同步」一起下线：现在只有比奇维护临时世界书，不再有互相顶掉的对象
  it('只剩比奇一个 widget 插件：开关互不影响，setEnabled 恒返回 null', () => {
    expect(PluginManager.setEnabled('biqi', true)).toBeNull();
    expect(PluginManager.isEnabled('biqi')).toBe(true);
    expect(PluginManager.getActiveWidgetPlugin('biqi')!.id).toBe('biqi');
    expect(PluginManager.getActiveWidgetPlugin('agent')).toBeNull();   // shell='agent' 已不存在
    expect(PluginManager.setEnabled('biqi', false)).toBeNull();
  });

  it('内置插件不可删除（uninstall 拒绝）', () => {
    expect(PluginManager.uninstall('db-classic-tables')).toBe(false);
    expect(PluginManager.uninstall('biqi')).toBe(false);
    expect(PluginManager.get('db-classic-tables')).not.toBeNull();
  });

  it('存储里遗留的第三方条目仍可读取与删除；id 与内置相同则内置优先', () => {
    const legacy: Partial<PluginManifest> = {
      id: 'db-legacy-third-party', name: '旧社区模板', version: '0.9.0', type: 'database',
      data: { tables: [{ id: 't1', name: '旧表', columns: ['A'] }] },
    };
    SM().set('localPlugins', [legacy, { id: 'db-classic-tables', name: '重复的内置 id', version: '0.1.0', type: 'database', data: {} }]);
    const all = PluginManager.getAll();
    expect(all.map(p => p.id)).toEqual(['db-classic-tables', 'biqi', 'db-legacy-third-party']);
    expect(all.filter(p => p.builtin).length).toBe(2);
    // 重复 id 以内置为准
    expect(PluginManager.get('db-classic-tables')!.name).toBe('经典记忆数据库');
    expect(PluginManager.uninstall('db-legacy-third-party')).toBe(true);
    expect(PluginManager.get('db-legacy-third-party')).toBeNull();
  });
});

// 老用户存储里可能还留着已下线插件的条目/开关（插件页会渲染成一张带「删除」按钮的卡片）：
// 启动时静默清掉，用户不用自己点删除。
describe('已下线插件的自动清理（cleanupRemoved）', () => {
  it('清掉 agent-setting-sync 的条目与开关，保留其它第三方条目', () => {
    SM().set('localPlugins', [
      { id: 'agent-setting-sync', name: 'Agent 设定同步', version: '1.0.0', type: 'widget', shell: 'agent' },
      { id: 'db-legacy-third-party', name: '旧社区模板', version: '0.9.0', type: 'database', data: {} },
    ]);
    SM().set('pluginEnabled:agent-setting-sync', true);
    const removed = PluginManager.cleanupRemoved();
    expect(removed).toContain('agent-setting-sync');
    // 开关键彻底移除（不是写成 false 留在存储里）
    expect(SM().get('pluginEnabled:agent-setting-sync', null)).toBeNull();
    expect((SM().get<any[]>('localPlugins', []) || []).map(p => p.id)).toEqual(['db-legacy-third-party']);
    // 开关值本身读出来也回到默认关闭
    expect(PluginManager.isEnabled('agent-setting-sync')).toBe(false);
  });

  it('shell=agent 的第三方 widget 一并清掉（引擎已不认识这个壳，卡片点不开）', () => {
    SM().set('localPlugins', [
      { id: 'some-agent-widget', name: '某临时设定插件', version: '1.0.0', type: 'widget', shell: 'agent' },
      { id: 'db-legacy-third-party', name: '旧社区模板', version: '0.9.0', type: 'database', data: {} },
    ]);
    const removed = PluginManager.cleanupRemoved();
    expect(removed).toContain('some-agent-widget');
    expect((SM().get<any[]>('localPlugins', []) || []).map(p => p.id)).toEqual(['db-legacy-third-party']);
  });

  it('干净时零写入、可重复跑（不凭空建 localPlugins 键、不动内置与合法第三方）', () => {
    SM().remove('localPlugins');
    expect(PluginManager.cleanupRemoved()).toEqual([]);
    expect(SM().get('localPlugins', null)).toBeNull();
    SM().set('localPlugins', [{ id: 'db-legacy-third-party', name: '旧社区模板', version: '0.9.0', type: 'database', data: {} }]);
    expect(PluginManager.cleanupRemoved()).toEqual([]);
    expect(PluginManager.cleanupRemoved()).toEqual([]);
    expect((SM().get<any[]>('localPlugins', []) || []).length).toBe(1);
    expect(PluginManager.getAll().map(p => p.id)).toEqual(['db-classic-tables', 'biqi', 'db-legacy-third-party']);
  });

  it('getAll 兜底：即便清理没跑到（存储被旧备份覆盖），也不列出已下线的卡片', () => {
    SM().set('localPlugins', [
      { id: 'agent-setting-sync', name: 'Agent 设定同步', version: '1.0.0', type: 'widget', shell: 'agent' },
      { id: 'some-agent-widget', name: '某临时设定插件', version: '1.0.0', type: 'widget', shell: 'agent' },
    ]);
    expect(PluginManager.getAll().map(p => p.id)).toEqual(['db-classic-tables', 'biqi']);
    expect(PluginManager.get('agent-setting-sync')).toBeNull();
  });
});
