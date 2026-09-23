// 意见反馈：用户单向给管理员提意见。
//
// 规则（与 server/src/routes/feedback.js 对齐，改动要成对改）：
//   · 单条最多 300 字，**客户端就卡死**（到 300 提示「可再发一条」，不让人白写 500 字再被服务端拒）；
//   · 用户可见的限流只有一条：每分钟最多 2 条（服务端另有 设备/天、IP/小时、全站/小时 三条兜底防刷）；
//   · **只有服务端真的接受（2xx）才弹感谢**——被限流或网络失败时说清楚，输入内容保留可复制；
//   · 不暂存、不静默补发：「以为发出去了其实没发」比明确报错更糟（App 是离线优先，但反馈必须联网）。
// 隐私：随提交带随机安装标识 + 版本 + 平台（用于限流与定位问题）；原始 IP 不入库。
import { SM } from '../infra/gate';
import { defaultServerBase } from '../lib/server-url';
import { ensureInstallId } from './stats';

export const FEEDBACK_MAX_LEN = 300;
const MINE_KEY = 'feedbackMine';
const MINE_KEEP = 3;               // 本机保留最近几条（仅本机可见，用于防重复提交）
const TIMEOUT_MS = 8000;

/** 按码点计长度：emoji 算 1 个（与界面计数器、服务端校验同一口径）。 */
export function cpLen(s: unknown): number { return Array.from(String(s ?? '')).length; }

interface FeedbackResult { ok: boolean; kind: 'ok' | 'rate' | 'invalid' | 'network' | 'server'; message: string }

function _serverBase(): string {
  try {
    const sm = SM() as unknown as { get?: (k: string, d?: string) => string };
    const s = String((sm && sm.get ? sm.get('communityServer', '') : '') || '').trim().replace(/\/+$/, '');
    if (s) return s;
  } catch (e) { /* 未初始化 */ }
  return defaultServerBase();
}

function _appVersion(): string {
  try {
    const u = (globalThis as unknown as { UpdateManager?: { local?: { versionName?: string } } }).UpdateManager;
    return String((u && u.local && u.local.versionName) || '');
  } catch (e) { return ''; }
}

function _platform(): string {
  try {
    return String((window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() || 'unknown');
  } catch (e) { return 'unknown'; }
}

function _esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export const Feedback = {
  MAX_LEN: FEEDBACK_MAX_LEN,
  _sending: false,

  /** 本机最近提交过的（仅本机可见）：防"同一条反复提"，也给用户一点闭环感。 */
  getMine(): Array<{ text: string; at: number }> {
    try {
      const raw = SM().get<unknown>(MINE_KEY, []);
      return Array.isArray(raw) ? (raw as Array<{ text: string; at: number }>).slice(0, MINE_KEEP) : [];
    } catch (e) { return []; }
  },

  _pushMine(text: string): void {
    try {
      const list = [{ text, at: Date.now() }].concat(this.getMine()).slice(0, MINE_KEEP);
      SM().set(MINE_KEY, list);
    } catch (e) { /* 本机留档失败不影响提交结果 */ }
  },

  render(): void {
    this._syncCount();
    this.renderMine();
  },

  _syncCount(): void {
    try {
      const ta = document.getElementById('fbText') as HTMLTextAreaElement | null;
      const out = document.getElementById('fbCount');
      const hint = document.getElementById('fbLimitHint');
      if (!ta) return;
      const n = cpLen(ta.value);
      if (out) out.textContent = n + ' / ' + FEEDBACK_MAX_LEN;
      if (hint) hint.style.display = n >= FEEDBACK_MAX_LEN ? 'block' : 'none';
    } catch (e) { /* ignore */ }
  },

  onInput(): void { this._syncCount(); },

  renderMine(): void {
    const box = document.getElementById('fbMine');
    if (!box) return;
    const mine = this.getMine();
    if (!mine.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:4px;">你最近提过的（只存在这台设备上）</div>'
      + mine.map((m) => '<div class="card" style="padding:8px 10px;">'
        + '<div style="font-size:12px;color:var(--text-muted);">' + new Date(m.at).toLocaleString() + '</div>'
        + '<div style="font-size:13px;white-space:pre-wrap;word-break:break-word;margin-top:2px;">' + _esc(m.text) + '</div>'
        + '</div>').join('');
  },

  _setStatus(msg: string, kind: 'info' | 'ok' | 'warn'): void {
    const el = document.getElementById('fbStatus');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = kind === 'ok' ? 'var(--success, #2e7d32)' : (kind === 'warn' ? 'var(--danger, #c62828)' : 'var(--text-muted)');
  },

  /** 提交：只有服务端 2xx 才感谢；被限流/失败要如实说，且不清空、不感谢。 */
  async submit(): Promise<FeedbackResult> {
    const ta = document.getElementById('fbText') as HTMLTextAreaElement | null;
    if (!ta) return { ok: false, kind: 'invalid', message: '界面未就绪' };
    if (this._sending) return { ok: false, kind: 'invalid', message: '正在提交，请稍候' };
    const text = String(ta.value || '').replace(/\r\n?/g, '\n').trim();
    if (!text) { this._setStatus('先写点内容再提交', 'warn'); return { ok: false, kind: 'invalid', message: '内容不能为空' }; }
    if (cpLen(text) > FEEDBACK_MAX_LEN) {
      this._setStatus('超过 ' + FEEDBACK_MAX_LEN + ' 字了，请删减或分两条发', 'warn');
      return { ok: false, kind: 'invalid', message: 'too long' };
    }
    this._sending = true;
    const btn = document.getElementById('fbSubmit') as HTMLButtonElement | null;
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    const ac = new AbortController();
    const timer = setTimeout(function () { ac.abort(); }, TIMEOUT_MS);
    try {
      const res = await fetch(_serverBase() + '/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: ensureInstallId(), text, v: _appVersion(), plat: _platform() }),
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        ta.value = '';
        this._syncCount();
        this._pushMine(text);
        this.renderMine();
        this._setStatus('已经收到啦，谢谢你的意见！', 'ok');
        try { (globalThis as unknown as { App?: { toast?: (m: string) => void } }).App?.toast?.('谢谢你的反馈！我们会认真看'); } catch (e) { /* ignore */ }
        return { ok: true, kind: 'ok', message: 'ok' };
      }
      // 429 = 限流（文案由服务端给），400 = 内容/标识不合法，其他按服务器错误处理
      let msg = '';
      try { const j = (await res.json()) as { error?: string }; msg = String((j && j.error) || ''); } catch (e) { /* 非 JSON */ }
      if (res.status === 429) {
        this._setStatus(msg || '提得太频繁了，请稍后再试', 'warn');
        return { ok: false, kind: 'rate', message: msg || 'rate limited' };
      }
      if (res.status === 400) {
        this._setStatus(msg || '内容不符合要求', 'warn');
        return { ok: false, kind: 'invalid', message: msg || 'bad request' };
      }
      this._setStatus('服务器暂时没接收成功（HTTP ' + res.status + '），内容还在，可以稍后再试', 'warn');
      return { ok: false, kind: 'server', message: 'http ' + res.status };
    } catch (e) {
      clearTimeout(timer);
      // 网络失败/超时：不感谢、不清空（内容保留，用户可复制留存）
      this._setStatus('没发出去（网络或服务器不可用），内容还在，可以稍后再试或复制留存', 'warn');
      return { ok: false, kind: 'network', message: String((e as Error)?.message || e) };
    } finally {
      this._sending = false;
      if (btn) { btn.disabled = false; btn.textContent = '提交给管理员'; }
    }
  },
};

(globalThis as unknown as { Feedback: typeof Feedback }).Feedback = Feedback;
export default Feedback;
