// SettingSyncManager：临时世界书（overlay）+ 待裁决表的存储与落盘引擎，**只服务比奇**。
// 「Agent 设定同步」插件已下线（用户要求：只留比奇）——那条自动链路（正文后输出 delta 块 →
// 攒批二审 → 落盘）连同它的提示词/阈值/提醒一起删掉了；这里保留的是比奇要用的部分：
//   · 按书 + 按模式的 overlay 键（小说 / 对话各一份，见 _bookId）
//   · 待裁决表 CRUD（比奇 addPending → applyApproved → removePending）
//   · applyApproved 的落盘语义（改名并入 / retarget / 软删除 / merge）
//   · 快照与回滚、resetAll
// 原书 worldBooks 零触碰：overlay 存独立键，比奇关掉时引擎静默跳过。
import { SM } from '../infra/gate';
import { PluginManager } from './plugins';
import { WorldBookManager } from './worldbook';

export interface DeltaOp {
  id: string;
  op: 'add' | 'mod' | 'del';
  target: string;
  content: string;
  reason: string;
  quote: string;
  type?: string;
  round: number;
  status: 'pending';
  /** 同条目提案合并次数（>1 表示本条覆盖了若干次后续修改，便于 UI 提示） */
  mergedCount?: number;
}

export interface SettingOverlay {
  modified: Record<string, { content?: string; name?: string; type?: string }>;
  disabled: string[];
  added: WBEntryGlobal[];
}

interface ReviewDecision {
  id: string;
  decision: 'accept' | 'reject' | 'merge';
  content?: string;
  reason?: string;
  /** 标题纠正：模型发现 target 与实际内容归属不符时，给正确条目名（配合 accept/merge 使用） */
  retarget?: string;
}

const DELTA_CONTENT_MAX = 4000;

/** 落盘策略：改名并入 / 允许删除 / 删除只做软删除（原书本体保留）。比奇的改动与旧自动链路同一套语义。 */
export const DEFAULT_TOGGLES = {
  allowMod: true,
  allowDel: true,
  softDeleteOnly: true,
};

function deepCopy<T>(v: T): T {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

function trunc(s: unknown, n: number): string {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) : t;
}

// 字段清单行：`中文标签：值`（标签 1-6 字、冒号为中文或半角）
const FIELD_LINE_RE = /^([\u4e00-\u9fa5A-Za-z0-9（）()·]{1,12})\s*[:：]\s*(.*)$/;

/**
 * 把新内容「并入」旧内容，而不是整体覆盖：
 * - 两边都是字段清单（如 姓名：xxx / 年龄：xxx 逐行）→ 字段级合并：
 *   同名字段用新值覆盖旧值；旧内容里有而新内容没提的字段保留；新字段追加；重复行去重。
 * - 非字段（散文/多行段落）→ 若新文本片段已包含在旧内容里则跳过，否则按段追加（不重复）。
 */
export function mergeEntryContent(oldContent: string, newContent: string): string {
  const oldText = String(oldContent || '').trim();
  const newText = String(newContent || '').trim();
  if (!oldText) return newText;
  if (!newText) return oldText;
  // 判断是否字段清单：行数 >1 且大多数行匹配字段行格式（至少 2 行或首行就是字段）
  const oldLines = oldText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  const newLines = newText.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
  const isFieldList = function (lines: string[]): boolean {
    if (lines.length === 0) return false;
    const fieldish = lines.filter(function (l) { return FIELD_LINE_RE.test(l); }).length;
    // 单行也算字段清单（如「年龄：17」），但要求确实是字段格式
    return fieldish >= Math.min(2, lines.length) && fieldish >= 1;
  };
  const oldIsField = isFieldList(oldLines);
  const newIsField = isFieldList(newLines);

  // 两边都是字段清单 → 字段级合并
  if (oldIsField && newIsField) {
    const map = new Map<string, string>();
    oldLines.forEach(function (l) {
      const m = l.match(FIELD_LINE_RE);
      if (m) map.set(m[1], m[2]);
      else map.set('__para_' + map.size, l); // 非字段行（如标题/说明）保留
    });
    // 新内容覆盖/追加字段，保持旧顺序；新字段追加到末尾
    const order: string[] = Array.from(map.keys());
    newLines.forEach(function (l) {
      const m = l.match(FIELD_LINE_RE);
      if (m) {
        const k = m[1];
        if (map.has(k)) {
          // 同名字段：新值非空才覆盖（空值视为删除该字段？不——保留旧值更安全）
          if (m[2].trim()) { map.set(k, m[2]); }
        } else {
          map.set(k, m[2]); order.push(k);
        }
      } else {
        const pk = '__para_' + map.size;
        if (!map.has(pk)) { map.set(pk, l); order.push(pk); }
      }
    });
    return order.map(function (k) {
      const v = map.get(k) || '';
      return k.indexOf('__para_') === 0 ? v : k + '：' + v;
    }).join('\n');
  }

  // 散文/混合 → 段级追加去重
  const norm = function (s: string): string { return s.replace(/\s+/g, ''); };
  const normOld = norm(oldText);
  // 新内容整体已包含在旧内容里 → 不追加
  if (normOld.indexOf(norm(newText)) >= 0) return oldText;
  // 逐段：新内容里没被旧内容覆盖的段才追加
  const extra = newLines.filter(function (l) {
    const n = norm(l);
    return n.length > 0 && normOld.indexOf(n) < 0;
  });
  if (extra.length === 0) return oldText;
  return oldText + '\n' + extra.join('\n');
}

function newDeltaId(): string {
  return 'sdo_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function newEntryId(): string {
  return 'wbe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
}

export const SettingSyncManager = {
  // ---- 插件门控 ----
  // 「Agent 设定同步」已下线（用户要求：只留比奇）。这份 overlay（临时世界书）现在只由**比奇**维护，
  // 所以门控就是"比奇开着吗"——isActive/isEnabled 两个名字都保留（调用点各用各的，语义已一致）。
  isEnabled(): boolean {
    try { return typeof PluginManager !== 'undefined' && PluginManager.isEnabled('biqi'); } catch (e) { return false; }
  },

  isActive(): boolean {
    return this.isEnabled();
  },

  // ---- 按书隔离键 ----
  // 模式后缀：对话模式的临时世界书与小说模式**各存各的**（用户要求）。默认 'novel'，
  // 键名与旧版完全一致（零迁移）；只有对话模式的入口显式 setMode('chat')。
  // 五个键（overlay/待裁决/日志/快照/元信息）全部派生自 _bookId()，所以一处切换整套隔离。
  _mode: 'novel' as 'novel' | 'chat',
  mode(): 'novel' | 'chat' { return this._mode === 'chat' ? 'chat' : 'novel'; },
  setMode(m: 'novel' | 'chat'): void { this._mode = (m === 'chat') ? 'chat' : 'novel'; },

  _bookId(): string {
    let id = 'none';
    try {
      if (typeof WorldBookManager !== 'undefined') {
        id = WorldBookManager.getActiveId() || 'none';
      }
    } catch (e) { /* ignore */ }
    return this.mode() === 'chat' ? id + '_chat' : id;
  },
  _pendingKey(): string { return 'settingDeltaPending_' + this._bookId(); },
  _overlayKey(): string { return 'settingOverlay_' + this._bookId(); },
  _logKey(): string { return 'settingDeltaLog_' + this._bookId(); },
  _snapsKey(): string { return 'settingOverlaySnaps_' + this._bookId(); },

  // ---- 待裁决表 ----
  getPending(): DeltaOp[] {
    return SM().get<DeltaOp[]>(this._pendingKey(), []) ?? [];
  },
  _savePending(arr: DeltaOp[]): void {
    SM().set(this._pendingKey(), arr);
  },
  addPending(ops: DeltaOp[], round?: number): number {
    if (!ops || ops.length === 0) return this.getPending().length;
    const cur = this.getPending();
    let added = 0;
    const mergedTargets: Record<string, boolean> = {};
    for (const o of ops) {
      const target = trunc((o.target || '').trim(), 40);
      if (!target) continue;
      const content = trunc(o.content || '', DELTA_CONTENT_MAX);
      const dup = cur.some(function (p) { return p.op === o.op && p.target === target && p.content === content; });
      if (dup) continue;
      const item: DeltaOp = {
        id: o.id || newDeltaId(),
        op: o.op, target, content,
        reason: trunc(o.reason || '', 500),
        quote: trunc(o.quote || '', 500),
        type: o.type ? trunc(o.type, 10) : undefined,
        round: typeof round === 'number' ? round : Date.now(),
        status: 'pending',
      };
      // 同条目合并：一个 target 在待裁决表里只保留**最新**一条提案。
      // 此前只挡「完全相同」的重复，模型分几轮反复改同一条目就会攒出多条待裁决
      // （二审要为同一目标做多次裁决、UI 上重复展示，且实际只有最后一条生效）。
      const idx = cur.findIndex(function (p) { return p.target === target; });
      if (idx >= 0) {
        item.id = cur[idx].id;                                        // 保留原 id：在途二审快照仍能对上
        item.mergedCount = (cur[idx].mergedCount || 1) + 1;           // 内容/原因/依据一律以最新为准
        cur[idx] = item;
        mergedTargets[target] = true;
        continue;
      }
      cur.push(item);
      added++;
    }
    const mergedList = Object.keys(mergedTargets);
    if (mergedList.length) {
      this._appendLog(mergedList.map(function (t) { return '同条目提案合并（只留最新）：' + t; }));
    }
    // 有界：最多保留 50 条，超了丢最旧
    while (cur.length > 50) cur.shift();
    this._savePending(cur);
    return cur.length;
  },

  /** 移除单条待裁决（比奇写入失败时只清理自己那条） */
  removePending(id: string): void {
    const list = this.getPending().filter(function (p) { return p && p.id !== id; });
    this._savePending(list);
  },

  /**
   * 清理历史遗留的待裁决：那批条目是已下线的自动同步链路攒下的（比奇是即时落盘，待裁决表在
   * 启动时必然是空的——addPending 之后同一次调用里就 applyApproved + removePending 了）。
   * 留着只会让老用户在「临时世界书」页看到一堆既没法裁决、也没法单条删除的提议（只能整页重置，
   * 连临时世界书一起清掉）。所以启动时直接扫掉，用户不用管。
   * 逐书 × 两种模式（键名与 _bookId 同构）扫；返回清掉的条数。
   */
  cleanupLegacyPending(): number {
    let n = 0;
    const ids: string[] = ['none'];   // 没有书时的兜底书号（老数据可能就存在这个键上）
    try {
      WorldBookManager.getAll().forEach(function (wb) {
        if (wb && wb.id && ids.indexOf(String(wb.id)) < 0) ids.push(String(wb.id));
      });
      const active = WorldBookManager.getActiveId();
      if (active && ids.indexOf(String(active)) < 0) ids.push(String(active));
    } catch (e) { /* ignore */ }
    ids.forEach(function (id) {
      ['', '_chat'].forEach(function (suffix) {
        const key = 'settingDeltaPending_' + id + suffix;
        const arr = SM().get<DeltaOp[] | null>(key, null);
        if (Array.isArray(arr) && arr.length > 0) {
          n += arr.length;
          SM().remove(key);
        }
      });
    });
    return n;
  },

  // ---- overlay ----
  _blankOverlay(): SettingOverlay {
    return { modified: {}, disabled: [], added: [] };
  },
  getOverlay(): SettingOverlay {
    const o = SM().get<SettingOverlay>(this._overlayKey(), null);
    if (!o || typeof o !== 'object') return this._blankOverlay();
    return {
      modified: (o.modified && typeof o.modified === 'object') ? o.modified : {},
      disabled: Array.isArray(o.disabled) ? o.disabled : [],
      added: Array.isArray(o.added) ? o.added : [],
    };
  },
  _saveOverlay(o: SettingOverlay): void {
    SM().set(this._overlayKey(), o);
  },
  /** Agent 页编辑保存入口（供 UI 调用，原书零触碰） */
  saveOverlay(o: SettingOverlay): void {
    this._saveOverlay(o);
  },
  overlayCount(): number {
    const o = this.getOverlay();
    return Object.keys(o.modified).length + o.disabled.length + o.added.length;
  },

  entryStatus(entryId: string): 'modified' | 'disabled' | 'added' | 'orig' {
    const o = this.getOverlay();
    if (o.disabled.indexOf(entryId) >= 0) return 'disabled';
    if (o.modified[entryId]) return 'modified';
    if (o.added.some(function (e) { return e.id === entryId; })) return 'added';
    return 'orig';
  },

  getDisplayEntry(orig: WBEntryGlobal): WBEntryGlobal {
    const o = this.getOverlay();
    const m = o.modified[orig.id];
    if (!m) return orig;
    const out: WBEntryGlobal = { ...orig };
    if (typeof m.content === 'string') out.content = m.content;
    if (typeof m.name === 'string') out.name = m.name;
    if (typeof m.type === 'string') out.type = m.type;
    return out;
  },

  /** 供 prompt stable 前缀：disabled 剔除、modified 覆盖、added 追加 */
  getEffectiveEntries(): WBEntryGlobal[] {
    let originals: WBEntryGlobal[] = [];
    try {
      if (typeof WorldBookManager !== 'undefined') {
        const wb = WorldBookManager.getActive();
        if (wb && wb.entries) originals = wb.entries;
      }
    } catch (e) { /* ignore */ }
    const o = this.getOverlay();
    const out: WBEntryGlobal[] = [];
    for (const e of originals) {
      if (o.disabled.indexOf(e.id) >= 0) continue;
      const m = o.modified[e.id];
      if (m) {
        const c: WBEntryGlobal = { ...e };
        if (typeof m.content === 'string') c.content = m.content;
        if (typeof m.name === 'string') c.name = m.name;
        if (typeof m.type === 'string') c.type = m.type;
        out.push(c);
      } else {
        out.push(e);
      }
    }
    for (const a of o.added) out.push(a);
    return out;
  },

  findOriginalByTarget(target: string): WBEntryGlobal | null {
    const t = String(target || '').trim();
    if (!t) return null;
    try {
      if (typeof WorldBookManager !== 'undefined') {
        const wb = WorldBookManager.getActive();
        const list = (wb && wb.entries) || [];
        const exact = list.find(function (e) { return String(e.name || '').trim() === t; });
        if (exact) return exact;
      }
    } catch (e) { /* ignore */ }
    const added = this.getOverlay().added;
    return added.find(function (e) { return String(e.name || '').trim() === t; }) || null;
  },

  // ---- 模式安全的读写（临时世界书按 小说/对话 两套键隔离）----
  // 小说的生成会把模式设成 novel（app.generate 开头），之后用户切回对话视图时模式还停在 novel——
  // 那时读写 overlay 会落到**小说那份**上（症状：临时角色/头像在对话模式里时有时无）。
  // 这里同步切模式、用完还原，不产生跨视图的串台。
  withMode<T>(m: 'novel' | 'chat', fn: () => T): T {
    const prev = this.mode();
    this.setMode(m);
    try { return fn(); } finally { this.setMode(prev); }
  },

  /** 在临时世界书里新增一条（比奇之外的入口：对话模式给龙套登记角色用）。同名幂等，返回条目 id。 */
  addTempEntry(entry: { type?: string; name: string; content?: string; inject?: boolean }): string | null {
    try {
      const name = String((entry && entry.name) || '').trim();
      if (!name) return null;
      const o = this.getOverlay();
      const dup = o.added.find(function (e) { return String(e.name || '').trim() === name; });
      if (dup) return String(dup.id);
      const id = newEntryId();
      o.added.push({
        id,
        type: (entry.type && ['世界观', '角色', '初始', '其他'].indexOf(entry.type) >= 0) ? entry.type : '角色',
        name,
        content: String(entry.content || ''),
        inject: entry.inject !== false,
      });
      this._saveOverlay(o);
      return id;
    } catch (e) { return null; }
  },

  /** 给**临时新增**条目写头像（原书条目走世界书那条路）。返回是否写入成功。 */
  setTempAvatar(entryId: string, dataUrl: string): boolean {
    try {
      const o = this.getOverlay();
      const idx = o.added.findIndex(function (e) { return e.id === entryId; });
      if (idx < 0) return false;
      o.added[idx] = { ...o.added[idx], avatar: dataUrl };
      this._saveOverlay(o);
      return true;
    } catch (e) { return false; }
  },

  // ---- 落盘（快照/回滚，比奇落盘前会自动存一份）----
  _snapshotNow(label: string): void {
    const key = this._snapsKey();
    const stack = SM().get<any[]>(key, []) ?? [];
    stack.push({
      time: Date.now(), label: String(label || ''),
      overlay: deepCopy(this.getOverlay()),
      pending: deepCopy(this.getPending()),
    });
    while (stack.length > 5) stack.shift();
    SM().set(key, stack);
  },

  _appendLog(lines: string[]): void {
    if (!lines || lines.length === 0) return;
    const key = this._logKey();
    const log = SM().get<any[]>(key, []) ?? [];
    for (const t of lines) log.push({ time: Date.now(), text: String(t) });
    while (log.length > 100) log.shift();
    SM().set(key, log);
  },


  getSnapshots(): { time: number; label: string }[] {
    const stack = SM().get<any[]>(this._snapsKey(), []) ?? [];
    return stack.map(function (s) { return { time: s.time, label: s.label }; });
  },

  applyApproved(decisions: ReviewDecision[]): { accepted: number; rejected: number } {
    const pending = this.getPending();
    if (pending.length === 0) return { accepted: 0, rejected: 0 };
    const byId: Record<string, ReviewDecision> = {};
    (decisions || []).forEach(function (d) { if (d && d.id) byId[d.id] = d; });
    const tg = DEFAULT_TOGGLES;
    this._snapshotNow('二审落盘前');
    const overlay = this.getOverlay();
    const self = this;
    let accepted = 0;
    let rejected = 0;
    const logLines: string[] = [];
    const remaining: DeltaOp[] = [];

    for (const p of pending) {
      const d = byId[p.id];
      if (!d) { remaining.push(p); continue; }
      if (d.decision === 'reject') {
        rejected++;
        logLines.push('拒绝[' + p.op + ']' + p.target + (d.reason ? '：' + d.reason : ''));
        continue;
      }
      // accept / merge：content 语义 = AI 给出的「完整最终内容」。
      // AI 给了 content（无论 accept/merge）→ 整体写入（AI 自主整合新旧，系统不二次拼接）；
      // AI 没给 content（纯 accept 没带整合版）→ 兜底用原始提议内容。
      const aiContent = (typeof d.content === 'string' && d.content.trim()) ? d.content.trim() : '';
      const content = aiContent || p.content;
      const aiGaveFull = !!aiContent;
      // 标题纠正：模型判定 target 与内容归属不符时给 retarget，落盘用正确条目名
      const effTarget = (typeof d.retarget === 'string' && d.retarget.trim()) ? d.retarget.trim() : p.target;
      const targetChanged = effTarget !== p.target;
      if (p.op === 'add') {
        // 防重复建条：add 的目标若已存在（原书/临时新增），说明模型该报 mod 却报成 add
        // （常见于标题错位：A 的内容用了 B 的标题，retarget 纠正回 A，但 A 原书已有）。
        // AI 给了完整最终版 → 整体写入（AI 已自行整合旧内容+新设定）；
        // AI 没给 → 兜底代码合并（保住旧内容不丢）。
        const existing = self.findOriginalByTarget(effTarget);
        if (existing) {
          const curEntry = self.getDisplayEntry(existing);
          const finalContent = aiGaveFull ? content : mergeEntryContent(curEntry.content || '', content);
          const addedIdx = overlay.added.findIndex(function (e) { return e.id === existing.id; });
          if (addedIdx >= 0) {
            overlay.added[addedIdx] = { ...overlay.added[addedIdx], content: finalContent };
            logLines.push('新增并入临时条「' + effTarget + '」' + (aiGaveFull ? '（AI 整合版整体写入）' : '（代码合并兜底）'));
            accepted++;
            continue;
          }
          overlay.modified[existing.id] = { content: finalContent };
          if (targetChanged) {
            logLines.push('新增纠正为并入：' + p.target + ' → 内容写入已有条目「' + effTarget + '」' + (aiGaveFull ? '（AI 整合版）' : '（代码合并兜底）'));
          } else {
            logLines.push('新增转并入：' + effTarget + ' 已存在，' + (aiGaveFull ? '写入 AI 整合版' : '代码合并兜底'));
          }
          accepted++;
          continue;
        }
        overlay.added.push({
          id: newEntryId(),
          type: (p.type && ['世界观', '角色', '初始', '其他'].indexOf(p.type) >= 0) ? p.type : '其他',
          name: effTarget, content,
          inject: true,
        });
        accepted++;
        logLines.push('新增' + (targetChanged ? p.target + '（标题纠正为「' + effTarget + '」）' : effTarget));
      } else if (p.op === 'mod') {
        if (!tg.allowMod) {
          rejected++;
          logLines.push('拒绝[改]' + p.target + '：插件已关闭修改');
          continue;
        }
        const orig = self.findOriginalByTarget(effTarget);
        if (orig && overlay.added.every(function (e) { return e.id !== orig.id; })) {
          const curEntry = self.getDisplayEntry(orig);
          const finalContent = aiGaveFull ? content : mergeEntryContent(curEntry.content || '', content);
          overlay.modified[orig.id] = { content: finalContent };
          accepted++;
          logLines.push('修改' + effTarget + (targetChanged ? '（标题纠正，原提 target=' + p.target + '）' : '') + (aiGaveFull ? '（AI 整合版整体写入）' : '（代码合并兜底）'));
        } else if (orig) {
          // 命中的是 overlay 新增条
          const idx = overlay.added.findIndex(function (e) { return e.id === orig.id; });
          if (idx >= 0) {
            const cur = overlay.added[idx].content || '';
            overlay.added[idx] = { ...overlay.added[idx], content: aiGaveFull ? content : mergeEntryContent(cur, content) };
            accepted++;
            logLines.push('修改' + effTarget + '（临时新增条）' + (aiGaveFull ? '（AI 整合版）' : '（代码合并兜底）') + (targetChanged ? '（标题纠正）' : ''));
          }
        } else {
          // 原书无此条，转新增
          overlay.added.push({ id: newEntryId(), type: '其他', name: effTarget, content, inject: true });
          accepted++;
          logLines.push('修改转新增' + effTarget + (targetChanged ? '（标题纠正，原提 target=' + p.target + '）' : ''));
        }
      } else {
        // del：只软删除
        if (!tg.allowDel) {
          rejected++;
          logLines.push('拒绝[删]' + p.target + '：插件已关闭删除');
          continue;
        }
        const orig = self.findOriginalByTarget(effTarget);
        if (orig && overlay.added.every(function (e) { return e.id !== orig.id; })) {
          if (overlay.disabled.indexOf(orig.id) < 0) overlay.disabled.push(orig.id);
          // 顺手清掉针对该条的 modified（停用优先）
          if (overlay.modified[orig.id]) delete overlay.modified[orig.id];
          accepted++;
          logLines.push('停用' + effTarget + '（软删除，可恢复）' + (targetChanged ? '（标题纠正）' : ''));
        } else if (orig) {
          const idx = overlay.added.findIndex(function (e) { return e.id === orig.id; });
          if (idx >= 0) { overlay.added.splice(idx, 1); accepted++; logLines.push('删除临时新增' + effTarget); }
        } else {
          rejected++;
          logLines.push('拒绝[删]' + p.target + '：原书无此条目');
        }
      }
    }

    this._saveOverlay(overlay);
    this._savePending(remaining);
    this._appendLog(logLines);
    return { accepted, rejected };
  },


  /** 重置：清 overlay + 待裁决 + 快照，原书零触碰；日志保留可审计 */
  resetAll(): void {
    SM().set(this._overlayKey(), this._blankOverlay());
    SM().set(this._pendingKey(), []);
    SM().set(this._snapsKey(), []);
  },

  rollback(): boolean {
    const key = this._snapsKey();
    const stack = SM().get<any[]>(key, []) ?? [];
    if (stack.length === 0) return false;
    const s = stack.pop();
    SM().set(key, stack);
    if (s && s.overlay) SM().set(this._overlayKey(), s.overlay);
    if (s && s.pending) SM().set(this._pendingKey(), s.pending);
    return true;
  },
};

// 挂载已移除（单 bundle 改造 P1）：消费方（app/ui）ES import 本模块；settingsync.js 产物停发
export default SettingSyncManager;
