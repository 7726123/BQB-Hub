// 管理员模式（系统版专用；正式版没有这个能力）。
//
// 判定依据是**安装包**：「系统版」APK（Android flavor `system`，资源里预置机器凭据）会被原生在
// 运行期判成 system edition（见 lib/edition.ts，值来自 HotBundle.getState() 的 edition 字段）。
// 正式版/干净版里 isOn() 恒为 false——没有连点手势、没有本地开关，改 localStorage 也不起作用
// （2026-10 起：正式版彻底移除管理员模式，连手势代码都不再存在于公共网页包里）。
//
// 作用：① 侧边栏「管理」页签（使用统计、审核队列、意见反馈）；
//       ② 每轮生成内容留档上报（sendTrace）；
//       ③ 真实模式（入口、世界书「初始记忆 / 部分人知道」条目类型、预设「仅真实」）。
//
// 服务端鉴权：管理请求默认带系统版机器凭据 X-System-Key（+ X-Install-Id 白名单），
// 无口令、无过期；兜底：长按顶部角标可用口令换 12h 留档令牌（X-Admin-Token），
// 用于凭据轮换后旧 APK 应急（见 renewToken）——正常情况下永远用不到。
import { SM } from '../infra/gate';
import { defaultServerBase } from '../lib/server-url';
import { isClean } from '../lib/buildflags';
import { isSystemEdition, systemKey, onEditionChange } from '../lib/edition';
import { ensureInstallId } from '../lib/installid';

const BADGE_ID = 'adminModeBadge';
/** 角标长按多久触发「口令换令牌」兜底入口（防误触） */
const BADGE_LONGPRESS_MS = 700;

interface AdminAppLike {
  toast?: (m: string) => void;
}
interface AdminUILike {
  closeModal?: (id: string) => void;
  showAdminAuth?: () => void;
}

export const AdminMode = {
  TOKEN_KEY: 'adminTraceToken',   // 兜底令牌（口令换的，12h；只存令牌，不存口令）

  /** 系统版 = 管理员模式常开；正式版/干净版恒关（没有任何开关能打开） */
  isOn(): boolean {
    if (isClean()) return false;   // 干净版：没有管理端（口令由服务器校验，本版本不联服务器）
    return isSystemEdition();
  },

  /**
   * 管理请求头：系统版机器凭据（X-System-Key + X-Install-Id 白名单）；
   * 手工换过兜底令牌时再叠 X-Admin-Token（服务端两套凭据任一生效）。
   * 正式版返回空对象（没有管理请求会走到这里）。
   */
  adminRequestHeaders(): Record<string, string> {
    const h: Record<string, string> = {};
    try {
      const tk = this.traceToken();
      if (tk) h['X-Admin-Token'] = tk;
    } catch (e) { /* 忽略 */ }
    if (isSystemEdition()) {
      const key = systemKey();
      if (key) {
        h['X-System-Key'] = key;
        try { h['X-Install-Id'] = ensureInstallId(); } catch (e) { /* 拿不到标识就不带（服务端白名单会拒绝，如实反映） */ }
      }
    }
    return h;
  },

  /** 兜底令牌（未换过/过期则为空串） */
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

  /** 上报一轮留档（指令 / 续写 / 记忆召回内容）。仅系统版 + 有凭据时发送；失败静默。 */
  sendTrace(payload: Record<string, unknown>): void {
    try {
      if (isClean()) return;   // 干净版：不留档上报
      if (!this.isOn()) return;
      const headers = Object.assign({ 'Content-Type': 'application/json' }, this.adminRequestHeaders());
      fetch(defaultServerBase() + '/api/admin/trace', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(payload),
      }).then(function (r) {
        if (r.status === 401) { AdminMode._saveToken('', 0); console.warn('[AdminTrace] 凭据无效且无有效令牌，已清除令牌'); }
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
        if (j.token) this._saveToken(String(j.token), Number(j.exp) || 0);
        return { ok: true };
      }
      return { ok: false, error: (j && j.error) || ('校验失败（HTTP ' + r.status + '）') };
    } catch (e) {
      return { ok: false, error: '无法连接服务器：' + String((e as Error).message || e).slice(0, 80) };
    }
  },

  /** 兜底入口（长按角标触发）：口令换 12h 令牌。正常路径靠机器凭据，不需要它。 */
  async renewToken(password: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.verify(password);
    if (!r.ok) return r;
    const UI = (globalThis as unknown as { UIManager?: AdminUILike }).UIManager;
    if (UI && UI.closeModal) UI.closeModal('modalAdminAuth');
    const App = (globalThis as unknown as { App?: AdminAppLike }).App;
    if (App && App.toast) App.toast('令牌已更新（12 小时有效）；系统版机器凭据不受影响');
    return { ok: true };
  },

  /** 界面联动刷新（系统版判定到达/变化时调用）：角标、「管理」入口、真实模式入口 */
  refresh(): void {
    this.syncBadge();
    // 让侧边栏「管理」入口立刻出现/消失（别等社区页重新渲染）
    try {
      const CC = (globalThis as unknown as { CommunityChat?: { syncAdminEntry?: () => void } }).CommunityChat;
      if (CC && CC.syncAdminEntry) CC.syncAdminEntry();
    } catch (e) { /* 忽略 */ }
    // 真实模式（入口 + 世界书条目类型 + 预设「仅真实」）也跟着这个开关立刻显隐
    try {
      const RM = (globalThis as unknown as { RealMode?: { syncEntry?: () => void } }).RealMode;
      if (RM && RM.syncEntry) RM.syncEntry();
    } catch (e) { /* 忽略 */ }
  },

  /** 顶部角标：系统版常驻提示（可长按 → 口令换令牌兜底入口） */
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
        // 注意 pointer-events 是 auto（与旧版不同）：角标是长按兜底入口的落点。
        // 只在系统版出现，最多吃顶部 20px 的点击，换来"令牌更新"有一个不显眼的入口。
        el.setAttribute('style', 'position:fixed;left:0;right:0;top:0;z-index:9999;text-align:center;'
          + 'font-size:12px;line-height:20px;background:#8a5a00;color:#fff;opacity:.92;'
          + 'font-family:-apple-system,"Microsoft YaHei",sans-serif');
        this._bindBadgeLongPress(el);
        doc.body.appendChild(el);
      }
      el.textContent = '系统版 · 内测通道 BETA · 长按可更新令牌';
    } catch (e) { /* 忽略 */ }
  },

  /** 角标长按 → 打开口令框（兜底换令牌；正常路径用不到，凭据轮换后旧 APK 应急） */
  _bindBadgeLongPress(el: HTMLElement): void {
    const self = this;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const clear = function (): void { if (timer) { clearTimeout(timer); timer = null; } };
    const arm = function (): void {
      clear();
      timer = setTimeout(function () { timer = null; self._openAuthFallback(); }, BADGE_LONGPRESS_MS);
    };
    el.addEventListener('touchstart', arm, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(function (ev) { el.addEventListener(ev, clear, { passive: true }); });
    // 桌面浏览器调试环境没有 touch 事件，用鼠标长按近似
    el.addEventListener('mousedown', arm);
    ['mouseup', 'mouseleave'].forEach(function (ev) { el.addEventListener(ev, clear); });
  },
  _openAuthFallback(): void {
    try {
      const UI = (globalThis as unknown as { UIManager?: AdminUILike }).UIManager;
      if (UI && UI.showAdminAuth) UI.showAdminAuth();
    } catch (e) { /* 没有弹窗可用：不影响任何流程 */ }
  },
};

// 系统版判定到达（原生 getState 返回）或测试切换时，联动刷新界面。
onEditionChange(function () {
  try { AdminMode.refresh(); } catch (e) { /* UI 未就绪时静默 */ }
});

export default AdminMode;
