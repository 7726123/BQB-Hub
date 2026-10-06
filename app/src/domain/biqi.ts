// BiqiAgent：插件「比奇」（widget, shell='biqi'）。
// 形态：正文页工具栏的「比奇」按钮 → 内容区上半屏对话窗（只有 ✕ 能关，下半屏正文照常滑动）。
// 能力：ReAct 工具循环，可读世界书（原书 + 临时层的合并视图）与最近正文（与续写注入同源），
//      可增/改/删临时世界书条目——立即生效，原书零触碰。
// 落盘路径：改动包成 DeltaOp 交给 SettingSyncManager.applyApproved（同一套语义：改名并入、
//      add 命中已有条目转更新、删原书条目走软删除），因此自带快照，可直接用「回滚上一批」撤回。
// 生图：主机（用户电脑上的 ComfyUI，协议见 domain/imagehost.ts）在线时给 draw_image 工具，
//      交互策略与写卡 Agent 不同——作者明确让画就直接画，不反问（用户 2026-10-05 定的）。
import { SM } from '../infra/gate';
import { PluginManager } from './plugins';
import { SettingSyncManager } from './settingsync';
import { WorldBookManager } from './worldbook';
import { renderMdStrong } from '../lib/mdtext';
import { probeHost, drawImageToStore, genImagesHtml, imageLabel, hydrateImages, lookAtImageTool, type HostStatusCache } from './imagedraw';
import { ImageCache } from '../lib/imagecache';
import { visionState, lookAtImageTracked } from '../lib/vision';

export interface BiqiMessage { role: 'user' | 'assistant'; content: string; _steps?: string[]; imageIds?: string[] }

// 比奇预设的存储键：**小说模式与对话模式共用一份**（键里不带模式）——
// 用户改过就用改的、没改过用内置默认 BIQI_SYSTEM（跟着软件更新走）。
export const BIQI_PRESET_KEY = 'biqiPresetText';

export const BIQI_SYSTEM =
  '你是「比奇」，这本书的设定管家。作者会和你讨论剧情接下来怎么走，你负责据此维护**临时世界书**。\n' +
  '临时世界书是叠在原书之上的设定层：可以改条目内容、停用条目、新增条目，原书永远不动，改动随时可回滚。\n\n' +
  '【工作方式】\n' +
  '1. 先看清楚再动手：涉及设定判断时，先调用 read_worldbook 看当前生效的条目，先调用 read_story 看最近正文（两者都是续写时真实注入的内容）。\n' +
  '2. 讨论和修改是两件事：作者只是问看法时，直接给分析和建议，不要改东西；作者认可要改、或明确让你改时，才调用写入工具。\n' +
  '3. 每次写入都自己拿主意：update_entry 必须给该条目的**完整最终内容**（旧文 + 新设定整合后的全文，不是只给改动片段），名称要写准。\n' +
  '4. 只收「跨场景长期成立的设定」：身份、能力、关系、势力、地理与力量体系、长期目标。一次性的情节事件（谁去了哪、说了什么、这章发生了什么）不进世界书。\n' +
  '5. 改动完成后，用一两句话说明「改了什么、为什么」，必要时给作者一个继续讨论的方向。不要复述整份条目全文。\n' +
  '6. 你只动临时世界书，不碰原书；也不要声称改不了——新增/修改/停用都在你的权限内。\n' +
  '8. 用中文回答，语气像一起写书的搭档：具体、克制、不说教。';

// ── 面板高度（拖动胶囊 / 键盘模式）────────────────────────────────────────
// 高度用"占 #editor-wrap 的比例"表示：默认半屏；拖过 90% 吸附成整屏；输入中（软键盘弹出时）
// WebView 已被 adjustResize 压成"键盘以上的可见区域"，此时占满 100% 就等于满可视区。
export const BIQI_MIN_RATIO = 0.25;
export const BIQI_MAX_RATIO = 0.9;
export const BIQI_SNAP_RATIO = 0.9;     // 拖过它就吸附整屏
export const BIQI_UNSNAP_RATIO = 0.88;  // 整屏后往回拖，低于它就解除吸附（留 2% 回差防抖）
export const BIQI_DEFAULT_RATIO = 0.5;

// 拖动一次的结果：输入起始比例/起始是否整屏、手指位移、容器高度 → 输出新的比例与吸附状态。
// 纯函数，便于单测（容器高度为 0 或位移非有限值时原样返回）。
export function biqiResolveDrag(startRatio: number, startSnapped: boolean, dy: number, containerH: number):
  { ratio: number; snapped: boolean } {
  if (!(containerH > 0) || !isFinite(dy)) return { ratio: startRatio, snapped: startSnapped };
  const r = (startSnapped ? 1 : startRatio) + dy / containerH;
  if (startSnapped) {
    if (r < BIQI_UNSNAP_RATIO) {
      return { ratio: Math.max(BIQI_MIN_RATIO, Math.min(BIQI_MAX_RATIO, r)), snapped: false };
    }
    return { ratio: BIQI_MAX_RATIO, snapped: true };
  }
  if (r > BIQI_SNAP_RATIO) return { ratio: BIQI_MAX_RATIO, snapped: true };
  return { ratio: Math.max(BIQI_MIN_RATIO, Math.min(BIQI_MAX_RATIO, r)), snapped: false };
}

const BIQI_MAX_ROUNDS = 4;
const STORY_CHAR_LIMIT = 6000;

interface ToolCall { id?: string; name: string; arguments?: Record<string, unknown> }

export const BiqiAgent: {
  messages: BiqiMessage[];
  _isSending: boolean;
  _status: string;
  _steps: string[];
  _open: boolean;
  _mode: 'novel' | 'chat';
  setMode(m: 'novel' | 'chat'): void;
  panelHost(host: 'novel' | 'chat'): void;
  _loadedKey: string;
  _ratio: number;          // 常态高度比例（不持久化：每次开窗回到半屏）
  _snapped: boolean;       // 是否吸附成整屏
  _kbOpen: boolean;        // 输入中（软键盘/输入框聚焦）→ 面板占满可视区
  isEnabled(): boolean;
  _applyHeight(): void;
  _clampForKeyboard(): void;
  _bindPanel(): void;
  _setKbMode(on: boolean): void;
  _scrollMessagesToBottom(): void;
  _historyKey(): string;
  init(): void;
  reloadForBook(): void;
  render(): void;
  toggle(): void;
  open(): void;
  close(): void;
  clear(): void;
  renderMessages(): void;
  _save(): void;
  send(): void;
  _runLoop(userText: string): Promise<void>;
  _sendTurn(msgs: unknown[], onPartial?: (text: string) => void): Promise<{ text: string; tools: ToolCall[] | null; err?: string }>;
  _tools(): unknown[];
  _executeTool(t: ToolCall): Promise<string>;
  _stepLine(t: ToolCall, out: string): string;
  _imageToolDraw(): unknown;
  _imageToolLook(): unknown;
  _toolLookImage(a: any): Promise<string>;
  _visionCheckNote(imgIds: string[], prompt: string): Promise<string>;
  _visionNoToast: boolean;
  _imageRuleMessage(): string;
  _refreshHostStatus(): Promise<void>;
  _toolDrawImage(a: any): Promise<string>;
  _genImages: Map<string, any>;
  _imgSeq: number;
  _imgGone: Set<string>;
  _hydrating: boolean;
  _drawToolsOn: boolean;
  _hostStatus: HostStatusCache;
  _applyOp(op: 'add' | 'mod' | 'del', target: string, content: string, reason: string, type?: string): { ok: boolean; text: string };
  readWorldbook(): string;
  _presetText(): string;
  openPresetModal(): void;
  closePresetModal(): void;
  savePreset(): void;
  resetPreset(): void;
  readStory(): string;
  openWorldbookPage(): void;
  _hydrateImages(): Promise<void>;
  viewImage(id: any): void;
} = {
  messages: [],
  _isSending: false,
  _status: '',
  _steps: [],
  _open: false,
  _mode: 'novel' as 'novel' | 'chat',   // 小说模式 / 对话模式各一份会话与临时世界书
  _loadedKey: '',   // 当前内存里的对话属于哪本书的存档键（换书时据此切会话）
  // 画图主机（本地 ComfyUI）：本会话生成的图片句柄 + 本地存档（lib/imagecache）。
  // 消息里只存 imageIds，不存图（768² 的 PNG base64 约 1MB，进消息会把存储撑爆）；
  // 重开 App 后句柄表是空的：渲染时按"激活书"从本地存档取回，取不到的才渲染成「已过期」（_imgGone）。
  _genImages: new Map<string, any>(), // id -> { full, thumb, seed, size, seconds, prompt, book }
  _imgSeq: 0,
  _imgGone: new Set<string>(), // 确认取不到的 id → 渲染成「已过期」，不再反复查
  _hydrating: false, // 水合进行中（防 renderMessages → 水合 → renderMessages 递归）
  _visionNoToast: false, // 「当前模型看不了图」只提示一次（每个实例一次）
  _drawToolsOn: false, // 本轮是否给 draw_image（= 主机已启用且在线的探测结果）
  _hostStatus: { at: 0, ok: false, model: '', hint: '' } as HostStatusCache, // 画图主机状态缓存（60 秒）
  _ratio: BIQI_DEFAULT_RATIO,
  _snapped: false,
  _kbOpen: false,

  // 面板宿主：小说模式挂在正文区（#editor-wrap），对话模式挂进对话页（#chatBody）。
  // 面板是绝对定位（top:0; height:50%），所以直接挪 DOM 节点即可，不需要两套实现；
  // 拖动改高度在拖动时读 parentElement.clientHeight，换宿主后自然按新容器算。
  panelHost(host: 'novel' | 'chat'): void {
    const panel = document.getElementById('biqiPanel');
    const target = document.getElementById(host === 'chat' ? 'chatBody' : 'editor-wrap');
    if (!panel || !target || panel.parentElement === target) return;
    // 挪窝前先收窗：半屏窗突然出现在另一个视图会很突兀
    if (this._open) { this._open = false; this._kbOpen = false; panel.classList.remove('open', 'kb-open', 'full'); }
    target.appendChild(panel);
  },

  isEnabled(): boolean {
    try { return typeof PluginManager !== 'undefined' && PluginManager.isEnabled('biqi'); } catch (e) { return false; }
  },

  // 对话按书隔离：换书不串台
  _historyKey(): string {
    let id = 'none';
    try { id = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || 'none'; } catch (e) { /* ignore */ }
    // 对话模式有自己的一份比奇会话（用户要求：两种模式不能共用同一个比奇）
    return 'biqiHistory_' + id + (this._mode === 'chat' ? '_chat' : '');
  },

  // 切换模式：先把当前会话存回它自己的键，再载入目标模式的会话。
  // 临时世界书 overlay 由 SettingSyncManager 按模式分键（那边 setMode 一次整套隔离）。
  setMode(m: 'novel' | 'chat'): void {
    const next = (m === 'chat') ? 'chat' : 'novel';
    if (next === this._mode) return;
    this._save();
    this._mode = next;
    try { SettingSyncManager.setMode(next); } catch (e) { /* ignore */ }
    this._loadedKey = '';
    this.reloadForBook();
    this.render();
  },

  init(): void {
    try {
      // 存档有两种历史写法：早先存 JSON 字符串、现在直接存数组——两种都认
      const raw = SM().get<unknown>(this._historyKey(), []);
      let h: unknown = raw;
      if (typeof raw === 'string') { try { h = JSON.parse(raw || '[]'); } catch (e) { h = []; } }
      this.messages = Array.isArray(h) ? (h as BiqiMessage[]).slice(-60) : [];
    } catch (e) { this.messages = []; }
    this._loadedKey = this._historyKey();
    this.render();
  },

  // 换书 → 换会话：先把当前对话存回它所属的那本书，再载入新书的对话。
  // 每本书的对话各自独立（键 biqiHistory_<书ID>），绝不串台。
  reloadForBook(): void {
    const key = this._historyKey();
    if (key === this._loadedKey) return;
    if (this._loadedKey && this.messages.length) {
      try { SM().set(this._loadedKey, this.messages); } catch (e) { /* ignore */ }
    }
    this._loadedKey = key;
    this._steps = [];
    this._status = '';
    let h: unknown = [];
    try {
      h = SM().get<unknown>(key, []);
      if (typeof h === 'string') { try { h = JSON.parse(h || '[]'); } catch (e) { h = []; } }
    } catch (e) { h = []; }
    this.messages = Array.isArray(h) ? (h as BiqiMessage[]).slice(-60) : [];
    if (this._open) this.renderMessages();
  },

  // 工具栏按钮显隐 + 插件关闭时收窗
  render(): void {
    const btn = document.getElementById('biqiToolbarBtn');
    const on = this.isEnabled();
    if (btn) btn.style.display = on ? 'flex' : 'none';
    const panel = document.getElementById('biqiPanel');
    if (panel && on) panel.classList.toggle('open', !!this._open);
    // 插件被关掉时收窗：键盘/整屏两个状态类一起清掉，避免下次开窗带着旧状态
    if (!on && this._open) { this._open = false; this._kbOpen = false; if (panel) panel.classList.remove('open', 'kb-open', 'full'); }
  },

  // 高度落地：常态按比例、吸附态整屏；键盘模式由 CSS 类接管（这里先清掉内联高度）
  _applyHeight(): void {
    const panel = document.getElementById('biqiPanel');
    if (!panel) return;
    panel.classList.toggle('full', this._snapped);
    panel.style.height = this._snapped ? '100%' : (Math.round(this._ratio * 100) + '%');
    if (this._kbOpen) this._clampForKeyboard();
  },

  // 键盘弹出后（WebView 被 adjustResize 压矮）：**保留用户设的比例**（用户要求，不再跳成整屏），
  // 只兜底一件事——按比例算出的高度若会让底部输入行落到键盘下面，就压到刚好看得见输入行为止。
  // 只压不涨；失焦时 _applyHeight() 会按比例恢复。
  _clampForKeyboard(): void {
    const panel = document.getElementById('biqiPanel');
    const wrap = panel && panel.parentElement;
    if (!panel || !wrap) return;
    if (typeof panel.getBoundingClientRect !== 'function') return;   // 测试桩/异常环境直接跳过
    const w = (typeof window !== 'undefined' ? window : null) as any;
    const vv = w && w.visualViewport;
    const visH = (vv && vv.height) ? Number(vv.height) : (w && w.innerHeight ? Number(w.innerHeight) : 0);
    if (!(visH > 0)) return;
    const top = Number(panel.getBoundingClientRect().top) || 0;
    const rowH = 64;                                   // 面板底部输入行（含内边距）的估算高度
    const maxH = Math.max(160, Math.round(visH - top - rowH - 8));
    if (Number(panel.getBoundingClientRect().height) > maxH) panel.style.height = maxH + 'px';
  },

  // 绑定胶囊拖拽（幂等）。拖动期间用 document 级 pointermove/pointerup，和列表拖拽同一套写法；
  // #biqiGrip 的 CSS 带 touch-action:none，纵向拖不会被当成滚动页面。
  _bindPanel(): void {
    const grip = document.getElementById('biqiGrip') as (HTMLElement & { __bound?: boolean }) | null;
    if (grip && !grip.__bound) {
      grip.__bound = true;
      grip.addEventListener('pointerdown', (e: any) => {
        if (this._kbOpen) return;                     // 输入中高度归键盘模式管
        const panel = document.getElementById('biqiPanel');
        const wrap = panel && panel.parentElement;
        const containerH = wrap ? wrap.clientHeight : 0;
        if (!containerH) return;
        e.preventDefault();
        // base* 是本次拖动的**固定基准**（起点比例 / 起点是否吸附 / 起点手指位置）：
        // 位移一律按 (当前 y - baseY) 算，中间**不能**改基准比例——否则位移会被算重
        // （实测：手指拖 160px 面板走 200px 以上，越拖越快，就是"不跟手"）。
        // 只有状态翻转（吸附 / 解除吸附）那一下才重设基准：以手指当前位置为新起点。
        let baseRatio = this._ratio;
        let baseSnapped = this._snapped;
        let baseY = Number(e.clientY) || 0;
        const onMove = (ev: any) => {
          const y = Number(ev.clientY) || 0;
          const next = biqiResolveDrag(baseRatio, baseSnapped, y - baseY, containerH);
          if (next.snapped !== baseSnapped) {
            // 翻转点：吸附态的内部基准是 1（整屏）；解除吸附时基准回到常态上限 90%，
            // 手指当前位置作为新起点（这样 100% → 90% 的视觉跳变最小，之后继续 1:1 跟手）
            baseSnapped = next.snapped;
            baseRatio = next.snapped ? 1 : BIQI_MAX_RATIO;
            baseY = y;
            this._ratio = BIQI_MAX_RATIO;
          } else {
            this._ratio = next.snapped ? BIQI_MAX_RATIO : next.ratio;
          }
          this._snapped = next.snapped;
          this._applyHeight();
        };
        const onEnd = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onEnd);
          document.removeEventListener('pointercancel', onEnd);
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onEnd);
        document.addEventListener('pointercancel', onEnd);
      });
    }
    const input = document.getElementById('biqiInput') as (HTMLElement & { __bound?: boolean }) | null;
    if (input && !input.__bound) {
      input.__bound = true;
      // 输入框聚焦 ≈ 软键盘弹出：面板占满可视区，列表拿回高度（并把最新上下文滚进视野）
      input.addEventListener('focus', () => this._setKbMode(true));
      input.addEventListener('blur', () => this._setKbMode(false));
    }
  },

  _setKbMode(on: boolean): void {
    this._kbOpen = !!on;
    const panel = document.getElementById('biqiPanel');
    if (panel) panel.classList.toggle('kb-open', this._kbOpen);
    this._applyHeight();   // 保留当前比例（不再变整屏）；比例过高时只压到看得见输入行
    if (this._kbOpen) {
      // 键盘弹起会改变可视高度（visualViewport 变矮），稍后再校准一次
      setTimeout(() => { if (this._kbOpen) this._applyHeight(); }, 300);
      this._scrollMessagesToBottom();
    }
  },

  _scrollMessagesToBottom(): void {
    const box = document.getElementById('biqiMessages');
    if (box) box.scrollTop = box.scrollHeight;
  },

  toggle(): void { if (this._open) this.close(); else this.open(); },

  open(): void {
    if (!this.isEnabled()) { App.toast('请先在「插件」页开启比奇'); return; }
    this.reloadForBook();
    this._open = true;
    const panel = document.getElementById('biqiPanel');
    if (panel) panel.classList.add('open');
    this.renderMessages();
    // 每次开窗回到半屏（比例不持久化：用户要求"一般打开后就是半屏"）
    this._ratio = BIQI_DEFAULT_RATIO;
    this._snapped = false;
    this._kbOpen = false;
    this._applyHeight();
    this._bindPanel();
    // 这里**不自动聚焦输入框**：聚焦会触发"输入中"模式（面板占满可视区），
    // 结果开窗就是整屏，和"打开后半屏、可拖 25%~90%、超 90% 才吸附整屏"的要求冲突（真机反馈）。
    // 用户点输入框时照旧进入"输入中"模式（软键盘弹出不被挤扁），失焦回到半屏。
  },

  close(): void {
    this._open = false;
    this._kbOpen = false;
    const panel = document.getElementById('biqiPanel');
    if (panel) panel.classList.remove('open', 'kb-open', 'full');
  },

  clear(): void {
    this.messages = [];
    this._steps = [];
    // 这次对话的图片存档一起删（用户明确要的："清空对话后这些图就可以删了"）；只删这本书的，别的书不动。
    const bid = String((typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || '');
    void ImageCache.delByBook(bid);
    for (const k of Array.from(this._genImages.keys())) {
      const g: any = this._genImages.get(k);
      if (String((g && g.book) || '') === bid) this._genImages.delete(k);
    }
    this._imgGone.clear();
    this._imgSeq = 0;   // 存档已删，图号从头排不会盖掉谁
    try { SM().set(this._historyKey(), []); } catch (e) { /* ignore */ }
    this.renderMessages();
  },

  renderMessages(): void {
    const box = document.getElementById('biqiMessages');
    if (!box) return;
    if (!this.messages.length) {
      box.innerHTML = '<div class="chat-empty">我是比奇，这本书的设定管家<br>聊聊接下来剧情该怎么走，或者让我把某段设定改掉；<br>改动只落在临时世界书，原书不动。<br>配好画图主机后，也可以直接说「画一张…」。</div>';
      return;
    }
    const self = this;
    box.innerHTML = this.messages.map(function (m, i) {
      const cls = m.role === 'user' ? 'chat-msg user' : 'chat-msg assistant';
      const thinking = self._isSending && i === self.messages.length - 1 && m.role === 'assistant';
      const raw = String(m.content || '');
      const imgHtml = genImagesHtml(self._genImages, m, 'BiqiAgent.viewImage', { gone: self._imgGone }); // 生成的图片（有图就不算"空内容"，也不再压状态条）
      const stepsHtml = (m._steps && m._steps.length)
        ? '<div class="as-steps">' + m._steps.map(function (t) { return '<div>' + htmlEscape(t) + '</div>'; }).join('') + '</div>'
        : '';
      const body = raw.trim()
        ? renderMdStrong(htmlEscape(raw)).replace(/\n/g, '<br>') + (thinking ? '<span class="as-caret"></span>' : '')
        : ((thinking && !imgHtml) ? '<div class="as-status"><span class="cw-spinner"></span>' + htmlEscape(self._status || '正在处理…') + '</div>' : '');
      return '<div class="' + cls + '">' + body + stepsHtml + imgHtml + '</div>';
    }).join('');
    this._scrollMessagesToBottom();
    // 图片水合：重开 App 后消息里的句柄是空的 → 异步从本地存档取回（按激活书），读到会自己再渲染一次
    void this._hydrateImages();
  },

  // 水合：把消息里引用的、内存里没有的图从本地存档（IndexedDB）取回；取不到的进 _imgGone（渲染成「已过期」）。
  // 顺带把图号续上（重开 App 后 _imgSeq 归零，直接递增会盖掉旧记录 → 旧气泡会显示成新图）。
  // ===== 比奇预设（用户 2026-10-06：「直接显示在比奇里，两个模式共用一套、可编辑」）=====
  // 只放**人设与工作方式**这类用户可改的内容；生图规则、工具协议这些由软件每轮另行注入，
  // 不写进预设（否则用户一改就丢，也容易被改坏）。
  _presetText(): string {
    try {
      const t = SM().get<any>(BIQI_PRESET_KEY, null);
      if (typeof t === 'string' && t.trim()) return t;
    } catch (e) { /* ignore */ }
    return BIQI_SYSTEM;
  },
  openPresetModal(): void {
    const m = document.getElementById('biqiPresetModal');
    if (!m) return;
    const ta = document.getElementById('biqiPresetText') as HTMLTextAreaElement | null;
    if (ta) ta.value = this._presetText();
    m.classList.add('show');
  },
  closePresetModal(): void {
    const m = document.getElementById('biqiPresetModal');
    if (m) m.classList.remove('show');
  },
  /** 保存：清空、或与内置默认一致 → 视为"用默认"（删掉自定义，之后软件更新预设会跟着更新）。 */
  savePreset(): void {
    const ta = document.getElementById('biqiPresetText') as HTMLTextAreaElement | null;
    const t = String((ta && ta.value) || '').trim();
    try {
      if (!t || t === String(BIQI_SYSTEM).trim()) {
        SM().remove(BIQI_PRESET_KEY);
        App.toast('已用回默认预设（会跟随软件更新）');
      } else {
        SM().set(BIQI_PRESET_KEY, t);
        App.toast('比奇预设已保存（小说 / 对话共用这一份，下次发送生效）');
      }
    } catch (e) {
      try { App.toast('保存失败：' + ((e && (e as Error).message) || e)); } catch (e2) { /* ignore */ }
      return;
    }
    this.closePresetModal();
  },
  /** 恢复默认：立即生效（清掉自定义并回填默认文本，点「保存」可把当前文本再存回去）。 */
  resetPreset(): void {
    try { SM().remove(BIQI_PRESET_KEY); } catch (e) { /* ignore */ }
    const ta = document.getElementById('biqiPresetText') as HTMLTextAreaElement | null;
    if (ta) ta.value = BIQI_SYSTEM;
    try { App.toast('已恢复默认预设（立即生效）'); } catch (e) { /* ignore */ }
  },

  async _hydrateImages() {
    if (this._hydrating) return;
    const ids: string[] = [];
    for (let i = 0; i < (this.messages || []).length; i++) {
      const arr = (this.messages[i] && this.messages[i].imageIds) || [];
      for (let j = 0; j < arr.length; j++) {
        const id = String(arr[j] || '');
        if (id && !this._genImages.has(id) && !this._imgGone.has(id)) ids.push(id);
      }
    }
    if (!ids.length) return;
    this._hydrating = true;
    try {
      const bookId = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || undefined;
      const r = await hydrateImages(this._genImages, bookId, ids);
      for (let i = 0; i < r.gone.length; i++) this._imgGone.add(r.gone[i]);
      try {
        const mx = await ImageCache.maxSeq(String(bookId || ''));
        if (mx > this._imgSeq) this._imgSeq = mx;
      } catch (e) { /* 忽略 */ }
      if (r.loaded.length || r.gone.length) this.renderMessages();
    } finally { this._hydrating = false; }
  },

  send(): void {
    if (this._isSending) return;
    if (!this.isEnabled()) { App.toast('请先在「插件」页开启比奇'); return; }
    const input = document.getElementById('biqiInput') as HTMLTextAreaElement | null;
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    const apiConfig = PresetManager.getActiveAPIConfig();
    if (!apiConfig.apiKey) { App.toast('请先在「高级设置 → 模型与密钥」配置 API'); return; }
    input.value = '';
    if (typeof App !== 'undefined' && App.resetChatInput) App.resetChatInput(input);
    this.messages.push({ role: 'user', content: text });
    this.messages.push({ role: 'assistant', content: '', _steps: [] });
    this._steps = [];
    this._status = '正在思考…';
    this._isSending = true;
    this._save();
    this.renderMessages();
    void this._runLoop(text);
  },

  _save(): void {
    try { SM().set(this._historyKey(), this.messages); } catch (e) { /* ignore */ }
  },

  // ReAct：最多 4 轮工具调用，最后一轮必须给文字结论
  async _runLoop(_userText: string): Promise<void> {
    // 本轮属于哪个模式，就写哪个模式的临时世界书（overlay/待裁决表都带模式后缀）
    try { SettingSyncManager.setMode(this._mode); } catch (e) { /* ignore */ }
    // 画图主机状态（60 秒缓存）：决定这轮给不给 draw_image、注入正向还是反向的生图规则
    await this._refreshHostStatus();
    // 历史里的图片：模型看不到图（对话只传文字），但要让它知道"上一轮出过图"——否则
    // 「再画一张，和刚才同风格」这类话接不上。句柄只在本会话内存里，重载后退化成"已过期"。
    const hist = this.messages.slice(-20).filter(m => String(m.content || '').trim()).map((m: any) => {
      let text = String(m.content || '');
      const ids: string[] = (m.imageIds && m.imageIds.length) ? m.imageIds : [];
      if (ids.length) {
        const info = ids.map((gid: string) => {
          const gg = this._genImages.get(gid);
          const no = imageLabel(gid);
          if (!gg) return gid + '（已过期）';
          return (no ? (no + '（id ' + gid + '）') : gid) + '｜' + gg.size + ' · seed ' + (gg.seed == null ? '?' : gg.seed)
            + (gg.base ? (' · 改自' + gg.base) : '');
        }).join('、');
        text += '\n（本轮出过图：' + info + '。作者说"图3 / 第3张"就是它，要改就用 draw_image 的 base_image；图片只显示给作者、不随对话传给你）';
      }
      return { role: m.role, content: text };
    });
    const msgs: any[] = [
      { role: 'system', content: this._presetText() },   // 用户可编辑的预设（两模式共用一份）
      { role: 'system', content: this._imageRuleMessage() },
    ].concat(hist);
    let finalText = '';
    let lastErr = '';
    const setStatus = (t: string) => { this._status = t; this.renderMessages(); };
    const pushStep = (line: string) => {
      const last = this.messages[this.messages.length - 1];
      if (!last) return;
      last._steps = (last._steps || []).concat([line]);
      this._steps = last._steps;
      this.renderMessages();
    };
    let lastPaint = 0;
    const onPartial = (txt: string) => {
      const now = Date.now();
      if (now - lastPaint < 200) return;
      lastPaint = now;
      const last = this.messages[this.messages.length - 1];
      if (last && last.role === 'assistant' && txt) { last.content = txt; this._status = ''; this.renderMessages(); }
    };
    try {
      for (let round = 0; round < BIQI_MAX_ROUNDS; round++) {
        setStatus(this._steps.length ? '正在整理回答…' : '正在思考…');
        const r = await this._sendTurn(msgs, onPartial);
        if (r.err) { lastErr = r.err; break; }
        if (!r.tools || !r.tools.length) { finalText = r.text || ''; break; }
        msgs.push({
          role: 'assistant',
          content: r.text || '',
          tool_calls: r.tools.map((t, i) => ({ id: t.id || ('biqi_' + i), type: 'function', function: { name: t.name, arguments: JSON.stringify(t.arguments || {}) } })),
        });
        const outs: string[] = [];
        for (let i = 0; i < r.tools.length; i++) {
          const t = r.tools[i];
          if (t.name === 'read_worldbook') setStatus('正在看世界书…');
          else if (t.name === 'read_story') setStatus('正在读最近正文…');
          else if (t.name === 'draw_image') setStatus('正在出图…');
          else if (t.name === 'look_at_image') setStatus('正在看图…');
          else setStatus('正在修改临时世界书…');
          let out = '';
          try { out = await this._executeTool(t); } catch (e: any) { out = JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
          outs.push(out);
          const line = this._stepLine(t, out);
          if (line) pushStep(line);
          msgs.push({ role: 'tool', tool_call_id: t.id || ('biqi_' + i), content: out });
        }
        // A：出图轮 → 软件替模型核对一眼（一次独立的看图子调用），结论作为软件记录注入下一轮
        try {
          const ids: string[] = [];
          for (const o of outs) {
            try { const j = JSON.parse(String(o || '{}')); if (j && j.image_id) ids.push(String(j.image_id)); } catch (e) { /* ignore */ }
          }
          if (ids.length) {
            const note = await this._visionCheckNote(ids, String((((this._genImages.get(ids[0]) || {}) as any).prompt) || ''));
            if (note) msgs.push({ role: 'system', content: note });
          }
        } catch (e) { /* 核对失败不影响本轮 */ }
        if (round === BIQI_MAX_ROUNDS - 1) finalText = r.text || '（这轮改完了，接着说下一步要动哪里？）';
      }
    } catch (e: any) {
      lastErr = String((e && e.message) || e);
    }
    const last = this.messages[this.messages.length - 1] as (BiqiMessage & { _steps?: string[] }) | undefined;
    if (lastErr) {
      this.messages.pop();
      this._isSending = false;
      this._save();
      this.renderMessages();
      App.toast('请求失败: ' + lastErr);
      return;
    }
    this._status = '';
    if (last && last.role === 'assistant') {
      last.content = String(finalText || '').trim() || '（没有拿到结果，请再说一次）';
    }
    this._isSending = false;
    this._save();
    this.renderMessages();
  },

  _sendTurn(msgs: unknown[], onPartial?: (text: string) => void): Promise<{ text: string; tools: ToolCall[] | null; err?: string }> {
    const self = this;
    return new Promise(function (resolve) {
      let acc = '';
      let done = false;
      const finish = (v: { text: string; tools: ToolCall[] | null; err?: string }) => { if (!done) { done = true; resolve(v); } };
      try {
        APIHandler.fetchCompletions(
          msgs as any[],
          function (d: any) { acc += String(d || ''); if (onPartial && acc) onPartial(acc); },
          function (full: string | null) { finish({ text: (full != null ? String(full) : acc).trim(), tools: null }); },
          function (err: string) { finish({ text: '', tools: null, err: err }); },
          { tools: self._tools(), onTools: function (calls: any) { finish({ text: acc.trim(), tools: calls || [] }); } }
        );
      } catch (e: any) { finish({ text: '', tools: null, err: String((e && e.message) || e) }); }
    });
  },

  _tools(): unknown[] {
    const base: unknown[] = [
      {
        type: 'function',
        function: {
          name: 'read_worldbook',
          description: '读取当前生效的世界书（原书条目 + 临时世界书改动合并后的结果）。判断设定、准备修改前先看它。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'read_story',
          description: '读取最近正文（与续写时注入给 AI 的正文一致），用来确认剧情实际写到哪了。',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
      {
        type: 'function',
        function: {
          name: 'add_entry',
          description: '在临时世界书里新增一个条目。名称已存在时会自动并入该条目（不会重复建条）。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '条目名（角色名/设定名）' },
              content: { type: 'string', description: '条目完整内容' },
              type: { type: 'string', enum: ['世界观', '角色', '其他'], description: '条目类型：人物/角色一律用「角色」（对话模式按角色名单分气泡，其他类型进不了名单、头像也挂不上）；世界设定/规则/势力用「世界观」；其余用「其他」' },
              reason: { type: 'string', description: '一句话说明为什么加' },
            },
            required: ['name', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'update_entry',
          description: '修改临时世界书里已有条目的内容。content 必须是该条目的完整最终内容（旧文与新设定整合后的全文），不是改动片段。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要改的条目名（必须是 worldbook 里已有的）' },
              content: { type: 'string', description: '该条目的完整最终内容' },
              reason: { type: 'string', description: '一句话说明改了什么' },
            },
            required: ['name', 'content'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'delete_entry',
          description: '停用（软删除）临时世界书里的一个条目：原书条目会被停用而非抹掉，可回滚；临时新增的条目直接移除。',
          parameters: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '要停用的条目名' },
              reason: { type: 'string', description: '一句话说明为什么停用' },
            },
            required: ['name'],
          },
        },
      },
    ];
    // 画图工具只在「画图主机已启用且这一轮探测到在线」时提供；不给工具时规则也会切换成
    // "你没有画图能力"（见 _imageRuleMessage），避免它嘴上提议"要不要我画一张"（用户看不到能点的东西）。
    if (this._drawToolsOn) {
      base.push(this._imageToolDraw());
      // 看图工具：只在"没确认看不了图"时给（模型看不了图就不让它看——用户 2026-10-06 要求）
      if (visionState() !== 'no') base.push(this._imageToolLook());
    }
    return base;
  },

  // 看图工具：模型自己看不到图片，靠**一次单独的看图子调用**回答"这张画得怎么样"这类问题。
  // 传 420px 缩略图（便宜、够判断明显问题）；看不了图的模型不给这个工具。
  _imageToolLook(): unknown {
    return {
      type: 'function',
      function: {
        name: 'look_at_image',
        description: '看一眼已经生成的图（单独的看图调用，约 3~6 秒）：可以问"手有没有画坏""背景是不是夜晚""这张和图4比哪张更像苏黎"。'
          + '**什么时候用**：你要判断画得对不对、有没有崩坏，或作者问起某张图的细节，而你自己看不到图片。'
          + '拿到的是文字回答——据此向作者说明，但不要说成"我亲眼看到的"。',
        parameters: {
          type: 'object',
          properties: {
            image_id: { type: 'string', description: '要看的那张图：界面编号「图3」或 "img3"；也可以填 "last" 或角色名（用 TA 的头像）' },
            question: { type: 'string', description: '你想让它看什么（一句话，越具体越好）' },
            image_id2: { type: 'string', description: '可选：对比用的第二张（填编号）' }
          },
          required: ['image_id', 'question']
        }
      }
    };
  },

  // —— 生图（本机 ComfyUI，协议见 domain/imagedraw.ts / imagehost.ts）——
  // 交互策略与写卡 Agent 相反：作者明确让画就直接画、不反问；只是讨论画面时先讨论。
  _imageToolDraw(): unknown {
    const st: any = this._hostStatus || {};
    const model = st.model ? String(st.model) : '';
    const hint = st.hint ? String(st.hint) : '';
    const caps: string[] = Array.isArray(st.caps) ? st.caps : [];
    const canImg2img = caps.indexOf('img2img') >= 0;
    const props: any = {
      prompt: { type: 'string', description: '英文正向提示词（按上面的画风/提示词要求写；改图时写"要改成什么"，不用把原图内容整段重写）' },
      seed: { type: 'integer', description: '可选：沿用上一张的 seed，可让同一人物/风格更接近（上一张的 seed 在历史里）' },
      quality: {
        type: 'string',
        enum: ['fast', 'draft', 'normal', 'high'],
        description: '画质档位：fast=最快（512×512/12 步，约 5~8 秒）；draft=草稿（512×512/20 步，用于挑构图）；normal=标准（768×768/28 步，默认）；high=更精细（1024×1024/36 步，约 30 秒）'
      }
    };
    if (canImg2img) {
      props.base_image = { type: 'string', description: '以什么为底图。**画到世界书里的角色时默认就填 TA 的角色名**（用 TA 当前头像当底图：换动作/衣服/背景都行、脸会保持是 TA）；也可以填"图3"/"img3"（对话里图片左下角的编号，作者说"第几张"就是它）或 "last"（最近一张）来改某张已出的图。角色还没有头像时会照常按描述画（不报错）。**带底图时一律按"大改"处理**（换姿势动作/衣服/背景，只保住人物和脸）。' };
    }
    return {
      type: 'function',
      function: {
        name: 'draw_image',
        description: '在作者电脑的「画图主机」（ComfyUI）上生成一张图，直接显示在对话里给作者看，约 10~35 秒。'
          + (model ? ('当前画图模型：' + model + '。') : '')
          + (hint ? ('画风与提示词要求：' + hint + ' ') : '')
          + '**作者明确让你画时直接调用，不要再问"要不要画/可以吗"**；他只是讨论画面、还没让你画时先讨论，不要抢着画。'
          + 'prompt 用英文；画什么以最近上下文为准（人物外观、当前场景、正在发生的事），拿不准时先 read_story / read_worldbook 看一眼。'
          + (canImg2img ? '作者要"改某一张"（"把图3改成雪景""给这段配张图"）时传 base_image；**画到世界书里的角色时默认就用 TA 的头像当底图**（一律大改：换动作/衣服/背景都行、脸保持是 TA）。' : '')
          + '档位：不填=标准（768×768，约 14 秒）；作者说"快一点/先看看"用 quality:"fast"（512，约 5~8 秒）；'
          + '一次出 2~3 张让他挑构图用 quality:"draft"（512×512/20 步，可连续调用几次）；说"更精细/更大"用 quality:"high"（1024×1024/36 步，约 30 秒）。',
        parameters: { type: 'object', properties: props, required: ['prompt'] }
      }
    };
  },

  // 生图规则文案（每轮注入一条独立 system 消息，与用户预设无关）：
  //   · 主机在线：作者让画就直接画（不反问）；只讨论就先讨论。
  //   · 主机没配/没开：反向规则——不给工具只能拦住"真去画"，拦不住它嘴上提议"要不要我画一张"，
  //     用户看到这种提议只会白点一下，所以必须明确告诉模型"你没有画图能力"。
  _imageRuleMessage(): string {
    if (this._drawToolsOn) {
      const caps: string[] = Array.isArray((this._hostStatus || {}).caps) ? (this._hostStatus as any).caps : [];
      const canImg2img = caps.indexOf('img2img') >= 0;
      return '【生图（作者电脑上的画图主机）】你可以用 draw_image 出图，结果会直接显示在对话里（约 10~35 秒）：\n'
        + '- **最常用的用法：作者刚写完一段 / 刚演完一轮，说一句"配张图""来张图""给这段配一张"→ 不要反问他画什么**，自己从最近正文/演出记录里挑最有画面感的那一幕（谁、在哪、正在做什么、什么时间与光线）画出来；\n'
        + '- 作者明确让你画（"画一张…""生图""就按这个画"）→ 一样**直接调用，不要再问"要不要画/可以吗"**，也不要只说"这就画"却不调用；\n'
        + '- 他只是讨论画面、还没让你画时 → 正常讨论，别抢着画；讨论里他认可了，也一样直接画；\n'
        + '- 出图后图上会有编号（气泡左下角的「图1/图2…」）：作者之后说"把图3改成雪景""基于图2再来一张"时，就用那个编号指代它'
        + (canImg2img
          ? '（draw_image 的 base_image 填那个编号 / "last"）'
          : '（本机画图主机是旧版、暂时不支持改图；他真要改就按新的描述重新画一张）') + '；\n'
        + (canImg2img
          ? '- **画面里有世界书里的角色时：默认用 TA 的头像当底图**（base_image 填角色名）——这样动作/衣服/背景都能换、脸始终是 TA；多人在场用作者点名的那个人，他没点名就用画面里最主要的那个。**带底图时一律按"大改"处理**（换姿势动作/整套衣服/背景场景，只保住人物和脸），不要做"只改一点"的小修——作者要的是新鲜感。角色还没头像就照常按描述画（别报错，末尾可以补一句"给它设张头像，以后脸就能固定"）。\n'
          : '')
        + '- 提示词落在最近上下文里能确定的东西上（人物外观、当前场景、正在发生的事）；他没说的细节按上下文最合理的样子补，别自己另起一个故事；\n'
        + '- 出图后用一两句中文说明画的是什么，问他要不要换一张或调整；失败（主机离线/超时/主机不支持改图）就如实说原因，不要重试超过一次，也不要假装画了。';
    }
    return '【生图】本轮你没有画图工具——作者还没配置画图主机，或者画图主机没在运行。因此：\n'
      + '- **不要提议"要不要我画一张"**，不要说"我可以帮你出图/生成图片/配图"，也不要输出生图提示词；专注设定与剧情。\n'
      + '- 只有当作者主动要求画图时，才说明：需要先在「设置 → AI 与生成 → 画图主机」填上电脑的地址和配对 token，并让电脑上的画图主机保持运行。';
  },

  // 画图主机状态探测（60 秒缓存，见 imagedraw.ts）：_runLoop 每轮开头调一次
  async _refreshHostStatus(): Promise<void> {
    this._drawToolsOn = await probeHost(this._hostStatus);
  },

  // 出一次图，返回给模型看的 JSON 文本（图片同步挂在最后一条 assistant 消息上）
  async _toolDrawImage(a: any): Promise<string> {
    try {
      const out = await drawImageToStore({
        prompt: String((a && a.prompt) || ''),
        quality: a && a.quality,
        legacyDraft: !!(a && a.draft),
        seed: a && a.seed,
        baseImage: a && a.base_image,
        // 比奇只做大改（用户 2026-10-06）：换动作/衣服/背景、只保脸——不做"只改一点"的小修，作者要新鲜感
        strength: 'strong',
        store: this._genImages,
        nextId: () => 'img' + (++this._imgSeq),
        bookId: (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || undefined,
        onTick: () => { this._status = '正在出图…'; this.renderMessages(); },
        onImage: (id: string) => {
          const last: any = this.messages[this.messages.length - 1];
          if (last && last.role === 'assistant') {
            last.imageIds = (last.imageIds || []).concat([id]);
            this._save();
          }
          this.renderMessages();
        }
      });
      if (out.host) this._hostStatus = { at: Date.now(), ok: !!out.host.ok, model: out.host.model || '', hint: out.host.hint || '', caps: out.host.caps || [], tiers: out.host.tiers || {} };
      if (!out.ok) return JSON.stringify({ ok: false, error: out.error });
      const t: any = out.tier;
      const label = imageLabel(out.id);
      return JSON.stringify({
        ok: true,
        image_id: out.id,
        image_label: label,
        size: out.size,
        seed: (out.seed == null ? null : out.seed),
        seconds: out.seconds,
        base: out.base || '',
        message: '图片已生成并显示在对话里（' + out.id + (label ? ('，界面编号 ' + label) : '') + '，' + t.label + '档，耗时 ' + out.seconds + ' 秒'
          + (out.base ? ('，基于' + out.base + '改的' + (out.hires ? '（两步放大重修）' : '')) : '') + '）。'
          + (out.baseNote ? ('（本次没有用底图：' + out.baseNote + '——末尾补一句告诉作者。）') : '')
          + '用一两句中文说明画面，并问作者要不要调整或换一张。'
      });
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: '失败：出图时出错（' + String((e && e.message) || e) + '）' });
    }
  },

  async _toolLookImage(a: any): Promise<string> {
    const r = await lookAtImageTool({
      imageRef: a && a.image_id,
      imageRef2: a && a.image_id2,
      question: a && a.question,
      store: this._genImages,
      bookId: (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || undefined,
      onStatus: () => { this._status = '正在看图…'; this.renderMessages(); }
    });
    if (!r.ok && r.message.indexOf('看不了图片') >= 0 && !this._visionNoToast) {
      this._visionNoToast = true;
      try { App.toast('当前模型看不了图片：已关闭"看图/图核对"（不影响出图与改图）'); } catch (e) { /* ignore */ }
    }
    return JSON.stringify(r.ok ? { ok: true, result: r.message } : { ok: false, error: r.message });
  },

  // A（出图后自动核对一眼）：软件替模型看一次刚生成的图，结论作为**软件记录**注入下一轮。
  // 看不了图的模型（已确认）直接跳过；试失败但不像能力问题（超时等）也只是这次不注入。
  async _visionCheckNote(imgIds: string[], prompt: string): Promise<string> {
    const id = String((imgIds && imgIds[0]) || '');
    if (!id || visionState() === 'no') return '';
    const g: any = this._genImages.get(id);
    const img = String((g && (g.thumb || g.full)) || '');
    if (!img) return '';
    this._status = '正在核对刚生成的图…';
    this.renderMessages();
    const ask = '这是刚刚生成的一张插图（缩略图）。请核对两点：① 画面主要内容是否与描述相符；'
      + '② 有没有**明显**的崩坏（手指畸形、乱码文字、结构错误、明显模糊）。两三句话直接说结论。'
      + (prompt ? ('\n（生成时用的描述：' + String(prompt).slice(0, 300) + '）') : '');
    const r = await lookAtImageTracked({ images: [img], question: ask, callLabel: 'vision' });
    if (r.state === 'no') {
      if (!this._visionNoToast) {
        this._visionNoToast = true;
        try { App.toast('当前模型看不了图片：已关闭"看图/图核对"（不影响出图与改图）'); } catch (e) { /* ignore */ }
      }
      return '';
    }
    const ans = String(r.answer || '').trim();
    if (!r.ok || !ans) return '';
    return '【软件替你看过刚生成的那张图（既不是作者说的，也不是你自己看到的）】' + ans
      + '\n请据此如实向作者说明这张图；与你刚才的预期不符时以这段为准，不要硬说达成了。若确实有明显崩坏，可以主动问一句「要不要我重画一张」。';
  },

  async _executeTool(t: ToolCall): Promise<string> {
    const a = (t.arguments || {}) as Record<string, string>;
    if (t.name === 'read_worldbook') return this.readWorldbook();
    if (t.name === 'read_story') return this.readStory();
    if (t.name === 'draw_image') return await this._toolDrawImage(a);
    if (t.name === 'look_at_image') return await this._toolLookImage(a);
    if (t.name === 'add_entry' || t.name === 'update_entry' || t.name === 'delete_entry') {
      const name = String(a.name || '').trim();
      if (!name) return JSON.stringify({ ok: false, error: 'name 不能为空' });
      const op = t.name === 'add_entry' ? 'add' : (t.name === 'update_entry' ? 'mod' : 'del');
      const content = String(a.content || '').trim();
      if (op !== 'del' && !content) return JSON.stringify({ ok: false, error: 'content 不能为空' });
      const r = this._applyOp(op, name, content, String(a.reason || ''), a.type);
      return JSON.stringify(r.ok ? { ok: true, result: r.text } : { ok: false, error: r.text });
    }
    return JSON.stringify({ ok: false, error: '未知工具 ' + t.name });
  },

  _stepLine(t: ToolCall, out: string): string {
    const a = (t.arguments || {}) as Record<string, string>;
    const name = String(a.name || '').trim();
    if (t.name === 'read_worldbook') {
      let n = 0;
      try { n = (JSON.parse(out).entries || []).length; } catch (e) { /* ignore */ }
      return '📚 查看世界书 → 生效 ' + n + ' 条';
    }
    if (t.name === 'read_story') {
      let n = 0;
      try { n = (JSON.parse(out).chars || 0); } catch (e) { /* ignore */ }
      return '📖 读最近正文 → ' + n + ' 字';
    }
    if (t.name === 'draw_image') {
      let j: any = null;
      try { j = JSON.parse(out); } catch (e) { /* ignore */ }
      if (j && j.ok) return '🎨 ' + (j.base ? '改图' : '出图') + ' → ' + (j.size || '') + ' · ' + (j.seconds == null ? '?' : j.seconds) + 's · ' + (j.image_label || j.image_id || '');
      return '⚠️ 出图失败 → ' + String((j && j.error) || '').slice(0, 60);
    }
    let ok = false;
    let msg = '';
    try { const j = JSON.parse(out); ok = !!j.ok; msg = j.result || j.error || ''; } catch (e) { /* ignore */ }
    const verb = t.name === 'add_entry' ? '新增' : (t.name === 'update_entry' ? '修订' : '停用');
    return (ok ? '✏️ ' : '⚠️ ') + verb + '「' + name + '」' + (ok && msg ? ' → ' + String(msg).slice(0, 40) : (msg ? ' → ' + String(msg).slice(0, 40) : ''));
  },

  // 落盘：包成 DeltaOp 走 applyApproved —— 与自动同步同一套语义，且自带快照（可「回滚上一批」）
  _applyOp(op: 'add' | 'mod' | 'del', target: string, content: string, reason: string, type?: string): { ok: boolean; text: string } {
    try {
      if (typeof SettingSyncManager === 'undefined') return { ok: false, text: '临时世界书不可用' };
      if (op === 'mod' && !SettingSyncManager.findOriginalByTarget(target)) {
        return { ok: false, text: '没有叫「' + target + '」的条目，先用 add_entry 新增，或改用准确的名字' };
      }
      if (op === 'del' && !SettingSyncManager.findOriginalByTarget(target)) {
        return { ok: false, text: '没有叫「' + target + '」的条目，无需停用' };
      }
      const id = 'biqi_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const op2: any = {
        id, op, target, content,
        reason: reason || '比奇对话修改',
        quote: '（比奇对话）',
        round: 0,
        status: 'pending',
      };
      if (type && ['世界观', '角色', '其他'].indexOf(type) >= 0) op2.type = type;
      SettingSyncManager.addPending([op2]);
      const res = SettingSyncManager.applyApproved([{ id, decision: 'accept', content, reason: reason || '比奇对话修改' }]);
      if (!res || res.accepted < 1) {
        // 只清掉自己这一条（不能 clearPending，别把自动同步攒着的待裁决一起清掉）
        try { SettingSyncManager.removePending(id); } catch (e) { /* ignore */ }
        return { ok: false, text: '没能写入（条目名或内容不合法）' };
      }
      try { if (this._open) { const page = document.getElementById('agentFullscreen'); if (page && page.style.display === 'flex') UIManager.renderAgentPage(); } } catch (e) { /* ignore */ }
      return { ok: true, text: op === 'add' ? '已加入临时世界书' : (op === 'mod' ? '已更新（原书未动）' : '已停用（可回滚）') };
    } catch (e: any) {
      return { ok: false, text: String((e && e.message) || e) };
    }
  },

  // 与备注：这两个函数是「注入一致性」的入口——世界书走 getEffectiveEntries（续写同源），
  // 正文走 App.collectRecentStoryText（续写同一个函数，见 app.ts）。
  readWorldbook(): string {
    try {
      const entries = (typeof SettingSyncManager !== 'undefined')
        ? SettingSyncManager.getEffectiveEntries()
        : ((WorldBookManager.getActive() || {}).entries || []);
      const items = entries.map(function (e: any) {
        const st = (typeof SettingSyncManager !== 'undefined') ? SettingSyncManager.entryStatus(e.id) : 'orig';
        const tag = st === 'added' ? '（临时新增）' : (st === 'modified' ? '（临时修改）' : '');
        return { id: e.id, type: e.type || '其他', name: e.name || '', status: st, content: String(e.content || '').slice(0, 1200), tag };
      });
      // 「初始」条目：只在正文为空时注入一次。正文已开始后它不出现在注入里——单独列出来避免被当成时间线错误
      const initials = items.filter(function (it: any) { return it.type === '初始'; });
      const body = (typeof App !== 'undefined' && App.collectRecentStoryText) ? String(App.collectRecentStoryText().recentText || '') : '';
      const bodyEmpty = body.replace(/\s/g, '').length === 0;
      return JSON.stringify({
        ok: true,
        total: items.length,
        note: '这是续写时实际注入的设定（原书 + 临时世界书合并）；status=orig 表示原书原文，modified/added 表示临时层改动。',
        initialEntries: initials.map(function (it: any) { return it.name; }),
        initialInjected: bodyEmpty,
        initialNote: bodyEmpty
          ? '正文还是空的：上面这些「初始」条目这轮会注入一次（开局快照）。'
          : '正文已经开始：上面这些「初始」条目**本轮不注入**（初始只在正文为空时注入一次）。它们与当前剧情对不上是正常的，不是时间线错误，不要去改它们。',
        entries: items,
      });
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  },

  readStory(): string {
    try {
      // 对话模式：比奇看的"最近剧情"是最近的演出记录（正文可能还没写到这里）
      if (this._mode === 'chat') {
        const chat = (typeof ChatMode !== 'undefined' && ChatMode.recentContext) ? String(ChatMode.recentContext() || '') : '';
        const text = chat.slice(-STORY_CHAR_LIMIT);
        return JSON.stringify({ ok: true, chapter: '（对话模式）', chars: text.length, note: '对话模式：这是最近的演出记录', text });
      }
      const story = (typeof App !== 'undefined' && App.collectRecentStoryText)
        ? App.collectRecentStoryText()
        : { recentText: '' };
      const text = String(story.recentText || '').slice(-STORY_CHAR_LIMIT);
      let chapter = '';
      try {
        const ch = App.getCurrentChapter && App.getCurrentChapter();
        chapter = (ch && (ch.title || (ch as any).name)) || '';
      } catch (e) { /* ignore */ }
      return JSON.stringify({ ok: true, chapter, chars: text.length, note: '与续写时注入的正文同源', text });
    } catch (e: any) {
      return JSON.stringify({ ok: false, error: String((e && e.message) || e) });
    }
  },

  openWorldbookPage(): void {
    try {
      if (typeof UIManager !== 'undefined' && UIManager.openAgentPage) UIManager.openAgentPage();
    } catch (e) { /* ignore */ }
  },

  // 点缩略图看大图：给全屏查看器换原图（气泡里是 420px 缩略图）。带图号与来源面板：
  // 查看器里的「基于这张改」据此把「把图3改成：」填进比奇输入框。
  viewImage(id: any): void {
    const key = String(id || '');
    const g = this._genImages.get(key);
    const src = (g && (g.full || g.thumb)) || '';
    if (src) { UIManager.viewAvatar(src, { id: key, label: imageLabel(id), ctx: 'biqi' }); return; }
    // 内存里没有（重开过 App / 被上限挤掉）→ 先从本地存档取回再打开
    const bookId = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || undefined;
    void hydrateImages(this._genImages, bookId, [key]).then(function (r) {
      const gg = BiqiAgent._genImages.get(key);
      const s2 = (gg && (gg.full || gg.thumb)) || '';
      if (s2) UIManager.viewAvatar(s2, { id: key, label: imageLabel(id), ctx: 'biqi' });
      else App.toast('这张图在本机存档里也没有了（清空对话/删书会一起删）——重新画一张吧');
    }).catch(function () { /* 忽略 */ });
  },
};

(globalThis as unknown as { BiqiAgent: typeof BiqiAgent }).BiqiAgent = BiqiAgent;
export default BiqiAgent;
