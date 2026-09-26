// EditorManager：正文编辑器（迁移自 www/modules/editor.js）。
// contenteditable 编辑器 + 对白高亮 + 流式渲染（思考块折叠）+ 上下文组装
// （跨章/全量正文）。文件尾部的全局函数 htmlEscape 一并迁移。
import { DELTA_CLOSE_RE, DELTA_OPEN_RE, DELTA_PARTIAL_RE } from '../lib/delta-tag';
import { createStatusStreamFilter } from '../lib/status-block';
import { StatusVars } from './statusvars';
import { htmlToPlainText } from '../lib/htmltext';
import { BODY_MARKER, THINK_CLOSE_RE, THINK_OPEN_RE, stripLeadingBodyMarker, tailPartialToken } from '../lib/think-protocol';
export const EditorManager = {
  editorEl: null as HTMLElement | null,
  saveTimer: null as ReturnType<typeof setTimeout> | null,
  lastWrapper: null as HTMLDivElement | null,
  lastBr: null as HTMLBRElement | null,
  _streamingWrapper: null as HTMLDivElement | null,
  _streamingBr: null as HTMLBRElement | null,
  _dashCount: 0,
  _streamingTimer: null as ReturnType<typeof setTimeout> | null,
  _streamingScrolled: false,
  _streamingRaw: '',
  _thinkingRequired: false,
  _thinkingSkipNotified: false,
  // 深度思考开关（关闭时不创建思维链框，正文照常流式）
  _deepThinkOn: true,
  // API 原生思维链实时框标记：正文首字到来（推理结束）时自动闭合，正文不再被吞进框
  _openThinkReasoning: false,
  // 跨 chunk 标记前缀扣留：思考开/闭标记与 `【正文】` 可能被网络分帧劈开，
  // 扣住疑似前缀（最多 10 字）等下一帧拼齐再判定，避免标记被当正文吃掉。
  // 注意：思考是否闭合、内容去哪，一律不用长度判定（思维链可能上万字）。
  _tokenHold: '',
  // 平滑流式：待消费缓冲（原文按 40ms/8 字匀速渲染）+ 思考框/正文两个独立容器（增量 DOM）
  _pendingStream: '',
  _streamThinkBox: null as HTMLDivElement | null,
  _streamSink: null as HTMLDivElement | null,
  _openThink: null as Text | null,
  // 流式对话高亮：跨帧「…」——「出现即建 span，持续追加，直到」闭合
  _openDialogue: null as HTMLSpanElement | null,
  // Agent 设定同步：流式丢弃 SETTING_DELTA 提议块（跨 chunk 状态机，不上屏不落盘）。
  // 被丢弃的原文仍记入 _streamingRaw 供 onDone 解析，但不进 _pendingStream。
  // 标记识别走 lib/delta-tag 容错版（模型写成 SETTINGS_DELTA 等变体也照样丢弃）。
  _discardingDelta: false,
  _deltaPrefixBuf: '',
  // 世界书「变量」：流式丢弃 <status>…</status> 回报块（跨 chunk 状态机，不上屏）。
  // sink 里的 DOM 就是最终正文，onDone 再剥已经来不及——必须在上屏前挡掉。
  // 只在当前书启用了变量条目时存在（见 startStreaming），其余情况为 null＝直通。
  _statusFilter: null as ReturnType<typeof createStatusStreamFilter> | null,

  init(): void {
    this.editorEl = document.getElementById('editor');
    (this.editorEl as HTMLElement).addEventListener('input', () => this.onInput());
    (this.editorEl as HTMLElement).addEventListener('keyup', () => App.updateWordCount?.());
    (this.editorEl as HTMLElement).addEventListener('paste', (e: ClipboardEvent) => {
      e.preventDefault();
      const t = e.clipboardData?.getData('text/plain') || '';
      document.execCommand('insertText', false, t);
    });
    (this.editorEl as HTMLElement).addEventListener('keyup', (e: KeyboardEvent) => { if (e.key === '「' || e.key === '」') this.highlightDialogue(); });
    this._bindThinkToggleAnchor();
    this._bindScrollBottomBtn();
  },

  // 「回到底部」浮钮：离底部超过约 50 行时显示，点击平滑滚到底（不能生硬跳）。
  // 用 rAF 自绘缓动而不是 scrollTo({behavior:'smooth'})——后者时长由浏览器定，
  // 长章节要滑好几秒；这里固定 ~520ms，且用户一动滚轮/触摸就立刻交还控制权。
  SCROLL_BTN_LINES: 50,
  SCROLL_ANIM_MS: 520,
  _scrollAnim: null as number | null,
  _bindScrollBottomBtn(): void {
    const ed = this.editorEl as HTMLElement | null;
    if (!ed || (ed as any)._scrollBtnBound) return;
    (ed as any)._scrollBtnBound = true;
    const self = this;
    ed.addEventListener('scroll', function () { self._syncScrollBottomBtn(); }, { passive: true });
    window.addEventListener('resize', function () { self._syncScrollBottomBtn(); });
    // 用户主动操作 → 立刻停掉正在跑的滚动动画（否则会和手指抢滚动条）
    ['wheel', 'touchstart', 'mousedown', 'keydown'].forEach(function (ev) {
      ed.addEventListener(ev, function () { self._cancelScrollAnim(); }, { passive: true });
    });
    this._syncScrollBottomBtn();
  },
  _scrollBottomGap(el: HTMLElement): number {
    const cs = getComputedStyle(el);
    let line = parseFloat(cs.lineHeight);
    if (!line || isNaN(line)) line = (parseFloat(cs.fontSize) || 16) * 1.8;
    return el.scrollHeight - el.scrollTop - el.clientHeight - line * (this.SCROLL_BTN_LINES as number);
  },
  _syncScrollBottomBtn(): void {
    const ed = this.editorEl as HTMLElement | null;
    const btn = document.getElementById('editorScrollBottom');
    if (!ed || !btn) return;
    btn.classList.toggle('show', this._scrollBottomGap(ed) > 0);
  },
  _cancelScrollAnim(): void {
    if (this._scrollAnim != null) { cancelAnimationFrame(this._scrollAnim); this._scrollAnim = null; }
  },
  scrollEditorToBottom(): void {
    const ed = this.editorEl as HTMLElement | null;
    if (!ed) return;
    this._cancelScrollAnim();
    const from = ed.scrollTop;
    const max = Math.max(0, ed.scrollHeight - ed.clientHeight);
    const to = max;
    if (to <= from + 1) { this._syncScrollBottomBtn(); return; }
    const dur = this.SCROLL_ANIM_MS as number;
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const self = this;
    const ease = function (p: number) { return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; };
    const step = function () {
      const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const p = Math.min(1, (now - t0) / dur);
      ed.scrollTop = from + (to - from) * ease(p);
      if (p >= 1) { self._scrollAnim = null; self._syncScrollBottomBtn(); return; }
      self._scrollAnim = requestAnimationFrame(step);
    };
    this._scrollAnim = requestAnimationFrame(step);
  },
  // 思维链 details 折叠/展开的视口锚定。根因：手动点「思考」折叠时其下方正文整体上移，
  // 浏览器保持 scrollTop 不变 → 用户正看的段落被顶走（视口滑到后面的位置）。
  // 修法：click 捕获阶段记 details 旧高度，toggle 事件（不冒泡，必须捕获监听）后按
  // 高度差同步补偿最近滚动容器——折叠上补偿、展开下补偿，正文钉在屏幕原位。
  _scrollParentOf(el: HTMLElement | null): HTMLElement | null {
    let p = el ? el.parentElement : null;
    while (p) {
      const oy = getComputedStyle(p).overflowY;
      if (oy === 'auto' || oy === 'scroll') return p;
      p = p.parentElement;
    }
    return null;
  },
  _bindThinkToggleAnchor(): void {
    const ed = this.editorEl as HTMLElement | null;
    if (!ed || (ed as any)._thinkAnchorBound) return;
    (ed as any)._thinkAnchorBound = true;
    // click（捕获）在默认折叠动作发生前触发：记下锚元素与滚动状态
    // 锚元素优先取蓝框自身的下一个兄弟；没有（生成完成态：蓝框是思考容器的唯一子元素）
    // 则向上找最近一个「有下个兄弟」的祖先——通常是思考容器的兄弟（正文 sink），
    // 保证「钉住用户正在看的下方内容」这一语义在任何嵌套下都成立。
    ed.addEventListener('click', (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      const sum = t && t.closest ? (t.closest('.cot-thinking > summary') as HTMLElement | null) : null;
      if (sum) {
        const det = sum.parentElement as HTMLElement;
        (det as any)._hBefore = det.offsetHeight;
        // 向上找最近的有下个兄弟的祖先（不越出编辑器根）
        let ref: HTMLElement | null = null;
        let cur: HTMLElement | null = det;
        while (cur && cur !== ed) {
          if (cur.nextElementSibling) { ref = cur.nextElementSibling as HTMLElement; break; }
          cur = cur.parentElement;
        }
        (det as any)._refEl = ref;
        (det as any)._refTopBefore = ref ? ref.getBoundingClientRect().top : null;
        // 记录收起前 summary 的视口位置与滚动容器：判定用户是否正看着框本身
        const scroller = this._scrollParentOf(det) || (ed as HTMLElement);
        (det as any)._sumTopBefore = sum.getBoundingClientRect().top;
        (det as any)._scrollerTopBefore = scroller.getBoundingClientRect().top;
      }
    }, true);
    ed.addEventListener('toggle', (e: Event) => {
      const det = e.target as HTMLElement;
      if (!det || !det.classList || !det.classList.contains('cot-thinking')) return;
      const before = (det as any)._hBefore as number | null;
      (det as any)._hBefore = null;
      if (before == null) return;
      const refEl = (det as any)._refEl as HTMLElement | null;
      const refTopBefore = (det as any)._refTopBefore as number | null;
      const sumTopBefore = (det as any)._sumTopBefore as number | null;
      const scrollerTopBefore = (det as any)._scrollerTopBefore as number | null;
      (det as any)._refEl = null; (det as any)._refTopBefore = null;
      (det as any)._sumTopBefore = null; (det as any)._scrollerTopBefore = null;
      const scroller = this._scrollParentOf(det) || (this.editorEl as HTMLElement);
      // 只在「用户看的区域在蓝框下方」（summary 已滚出可视区上缘）时补偿视口：
      // 该场景下用户正在看框下方/内部靠后的内容，期望是「我看的文字不动，下面的文字往上」。
      // 用户正盯着 summary（框在其眼前）收起时保持自然行为——框原地缩掉，下方文字上滑。
      const watchingBoxItself = (sumTopBefore != null && scrollerTopBefore != null && sumTopBefore >= scrollerTopBefore);
      if (!watchingBoxItself && refEl && refTopBefore != null) {
        // 首选：把锚元素拉回收起前的视口位置（零推算误差）
        scroller.scrollTop = Math.max(0, scroller.scrollTop + (refEl.getBoundingClientRect().top - refTopBefore));
      } else if (!watchingBoxItself) {
        // 兜底：蓝框之后没有任何兄弟元素（正文为空等）时按高度差补偿（折叠为正/展开为负）
        const delta = before - det.offsetHeight;
        if (delta) scroller.scrollTop = Math.max(0, scroller.scrollTop - delta);
      }
    }, true);
  },
  onInput(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      App.saveCurrentChapter?.();
      App.updateWordCount?.();
      const st = document.getElementById('editor-status');
      if (st) st.textContent = '已自动保存 ' + new Date().toLocaleTimeString();
    }, 500);
    const st = document.getElementById('editor-status');
    if (st) st.textContent = '未保存...';
  },
  getContent(): string {
    let html = this.editorEl ? this.editorEl.innerHTML : '';
    // 未闭合思考提示条不属于正文，存档前抠掉
    html = html.replace(/<div\b[^>]*class\s*=\s*["'][^"']*think-unclosed-notice[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
    html = html.replace(/<span class="dialogue"[^>]*>(.*?)<\/span>/g, '$1');
    return html;
  },
  setContent(html: string): void {
    if (this.editorEl) {
      this.editorEl.innerHTML = html || '';
      this.highlightDialogue();
      App.updateWordCount?.();
      this._syncScrollBottomBtn?.();   // 换章/导入后浮钮状态要跟着正文长度走
    }
  },
  highlightDialogue(): void {
    if (!this.editorEl) return;
    let html = this.editorEl.innerHTML;
    html = html.replace(/<span class="dialogue"[^>]*>(.*?)<\/span>/g, '$1');
    html = html.replace(/「[^「」]*」/g, '<span class="dialogue">$&</span>');
    this.editorEl.innerHTML = html;
  },
  insertAtCursor(html: string): void {
    let hhtml = html;
    // {{user}} 替换为主角名
    const protag = App.getProtagonist?.();
    const protagName = (protag && protag.name) ? protag.name : '主角';
    hhtml = hhtml.replace(/\{\{user\}\}/gi, protagName);
    // 对白高亮
    hhtml = hhtml.replace(/「[^「」]*」/g, '<span class="dialogue">$&</span>');
    this.lastWrapper = document.createElement('div'); this.lastWrapper.className = 'ai-generated'; this.lastWrapper.innerHTML = hhtml;
    const wrapper = this.lastWrapper;
    (this.editorEl as HTMLElement).appendChild(wrapper);
    const br = document.createElement('br'); (this.editorEl as HTMLElement).appendChild(br);
    this.lastBr = br;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const editor = document.getElementById('editor');
        const wrapperTop = (wrapper as HTMLDivElement).offsetTop;
        if (editor) editor.scrollTop = wrapperTop;
      });
      if (!isMobile) {
        (this.editorEl as HTMLElement).focus({ preventScroll: true } as FocusOptions);
        const sel = window.getSelection(); const range = document.createRange();
        range.setStartAfter(br); range.collapse(true); sel?.removeAllRanges(); sel?.addRange(range);
      }
    });
    this.onInput();
  },

  startStreaming(): void {
    this._dashCount = 0;
    this._streamingScrolled = false;
    this._streamingRaw = '';
    this._thinkingSkipNotified = false;
    this._tokenHold = '';
    this._pendingStream = '';
    this._discardingDelta = false;
    this._deltaPrefixBuf = '';
    // 世界书「变量」：只有当前书启用了变量条目时才挂过滤器（否则上屏路径逐字节与之前一致）
    this._statusFilter = null;
    try { if (StatusVars.enabled('novel')) this._statusFilter = createStatusStreamFilter(); } catch (e) { this._statusFilter = null; }
    this._streamThinkBox = null;
    this._streamSink = null;
    this._openThink = null;
    // 思考强度：off 时不建思维链框、剥离思考标签（正文照常流式）；其余档位照常。
    // 协议自愈：该模型被判定"不吃标签协议"时同样不建框（思考按正文处理）。
    // editor.ts 为遗留无 import 模块（运行时全局），经 globalThis 访问 App
    const _appG = (globalThis as any).App;
    this._deepThinkOn = _appG && typeof _appG.thinkingLevel === 'function' ? _appG.thinkingLevel() !== 'off' : true;
    if (_appG && typeof _appG.thinkBoxDisabledForModel === 'function' && _appG.thinkBoxDisabledForModel()) this._deepThinkOn = false;
    this._streamingWrapper = document.createElement('div');
    this._streamingWrapper.className = 'ai-generated';
    (this.editorEl as HTMLElement).appendChild(this._streamingWrapper);
    // 平滑流式结构：思考框与正文两个独立容器；正文增量追加（不再全量 innerHTML）
    this._streamThinkBox = document.createElement('div');
    this._streamSink = document.createElement('div');
    this._streamingWrapper.appendChild(this._streamThinkBox);
    this._streamingWrapper.appendChild(this._streamSink);
    this._streamingBr = document.createElement('br');
    (this.editorEl as HTMLElement).appendChild(this._streamingBr);
  },

  // 把模型输出里的 <!-- 注释 / <think> 标签 --> 转换为可见的折叠块。
  // open=true：流式时展开（灰色，带光标）；open=false：结束后折叠。
  _renderThinking(raw: string, open: boolean): string {
    return raw
      .replace(/<!--([\s\S]*?)(-->|$)/g, function (_, inner: string, term: string) {
        const esc = inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const label = open ? '思考中…' : '思考';
        const caret = (open && !term) ? '▍' : '';
        return '<details class="cot-thinking" contenteditable="false"' + (open ? ' open' : '') + '><summary>' + label + '</summary>' + esc + caret + '</details>';
      })
      .replace(/<think(?:ing)?\s*>([\s\S]*?)(<\/think(?:ing)?\s*>|$)/gi, function (_, inner: string, term: string) {
        const esc = inner.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const label = open ? '思考中…' : '思考';
        const caret = (open && !term) ? '▍' : '';
        return '<details class="cot-thinking" contenteditable="false"' + (open ? ' open' : '') + '><summary>' + label + '</summary>' + esc + caret + '</details>';
      })
      // 漏闭合的 <think>（无 </think>）：一律去掉标签字符保留为正文（正文优先）
      .replace(/<\/?think(?:ing)?\s*>/gi, '');
  },

  // API 原生思维链（reasoning_content）实时进思考框：opencode/deepseek 等推理模型的
  // 推理走该通道，正文流里没有思考标签——不接上的话流式期间思考框
  // 空白、正文首字要等推理完成（感知"很慢"）
  appendReasoning(rc: string): void {
    if (!this._streamingWrapper || !rc) return;
    if (!this._deepThinkOn) return; // 深度思考已关闭：不显示
    // 防吞正文：正文已开始（_pendingStream/_streamingRaw 非空）说明 reasoning 晚于正文到达
    // （部分网关 content 与 reasoning 交错）——此时不建实时框，否则 _flushStreaming 会把
    // pending 里的正文误当思考塞进框（正文进思维链根因）。reasoning 仍由 onDone 结束端统一显示。
    if (this._streamingRaw || this._pendingStream) return;
    if (!this._thinkingSkipNotified) this._thinkingSkipNotified = true; // 已有原生思维链，不再提示模型"跳过思维链"
    this._openThinkReasoning = true;
    if (this._openThink) {
      this._appendToOpenThink(rc);
    } else {
      this._openThink = this._createThinkTextBox();
      this._openThink.nodeValue = (this._openThink.nodeValue || '') + rc;
    }
  },

  appendStreaming(text: string): void {
    if (!this._streamingWrapper) return;
    // 正文首字到来 = API 推理结束 → 闭合 reasoning 实时框（正文此后走正文流，不再被吞进框）
    if (!this._streamingRaw && this._openThinkReasoning && this._openThink) {
      this._closeThink();
    }
    this._openThinkReasoning = false;
    this._streamingRaw += text;
    // Agent 设定同步：跨 chunk 丢弃 [SETTING_DELTA]…[/SETTING_DELTA] 块（含未闭合残块到行尾）。
    // 必须在 _pendingStream 之前过滤——否则格式逐字上屏进 sink，完成态提交时正文原位保留，
    // onDone 再剥也来不及（sink 已是最终正文）。
    text = this._stripStreamingDelta(text);
    // 世界书「变量」：把 <status>…</status> 挡在上屏之前，理由与上一行完全相同
    // （sink 是最终正文，onDone 再剥来不及）。空过滤器＝当前书没用变量功能，原样放行。
    if (this._statusFilter) { try { text = this._statusFilter.feed(text); } catch (e) { /* 过滤失败按原样上屏 */ } }
    // 上一轮扣留的尾巴先并回（它在流里位于新文本之前）：跨 chunk 的标记才能拼齐
    // （"<th" + "inking>" → "<thinking>"），且不会破坏 pending 与新文本的先后顺序。
    this._pendingStream += this._tokenHold + text;
    this._tokenHold = '';
    // 平滑渲染：累积后由 40ms 定时器匀速消费（正文按帧少量追加），思考注释块一次建框
    if (!this._streamingTimer) {
      this._streamingTimer = setTimeout(() => { this._streamingTimer = null; this._flushStreaming(); }, 40);
    }
    // 检测模型是否跳过显性思维链直接输出正文（仅当预设要求思维链时，每次生成最多提示一次）
    if (this._thinkingRequired && !this._thinkingSkipNotified) {
      const _probe = this._streamingRaw.replace(/^[\s\-——=*_>]+/, '').slice(0, 200);
      // 指令要求的是 <thinking> 标签（generate 已统一收敛），认 <thinking>/<think>/<!-- 任一
      if (_probe.length >= 40 && !/<thinking|<think|<!--/.test(_probe)) {
        this._thinkingSkipNotified = true;
        console.warn('[COT] 模型未输出 `<thinking>` 思维链，直接输出正文');
      }
    }
    // 首个 chunk 滚动到流式输出
    if (!this._streamingScrolled) {
      this._streamingScrolled = true;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const editor = document.getElementById('editor');
          if (editor && this._streamingWrapper) editor.scrollTop = this._streamingWrapper.offsetTop;
        });
      });
    }
  },

  // 流式 delta 过滤状态机：返回剔除 delta 块后的可上屏文本。
  // 丢弃模式：遇到开标记（任意变体）进入；闭标记（任意变体）或行尾/文末退出。
  // 开标记可能被 chunk 劈开（`[SETTING_` + `DELTA]…`），因此输出前把末尾疑似前缀扣留，
  // 确认构成完整开标记才进入丢弃，否则吐出扣留内容——正文永不因扣留而丢字。
  _stripStreamingDelta(text: string): string {
    const src = String(text || '');
    if (!src) return '';
    // 若正处在丢弃模式，先把上一轮扣留的疑似前缀清掉（它属于被丢弃块）
    const held = this._deltaPrefixBuf;
    this._deltaPrefixBuf = '';
    let work = held + src;
    let out = '';
    // 丢弃模式：只在闭标签处退出（块独占末尾；漏闭保持丢弃，onDone 兜底剥残块）
    if (this._discardingDelta) {
      const cm = DELTA_CLOSE_RE.exec(work);
      if (cm) {
        work = work.slice(cm.index + cm[0].length);
        this._discardingDelta = false;
      } else {
        return '';
      }
    }
    // 正常模式：逐段找开标记，输出前扣留疑似前缀
    out = this._stripOpenPrefix(work);
    return out;
  },

  // 在 work 里找完整开标记；末尾若残留其前缀则扣留到 _deltaPrefixBuf
  _stripOpenPrefix(work: string): string {
    let rest = work;
    let out = '';
    for (;;) {
      const mo = DELTA_OPEN_RE.exec(rest);
      if (mo) {
        out += rest.slice(0, mo.index);
        // 找到开标记：进入丢弃，块内容从开标记后开始
        const after = rest.slice(mo.index + mo[0].length);
        this._discardingDelta = true;
        // 立即处理块内容（可能同 chunk 有闭标签）
        rest = this._consumeDiscard(after);
        continue;
      }
      // 无完整开标记：检查末尾是否有前缀残留
      const tail = this._tailOpenPrefix(rest);
      if (tail !== '') {
        // 扣留疑似前缀，其余输出
        out += rest.slice(0, rest.length - tail.length);
        this._deltaPrefixBuf = tail;
        return out;
      }
      out += rest;
      return out;
    }
  },

  // 返回 rest 末尾疑似「开标记前缀」的最长片段（`[` 起、其后仅 ASCII 字母/下划线/空白，
  // 如 `[SETTING_`、`[SETTINGS_DELTA`）；单个 `[` 也扣留（chunk 恰好切在 `[` 之后的形态）。
  // 中文正文的方括号（如「[笑」）不匹配该形态，不会被扣留。
  _tailOpenPrefix(rest: string): string {
    const maxKeep = 24;
    const from = Math.max(0, rest.length - maxKeep);
    const tail = rest.slice(from);
    for (let keep = tail.length; keep > 0; keep--) {
      const cand = tail.slice(tail.length - keep);
      if (!DELTA_PARTIAL_RE.test(cand)) continue;
      if (keep === 1 || /[A-Za-z_]/.test(cand)) return cand;
    }
    return '';
  },

  // 丢弃块内容直到闭标签/文末；返回剩余正文。
  // 注意：不因换行退出——delta 块可能被模型格式化成多行 JSON，且指令要求块独占末尾、
  // 块后不再有正文；只有闭标签（或下一轮仍无闭则保持丢弃，onDone 兜底剥残块）才恢复。
  _consumeDiscard(after: string): string {
    const cm = DELTA_CLOSE_RE.exec(after);
    if (cm) {
      this._discardingDelta = false;
      return after.slice(cm.index + cm[0].length);
    }
    // 无闭标签：保持丢弃（可能跨 chunk / 模型漏闭），剩余全丢
    return '';
  },

  // 平滑流式主循环：每 40ms 消费一帧
  _flushStreaming(): void {
    if (!this._streamingWrapper || !this._streamSink) return;
    const protag = App.getProtagonist?.();
    const protagName = (protag && protag.name) ? protag.name : '主角';

    // 1) 思考/正文分离：思考注释（含未闭合）实时进蓝框并跨帧持续追加，正文走匀速消费
    this._takeThinkingAndPre(protagName);

    // 2) 正文匀速消费：每帧最多 8 字
    if (this._pendingStream && !this._openThink) {
      const chunk = this._pendingStream.slice(0, 8);
      this._pendingStream = this._pendingStream.slice(8);
      this._appendSmooth(chunk, protagName);
    }

    // 3) 还有剩余 → 下一帧继续
    if (this._pendingStream && !this._streamingTimer) {
      this._streamingTimer = setTimeout(() => { this._streamingTimer = null; this._flushStreaming(); }, 40);
    }

    // 光标跟随最新内容
    try {
      const sel = window.getSelection();
      const range = document.createRange();
      if (this._streamingBr) range.setStartAfter(this._streamingBr);
      range.collapse(true);
      sel?.removeAllRanges(); sel?.addRange(range);
    } catch (e) { /* 无光标上下文忽略 */ }
  },

  // 思考/正文分离。协议（生成侧指令见 app.ts）：`<thinking>…（任意长度）…</thinking>`，
  // `</thinking>` 独占一行闭合，正文以 `【正文】` 开头。判定顺序：闭标记 → 正文标记；
  // 两者都没等到就继续留在思考框——**长度不参与任何判定**（思维链可能上万字）。
  // 跨 chunk 的标记前缀一律扣留（_tokenHold），等下一帧拼齐再判定，避免标记被当正文吃掉。
  _takeThinkingAndPre(protagName: string): void {
    if (!this._streamThinkBox || !this._streamSink) return;
    // 扣留的尾巴在流序上位于 _pendingStream 之后（它是"已收到文本"的末尾，而 pending 是尚未消费的前文），
    // 必须拼在**末尾**。拼在前面会把它当成前文先渲染 → 末尾字符顺序颠倒：
    // 单帧 "abcdefghi-" 上屏成 "abcdefgh-i"（"-" 是 "-->" 的前缀被扣留，下一轮又跑到 "i" 前面）。
    // 分帧不变量属性测试的反例即此类。
    let rest = this._pendingStream + this._tokenHold;
    this._tokenHold = '';

    // === 进行中的思考块（已见到开标签，尚未见到闭标记/正文标记）===
    if (this._openThink) {
      const cm = THINK_CLOSE_RE.exec(rest);
      const bmIdx = cm ? -1 : rest.indexOf(BODY_MARKER);
      if (cm) {
        // 闭标记到达：闭标记前内容入思考框；闭标记（含）之后 → 永久回正文
        const before = rest.slice(0, cm.index);
        if (before) this._appendToOpenThink(before);
        this._closeThink();
        rest = stripLeadingBodyMarker(rest.slice(cm.index + cm[0].length));
      } else if (bmIdx >= 0) {
        // 正文标记到达：思考到此为止，标记之后即正文（标记不上屏）
        const before = rest.slice(0, bmIdx);
        if (before) this._appendToOpenThink(before);
        this._closeThink();
        rest = stripLeadingBodyMarker(rest.slice(bmIdx));
      } else {
        // 未判定出边界：内容继续进框；末尾疑似标记前缀扣留等下一帧
        const hold = tailPartialToken(rest);
        const body = hold ? rest.slice(0, rest.length - hold.length) : rest;
        if (body) this._appendToOpenThink(body);
        this._tokenHold = hold;
        this._pendingStream = '';
        return;
      }
      if (rest) this._appendSmooth(rest, protagName);
      this._pendingStream = '';
      return;
    }

    // === 无进行中思考：找最早的思考开标签 ===
    const om = THINK_OPEN_RE.exec(rest);
    if (!om) {
      // 无思考标记 → 正文照常匀速消费；末尾疑似标记前缀扣留（不参与本轮消费）
      const hold = tailPartialToken(rest);
      this._tokenHold = hold;
      this._pendingStream = hold ? rest.slice(0, rest.length - hold.length) : rest;
      return;
    }

    // 开标签前的正文 → 先入正文
    if (om.index > 0) {
      this._appendSmooth(rest.slice(0, om.index), protagName);
      rest = rest.slice(om.index);
    }
    const tail = rest;
    const cm = THINK_CLOSE_RE.exec(tail);
    if (cm) {
      // 开+闭同帧：整段进思考框，闭标记后内容回正文
      const blk = tail.slice(0, cm.index + cm[0].length);
      this._appendThinkBlocks([blk]);
      const after = stripLeadingBodyMarker(tail.slice(cm.index + cm[0].length));
      if (after) this._appendSmooth(after, protagName);
      rest = '';
    } else {
      // 开标签未闭合：立即建框，内容进进行中（无长度上限）
      this._openThink = this._createThinkTextBox();
      const body = this._stripThoughtTags(tail);
      if (body) this._openThink.nodeValue = (this._openThink.nodeValue || '') + body;
      rest = '';
    }
    this._pendingStream = rest;
  },

  // 建一个 open 状态的思考框并返回其文本节点（进行中思考用）
  _createThinkTextBox(): Text {
    const det = document.createElement('details');
    det.className = 'cot-thinking';
    det.setAttribute('contenteditable', 'false');
    det.setAttribute('open', '');
    // 深度思考已关闭：思考框隐藏（状态机照常，结束端由 app 层替换为纯正文）
    if (!this._deepThinkOn) det.setAttribute('hidden', '');
    const sum = document.createElement('summary');
    sum.textContent = '思考中…';
    det.appendChild(sum);
    const txt = document.createTextNode('');
    det.appendChild(txt);
    this._streamThinkBox!.appendChild(det);
    return txt;
  },

  _appendToOpenThink(text: string): void {
    if (this._openThink) this._openThink.nodeValue = (this._openThink.nodeValue || '') + text;
  },

  _closeThink(): void {
    if (this._openThink) {
      const det = this._openThink.parentElement as HTMLElement | null;
      const sum = det ? det.querySelector('summary') : null;
      if (sum) sum.textContent = '思考';
      this._openThink = null;
    }
  },

  // 追加一段正文到 sink（每帧少量，匀速）。
  // 对话高亮策略：「出现即建 dialogue span（打开即高亮），跨帧持续追加，直到」闭合；
  // 若帧内本身就是完整「…」对，一次性建 span。正文 sink 增量追加，不做整块重建。
  _appendSmooth(chunkIn: string, protagName: string): void {
    if (!this._streamSink) return;
    let chunk = chunkIn.replace(/\{\{user\}\}/gi, protagName);
    chunk = chunk.replace(/——/g, () => ++this._dashCount <= 3 ? '——' : '—');
    // 流式期间只做引号归一化（弯引号 → 「」），【不】做段内配对/删除——
    // normalizeQuotes 的"段内多余引号删除"会把跨帧拆开的「…」的第二帧单独成段，
    // 段内没有开着的「 → 多余的」被删掉（`「你好啊」我说` 流式变成 `「你好啊我说`，闭合标记丢失）。
    // 配对修复统一留给结束端对完整全文执行。
    chunk = chunk.replace(/[“«「]/g, '「').replace(/[”»」]/g, '」');
    if (!chunk) return;
    const frag = document.createDocumentFragment();
    let rest = chunk;
    // 1) 已有跨帧打开的 dialogue span：继续吞直到「」闭合
    if (this._openDialogue) {
      const closeIdx = rest.indexOf('」');
      if (closeIdx >= 0) {
        const head = rest.slice(0, closeIdx + 1);
        this._openDialogue.textContent = (this._openDialogue.textContent || '') + head;
        this._openDialogue = null; // 闭合
        rest = rest.slice(closeIdx + 1);
      } else {
        this._openDialogue.textContent = (this._openDialogue.textContent || '') + rest;
        return; // 全部并入打开的对话，本帧无剩余
      }
    }
    if (!rest) return;
    // 2) 帧内完整「…」对：一次性高亮
    const reInner = /「[^「」]*」/g;
    let mm: RegExpExecArray | null;
    let last = 0;
    while ((mm = reInner.exec(rest))) {
      if (mm.index > last) frag!.appendChild(document.createTextNode(rest.slice(last, mm.index)));
      const span = document.createElement('span');
      span.className = 'dialogue';
      span.textContent = mm[0];
      frag!.appendChild(span);
      last = mm.index + mm[0].length;
    }
    // 3) 剩余尾部：若以「开头且无闭合 → 打开即高亮（建 span，跨帧持续）；否则原样入正文
    const tail = rest.slice(last);
    if (tail) {
      const openIdx = tail.indexOf('「');
      if (openIdx >= 0 && tail.indexOf('」', openIdx) < 0) {
        if (openIdx > 0) frag!.appendChild(document.createTextNode(tail.slice(0, openIdx)));
        const span = document.createElement('span');
        span.className = 'dialogue';
        span.textContent = tail.slice(openIdx);
        frag!.appendChild(span);
        this._openDialogue = span;
      } else {
        frag!.appendChild(document.createTextNode(tail));
      }
    }
    if (frag.childNodes.length > 0) this._streamSink.appendChild(frag);
  },

  // 思考块一次建框（open 状态，与完成态同款 details；直接建 DOM，不依赖 innerHTML 解析）
  _appendThinkBlocks(blocks: string[]): void {
    if (!this._streamThinkBox) return;
    blocks.forEach((b) => {
      const det = document.createElement('details');
      det.className = 'cot-thinking';
      det.setAttribute('contenteditable', 'false');
      det.setAttribute('open', '');
      // 深度思考已关闭：思考块隐藏（状态机照常，结束端由 app 层替换为纯正文）
      if (!this._deepThinkOn) det.setAttribute('hidden', '');
      const sum = document.createElement('summary');
      sum.textContent = '思考';
      det.appendChild(sum);
      det.appendChild(document.createTextNode(this._stripThoughtTags(b)));
      this._streamThinkBox!.appendChild(det);
    });
  },

  _stripThoughtTags(b: string): string {
    return String(b)
      .replace(/^<!--\s*/, '')
      .replace(/^<think(?:ing)?\s*>\s*/i, '')
      .replace(/-->\s*$/, '')
      .replace(/<\/think(?:ing)?>\s*$/i, '')
      .trim();
  },

  // 完成态提交（替换流式 DOM → 折叠后的全文 HTML + 对白高亮 + 视口锚定 + 清理）
  _commitFinished(html: string, editor: HTMLElement | null) {
    const wrapper = this._streamingWrapper!;
    const thinkBox = this._streamThinkBox;
    const sink = this._streamSink;
    // 关键：先把未消费的流式缓冲同步落进正文。平滑渲染 40ms 只消费 8 字，完成瞬间
    // _pendingStream 里往往还压着一段尾巴——不补齐则 sink 缺尾，下方"正文补回"会
    // 误判为缺尾并追加，叠加上切口偏移（见下）就把结尾一段渲染了两遍。
    // 跨 chunk 的两个扣留缓冲（思考标记前缀 / delta 标记前缀）也在这一刻释放——绝不因扣留丢字。
    // 思考未闭合时 pending 属于思考框（完成态由 thinkPart 整体替换），跳过正文 drain。
    const _protag = App.getProtagonist?.();
    const _protagName = (_protag && _protag.name) ? _protag.name : '主角';
    if (this._tokenHold) { this._pendingStream += this._tokenHold; this._tokenHold = ''; }
    if (this._deltaPrefixBuf) { this._pendingStream += this._deltaPrefixBuf; this._deltaPrefixBuf = ''; }
    // 变量块过滤器收尾：扣留的疑似标记前缀就地吐回（未闭合块＝丢弃，onDone 会再剥一次）——
    // 与 _deltaPrefixBuf 同级，绝不因扣留丢字。
    if (this._statusFilter) {
      try { const _rel = this._statusFilter.release(); if (_rel) this._pendingStream += _rel; } catch (e) { /* ignore */ }
      this._statusFilter = null;
    }
    // 极快的端点可能在两帧之间把整段回复送完 → pending 里压着从未过状态机的原文。
    // 直接 drain 会把思考标签与 `【正文】` 标记原样写进正文（真机 mock 回归），
    // 因此先跑一遍思考/正文分离，再 drain 残余。
    if (this._pendingStream) this._takeThinkingAndPre(_protagName);
    if (this._pendingStream && !this._openThink && sink) {
      const rest = this._pendingStream;
      this._pendingStream = '';
      if (this._streamingTimer) { clearTimeout(this._streamingTimer); this._streamingTimer = null; }
      this._appendSmooth(rest, _protagName);
    }
    // 提交时不会再有下一帧：上面若扣留了"疑似标记前缀"，必须就地落地（否则末尾字符丢失）
    if (this._tokenHold) {
      const _held = this._tokenHold;
      this._tokenHold = '';
      if (this._openThink) this._appendToOpenThink(_held);
      else if (sink) this._appendSmooth(_held, _protagName);
    }
    // 视口锚定：以正文起点（无正文用 wrapper 顶）为锚，提交前后重测其视口 Y，scrollTop 补差额。
    // 锚点元素钉在屏幕同一位置，与高度差推算无关（高度差推算在 max-height 裁剪下不可靠）。
    // 仅当锚点提交前在滚动容器可视范围附近才补偿——用户上滑读旧文时不拖动视口。
    const scroller = this._scrollParentOf(wrapper) || editor;
    const anchorEl = (sink || wrapper) as HTMLElement;
    const topBefore = anchorEl.getBoundingClientRect().top;
    const anchorNear = scroller ? topBefore < scroller.getBoundingClientRect().bottom + 400 : false;
    // 完成态 HTML = 【折叠思考块 details】+【正文】。只取思考块部分替换思考容器；
    // 正文（sink 内已流式渲染的 DOM）原位保留不动——流式正文即最终正文，不整块重建，
    // 从根上消除“折叠后正文瞬跳”（正文节点全程不参与任何替换/重建）。
    // 例外：模型漏闭合  thinking 时流式正文会被吞进思考框（sink 空/不完整），
    // 完成态必须用 html 里的正文（_body 已按正文优先剥离）补回 sink——正文优先，
    // 宁可思维链外露也绝不丢正文。用 html 正文与 sink 现有文本比较，缺失才补，
    // 避免「sink 已有完整正文」时重复拼接。
    const thinkPart = String(html || '').match(/<details class="cot-thinking"[\s\S]*?<\/details>/);
    const bodyText = String(html || '').replace(/<details class="cot-thinking"[\s\S]*?<\/details>/g, '').replace(/<br\s*\/?>/g, '\n').replace(/<[^>]*>/g, '');
    if (thinkBox) {
      if (thinkPart) {
        thinkBox.innerHTML = thinkPart[0];
      } else if (!html && this._streamingRaw) {
        // 完成态为空（解析异常）时保留流式思考框为折叠形态（fallback，不丢思维链）
        const _fallback = document.createElement('div');
        _fallback.innerHTML = this._renderThinking(this._streamingRaw, false);
        while (_fallback.firstChild) thinkBox.appendChild(_fallback.firstChild);
      }
    }
    // 正文补回：流式正文与完成态正文的引号归一不一致（半角 " 转「」/段内去重）时
    // 整体比较必然不等，不能整段追加（会出"正文两遍"）。只做两种恢复：
    // 1) sink 为空（模型漏闭合  thinking 把正文吞进思考框）→ 补回 html 完整正文；
    // 2) sink 已有正文但结尾缺失（流式中断/漏闭合兜底转正文只写了一半）→ 只补缺失的尾部。
    if (sink) {
      // 引号归一化后比较：流式未转的半角 " 与完成态「」视为等价
      const _normQ = function (t: string) {
        let open = false;
        return t.replace(/"/g, function () { open = !open; return open ? '「' : '」'; });
      };
      const curText = _normQ((sink.textContent || '').replace(/\s+/g, ''));
      const wantText = _normQ((bodyText || '').replace(/\s+/g, ''));
      if (wantText) {
        if (!curText) {
          const _div = document.createElement('div');
          _div.innerHTML = bodyText;
          while (_div.firstChild) sink.appendChild(_div.firstChild);
        } else if (wantText.length > curText.length && wantText.indexOf(curText) === 0) {
          // 只把缺的后半段补进 sink（不重建前面已渲染的 DOM，避免折叠瞬跳/引号差异叠加）。
          // 注意 curText 是去空白后的紧凑串：直接拿它切原始 bodyText 会把切口向前推
          // （正文里的换行数被计入偏移）→ 结尾一段重复出现。按紧凑长度映射回原始下标再切。
          let compacted = 0, rawCut = -1;
          for (let i = 0; i < bodyText.length; i++) {
            if (/\s/.test(bodyText[i])) continue;
            if (compacted === curText.length) { rawCut = i; break; }
            compacted++;
          }
          const _tail = rawCut >= 0 ? bodyText.slice(rawCut) : '';
          if (_tail.trim()) sink.appendChild(document.createTextNode(_tail));
        }
      }
    }
// 对白高亮：只对正文 sink 的文本节点原位替换 span（不重建任何外层容器）。
  if (sink) {
    const walker = document.createTreeWalker(sink, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let dn: Node | null;
    while ((dn = walker.nextNode())) nodes.push(dn as Text);
    nodes.forEach(function (node) {
      if (node.parentElement && node.parentElement.closest('.cot-thinking')) return;
      // 流式期间已高亮的完整「…」对已经包在 span.dialogue 里→ 这里跳过，避免完成态二次嵌套；
      // 只补裸文本节点里的残余对（例如模型漏标/旧逻辑遗留的跨节点段）。
      if (node.parentElement && node.parentElement.closest('span.dialogue')) return;
      // 半角 " 交替转「」（开闭同形，段内成对交替）后高亮；纯「」无需转换
      const rawText = node.nodeValue || '';
      let text = rawText;
      if (text.indexOf('"') >= 0 && !/「[^」]*」/.test(text)) {
        let open = false;
        text = text.replace(/"/g, function () { open = !open; return open ? '「' : '」'; });
      }
      if (!/「[^」]*」/.test(text)) return;
      const frag = document.createDocumentFragment();
      let last = 0;
      const re = /「[^」]*」/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const span = document.createElement('span'); span.className = 'dialogue'; span.textContent = m[0]; frag.appendChild(span);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode?.replaceChild(frag, node);
    });
  }
    // 视口锚定补偿（见函数头注释）：锚点视口位置差即正文真实位移
    if (scroller && anchorNear) {
      scroller.scrollTop = Math.max(0, scroller.scrollTop + (anchorEl.getBoundingClientRect().top - topBefore));
    }
    this.lastWrapper = this._streamingWrapper;
    this.lastBr = this._streamingBr;
    if (this._streamingTimer) clearTimeout(this._streamingTimer);
    this._streamingWrapper = null;
    this._streamingBr = null;
    this._streamingTimer = null;
    this._streamingRaw = '';
    this._pendingStream = '';
    this._tokenHold = '';
    this._streamThinkBox = null;
    this._streamSink = null;
    this._openThink = null;
    this._dashCount = 0;
    this._streamingScrolled = false;
    this.onInput();
  },

  // 完成：思维链收起引起的正文“瞬跳”改平滑——思考框高度 250ms 动画收缩，
  // 动画期间视口逐帧跟随高度减少量补偿（正文像被托住平滑上移，不硬跳）
  finishStreaming(html: string): void {
    if (this._streamingWrapper) {
      const editor = document.getElementById('editor');
      // 完成态为空时保留流式 DOM（fallback）——不折叠，直接提交
      if (!html && this._streamingRaw) { this._commitFinished(html, editor); return; }
      const box = this._streamThinkBox;
      if (box && box.children.length > 0 && box.scrollHeight > 0) {
        // 视口锚点 = 正文起点（无正文用思考容器）。动画期间逐帧把锚点钉在屏幕原位。
        // 旧实现读 box.scrollHeight 做「高度差补偿」——但 max-height:0 + overflow:hidden
        // 下 scrollHeight 恒等于完整内容高度，差值恒为 0，逐帧补偿从未生效（折叠仍滑动）。
        // getBoundingClientRect 反映裁剪后的真实布局，逐帧跟随才可靠。
        const scroller = this._scrollParentOf(box) || (editor as HTMLElement);
        const anchorEl = (this._streamSink || box) as HTMLElement;
        const anchorNear = anchorEl.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom + 400;
        const h0 = box.scrollHeight;
        box.style.maxHeight = h0 + 'px';
        box.style.overflow = 'hidden';
        box.style.transition = 'max-height 0.25s ease';
        void box.offsetHeight; // 强制 reflow，确保过渡从当前高度开始
        box.style.maxHeight = '0px';
        let prevTop = anchorEl.getBoundingClientRect().top;
        let rafId = 0;
        const tick = () => {
          if (anchorNear) {
            const top = anchorEl.getBoundingClientRect().top;
            scroller.scrollTop = Math.max(0, scroller.scrollTop + (top - prevTop));
            prevTop = top;
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        // 动画结束后清理过渡样式并提交完成态
        setTimeout(() => {
          if (rafId) cancelAnimationFrame(rafId);
          box.style.maxHeight = '';
          box.style.transition = '';
          box.style.overflow = '';
          this._commitFinished(html, editor);
        }, 280);
        return;
      }
      this._commitFinished(html, editor);
    } else {
      this.lastWrapper = null;
      this.lastBr = null;
      this.onInput();
    }
  },

  // 未闭合思考提示条：默认策略（keep）下未闭合思考内容保留在思考框、不进正文；
  // 但编辑器取正文会剔除 cot-thinking 块——必须给用户一个显式的"移回正文"出口，
  // 否则这段内容会从上下文/存档里静默消失。提示条本身不算正文（见 getContent/stripThinking）。
  showUnclosedThinkNotice(charCount: number): void {
    const host = this.lastWrapper || (document.getElementById('editor') as HTMLElement | null);
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'think-unclosed-notice';
    el.setAttribute('contenteditable', 'false');
    el.textContent = '模型未闭合思考标签：这 ' + charCount + ' 字已保留在「思考」框内，未计入正文。';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'think-unclosed-btn';
    btn.textContent = '移回正文';
    btn.onclick = () => this.moveUnclosedThinkToBody();
    el.appendChild(btn);
    host.appendChild(el);
    App.saveCurrentChapter?.();
  },

  // 违约补救：把最后一个思考框的内容移回正文
  moveUnclosedThinkToBody(): void {
    const editor = document.getElementById('editor');
    if (!editor) return;
    const notice = editor.querySelector('.think-unclosed-notice');
    const dets = editor.querySelectorAll('details.cot-thinking');
    const det = dets.length ? (dets[dets.length - 1] as HTMLElement) : null;
    if (det) {
      const clone = det.cloneNode(true) as HTMLElement;
      const sum = clone.querySelector('summary');
      if (sum) sum.remove();
      const text = (clone.textContent || '').trim();
      const p = document.createElement('div');
      p.textContent = text;
      det.parentNode?.replaceChild(p, det);
    }
    if (notice) notice.remove();
    App.saveCurrentChapter?.();
    App.updateWordCount?.();
  },

  cancelStreaming(): void {
    if (this._streamingTimer) clearTimeout(this._streamingTimer);
    this._streamingWrapper = null;
    this._streamingBr = null;
    this._streamingTimer = null;
    this._streamingRaw = '';
    this._pendingStream = '';
    this._tokenHold = '';
    this._discardingDelta = false;
    this._deltaPrefixBuf = '';
    this._statusFilter = null;
    this._streamThinkBox = null;
    this._streamSink = null;
    this._openThink = null;
    this._dashCount = 0;
    this._streamingScrolled = false;
  },

  // 从章节 HTML 中移除模型思考块与未闭合提示条，保证它们不进入后续 prompt/存档文本
  stripThinking(html: string): string {
    if (!html) return '';
    return html
      .replace(/<details\b[^>]*class\s*=\s*["'][^"']*cot-thinking[^"']*["'][^>]*>[\s\S]*?<\/details>/gi, '')
      .replace(/<div\b[^>]*class\s*=\s*["'][^"']*think-unclosed-notice[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '');
  },
  getPlainText(): string {
    if (!this.editorEl) return '';
    // 先剔思考块/提示条再取文本。注意：不能克隆后读 innerText —— 分离节点上 Chrome 会把
    // innerText 退化成 textContent（<br> 不再是换行），整篇正文会拼成一整行（见 lib/htmltext.ts）。
    return htmlToPlainText(this.stripThinking(this.editorEl.innerHTML || ''));
  },
  // 与写正文 generate 相同的上下文来源：
  // 有 AI 段落时取"最后一个 AI 段落到编辑器末尾"；无 AI 段落时用跨章节上下文
  getRecentStoryText(): string {
    const aiDivs = document.querySelectorAll('#editor .ai-generated');
    if (aiDivs.length > 0) {
      const lastDiv = aiDivs[aiDivs.length - 1] as HTMLElement;
      const lastDivText = lastDiv.innerText || '';
      const editorEl = document.getElementById('editor');
      const allText = editorEl ? (editorEl.innerText || '') : '';
      const lastDivStart = allText.indexOf(lastDivText);
      if (lastDivStart >= 0) return allText.slice(lastDivStart);
      return lastDivText;
    }
    return this.getCrossChapterContext(8000);
  },
  // 全量正文：所有章节纯文本按序拼接（带章节标题分隔）；超 maxChars 从最旧章节裁剪
  getFullNovelText(maxChars = 100000): string {
    const data = (App.getNovelData?.() ?? { chapters: [] }) as any;
    const chapters = data.chapters || [];
    const currentId = data.currentChapterId;
    const currentText = this.getPlainText();
    const parts: string[] = [];
    chapters.forEach(function (ch: any) {
      let text: string;
      if (ch.id === currentId) {
        text = currentText || '';
      } else {
        text = htmlToPlainText(EditorManager.stripThinking(ch.content || ''));
      }
      if (text && text.trim()) {
        parts.push('### ' + (ch.title || '未命名') + '\n' + text.trim());
      }
    });
    let full = parts.join('\n\n');
    if (full.length > maxChars) {
      full = full.slice(-maxChars);
      const firstBreak = full.indexOf('\n');
      if (firstBreak > 0 && firstBreak < 120) full = full.slice(firstBreak + 1);
    }
    return full;
  },
  getCrossChapterContext(maxChars = 3000, fullContext = false): string {
    const data = App.getNovelData?.() ?? { chapters: [] };
    const chapters = data.chapters || [];
    const currentId = data.currentChapterId;
    const currentText = this.getPlainText();

    // 全量模式：包含所有章节（首次生成用）
    if (fullContext) {
      let context = currentText || '';
      for (const ch of chapters) {
        if (ch.id === currentId) continue;
        const text = htmlToPlainText(this.stripThinking(ch.content || ''));
        if (text) context = text + '\n\n' + context;
      }
      if (context.length > maxChars) {
        context = context.slice(-maxChars);
        const firstBreak = context.indexOf('\n');
        if (firstBreak > 0 && firstBreak < 100) context = context.slice(firstBreak + 1);
      }
      return context;
    }

    // 智能模式：前章末尾 + 当前章
    if (!currentText && chapters.length <= 1) return currentText || '';
    let context = currentText || '';
    const curIdx = chapters.findIndex(ch => ch.id === currentId);

    // 补充前章末尾
    if (curIdx > 0 && context.length < maxChars) {
      const prevCh = chapters[curIdx - 1];
      if (prevCh) {
        let prevText = htmlToPlainText(this.stripThinking(prevCh.content || ''));
        if (prevText) {
          const remaining = maxChars - context.length;
          const tailLen = Math.min(500, remaining - 100);
          if (tailLen > 100) {
            prevText = prevText.length > tailLen ? '…' + prevText.slice(-tailLen) : prevText;
            context = prevText + '\n\n' + context;
          }
        }
      }
    }

    if (context.length > maxChars) {
      context = context.slice(-maxChars);
      const firstBreak = context.indexOf('\n');
      if (firstBreak > 0 && firstBreak < 100) {
        context = context.slice(firstBreak + 1);
      }
    }
    return context;
  }
};

export function htmlEscape(str: unknown): string {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const g = globalThis as unknown as { EditorManager: typeof EditorManager; htmlEscape: typeof htmlEscape };
g.EditorManager = EditorManager;
g.htmlEscape = htmlEscape;