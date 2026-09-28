// RealState：真实模式的场景状态 + 记录 + 按角色切片（"物理隔离"的落点）。
// 产品模型（2026-09-28 用户定案）：
//   · 一轮 = 一次公共调用（场记：时间/地点/在场/纪要/选人/可感集合判定）+ 一次角色调用（旁白/动作/台词/<内心>）；
//   · 记录存原文 + 元数据，渲染与注入时解析（与对话模式同一哲学）；
//   · 每个角色只拿到"自己可感"的那部分：不在场 → 整条不出现；同场但不在可感集合 → 只给壳（由模型写）；
//     <内心> 块只属于写出它的那个角色——他自己的视角保留，别人的视角剥掉。用户（读者）看到的是原文，
//     由渲染层负责，不走这里的切片。
// 单角色不变量：本模块只做机械的按人切片，绝不做跨角色的合并判断——任何一次 API 请求里私有材料
// 只能来自一个角色（回归守卫见 app/tests/realstate.test.ts 的隔离用例）。
import { SM } from '../infra/gate';
import { WorldBookManager } from './worldbook';

/** 记录上限（沿用对话模式量级：超了丢最老的，回忆里的 upToId 会被截掉、按从头算兜底） */
export const RECORD_LIMIT = 1200;
const STATE_VERSION = 1;

/** 不可感者看到的"外壳"：由模型写（公共调用判悄悄话时顺带写 / 说话人自己写），写一次存下来 */
export interface RealShell { see?: string; hear?: string }
export interface RealScene { time: string; place: string; present: string[] }
export interface RealRecord {
  id: string;
  at: number;
  kind: 'player' | 'npc' | 'scene';
  /** 说话人角色名；'' = 旁白 / 场记 */
  speaker: string;
  /** 原文（含 <内心> 等标记；渲染与注入时解析） */
  raw: string;
  /** 写入时的在场快照——"不在场就不可知"靠它落地（场景的在场名单之后变了也不影响历史） */
  present: string[];
  /** 台词层的可感集合；缺省 = 在场全体都听得到（悄悄话写这里） */
  heard?: string[];
  shell?: RealShell;
}
/** 压缩回忆（批次 3 用；upToId = 最后一条已经折进回忆的记录 id） */
export interface RealMemory { text: string; upToId: string }
export interface RealBookState {
  version: number;
  scene: RealScene;
  player: string;
  /** 本模式已加入的角色（输入框上方下拉可切换"以谁的身份说话"；与"在场"是两件事） */
  cast: string[];
  /** 上帝模式：这一轮不替任何人说话，只推进剧情（与 player 互斥） */
  god: boolean;
  /** 角色清单是否已经自动种过（只种一次，之后由用户用「＋/移除」自己管，免得移除的又被加回来） */
  castSeeded?: boolean;
  /** 公共纪要（公共调用每轮顺手维护；真实模式的长期上下文靠它 + 各角色的压缩回忆） */
  summary: string;
  log: RealRecord[];
  memories: Record<string, RealMemory>;
  /** 本轮开始前的现场快照（撤回用）。放在状态里而不是挂在记录上：一轮可能什么记录都没产出 */
  turnSnap?: any;
}
export interface RealSliceItem { id: string; speaker: string; text: string; degraded: boolean }
export interface RealSnapshot { scene: RealScene; player: string; summary: string; logLen: number; memories: Record<string, RealMemory> }

const INNER_OPEN = /<\s*内心\s*>/i;
const INNER_BLOCK = /<\s*内心\s*>[\s\S]*?<\s*\/\s*内心\s*>/gi;

/**
 * 剥掉 <内心>…</内心> 块。给"不是写出它的那个角色"看的时候用。
 * 未闭合的开标记 → 从它起全丢（和 lib/status-block 的兜底同策略：宁可少显示，不可把内心漏出去）。
 */
export function stripInner(text: string): string {
  let s = String(text || '');
  s = s.replace(INNER_BLOCK, '');
  const open = s.search(INNER_OPEN);
  if (open >= 0) s = s.slice(0, open);
  return s.trim();
}

/** 壳的两段（看到 / 听到）合成一段文本；都没有 = 空串（调用方按"整条不显示"处理） */
export function shellText(shell?: RealShell): string {
  if (!shell) return '';
  const parts: string[] = [];
  if (shell.see && String(shell.see).trim()) parts.push(String(shell.see).trim());
  if (shell.hear && String(shell.hear).trim()) parts.push(String(shell.hear).trim());
  return parts.join('\n');
}

/**
 * 某个角色的视角切片（"他知道什么"）。
 *   不在场 → 整条不出现；同场但不在可感集合 → 只给壳（没壳则整条不出现，宁可少给不可多给）；
 *   其余 → 原文（不是他写的就把 <内心> 剥掉）。剥完什么都不剩的记录等于"这一轮对他没发生"。
 */
export function visibleIn(log: RealRecord[], name: string): RealSliceItem[] {
  const out: RealSliceItem[] = [];
  const me = String(name || '');
  (log || []).forEach(function (r) {
    if (!r || !Array.isArray(r.present) || r.present.indexOf(me) < 0) return;
    if (Array.isArray(r.heard) && r.heard.indexOf(me) < 0) {
      const shell = shellText(r.shell);
      if (shell) out.push({ id: r.id, speaker: '', text: shell, degraded: true });
      return;
    }
    const text = (!!r.speaker && r.speaker === me) ? String(r.raw || '') : stripInner(String(r.raw || ''));
    if (!text) return;
    out.push({ id: r.id, speaker: r.speaker || '', text: text, degraded: false });
  });
  return out;
}

export function sliceChars(items: RealSliceItem[]): number {
  return (items || []).reduce(function (n, it) { return n + String(it.text || '').length; }, 0);
}

/**
 * 「初始记忆」条目 → 该角色的私有根记忆（开局即生效，不复制到运行时存储：改条目立即生效，可当修正存档用）。
 * 1 对 1 绑定由编辑器保证；这里对数据异常（重复绑定）取第一条，不报错、不炸。
 */
export function initialMemoryFor(name: string, entries: any[]): { text: string; entryId: string } | null {
  const who = String(name || '').trim();
  if (!who) return null;
  const list = entries || [];
  const roleIds: string[] = [];
  list.forEach(function (e: any) {
    if (e && e.type === '角色' && String(e.name || '').trim() === who) roleIds.push(String(e.id || ''));
  });
  let hit: any = null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (!e || e.type !== '初始记忆' || e.inject === false) continue;
    const bid = String(e.bindId || '');
    // bindName 兜底：角色条目被删了重建（id 变了）时按名字仍认得出
    if ((bid && roleIds.indexOf(bid) >= 0) || String(e.bindName || '').trim() === who) { hit = e; break; }
  }
  if (!hit) return null;
  return { text: String(hit.content || ''), entryId: String(hit.id || '') };
}

function emptyState(): RealBookState {
  return { version: STATE_VERSION, scene: { time: '', place: '', present: [] }, player: '', cast: [], god: false, summary: '', log: [], memories: {} };
}

function normalize(s: RealBookState): RealBookState {
  if (!s || typeof s !== 'object') return emptyState();
  if (!s.scene || typeof s.scene !== 'object') s.scene = { time: '', place: '', present: [] };
  if (!Array.isArray(s.scene.present)) s.scene.present = [];
  if (typeof s.scene.time !== 'string') s.scene.time = String(s.scene.time || '');
  if (typeof s.scene.place !== 'string') s.scene.place = String(s.scene.place || '');
  if (!Array.isArray(s.log)) s.log = [];
  if (!s.memories || typeof s.memories !== 'object') s.memories = {};
  if (typeof s.player !== 'string') s.player = '';
  if (!Array.isArray(s.cast)) s.cast = [];
  if (typeof s.god !== 'boolean') s.god = false;
  if (typeof s.castSeeded !== 'boolean') s.castSeeded = false;
  if (typeof s.summary !== 'string') s.summary = '';
  if (!s.version) s.version = STATE_VERSION;
  return s;
}

function newId(): string {
  return 'rr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

export const RealState = {
  _key: 'realState' as string,

  _all(): Record<string, RealBookState> {
    try { return SM().get<Record<string, RealBookState>>(this._key, {}) ?? {}; } catch (e) { return {}; }
  },
  _write(all: Record<string, RealBookState>): void {
    try { SM().set(this._key, all); } catch (e) { /* 存储失败不影响生成 */ }
  },

  /** 当前书的状态（只读用途；要改请走下面的写方法——它们负责落盘） */
  state(): RealBookState {
    const id = WorldBookManager.getActiveId();
    if (!id) return emptyState();
    const cur = this._all()[id];
    return cur ? normalize(cur) : emptyState();
  },

  /** 改状态并落盘（查不到书 / 没数据时按空状态起） */
  _mutate(fn: (s: RealBookState) => void): RealBookState {
    const id = WorldBookManager.getActiveId();
    if (!id) return emptyState();
    const all = this._all();
    const cur = normalize(all[id]);
    fn(cur);
    all[id] = cur;
    this._write(all);
    return cur;
  },

  scene(): RealScene { return this.state().scene; },
  setScene(patch: Partial<RealScene>): void {
    if (!patch) return;
    this._mutate(function (s) {
      if (typeof patch.time === 'string') s.scene.time = patch.time;
      if (typeof patch.place === 'string') s.scene.place = patch.place;
      if (Array.isArray(patch.present)) {
        const seen: Record<string, boolean> = {};
        const list: string[] = [];
        patch.present.forEach(function (n: any) {
          const v = String(n || '').trim();
          if (!v || seen[v]) return;
          seen[v] = true; list.push(v);
        });
        s.scene.present = list;
      }
    });
  },

  player(): string { return this.state().player; },
  /** 选"以谁的身份说话"；传 '' 表示还没选（不自动落到主角——这个模式没有固定扮演者） */
  setPlayer(name: string): void {
    this._mutate(function (s) {
      s.player = String(name || '');
      if (s.player) s.god = false;      // 选了角色就退出上帝模式
    });
  },

  /** 本模式已加入的角色清单（输入框上方的下拉就是它 + 「上帝模式」） */
  cast(): string[] { return (this.state().cast || []).slice(); },
  addCast(name: string): void {
    const who = String(name || '').trim();
    if (!who) return;
    this._mutate(function (s) {
      if (!Array.isArray(s.cast)) s.cast = [];
      if (s.cast.indexOf(who) < 0) s.cast.push(who);
    });
  },
  removeCast(name: string): void {
    const who = String(name || '').trim();
    if (!who) return;
    this._mutate(function (s) {
      if (!Array.isArray(s.cast)) s.cast = [];
      s.cast = s.cast.filter(function (n) { return n !== who; });
      if (s.player === who) s.player = '';
    });
  },

  /** 上帝模式：不替任何人说话，只推进剧情 */
  isGod(): boolean { return !!this.state().god; },
  /** 角色清单是否自动种过（只种一次） */
  castSeeded(): boolean { return !!this.state().castSeeded; },
  setCastSeeded(on: boolean): void { this._mutate(function (s) { s.castSeeded = !!on; }); },
  setGod(on: boolean): void {
    this._mutate(function (s) {
      s.god = !!on;
      if (s.god) s.player = '';
    });
  },

  log(): RealRecord[] { return this.state().log; },

  /** 公共纪要（给公共调用当长期上下文；超预算由它顺手压缩） */
  summary(): string { return this.state().summary || ''; },
  setSummary(text: string): void { this._mutate(function (s) { s.summary = String(text || ''); }); },

  /** 补一条已经写下的记录（公共调用判定完"这句只说给谁"后回填 heard / shell 用） */
  patch(id: string, patch: Partial<RealRecord>): void {
    if (!id || !patch) return;
    this._mutate(function (s) {
      const r = s.log.find(function (x) { return x && x.id === id; });
      if (r) Object.assign(r, patch);
    });
  },

  /** 回合开始：记下这一轮之前的现场（撤回用）。角色侧什么都不写回，所以只要场景/纪要/记录长度/回忆。 */
  beginTurn(snap: any): void { this._mutate(function (s) { s.turnSnap = snap || null; }); },
  turnSnap(): any { return this.state().turnSnap || null; },
  clearTurnSnap(): void { this._mutate(function (s) { s.turnSnap = null; }); },

  /** 追加一条记录；present 缺省 = 当前场景的在场快照（写时刻的，之后改场景不影响历史） */
  append(rec: { kind: RealRecord['kind']; speaker?: string; raw: string; present?: string[]; heard?: string[]; shell?: RealShell }): string | null {
    const id = WorldBookManager.getActiveId();
    if (!id || !rec) return null;
    const rid = newId();
    this._mutate(function (s) {
      const present = Array.isArray(rec.present) ? rec.present.map(function (n) { return String(n || ''); })
        : (s.scene.present || []).slice();
      const row: RealRecord = {
        id: rid, at: Date.now(), kind: rec.kind, speaker: String(rec.speaker || ''),
        raw: String(rec.raw || ''), present: present,
      };
      if (Array.isArray(rec.heard)) row.heard = rec.heard.map(function (n) { return String(n || ''); });
      if (rec.shell) row.shell = rec.shell;
      s.log.push(row);
      if (s.log.length > RECORD_LIMIT) s.log.splice(0, s.log.length - RECORD_LIMIT);
    });
    return rid;
  },

  /** 撤回：删掉最后一条并返回它（按人回滚由渲染/调用侧负责——角色侧不写回任何东西） */
  popLast(): RealRecord | null {
    let removed: RealRecord | null = null;
    this._mutate(function (s) {
      removed = s.log.length ? s.log.pop() || null : null;
    });
    return removed;
  },

  /** 一次生成前的快照（撤回用：场景 + 记录长度 + 回忆区；角色本身不写回，所以只要这三样） */
  snapshot(): RealSnapshot | null {
    const s = this.state();
    try {
      return JSON.parse(JSON.stringify({ scene: s.scene, player: s.player, summary: s.summary || '', logLen: (s.log || []).length, memories: s.memories })) as RealSnapshot;
    } catch (e) { return null; }
  },
  restore(snap: RealSnapshot | null): void {
    if (!snap) return;
    this._mutate(function (s) {
      if (snap.scene) s.scene = normalize({ scene: snap.scene } as RealBookState).scene;
      if (typeof snap.player === 'string') s.player = snap.player;
      if (typeof snap.summary === 'string') s.summary = snap.summary;
      const n = Math.max(0, Number(snap.logLen) || 0);
      if (Array.isArray(s.log) && s.log.length > n) s.log = s.log.slice(0, n);
      if (snap.memories && typeof snap.memories === 'object') s.memories = snap.memories;
    });
  },

  /** 当前书的真实模式状态整份清掉（重置本书时调用） */
  reset(bookId?: string): void {
    try {
      const id = bookId || WorldBookManager.getActiveId();
      if (!id) return;
      const all = this._all();
      if (all[id]) { delete all[id]; this._write(all); }
    } catch (e) { /* ignore */ }
  },

  /** 备份用：整份导出 / 导入（JSON 备份的 realState 字段；导入前会整份替换）。
   *  导出**必须是深拷贝**——返回活引用的话，之后一次 reset 会把已经交出去的备份一起清空。 */
  exportAll(): Record<string, RealBookState> {
    try { return JSON.parse(JSON.stringify(this._all() || {})) as Record<string, RealBookState>; } catch (e) { return {}; }
  },
  importAll(obj: any): void {
    if (!obj || typeof obj !== 'object') return;
    this._write(obj as Record<string, RealBookState>);
  },

  /** 该角色的视角切片（他自己能看到、听到的全部） */
  visibleTo(name: string): RealSliceItem[] { return visibleIn(this.state().log, name); },

  /** 该角色的私有根记忆（世界书「初始记忆」条目，按绑定认人） */
  initialMemory(name: string): { text: string; entryId: string } | null {
    try {
      const wb = WorldBookManager.getActive();
      return initialMemoryFor(name, (wb && (wb as any).entries) || []);
    } catch (e) { return null; }
  },

  memoryOf(name: string): RealMemory | null {
    const mem = (this.state().memories || {})[String(name || '')];
    return mem ? { text: String(mem.text || ''), upToId: String(mem.upToId || '') } : null;
  },
  setMemory(name: string, text: string, upToId: string): void {
    const who = String(name || '');
    if (!who) return;
    this._mutate(function (s) {
      s.memories[who] = { text: String(text || ''), upToId: String(upToId || '') };
    });
  },

  /**
   * 该角色的视角流是否超过窗口（超了才触发压缩；窗口长度复用记忆页的「正文窗口（字）」storyWindowChars）。
   * 回忆里 upToId 已被记录上限截掉 → 按从头算（宁可多压一次，不可漏）。
   */
  shouldCompress(name: string, windowChars: number): boolean {
    const win = Number(windowChars) || 0;
    const who = String(name || '');
    if (win <= 0 || !who) return false;
    const s = this.state();
    const log = s.log || [];
    let from = 0;
    const mem = (s.memories || {})[who];
    if (mem && mem.upToId) {
      const idx = log.findIndex(function (r) { return r && r.id === mem.upToId; });
      from = idx >= 0 ? idx + 1 : 0;
    }
    return sliceChars(visibleIn(log.slice(from), who)) > win;
  },
};
