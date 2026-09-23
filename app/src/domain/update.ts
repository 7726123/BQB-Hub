// UpdateManager：App 整包自动更新（从 www/modules/update.js 深度类型化）。
// 流程：内置 version.json ↔ 服务器 /api/app/version → 发现新版本弹窗 →
// 内部 StorageManager 访问经 SM() gate（lib.dom 同名类型冲突，见 infra/gate.ts）。
// 原生插件下载 APK（带进度）→ 拉起系统安装器；仅 Android 原生环境执行。
export interface AppVersionInfo {
  versionCode: number;
  versionName: string;
  note?: string;
  apkUrl?: string;
}
export interface DownloadProgress { received?: number; total?: number }

// 可测纯逻辑：远端版本是否应提示更新（远端 versionCode 严格大于本地才提示）
export function shouldUpdate(remoteCode: number, localCode: number): boolean {
  return remoteCode > localCode;
}

/**
 * 网页包已就绪 → 问一句是否立即生效（就地换资源目录并重载，免去"退出 App 再打开"）。
 * 之所以要问：重载会丢弃未保存的输入；选取消则维持原设计，下次冷启动生效。
 * 没有确认框可用时不打扰（下次启动照样生效）。
 */
export function offerHotApply(version?: string, confirmFn?: (msg: string, cb: () => void) => void, applyFn?: () => void): void {
  const UI = (globalThis as unknown as { UIManager?: { showConfirm?: (msg: string, cb: () => void) => void } }).UIManager;
  const ask = confirmFn || (UI && UI.showConfirm);
  if (!ask) return;
  const msg = '新版本' + (version ? ' ' + version : '') + ' 已就绪。\n现在重启界面立即生效？'
    + '\n（未保存的输入会丢失，建议先确认已保存；选「取消」则下次打开 App 时生效）';
  const run = applyFn || function () { HotBundle.applyPendingNow(); };
  try { ask(msg, run); } catch (e) { /* 弹窗不可用：不打扰，等下次启动 */ }
}

// Capacitor 原生插件的最小类型声明（UpdateChecker）
interface UpdateCheckerPlugin {
  canRequestInstall?: () => Promise<{ granted: boolean }>;
  openInstallSettings?: () => Promise<void>;
  addListener?: (event: string, cb: (e: DownloadProgress) => void) => void;
  download?: (opts: { url: string }) => Promise<void>;
}
interface CapacitorLike {
  getPlatform?: () => string;
  Plugins?: { UpdateChecker?: UpdateCheckerPlugin };
}

import { SM } from '../infra/gate';
import { AdminMode } from './adminmode';
import { ClientLog } from './clientlog';
import { HotBundle } from './hotbundle';
import { UsagePing } from './stats';
import { defaultServerBase } from '../lib/server-url';

export const UpdateManager: {
  server: string;
  local: AppVersionInfo | null;
  remote: AppVersionInfo | null;
  downloading: boolean;
  _pendingPermission: boolean;
  _permTimer: ReturnType<typeof setInterval> | null;
  _animWidth: number;
  _animTarget: number;
  _animRaf: number | null;
  _lastProg: { t: number; received: number } | null;
  _speedText: string;
  _lastEventAt: number;
  _indetTimer: ReturnType<typeof setInterval> | null;
  _lastManualAt: number;
  init(): void;
  check(manual?: boolean): void;
  _showDialog(): void;
  _setPercent(pct: number): void;
  _trackSpeed(received: number): void;
  _ensureIndeterminate(): void;
  close(): void;
  startUpdate(): void;
  _watchPermission(): void;
  _doDownload(): void;
} = {
  // 默认地址在 init() 里解析（模块顶层执行时 Capacitor/UA 可能尚未就绪，
  // 会误判系统能力；init 由 DOMContentLoaded 之后调用，此时平台信息可靠）
  server: '',
  local: null,       // 内置版本
  remote: null,      // 服务器版本
  downloading: false,
  _pendingPermission: false, _permTimer: null,
  _animWidth: 0, _animTarget: 0, _animRaf: null,
  _lastProg: null, _speedText: '', _lastEventAt: 0, _indetTimer: null, _lastManualAt: 0,

  init(): void {
    const self = this;
    // 默认地址：按系统版本选协议（Android 7+ 走内置自签 CA 信任的 HTTPS 端口）。
    // 放在平台检查之前，保证非 Android 环境下 server 也有可用默认值。
    self.server = defaultServerBase();
    // 仅 Android 原生环境检查
    try {
      if (!(window as unknown as { Capacitor?: CapacitorLike }).Capacitor
        || ((window as unknown as { Capacitor?: CapacitorLike }).Capacitor as CapacitorLike).getPlatform?.() !== 'android') return;
    } catch (e) { return; }
    // 网页包热更新：读状态 + 确认启动 + 有回退时告知。放在版本检查之前——它决定"当前跑的是哪个网页包"，
    // 后续版本显示与错误上报都要用（失败静默，绝不阻塞启动）。
    try { HotBundle.init(); } catch (e) { /* 忽略 */ }
    // 与社区同源：用户改过社区服务器地址时，更新也走同一台
    try {
      if (typeof StorageManager !== 'undefined') {
        const s = String(SM().get<string>('communityServer', '') || '').trim().replace(/\/+$/, '');
        if (s) self.server = s;
      }
    } catch (e) { /* 保持默认地址 */ }
    // 读取内置版本号
    fetch('version.json?_=' + Date.now())
      .then(function (r) { if (!r.ok) throw new Error('no version'); return r.json(); })
      .then(function (v: AppVersionInfo) { self.local = v || null; })
      .catch(function () { self.local = null; })
      .then(function () {
        if (!self.local || !self.local.versionCode) return;
        // 匿名使用统计：启动上报一次 + 起前台心跳（管理员在「社区 → 管理」看人数）。
        // 放在拿到本机版本号之后（上报里要带版本号），失败静默、绝不影响启动。
        try { UsagePing.init(self.local.versionName || ''); } catch (e) { /* 忽略 */ }
        self.check(); // 打开 App 立即检查更新并弹窗
      })
      .catch(function () { /* 启动时版本检查链路异常忽略 */ });
  },

  check(manual?: boolean): void {
    const self = this;
    if (self.downloading) return;
    // 管理员模式入口：连点 10 下「检查更新」（间隔 > 2.5s 重新计数）。
    // 未开启 → 弹口令框（服务器校验）；已开启 → 退出。命中时不再走更新检查。
    if (manual) {
      try {
        const act = AdminMode.tap();
        if (act === 'enter') { UIManager.showAdminAuth(); return; }
        if (act === 'exit') { AdminMode.requestExit(); return; }
      } catch (e) { /* 连击计数异常不影响更新检查 */ }
    }
    if (manual) {
      // 连点「检查更新」是管理员模式入口（要连点 10 下，见 AdminMode）——若不拦，一次进模式会
      // 触发 9 次检查、弹出 9 条提示（w2 那次就是这么冒出一串"安装失败"的）。10 秒内只认真查一次。
      const now = Date.now();
      if (now - (self._lastManualAt || 0) < 10000) return;
      self._lastManualAt = now;
    }
    const cap = (window as unknown as { Capacitor?: CapacitorLike }).Capacitor;
    if (!self.local || !cap || !cap.Plugins || !cap.Plugins.UpdateChecker) {
      if (manual) App.toast('请在 Android 应用内检查更新');
      return;
    }
    if (manual) App.toast('正在检查更新…');
    fetch(self.server + '/api/app/version?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j: AppVersionInfo) {
        // 服务器可达性已被本次版本请求证明：捎带上报本地攒的错误日志（fire-and-forget 旁路）
        try { if (typeof ClientLog !== 'undefined') ClientLog.flush('version'); } catch (e) { /* 旁路失败忽略 */ }
        if (!j || !j.versionCode) { if (manual) App.toast('服务器未配置更新'); return; }
        if (!shouldUpdate(j.versionCode, self.local!.versionCode)) {
          // 没有新 APK 时顺带看一眼网页包（热更新，无需安装）。
          // 提示分工：装了/已就绪/失败由 HotBundle 自己提示；"没有更新的包"这里统一提示，避免弹两条。
          try {
            HotBundle.check(manual, function (r) {
              if (!manual) return;
              // 刚装好、或之前装好还没重启 → 问一句要不要立即生效（原地换目录 + 重载）
              if (r && (r.installed || r.ready)) { offerHotApply(r.version); return; }
              if (r && r.reason) return;   // 失败提示已由 HotBundle 弹出
              App.toast('已是最新版本 v' + (self.local!.versionName || ''));
            });
          } catch (e) { /* 热更新门面异常不影响整包更新流程 */ }
          return;
        }
        self.remote = j;
        self._showDialog();
      })
      .catch(function () { if (manual) App.toast('检查失败：网络错误'); });
  },

  _showDialog(): void {
    const j = this.remote!;
    document.getElementById('updVersion')!.textContent = 'v' + (j.versionName || '') + '（' + j.versionCode + '）';
    document.getElementById('updNote')!.textContent = j.note || '发现新版本，建议立即更新';
    document.getElementById('updBtn')!.style.display = '';
    document.getElementById('updDownloading')!.style.display = 'none';
    this._setPercent(-1);
    UIManager.showModal?.('modalAppUpdate');
  },

  // 进度条：目标值 + requestAnimationFrame 平滑推进（回调再密也顺滑，
  // 回调稀疏/中断时动画仍连续）；右下角小字同时显示百分比与下载速度。
  _setPercent(pct: number): void {
    const bar = document.getElementById('updBar');
    if (!bar) return;
    if (pct < 0) {
      this._animTarget = 0; this._animWidth = 0;
      this._speedText = '';
      if (this._animRaf != null) { cancelAnimationFrame(this._animRaf); this._animRaf = null; }
      bar.style.width = '0%';
      const p = document.getElementById('updPct'); if (p) p.textContent = '';
      return;
    }
    this._animTarget = Math.min(100, pct);
    if (this._animRaf == null) {
      const step = () => {
        const diff = this._animTarget - this._animWidth;
        if (Math.abs(diff) < 0.2) this._animWidth = this._animTarget;
        else this._animWidth += diff * 0.22; // 缓动趋近
        bar.style.width = this._animWidth + '%';
        const p = document.getElementById('updPct');
        if (p) p.textContent = Math.round(this._animWidth) + '%' + (this._speedText ? ' · ' + this._speedText : '');
        if (Math.abs(diff) >= 0.2) this._animRaf = requestAnimationFrame(step);
        else this._animRaf = null;
      };
      this._animRaf = requestAnimationFrame(step);
    }
  },

  // 事件缺席兜底：原生进度事件可能因线程/桥接原因缺失（已知盲区）——
  // 下载一旦开始，若 6 秒内无任何进度事件，进度条转未定态动画（indeterminate），
  // 保证始终有可视反馈；事件恢复后立即切回百分比。
  _ensureIndeterminate(): void {
    if (!this.downloading || this._indetTimer) return;
    this._lastEventAt = Date.now();
    this._indetTimer = setInterval(() => {
      if (!this.downloading) { if (this._indetTimer) { clearInterval(this._indetTimer); this._indetTimer = null; } return; }
      if (Date.now() - this._lastEventAt > 6000) {
        const bar = document.getElementById('updBar');
        if (bar) bar.classList.add('indet');
        const p = document.getElementById('updPct');
        if (p && !p.textContent) p.textContent = '下载中…';
      } else {
        const bar = document.getElementById('updBar');
        if (bar) bar.classList.remove('indet');
      }
    }, 1000);
  },

  // 下载速度：相邻两次进度事件的字节增量 / 时间差 → MB/s（KB/s 兜底）
  _trackSpeed(received: number): void {
    const now = Date.now();
    if (!this._lastProg) { this._lastProg = { t: now, received }; return; }
    const dt = now - this._lastProg.t;
    const db = received - this._lastProg.received;
    this._lastProg = { t: now, received };
    if (dt <= 0 || db <= 0) return;
    const bps = db / dt * 1000;
    this._speedText = bps >= 1024 * 1024 ? (bps / 1024 / 1024).toFixed(1) + ' MB/s'
      : (bps / 1024).toFixed(0) + ' KB/s';
  },

  close(): void { UIManager.closeModal?.('modalAppUpdate'); },

  startUpdate(): void {
    const self = this;
    const j = this.remote;
    if (!j || !j.apkUrl) { App.toast('更新地址缺失'); return; }
    const checker = ((window as unknown as { Capacitor?: CapacitorLike }).Capacitor as CapacitorLike).Plugins!.UpdateChecker!;
    // 8.0+ 需要"安装未知来源"权限：未授权先引导去系统设置
    if (checker.canRequestInstall) {
      checker.canRequestInstall()
        .then(function (r) {
          if (r && r.granted) self._doDownload();
          else {
            // 不关闭弹窗：用户授权回来后自动继续下载
            self._pendingPermission = true;
            self._watchPermission();
            App.toast('请在系统设置中允许安装，返回后自动继续');
            const btn = document.getElementById('updBtn'); if (btn) btn.textContent = '等待授权...';
            if (checker.openInstallSettings) {
              checker.openInstallSettings().catch(function () { /* 忽略 */ });
            }
          }
        })
        .catch(function () { self._doDownload(); });
      return;
    }
    self._doDownload();
  },

  // 授权监视：从系统设置回到 App 后，检测到已授权则自动开始下载。
  // 用轻量轮询（700ms）而非事件监听，兼容所有机型的生命周期差异。
  _watchPermission(): void {
    const self = this;
    if (self._permTimer) return;
    self._permTimer = setInterval(function () {
      if (!self._pendingPermission) { if (self._permTimer) clearInterval(self._permTimer); self._permTimer = null; return; }
      // 用户主动关了弹窗 → 放弃等待
      const overlay = document.getElementById('modalAppUpdate');
      if (!overlay || !overlay.classList.contains('show')) {
        self._pendingPermission = false;
        if (self._permTimer) clearInterval(self._permTimer); self._permTimer = null;
        return;
      }
      if (document.hidden) return; // 还在系统设置页
      try {
        const checker = ((window as unknown as { Capacitor?: CapacitorLike }).Capacitor as CapacitorLike).Plugins!.UpdateChecker!;
        checker.canRequestInstall!().then(function (r) {
          if (self._pendingPermission && r && r.granted && !document.hidden) {
            self._pendingPermission = false;
            if (self._permTimer) clearInterval(self._permTimer); self._permTimer = null;
            const btn = document.getElementById('updBtn');
            if (btn) btn.textContent = '立即更新';
            self._doDownload();
          }
        }).catch(function () { /* 忽略 */ });
      } catch (e) { /* 忽略 */ }
    }, 700);
  },

  _doDownload(): void {
    const self = this;
    const j = this.remote!;
    self.downloading = true;
    self._lastProg = null; self._speedText = '';
    self._ensureIndeterminate();
    document.getElementById('updBtn')!.style.display = 'none';
    document.getElementById('updDownloading')!.style.display = '';
    self._setPercent(0);
    const checker = ((window as unknown as { Capacitor?: CapacitorLike }).Capacitor as CapacitorLike).Plugins!.UpdateChecker!;
    // 监听原生下载进度。注意：Capacitor 的 addListener 是异步注册——必须等 listener
    // 就绪后再启动 download，否则进度事件会因竞态丢失（进度条全程 0%）。
    const onProg = function (e: DownloadProgress) {
      self._lastEventAt = Date.now();
      const bar = document.getElementById('updBar'); if (bar) bar.classList.remove('indet');
      if (e && e.total && e.total > 0) {
        self._trackSpeed(e.received || 0);
        self._setPercent((e.received || 0) * 100 / e.total);
      }
    };
    const onOk = function () {
      self.downloading = false;
      if (self._indetTimer) { clearInterval(self._indetTimer); self._indetTimer = null; }
      self._lastProg = null;
      self._setPercent(100);
      UIManager.closeModal?.('modalAppUpdate');
      App.toast('更新包已就绪，请在弹出的安装界面确认');
    };
    const onFail = function (err: unknown) {
      self.downloading = false;
      if (self._indetTimer) { clearInterval(self._indetTimer); self._indetTimer = null; }
      self._lastProg = null;
      self._speedText = '';
      const btn = document.getElementById('updBtn'); if (btn) btn.style.display = '';
      const dl = document.getElementById('updDownloading'); if (dl) dl.style.display = 'none';
      self._setPercent(-1);
      App.toast('下载失败：' + ((err && (err as Error).message) || '网络错误'));
    };
    const startDl = function () {
      checker.download!({ url: j.apkUrl! }).then(onOk, onFail);
    };
    try {
      if (checker.addListener) {
        const lp = checker.addListener('downloadProgress', onProg) as unknown;
        if (lp && typeof lp === 'object' && typeof (lp as Promise<void>).then === 'function') {
          (lp as Promise<void>).then(startDl, startDl); // listener 就绪后开始下载（失败也照常下载）
        } else {
          startDl();
        }
      } else {
        startDl();
      }
    } catch (e2) { startDl(); }
  }
};

// 挂载已移至 src/boot/compat.ts 白名单（P3-B）：index.html「检查更新」按钮字符串 onclick 引用；
// 消费方（app/clientlog）ES import；update.js 产物停发
export default UpdateManager;