import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { PluginManager, type PluginManifest } from '../src/domain/plugins';

const SM = () => (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;

function resetPlugins() {
  SM().remove('localPlugins');
  SM().remove('pluginEnabled:db-classic-tables');
  SM().remove('pluginEnabled:agent-setting-sync');
  SM().remove('pluginEnabled:biqi');
  SM().remove('pluginEnabled:db-legacy-third-party');
}

beforeEach(resetPlugins);

describe('PluginManager（全部内置，无安装入口）', () => {
  it('内置插件常驻：数据库模板 + Agent 设定同步 + 比奇，均带 builtin 标记', () => {
    const all = PluginManager.getAll();
    expect(all.map(p => p.id)).toEqual(['db-classic-tables', 'agent-setting-sync', 'biqi']);
    expect(all.every(p => p.builtin === true)).toBe(true);
    const db = PluginManager.get('db-classic-tables')!;
    expect(db.type).toBe('database');
    expect(db.data.tables.map((t: any) => t.name)).toEqual(['剧情摘要', '角色档案', '物品追踪', '世界设定']);
    const agent = PluginManager.get('agent-setting-sync')!;
    expect(agent.type).toBe('widget');
    expect(agent.shell).toBe('agent');
    const biqi = PluginManager.get('biqi')!;
    expect(biqi.type).toBe('widget');
    expect(biqi.shell).toBe('biqi');
    expect(biqi.name).toBe('比奇');
  });

  it('默认全部关闭；开关只记录状态，不写入插件清单', () => {
    expect(PluginManager.getActiveDatabasePlugin()).toBeNull();
    expect(PluginManager.getActiveWidgetPlugin('agent')).toBeNull();
    PluginManager.setEnabled('db-classic-tables', true);
    expect(PluginManager.getActiveDatabasePlugin()!.id).toBe('db-classic-tables');
    PluginManager.setEnabled('agent-setting-sync', true);
    expect(PluginManager.getActiveWidgetPlugin('agent')!.id).toBe('agent-setting-sync');
    // 悬浮球插件已不再内置：任何 shell='option-ball' 都取不到
    expect(PluginManager.getActiveWidgetPlugin('option-ball')).toBeNull();
  });

  // 互斥：比奇与 Agent 设定同步写同一份临时世界书 overlay，同时开启会互相覆盖
  it('互斥：开启一方自动关闭另一方（返回值 = 被顶掉的名字）', () => {
    expect(PluginManager.setEnabled('agent-setting-sync', true)).toBeNull();
    expect(PluginManager.isEnabled('agent-setting-sync')).toBe(true);
    const bumped = PluginManager.setEnabled('biqi', true);
    expect(bumped).toBe('Agent 设定同步');
    expect(PluginManager.isEnabled('biqi')).toBe(true);
    expect(PluginManager.isEnabled('agent-setting-sync')).toBe(false);
    // 反向亦然
    expect(PluginManager.setEnabled('agent-setting-sync', true)).toBe('比奇');
    expect(PluginManager.isEnabled('agent-setting-sync')).toBe(true);
    expect(PluginManager.isEnabled('biqi')).toBe(false);
    // 关闭不触发互斥
    expect(PluginManager.setEnabled('agent-setting-sync', false)).toBeNull();
  });

  it('内置插件不可删除（uninstall 拒绝）', () => {
    expect(PluginManager.uninstall('db-classic-tables')).toBe(false);
    expect(PluginManager.uninstall('agent-setting-sync')).toBe(false);
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
    expect(all.map(p => p.id)).toEqual(['db-classic-tables', 'agent-setting-sync', 'biqi', 'db-legacy-third-party']);
    expect(all.filter(p => p.builtin).length).toBe(3);
    // 重复 id 以内置为准
    expect(PluginManager.get('db-classic-tables')!.name).toBe('经典记忆数据库');
    expect(PluginManager.uninstall('db-legacy-third-party')).toBe(true);
    expect(PluginManager.get('db-legacy-third-party')).toBeNull();
  });
});
