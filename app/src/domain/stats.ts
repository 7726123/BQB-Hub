// 匿名使用统计（设备维度计数）：管理员在「社区 → 管理」里看到在线/今日/近 7 天/近 30 天人数。
//
// 隐私红线（与 clientlog 同级，改动前先读）：
//   · 只上报四样东西——随机安装标识、APK 版本、网页包版本、平台。**不含任何内容、设备信息、位置**；
//   · 标识是本地随机生成的 32 位十六进制串，清应用数据即重置；不跨 App、不跨站点，不是硬件设备号；
//   · 原始 IP 不入库（服务器只在内存限流里用一下）。
// 上报时机：启动一次 + 前台每 3 分钟一次（服务端 5 分钟内算「正在使用」）。
//   切后台时定时器会被系统冻结，心跳自然停止——这正好符合"正在使用"的语义，不会把挂后台的算成在线。
// 离线不丢：发不出去就留一个待上报标记，之后任何一次心跳成功即补上（与 ClientLog 的捎带策略同思路）。
// 全链路失败静默：统计永远不能影响写作，任何异常都不上抛（只有服务器明确报错才留一条诊断）。
import { SM } from '../infra/gate';
import { defaultServerBase } from '../lib/server-url';
import { getWebVersion } from '../lib/webver';
import { ClientLog } from './clientlog';
import { isClean } from '../lib/buildflags';

const ID_KEY = 'usageInstallId';
const PENDING_KEY = 'usagePendingPing';
/** 前台心跳间隔（服务端按最后心跳 5 分钟内算在线，留出一次丢包余量） */
export const HEARTBEAT_MS = 3 * 60 * 1000;

/** 取（必要时生成）本机安装标识：匿名统计与「反馈」共用同一个随机 id（限流按设备维度需要它）。
 *  清应用数据即重置；不跨 App、不跨站点，不是硬件设备号。 */
export function ensureInstallId(): string {
  try {
    let id = _ls(ID_KEY);
    if (!validInstallId(id)) {
      id = newInstallId();
      _lsSet(ID_KEY, id);
    }
    return id;
  } catch (e) { return newInstallId(); }
}
const REPORT_TIMEOUT_MS = 8000;

/** 生成安装标识：32 位十六进制。crypto 不可用时退化为 Math.random（标识只需唯一，不需密码学强度）。 */
export function newInstallId(cryptoLike?: { getRandomValues?: (a: Uint8Array) => Uint8Array }): string {
  const bytes = new Uint8Array(16);
  const c = cryptoLike || (globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c && c.getRandomValues) {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 0x100).toString(16).slice(1);
  return out;
}

/** 服务端与客户端共同遵守的标识格式（服务器用它挡垃圾数据，本地也自检一遍）。 */
export function validInstallId(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,64}$/.test(String(id || ''));
}

// 与 update.ts / clientlog.ts 同一套服务器解析规则（用户改过社区地址时同源）
function _serverBase(): string {
  try {
    const sm = (globalThis as unknown as { StorageManager?: { get?: (k: string, d?: string) => string } }).StorageManager;
    const s = String((sm && sm.get ? sm.get('communityServer', '') : '') || '').trim().replace(/\/+$/, '');
    if (s) return s;
  } catch (e) { /* 未初始化 */ }
  return defaultServerBase();
}

function _platform(): string {
  try {
    return String((window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() || 'unknown');
  } catch (e) { return 'unknown'; }
}

function _ls(key: string): string {
  try { return String(localStorage.getItem(key) || ''); } catch (e) { return ''; }
}
function _lsSet(key: string, v: string): void {
  try {
    if (v) localStorage.setItem(key, v); else localStorage.removeItem(key);
  } catch (e) { /* 隐私模式等 */ }
}

export const UsagePing = {
  _started: false,
  _timer: null as ReturnType<typeof setInterval> | null,
  _appVersion: '',
  _bound: false,

  /** 安装标识（首次调用时生成并落盘，之后稳定不变） */
  id(): string {
    let id = _ls(ID_KEY);
    if (!validInstallId(id)) {
      id = newInstallId();
      _lsSet(ID_KEY, id);
    }
    return id;
  },

  /** 待上报标记（离线启动时置位，下次心跳成功即清除并补报） */
  pending(): boolean { return _ls(PENDING_KEY) === '1'; },

  /** 启动时调用一次：立刻上报 + 起前台心跳。重复调用无副作用。 */
  init(appVersion?: string): void {
    if (isClean()) return;   // 干净版：没有匿名使用统计（不上报、不起心跳）
    if (typeof appVersion === 'string' && appVersion) this._appVersion = appVersion;
    if (this._started) return;   // 幂等：热更新后重新 init 也不重复起定时器
    this._started = true;
    this.ping('start');
    try {
      this._timer = setInterval(function () { UsagePing.ping('beat'); }, HEARTBEAT_MS);
    } catch (e) { /* 定时器不可用：只剩启动上报 */ }
    if (!this._bound) {
      this._bound = true;
      try {
        // 回到前台立刻补一次（后台期间定时器被冻，回来要尽快恢复"在线"状态）
        document.addEventListener('visibilitychange', function () {
          if (!document.hidden) UsagePing.ping('visible');
        });
        // 网络恢复：离线启动的设备在这里补上
        window.addEventListener('online', function () { UsagePing.ping('online'); });
      } catch (e) { /* 事件不可用 */ }
    }
  },

  /** 上报一次（fire-and-forget，永不抛错）。 */
  ping(reason?: string): void {
    try {
      const id = this.id();
      if (!validInstallId(id)) return;
      const body = JSON.stringify({
        id: id,
        v: String(this._appVersion || ''),
        w: getWebVersion(),          // 空 = 跑 APK 内置资源（服务端如实记录，回退后不会谎报旧热包）
        plat: _platform(),
      });
      // 明确离线时不发（浏览器/系统会立刻拒绝，白跑一趟）；留标记等 online 事件或下次心跳
      const nav = (globalThis as unknown as { navigator?: { onLine?: boolean } }).navigator;
      if (nav && nav.onLine === false) { _lsSet(PENDING_KEY, '1'); return; }

      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      if (ac) setTimeout(function () { try { ac.abort(); } catch (e) { /* ignore */ } }, REPORT_TIMEOUT_MS);
      fetch(_serverBase() + '/api/app/ping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        signal: ac ? ac.signal : undefined,
      }).then(function (r) {
        if (r.ok) { _lsSet(PENDING_KEY, ''); return; }   // 成功：清掉待上报标记
        // 服务器明确拒绝（400/401/429 等）：本地数据格式或服务端有问题，留一条诊断便于自查
        ClientLog.note('使用统计', '上报被拒 HTTP ' + r.status + '（' + (reason || 'beat') + '）');
      }).catch(function () {
        // 网络异常（离线/超时/服务器不可达）：静默留标记，等下次心跳或网络恢复补报
        _lsSet(PENDING_KEY, '1');
      });
    } catch (e) { /* 统计失败绝不影响写作 */ }
  },
};

export default UsagePing;
