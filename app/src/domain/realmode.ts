// RealMode：真实模式的视图与两条调用链（批次 2）。
// 一轮 = ① 公共调用（场记：场景/在场/公共事件/旁白/纪要/接话 + 判定作者那句的可感与壳）
//       ② 角色调用（本轮唯一说话人：只看自己可感的材料）
// 单角色不变量：私有材料只出现在同一个角色的那一次请求里（回归守卫见 app/tests/realmode.test.ts）。
// 界面元素由 web/index.html 的 #tab-real 提供（id 固定，见 app/tests/realmode-view.test.ts）。
import { RealState } from './realstate';
import type { RealRecord, RealScene } from './realstate';
import {
  buildPublicMessages, buildRoleMessages, buildMemoryMessages, cleanMemory,
  formatSlice, formatPublicRecent, parsePublicReply, parseRoleReply, extractBlocks,
} from './realprompt';
import type { Msg } from './realprompt';
import { parseBubbles } from '../lib/bubble';
import { WorldBookManager } from './worldbook';
import { normalizeStoryWindow } from '../lib/contextbudget';
import { SM } from '../infra/gate';

/** 视角切片注入给角色的条数上限（更早的折进"自己的回忆"） */
const MAX_SLICE = 60;
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
  _playerRecId: '',
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
    if (this._sending) { btn.disabled = true; btn.textContent = '…'; return; }   // 生成中别让它看起来"点了没反应"
    btn.disabled = false;
    btn.textContent = (ta && String(ta.value || '').trim()) ? '发送' : '▶ 继续';
  },
  _renderHead(): void {
    const sc = this.scene();
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
    this.refreshSendLabel();
  },

  _recordHtml(rec: RealRecord): string {
    const inner = extractBlocks(String(rec.raw || ''), '内心');
    let body = extractBlocks(inner.rest, '壳').rest.replace(/<\s*私下[^>]*>/gi, '');
    const speaker = String(rec.speaker || '');
    const lines = String(body).split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (!lines.length && !inner.blocks.length) return '';
    let out = '';
    if (!speaker) {
      const txt = lines.map(function (l) { return l.replace(/^\s*旁白\s*[:：]\s*/, ''); }).join('\n');
      if (txt.trim()) out += '<div class="chat-narr">' + nl2br(esc(txt)) + '</div>';
      if (inner.blocks.length) out += '<div class="real-inner">' + nl2br(esc(inner.blocks.join('\n'))) + '</div>';
      return out;
    }
    // 不给每行加「说话人：」前缀——一轮只有一个说话人，用 defaultSpeaker 归属即可；
    // 加前缀的话，模型本来写对的行会变成「悠真：早啊…」把前缀也显示进气泡（页面验收踩到过）。
    const prefixed = lines.map(function (l) {
      return /^\s*旁白\s*[:：]/.test(l) ? '白：' + l.replace(/^\s*旁白\s*[:：]\s*/, '') : l;
    }).join('\n');
    let bubbles: any[] = [];
    try { bubbles = parseBubbles(prefixed, { roster: [speaker], defaultSpeaker: speaker } as any) || []; } catch (e) { bubbles = []; }
    if (!bubbles.length && String(body).trim()) {
      bubbles = [{ speaker: speaker, known: true, blocks: [{ type: 'say', text: String(body).trim() }] }];
    }
    const isMe = speaker === this.player();
    const av = this._avatar(speaker);
    let innerPlaced = false;
    bubbles.forEach(function (b: any) {
      const sp = b.speaker === null ? '白' : String(b.speaker || '');
      const blocks = (b.blocks || []).map(function (x: any, i: number) {
        const br = i > 0 && (x.nlBefore || x.para) ? '<br>' : '';
        return br + (x.type === 'say'
          ? '<span class="chat-say">' + nl2br(esc(x.text)) + '</span>'
          : '<span class="chat-act">' + nl2br(esc(x.text)) + '</span>');
      }).join('');
      if (sp === '白' || sp === '旁白' || sp === '') { out += '<div class="chat-narr">' + blocks + '</div>'; return; }
      const innerHtml = (inner.blocks.length && !innerPlaced)
        ? '<div class="real-inner">' + inner.blocks.map(function (x: string) { return nl2br(esc(x)); }).join('<br>') + '</div>'
        : '';
      innerPlaced = true;
      out += '<div class="chat-row' + (isMe ? ' chat-row-me' : '') + '">' + av +
        '<div class="chat-main"><div class="chat-name">' + esc(sp) + '</div>' +
        '<div class="chat-bubble">' + blocks + innerHtml + '</div></div></div>';
    });
    if (inner.blocks.length && !innerPlaced) out += '<div class="real-inner">' + nl2br(esc(inner.blocks.join('\n'))) + '</div>';
    return out;
  },

  _avatar(name: string): string {
    try {
      const C = (globalThis as any).ChatMode;
      const av = (C && typeof C.avatar === 'function') ? C.avatar(name) : null;
      if (av && av.src) return '<img class="chat-av" src="' + esc(av.src) + '" alt="">';
      if (av) return '<div class="chat-av chat-av-txt" style="background:' + esc(av.color || '#8b8b8b') + '">' + esc(av.initial || '') + '</div>';
    } catch (e) { /* ignore */ }
    return '<div class="chat-av chat-av-txt" style="background:#8b8b8b">' + esc(String(name || '?').slice(0, 1)) + '</div>';
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
          (chunk: string) => { this._status = ''; this._paint(chunk); },
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

  // ---------- 公共调用（场记） ----------
  async _publicCall(text: string): Promise<boolean> {
    const log = RealState.log();
    const msgs = buildPublicMessages({
      scene: this.scene(),
      summary: RealState.summary(),
      // 作者刚写的那句已经在记录里了，这里不再重复一遍（它下面是"作者这一次的输入"）
      recent: formatPublicRecent(this._playerRecId ? log.filter((r) => r.id !== this._playerRecId) : log, 40),
      input: text,
      inputKind: this._inputKind,
      roster: this._roster(),
      player: this.player(),
    });
    this._status = '场记整理中…';
    this._streamSpeaker = '';
    this._acc = '';
    this.render();
    const raw = await this._call(msgs, 'real-scene');
    if (raw == null) return false;
    const pub = parsePublicReply(raw);
    if (!pub) { toast('场记没按合同回（这一轮跳过，可以再点一次）'); return false; }
    const patch: any = {};
    if (pub.time) patch.time = pub.time;
    if (pub.place) patch.place = pub.place;
    if (pub.present && pub.present.length) patch.present = pub.present;
    if (Object.keys(patch).length) RealState.setScene(patch);
    if (pub.summary) RealState.setSummary(pub.summary);
    const body = [pub.narration, pub.events].filter(Boolean).join('\n').trim();
    if (body) {
      RealState.append({ kind: 'scene', speaker: '', raw: body, present: (RealState.scene().present || []).slice() });
    }
    // 作者那句被判定成悄悄话 → 回填可感（作者本人一定知道）与壳
    if (this._playerRecId && (pub.heard || pub.shell)) {
      const heard = pub.heard && pub.heard.length
        ? Array.from(new Set(pub.heard.concat([this.player()]).filter(Boolean))) : undefined;
      RealState.patch(this._playerRecId, { heard: heard, shell: pub.shell });
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
    const msgs = buildRoleMessages({
      name: name,
      persona: this._persona(name),
      initial: init ? init.text : '',
      memory: mem ? mem.text : '',
      slice: formatSlice(RealState.visibleTo(name).slice(-MAX_SLICE)),
      scene: Object.assign({}, this.scene(), { present: this._presentList() }),
      others: this._others(name),
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
    this._next = '';
    this._playerInput = text;
    // 上帝模式（输入框上方的下拉）：写的就是客观推进，不替任何人说话
    this._inputKind = !text ? 'empty' : (RealState.isGod() ? 'narration' : 'line');
    this._snap();
    this._scrollOnce = true;
    try { (globalThis as any).UsageStats?.beginSession?.(); } catch (e) { /* ignore */ }
    const logLenBefore = RealState.log().length;
    if (text) {
      if (ta) ta.value = '';
      if (this._inputKind === 'narration') {
        // 上帝模式的旁白是客观事实、不是"你说的话"：落成旁白记录（居中淡色），不要挂在扮演者身上
        RealState.append({ kind: 'scene', speaker: '', raw: text.replace(/^\s*旁白\s*[:：]\s*/, '') });
      } else {
        this._playerRecId = RealState.append({ kind: 'player', speaker: this.player(), raw: text }) || '';
      }
    }
    this.render();
    try {
      const ok = await this._publicCall(text);
      if (!ok) {
        // 场记失败：把这一轮撤回去、作者那句放回输入框（和对话模式一个待遇），
        // 否则记录里会留一句"没人接"的话，用户再发一次就重复了。
        try {
          const snap = RealState.turnSnap();
          if (snap && text) {
            RealState.restore(snap);
            RealState.clearTurnSnap();
            const ta2 = el('realInput');
            if (ta2) ta2.value = text;
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
    if (ta && snap.playerInput) ta.value = String(snap.playerInput);
    this._scrollOnce = true;
    this.render();
    this.refreshSendLabel();
  },
};

// 遗留全局：内联 onclick（RealMode.send() / undoLast() …）与 mobile.ts 的切页钩子都按全局调用
const g = globalThis as unknown as { RealMode: typeof RealMode };
g.RealMode = RealMode;
