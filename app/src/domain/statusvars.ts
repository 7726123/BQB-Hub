// StatusVars：世界书「变量」条目的注入与收集（一个条目 = 一个变量）。
// 产品模型（2026-09-26 用户定案）：
//   · 条目 `名称` = 变量名，`内容` = 对模型的讲解（是什么、怎么变、范围/失败条件），`注入` 开关 = 启用/停用；
//   · 每轮生成把「格式契约（软件给定，按启用中的变量名生成）+ 变量说明 + 当前值」注入到
//     最后一条用户消息末尾（两种模式都注入；位置由软件负责，与预设尾部模块同级）；
//   · 模型在正文之后回报 <status> 名称：值 …</status>，本模块把块剥掉、把值按名字落盘；
//   · 值按「书 × 模式」各存一份（小说 / 对话两条剧情线互不污染，与记忆表 <id> / <id>_chat 同惯例）。
// 默认不生效：没有启用中的「变量」条目时，注入 / 剥离 / 徽标全为空——对不使用该功能的书零行为变化。
import { SM } from '../infra/gate';
import { WorldBookManager } from './worldbook';
import { SettingSyncManager } from './settingsync';
import { parseStatusBlock } from '../lib/status-block';

export type StatusMode = 'novel' | 'chat';

export interface StatusValue { v: string; at: number }
export interface StatusSnap {
  /** 变量名 → { 值, 更新时间 } */
  values: Record<string, StatusValue>;
  /** 最近一次原文块（面板「原文」/诊断用） */
  raw: string;
  /** 最近一次收集时间 */
  at: number;
}

function emptySnap(): StatusSnap { return { values: {}, raw: '', at: 0 }; }

export const StatusVars = {
  _key: 'statusVars' as string,

  _all(): Record<string, any> {
    try { return SM().get<Record<string, any>>(this._key, {}) ?? {}; } catch (e) { return {}; }
  },
  _write(all: Record<string, any>): void {
    try { SM().set(this._key, all); } catch (e) { /* 存储失败不影响生成 */ }
  },

  /** 启用中的变量条目（按书内顺序；比奇生效时用「生效条目」，停用/改过的都算数） */
  entries(mode: StatusMode): any[] {
    let list: any[] = [];
    try {
      if (SettingSyncManager.isActive() && typeof SettingSyncManager.getEffectiveEntries === 'function') {
        try { SettingSyncManager.setMode(mode); } catch (e) { /* ignore */ }
        list = SettingSyncManager.getEffectiveEntries() || [];
      } else {
        const wb = WorldBookManager.getActive();
        list = (wb && wb.entries) || [];
      }
    } catch (e) { list = []; }
    return list.filter(function (e: any) {
      return e && e.type === '变量' && e.inject !== false
        && String(e.content || '').trim().length > 0
        && String(e.name || '').trim().length > 0;
    });
  },

  names(mode: StatusMode): string[] {
    return this.entries(mode).map(function (e: any) { return String(e.name || '').trim(); });
  },

  enabled(mode: StatusMode): boolean { return this.entries(mode).length > 0; },

  /** 当前生成链属于哪条线（小说 generate 开头 setMode('novel')、演出 setMode('chat')） */
  currentMode(): StatusMode {
    try { return SettingSyncManager.mode() === 'chat' ? 'chat' : 'novel'; } catch (e) { return 'novel'; }
  },

  snap(mode: StatusMode): StatusSnap {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return emptySnap();
    const book = this._all()[wbId];
    const s = book && book[mode];
    if (!s || typeof s !== 'object') return emptySnap();
    return { values: (s.values && typeof s.values === 'object') ? s.values : {}, raw: String(s.raw || ''), at: Number(s.at) || 0 };
  },

  values(mode: StatusMode): Record<string, StatusValue> { return this.snap(mode).values; },

  /** 徽标/面板计数：启用中的变量条数 */
  count(mode: StatusMode): number { return this.entries(mode).length; },

  /** 注入块：格式契约（按启用中的变量名生成）+ 变量说明 + 当前值；没有启用条目时返回空串 */
  block(mode: StatusMode): string {
    const list = this.entries(mode);
    if (list.length === 0) return '';
    const vals = this.values(mode);
    const names = list.map(function (e: any) { return String(e.name || '').trim(); });
    let out = '【变量（每轮必须回报）】\n' +
      '正文写完后，另起一行按下面格式回报这几个变量的最新值：一行一个，每个都要写（即使这一轮没有变化）；' +
      '不要写解释、不要写进思考，也不要在别处重复。\n' +
      '<status>\n' + names.map(function (n) { return n + '：xx'; }).join('\n') + '\n</status>\n' +
      '值是清单（多项）时写在键行下面，每项一行。';
    out += '\n\n【变量说明】';
    list.forEach(function (e: any) {
      const n = String(e.name || '').trim();
      const cur = (vals[n] && vals[n].v) ? String(vals[n].v) : '';
      out += '\n### ' + n + '\n' + String(e.content || '').trim() + '\n' +
        (cur ? '当前值：' + cur : '当前值：（还没有回报过——这一轮请给出符合上面讲解的初始值）');
    });
    return out;
  },

  /**
   * 收口：把正文里的变量回报块剥掉，命中就把值落盘。
   * 没有启用条目 / 没找到块 → 原样返回（绝不动正文，也绝不清空旧值）。
   */
  capture(mode: StatusMode, text: string): string {
    const src = String(text == null ? '' : text);
    if (!src) return src;
    const names = this.names(mode);
    if (names.length === 0) return src;
    const res = parseStatusBlock(src, names);
    if (!res) return src;
    const all = res.hits.concat(res.extra);
    if (all.length > 0) this._store(mode, all, res.raw);
    return res.text;
  },

  _store(mode: StatusMode, hits: { name: string; value: string }[], raw: string): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = this._all();
    if (!all[wbId] || typeof all[wbId] !== 'object') all[wbId] = {};
    const cur = all[wbId][mode];
    const snap: StatusSnap = (cur && typeof cur === 'object')
      ? { values: (cur.values && typeof cur.values === 'object') ? cur.values : {}, raw: String(cur.raw || ''), at: Number(cur.at) || 0 }
      : emptySnap();
    const now = Date.now();
    hits.forEach(function (h) { snap.values[h.name] = { v: h.value, at: now }; });
    if (raw) snap.raw = raw;
    snap.at = now;
    all[wbId][mode] = snap;
    this._write(all);
  },

  // ---- 整书/整模式快照（撤回用：撤回正文时变量必须一起回退，否则会留着「未来」的值） ----
  snapshotBook(): Record<string, any> | null {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return null;
    const cur = this._all()[wbId];
    return cur ? JSON.parse(JSON.stringify(cur)) : {};
  },
  restoreBook(wbId: string, snap: Record<string, any> | null): void {
    if (!wbId) return;
    const all = this._all();
    if (!snap || Object.keys(snap).length === 0) delete all[wbId];
    else all[wbId] = snap;
    this._write(all);
  },
  snapshotMode(mode: StatusMode): StatusSnap | null {
    const s = this.snap(mode);
    return (s.at || Object.keys(s.values).length) ? JSON.parse(JSON.stringify(s)) : null;
  },
  restoreMode(mode: StatusMode, snap: StatusSnap | null): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = this._all();
    if (!all[wbId] || typeof all[wbId] !== 'object') all[wbId] = {};
    if (!snap) delete all[wbId][mode];
    else all[wbId][mode] = JSON.parse(JSON.stringify(snap));
    this._write(all);
  },

  /** 清空当前书、当前模式的值（面板「清空」按钮） */
  clear(mode: StatusMode): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = this._all();
    if (!all[wbId]) return;
    delete all[wbId][mode];
    if (Object.keys(all[wbId]).length === 0) delete all[wbId];
    this._write(all);
  },

  /** 重置本书（世界书重置）时清掉两种模式的值 */
  reset(): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = this._all();
    if (!(wbId in all)) return;
    delete all[wbId];
    this._write(all);
  },

  /** 面板用：模型回报了值、但节点里已经没有对应条目的键（改名/删条目后的残留），不丢、单独列出 */
  unregistered(mode: StatusMode): { name: string; v: string; at: number }[] {
    const known: Record<string, boolean> = {};
    this.names(mode).forEach(function (n) { known[n] = true; });
    const vals = this.values(mode);
    const out: { name: string; v: string; at: number }[] = [];
    Object.keys(vals).forEach(function (k) {
      if (!known[k]) out.push({ name: k, v: String(vals[k].v || ''), at: Number(vals[k].at) || 0 });
    });
    return out;
  },
};

// 挂载已移至 src/boot/compat.ts 白名单之外：本模块只被 app/chatmode/ui 直接 import，
// 无需字符串 onclick 解析（面板按钮统一走 UIManager）。
export default StatusVars;
