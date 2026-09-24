// CharacterManager：登场角色 + 角色状态追踪（迁移自 www/modules/character.js）。
import { SM } from '../infra/gate';
import { WorldBookManager } from './worldbook';
import { BookManager } from './book';

export interface CharacterState {
  currentLocation?: string;
  mood?: string;
  knowledgeState?: unknown[];
  relationshipChanges?: Record<string, unknown>;
  lastSeen?: { timestamp: number } | null;
  unresolvedGoals?: unknown[];
  [k: string]: any;
}
export interface Character {
  id: string;
  name?: string;
  age?: string;
  description?: string;
  wbId?: string | null;
  createdAt: number;
  state?: CharacterState;
  [k: string]: any; // 动态字段（gender/relation/alias/occupation…）由消费方宽松读写
}

export const CharacterManager = {
  getAll(): Character[] { return SM().get<Character[]>('characters', []) ?? []; },
  getByWorldBook(wbId: string | null): Character[] { return this.getAll().filter(c => !c.wbId || c.wbId === wbId); },
  saveAll(arr: Character[]): void { SM().set('characters', arr); BookManager.saveActive({ characters: arr }); },
  create(data: Partial<Character>): Character {
    const age = data.age ? String(data.age).replace(/岁$/, '') : '';
    const c: Character = {
      ...data,
      age,
      description: data.description ? data.description.slice(0, 150) : '',
      wbId: WorldBookManager.getActiveId(),
      id: 'char_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      createdAt: Date.now(),
      state: {
        currentLocation: '',
        mood: '',
        knowledgeState: [],
        relationshipChanges: {},
        lastSeen: null,
        unresolvedGoals: []
      }
    };
    const all = this.getAll(); all.push(c); this.saveAll(all);
    return c;
  },
  update(id: string, data: Partial<Character>): void {
    const all = this.getAll(); const idx = all.findIndex(c => c.id === id);
    if (idx >= 0) {
      // 合并状态字段
      if (data.state) {
        data.state = Object.assign({}, all[idx].state || {}, data.state);
      }
      all[idx] = {
        ...all[idx], ...data,
        description: data.description ? data.description.slice(0, 150) : all[idx].description,
        id: all[idx].id, createdAt: all[idx].createdAt
      };
      this.saveAll(all);
    }
  },
  delete(id: string): void { this.saveAll(this.getAll().filter(c => c.id !== id)); },

};

// 挂载已移除（单 bundle 改造 P3-B）：消费方 ES import；character.js 停发
export default CharacterManager;