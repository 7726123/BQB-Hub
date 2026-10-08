// ChatMode：对话模式（同一本书的"演出"视图）领域层。
//
// 三条硬约束（改动前先读）：
//   ① **按书独立**：聊天记录挂在世界书对象上（`wb.chatLog`，与 chapters 同级，不进正文、不影响编辑器），
//      流式缓冲也按书 id 归属——切书不会串台，A 书正在跑的那一轮不会画进 B 书。
//   ② **世界书同一份**：只用原书条目注入（与小说模式同一份世界书）；临时改动各存各的——只有
//      **对话模式自己那份**临时世界书（overlay 键带 `_chat` 后缀，由比奇/龙套登记维护）参与，
//      小说模式那份不读。读之前显式切模式（SettingSyncManager.withMode），否则小说生成后
//      模式停在 novel，会读到小说那份（见 _entries 注释）。
//   ③ **存原文、渲染时解析**：chatLog 里是模型原样输出；气泡、样式、头像都在渲染层由 lib/bubble.ts 解析。
//      解析失败只影响样式，绝不丢字。
//
// 与小说模式的差异（有意为之）：不走 waterline / 归档回读 / 事实卡（那些的输入是"正文"，见 §13.23）；
// 上下文的"最近演出"= chatLog 尾部原文，长度要求写在用户消息末尾（实测只写在 system 里会掉到 65–80%）。

import { WorldBookManager, selectInjectableEntries, WB_INJECT_MAX_CHARS, hasUserNamedEntry } from './worldbook';
import { PresetManager, moduleRole, pickModules } from './preset';
import { APIHandler } from './api';
import { hasNativeReasoning } from './modelcompat';
import { BookManager } from './book';
import { SettingSyncManager } from './settingsync';
import { StatusVars } from './statusvars';
import { stripStatusBlocks } from '../lib/status-block';
import { PluginManager } from './plugins';
import { parseBubbles, analyzeParse, stripSpeakerPrefixes, NARRATOR } from '../lib/bubble';
import type { Bubble } from '../lib/bubble';
import { bindAutoGrow } from '../lib/inputgrow';
import { avatarUrl } from '../lib/avatarurl';
import { UsageStats } from '../lib/usage';
import { chatFormatBlock, chatRoster } from './chatprompt';
import { windowFromContext } from '../lib/contextbudget';

export interface ChatMsg {
  id: string;
  kind: 'ai' | 'author' | 'director';  // ai=演出 / author=作者扮演发言 / director=作者指令
  raw: string;
  at: number;
  hidden?: boolean;     // 不显示在演出流里（作者输入：只给模型，读者只看到 AI 演出来的版本）；
                        // 仍然留在记录里，撤回时能把当轮要求放回输入框
  truncated?: boolean;   // finish_reason=length：这轮被截断
  drift?: boolean;       // 解析诊断发现格式漂移或台词没加引号
  words?: number;        // 本轮字数（标记剥离后，仅用于显示）
  reasoning?: number;    // 本轮思考字数（reasoning_content 通道）：被截断时用来判断"额度是不是被思考吃掉的"
  // 世界书「变量」：本轮之前的变量值快照（撤回这一轮演出时一起回退，与小说模式「撤回连变量一起回滚」同语义）
  statusPrev?: any;
}

const RENDER_WINDOW = 120;      // 一次渲染最近多少条（更早的用「载入更早」展开）
// 上下文里带多少字的最近演出：按「模型可用上下文」算（2026-09-26 改，原先写死 6000 字）。
// 命中价比新输入便宜 50 倍（实测同一 prompt 重发命中 99.9%），常驻历史几乎免费；但大前缀每轮
// 都要重读一遍——实测 1.1 万 token 的首字延迟 1.5s、35 万 token 涨到 3.8s，所以这里留保守上限
// 20 万字（≈14 万 token，约 +1 秒），不跟着窗口一路顶到预算。
const CTX_CHARS_FALLBACK = 60000;
const CTX_CHARS_HARD_CAP = 200000;
const CTX_CHARS_MIN = 6000;
const MAX_LOG = 1200;           // 存储上限（防 localStorage 无限涨）
const REASONING_HINT = '正在思考…';

function esc(s: any): string {
  const t = String(s == null ? '' : s);
  try { if (typeof htmlEscape === 'function') return htmlEscape(t); } catch (e) { /* fallthrough */ }
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const nl2br = (s: string) => esc(s).replace(/\n/g, '<br>');
const uid = () => 'cmsg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

function sm(): any { return (globalThis as any).StorageManager; }
function smGet<T>(k: string, d: T): T { try { return sm().get(k, d) as T; } catch (e) { return d; } }
// 背景层当前已应用的封面（值不变就不重复设置，见 _applyBg）——模块级，跨实例共享一份
let _chatBgApplied = '';
function smSet(k: string, v: unknown): void { try { sm().set(k, v); } catch (e) { /* ignore */ } }

export const ChatMode = {
  _loadedBookId: '',
  _window: RENDER_WINDOW,
  _sending: false,
  _status: '',
  _acc: '',              // 流式累积（属于 _streamBookId 那本书）
  _streamBookId: '',
  _lastPaint: 0,
  _lastInstruction: '',
  // 贴底时机（用户要求：流式输出不许自己滚动，完全按用户自己的滑动来）：
  // 这个标记只在"用户刚做了动作"时置位（发一条 / 撤回 / 换书），下一次 render 贴一次底就清掉。
  // 流式增量渲染**不**碰它，所以写着写着页面不会自己往下跑。
  _scrollOnce: true,
  _reasoningChars: 0,
  _profileName: '',       // 打开着的角色简介是谁（换头像后按名字重开，见 refreshAvatars）

  // ---------- 数据 ----------

  book(): any { try { return WorldBookManager.getActive(); } catch (e) { return null; } },
  bookId(): string { try { return WorldBookManager.getActiveId() || ''; } catch (e) { return ''; } },

  log(): ChatMsg[] {
    const wb = this.book();
    const list = (wb && Array.isArray(wb.chatLog)) ? wb.chatLog : [];
    return list.filter((m: any) => m && m.raw != null);
  },

  _saveLog(list: ChatMsg[]): void {
    const trimmed = list.length > MAX_LOG ? list.slice(list.length - MAX_LOG) : list;
    try { WorldBookManager.saveNovelData({ chatLog: trimmed } as any); } catch (e) { console.warn('[Chat] 保存失败', e); }
  },

  append(kind: ChatMsg['kind'], raw: string, extra: Partial<ChatMsg> = {}): ChatMsg {
    const msg: ChatMsg = { id: uid(), kind, raw: String(raw || ''), at: Date.now(), ...extra };
    this._saveLog(this.log().concat([msg]));
    return msg;
  },

  // 写到**指定书**上（不一定是当前书）：流式请求跨书完成时，结果必须落回它开始的那本书，
  // 否则用户在生成途中切书，这一轮的内容会串进另一本（本轮实测要覆盖的场景）。
  _appendToBook(bookId: string, kind: ChatMsg['kind'], raw: string, extra: Partial<ChatMsg> = {}): ChatMsg | null {
    let all: any[];
    try { all = WorldBookManager.getAll(); } catch (e) { all = []; }
    const wb = all.find((w: any) => w && w.id === bookId);
    if (!wb) return null;                        // 书被删了：丢弃这一轮，不串台
    const list: any[] = Array.isArray(wb.chatLog) ? wb.chatLog.slice() : [];
    const msg: ChatMsg = { id: uid(), kind, raw: String(raw || ''), at: Date.now(), ...extra };
    list.push(msg);
    wb.chatLog = list.length > MAX_LOG ? list.slice(list.length - MAX_LOG) : list;
    try { WorldBookManager.saveAll(all); } catch (e) { console.warn('[Chat] 保存失败', e); }
    return msg;
  },

  // 换书：重载窗口、清掉不属于当前书的流式缓冲（请求本身不打断——切回来还能继续画）
  reload(): void {
    const id = this.bookId();
    if (id === this._loadedBookId) { this.render(); return; }
    this._loadedBookId = id;
    this._window = RENDER_WINDOW;
    void this.syncArchive();   // 补同步：切书回来时把上次没归档的演出补上
    this._status = '';
    this._acc = '';
    this._streamBookId = '';
    this._scrollOnce = true;   // 换书是用户主动动作：贴到底看最新一轮
    this.render();
  },

  // 清空：与小说模式「重置本书」同款交互（应用内确认框，不用系统弹窗）+ 同款收尾——
  // 除了这本书的演出记录，**输入栏与当轮状态也一并清干净**（用户 2026-09-25：点了清空，输入框里
  // 还留着上一句没发出去的话，像是没清干净）。世界书与正文一律不动。
  clearAll(): void {
    const self = this;
    let bookName = '当前书';
    try { const wb: any = this.book(); if (wb && wb.name) bookName = String(wb.name); } catch (e) { /* ignore */ }
    const run = () => {
      self._saveLog([]);
      const ta: any = document.getElementById('chatInput');
      if (ta) {
        ta.value = '';
        try { if (typeof App !== 'undefined' && App.resetChatInput) App.resetChatInput(ta); } catch (e) { /* ignore */ }
      }
      // 当轮遗留状态一起清掉（否则清完还挂着上一轮的状态文案/流式缓冲/撤回指令）
      self._acc = '';
      self._status = '';
      self._lastInstruction = '';
      self._reasoningChars = 0;
      self._scrollOnce = true;
      // 世界书「变量」：演出记录清空了，对话模式那份变量值也一起清（与"撤回一轮"同语义；
      // 小说模式那份不动——这里清的是对话模式的记录）
      try { StatusVars.clear('chat'); } catch (e) { /* ignore */ }
      try { smSet(self._ctxFromKey(), 0); } catch (e) { /* 水位线归零失败不影响清空 */ }
      self.render();
      try { App.toast('已清空演出记录'); } catch (e) { /* ignore */ }
    };
    try {
      if (typeof UIManager !== 'undefined' && UIManager && typeof UIManager.showConfirm === 'function') {
        UIManager.showConfirm('清空《' + bookName + '》的全部演出记录？此操作不可恢复（世界书与正文不受影响，输入栏里的内容也会一起清掉）。', run);
        return;
      }
    } catch (e) { /* 弹框失败退回系统确认 */ }
    if (confirm('清空《' + bookName + '》的全部演出记录？清空后不可恢复（世界书和正文不受影响）。')) run();
  },

  // ---------- 名单 / 头像 / 简介 ----------

  // 生效条目：对话模式自己的临时世界书（settingOverlay_<书ID>_chat）叠在原书之上；
  // 小说模式那份 overlay 与这里完全无关（用户要求：两种模式各存各的）。
  // 读之前显式把模式切到 chat 并还原：小说的生成会把模式设成 novel，切回对话视图时模式还停在
  // novel，那时 getEffectiveEntries 读的是小说那份（症状：临时角色/头像在对话模式里时有时无）。
  _entries(): any[] {
    const wb = this.book();
    const orig = (wb && wb.entries) || [];
    try {
      const SS = SettingSyncManager;
      if (SS && typeof SS.isActive === "function" && SS.isActive() && typeof SS.getEffectiveEntries === "function") {
        const eff = (typeof SS.withMode === 'function')
          ? SS.withMode('chat', () => SS.getEffectiveEntries())
          : SS.getEffectiveEntries();
        if (Array.isArray(eff) && eff.length > 0) return eff;
      }
    } catch (e) { /* 回落原书条目 */ }
    return orig;
  },

  roster(): string[] {
    const list = chatRoster(this._entries(), this.protagonistName());
    // 没设主角时：第一人称视角会以「我」发言，必须把「我」也算合法说话人——
    // 否则格式块的"说话人只能从名单里取"会把主角的台词挡掉（实测：主角声音整个消失）。
    if (!this.protagonistName() && list.indexOf('我') < 0) list.push('我');
    return list;
  },
  protagonistName(): string {
    try { const p = App.getProtagonist(); return (p && p.name) ? String(p.name) : ''; } catch (e) { return ''; }
  },
  // 别名 → 规范名：不只「我」，还包括主角名的姓/名简写。模型经常用姓或名单独称呼主角
  // （「温水：」「和彦：」），不认的话这些行会被当成"名单外的新人物"另起一个头像气泡——
  // 用户报的「对话模式里多出一个角色」就是这么来的。只取前缀/后缀（姓、名），不取中间片段；
  // 单字太容易误伤，最少两个字；名单里真有同名角色时以名单为准（resolveKnown 先查名单）。
  // 「主角」和「user」是同一个人的另外两种写法：卡片常用 user 当主角占位符（2026-09-25 用户
  // 反馈），模型照抄条目里的 user 写「user：」时，不收敛就会多出一个叫 user 的陌生人气泡。
  // 没设主角名时全部落到「我」——名单里也是「我」，同一个身份只出现一次（不然「主角：」+「我：」
  // 会渲染成两条各自靠右的气泡，像两个人）。
  aliases(): Record<string, string> {
    const p = this.protagonistName();
    const self = p || '我';
    const map: Record<string, string> = { '我': self, '主角': self };
    // 世界书里真有一个叫 User/user 的角色时，user 是正经角色名，不接管
    if (!this._hasUserEntry()) map['user'] = self;
    if (!p) return map;
    const chars = Array.from(p);
    for (let len = 2; len < chars.length; len++) {
      map[chars.slice(0, len).join('')] = p;
      map[chars.slice(chars.length - len).join('')] = p;
    }
    return map;
  },
  _hasUserEntry(): boolean {
    try { return hasUserNamedEntry(this._entries()); } catch (e) { return false; }
  },
  parseOpts(): { roster: string[]; aliases: Record<string, string>; narrator?: string } {
    // narrator = 主角：它的气泡里"我…"的长动作句按叙述着色（模型整轮不写引号时的兜底，见 lib/bubble.ts）
    const p = this.protagonistName();
    return { roster: this.roster(), aliases: this.aliases(), narrator: p || undefined };
  },

  _entryByName(name: string): any | null {
    const list = this._entries();
    const strip = (s: string) => s.replace(/(小姐|先生|女士|老师|大人|同学|哥哥|姐姐|弟弟|妹妹|大叔|阿姨|夫人|殿下)$/, '');
    const n = strip(name);
    // ① 先找「角色」条目（头像、简介都按它）
    const hit = list.filter((e: any) => e && e.type === '角色' && String(e.name || '') === name);
    if (hit.length > 0) return hit[0];
    const fuzzy = list.find((e: any) => e && e.type === '角色' && strip(String(e.name || '')) === n);
    if (fuzzy) return fuzzy;
    // ② 兜底：同名的其他类型条目（比奇新增时 type 默认「其他」，角色名却落在那种条目上——
    //    不兜底的话，简介里看得到设定、头像却永远挂不上）
    const anyType = list.find((e: any) => e && String(e.name || '') === name);
    if (anyType) return anyType;
    return list.find((e: any) => e && strip(String(e.name || '')) === n) || null;
  },

  // 龙套登记落在**比奇的临时世界书**里，所以比奇关着就没法登记：那份 overlay 由比奇开关门控
  // （关掉比奇 = 临时世界书整体不参与，读了也看不到）。关着时明确说清楚，不做"写了却看不到"的静默失败。
  _tempCharAvailable(): boolean {
    try {
      if (typeof PluginManager === 'undefined' || typeof PluginManager.isEnabled !== 'function') return true;
      return !!PluginManager.isEnabled('biqi');
    } catch (e) { return false; }
  },

  // 临时角色登记：路人/同学A 这类名字要能长期复用同一个称呼、要点开有简介、要能给头像，
  // 就得在**对话模式自己的临时世界书**里有一条同名「角色」条目（原书不动）。已存在则复用。
  // 登记条的 inject=false：它只为"头像与名单"服务，不进提示词（名单由 chatRoster 直接读条目，
  // 不看 inject，所以名字照样进名单）；想给它写正式设定就在比奇页编辑并勾上注入。
  ensureTempCharacter(name: string): string | null {
    const n = String(name || '').trim();
    if (!n || n === NARRATOR) return null;
    if (!this._tempCharAvailable()) return null;
    try {
      const strip = (s: string) => s.replace(/(小姐|先生|女士|老师|大人|同学|哥哥|姐姐|弟弟|妹妹|大叔|阿姨|夫人|殿下)$/, '');
      const base = strip(n);
      const hit = this._entries().find((e: any) => e && e.type === '角色' &&
        (String(e.name || '') === n || strip(String(e.name || '')) === base));
      if (hit && hit.id) return String(hit.id);      // 已有（原书或临时）→ 直接用它的 id
      return SettingSyncManager.withMode('chat', () => SettingSyncManager.addTempEntry({
        type: '角色', name: n, inject: false,
        content: '（对话模式临时登记的角色：只为头像、简介与说话人名单。要给它固定设定，就在这里补充并勾上注入。）',
      }));
    } catch (e) { return null; }
  },

  // 简介弹窗里给「世界书里没有的角色」设头像：先登记成临时角色，再走统一的世界书头像选择器
  // （UIManager.onAvatarPicked 会认出临时条目并把头像写进 overlay；重置临时设定后头像一起消失）。
  pickAvatarFor(name: string): void {
    try {
      if (!this._tempCharAvailable()) {
        App.toast('临时角色存在比奇的临时世界书里：请先在「插件」页开启比奇');
        return;
      }
      const id = this.ensureTempCharacter(name);
      if (!id) { App.toast('这个名字没法登记'); return; }
      UIManager.pickAvatar('wb', id);
    } catch (e) {
      try { App.toast('设头像失败：' + String((e as any)?.message || e)); } catch (e2) { /* ignore */ }
    }
  },

  // 主角的气泡靠右（微信里"自己的消息"那一侧）：设了主角按主角名，没设主角时第一人称的「我」也算
  _isSelf(speaker: string): boolean {
    const p = this.protagonistName();
    if (p) return speaker === p;
    return speaker === '我' || speaker === '主角';
  },

  avatar(name: string): { src: string | null; initial: string; color: string } {
    const initial = String(name || '?').trim().charAt(0) || '?';
    let h = 0;
    for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) % 360;
    const color = 'hsl(' + h + ', 42%, 52%)';
    if (!name || name === NARRATOR) return { src: null, initial: '白', color: 'hsl(220, 12%, 52%)' };
    const e = this._entryByName(name);
    // 短地址（blob:）而不是原 data URL：流式时每 200ms 会重画整屏气泡，塞原图会把 JS 线程占满
    return { src: (e && e.avatar) ? avatarUrl(e.avatar) : null, initial, color };
  },

  // 角色简介 = 自动聚合：精确名 → 去尊称后包含匹配，命中的条目按「条目名 + 类型」分组显示
  profile(name: string): Array<{ id: string; name: string; type: string; content: string; inject?: boolean }> {
    const list = this._entries();
    const n = String(name || '').trim();
    if (!n) return [];
    const strip = (s: string) => s.replace(/(小姐|先生|女士|老师|大人|同学|哥哥|姐姐|弟弟|妹妹|大叔|阿姨|夫人|殿下)$/, '');
    const base = strip(n);
    const exact: any[] = [], fuzzy: any[] = [];
    list.forEach((e: any) => {
      if (!e) return;
      const en = String(e.name || '');
      if (!en) return;
      if (en === n || strip(en) === base) { exact.push(e); return; }
      if (en.length > 1 && (en.indexOf(base) >= 0 || base.indexOf(en) >= 0)) fuzzy.push(e);
    });
    return exact.concat(fuzzy).map((e: any) => ({ id: e.id, name: e.name, type: e.type || '', content: e.content || '', inject: e.inject !== false }));
  },

  // 临时标记按**对话模式那份** overlay 判定：模式可能停在 novel（小说的生成设的），
  // 不切模式就会查小说那份，临时标记忽有忽无（与 _entries 同一类坑）。
  _entryStatusChat(id: string): 'modified' | 'disabled' | 'added' | 'orig' {
    try {
      return (typeof SettingSyncManager.withMode === 'function')
        ? SettingSyncManager.withMode('chat', () => SettingSyncManager.entryStatus(id))
        : SettingSyncManager.entryStatus(id);
    } catch (e) { return 'orig'; }
  },

  openProfile(name: string): void {
    const box = document.getElementById('chatProfileModal');
    const body = document.getElementById('chatProfileBody');
    const title = document.getElementById('chatProfileTitle');
    if (!box || !body) return;
    this._profileName = String(name || '');   // 换完头像要按名字重开一次（见 refreshAvatars）
    if (title) title.textContent = name + ' · 角色简介';
    const av = this.avatar(name);
    const avHtml = av.src
      ? '<img src="' + esc(av.src) + '" style="width:64px;height:64px;border-radius:12px;object-fit:cover;" onclick="UIManager.viewAvatar(this.src)" alt="">'
      : '<div style="width:64px;height:64px;border-radius:12px;background:' + av.color + ';color:#fff;display:flex;align-items:center;justify-content:center;font-size:28px;">' + esc(av.initial) + '</div>';
    const rows = this.profile(name);
    let html = '<div style="display:flex;gap:12px;align-items:center;margin-bottom:10px;">' + avHtml +
      '<div><div style="font-weight:600;font-size:15px;">' + esc(name) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + (rows.length ? rows.length + ' 条相关设定' : '世界书里还没这个角色的条目') + '</div></div></div>';
    if (rows.length === 0) {
      html += '<div style="font-size:12px;color:var(--text-muted);line-height:1.8;">世界书里还没有这个角色的条目（临时出场的路人/同学A 这类角色通常也没有）。' +
        '给它设个头像，就会在临时世界书里登记一条同名「角色」条目：原书不动，重置临时设定后一起消失。</div>' +
        '<div style="margin-top:8px;"><button class="ghost-btn" onclick="ChatMode.pickAvatarFor(\'' + esc(name) + '\')">给 TA 设头像</button>' +
        '<button class="ghost-btn" onclick="ChatMode.closeProfile()" style="margin-left:6px;">知道了</button></div>';
    } else {
      rows.forEach(r => {
        // 临时标记：让用户知道这条是"临时修订/临时新增"，重置临时设定就没了
        let tempChip = '';
        const st = this._entryStatusChat(r.id);
        if (st === 'added') tempChip = '<span class="type-chip">临时新增</span>';
        else if (st === 'modified') tempChip = '<span class="type-chip">临时修改</span>';
        html += '<div class="card" style="margin-top:8px;">' +
          '<div style="display:flex;align-items:center;gap:6px;"><span class="type-chip">' + esc(r.type) + '</span>' + tempChip + '<b style="font-size:13px;">' + esc(r.name) + '</b></div>' +
          '<div style="font-size:13px;line-height:1.8;margin-top:6px;white-space:pre-wrap;">' + esc(r.content) + '</div>' +
          '<div style="margin-top:6px;"><button class="ghost-btn" onclick="ChatMode.closeProfile()">知道了</button>' +
          '<button class="ghost-btn" onclick="UIManager.pickAvatar(\'wb\',\'' + esc(r.id) + '\')" style="margin-left:6px;">换头像</button></div>' +
          '</div>';
      });
    }
    body.innerHTML = html;
    box.style.display = 'flex';
  },
  // 打开对话模式的比奇（与小说模式各一份会话、各一份临时世界书）
  openBiqi(): void {
    const B = (globalThis as any).BiqiAgent;
    if (!B) return;
    if (typeof B.isEnabled === 'function' && !B.isEnabled()) { try { App.toast('请先在「插件」页开启比奇'); } catch (e) { /* ignore */ } return; }
    B.panelHost?.('chat');
    B.setMode?.('chat');
    B.toggle?.();
  },

  closeProfile(): void {
    const box = document.getElementById('chatProfileModal');
    if (box) box.style.display = 'none';
    this._profileName = '';
  },

  /**
   * 换完头像立刻生效（由 UIManager.onAvatarPicked 调用）。
   * 以前头像写进世界书条目后只刷新了世界书那一页，对话模式得切到别的视图再回来才看得到新头像——
   * 因为气泡与简介都是渲染时用角色名现查条目，不重画就还是旧的。
   */
  refreshAvatars(): void {
    this.render();
    const box = document.getElementById('chatProfileModal');
    const open = !!box && box.style.display !== 'none' && box.style.display !== '';
    if (open && this._profileName) this.openProfile(this._profileName);   // 简介弹窗里那张大图也跟着换
  },

  // ---------- 封面背景（气泡自带底色，背景不挡字） ----------
  // 用户要求：把书的封面自动当对话背景；**没有封面就不设**；顶部（比奇旁边）给一个开关自己选。
  // 开关是全局的（一本书一个封面，开关只管"要不要用封面当背景"），切书时背景跟着当前书换。
  bgEnabled(): boolean {
    return smGet<boolean>('chatCoverBg', true) !== false;   // 默认开（有封面才真正生效）
  },
  setBgEnabled(on: boolean): void {
    smSet('chatCoverBg', !!on);
    this.render();
  },
  toggleBg(): void {
    const on = !this.bgEnabled();
    this.setBgEnabled(on);
    try { App.toast(on ? '已开启封面背景' : '已关闭封面背景'); } catch (e) { /* ignore */ }
  },
  // 当前书的封面（没设就是空串：书列表那边会退化成"一个字"的色块，不是图片）
  coverUrl(): string {
    try {
      const wb = this.book();
      const c = wb && (wb as any).cover ? String((wb as any).cover) : '';
      return /^data:image\//.test(c) ? c : '';   // 只认图片 data URL（防脏数据）
    } catch (e) { return ''; }
  },
  // 背景层（#chatBg）只在这里更新：流式渲染每 200ms 会重画一次气泡，
  // 值没变就一个字节都不动（否则每帧都设一次几百 KB 的 data URL，等于每帧重新解码）
  _applyBg(): void {
    const host = document.getElementById('chatBg');
    const wrap = document.getElementById('chatStreamWrap');
    const cover = this.bgEnabled() ? this.coverUrl() : '';
    if (!host) return;
    if (_chatBgApplied === cover) return;
    _chatBgApplied = cover;
    if (!cover) {
      host.classList.remove('on');
      host.style.backgroundImage = '';
      if (wrap) wrap.classList.remove('chat-has-bg');
      return;
    }
    host.style.backgroundImage = 'url("' + cover.replace(/"/g, '%22') + '")';
    host.classList.add('on');
    if (wrap) wrap.classList.add('chat-has-bg');
  },

  // ---------- 渲染 ----------

  render(): void {
    const stream = document.getElementById('chatStream');
    if (!stream) return;
    // 贴底标记只在这里消费一次（空记录分支也要消费掉，否则它会一直挂着，下一次渲染莫名贴底）
    const wantBottom = this._scrollOnce;
    this._scrollOnce = false;
    if (this.bookId() !== this._loadedBookId) { this._loadedBookId = this.bookId(); this._window = RENDER_WINDOW; }
    this._renderHead();
    this._applyBg();
    const all = this.log();
    const shown = all.slice(Math.max(0, all.length - this._window));
    const tail: ChatMsg | null = (this._sending && this._streamBookId === this.bookId())
      ? { id: '_streaming', kind: 'ai', raw: this._displayRaw(this._acc), at: Date.now() }
      : null;
    const rows = shown.concat(tail ? [tail] : []).filter(m => !m.hidden);
    if (rows.length === 0) {
      stream.innerHTML = '<div class="empty-box" style="margin:20px 12px;"><div class="empty-tt">这本还没有演出记录</div>' +
        '<div class="empty-sub">在下面写一句要求（比如「放学后的教室，林薇把一封信放在我桌上」），或者直接点「发送」</div></div>';
      return;
    }
    const hiddenBefore = all.length - shown.length;
    let html = hiddenBefore > 0
      ? '<div style="text-align:center;margin:8px 0;"><button class="ghost-btn" onclick="ChatMode.loadMore()">载入更早的 ' + hiddenBefore + ' 条</button></div>'
      : '';
    let lastAt = 0;
    rows.forEach(m => {
      if (lastAt === 0 || m.at - lastAt > 10 * 60 * 1000) html += this._timeSep(m.at);
      lastAt = m.at;
      html += this._bubbleHtml(m);
    });
    html += '<div id="chatBottomAnchor"></div>';
    stream.innerHTML = html;
    // 只有用户主动动作后的那一次渲染才贴底；流式增量渲染不贴（否则页面会跟着输出自己往下跑）
    if (wantBottom) this._scrollToBottom();
    this._syncScrollBottomBtn();
  },

  // 载入更早的消息：新内容插在**上面**，不锚定的话用户正看着的那条会被顶走。
  // 按插入前后的高度差补 scrollTop，视觉上停在原地。
  loadMore(): void {
    const stream = document.getElementById('chatStream');
    const beforeH = stream ? stream.scrollHeight : 0;
    const beforeTop = stream ? stream.scrollTop : 0;
    this._window += RENDER_WINDOW;
    this.render();
    if (stream) stream.scrollTop = beforeTop + (stream.scrollHeight - beforeH);
    this._syncScrollBottomBtn();
  },

  // ---------- 跳到底部（与写作页那颗 ↩ 同款；浮在气泡区右下角）----------

  _scrollGap(): number {
    const stream = document.getElementById('chatStream');
    if (!stream) return 0;
    return stream.scrollHeight - stream.scrollTop - stream.clientHeight;
  },

  _syncScrollBottomBtn(): void {
    const btn = document.getElementById('chatScrollBottom');
    if (!btn) return;
    // 离底部超过一屏内的两行才显示：和写作页一样，只是"滚上去了"的提示
    btn.classList.toggle('show', this._scrollGap() > 80);
  },

  // 点一下：缓动滚到底（用户主动动作）。注意**不恢复"自动跟随"**——streaming 期间页面永远不自己动，
  // 想看新内容就再点一下（或者自己往下滑）。
  scrollToBottomAnimated(): void {
    const stream = document.getElementById('chatStream');
    if (!stream) return;
    const from = stream.scrollTop;
    const to = Math.max(0, stream.scrollHeight - stream.clientHeight);
    if (to <= from + 1) { this._syncScrollBottomBtn(); return; }
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const dur = 260;
    const ease = function (p: number) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
    const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : function (cb: any) { setTimeout(cb, 16); };
    const self = this;
    const step = function () {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const p = Math.min(1, (now - t0) / dur);
      stream.scrollTop = from + (to - from) * ease(p);
      if (p < 1) { raf(step); } else { self._syncScrollBottomBtn(); }
    };
    raf(step);
  },

  _renderHead(): void {
    // 生成中：发送键换成停止键（与写作页同一对：蓝色发送 / 红色停止）
    const sending = this.isSending();
    const sendBtn = document.getElementById('chatSendBtn');
    const stopBtn = document.getElementById('chatStopBtn');
    if (sendBtn) sendBtn.style.display = sending ? 'none' : 'flex';
    if (stopBtn) stopBtn.style.display = sending ? 'flex' : 'none';
    const bb = document.getElementById('chatBiqiBtn');
    if (bb) {
      let on = false;
      try { on = PluginManager.isEnabled('biqi'); } catch (e) { /* ignore */ }
      bb.style.display = on ? '' : 'none';
    }
    // 封面背景开关：这本书有封面才显示（没封面没什么可开的），开着时按钮高亮
    const bgBtn = document.getElementById('chatBgBtn');
    if (bgBtn) {
      const has = !!this.coverUrl();
      bgBtn.style.display = has ? '' : 'none';
      bgBtn.classList.toggle('on', has && this.bgEnabled());
      bgBtn.textContent = this.bgEnabled() ? '背景：开' : '背景：关';
      bgBtn.title = has ? '用这本书的封面做对话背景（点一下切换）' : '这本书还没有封面';
    }
    const st = document.getElementById('chatStatus');
    if (st) st.textContent = this._status || '';
  },

  _timeSep(at: number): string {
    const d = new Date(at);
    const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const label = sameDay ? hm : (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm;
    return '<div style="text-align:center;font-size:11px;color:var(--text-muted);margin:10px 0 6px;">' + esc(label) + '</div>';
  },

  // 模型偶尔把占位符原样写进输出（`{{user}}：「…」`）：花括号会让解析器不认这行（不是名字形状），
  // 字面量还会直接显示给读者。渲染前只把**花括号写法**换成名字，正常正文一个字符都不动。
  _fixMacros(t: string): string {
    const self = this.protagonistName() || '我';
    return String(t || '')
      .replace(/\{\{\s*user\s*\}\}/gi, () => self)
      .replace(/\{\s*user\s*\}/gi, () => self)
      .replace(/\{\{\s*char\s*\}\}/gi, () => '其他角色');
  },

  // 流式中的显示副本：把变量回报块挡在气泡之外（落盘/解析在 _finish 里做，这里只为不上屏）。
  // 没启用变量条目时原样返回——不使用该功能的书逐字节与之前一致。
  _displayRaw(raw: string): string {
    try {
      const names = StatusVars.names('chat');
      if (names.length === 0) return raw;
      return stripStatusBlocks(raw, names);
    } catch (e) { return raw; }
  },

  _bubbleHtml(m: ChatMsg): string {
    // 作者的输入：像"戏里的一句"（带引号/括号，或以「我」/角色名打头）就渲染成主角气泡（靠右）；
    // 其余（长句要求、场景说明）渲染成一行淡色文字——不再有「导演」标签，也没有模式切换按钮。
    if (m.kind === 'director' || (m.kind === 'author' && !this.authorLooksInCharacter(m.raw))) {
      return '<div class="chat-note">' + nl2br(m.raw) + '</div>';
    }
    const name = this.protagonistName() || '我';
    const raw = this._fixMacros(m.raw);
    // 解析：作者发言按"用户规则"（裸文本=台词、（）=动作），AI 演出按"输出规则"（非引号=淡色）
    const bubbles: Bubble[] = raw.trim()
      ? parseBubbles(raw, m.kind === 'author'
        ? { ...this.parseOpts(), bareIsSay: true, defaultSpeaker: name }
        : { ...this.parseOpts(), defaultSpeaker: null })
      : [];
    const mine = m.kind === 'author';
    let out = '';
    if (bubbles.length === 0) {
      // 两种"空"要分开：真·空回复 vs **流式占位**（模型还在思考、第一个字还没吐出来）。
      // 用户实测反馈：第一轮思考久（推理模型先思考 20 秒很正常），这期间挂着「（这一轮没有内容）」
      // 像是这一轮白跑了——其实只是在想。占位期间显示思考状态（与顶部状态行同一句话）。
      out += m.id === '_streaming'
        ? '<div class="chat-note chat-waiting">' + esc(this._status || REASONING_HINT) + '</div>'
        : '<div class="chat-note">（这一轮没有内容）</div>';
    }
    // 同一角色连续输出合并成一个气泡（一个角色一段戏只有一条气泡，不再一句一条）
    const merged: Bubble[] = [];
    bubbles.forEach(b => {
      const prev = merged[merged.length - 1];
      if (prev && prev.speaker === b.speaker) {
        // 合并的是模型**各自一行**的输出（每行都带「说话人：」）→ 之间要断行，
        // 否则同一角色的旁白与台词会被挤在同一行（截图实测：`她把手插回兜里。 人家让我转交…`）
        const add = b.blocks.slice();
        if (add.length > 0 && !add[0].nlBefore) add[0] = { ...add[0], para: true };
        prev.blocks = prev.blocks.concat(add);
      } else merged.push({ speaker: b.speaker, known: b.known, blocks: b.blocks.slice() });
    });
    merged.forEach(b => {
      const speaker = b.speaker === null ? NARRATOR : b.speaker;
      // 块之间按原文连排，但**说话与非说话要分段**（2026-09-25 用户："说话的内容和非说话的内容要
      // 分段，不要直接连着"）：nlBefore = 原文里真有换行，para = 台词/旁白的切换处（解析层加的）。
      // 以前块之间一律不换行，同一行里颜色突然从深变淡，看着像染色出错；而 1.5.97.36 之前是
      // 块块都补 <br>（行内动作被硬拆、新行以标点开头）——现在是"只在类型切换处换行 + 标点并入上一块"。
      const blocks = b.blocks.map((x, i) => (i > 0 && (x.nlBefore || x.para) ? '<br>' : '') + (x.type === 'say'
        ? '<span class="chat-say">' + nl2br(x.text) + '</span>'
        : '<span class="chat-act">' + nl2br(x.text) + '</span>')).join('');
      // 旁白：不带「白」头像/名字，直接一行淡色文字（用户反馈：不要那个标签更好看）
      if (speaker === NARRATOR) {
        out += '<div class="chat-narr">' + blocks + '</div>';
        return;
      }
      const isMe = mine || this._isSelf(speaker);
      const av = this.avatar(speaker);
      const avatarHtml = av.src
        ? '<img class="chat-av" src="' + esc(av.src) + '" onclick="ChatMode.openProfile(\'' + esc(speaker) + '\')" alt="">'
        : '<div class="chat-av chat-av-txt" style="background:' + av.color + '" onclick="ChatMode.openProfile(\'' + esc(speaker) + '\')">' + esc(av.initial) + '</div>';
      out += '<div class="chat-row' + (isMe ? ' chat-row-me' : '') + '">' + avatarHtml +
        '<div class="chat-main">' +
        '<div class="chat-name">' + esc(speaker) + '</div>' +
        '<div class="chat-bubble">' + blocks + '</div>' +
        '</div></div>';
    });
    // 尾部状态：截断 / 漂移。撤回不再挂在气泡上——挪到输入行左侧的 ↩（与写作页一致）
    const flags: string[] = [];
    if (m.truncated) {
      // 推理模型（doubao-seed 这类）的思考 token 与正文共用同一个输出额度：截断多半是思考吃掉的，
      // 说清楚"思考占了多少"用户才知道下一步该调什么（否则只会以为正文被砍了）。
      flags.push(m.reasoning
        ? '这一轮被截断了（思考已用掉约 ' + m.reasoning + ' 字额度，正文写不下了）——点「发送」接着往下演'
        : '这一轮被截断了（模型额度用完）——点「发送」接着往下演');
    }
    // 说明：这里原本还有一条「这一轮的格式没走对（台词没加引号）…」的提示，用户 2026-09-25 要求去掉
    // （对着读者/作者弹这种内部诊断很奇怪）。诊断本身仍然算、仍留在消息的 m.drift 上，只是不再显示——
    // 分色早就按引号自动处理了（整轮有引号时严格按引号，完全没引号时按内容兜底），用户无需知道。
    if (m.kind === 'ai' && m.id !== '_streaming' && m.words) {
      out += '<div class="chat-actions"><span class="chat-meta">' + esc(m.words + ' 字') + '</span></div>';
    }
    if (flags.length) out += '<div class="chat-warn">' + esc(flags.join('　')) + '</div>';
    return out;
  },

  _scrollToBottom(): void {
    const stream = document.getElementById('chatStream');
    if (stream) stream.scrollTop = stream.scrollHeight;
    this._syncScrollBottomBtn();
  },

  onScroll(): void {
    // 用户自己的滑动：只更新"回到底部"按钮的显隐，不做任何自动贴底
    this._syncScrollBottomBtn();
  },

  // 流式绘制：末尾那行可能还是"半截说话人前缀"（如「林」），先扣住不画，免得先落进上一个气泡再跳出来
  _streamTail(raw: string): string {
    const i = raw.lastIndexOf('\n');
    if (i < 0) return raw;
    const tail = raw.slice(i + 1);
    const opts = this.parseOpts();
    if (!tail.trim()) return raw;
    if (tail.length > 10) return raw;
    if (/[：:【】\s]/.test(tail)) return raw;
    const names = opts.roster.concat([NARRATOR]);
    const maybe = names.some(n => n.indexOf(tail) === 0 || tail.indexOf(n) === 0);
    return maybe ? raw.slice(0, i + 1) : raw;   // 连同换行一起扣住：留出"下一行即将开始"的位置
  },

  _paintStream(): void {
    const now = Date.now();
    if (now - this._lastPaint < 200) return;
    this._lastPaint = now;
    if (this._streamBookId !== this.bookId()) return;   // 别的书在跑，不画到这本书上
    this.render();
  },

  // ---------- 输入 ----------

  // 作者的输入是不是"戏里的一句"：带引号/括号，以「我」/角色名打头，或是一句短的口语台词。
  // 是 → 主角气泡（靠右）；不是（长句要求、场景说明）→ 一行淡色文字。
  // 没有模式切换按钮，靠这条规则自动分（用户要求：不要「给指令」按钮）。
  // 命中指令词（演到/让她/改成…）一律当要求，避免"演到她说出理由。"被当成台词。
  authorLooksInCharacter(raw: string): boolean {
    const t = String(raw || '').trim();
    if (!t) return false;
    if (/[「」『』“”（）()]/.test(t)) return true;
    if (/(演到|演完|接着|继续|让她|让他|改成|变成|换成|停在|不要|别|至少|大约|左右|字|场景|设定|下一轮|这轮|推进)/.test(t)) return false;
    const head = t.split(/[：:\n]/)[0];
    if (head && head.length <= 12 && (head === '我' || head === '主角' || this.roster().some(n => n && n !== '我' && (head === n || head.indexOf(n) === 0)))) return true;
    // 短、带句末语气（！？…）→ 当一句台词；其余当要求
    return t.length <= 30 && /[！？…～!?~]$/.test(t);
  },

  isSending(): boolean { return this._sending; },

  /**
   * 把作者刚写的那句放回输入框（只在输入框空着时）。
   * 作者输入不再显示在演出流里，所以"请求失败/没拿到内容"时必须回填——否则用户会觉得
   * 自己写的东西凭空没了（而且没有可撤回的一轮，↩ 也够不着）。
   */
  _restoreInstruction(text: string): boolean {
    const t = String(text || '').trim();
    if (!t) return false;
    const ta = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    if (!ta || String(ta.value || '').trim()) return false;
    ta.value = t;
    ta.style.height = 'auto';
    ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
    return true;
  },

  send(): void {
    if (this._sending) return;   // 生成中：停止走输入行旁边那颗红色停止键（与写作页一致）
    const ta = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const text = ta ? String(ta.value || '').trim() : '';
    if (ta) { ta.value = ''; ta.style.height = ''; }
    void this.generate(text);
  },

  stop(): void {
    try { APIHandler.abort?.(); } catch (e) { /* ignore */ }
    this._status = '已停止';
    this._renderHead();
  },

  // ---------- 提示词 ----------

  lengthWords(): number | null {
    const p = PresetManager.getCurrentPreset();
    const mods = (p && (p as any).promptModules) || [];
    for (const m of mods) {
      if (!m || !m.enabled) continue;
      const hit = /约\s*(\d{3,5})\s*字/.exec(String(m.content || ''));
      if (hit) return Number(hit[1]);
    }
    return null;   // 预设没写字数就不给数字：长度完全由预设决定（用户要求，别由软件兜底）
  },

  buildSystem(): string {
    // 组装对话模式的提示词：先把临时世界书切到对话模式那份（键名带 _chat；小说模式那份不参与）
    try { SettingSyncManager.setMode('chat'); } catch (e) { /* ignore */ }
    let sys = '';
    // 模块收集统一走 activeModules：启用 + 本模式生效（mode）+ 按 order；
    // role='user' 的模块不进 system（它们去用户消息尾部，见 buildUser 里的 tailText）。
    const mods = pickModules((PresetManager.getCurrentPreset() as any || {}).promptModules, 'chat');
    if (mods.length > 0) {
      sys = mods.filter((m: any) => moduleRole(m) === 'system').map((m: any) => m.content).join('\n\n');
    }
    if (!sys) sys = PresetManager.getActiveSystemPrompt();
    // 世界书：稳定块只放**原书条目原文**（比奇改过/停用/新增的一律去 user 区尾部的「临时修订」块，
    // 见 overlayCtx()）——比奇一改，前缀的字节不能动，否则后面（含整段演出记录）全部按 miss 计费。
    const wb = this.book();
    const origEntries: any[] = ((wb && wb.entries) || []).slice();
    const pick = selectInjectableEntries(origEntries, WB_INJECT_MAX_CHARS);
    let wbBlock = '';
    if (pick.kept.length > 0) {
      wbBlock = '## 世界书条目（必须严格遵守，不得违反）\n';
      pick.kept.forEach((e: any) => { wbBlock += '### [' + e.type + '] ' + e.name + '\n' + (e.content || '') + '\n\n'; });
    }
    // 初始条目：正文与演出记录都还空着时才注入（开局状态）
    const logEmpty = this.log().length === 0;
    const bodyEmpty = !((wb && wb.chapters) || []).some((ch: any) => String(ch.content || '').replace(/<[^>]*>/g, '').trim().length > 0);
    if (logEmpty && bodyEmpty) {
      // inject !== false：面板里关掉注入的「初始」条目不能注入（与小说模式同一条规则；
      // 2026-09-26 用户反馈：关掉初始条目后两边都还在注入——这条独立路径以前只看 type）
      const init = origEntries.filter((e: any) => e && e.type === '初始' && e.content && e.inject !== false);
      if (init.length > 0) {
        wbBlock += '## 故事初始状态\n';
        init.forEach((e: any) => { wbBlock += '### [' + e.type + '] ' + e.name + '\n' + e.content + '\n\n'; });
      }
    }
    if (this.thinkingLevelOff()) sys += '\n\n【深度思考已关闭】禁止进行任何显式思考/推理/分析过程，直接输出正文，不要输出任何思考内容、思维链或相关标签。';
    const fmt = chatFormatBlock({ roster: this.roster(), protagonist: this.protagonistName(), lengthWords: this.lengthWords() ?? undefined });
    return [sys, wbBlock, fmt].filter(Boolean).join('\n\n');
  },

  /**
   * 对话模式的临时世界书修订块（比奇的改动 + 停用标记 + 新增条目）。
   * 放在 user 区尾部（演出记录之后、作者指令之前）：变了只赔这一小块，且自带近端强调。
   * 关掉比奇 / overlay 为空时返回空串。
   */
  overlayCtx(): string {
    try {
      if (typeof SettingSyncManager === 'undefined' || !SettingSyncManager.isActive()) return '';
      SettingSyncManager.setMode('chat');
      const ov = SettingSyncManager.getOverlay();
      const orig: any[] = ((this.book() || {}).entries) || [];
      const byId: Record<string, any> = {};
      orig.forEach((e: any) => { if (e && e.id) byId[e.id] = e; });
      let out = '';
      // 改过的条目：带最终内容。原书里已经没有这条（被删掉、或改名后被重建）→ 这条临时修订是孤儿，
      // 直接跳过——否则会拿内部 id 当条目名塞进提示词（2026-09-25 一致性检查发现）
      Object.keys(ov.modified || {}).forEach((id: string) => {
        const src = byId[id];
        if (!src) return;
        const m = (ov.modified || {})[id] || {};
        const name = m.name || (src && src.name) || id;
        const type = m.type || (src && src.type) || '其他';
        const content = (typeof m.content === 'string') ? m.content : ((src && src.content) || '');
        if (!content) return;
        out += '### [' + type + '] ' + name + '\n' + content + '\n\n';
      });
      // 停用：原文留在上面的稳定块里不动，这里只说明它失效（原书里已没有这条 → 孤儿，跳过）
      (ov.disabled || []).forEach((id: string) => {
        const src = byId[id];
        if (!src) return;
        out += '### [' + ((src && src.type) || '其他') + '] ' + ((src && src.name) || id) +
          '\n（本条已临时停用：视作不存在，不要再使用它的设定）\n\n';
      });
      // 新增条目
      (ov.added || []).forEach((e: any) => {
        if (!e || !e.content) return;
        if (e.inject === false) return;    // 只为登记头像/名单的临时角色（inject=false）：不进提示词
        out += '### [' + (e.type || '其他') + '] ' + (e.name || '（未命名）') + '\n' + e.content + '\n\n';
      });
      if (!out) return '';
      return '## 世界书条目·临时修订（本次演出生效，优先于上面的原书条目）\n' + out;
    } catch (e) { return ''; }
  },

  thinkingLevelOff(): boolean {
    try { return typeof App.thinkingLevel === 'function' && App.thinkingLevel() === 'off'; } catch (e) { return false; }
  },

  // 演出记录注入块：**append-only 水位线**（缓存）。
  // 旧实现取"最后 6000 字"——块首每轮都往后滑一点，前缀缓存就断在块的第一个字节，
  // 于是整个 user 消息（含演出记录）永远 miss，只剩 system 命中。
  // 现在记一个起点下标（每本书一个），只包含 [from, end)：起点固定 → 每轮只往末尾追加，
  // 缓存能一路命中到上一轮结尾；攒到 1.5 倍目标长度才把起点往前推一次（那一轮本来就整段重写）。
  _ctxFromKey(): string { return 'chatCtxFrom_' + (this.bookId() || 'none'); },
  // 演出记录里只放"演出"：作者输入是当轮的指令（在 user 消息末尾另发一次），不进历史上下文——
  // 与小说模式一致（正文里没有作者的要求），也避免模型把上一轮的要求再演一遍。
  _msgPiece(m: ChatMsg): string {
    return m.kind === 'ai' ? m.raw : '';
  },
  // 演出记录的目标长度（字）：按模型预算算（预算 = 可用上下文 − 系统块 − 世界书 − 尾部）。
  // 系统块要现算一次（预设 + 原书世界书 + 格式块），失败就退回兜底值。
  _ctxChars(): number {
    try {
      const sys = this.buildSystem().length;
      const budget = windowFromContext({
        contextTokens: App._modelContextTokens(),
        worldBookChars: sys + 4000,   // 系统块 + user 尾部（临时修订/作者/目标）
      });
      if (!(budget > 0)) return CTX_CHARS_FALLBACK;
      return Math.max(CTX_CHARS_MIN, Math.min(budget, CTX_CHARS_HARD_CAP));
    } catch (e) { return CTX_CHARS_FALLBACK; }
  },
  recentContext(): string {
    const target = this._ctxChars();
    const all = this.log();
    let from = Number(smGet(this._ctxFromKey(), 0)) || 0;
    if (!(from >= 0) || from > all.length) from = 0;
    const build = (f: number) => {
      const parts: string[] = [];
      for (let i = f; i < all.length; i++) {
        const piece = this._msgPiece(all[i]);
        if (piece) parts.push(piece);
      }
      return parts.join('\n\n').trim();
    };
    let out = build(from);
    if (out.length > target * 1.5) {
      // 超阈值：把起点推到"剩下的正好 ≤ 目标长度"，落盘（下一轮从这里开始，又是一次纯追加）
      let f = from;
      while (f < all.length && build(f).length > target) f++;
      if (f > from) { from = f; smSet(this._ctxFromKey(), f); out = build(from); }
    }
    return out;
  },

  buildUser(instruction: string): string {
    const ctx = this.recentContext();
    const n = this.lengthWords();
    const parts: string[] = [];
    if (ctx) parts.push('## 演出记录（按时间先后，最后一条离现在最近）\n' + ctx);
    // 临时世界书修订块：之后变也只赔这一块（在演出记录后面 = 不拖累历史命中）
    const ovCtx = this.overlayCtx();
    if (ovCtx) parts.push(ovCtx);
    parts.push('【作者】' + (instruction || '（没有新要求，接着往下演）'));
    // 预设的尾部模块（role='user'）+ 思考要求兜底：插在【作者】之后、【格式】之前。
    // 位置是实测定的：思考块放到【格式】之后（=最末尾）会把格式契约压掉——同一批实验里
    // 27 轮有 9 轮整场台词丢引号；放在【格式】之前 → 漂移 3/18，与现状 2/12 持平（见 preset.ts 注释）。
    try {
      const _cfg: any = PresetManager.getActiveAPIConfig ? PresetManager.getActiveAPIConfig() : {};
      const _tail = PresetManager.tailText('chat', {
        thinkingOff: this.thinkingLevelOff(),
        nativeReasoning: hasNativeReasoning(String((_cfg && _cfg.model) || '').toLowerCase())
      });
      if (_tail) parts.push(_tail);
    } catch (e) { /* 尾部模块失败不影响演出 */ }
    // 世界书「变量」（一个条目 = 一个变量）：格式契约 + 变量说明 + 当前值。
    // 放在【格式】之前：收尾那两句是实测保命契约（把别的块塞到它们后面会掉引号，见上），
    // 变量块不跟它们抢末尾。没有启用中的变量条目时 block() 返回空串 —— 零变化。
    try {
      const _varBlk = StatusVars.block('chat');
      if (_varBlk) parts.push(_varBlk);
    } catch (e) { /* 变量块失败不影响演出 */ }
    // 格式重申放最末尾：与字数一样，只写在 system 里命中率会掉（实测），贴在用户消息尾部最有效。
    // 两句都是重灾区：漏引号 → 台词被当动作（淡色）；旁白忘了写「白：」→ 会被算在上一个角色头上。
    // 2026-09-25：分色规则改成"引号=台词、没引号=叙述"，所以这里把契约再钉一遍（含单字/短回应和心声）。
    parts.push('【格式】行首写「说话人：」；旁白单独一行写「白：」；**说出口的话一律用「」包住**（含「嗯。」这类单字/短回应，漏引号会被当成动作）；没说出口的（动作、心理、心声、环境）一律不加引号。');
    if (n) parts.push('【本轮目标】约 ' + n + ' 字。不足 ' + n + ' 字算没写完，不要提前收尾。');
    return parts.join('\n\n');
  },

  buildMessages(instruction: string): Array<{ role: string; content: string }> {
    const msgs = [
      { role: 'system', content: this.buildSystem() },
      { role: 'user', content: this.buildUser(instruction) },
    ];
    try {
      const ex = (globalThis as any)._expandSTInMessages;
      // 世界书/预设里的酒馆宏（{{user}}/{{addvar}}/{{lastUserMessage}} 等）：
      // lastUserMessage 传本轮作者要求（预设里 <dreamer_input>{{lastUserMessage}}</dreamer_input> 靠它填）
      if (typeof ex === 'function') ex(msgs, { lastUserMessage: instruction });
    } catch (e) { /* 宏展开失败不影响生成 */ }
    return msgs;
  },

  // ---------- 生成 ----------

  async generate(instruction: string): Promise<void> {
    if (this._sending) return;
    // 本轮属于对话模式：临时世界书写到 settingOverlay_<书ID>_chat（与小说模式各存各的）
    try { SettingSyncManager.setMode('chat'); } catch (e) { /* ignore */ }
    if (instruction) {
      // 作者输入**不显示**在演出流里（用户要求：读者只看到 AI 整理过的演出，像小说模式那样）：
      // 记 hidden 留在记录里，只为"撤回时把当轮要求放回输入框"，以及当轮随 user 消息发给模型。
      this.append('author', instruction, { hidden: true });
    }
    this._lastInstruction = instruction;
    this._sending = true;
    this._acc = '';
    this._reasoningChars = 0;
    this._streamBookId = this.bookId();
    this._status = REASONING_HINT;
    // 用户要求：流式输出**不要自己滚动**，完全按用户自己的滑动来。
    // 只有"用户刚做了一个动作"才贴一次底（发一条、撤回、换书），之后输出再多也不动。
    this._scrollOnce = true;
    this._lastPaint = 0;
    this.render();
    // 本轮用量记账：对话模式与小说模式一样，演出完成/失败都要留一条记录
    // （以前这里没有 begin/end，演出轮的 token 根本不算进「用量统计」）
    try { UsageStats.beginSession(); } catch (e) { /* 记账失败不影响演出 */ }

    const msgs = this.buildMessages(instruction);
    let finishReason: string | null = null;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      try {
        // void：这一版的承诺由回调驱动（done()），外面已经在 await 这个 Promise 了
        void APIHandler.fetchCompletions(
          msgs as any,
          (chunk: string) => {
            this._acc += String(chunk || '');
            if (this._streamBookId !== this.bookId()) return;   // 切书后台跑：不画，回来自会补
            this._status = '';
            this._paintStream();
          },
          (full: string | null, aborted?: boolean, reasoning?: string) => {
            if (reasoning && String(reasoning).trim()) this._reasoningChars = String(reasoning).replace(/\s/g, '').length;
            this._finish(full, !!aborted, finishReason);
            done();
          },
          (err: string) => {
            this._sending = false;
            this._status = '';
            this._acc = '';
            this.render();
            try { UsageStats.endSession(0); } catch (e) { /* ignore */ }
            const back = this._restoreInstruction(instruction);
            try { App.toast('请求失败：' + err + (back ? '（刚才那句已放回输入框）' : '')); } catch (e) { /* ignore */ }
            done();
          },
          {
            callLabel: 'chat',
            maxTokens: 65535,      // 推理模型会先花掉大量思考 token：绝不能按字数估（实测 2500 档被 12000 截断）
            onReasoning: (chunk: string) => {
              this._reasoningChars += String(chunk || '').length;
              if (this._streamBookId === this.bookId()) {
                this._status = REASONING_HINT + '（已想 ' + this._reasoningChars + ' 字）';
                this._renderHead();
              }
            },
            onFinishReason: (r: string | null) => { finishReason = r; },
            timeout: 600000,
          }
        );
      } catch (e: any) {
        this._sending = false;
        this._status = '';
        this.render();
        try { UsageStats.endSession(0); } catch (e2) { /* 记账失败不影响提示 */ }
        try { App.toast('请求异常：' + String((e && e.message) || e)); } catch (e2) { /* ignore */ }
        done();
      }
    });
  },

  // 收尾：剥思考块 → 存原文 → 诊断（截断 / 漂移）
  _finish(full: string | null, aborted: boolean, finishReason: string | null): void {
    let raw = String(full != null ? full : this._acc || '');
    try {
      const split = (globalThis as any)._splitThinkingBlocks;
      if (typeof split === 'function') { const s = split(raw); if (s && typeof s.body === 'string') raw = s.body; }
    } catch (e) { /* ignore */ }
    raw = raw.replace(/^\s*#{1,3}\s+.*$/gm, '').trim();   // 模型偶尔仍带章节标题行
    // 世界书「变量」（一个条目 = 一个变量）：剥掉正文之后的 <status> 回报块、把值收进「变量」面板。
    // 快照先取（本轮之前的值）——撤回这一轮时用它把变量一起回退。
    let statusPrev: any = null;
    try {
      statusPrev = StatusVars.snapshotMode('chat');
      raw = StatusVars.capture('chat', raw);
    } catch (e) { /* 变量收集失败不影响落库 */ }
    this._sending = false;
    this._status = '';
    this._acc = '';
    // 落库目标：这一轮开始时的那本书；拿不到（例如异常路径）就退回当前书
    const bookIdAtStart = this._streamBookId || this.bookId();
    this._streamBookId = '';
    if (aborted) { try { UsageStats.endSession(0); } catch (e) { /* ignore */ } this.render(); return; }
    const _reasoning = this._reasoningChars || 0;
    if (!raw) {
      // 一条都没写出来时把"是不是额度被思考吃掉了"说清楚：推理模型的思考与正文共用输出额度，
      // 思考跑满就一个字都写不出来（用户实测场景）。不然用户只会以为是随机抽风。
      const _cut = finishReason === 'length' || finishReason === 'max_tokens';
      const back = this._restoreInstruction(this._lastInstruction);   // 输入不再显示，没写出来就回填
      try { UsageStats.endSession(0); } catch (e) { /* 记账失败不影响提示 */ }
      try {
        App.toast((_cut && _reasoning > 0
          ? '额度被思考吃满了（已想约 ' + _reasoning + ' 字），正文一个字没写出来：再点「发送」重试，反复如此就把「思考强度」调到最低或换个模型'
          : (_reasoning > 0
            // 用户实测（commandcode 端点）：模型有时把整轮都花在思考上、正文为空但 finish=stop，
            // 看着像"随机抽风"——把"只出了思考"说清楚，才知道下一步该重试还是调思考强度
            ? '模型只输出了思考（已想约 ' + _reasoning + ' 字）、没写正文：再点「发送」重试；反复如此就把「思考强度」调低或换个模型'
            : '这一轮没有拿到内容（可能被截断或模型返回空），可以点「发送」重试'))
          + (back ? '（刚才那句已放回输入框）' : ''));
      } catch (e) { /* ignore */ }
      this.render();
      return;
    }
    // 诊断：格式漂移 / 台词没加引号（**内部诊断，不再显示给用户**；分色由解析器按引号自动处理）
    let drift = false;
    let words = 0;
    try {
      const rep = analyzeParse(raw, { ...this.parseOpts(), defaultSpeaker: null });
      drift = rep.notes.some(n => n.indexOf('格式漂移') >= 0 || n.indexOf('台词未加引号') >= 0);
      words = rep.sayChars + rep.actChars;
    } catch (e) { /* 诊断失败不影响落库 */ }
    this._appendToBook(bookIdAtStart, 'ai', raw, {
      truncated: finishReason === 'length' || finishReason === 'max_tokens',
      drift,
      words,
      reasoning: _reasoning || undefined,
      statusPrev: statusPrev || undefined,
    });
    // 本轮用量记账收尾（字数就是这次演出的净字数；token 由 APIHandler 内记）
    try { UsageStats.endSession(words); } catch (e) { /* 记账失败不影响落库 */ }
    // 演出的记忆：进数据库**对话模式那一份**（与小说模式各存一份；没开数据库插件时自动跳过）
    try {
      const _DB = (globalThis as any).DatabaseManager;
      if (_DB && typeof _DB.isEnabled === 'function' && _DB.isEnabled()) {
        void App.fillMemoryTable(this.recentContext().slice(-3000), 'chat');
      }
    } catch (e) { /* 填表失败静默：与小说模式一致 */ }
    // 演出进归档（回读/检索用）：必须在这条落库之后，否则本轮内容要等到下一轮才归档
    if (bookIdAtStart === this.bookId()) { void this.syncArchive(); this.render(); }
  },

  // 输入行左侧那颗 ↩：撤回最近一轮演出（与写作页的撤回同一个位置、同一套语义）
  undoLast(): void {
    const all = this.log();
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].kind === 'ai') { this.undo(all[i].id); return; }
    }
    try { App.toast('还没有可以撤回的演出'); } catch (e) { /* ignore */ }
  },

  // 撤回指定的一轮（由 undoLast 调用）：本轮的演出记录整条去掉，作者当轮写的要求放回输入框。
  // 输入框里的旧内容会被覆盖前先确认——避免把用户正在打的东西弄丢。
  undo(id: string): void {
    if (this._sending) { try { App.toast('正在生成中，先等这一轮结束'); } catch (e) { /* ignore */ } return; }
    const all = this.log();
    const idx = all.findIndex(m => m.id === id);
    if (idx < 0 || all[idx].kind !== 'ai') return;
    let cut = idx;
    const prev = idx > 0 ? all[idx - 1] : null;
    const restore = (prev && (prev.kind === 'author' || prev.kind === 'director')) ? prev.raw : '';
    if (prev && (prev.kind === 'author' || prev.kind === 'director')) cut = idx - 1;
    const ta = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    const doUndo = () => {
      this._saveLog(all.slice(0, cut));       // 本轮之前的所有记录保留
      // 世界书「变量」：这一轮回报的值一起回退（否则面板会留着"未来"的值）
      try { StatusVars.restoreMode('chat', all[idx].statusPrev || null); } catch (e) { /* ignore */ }
      if (ta) { ta.value = restore; ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; }
      this._scrollOnce = true;                 // 撤回是用户主动动作：贴到底看撤回后的尾部
      this.render();
    };
    // 覆盖未发送内容时的确认：与清空/重置同款，用应用内确认框（系统 confirm 在 App 里很出戏）
    if (ta && String(ta.value || '').trim() && restore) {
      try {
        if (typeof UIManager !== 'undefined' && UIManager && typeof UIManager.showConfirm === 'function') {
          UIManager.showConfirm('输入框里还有没发出去的内容，撤回会覆盖它，继续？', doUndo);
          return;
        }
      } catch (e) { /* 退回系统确认 */ }
      if (!confirm('输入框里还有没发出去的内容，撤回会覆盖它，继续？')) return;
    }
    doUndo();
  },

  // ---------- 演出 → 连续正文文本（记忆/归档用；不提供界面入口）----------
  // 剥掉说话人前缀，保留「」台词与动作/心理原文。
  toProseText(id?: string): string {
    const all = this.log();
    const list = id ? all.filter(m => m.id === id) : all;
    return list.filter(m => m.kind === 'ai').map(m => {
      const body = stripSpeakerPrefixes(m.raw, { ...this.parseOpts(), defaultSpeaker: null });
      return body.replace(/\n{3,}/g, '\n\n').trim();
    }).join('\n\n');
  },

  // ---------- 记忆：演出记录进归档（回读/检索用）----------
  // 只把"演出文本"追加进本书的归档块（ArchiveStore 按书分键），**不动水线窗口**——
  // 水线的 x/块假设"文本只在末尾增长"，把对话插进正文中间会让它对不齐；
  // 而归档检索是纯内容匹配，不依赖顺序，所以对话从归档进来就能被回读捞到。
  // 增量：已归档的消息 id 记在 storage（chatArchivedUpTo_<书ID>），切书回来会补同步。
  //
  // 两个坑（都踩过，实测症状是"归档里一条对话都没有"）：
  //   ① ArchiveStore 启动时异步从 IndexedDB 载入归档态，写早了会被随后载入的快照覆盖
  //      → 先 await `_idbReady`；
  //   ② 记账必须在写入**成功之后**，否则一次失败就永远不再重试。
  async syncArchive(): Promise<void> {
    const id = this.bookId();
    const wb = this.book();
    if (!id || !wb) return;
    const aiMsgs = this.log().filter(m => m.kind === 'ai' && String(m.raw || '').trim());
    if (aiMsgs.length === 0) return;
    const key = 'chatArchivedUpTo_' + id;
    const done = smGet<string[]>(key, []) || [];
    const fresh = aiMsgs.filter(m => done.indexOf(m.id) < 0);
    if (fresh.length === 0) return;
    const A = (globalThis as any).ArchiveStore;
    if (!A || typeof A.addBlocks !== 'function') return;
    const ready = A._idbReady;
    if (ready && typeof ready.then === 'function') { try { await ready; } catch (e) { /* 载入失败也继续，走内存 */ } }
    const chunks: string[] = [];
    fresh.forEach(m => {
      const body = stripSpeakerPrefixes(m.raw, { ...this.parseOpts(), defaultSpeaker: null }).replace(/\n{3,}/g, '\n\n').trim();
      if (!body) return;
      // 与滚动归档同量级的块（900 字），避免单块过大拖慢检索
      for (let i = 0; i < body.length; i += 900) chunks.push(body.slice(i, i + 900));
    });
    if (chunks.length > 0) {
      try { A.addBlocks(chunks, 900); }
      catch (e) { console.warn('[Chat] 归档写入失败（不记账，下次再试）', e); return; }
    }
    smSet(key, done.concat(fresh.map(m => m.id)).slice(-1000));
  },

  // ---------- 换书 ----------

  switchBook(id: string): void {
    if (this._sending) { try { App.toast('正在生成中，切书会中断这一轮'); } catch (e) { /* ignore */ } }
    try { BookManager.switchBook(id); } catch (e) { console.warn('[Chat] 切书失败', e); }
    this._loadedBookId = '';
    this.reload();
  },

  // 初始化（view 绑定一次）
  init(): void {
    const stream = document.getElementById('chatStream');
    if (stream && !(stream as any).__bound) {
      (stream as any).__bound = true;
      stream.addEventListener('scroll', () => this.onScroll());
    }
    // 输入框自动增高：和写作页共用同一套实现（lib/inputgrow —— 空值不吃 placeholder 的折行高度，
    // 这是"删光了输入框还是好几行高"的真因）。回车发送仍在 HTML 内联 onkeydown 上，不在这里绑。
    const ta = document.getElementById('chatInput') as HTMLTextAreaElement | null;
    if (ta && !(ta as any).__growBound) { (ta as any).__growBound = true; bindAutoGrow(ta); }
    // 选书也不再在这里渲染：两种模式共用顶部的「书名 ▾」，切书由 UIManager.switchWorldBook 调 reload()。
    this.reload();
  },
};

declare global {
  interface Window { ChatMode: typeof ChatMode }
}
try { (globalThis as any).ChatMode = ChatMode; } catch (e) { /* ignore */ }

export default ChatMode;
