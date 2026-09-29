// 管理员模式（客户端管理能力开关）。
//
// 入口：连续点击「检查更新」10 下（间隔 > TAP_GAP_MS 视为重新计数）
//   · 未开启时 → 弹口令框，口令由**服务器后端**校验（本地不存任何口令/明文）
//   · 已开启时 → 同一手势退出
//
// 作用：拿到服务器签发的管理员令牌（12h）后，① 侧边栏出现与「社区」同级的「管理」页签
//   （内含使用统计与审核队列，见 domain/community.ts 与 index.html 的 #tab-admin），
//   ② 每轮生成内容留档上报（sendTrace）。
//
// 正文窗口不受本模式影响：与普通用户完全一致，只由设置里的「正文窗口」决定
// （lib/contextbudget.ts）。旧版会把窗口压到 1 万字，随窗口设置可调而下线。
import { SM } from '../infra/gate';
import { defaultServerBase } from '../lib/server-url';
import { isClean } from '../lib/buildflags';

export const ADMIN_TAPS = 10;
export const ADMIN_TAP_GAP_MS = 2500;
const BADGE_ID = 'adminModeBadge';

interface AdminAppLike {
  toast?: (m: string) => void;
  loadEditorContent?: () => void;
  renderAll?: () => void;
}
interface AdminUILike {
  showConfirm?: (msg: string, cb: () => void) => void;
  closeModal?: (id: string) => void;
}

export const AdminMode = {
  KEY: 'adminMode',
  TOKEN_KEY: 'adminTraceToken',   // 留档上报令牌（/api/admin/verify 签发，12h；只存令牌，不存口令）
  _taps: 0,
  _lastTap: 0,

  isOn(): boolean {
    if (isClean()) return false;   // 干净版：没有管理端（口令由服务器校验，本版本不联服务器）
    try { return SM().get<boolean>(this.KEY, false) === true; } catch (e) { return false; }
  },
  set(on: boolean): void {
    try { SM().set(this.KEY, !!on); } catch (e) { /* 忽略 */ }
    this.syncBadge();
    // 让侧边栏「管理」入口立刻出现/消失（别等社区页重新渲染）
    try {
      const CC = (globalThis as unknown as { CommunityChat?: { syncAdminEntry?: () => void } }).CommunityChat;
      if (CC && CC.syncAdminEntry) CC.syncAdminEntry();
    } catch (e) { /* 忽略 */ }
  },

  /** 记一次「检查更新」点击。返回 'enter'（该弹口令框）/ 'exit'（该退出）/ null（继续正常检查更新） */
  tap(now?: number): 'enter' | 'exit' | null {
    if (isClean()) return null;   // 干净版：连点也不会进入管理员模式
    const t = typeof now === 'number' ? now : Date.now();
    if (t - this._lastTap > ADMIN_TAP_GAP_MS) this._taps = 0;   // 间隔过久 → 重新计数
    this._lastTap = t;
    this._taps++;
    if (this._taps < ADMIN_TAPS) return null;
    this._taps = 0;
    return this.isOn() ? 'exit' : 'enter';
  },

  /** 留档令牌（未开启/过期则为空串） */
  traceToken(): string {
    try {
      const t = SM().get<{ token: string; exp: number } | null>(this.TOKEN_KEY, null);
      if (!t || !t.token || !t.exp) return '';
      if (Date.now() > Number(t.exp)) { SM().remove(this.TOKEN_KEY); return ''; }
      return String(t.token);
    } catch (e) { return ''; }
  },
  _saveToken(token: string, exp: number): void {
    try {
      if (token) SM().set(this.TOKEN_KEY, { token: token, exp: Number(exp) || (Date.now() + 12 * 3600 * 1000) });
      else SM().remove(this.TOKEN_KEY);
    } catch (e) { /* 忽略 */ }
  },

  /** 上报一轮留档（指令 / 续写 / 记忆召回内容）。仅管理员模式 + 有令牌时发送；失败静默。 */
  sendTrace(payload: Record<string, unknown>): void {
    try {
      if (isClean()) return;   // 干净版：不留档上报
      if (!this.isOn()) return;
      const token = this.traceToken();
      if (!token) { console.log('[AdminTrace] 无有效令牌（重启后需重新连点 10 下进一次管理员模式）'); return; }
      fetch(defaultServerBase() + '/api/admin/trace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(payload),
      }).then(function (r) {
        if (r.status === 401) { AdminMode._saveToken('', 0); console.warn('[AdminTrace] 令牌失效，已清除'); }
        else if (!r.ok) console.warn('[AdminTrace] 上报失败 HTTP ' + r.status);
        else console.log('[AdminTrace] 已留档：第 ' + (payload.round || '?') + ' 轮');
      }).catch(function (e) { console.warn('[AdminTrace] 上报异常：' + String((e as Error).message || e).slice(0, 80)); });
    } catch (e) { /* 上报失败不影响写作 */ }
  },

  /** 向服务器校验口令（明文只经本次请求体，不落任何存储） */
  async verify(password: string): Promise<{ ok: boolean; error?: string }> {
    const pw = String(password || '');
    if (!pw) return { ok: false, error: '请输入口令' };
    const base = defaultServerBase();
    try {
      const r = await fetch(base + '/api/admin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      });
      const j = await r.json().catch(function () { return {}; });
      if (r.ok && j && j.ok) {
        if (j.token) this._saveToken(String(j.token), Number(j.exp) || 0);   // 供本轮测试的留档上报
        return { ok: true };
      }
      return { ok: false, error: (j && j.error) || ('校验失败（HTTP ' + r.status + '）') };
    } catch (e) {
      return { ok: false, error: '无法连接服务器：' + String((e as Error).message || e).slice(0, 80) };
    }
  },

  /** 口令校验通过后开启管理员模式 */
  async enableWithPassword(password: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.verify(password);
    if (!r.ok) return r;
    this.set(true);
    const UI = (globalThis as unknown as { UIManager?: AdminUILike }).UIManager;
    if (UI && UI.closeModal) UI.closeModal('modalAdminAuth');
    const App = (globalThis as unknown as { App?: AdminAppLike }).App;
    if (App && App.toast) App.toast('管理员模式已开启：侧边栏「管理」入口已可用（令牌 12 小时有效）；再连点 10 下「检查更新」退出');
    return { ok: true };
  },

  /** 退出：只关掉管理能力（正文、水位线与归档区都不动——它们由窗口设置决定） */
  exit(): void {
    this.set(false);
    const App = (globalThis as unknown as { App?: AdminAppLike }).App;
    if (App && App.toast) App.toast('已退出管理员模式：侧边栏「管理」入口已隐藏（写作与记忆设置不受影响）');
  },

  /** 退出前确认（由 update.ts 的连击触发） */
  requestExit(): void {
    const UI = (globalThis as unknown as { UIManager?: AdminUILike }).UIManager;
    const self = this;
    if (UI && UI.showConfirm) {
      UI.showConfirm('退出管理员模式？\n退出后侧边栏「管理」入口（使用统计与审核队列）会隐藏；正文、水位线与归档区不受影响。', function () { self.exit(); });
    } else {
      this.exit();
    }
  },

  /** 顶部角标：管理员模式开启时常驻提示（纯 DOM 注入，不改 HTML/CSS 文件） */
  syncBadge(): void {
    try {
      const doc = (globalThis as unknown as { document?: Document }).document;
      if (!doc || !doc.body) return;
      let el = doc.getElementById(BADGE_ID);
      if (!this.isOn()) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        return;
      }
      if (!el) {
        el = doc.createElement('div');
        el.id = BADGE_ID;
        el.setAttribute('style', 'position:fixed;left:0;right:0;top:0;z-index:9999;text-align:center;'
          + 'font-size:12px;line-height:20px;background:#8a5a00;color:#fff;opacity:.92;pointer-events:none;'
          + 'font-family:-apple-system,"Microsoft YaHei",sans-serif');
        doc.body.appendChild(el);
      }
      el.textContent = '管理员模式：侧边栏「管理」已开启 · 连点 10 下「检查更新」退出';
    } catch (e) { /* 忽略 */ }
  },
};

export default AdminMode;
