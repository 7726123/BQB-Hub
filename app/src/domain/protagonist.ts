// ProtagonistManager：主角管理（迁移自 www/modules/protagonist.js）。
import { SM } from '../infra/gate';
import { BookManager } from './book';

export interface Protagonist {
  id: string;
  name?: string;
  description?: string;
  createdAt: number;
  [k: string]: any; // 动态字段（gender/age/occupation/personality…）由消费方宽松读写
}

export const ProtagonistManager = {
  getAll(): Protagonist[] { return SM().get<Protagonist[]>('protagonists', []) ?? []; },
  saveAll(arr: Protagonist[]): void { SM().set('protagonists', arr); },
  getActiveId(): string | null { return SM().get<string>('activeProtagonistId', null); },
  setActiveId(id: string | null): void { SM().set('activeProtagonistId', id); BookManager.saveActive({ activeProtagonistId: id }); },
  getActive(): Protagonist | null {
    const id = this.getActiveId();
    if (!id) return null;
    return this.getAll().find(p => p.id === id) || null;
  },
  create(data: Partial<Protagonist>): Protagonist {
    const p: Protagonist = { ...data, id: 'protag_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), createdAt: Date.now() };
    const all = this.getAll(); all.push(p); this.saveAll(all);
    if (!this.getActiveId()) this.setActiveId(p.id);
    return p;
  },
  update(id: string, data: Partial<Protagonist>): void {
    const all = this.getAll(); const idx = all.findIndex(p => p.id === id);
    if (idx >= 0) {
      all[idx] = {
        ...all[idx], ...data,
        description: data.description ? data.description.slice(0, 150) : all[idx].description,
        id: all[idx].id, createdAt: all[idx].createdAt
      };
      this.saveAll(all);
    }
  },
  delete(id: string): void {
    let all = this.getAll(); all = all.filter(p => p.id !== id); this.saveAll(all);
    if (this.getActiveId() === id) { const next = all[0]; this.setActiveId(next ? next.id : null); }
  },
  migrateFromLegacy(): void {
    if (this.getAll().length > 0) return;
    const legacy = SM().get<Protagonist>('protagonist', null);
    if (legacy && legacy.name) {
      this.create(legacy);
      SM().remove('protagonist');
    }
  }
};

// 挂载已移除（单 bundle 改造 P3-B）：消费方 ES import；protagonist.js 停发
export default ProtagonistManager;