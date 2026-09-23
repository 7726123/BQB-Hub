import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';

import { WorldBookManager as WBM } from '../src/domain/worldbook';

describe('WorldBookManager', () => {
  beforeEach(() => {
    (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager.remove('worldBooks');
    (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager.remove('activeWorldBookId');
  });

  it('createBook 建立完整默认结构并激活', () => {
    const wb = WBM.createBook('测试书');
    expect(wb.name).toBe('测试书');
    expect(wb.title).toBe('测试书');
    expect(wb.chapters).toHaveLength(1);
    expect(wb.entries).toEqual([]);
    expect(WBM.getActiveId()).toBe(wb.id);
    expect(WBM.getAll()).toHaveLength(1);
  });

  it('getNovelData 惰性初始化旧书的 chapters/title', () => {
    // 构造旧格式书（无 chapters、只有 name）
    const id = 'wb_legacy_1';
    (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass })
      .StorageManager.set('worldBooks', [{ id, name: '旧书', entries: [] }]);
    WBM.setActiveId(id);
    const wb = WBM.getNovelData();
    expect(wb?.chapters).toHaveLength(1);
    expect(wb?.title).toBe('旧书');
    // 惰性初始化已持久化
    expect(WBM.getAll()[0].chapters).toHaveLength(1);
  });

  it('addEntry 默认注入；「初始」不参与常规注入（ADR-0001）', () => {
    const wb = WBM.createBook();
    const normal = WBM.addEntry(wb.id, { type: '角色', name: '夏洛', content: '设定' });
    expect(normal?.inject).toBe(true);
    const off = WBM.addEntry(wb.id, { type: '角色', name: 'x', content: 'x', inject: false });
    expect(off?.inject).toBe(false);
    const initial = WBM.addEntry(wb.id, { type: '初始', name: '初始', content: '内容' });

    const relevant = WBM.filterRelevantEntries();
    expect(relevant.some((e) => e.id === normal?.id)).toBe(true);
    expect(relevant.some((e) => e.id === off?.id)).toBe(false);
    expect(relevant.some((e) => e.id === initial?.id)).toBe(false);
  });

  it('toggleEntryInject 与 setCover', () => {
    const wb = WBM.createBook();
    const e = WBM.addEntry(wb.id, { name: 'a' })!;
    WBM.toggleEntryInject(e.id, false);
    expect(WBM.getActive()?.entries[0].inject).toBe(false);
    WBM.setCover(wb.id, 'data:image/jpeg;base64,xxx');
    expect(WBM.getActive()?.cover).toBe('data:image/jpeg;base64,xxx');
  });

  it('migrateEntryTypes 将非白名单类型归为「其他」（幂等）', () => {
    const wb = WBM.createBook();
    WBM.addEntry(wb.id, { type: '事件', name: 'x' });
    WBM.addEntry(wb.id, { type: '地点', name: 'y' });
    WBM.addEntry(wb.id, { type: '角色', name: 'z' });
    expect(WBM.migrateEntryTypes()).toBe(true);
    const types = WBM.getActive()?.entries.map((e) => e.type);
    expect(types).toEqual(['其他', '其他', '角色']);
    expect(WBM.migrateEntryTypes()).toBe(false); // 幂等
  });

  it('deleteBook 最后一本时自动补默认书', () => {
    (globalThis as unknown as { App: unknown }).App = { toast: () => {}, loadEditorContent: () => {} };
    const wb = WBM.createBook('唯一');
    WBM.deleteBook(wb.id);
    expect(WBM.getAll()).toHaveLength(1);
    expect(WBM.getAll()[0].name).toBe('默认世界书');
  });
});
describe('开头条目类型已废弃（v1.5.81）', () => {
  const SMx = () => (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;

  it('removeOpeningEntries：删掉开头条目并备份内容；其余条目与顺序不变', () => {
    SMx().remove('removedOpeningEntriesBackup');
    WBM.saveAll([{
      id: 'wbx', name: '书', entries: [
        { id: 'a', type: '世界观', name: '世界背景', content: 'X' },
        { id: 'b', type: '开头', name: '开场A', content: '第一句话' },
        { id: 'c', type: '角色', name: '苏黎', content: 'Y' },
        { id: 'd', type: '开头', name: '开场B', content: '第二句话' },
      ],
    }] as never);
    const removed = WBM.removeOpeningEntries();
    expect(removed).toBe(2);
    const entries = WBM.getAll()[0].entries;
    expect(entries.map(e => e.id)).toEqual(['a', 'c']);
    const backup = SMx().get<Record<string, unknown[]>>('removedOpeningEntriesBackup', {}) || {};
    expect((backup['wbx'] || []).length).toBe(2);   // 内容可找回
    WBM.removeOpeningEntries();                     // 幂等：再跑一次没得删
    expect(WBM.getAll()[0].entries.map(e => e.id)).toEqual(['a', 'c']);
  });

  it('migrateEntryTypes：旧类型归「其他」，不再保留「开头」', () => {
    WBM.saveAll([{ id: 'wby', name: '书', entries: [
      { id: 'x', type: '地点', name: '灰港', content: 'Z' },
    ] }] as never);
    WBM.migrateEntryTypes();
    expect(WBM.getAll()[0].entries[0].type).toBe('其他');
  });

  it('常规注入跳过「初始」（它由写作端在正文为空时单独注入）', () => {
    WBM.saveAll([{ id: 'wbz', name: '书', entries: [
      { id: 'p', type: '世界观', name: 'A', content: '1' },
      { id: 'q', type: '初始', name: '开局', content: '2' },
    ] }] as never);
    WBM.setActiveId('wbz');
    expect(WBM.filterRelevantEntries().map(e => e.id)).toEqual(['p']);
  });
});
