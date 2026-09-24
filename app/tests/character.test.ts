import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/protagonist';
import '../src/domain/character';
import '../src/domain/book';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
import { ProtagonistManager as PM } from '../src/domain/protagonist';
import { CharacterManager as CM } from '../src/domain/character';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

describe('ProtagonistManager', () => {
  beforeEach(() => {
    sm().remove('protagonists'); sm().remove('activeProtagonistId');
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
  });

  it('create 自动激活首个主角；getAll/getActive', () => {
    const p1 = PM.create({ name: '叶山', description: '主角' });
    expect(PM.getActiveId()).toBe(p1.id);
    PM.create({ name: '第二主角' });
    expect(PM.getActive()?.id).toBe(p1.id); // 不改激活
    expect(PM.getAll()).toHaveLength(2);
  });

  it('update 保留 id/createdAt，description 截断 150', () => {
    const p = PM.create({ name: 'a' });
    PM.update(p.id, { id: 'hack', createdAt: 0, description: 'x'.repeat(200) });
    const after = PM.getAll().find((x) => x.id === p.id)!;
    expect(after.id).toBe(p.id);
    expect(after.createdAt).toBe(p.createdAt);
    expect(after.description!.length).toBe(150);
  });

  it('delete 后激活转移到剩余第一个', () => {
    const p1 = PM.create({ name: '一' });
    const p2 = PM.create({ name: '二' });
    PM.setActiveId(p1.id);
    PM.delete(p1.id);
    expect(PM.getActiveId()).toBe(p2.id);
    PM.delete(p2.id);
    expect(PM.getActiveId()).toBeNull();
  });

  it('migrateFromLegacy 迁移旧 protagonist 并移除旧键', () => {
    sm().set('protagonist', { name: '旧主角', description: 'legacy' });
    PM.migrateFromLegacy();
    expect(PM.getAll()).toHaveLength(1);
    expect(PM.getAll()[0].name).toBe('旧主角');
    expect(sm().get('protagonist', null)).toBeNull();
  });
});

describe('CharacterManager', () => {
  beforeEach(() => {
    sm().remove('characters');
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
  });

  it('create：age 去掉「岁」、description 截断、初始 state、绑定当前书', () => {
    WBM.createBook('书');
    const c = CM.create({ name: '夏洛', age: '16岁', description: 'y'.repeat(200) });
    expect(c.age).toBe('16');
    expect(c.description!.length).toBe(150);
    expect(c.wbId).toBe(WBM.getActiveId());
    expect(c.state).toMatchObject({ currentLocation: '', mood: '', lastSeen: null });
  });

  it('update 深合并 state（字段保留给以后 AI 维护用）', () => {
    WBM.createBook();
    const c = CM.create({ name: 'A' });
    CM.update(c.id, { state: { mood: '开心' } });
    const after = CM.getAll().find((x) => x.id === c.id)!;
    expect(after.state?.mood).toBe('开心');
    expect(after.state?.currentLocation).toBe(''); // 原字段保留
  });

  it('getByWorldBook：未绑定的（旧数据）与匹配的都返回', () => {
    WBM.createBook();
    CM.create({ name: '新角色' });
    expect(CM.getByWorldBook(WBM.getActiveId()!)).toHaveLength(1);
    // 手动塞一条旧数据（无 wbId）
    const all = CM.getAll(); all.push({ id: 'char_old', name: '旧', createdAt: 0 });
    sm().set('characters', all);
    expect(CM.getByWorldBook(WBM.getActiveId()!)).toHaveLength(2);
  });
});