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

  /** 启用中的变量条目（按书内顺序；比奇生效时用「生效条目」，停用/改过/临时新增的都算数）。
   *  读 overlay 需要把 SettingSyncManager 切到该模式，**读完立刻切回**（同步流程内还原）——
   *  否则一次徽标刷新（它要同时数小说/对话两份）就会把比奇面板的模式悄悄改掉，之后它按模式读 overlay 会读错一份。 */
  entries(mode: StatusMode): any[] {
    let list: any[] = [];
    let prev: any = null;
    try {
      if (SettingSyncManager.isActive() && typeof SettingSyncManager.getEffectiveEntries === 'function') {
        try {
          prev = SettingSyncManager.mode();
          if (prev !== mode) SettingSyncManager.setMode(mode);
        } catch (e) { prev = null; }
        try { list = SettingSyncManager.getEffectiveEntries() || []; }
        finally { if (prev && prev !== mode) { try { SettingSyncManager.setMode(prev); } catch (e) { /* ignore */ } } }
      } else {
        const wb = WorldBookManager.getActive();
        list = (wb && wb.entries) || [];
      }
    } catch (e) {
      // 比奇那份读失败（插件异常 / overlay 结构异常）：退回"原书条目"而不是当成"没有变量"——
      // 面板空着又不说原因，用户只会以为功能没生效（"我启用了怎么什么都没有"）。
      try {
        const wb2 = WorldBookManager.getActive();
        list = (wb2 && wb2.entries) || [];
      } catch (e2) { list = []; }
    }
    return list.filter(function (e: any) {
      // 内容（讲解）允许为空：只填了名称也该生效——否则"我明明启用了，面板却说没有启用中的条目"，
      // 用户根本看不出是漏写讲解（面板空态会把这些"差在哪"的条目列出来，见 nearMisses）。
      return e && e.type === '变量' && e.inject !== false
        && String(e.name || '').trim().length > 0;
    });
  },

  /**
   * 面板空态自查：书里的「变量」条目为什么没生效（逐条给原因）。
   * 覆盖最容易踩的四种：类型不对（老版本把「变量」迁移成了「其他」）、注入开关关着、名称为空、
   * 在比奇的临时世界书里被停用。面板只在"一条都没生效"时显示，避免平时占地方。
   */
  nearMisses(mode: StatusMode): { name: string; reason: string }[] {
    const out: { name: string; reason: string }[] = [];
    let disabledIds: any[] = [];
    try {
      if (SettingSyncManager.isActive() && typeof SettingSyncManager.getOverlay === 'function') {
        const o: any = SettingSyncManager.getOverlay() || {};
        disabledIds = Array.isArray(o.disabled) ? o.disabled : [];
      }
    } catch (e) { /* 比奇读不到就按没停用处理 */ }
    let list: any[] = [];
    try {
      const wb = WorldBookManager.getActive();
      list = (wb && wb.entries) || [];
    } catch (e) { list = []; }
    list.forEach(function (e: any) {
      if (!e) return;
      const name = String(e.name || '').trim();
      const type = String(e.type || '其他');
      if (type !== '变量') {
        // 名字里带「变量」但类型不是变量的：老版本的「变量」类型在类型精简迁移里被改成了「其他」，
        // 用户以为"启用了一个变量条目"，其实它是个普通条目——这是最容易踩的一条。
        if (name.indexOf('变量') >= 0) out.push({ name: name || '（未命名）', reason: '类型是「' + type + '」，变量条目必须把类型改成「变量」' });
        return;
      }
      if (!name) { out.push({ name: '（未命名）', reason: '名称为空——名称就是变量名，必须填' }); return; }
      if (e.inject === false) { out.push({ name: name, reason: '注入开关关着（世界书列表里打开它）' }); return; }
      if (disabledIds.indexOf(e.id) >= 0) { out.push({ name: name, reason: '在比奇的临时世界书里被停用了（去比奇面板恢复，或关掉比奇）' }); return; }
    });
    return out;
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
      '**变量名逐字照抄下面的模板**（含括号，一个字都不要改、不要新增别的变量）；' +
      '不要写解释、不要写进思考，也不要在别处重复。\n' +
      '<status>\n' + names.map(function (n) { return n + '：xx'; }).join('\n') + '\n</status>\n' +
      '值是清单（多项）时写在键行下面，每项一行。';
    out += '\n\n【变量说明】';
    list.forEach(function (e: any) {
      const n = String(e.name || '').trim();
      const cur = (vals[n] && vals[n].v) ? String(vals[n].v) : '';
      const note = String(e.content || '').trim();
      out += '\n### ' + n + '\n' +
        (note ? note + '\n' : '（这条还没写讲解：请按变量名自行判断它指什么，并给出符合剧情的当前值）\n') +
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
    if (res.hits.length > 0) this._store(mode, res.hits, res.raw);
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
    // 只留"启用中的变量"那份：改过名/删掉/停用过的残留值不再攒着（面板不显示未登记，攒着只会让
    // {{getvar::}} 和存储里留脏键）。本轮漏写的变量仍保留旧值（上面只是覆盖命中的那些）。
    const keep: Record<string, boolean> = {};
    this.names(mode).forEach(function (n) { keep[n] = true; });
    Object.keys(snap.values).forEach(function (k) { if (!keep[k]) delete snap.values[k]; });
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
};

// 挂载已移至 src/boot/compat.ts 白名单之外：本模块只被 app/chatmode/ui 直接 import，
// 无需字符串 onclick 解析（面板按钮统一走 UIManager）。
export default StatusVars;
