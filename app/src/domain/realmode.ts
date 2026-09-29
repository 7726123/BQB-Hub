// RealMode：真实模式的视图与两条调用链（批次 2）。
// 一轮 = ① 公共调用（场记：场景/在场/公共事件/旁白/纪要/接话 + 判定作者那句的可感与壳）
//       ② 角色调用（本轮唯一说话人：只看自己可感的材料）
// 单角色不变量：私有材料只出现在同一个角色的那一次请求里（回归守卫见 app/tests/realmode.test.ts）。
// 界面元素由 web/index.html 的 #tab-real 提供（id 固定，见 app/tests/realmode-view.test.ts）。
import { RealState, visibleSplit } from './realstate';
import type { RealRecord, RealScene, RealShell } from './realstate';
import {
  buildPublicMessages, buildRoleMessages, buildMemoryMessages, buildEchoMessages, cleanEcho, cleanMemory,
  formatSlice, formatSubset, formatPublicRecent, parsePublicReply, parseRoleReply, extractBlocks,
} from './realprompt';
import type { Msg } from './realprompt';
import { parseBubbles } from '../lib/bubble';
import { autoGrow, bindAutoGrow } from '../lib/inputgrow';
import { WorldBookManager } from './worldbook';
import { normalizeStoryWindow } from '../lib/contextbudget';
import { SM } from '../infra/gate';

/** 视角切片注入给角色的条数上限（更早的折进"自己的回忆"） */
const MAX_SLICE = 60;
/** 转述时参考的"他之前说过的"轮数（太少稳不住语气，太多没必要还费 token） */
const ECHO_PREV = 2;
/** 窗口留空/自动时的兜底（字）：真实模式的记录比正文短得多，2 万字≈几百轮可见记录 */
const REAL_WINDOW_FALLBACK = 20000;
/** 输入框上方下拉里"上帝模式"的取值（不替任何人说话，只推进剧情） */
const GOD = '__god__';

function esc(s: any): string {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function nl2br(s: any): string {
  return String(s == null ? '' : s).replace(/\n/g, '<br>');
}
function el(id: string): any {
  try { return (globalThis as any).document ? document.getElementById(id) : null; } catch (e) { return null; }
}
function toast(msg: string): void {
  try { (globalThis as any).App?.toast?.(msg); } catch (e) { /* ignore */ }
}

/**
 * 把一行拆成「说出口的台词」与「动作/其余」两类片段。
 * **真实模式不能用对话模式那套说话人启发式**：那边有一条"没有前缀、又像叙述的行 → 判成旁白"的兜底，
 * 而真实模式一轮就是某一个人的回合——模型用小说体写（无前缀）时，那套兜底会把整轮reply全变成旁白块，
 * 气泡就没了（实测：say=2 act=3 但 rows=0 bubbles=0 narr=3）。所以这里只认引号。
 */
/** 去掉一层包裹：对话模式的气泡也是这么做的——引号/括号只是分隔符，不上屏（内容一字不动） */
function unquote(text: string): string {
  let t = String(text).trim();
  let m = t.match(/^[（(]([\s\S]*)[）)]$/);
  if (m) t = m[1].trim();
  m = t.match(/^\*([\s\S]*)\*$/);
  if (m) t = m[1].trim();
  m = t.match(/^[「『“"]([\s\S]*)[」』”"]$/);
  if (m) t = m[1].trim();
  return t;
}

function scanLine(line: string): { type: 'say' | 'act'; text: string }[] {
  const out: { type: 'say' | 'act'; text: string }[] = [];
  const re = /「([^」]*)」|『([^』]*)』|“([^”]*)”|"([^"]*)"/g;
  let i = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > i) out.push({ type: 'act', text: line.slice(i, m.index) });
    out.push({ type: 'say', text: String(m[1] || m[2] || m[3] || m[4] || '') });
    i = m.index + m[0].length;
  }
  if (i < line.length) out.push({ type: 'act', text: line.slice(i) });
  return out
    .map(function (x) { return { type: x.type, text: unquote(x.text) }; })
    .filter(function (x) { return String(x.text).trim().length > 0; });
}

function renderBlocks(blocks: { type: 'say' | 'act'; text: string }[]): string {
  return (blocks || []).map(function (x, i) {
    const br = i > 0 ? '<br>' : '';
    return br + (x.type === 'say'
      ? '<span class="chat-say">' + nl2br(esc(x.text)) + '</span>'
      : '<span class="chat-act">' + nl2br(esc(x.text)) + '</span>');
  }).join('');
}

export const RealMode = {
  _sending: false,
  _acc: '',
  _status: '',
  /** 压缩记忆那一次调用不画到记录区（它是内部整理，不是剧情） */
  _silent: false,
  /** 用户刚做了一个动作（发送/撤回/换书）→ 下一次重画贴一次底；之后重画不再动滚动位置 */
  _scrollOnce: false,
  _reasonChars: 0,
  _lastPaint: 0,
  _streamSpeaker: '',
  _inputKind: 'empty' as 'empty' | 'line' | 'narration' | 'direct',
  _playerInput: '',
  /** 作者这一轮实际落进记录的那一句（转述成功 = 整理后的；没转述 = 原话）——给场记当输入 */
  _playerCanon: '',
  _playerRecId: '',
  /** 用户在生成期间按了「停止」：这一轮不要再往下走（整理被停掉后，别接着喊场记） */
  _stopped: false,
  _next: '',

  // ---------- 基础 ----------
  bookId(): string {
    try { return WorldBookManager.getActiveId() || ''; } catch (e) { return ''; }
  },
  _entries(): any[] {
    try { const wb = WorldBookManager.getActive(); return (wb && (wb as any).entries) || []; } catch (e) { return []; }
  },
  _persona(name: string): string {
    const e = this._entries().find(function (x: any) { return x && x.type === '角色' && String(x.name || '') === String(name || ''); });
    return e ? String(e.content || '') : '';
  },
  /** 选人候选 = 本模式角色清单（排除作者正在扮演的那个）——在场由场记维护，不是候选的来源 */
  _roster(): { name: string; persona: string }[] {
    const me = this.player();
    return this.cast().filter(function (n: string) { return n !== me; })
      .map((n: string) => ({ name: n, persona: this._persona(n).replace(/\s+/g, ' ').slice(0, 60) }));
  },
  /** 有效在场名单：场景定过就用它；还没定（开局）用角色清单兜底，免得提示词里写「在场：（空）」 */
  _presentList(): string[] {
    const sc = this.scene();
    if (sc.present && sc.present.length) return sc.present.slice();
    return this.cast().slice(0, 12);
  },
  _others(name: string): { name: string; persona: string }[] {
    return this._presentList().filter(function (n: string) { return n !== name; })
      .map((n: string) => ({ name: n, persona: this._persona(n).replace(/\s+/g, ' ').slice(0, 60) }));
  },
  // ---------- 场景 / 扮演者 ----------
  scene(): RealScene { return RealState.scene(); },
  sceneInfo(): RealScene { return RealState.scene(); },
  /** 「大家都知道的事」（公开通知/传闻）：场记每轮维护，场景弹窗里用户也能改 */
  common(): string { return RealState.common(); },
  setCommon(text: string): void { RealState.setCommon(String(text || '').replace(/\r\n?/g, '\n').trim()); },
  player(): string { return RealState.player(); },
  saveScene(patch: Partial<RealScene>): void { RealState.setScene(patch || {}); this.render(); },
  setPlayer(name: string): void { RealState.setPlayer(String(name || '')); this.render(); },
  /** 输入框上方下拉：传角色名，或 `__god__` 表示上帝模式 */
  select(key: string): void {
    const k = String(key || '');
    if (k === GOD) { RealState.setGod(true); }
    else { RealState.setGod(false); RealState.setPlayer(k); }
    this.render();
  },
  selected(): string { return RealState.isGod() ? GOD : this.player(); },

  /** 导出/预览用：整份记录铺成文本（旁白成段、台词带说话人；内心保留成「（心声）…」） */
  toProseText(): string {
    const out: string[] = [];
    try {
      RealState.log().forEach(function (r: RealRecord) {
        let t = String(r.raw || '')
          .replace(/<\s*内心\s*>([\s\S]*?)<\s*\/\s*内心\s*>/gi, '（心声）$1')
          .replace(/<\s*私下[^>]*>/gi, '')
          .trim();
        if (!t) return;
        t = t.replace(/^旁白\s*[:：]\s*/gm, '');
        out.push(r.speaker ? r.speaker + '：' + t : t);
      });
    } catch (e) { /* ignore */ }
    return out.join('\n\n');
  },

  // ---------- 清空（和对话模式一样的一键清空） ----------
  clearAll(): void {
    const go = () => {
      try { RealState.clearStory(); } catch (e) { /* ignore */ }
      this._scrollOnce = true;
      this.render();
      toast('已清空这本书的真实模式记录');
    };
    try {
      const U = (globalThis as any).UIManager;
      if (U && typeof U.showConfirm === 'function') {
        U.showConfirm('清空这本书的真实模式记录与场景？参演名单和你在扮演的角色会保留（世界书不动）。', go);
      } else go();
    } catch (e) { go(); }
  },

  // ---------- 本模式的角色清单（输入框上方的「＋ 添加角色」） ----------
  cast(): string[] { return RealState.cast(); },
  removeCast(name: string): void {
    RealState.removeCast(String(name || ''));
    this._renderCastModal();
    this.render();
  },
  addCastFromModal(): void {
    const sel = el('realCastSel');
    const name = sel ? String(sel.value || '').trim() : '';
    if (!name) return;
    RealState.addCast(name);
    try {
      const sc = RealState.scene();
      if ((sc.present || []).indexOf(name) < 0) RealState.setScene({ present: (sc.present || []).concat([name]) });
    } catch (e) { /* ignore */ }
    this._renderCastModal();
    this.render();
    toast('已加入：' + name);
  },
  openCast(): void {
    this._renderCastModal();
    try { (globalThis as any).UIManager?.showModal?.('modalRealCast'); } catch (e) { toast('弹窗打不开'); }
  },
  /** 只在还没种过时，用"世界书里所有「角色」条目"种一次参演名单——这样点「继续」就能开局，不用先配场景 */
  _ensureCast(): void {
    try {
      if (RealState.castSeeded()) return;
      RealState.setCastSeeded(true);
      this._entries().filter(function (e: any) {
        return e && e.type === '角色' && String(e.name || '').trim();
      }).forEach((e: any) => RealState.addCast(String(e.name)));
    } catch (e) { /* ignore */ }
  },
  _renderCastModal(): void {
    const list = this.cast();
    const box = el('realCastList');
    if (box) {
      box.innerHTML = list.length
        ? list.map(function (n: string) {
          return '<div class="real-cast-row"><span>' + esc(n) + '</span>' +
            '<button class="ghost-btn" onclick="RealMode.removeCast(&quot;' + esc(n) + '&quot;)">移除</button></div>';
        }).join('')
        : '<div style="font-size:12px;color:var(--text-muted);">还没有加入角色：上面选一个点「添加」。</div>';
    }
    const sel = el('realCastSel');
    if (sel) {
      const avail = this._entries().filter(function (e: any) {
        return e && e.type === '角色' && String(e.name || '').trim() && list.indexOf(String(e.name)) < 0;
      }).map(function (e: any) { return String(e.name); });
      sel.innerHTML = avail.length
        ? avail.map(function (n: string) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('')
        : '<option value="">（世界书里的角色都加进来了）</option>';
    }
  },
  openScene(): void {
    try { (globalThis as any).UIManager?.openRealScene?.(); } catch (e) { toast('场景弹窗打不开'); }
  },

  // ---------- 预设（真实模式的模块；契约文本在 realprompt.ts） ----------
  _presetSystem(): string {
    try {
      const P = (globalThis as any).PresetManager;
      if (!P || typeof P.activeModules !== 'function') return '';
      const mods = P.activeModules('real') || [];
      return mods.filter(function (m: any) { return String((m && m.role) || 'system') === 'system'; })
        .map(function (m: any) { return String((m && m.content) || ''); }).filter(Boolean).join('\n\n');
    } catch (e) { return ''; }
  },
  _presetTail(): string {
    try {
      const P = (globalThis as any).PresetManager;
      if (!P || typeof P.tailText !== 'function') return '';
      // nativeReasoning=true：思考档位由 API 层管；这里只决定"发不发思考要求那类模块"，
      // 传 true 让 slot='think' 的模块（含内置的 min_27）正常下发。
      return String(P.tailText('real', { nativeReasoning: true, thinkingOff: false }) || '');
    } catch (e) { return ''; }
  },

  // ---------- 视图 ----------
  init(): void { this._scrollOnce = true; this.render(); },
  refreshSendLabel(): void {
    const ta = el('realInput');
    const btn = el('realSendBtn');
    if (!btn) return;
    if (this._sending) { btn.disabled = true; btn.innerHTML = '<span style="font-size:18px;">…</span>'; return; }
    btn.disabled = false;
    // 图标与对话模式同款：空输入 = 播放三角（继续/推进），有字 = 纸飞机（发送）
    const empty = !(ta && String(ta.value || '').trim());
    btn.title = empty ? '继续（让剧情自己走）' : '发送';
    btn.innerHTML = empty
      ? '<svg class="ic-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 4l14 8-14 8V4z"></path></svg>'
      : '<svg class="ic-20 rot-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>';
  },
  _renderHead(): void {
    const sc = this.scene();
    // 下拉的第一项就是「上帝模式」——啥都没选时把它落成真状态，否则下拉看着选中了、一点发送却说"没选角色"
    try { if (!RealState.isGod() && !this.player()) RealState.setGod(true); } catch (e) { /* ignore */ }
    const head = el('realSceneText');
    if (head) {
      const bits: string[] = [];
      if (sc.time) bits.push(sc.time);
      if (sc.place) bits.push(sc.place);
      bits.push((sc.present && sc.present.length) ? '在场：' + sc.present.join('、') : '（在场未设定）');
      head.textContent = bits.join(' · ');
    }
    // 参演名单只种一次（世界书里的角色条目）；在场由场记维护，不在这里碰
    this._ensureCast();
    const sel = el('realSpeakerSel');
    if (sel) {
      const cur = this.selected();
      sel.innerHTML = '<option value="' + GOD + '"' + (cur === GOD ? ' selected' : '') + '>上帝模式（不发言，只推进）</option>' +
        this.cast().map(function (n: string) {
          return '<option value="' + esc(n) + '"' + (n === cur ? ' selected' : '') + '>' + esc(n) + '</option>';
        }).join('');
    }
    const st = el('realStatus');
    if (st) st.textContent = this._status || '';
    this._bindGrow();
    this.refreshSendLabel();
  },

  /** 输入框（#realInput）接上自动增高：和写作页/对话模式**同一套实现**（空值回落 CSS 高度） */
  _bindGrow(): void {
    const ta = el('realInput');
    if (ta && !ta.__growBound) { ta.__growBound = true; bindAutoGrow(ta); }
  },

  _recordHtml(rec: RealRecord): string {
    const inner = extractBlocks(String(rec.raw || ''), '内心');
    let body = inner.rest;
    // 模型漏写 </内心> 闭标记时（实测会遇到）：从开标记起剩下的都算内心，别让标签原样显示在气泡里
    const openAt = body.search(/<\s*内心\s*>/i);
    if (openAt >= 0) {
      inner.blocks.push(body.slice(openAt).replace(/<\s*内心\s*>/i, ''));
      body = body.slice(0, openAt);
    }
    body = extractBlocks(body, '壳').rest.replace(/<\s*私下[^>]*>/gi, '');
    const speaker = String(rec.speaker || '');
    const lines = String(body).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length && !inner.blocks.length) return '';
    let out = '';
    if (!speaker) {
      // 旁白（世界侧叙述）成段显示；公共事件压成一行小字——不然每轮都是一大段"小说体"
      const narr: string[] = [];
      const notes: string[] = [];
      lines.forEach(function (l) {
        const t = l.replace(/^\s*旁白\s*[:：]\s*/, '');
        if (/^\s*【公共事件】/.test(t)) notes.push(t.replace(/^\s*【公共事件】\s*/, ''));
        else narr.push(t);
      });
      if (narr.length) out += '<div class="chat-narr">' + nl2br(esc(narr.join('\n'))) + '</div>';
      if (notes.length) out += '<div class="chat-note">' + nl2br(esc(notes.map(function (n) { return '· ' + n; }).join('\n'))) + '</div>';
      if (inner.blocks.length) out += '<div class="real-inner">' + nl2br(esc(inner.blocks.join('\n'))) + '</div>';
      return out;
    }
    // 不给每行加「说话人：」前缀——一轮只有一个说话人，用 defaultSpeaker 归属即可；
    // 加前缀的话，模型本来写对的行会变成「悠真：早啊…」把前缀也显示进气泡（页面验收踩到过）。
    const isMe = speaker === this.player();
    const av = this._avatar(speaker);
    // 一轮就是这个人的：旁白行（明确写「旁白：」的）单独成段，其余整轮算他的气泡（引号内＝台词）
    const narrLines: string[] = [];
    const mineLines: string[] = [];
    lines.forEach(function (l) {
      if (/^\s*旁白\s*[:：]/.test(l)) narrLines.push(l.replace(/^\s*旁白\s*[:：]\s*/, ''));
      else mineLines.push(l);
    });
    if (narrLines.length) out += '<div class="chat-narr">' + renderBlocks(scanLine(narrLines.join('\n'))) + '</div>';
    const mineBlocks = scanLine(mineLines.join('\n'));
    const innerHtml = inner.blocks.length
      ? '<div class="real-inner">' + inner.blocks.map(function (x: string) { return nl2br(esc(x)); }).join('<br>') + '</div>'
      : '';
    // 转述过的：留一个可展开的原话（默认收起——屏幕上就是整理后的一轮，和其他角色的输出一模一样）
    const echoHtml = rec.playerRaw
      ? '<div class="real-echo"><span class="real-echo-tag" onclick="RealMode.toggleEcho(this)">✎ 已整理 · 看原话</span>' +
        '<div class="real-echo-raw">' + nl2br(esc(rec.playerRaw)) + '</div></div>'
      : '';
    if (mineBlocks.length || innerHtml) {
      out += '<div class="chat-row' + (isMe ? ' chat-row-me' : '') + '">' + av +
        '<div class="chat-main"><div class="chat-name">' + esc(speaker) + '</div>' +
        '<div class="chat-bubble">' + renderBlocks(mineBlocks) + innerHtml + echoHtml + '</div></div></div>';
    }
    return out;
  },

  /** 「✎ 已整理 · 看原话」的展开/收起（内联 onclick 传 this） */
  toggleEcho(node: any): void {
    try {
      const box = node && node.parentNode;
      if (box && box.classList) box.classList.toggle('open');
    } catch (e) { /* ignore */ }
  },

  _avatar(name: string): string {
    // 点头像 = 打开角色简介（和对话模式同一个弹窗：世界书条目 + 就地换头像）
    const click = ' onclick="ChatMode.openProfile(\'' + esc(String(name || '').replace(/'/g, '')) + '\')"';
    try {
      const C = (globalThis as any).ChatMode;
      const av = (C && typeof C.avatar === 'function') ? C.avatar(name) : null;
      if (av && av.src) return '<img class="chat-av" src="' + esc(av.src) + '"' + click + ' alt="">';
      if (av) return '<div class="chat-av chat-av-txt" style="background:' + esc(av.color || '#8b8b8b') + '"' + click + '>' + esc(av.initial || '') + '</div>';
    } catch (e) { /* ignore */ }
    return '<div class="chat-av chat-av-txt" style="background:#8b8b8b"' + click + '>' + esc(String(name || '?').slice(0, 1)) + '</div>';
  },

  render(): void {
    const box = el('realStream');
    if (!box) { this._renderHead(); return; }
    const keepTop = Number(box.scrollTop) || 0;
    const log = RealState.log();
    let html = '';
    if (!log.length) {
      html = '<div class="chat-note">还没有开局：直接点「▶ 继续」，场记会自己定开场（时间、地点、在场）；也可以在输入框上方选个角色先开口。</div>';
    } else {
      log.forEach((r: RealRecord) => { html += this._recordHtml(r); });
    }
    if (this._sending && !this._silent) {
      if (this._acc) {
        html += this._recordHtml({ id: '_streaming', at: 0, kind: this._streamSpeaker ? 'npc' : 'scene', speaker: this._streamSpeaker, raw: this._acc, present: [] } as RealRecord);
      } else {
        html += '<div class="chat-note chat-waiting">' + esc(this._status || '思考中…') + '</div>';
      }
    }
    box.innerHTML = html;
    // 滚动：不自己贴底（用户自己滑），但重画不能把位置弄丢；只有"用户刚做了一个动作"才贴一次底
    try {
      if (this._scrollOnce) { box.scrollTop = box.scrollHeight; this._scrollOnce = false; }
      else if (typeof keepTop === 'number' && keepTop > 0) { box.scrollTop = keepTop; }
    } catch (e) { /* ignore */ }
    this._renderHead();
  },

  _paint(delta: string): void {
    this._acc += String(delta || '');
    if (this._sending && !this._silent) {
      const now = Date.now();
      if (now - this._lastPaint < 200) return;
      this._lastPaint = now;
      this.render();
    }
  },

  // ---------- 请求 ----------
  _call(msgs: Msg[], label: string): Promise<string | null> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: string | null) => { if (!settled) { settled = true; resolve(v); } };
      const A = (globalThis as any).APIHandler;
      if (!A || typeof A.fetchCompletions !== 'function') { toast('API 层还没就绪'); done(null); return; }
      try {
        A.fetchCompletions(
          msgs,
          (chunk: string) => { if (!this._silent) this._status = ''; this._paint(chunk); },
          (full: string | null) => { const out = (full == null ? this._acc : String(full)); done(out); },
          (err: string) => { this._status = ''; toast('请求失败：' + err); done(null); },
          {
            callLabel: label,
            maxTokens: 65535,
            timeout: 600000,
            onReasoning: (c: string) => {
              this._reasonChars += String(c || '').length;
              this._status = '思考中（已想 ' + this._reasonChars + ' 字）';
              this._renderHead();
            },
          }
        );
      } catch (e: any) {
        toast('请求异常：' + String((e && e.message) || e));
        done(null);
      }
    });
  },

  /** 上一轮是不是"只有旁白、没人说话"（用来提示场记：这一轮让角色开口，别一直推进） */
  _lastWasNarration(): boolean {
    try {
      const log = RealState.log();
      const last = log[log.length - 1];
      return !!(last && last.kind === 'scene' && !last.speaker);
    } catch (e) { return false; }
  },

  // ---------- 转述（作者随手写的一句 → 规范的一轮） ----------
  /** 这个角色最近说过的（给他本人看的公开记录，用来稳住语气）——本轮那条要排除（那就是等一下要整理的原话） */
  _recentOwnLines(name: string, skipId?: string): string {
    try {
      return RealState.log().filter(function (r) {
        return r && r.kind !== 'scene' && r.speaker === name && r.id !== skipId;
      }).slice(-ECHO_PREV).map(function (r) {
        return '【他说】' + String(r.raw || '').replace(/<\s*内心\s*>[\s\S]*?<\s*\/\s*内心\s*>/gi, '').replace(/\s+/g, ' ').trim();
      }).filter(function (s) { return s.length > 3; }).join('\n');
    } catch (e) { return ''; }
  },

  /**
   * 把作者随手写的一句整理成规范的一轮（唯一一次"作者不写标记也能分清哪些是心里话"的机会）。
   * **失败/没内容就返回 null**，调用方照原话发出——绝不因为整理失败而卡住这一轮。
   */
  async _echoCall(name: string, text: string): Promise<{ text: string; heard?: string[]; shell?: RealShell; changed: boolean } | null> {    const msgs = buildEchoMessages({
      name: name,
      persona: this._persona(name),
      prev: this._recentOwnLines(name, this._playerRecId),
      scene: this.scene(),
      present: this._presentList(),
      input: text,
    });
    this._status = '正在整理你这句话…';
    this._streamSpeaker = '';
    this._reasonChars = 0;
    this._acc = '';
    this._silent = true;      // 整理过程不上屏（屏幕上留着作者自己的原话）
    this.render();
    const raw = await this._call(msgs, 'real-echo');
    this._silent = false;
    this._acc = '';
    if (raw == null) return null;
    const rep = parseRoleReply(raw, name);       // 顺带认出 <私下>/<壳>（转述自己判悄悄话）
    const out = cleanEcho(rep.text);
    if (!out.trim()) return null;
    return { text: out, heard: rep.heard, shell: rep.shell, changed: out.trim() !== String(text || '').trim() };
  },

  // ---------- 公共调用（场记） ----------
  async _publicCall(text: string): Promise<boolean> {
    const log = RealState.log();
    const msgs = buildPublicMessages({
      scene: this.scene(),
      summary: RealState.summary(),
      common: RealState.common(),
      // 作者刚写的那句已经在记录里了，这里不再重复一遍（它下面是"作者这一次的输入"）
      recent: formatPublicRecent(this._playerRecId ? log.filter((r) => r.id !== this._playerRecId) : log, 40),
      input: text,
      inputKind: this._inputKind,
      roster: this._roster(),
      player: this.player(),
      lastWasNarration: this._lastWasNarration(),
    });
    this._status = '场记整理中…';
    this._streamSpeaker = '';
    this._acc = '';
    this._silent = true;      // 场记的 <场记> 块是内部账本，不往记录区画（只留状态行）
    this.render();
    const raw = await this._call(msgs, 'real-scene');
    this._silent = false;
    this._acc = '';
    if (raw == null) return false;
    const pub = parsePublicReply(raw);
    if (!pub) {
      // 场记这次没按格式回：**别整轮作废**——把它的正文当世界侧旁白收下（剥掉标签与字段行），
      // 剧情照样往前走，用户也能在屏幕上看到它到底写了什么。（太短的（像一句推脱）就直接当失败）
      const salvaged = String(raw || '')
        .replace(/<\/?[^>]{1,14}>/g, '')
        .split('\n')
        .filter(function (l) { return !/^\s*[-*•]?\s*(时间|地点|在场|公共事件|旁白|纪要|接话|可感|壳)\s*[:：]/.test(l); })
        .join('\n')
        .trim();
      if (salvaged.length >= 24) {
        RealState.append({ kind: 'scene', speaker: '', raw: salvaged.slice(0, 800) });
        this._next = '旁白';
        toast('场记这次没按格式回（已把它写的当旁白收下）');
        return true;
      }
      toast('场记没按合同回（这一轮跳过，可以再点一次）');
      return false;
    }
    const patch: any = {};
    if (pub.time) patch.time = pub.time;
    if (pub.place) patch.place = pub.place;
    if (pub.present && pub.present.length) patch.present = pub.present;
    if (Object.keys(patch).length) RealState.setScene(patch);
    if (pub.summary) RealState.setSummary(pub.summary);
    // 共知：模型没写/写「无/同上」都按"没变化"处理（保留旧值——宁可少给，不要让大家的记忆被清空）
    if (pub.common) RealState.setCommon(pub.common);
    const body = [pub.narration, pub.events ? '【公共事件】' + String(pub.events).split('\n').join('\n【公共事件】') : '']
      .filter(Boolean).join('\n').trim();
    if (body) {
      RealState.append({ kind: 'scene', speaker: '', raw: body, present: (RealState.scene().present || []).slice() });
    }
    // 作者那句被判定成悄悄话 → 回填可感（作者本人一定知道）与壳。
    // **只补不覆盖**：转述可能已经判过悄悄话并写好了壳，场记这里缺哪项就只补哪项——
    // 拿 undefined 去 patch 会把 heard 抹成"在场全体都听得到"，那是往泄漏的方向走。
    if (this._playerRecId && (pub.heard || pub.shell)) {
      const cur = RealState.log().find((r) => r.id === this._playerRecId) as RealRecord | undefined;
      const patch: Partial<RealRecord> = {};
      if (pub.heard && pub.heard.length) {
        patch.heard = Array.from(new Set(pub.heard.concat([this.player()]).filter(Boolean)));
      }
      if (pub.shell && !(cur && cur.shell)) patch.shell = pub.shell;
      if (Object.keys(patch).length) RealState.patch(this._playerRecId, patch);
    }
    this._next = String(pub.next || '旁白');
    return true;
  },

  // ---------- 压缩回忆（远期记忆） ----------
  /** 视角窗口（字）：复用记忆页的「正文窗口」；留空/自动时用真实模式的兜底值 */
  _windowChars(): number {
    let v = 0;
    try { v = normalizeStoryWindow(SM().get<any>('storyWindowChars', 0)); } catch (e) { v = 0; }
    return v > 0 ? v : REAL_WINDOW_FALLBACK;
  },

  /**
   * 视角流超过窗口时，把"较早的那部分"折成一段第一人称回忆（≤250 字，不裁字）。
   * 单角色不变量：这一次调用只涉及这一个角色的材料。失败就静默跳过，这一轮照常生成。
   */
  async _compressIfNeeded(name: string): Promise<void> {
    try {
      const win = this._windowChars();
      if (!RealState.shouldCompress(name, win)) return;
      const items = RealState.visibleTo(name);
      // 最近约一半原文留着（人记得住眼前的事），前面的折进回忆
      const keep = Math.floor(win / 2);
      let tail = 0;
      let cut = 0;
      for (let i = items.length - 1; i >= 0; i--) {
        tail += String(items[i].text || '').length;
        if (tail > keep) { cut = i + 1; break; }
      }
      const folded = items.slice(0, cut);
      if (!folded.length) return;
      const old = RealState.memoryOf(name);
      this._status = '整理 ' + name + ' 的记忆…';
      this._renderHead();
      this._silent = true;
      this._acc = '';
      const raw = await this._call(buildMemoryMessages({
        name: name, oldMemory: old ? old.text : '', recent: formatSlice(folded),
      }), 'real-mem');
      this._silent = false;
      this._acc = '';
      const text = cleanMemory(raw || '');
      if (text) RealState.setMemory(name, text, String(folded[folded.length - 1].id || ''));
    } catch (e) {
      this._silent = false;
      /* 压缩失败不影响这一轮生成 */
    }
  },

  // ---------- 角色调用（本轮唯一说话人） ----------
  _roleMessagesFor(name: string): Msg[] {
    const mem = RealState.memoryOf(name);
    const init = RealState.initialMemory(name);
    let shared = '';
    let extra = '';
    try {
      const sp = visibleSplit(RealState.log(), name);
      shared = formatSlice(sp.shared.slice(-MAX_SLICE));
      extra = formatSlice(sp.extra.slice(-12));
    } catch (e) { /* ignore */ }
    const msgs = buildRoleMessages({
      name: name,
      persona: this._persona(name),
      initial: init ? init.text : '',
      memory: mem ? mem.text : '',
      shared: shared,
      extra: extra,
      scene: Object.assign({}, this.scene(), { present: this._presentList() }),
      others: this._others(name),
      common: RealState.common(),
      subset: formatSubset(RealState.subsetKnowledge(name)),
    });
    const sys = this._presetSystem();
    if (sys) msgs[0].content += '\n\n' + sys;
    const tail = this._presetTail();
    if (tail) msgs[1].content += '\n\n' + tail;
    return msgs;
  },

  async _roleCall(name: string): Promise<void> {
    await this._compressIfNeeded(name);   // 超窗口先把较早的部分折成"自己的回忆"（只涉及这一个角色）
    const msgs = this._roleMessagesFor(name);
    this._status = name + ' 正在回应…';
    this._streamSpeaker = name;
    this._reasonChars = 0;
    this._acc = '';
    this.render();
    const raw = await this._call(msgs, 'real-role');
    if (raw == null) return;
    const rep = parseRoleReply(raw, name);
    if (!String(rep.text || '').trim()) {
      toast(name + ' 这一轮什么都没写');
      return;
    }
    RealState.append({ kind: 'npc', speaker: name, raw: rep.text, heard: rep.heard, shell: rep.shell });
  },

  // ---------- 一轮 ----------
  _snap(): void {
    let snap: any = null;
    try { snap = RealState.snapshot() || {}; } catch (e) { snap = {}; }
    snap.playerInput = this._playerInput || '';
    RealState.beginTurn(snap);
  },

  async send(): Promise<void> {
    if (this._sending) return;
    const ta = el('realInput');
    const text = ta ? String(ta.value || '').trim() : '';
    await this._sendText(text);
  },

  /** 一轮的正文（send 读输入框后调它；测试直接用它，不需要 DOM） */
  async _sendText(text: string): Promise<void> {
    if (this._sending) return;
    if (!this.bookId()) { toast('请先选择一本书'); return; }
    this._ensureCast();                       // 第一次发送时把参演名单种上（不能只依赖渲染）
    const ta = el('realInput');
    const sc = this.scene();
    if (!this.cast().length) { toast('这本书的世界书里还没有「角色」条目：先在世界书页加人，或用「＋ 添加角色」加进来'); return; }
    if (!RealState.isGod() && !this.player()) { toast('先在输入框上方选一个角色，或选「上帝模式」'); return; }
    this._sending = true;
    this._reasonChars = 0;
    this._playerRecId = '';
    this._playerCanon = '';
    this._stopped = false;
    this._next = '';
    this._playerInput = text;
    // 上帝模式（输入框上方的下拉）：写的就是客观推进，不替任何人说话
    this._inputKind = !text ? 'empty' : (RealState.isGod() ? 'narration' : 'line');
    this._snap();
    this._scrollOnce = true;
    try { (globalThis as any).UsageStats?.beginSession?.(); } catch (e) { /* ignore */ }
    const logLenBefore = RealState.log().length;
    // 从这里起整段都在 try 里：中途任何意外（含渲染/输入框的 DOM 异常）都必须走 finally，
    // 否则 _sending 会永远卡在 true——整个模式就再也发不出去了（一条记录都发不出去，只能重开页面）。
    try {
    if (text) {
      if (ta) { ta.value = ''; autoGrow(ta); }   // 发出去就把框收回一行（程序改 value 不触发 input）
      if (this._inputKind === 'narration') {
        // 上帝模式的旁白是客观事实、不是"你说的话"：落成旁白记录（居中淡色），不要挂在扮演者身上
        RealState.append({ kind: 'scene', speaker: '', raw: text.replace(/^\s*旁白\s*[:：]\s*/, '') });
      } else {
        // 先按原话落一条（作者能立刻看到自己发了什么），再让转述把它换成规范的一轮。
        // 换来换去都在同一条记录上（patch），所以撤回/回滚的语义不变。
        this._playerRecId = RealState.append({ kind: 'player', speaker: this.player(), raw: text }) || '';
        const echo = await this._echoCall(this.player(), text);
        if (echo) {
          const patch: Partial<RealRecord> = {};
          if (echo.changed) { patch.raw = echo.text; patch.playerRaw = text; }
          if (echo.heard) patch.heard = echo.heard;
          if (echo.shell) patch.shell = echo.shell;
          if (Object.keys(patch).length) RealState.patch(this._playerRecId, patch);
          // 场记看的是"这一轮实际发生了什么"（整理后的一轮），不是作者的原话
          this._playerCanon = echo.text;
        } else {
          // 整理没成（超时/空回/接口报错——报错已在 _call 里提示过）→ 照原话发出，别卡住这一轮
          this._playerCanon = text;
        }
      }
      // 整理这段等待里用户按了「停止」→ 这一轮整体退回（别整理完还接着喊场记），原话回输入框
      if (this._stopped) {
        try {
          const snap0 = RealState.turnSnap();
          if (snap0) { RealState.restore(snap0); RealState.clearTurnSnap(); }
        } catch (e) { /* ignore */ }
        const ta0 = el('realInput');
        if (ta0 && text) { ta0.value = text; autoGrow(ta0); }
        return;
      }
    }
    this.render();
    const ok = await this._publicCall(this._playerCanon || text);
    if (!ok) {
      // 场记失败：把这一轮撤回去、作者那句放回输入框（和对话模式一个待遇），
      // 否则记录里会留一句"没人接"的话，用户再发一次就重复了。
      try {
        const snap = RealState.turnSnap();
        if (snap && text) {
          RealState.restore(snap);
          RealState.clearTurnSnap();
          const ta2 = el('realInput');
          if (ta2) { ta2.value = text; autoGrow(ta2); }
          toast('这一轮没走成，刚才那句已放回输入框');
        }
      } catch (e) { /* ignore */ }
      return;
    }
    if (this._next && this._next !== '旁白') {
      await this._roleCall(this._next);
    }
    } finally {
      this._sending = false;
      this._status = '';
      this._acc = '';
      this._silent = false;
      this._streamSpeaker = '';
      this._playerRecId = '';
      this._playerCanon = '';
      this._reasonChars = 0;
      this.render();
      // 记账：这一轮实际写进记录的正文长度（以前一律传 0，用量统计里看不到产出）
      let words = 0;
      try {
        const log = RealState.log();
        for (let i = logLenBefore; i < log.length; i++) words += String(log[i].raw || '').length;
      } catch (e) { /* ignore */ }
      try { (globalThis as any).UsageStats?.endSession?.(words); } catch (e) { /* ignore */ }
    }
  },

  stop(): void {
    this._stopped = true;      // 整理/生成被中断时，这一轮不再往下走（下一轮发送时会复位）
    try { (globalThis as any).APIHandler?.abort?.(); } catch (e) { /* ignore */ }
    this._status = '已停止';
    this._renderHead();
  },

  undoLast(): void {
    let snap: any = null;
    try { snap = RealState.turnSnap(); } catch (e) { snap = null; }
    if (!snap) {
      if (!RealState.log().length) { toast('没有可撤回的'); return; }
      RealState.popLast(); this.render(); return;
    }
    try { RealState.restore(snap); RealState.clearTurnSnap(); } catch (e) { /* ignore */ }
    const ta = el('realInput');
    if (ta && snap.playerInput) { ta.value = String(snap.playerInput); autoGrow(ta); }
    this._scrollOnce = true;
    this.render();
    this.refreshSendLabel();
  },
};

// 遗留全局：内联 onclick（RealMode.send() / undoLast() …）与 mobile.ts 的切页钩子都按全局调用
const g = globalThis as unknown as { RealMode: typeof RealMode };
g.RealMode = RealMode;
