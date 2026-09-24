// HotBundle：网页包热更新（Android 原生插件 HotBundle 的前端门面）。
//
// 分工（重要）：验签、下载、解包、逐文件哈希、原子替换、启动健康门与自动回退**全部在原生侧**
// （HotBundlePlugin.java / HotBundleCore.java）——那是安全边界，必须放在网络攻击者改不动的地方。
// 本模块只做四件事：
//   ① 启动时读状态：新包确认（confirm，能被调用到就说明新包的 JS 起来了）、回退事件提示；
//   ② 记录"当前运行的网页包版本"给版本显示与错误上报（lib/webver.ts，叶子模块无环）；
//   ③ 检查更新：取回（已签名）manifest 后连同服务器地址交给原生，本模块不解析、不信任其中任何字段；
//   ④ 所有失败一律静默 + ClientLog.note（排查靠日志不靠猜），仅手动检查时弹提示。
//
// 生效时机：安装成功后**启动画面还盖着就当场换页面**（用户打开即新版）；错过启动窗口只写 pref，
// 下次冷启动生效——绝不在用户写作中途重载（就地切换由 applyPending 负责，页面会重载）。
import { ClientLog } from './clientlog';
import { BootSplash } from './bootsplash';
import { defaultServerBase } from '../lib/server-url';
import { getWebVersion, setWebVersion } from '../lib/webver';

export interface HotBundleState {
  active: string;      // 正在运行的热包版本（'' = 内置资源）
  pending: string;     // 已安装待确认的版本
  code: number;        // 运行中热包的序号
  blocked: string;     // 曾启动失败、不再自动安装的版本
  nativeCode: number;  // 本机 APK versionCode
  rolledBack?: string; // 上次启动失败被回退的版本（原生读一次即清）
  serving?: string;    // 实际加载的目录（'public' = 内置资源；排查用）
  isAsset?: boolean;   // 是否正跑内置资源
}
export interface HotBundleManifest { payload?: string; sig?: string; v?: string }
export interface HotBundleInstallResult { ok?: boolean; version?: string; code?: number; seeded?: number }
/** 一次检查的结论：installed=装了新包；ready=装好了等重启；reason=失败原因；都无 = 没有更新的包。 */
export interface HotBundleResult { installed?: boolean; ready?: boolean; version?: string; reason?: string }

interface HotBundlePlugin {
  getState?: () => Promise<HotBundleState>;
  confirm?: (o: { version: string }) => Promise<{ ok: boolean }>;  install?: (o: { serverBase: string; payload: string; sig: string }) => Promise<HotBundleInstallResult>;
  // 原生就地生效（APK 158 起）：目录由原生算（跑内置资源时也能切），切换后原生还会 arm 回退看门狗。
  // 老 APK 没有这个方法 → 退回 Capacitor 的 WebView.setServerBasePath（只在已跑热包时可用）。
  applyPending?: () => Promise<{ ok?: boolean; version?: string }>;
  clearBlocked?: () => Promise<{ ok: boolean }>;
}
interface CapacitorLike {
  getPlatform?: () => string;
  Plugins?: { HotBundle?: HotBundlePlugin };
}

function _plugin(): HotBundlePlugin | null {
  try {
    const cap = (window as unknown as { Capacitor?: CapacitorLike }).Capacitor;
    if (!cap || cap.getPlatform?.() !== 'android') return null;
    const p = cap.Plugins && cap.Plugins.HotBundle;
    return (p && p.install) ? p : null;
  } catch (e) { return null; }
}

function _toast(msg: string): void {
  try { App.toast(msg); } catch (e) { /* 测试/非 App 环境 */ }
}

// 用户改过社区服务器地址时与社区同源（与 update.ts / clientlog.ts 同一套解析规则）
function _serverBase(): string {
  try {
    const sm = (globalThis as unknown as { StorageManager?: { get?: (k: string, d?: string) => string } }).StorageManager;
    const s = String((sm && sm.get ? sm.get('communityServer', '') : '') || '').trim().replace(/\/+$/, '');
    if (s) return s;
  } catch (e) { /* 未初始化 */ }
  return defaultServerBase();
}

/** 手动检查的结果文案（纯函数，便于测试）。 */
export function manualResultText(r: { installed?: boolean; version?: string; reason?: string }): string {
  if (r.installed) return '新版本 ' + (r.version || '') + ' 已就绪，下次启动自动生效';
  return r.reason || '已是最新版本';
}

/** 启动期间的安装等待预算：超时就不再等（原生那边继续装，装好后下次启动生效）——启动画面绝不能变成"卡住"。 */
const BOOT_INSTALL_BUDGET_MS = 8000;

/** 就地切换（老路径，Capacitor 内置的 WebView 插件）：只在当前已经跑着热包时可用。返回是否发出了切换。 */
function _applyViaWebView(st: HotBundleState): boolean {
  const serving = String(st.serving || '');
  const i = serving.lastIndexOf('/');
  if (i <= 0 || serving.indexOf('/hot/') < 0) {
    _toast('新版本已就绪，下次打开 App 时生效');
    return false;
  }
  const dir = serving.slice(0, i + 1) + st.pending;
  try {
    const cap = (window as unknown as { Capacitor?: { Plugins?: { WebView?: { setServerBasePath?: (o: { path: string }) => Promise<void> } } } }).Capacitor;
    const wv = cap && cap.Plugins && cap.Plugins.WebView;
    if (!wv || !wv.setServerBasePath) { _toast('新版本已就绪，下次打开 App 时生效'); return false; }
    ClientLog.note('热更新', '切换到网页包 ' + st.pending + '（就地生效）');
    Promise.resolve(wv.setServerBasePath({ path: dir })).catch(function () { /* 失败则等下次启动 */ });
    return true;
  } catch (e) {
    return false;
  }
}

/** 原生就地生效（优先，APK 158 起）：目录由原生算（内置资源也能切）、切完 arm 回退看门狗。null = 该 APK 没有这个方法。 */
function _nativeApply(p: HotBundlePlugin, st: HotBundleState): Promise<boolean> | null {
  if (typeof p.applyPending !== 'function') return null;
  try {
    ClientLog.note('热更新', '切换到网页包 ' + st.pending + '（原生就地生效）');
    return Promise.resolve(p.applyPending()).then(function (r) {
      return !(r && r.ok === false);
    }, function (e) {
      ClientLog.note('热更新', '原生就地生效失败：' + String((e && (e as Error).message) || e));
      return false;
    });
  } catch (e) {
    return null;
  }
}

export const HotBundle = {
  _lastResult: null as null | HotBundleResult,
  /** 启动期间的安装等待预算（毫秒）。测试改小它来跑超时分支。 */
  _bootBudgetMs: BOOT_INSTALL_BUDGET_MS,

  /** 启动时调用一次（早于版本检查）。失败静默，绝不阻塞启动。 */
  init(): void {
    const p = _plugin();
    if (!p || !p.getState) return;
    try {
      Promise.resolve(p.getState()).then(function (st) {
        if (!st) return;
        HotBundle._state = st;
        if (st.rolledBack) {
          setWebVersion('');
          ClientLog.note('热更新', '网页包 ' + st.rolledBack + ' 启动未确认，已回退到内置版本');
          _toast('新版本未能正常启动，已自动回退到当前版本');
        }
        if (st.pending) {
          // 能执行到这里 = 新包的 JS 已经跑起来了 → 确认（原生据此取消回退看门狗）。
          // 但版本号只在原生确认成功后才算数：原生会核对"实际加载的目录"，若 Capacitor 没采纳
          // serverBasePath（页面其实来自内置资源），confirm 会返回 ok:false —— 此时绝不能把
          // pending 记成本机版本，否则会出现"显示热包版本、实际跑内置资源"的假状态。
          try {
            Promise.resolve(p.confirm!({ version: st.pending })).then(function (r) {
              setWebVersion(r && r.ok ? st.pending : (st.active || ''));
            }, function () { setWebVersion(st.active || ''); });
          } catch (e) { setWebVersion(st.active || ''); }
        } else {
          setWebVersion(st.active || '');
        }
      }).catch(function () { /* 状态读取失败：按内置资源处理 */ });
    } catch (e) { /* 忽略 */ }
  },

  /** 当前运行的网页包版本（'' = 内置资源）。 */
  version(): string {
    return getWebVersion();
  },

  /**
   * 检查并安装新网页包。**本模块只负责"装了/已就绪/失败"的提示**；"没有更新的包"这一情形留静默，
   * 由调用方（update.ts 的「检查更新」流程）统一提示，避免同一次手动检查弹两条 toast。
   * done 回调保证恰好被调用一次（含无插件/异常等提前返回路径），便于调用方编排提示。
   *
   * 为什么要先查本地状态再调原生：原生 install() 把「不比当前版本新」当成拒收（因为它要防降级），
   * 但**已经装好、只等重启生效**是正常状态，不该报成"安装失败"。这里先比一次版本号把它挡在前面，
   * 顺便也省掉一次无谓的下载。版本号取自服务端 manifest 里未签名的 v 字段——只用于"跳不跳"这个
   * 判断，装不装仍由原生按签名后的 payload 决定，攻击者即便伪造 v 也只会让我们少装一次。
   */
  check(manual?: boolean, done?: (r: HotBundleResult) => void): void {
    const finish = function (r: HotBundleResult): void {
      HotBundle._lastResult = r;
      if (manual && r.installed) _toast(manualResultText(r));
      else if (manual && r.ready) _toast('新版本 ' + (r.version || '') + ' 已就绪，重启 App 后生效');
      else if (manual && r.reason) _toast(r.reason);
      if (done) { try { done(r); } catch (e) { /* 调用方异常不影响自身 */ } }
    };
    const p = _plugin();
    if (!p || !p.install) {
      if (manual && !done) _toast('请在 Android 应用内检查更新');
      finish({ installed: false });
      return;
    }
    const server = _serverBase();
    // 启动画面还盖着（冷启动的自动检查）→ 这次检查 + 下载 + 切换的等待全由它盖住，
    // 装完当场换页面：用户看到的是"启动画面 → 新版界面"，不用退出再打开。
    const boot = !manual && BootSplash.available();
    // 先读本地状态：待生效的那一版就是服务端现在给的这一版 → 直接告知，别去撞原生
    const st = HotBundle._state || { active: '', pending: '', code: 0, blocked: '', nativeCode: 0 };
    fetch(server + '/api/app/web-bundle?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json() as Promise<HotBundleManifest>; })
      .then(function (j) {
        if (!j || !j.payload || !j.sig) { finish({ installed: false }); return; }
        const v = String(j.v || '');
        if (v && v === st.pending) {
          finish({ installed: false, ready: true, version: v });   // 装好了、等重启
          return;
        }
        if (v && v === st.active) {
          finish({ installed: false });                            // 正在跑的就是最新
          return;
        }
        let gaveUp = false;
        if (boot) {
          BootSplash.text('正在同步最新版本…');
          BootSplash.busy(true);
          // 「稍后」= 不等了，直接进 App；包在原生那边继续装，装好下次打开生效
          BootSplash.onSkip(function () { gaveUp = true; });
        }
        // 安装本身（含"装好了记账"）与预算解耦：超时/稍后只是不再等，原生装完照样下次生效
        const instP = Promise.resolve(p.install!({ serverBase: server, payload: j.payload, sig: j.sig }))
          .then(function (res) {
            const got = (res && res.version) || v;
            ClientLog.note('热更新', '网页包 ' + got + ' 已就绪' + (boot ? '（启动期间就地生效）' : '，下次启动生效'));
            if (st) { st.pending = got; }
            return { ok: true, version: got, msg: '' };
          }, function (err) {
            const msg = String((err && (err as Error).message) || err || '未知错误');
            ClientLog.note('热更新', '安装失败：' + msg);
            return { ok: false, version: v, msg: msg };
          });
        const timeoutP = new Promise<string>(function (resolve) {
          setTimeout(function () { resolve('timeout'); }, HotBundle._bootBudgetMs);
        });
        return Promise.race([instP, timeoutP]).then(function (out: any) {
          if (out === 'timeout') {
            ClientLog.note('热更新', '安装超过 ' + Math.round(HotBundle._bootBudgetMs / 1000) + ' 秒，不再等（后台继续，下次启动生效）');
            finish({ installed: false, version: v });
            return;
          }
          if (!out.ok) { finish({ installed: false, version: v, reason: '更新失败：' + out.msg }); return; }
          if (boot && !gaveUp) {
            BootSplash.text('正在准备新版本…');
            return HotBundle.applyPending().then(function (switched) {
              if (switched) { return; }   // 页面马上重载：不收启动画面、不回调——新包自己的启动画面接上
              finish({ installed: true, version: out.version });
            });
          }
          finish({ installed: true, version: out.version });
        });
      })
      .catch(function (e) {
        // 静默留痕（服务器不可达 / 接口未上线都很正常，不该打扰用户）
        ClientLog.note('热更新', '检查失败：' + String((e && (e as Error).message) || e));
        finish({ installed: false, reason: manual ? '检查更新失败：网络错误' : '' });
      });
  },

  /**
   * 立即生效（Promise 版）：把资源目录切到已装好的那一版并重载页面。
   * 原生方法优先（目录由原生算，跑内置资源时也能切，切完原生 arm 回退看门狗）；
   * 旧 APK 没有这个方法 → 退回 Capacitor 内置 WebView 插件的 setServerBasePath（见 _applyViaWebView）。
   * 返回 true = 已经发出切换（页面随后重载）。
   *
   * 为什么 JS 能做：换目录后会 reload——同 origin，localStorage 与所有本地数据不受影响。
   * 安全性：这条路径不比冷启动弱——重启后新包的 JS 仍要过 confirm，看门狗也照常生效；
   * 若新包起不来，25 秒后自动回退并拉黑该版本。
   */
  applyPending(): Promise<boolean> {
    const st = HotBundle._state;
    const p = _plugin();
    if (!p || !st || !st.pending) return Promise.resolve(false);
    const nat = _nativeApply(p, st);
    if (nat) return nat.then(function (ok) { return ok ? true : _applyViaWebView(st); });
    return Promise.resolve(_applyViaWebView(st));
  },

  /**
   * 立即生效（同步版，手动检查的确认框用）：返回值只表示"是否发出了切换"。
   * 原生优先；原生失败时退回 WebView 路径。
   */
  applyPendingNow(): boolean {
    const st = HotBundle._state;
    const p = _plugin();
    if (!p || !st || !st.pending) return false;
    const nat = _nativeApply(p, st);
    if (nat) {
      void nat.then(function (ok) { if (!ok) { _applyViaWebView(st); } });
      return true;
    }
    return _applyViaWebView(st);
  },

  /** 本地已知状态（init 时读一次；check 后同步 pending） */
  _state: null as HotBundleState | null,

  /** 手动重试曾被回退拦下的版本（排查/自救用）。 */
  clearBlocked(): void {
    const p = _plugin();
    if (!p || !p.clearBlocked) return;
    try { Promise.resolve(p.clearBlocked()).catch(function () { /* 忽略 */ }); } catch (e) { /* 忽略 */ }
  }
};

export default HotBundle;
