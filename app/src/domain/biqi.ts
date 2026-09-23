// BiqiAgent：插件「比奇」（widget, shell='biqi'）。
// 形态：正文页工具栏的「比奇」按钮 → 内容区上半屏对话窗（只有 ✕ 能关，下半屏正文照常滑动）。
// 能力：ReAct 工具循环，可读世界书（原书 + 临时层的合并视图）与最近正文（与续写注入同源），
//      可增/改/删临时世界书条目——立即生效，原书零触碰。
// 落盘路径：改动包成 DeltaOp 交给 SettingSyncManager.applyApproved（同一套语义：改名并入、
//      add 命中已有条目转更新、删原书条目走软删除），因此自带快照，可直接用「回滚上一批」撤回。
import { SM } from '../infra/gate';
import { PluginManager } from './plugins';
import { SettingSyncManager } from './settingsync';
import { WorldBookManager } from './worldbook';
import { renderMdStrong } from '../lib/mdtext';

export interface BiqiMessage { role: 'user' | 'assistant'; content: string; _steps?: string[] }

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
  _loadedKey: string;
  _ratio: number;          // 常态高度比例（不持久化：每次开窗回到半屏）
  _snapped: boolean;       // 是否吸附成整屏
  _kbOpen: boolean;        // 输入中（软键盘/输入框聚焦）→ 面板占满可视区
  isEnabled(): boolean;
  _applyHeight(): void;
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
  _applyOp(op: 'add' | 'mod' | 'del', target: string, content: string, reason: string, type?: string): { ok: boolean; text: string };
  readWorldbook(): string;
  readStory(): string;
  openWorldbookPage(): void;
} = {
  messages: [],
  _isSending: false,
  _status: '',
  _steps: [],
  _open: false,
  _loadedKey: '',   // 当前内存里的对话属于哪本书的存档键（换书时据此切会话）
  _ratio: BIQI_DEFAULT_RATIO,
  _snapped: false,
  _kbOpen: false,

  isEnabled(): boolean {
    try { return typeof PluginManager !== 'undefined' && PluginManager.isEnabled('biqi'); } catch (e) { return false; }
  },

  // 对话按书隔离：换书不串台
  _historyKey(): string {
    let id = 'none';
    try { id = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId && WorldBookManager.getActiveId()) || 'none'; } catch (e) { /* ignore */ }
    return 'biqiHistory_' + id;
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
    if (this._kbOpen) { panel.style.height = ''; return; }
    panel.classList.toggle('full', this._snapped);
    panel.style.height = this._snapped ? '100%' : (Math.round(this._ratio * 100) + '%');
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
        // base* 是"当前状态的基准"：吸附/解除的那一刻以手指当前位置重新起算，
        // 否则从整屏往回拖会按整段位移直接跳到 63% 这类值（高度会跳一截，实测手感很差）。
        let baseRatio = this._ratio;
        let baseSnapped = this._snapped;
        let baseY = Number(e.clientY) || 0;
        const onMove = (ev: any) => {
          const y = Number(ev.clientY) || 0;
          const next = biqiResolveDrag(baseRatio, baseSnapped, y - baseY, containerH);
          if (next.snapped !== baseSnapped) {
            // 切换状态：高度落在该状态的起点（吸附=整屏、解除=90%），并以手指当前位置重新起算，
            // 注意这里要用起点值而不是切换前的计算值（否则解除瞬间会跳到 63% 这种数）
            baseSnapped = next.snapped;
            baseRatio = next.snapped ? 1 : BIQI_MAX_RATIO;
            baseY = y;
            this._ratio = BIQI_MAX_RATIO;
          } else {
            baseRatio = next.ratio;
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
    this._applyHeight();   // 键盘态：清掉内联高度（否则内联会压过 .kb-open 的 CSS 高度）；非键盘态：按比例落地
    if (this._kbOpen) this._scrollMessagesToBottom();
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
    const input = document.getElementById('biqiInput') as HTMLTextAreaElement | null;
    if (input && !this.messages.length) input.focus();
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
    try { SM().set(this._historyKey(), []); } catch (e) { /* ignore */ }
    this.renderMessages();
  },

  renderMessages(): void {
    const box = document.getElementById('biqiMessages');
    if (!box) return;
    if (!this.messages.length) {
      box.innerHTML = '<div class="chat-empty">我是比奇，这本书的设定管家<br>聊聊接下来剧情该怎么走，或者让我把某段设定改掉；<br>改动只落在临时世界书，原书不动。</div>';
      return;
    }
    const self = this;
    box.innerHTML = this.messages.map(function (m, i) {
      const cls = m.role === 'user' ? 'chat-msg user' : 'chat-msg assistant';
      const thinking = self._isSending && i === self.messages.length - 1 && m.role === 'assistant';
      const raw = String(m.content || '');
      const stepsHtml = (m._steps && m._steps.length)
        ? '<div class="as-steps">' + m._steps.map(function (t) { return '<div>' + htmlEscape(t) + '</div>'; }).join('') + '</div>'
        : '';
      const body = raw.trim()
        ? renderMdStrong(htmlEscape(raw)).replace(/\n/g, '<br>') + (thinking ? '<span class="as-caret"></span>' : '')
        : (thinking ? '<div class="as-status"><span class="cw-spinner"></span>' + htmlEscape(self._status || '正在处理…') + '</div>' : '');
      return '<div class="' + cls + '">' + body + stepsHtml + '</div>';
    }).join('');
    this._scrollMessagesToBottom();
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
    const msgs: any[] = [{ role: 'system', content: BIQI_SYSTEM }].concat(
      this.messages.slice(-20).filter(m => String(m.content || '').trim()).map(m => ({ role: m.role, content: m.content }))
    );
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
        for (let i = 0; i < r.tools.length; i++) {
          const t = r.tools[i];
          if (t.name === 'read_worldbook') setStatus('正在看世界书…');
          else if (t.name === 'read_story') setStatus('正在读最近正文…');
          else setStatus('正在修改临时世界书…');
          let out = '';
          try { out = await this._executeTool(t); } catch (e: any) { out = JSON.stringify({ ok: false, error: String((e && e.message) || e) }); }
          const line = this._stepLine(t, out);
          if (line) pushStep(line);
          msgs.push({ role: 'tool', tool_call_id: t.id || ('biqi_' + i), content: out });
        }
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
    return [
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
              type: { type: 'string', enum: ['世界观', '角色', '其他'], description: '条目类型，默认其他' },
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
  },

  async _executeTool(t: ToolCall): Promise<string> {
    const a = (t.arguments || {}) as Record<string, string>;
    if (t.name === 'read_worldbook') return this.readWorldbook();
    if (t.name === 'read_story') return this.readStory();
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
};

(globalThis as unknown as { BiqiAgent: typeof BiqiAgent }).BiqiAgent = BiqiAgent;
export default BiqiAgent;
