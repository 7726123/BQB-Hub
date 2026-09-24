// 数据库按模式分开存（用户要求：数据库插件适配对话模式，同一本书能查看两个模式）。
// 小说模式沿用不带后缀的旧键（零迁移），对话模式用 `<bookId>_chat`——与临时世界书 overlay 同一套规则。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { PluginManager } from '../src/domain/plugins';
import { DatabaseManager as DB } from '../src/domain/database';

type SMType = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SMType }).StorageManager;

function seed() {
  sm().remove('worldBooks');
  sm().remove('activeWorldBookId');
  sm().remove('memoryTableDB');
  sm().remove('pluginEnabled:db-classic-tables');
  PluginManager.setEnabled('db-classic-tables', true);   // 没开数据库插件时没有表
  const wb = WBM.createBook('书甲');
  WBM.saveAll(WBM.getAll());
  WBM.setActiveId(wb.id);
  DB.setMode('novel');
  return wb;
}

beforeEach(seed);

describe('数据库：小说 / 对话各存一份', () => {
  it('同一本书两个模式互不干扰，键名只给对话模式加 _chat 后缀', () => {
    const wb = seed();
    DB.setMode('novel');
    DB.upsertRecord('character_profile', { '角色名': '林薇', '性格': '直接' });
    expect(DB.getRecords('character_profile')).toHaveLength(1);

    DB.setMode('chat');
    expect(DB.getRecords('character_profile')).toHaveLength(0);   // 对话那份还是空的
    DB.upsertRecord('character_profile', { '角色名': '陈默', '性格': '话少' });
    expect(DB.getRecords('character_profile').map(r => r.values['角色名'])).toEqual(['陈默']);

    DB.setMode('novel');
    expect(DB.getRecords('character_profile').map(r => r.values['角色名'])).toEqual(['林薇']);

    const all = sm().get<Record<string, any>>('memoryTableDB', {}) || {};
    expect(Object.keys(all).sort()).toEqual([wb.id, wb.id + '_chat'].sort());   // 小说键没有后缀（零迁移）
  });

  it('getTableDump 跟着作用域走（注入/填表上下文都用它）', () => {
    seed();
    DB.setMode('novel');
    DB.upsertRecord('character_profile', { '角色名': '林薇' });
    DB.setMode('chat');
    DB.upsertRecord('character_profile', { '角色名': '陈默' });
    expect(DB.getTableDump()).toContain('陈默');
    expect(DB.getTableDump()).not.toContain('林薇');
    DB.setMode('novel');
    expect(DB.getTableDump()).toContain('林薇');
    expect(DB.getTableDump()).not.toContain('陈默');
  });

  it('clear 只清当前模式那一份', () => {
    seed();
    DB.setMode('novel');
    DB.upsertRecord('character_profile', { '角色名': '林薇' });
    DB.setMode('chat');
    DB.upsertRecord('character_profile', { '角色名': '陈默' });
    DB.clear();
    expect(DB.getRecords('character_profile')).toHaveLength(0);
    DB.setMode('novel');
    expect(DB.getRecords('character_profile')).toHaveLength(1);
  });

  it('换书也按模式隔离（书 × 模式两维）', () => {
    const a = seed();
    DB.setMode('channel' as never); // 非法值回落 novel
    expect(DB.mode()).toBe('novel');
    DB.setMode('novel');
    DB.upsertRecord('character_profile', { '角色名': '甲书角色' });
    const b = WBM.createBook('书乙');
    WBM.saveAll(WBM.getAll());
    WBM.setActiveId(b.id);
    DB.setMode('novel');
    expect(DB.getRecords('character_profile')).toHaveLength(0);   // 乙书小说那份是空的
    expect(a.id).not.toBe(b.id);
    WBM.setActiveId(a.id);
    expect(DB.getRecords('character_profile')).toHaveLength(1);
  });
});
