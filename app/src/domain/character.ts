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
  getById(id: string): Character | null { return this.getAll().find(c => c.id === id) || null; },
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

  // === 角色状态管理 ===
  getState(id: string): CharacterState {
    const c = this.getById(id);
    return c ? (c.state || {}) : {};
  },

  updateState(id: string, stateUpdate: Partial<CharacterState>): void {
    const all = this.getAll();
    const idx = all.findIndex(c => c.id === id);
    if (idx < 0) return;
    const current = all[idx].state || {};
    all[idx].state = Object.assign({}, current, stateUpdate);
    all[idx].state.lastSeen = { timestamp: Date.now() };
    this.saveAll(all);
  },

  batchUpdateState(updates: Record<string, Partial<CharacterState>>): void {
    const all = this.getAll();
    let changed = false;
    Object.entries(updates).forEach(function (pair) {
      const name = pair[0];
      const stateUpdate = pair[1];
      const c = all.find(function (ch) { return ch.name === name; });
      if (c) {
        c.state = Object.assign({}, c.state || {}, stateUpdate);
        c.state.lastSeen = { timestamp: Date.now() };
        changed = true;
      }
    });
    if (changed) this.saveAll(all);
  },

  // 从正文中提取角色状态变化（规则提取，不调用 API）
  extractStateFromText(text: string): Record<string, Partial<CharacterState>> {
    if (!text) return {};
    const all = this.getAll();
    const updates: Record<string, Partial<CharacterState>> = {};

    all.forEach(function (c) {
      if (!c.name || c.name.length < 2) return;
      if (text.indexOf(c.name) < 0) return;

      const charUpdate: Partial<CharacterState> = {};

      // 检测情绪关键词
      const moodKeywords: Record<string, string> = {
        '开心': '开心', '高兴': '开心', '快乐': '开心', '喜悦': '开心',
        '生气': '愤怒', '愤怒': '愤怒', '恼火': '愤怒', '暴怒': '愤怒',
        '难过': '悲伤', '伤心': '悲伤', '悲伤': '悲伤', '哭泣': '悲伤',
        '害怕': '恐惧', '恐惧': '恐惧', '紧张': '紧张', '不安': '紧张',
        '惊讶': '惊讶', '震惊': '惊讶', '意外': '惊讶',
        '平静': '平静', '冷静': '平静', '淡然': '平静',
        '困惑': '困惑', '疑惑': '困惑', '不解': '困惑'
      };

      Object.entries(moodKeywords).forEach(function (pair) {
        // 检查角色名附近的情绪词（前后 50 字内）
        const charIdx = text.indexOf(c.name as string);
        const nearby = text.slice(Math.max(0, charIdx - 50), charIdx + (c.name as string).length + 50);
        if (nearby.indexOf(pair[0]) >= 0) {
          charUpdate.mood = pair[1];
        }
      });

      // 检测地点关键词
      const locationPatterns = [
        /在([^\s，。！？]{2,8})(里|中|内|上|下|旁|边)/,
        /来到([^\s，。！？]{2,8})/,
        /进入([^\s，。！？]{2,8})/,
        /离开([^\s，。！？]{2,8})/
      ];
      locationPatterns.forEach(function (rg) {
        const m = text.match(rg);
        if (m) {
          charUpdate.currentLocation = m[1] || m[0];
        }
      });

      if (Object.keys(charUpdate).length > 0) {
        updates[c.name as string] = charUpdate;
      }
    });

    return updates;
  },

  // 所有角色当前状态摘要（用于注入上下文）
  getStatesSummary(): string[] {
    const all = this.getAll();
    const summary: string[] = [];
    all.forEach(function (c) {
      if (!c.name || !c.state) return;
      const parts = [c.name];
      if (c.state.currentLocation) parts.push('在' + c.state.currentLocation);
      if (c.state.mood) parts.push('心情' + c.state.mood);
      if (parts.length > 1) summary.push(parts.join('·'));
    });
    return summary;
  }
};

// 挂载已移除（单 bundle 改造 P3-B）：消费方 ES import；character.js 停发
export default CharacterManager;