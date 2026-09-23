// SettingSyncManager：Agent 设定同步引擎（临时世界书 overlay + 待裁决表 + 攒批二审）。
// 架构：引擎与策略全内置；插件「Agent 设定同步」（type=widget, shell='agent'）只是启停开关。
// 提示词模板/阈值/开关一律取自本文件的常量——外部数据（历史遗留 manifest）不能覆盖。
// 原书 worldBooks 零触碰：overlay 存独立键，禁用时引擎静默跳过，原世界书页永远只读原书。
import { SM } from '../infra/gate';
import { PluginManager } from './plugins';
import { WorldBookManager } from './worldbook';
import { DELTA_ANY_RE, DELTA_BLOCK_RE, DELTA_BLOCK_RE_G, DELTA_HALF_RE, DELTA_OPEN_RE, DELTA_TAG_RE_G, leadingJsonEnd } from '../lib/delta-tag';

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

// 标记识别统一走 lib/delta-tag（容忍 SETTINGS_DELTA / SERIES_DELTA / 大小写 / 空格 等变体），
// 不再用字面量 [SETTING_DELTA]——模型写错一个字母就整块漏剥是本模块此前的线上问题。
const DELTA_CONTENT_MAX = 4000;

// ==== 默认策略（插件 data 可覆盖） ====
export const DEFAULT_TAIL_INSTRUCTION =
  '\n\n【设定同步】\n正文之后另起一段输出设定变更块：[SETTING_DELTA][{"op":"add|mod|del","target":"条目名","content":"新增内容/新内容","reason":"一句话原因","quote":"正文依据原文一句话"}][/SETTING_DELTA]；无变更也必须输出空块 [SETTING_DELTA][][/SETTING_DELTA]。标记逐字拼写 SETTING_DELTA（单数形式、用下划线，勿写 SETTINGS_DELTA/SERIES_DELTA 等变体）。op 选择：条目已存在 → 用 mod 更新（禁止用 add 重复建条）；世界书完全没有的新设定 → 用 add；旧设定被剧情推翻/角色死亡 → 用 del（不确定别乱删）。同一条目在同一块里只能出现一次——若该条目本轮有多处改动，只写合并后的最终内容（引擎对同条目只保留最后一条提案）。只输出块，不解释。';

// ==== 引擎强制规则（不随插件 data 覆盖；追加在模板之后，升级即生效） ====
// 只同步「全局性设定」，单次情节事件（发生了什么/谁去哪/说了什么）一律不入世界书。
// 事件应交由记忆数据库/摘要/变量等通道记录，世界书条目必须是跨场景持续成立的约束。
export const ENGINE_HARD_RULES =
  '\n\n【引擎强制规则·不可违背】\n' +
  '一、只收「全局性设定」：能长期（至少跨数章）成立的设定才能进世界书——如 角色能力/身份/阵营/关系/关键道具、势力格局、地理规则、力量体系、世界观法则、长期目标/动机。\n' +
  '二、禁止收入「一次性情节事件」：本轮的 场景推进/对白/动作/战斗经过/临时情绪/单次决定/某地去过/某话说过/暂时状态，一律不构成设定，必须拒绝（这是唯一可以放心拒绝的情形）。\n' +
  '三、add 前自问：这条删掉后，未来十章不重提它，故事会不会出现矛盾？不会 → 拒绝（它是事件不是设定）。\n' +
  '四、事件若揭示出「永久性改变」（如角色死亡、身份揭晓、势力覆灭），只收那个永久改变本身，不收过程。\n' +
  '五、content 只写「设定描述」，禁止写：故事梗概/简介、本章剧情总结、事件流水账、时间线记录、心情/评价/散文。content 必须能被直接当世界书条目引用。\n' +
  '六、以下属于「可修正的瑕疵」，用 merge/retarget 修正后采纳，禁止因此整条拒绝：mod 只允许改角色的静态属性（年龄/外貌/性格/背景/身世/能力/职业/身份/阵营/关系）——改动超出这些范围时，把合理部分修正后采纳；content 是散文而非字段清单——用 merge 重排成字段格式；target 标题与内容归属不符——用 retarget 纠正。\n' +
  '七、target 必须对应一个明确条目名；内容泛化成一段介绍/没有锚定到具体条目名的 add——若能判断出该归到哪条，修正后采纳，实在无法判断才拒绝。\n' +
  '八、新增/修改「角色」类条目时，content 最好用规范字段格式（对齐写卡人设卡）：\n' +
  '姓名：xxx\n性别：xxx\n年龄：xxx\n外貌：xxx\n性格：xxx\n背景：xxx\n能力：xxx（可选）\n职业：xxx（可选）\n身份：xxx（可选）\n关系：与xxx（xxx关系）\n只填本轮确有依据/变化的字段，未知字段写「未知」或省略。模型给出散文段落时，merge 重排成该格式，而不是拒绝。\n' +
  '九、target 标题可能与内容归属不符（内容是对的、归错了条目）。遇到这种情况不要拒绝：判明内容真正该归的条目，在裁决 JSON 加 "retarget":"正确条目名" 后按正确归属采纳。\n' +
  '十、每条采纳的条目，content 必须给「完整最终内容」（含已有设定与新设定整合后的全文），系统会整体写入该条目、不做任何二次拼接/追加。禁止只给改动片段。更新已有条目时你负责取舍：过时内容删除、仍有效内容保留、新设定并入，输出一份干净完整的最终版。';

export const DEFAULT_REVIEW_SYSTEM =
  '你是世界书设定的整理者（Agent），对每条待裁决设定行使自主修改权。判定原则：能救则救，只有「内容本身是错的、不该收录」才拒绝。\n' +
  '输入：当前世界书条目全量（system）、待裁决变更（含正文依据 quote）、最近正文片段。\n' +
  '你拥有完整的修改权限，逐条自主决定怎么处理：\n' +
  '一、reject 仅限：①新增内容是情节事件/流水账不该进世界书；②与已有设定矛盾且无法调和；③纯泛化介绍无具体设定。\n' +
  '二、其余一律采纳，且由你输出「该条目的完整最终内容」：\n' +
  '  - 更新已有条目（add 打在已有同名条、或 mod）→ 你自行把「条目现有内容 + 新设定」整合成一份完整新版：过时的删掉、仍有效的保留、新设定并入，按规范格式（角色用 姓名/性别/年龄/外貌/性格/背景…字段清单）重排，输出**完整全文**（不是只给改动片段）。\n' +
  '  - 全新条目 → content 直接给完整内容。\n' +
  '  - 措辞差/格式乱/归属错 → 顺手修正（retarget 给正确条目名）。\n' +
  '三、每条落盘以你的 content 为准（整体写入该条目），系统不做二次拼接。\n' +
  '输出：只输出 JSON 数组，不要解释：[{"id":"待裁决id","decision":"accept|merge","content":"该条目的完整最终内容（必须给全，不接受片段）","reason":"一句话","retarget":"归属错时给正确条目名，可省略"}]；要拒绝的条目 decision 用 reject。';

export const DEFAULT_THRESHOLDS = {
  triggerCount: 5,
  timeoutRounds: 10,
  maxPending: 20,
  cooldownMs: 60000,
};

export const DEFAULT_TOGGLES = {
  allowMod: true,
  allowDel: true,
  softDeleteOnly: true,
};

function deepCopy<T>(v: T): T {
  return v === undefined || v === null ? v : JSON.parse(JSON.stringify(v));
}

function pickText(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v : fallback;
}

function pickNum(v: unknown, fallback: number): number {
  const n = Number(v);
  return n > 0 ? n : fallback;
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
  getActivePlugin(): any {
    try {
      if (typeof PluginManager === 'undefined') return null;
      return PluginManager.getActiveWidgetPlugin('agent');
    } catch (e) { return null; }
  },

  isEnabled(): boolean {
    return !!this.getActivePlugin();
  },

  // 临时世界书是否参与续写注入：Agent 设定同步或比奇任一开启即生效——
  // 两者写的是同一份 overlay，比奇改完的东西必须能被续写读到（否则改了等于没改）。
  isActive(): boolean {
    if (this.isEnabled()) return true;
    try { return typeof PluginManager !== 'undefined' && PluginManager.isEnabled('biqi'); } catch (e) { return false; }
  },

  getConfig(): { enabled: boolean; tailInstruction: string; reviewSystem: string; thresholds: typeof DEFAULT_THRESHOLDS; toggles: typeof DEFAULT_TOGGLES } {
    const plugin = this.getActivePlugin();
    const data = (plugin && plugin.data) || {};
    const th = (data.thresholds) || {};
    const tg = (data.toggles) || {};
    // prompt 始终用引擎内置默认 + 强制规则，不再从插件 data 全文读——历史插件 manifest 固化过
    // 旧版「默认拒绝」文案会覆盖新版宽松策略（pickText 优先 data）；插件 data 只保留阈值/开关。
    // 插件 data 若仍想自定义，后续版本再做版本化白名单（data.promptVersion>=2 才采纳）。
    return {
      enabled: !!plugin,
      tailInstruction: DEFAULT_TAIL_INSTRUCTION,
      reviewSystem: DEFAULT_REVIEW_SYSTEM + ENGINE_HARD_RULES,
      thresholds: {
        triggerCount: pickNum(th.triggerCount, DEFAULT_THRESHOLDS.triggerCount),
        timeoutRounds: pickNum(th.timeoutRounds, DEFAULT_THRESHOLDS.timeoutRounds),
        maxPending: pickNum(th.maxPending, DEFAULT_THRESHOLDS.maxPending),
        cooldownMs: pickNum(th.cooldownMs, DEFAULT_THRESHOLDS.cooldownMs),
      },
      toggles: {
        allowMod: tg.allowMod !== false,
        allowDel: tg.allowDel !== false,
        softDeleteOnly: tg.softDeleteOnly !== false,
      },
    };
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
  _metaKey(): string { return 'settingDeltaMeta_' + this._bookId(); },

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

  /** 移除单条待裁决（比奇写入失败时只清理自己那条，不动自动同步攒下的其它条目） */
  removePending(id: string): void {
    const list = this.getPending().filter(function (p) { return p && p.id !== id; });
    this._savePending(list);
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

  // ---- DELTA 解析/剥离（best-effort：失败静默丢弃） ----
  parseDeltaBlock(text: string): DeltaOp[] {
    const src = String(text || '');
    const m = src.match(DELTA_BLOCK_RE);
    if (!m) return [];
    // 去掉开/闭标记（任意变体），保留块内 JSON
    let inner = m[0].replace(DELTA_TAG_RE_G, '').trim();
    // 容忍 ```json fences
    inner = inner.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    if (!inner || inner === '[]') return [];
    let arr: any;
    try {
      arr = JSON.parse(inner);
    } catch (e) { return []; }
    if (!Array.isArray(arr)) return [];
    const out: DeltaOp[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const op = String(it.op || '').toLowerCase();
      if (op !== 'add' && op !== 'mod' && op !== 'del') continue;
      const target = trunc(String(it.target || '').trim(), 40);
      if (!target) continue;
      out.push({
        id: newDeltaId(),
        op: op as DeltaOp['op'],
        target,
        content: trunc(it.content || '', DELTA_CONTENT_MAX),
        reason: trunc(it.reason || '', 500),
        quote: trunc(it.quote || '', 500),
        type: it.type ? trunc(it.type, 10) : undefined,
        round: Date.now(),
        status: 'pending',
      });
    }
    return out;
  },

  stripDeltaBlock(text: string): string {
    let s = String(text || '');
    // 1) 完整闭合块（含标记变体）：整块删
    s = s.replace(DELTA_BLOCK_RE_G, '');
    // 2) 半截块（模型漏写闭标签 / 输出被截断）：开标记起若紧跟 JSON 载荷，
    //    载荷平衡处之前的都是提议内容 → 删除，其后的正文原样保留；
    //    开标记后不是 JSON（可能紧跟正文）→ 原样留下，交给第 3 步只删标记本身
    s = s.replace(DELTA_HALF_RE, function (m) {
      const afterTag = m.replace(DELTA_OPEN_RE, '');
      const end = leadingJsonEnd(afterTag);
      return end <= 0 ? m : afterTag.slice(end);
    });
    // 3) 孤立残留标记（开/闭、任意变体）：只删标记本身，不碰同行正文
    s = s.replace(DELTA_TAG_RE_G, '');
    return s.replace(/\n{3,}/g, '\n\n').trim();
  },

  hasDeltaBlock(text: string): boolean {
    return DELTA_BLOCK_RE.test(String(text || ''));
  },

  /** 宽松判据：出现任一 DELTA 标记（含漏闭的半截块、变体拼写）→ 需要走解析/剥离链路 */
  hasDeltaMarker(text: string): boolean {
    return DELTA_ANY_RE.test(String(text || ''));
  },

  buildTailInstruction(): string {
    // 引擎强制追加：只收全局性设定，一次性情节事件（对白/动作/经过/单次决定）禁止报 add；
    // 事件揭示的永久改变（死亡/身份揭晓）才收那一条改变本身；content 只写设定描述不写简介。
    // 不可被插件模板覆盖。
    return this.getConfig().tailInstruction +
      '\n【引擎强制】只报「全局性设定」：角色能力/身份/阵营/关系/关键道具/势力格局/世界观法则等能长期成立的；本轮发生的 场景推进/对白/动作/经过/临时状态/单次决定 属情节事件，一律禁止报。content 只写设定描述（禁止写故事简介/本章总结/事件流水账）。' +
      'op 选择铁律：条目已存在（无论原书还是本批已提议）→ 必须用 mod 更新它，**禁止用 add 另建同名/同内容条目**（add 只用于世界书里完全没有的新设定）；' +
      '若不确定该设定是否已有条目，优先用 mod（目标不存在时系统会自动转新增，不会丢）；' +
      'del 用于旧设定被剧情明确推翻/角色死亡/势力覆灭；不确定删不删就报 mod 或 add，别乱报 del。' +
      '角色类条目 content 用字段清单格式（姓名/性别/年龄/外貌/性格/背景/能力/职业/身份/关系：xxx），禁止散文段落。target 标题必须与 content 内容归属一致（内容讲谁/什么，target 就写谁/什么）。';
  },

  /** 待裁决转"覆盖指令"（注入 rolling 区，与世界书冲突时以此为准） */
  buildCoverageText(): string {
    const pending = this.getPending();
    if (pending.length === 0) return '';
    const opLabel = function (op: string): string {
      return op === 'add' ? '新增' : op === 'mod' ? '修改' : '删除';
    };
    let s = '\n【设定覆盖·暂未落盘，本轮及之后以此为准，与世界书冲突时以此为准】\n';
    pending.forEach(function (p) {
      s += '- [' + opLabel(p.op) + ']' + p.target + '：' + trunc(p.content, 200);
      if (p.reason) s += '（' + trunc(p.reason, 100) + '）';
      s += '\n';
    });
    return s;
  },

  /** 待裁决为空时的补交提醒（防上轮漏报）：连续多轮无有效提议才附一行，提醒后清零 */
  buildReminderText(): string {
    const m = this._getMeta();
    if (this.getPending().length > 0) return '';
    if (m.missStreak < 2) return '';
    m.missStreak = 0;
    this._saveMeta(m);
    return '\n【设定补交】若本轮正文引入了尚不在世界书中的关键设定（新登场的重要角色/新能力/关系变化等），请在正文后补充输出设定块一并提交；若无则忽略本提醒。';
  },

  /** onDone 剥离点回调：记录本轮 delta 产出情况（>0 清连续漏报计数，否则 +1） */
  noteDeltaResult(count: number): void {
    const m = this._getMeta();
    m.missStreak = count > 0 ? 0 : m.missStreak + 1;
    this._saveMeta(m);
  },

  // ---- 触发判定 ----
  _getMeta(): { roundsSinceReview: number; forceReview: boolean; lastReviewAt: number; missStreak: number } {
    const m = SM().get<any>(this._metaKey(), null);
    return {
      roundsSinceReview: Number((m && m.roundsSinceReview) || 0),
      forceReview: !!(m && m.forceReview),
      lastReviewAt: Number((m && m.lastReviewAt) || 0),
      missStreak: Number((m && m.missStreak) || 0),
    };
  },
  _saveMeta(m: { roundsSinceReview: number; forceReview: boolean; lastReviewAt: number; missStreak: number }): void {
    SM().set(this._metaKey(), m);
  },
  bumpRound(): 'count' | 'timeout' | 'overflow' | 'chapter' | null {
    const m = this._getMeta();
    m.roundsSinceReview++;
    this._saveMeta(m);
    return this.shouldTriggerReview();
  },
  requestChapterReview(): void {
    const m = this._getMeta();
    m.forceReview = true;
    this._saveMeta(m);
  },
  recordReviewAttempt(): void {
    const m = this._getMeta();
    m.lastReviewAt = Date.now();
    m.roundsSinceReview = 0;
    m.forceReview = false;
    m.missStreak = 0;
    this._saveMeta(m);
  },
  shouldTriggerReview(): 'count' | 'timeout' | 'overflow' | 'chapter' | null {
    const pending = this.getPending();
    if (pending.length === 0) return null;
    const cfg = this.getConfig().thresholds;
    const m = this._getMeta();
    if (m.lastReviewAt && Date.now() - m.lastReviewAt < cfg.cooldownMs) return null;
    if (m.forceReview) return 'chapter';
    if (pending.length >= cfg.maxPending) return 'overflow';
    if (pending.length >= cfg.triggerCount) return 'count';
    if (m.roundsSinceReview >= cfg.timeoutRounds) return 'timeout';
    return null;
  },

  // ---- 二审输入/输出 ----
  buildReviewUserText(recentText: string): string {
    const pending = this.getPending();
    let s = '待裁决变更（JSON，逐条给出 accept/reject；id 必须原样返回）：\n' + JSON.stringify(pending.map(function (p) {
      return { id: p.id, op: p.op, target: p.target, content: p.content, reason: p.reason, quote: p.quote };
    }), null, 1) + '\n\n';
    // 每个 target 的「当前完整内容」——你是整理者，整合新旧时必须基于此旧全文输出完整最终版
    s += '各目标条目当前内容（整合底稿，你的 content 要基于它输出完整最终版）：\n';
    const seen: Record<string, boolean> = {};
    pending.forEach(function (p) {
      if (seen[p.target]) return;
      seen[p.target] = true;
      const cur = SettingSyncManager.findOriginalByTarget(p.target);
      if (cur) {
        const disp = SettingSyncManager.getDisplayEntry(cur);
        const isAdded = SettingSyncManager.getOverlay().added.some(function (e: any) { return e.id === cur.id; });
        s += '- [' + (isAdded ? '临时条' : '原书条') + ']' + p.target + '：\n' + (disp.content || '（空）') + '\n\n';
      } else {
        s += '- ' + p.target + '：（不存在，属全新条目）\n\n';
      }
    });
    const rt = String(recentText || '');
    if (rt) s += '\n最近正文片段（核对 quote 依据用，注意正文可能与提议相隔数轮）：\n' + rt.slice(-4000);
    return s;
  },

  parseReviewResult(text: string): ReviewDecision[] | null {
    const src = String(text || '').trim();
    if (!src) return null;
    // 容忍 ```json fence 与前后解释文字：剥 fence → 先整串试 parse → 失败再截第一个 [ 到最后一个 ] 之间
    let candidate = src.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    let arr: any = null;
    const tryParse = function (s: string): any {
      try { return JSON.parse(s); } catch (e) { return null; }
    };
    arr = tryParse(candidate);
    if (!arr) {
      const open = candidate.indexOf('[');
      const close = candidate.lastIndexOf(']');
      if (open >= 0 && close > open) arr = tryParse(candidate.slice(open, close + 1));
    }
    if (!arr) return null;
    if (!Array.isArray(arr)) return null;
    const out: ReviewDecision[] = [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      if (!it.id) continue;
      const d = String(it.decision || '').toLowerCase();
      if (d !== 'accept' && d !== 'reject' && d !== 'merge') continue;
      out.push({
        id: String(it.id),
        decision: d as ReviewDecision['decision'],
        content: typeof it.content === 'string' ? trunc(it.content, DELTA_CONTENT_MAX) : undefined,
        reason: typeof it.reason === 'string' ? trunc(it.reason, 500) : undefined,
        retarget: typeof it.retarget === 'string' ? trunc(it.retarget.trim(), 40) : undefined,
      });
    }
    return out;
  },

  // ---- 落盘 ----
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
    const tg = this.getConfig().toggles;
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
    const m = this._getMeta();
    m.roundsSinceReview = 0;
    m.forceReview = false;
    m.lastReviewAt = Date.now();
    m.missStreak = 0;
    this._saveMeta(m);
    return { accepted, rejected };
  },


  /** 重置：清 overlay + 待裁决 + 快照，原书零触碰；日志保留可审计 */
  resetAll(): void {
    SM().set(this._overlayKey(), this._blankOverlay());
    SM().set(this._pendingKey(), []);
    SM().set(this._snapsKey(), []);
    SM().set(this._metaKey(), { roundsSinceReview: 0, forceReview: false, lastReviewAt: 0, missStreak: 0 });
  },

  rollback(): boolean {
    const key = this._snapsKey();
    const stack = SM().get<any[]>(key, []) ?? [];
    if (stack.length === 0) return false;
    const s = stack.pop();
    SM().set(key, stack);
    if (s && s.overlay) SM().set(this._overlayKey(), s.overlay);
    if (s && s.pending) SM().set(this._pendingKey(), s.pending);
    const m = this._getMeta();
    m.roundsSinceReview = 0;
    m.forceReview = false;
    m.missStreak = 0;
    this._saveMeta(m);
    return true;
  },
};

// 挂载已移除（单 bundle 改造 P1）：消费方（app/ui）ES import 本模块；settingsync.js 产物停发
export default SettingSyncManager;
