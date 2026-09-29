// ClientLog：客户端错误上报（两级降级设计）。
// 第 1 级（永远工作，零网络）：index.html 早捕获把错误写入 localStorage.__errLog（环形 8 条），
//   写入不在本模块——上报失败时条目自然留在本地，信息永不丢。
// 第 2 级（尽力而为）：fire-and-forget 后台 POST——绝不 await、绝不进入任何用户路径；
//   失败静默放弃并进入 10 分钟冷却（服务器不可达时最多每 10 分钟空试一次，不重试不排队）。
// 上报时机（均不为上报单独发起连接）：
//   a) 捎带：update.ts 版本检查成功后调 flush('version')——该请求已证明服务器可达；
//   b) 节流直发：index.html record() → notifyError()，8 秒防抖合并连续错误。
// 隐私红线：只发错误消息摘要与运行环境；密钥形态（sk-/user_/Bearer）一律打码；
//   永不发小说正文/世界书内容。单次 ≤8 条、单条 ≤300 字、每日 ≤20 次、24h 同签名去重。

const CL_LOG_KEY = '__errLog';
const CL_SIG_KEY = '__clSigs';
const CL_DAY_KEY = '__clDay';
const DEDUPE_MS = 24 * 3600 * 1000;
const FAIL_COOLDOWN_MS = 10 * 60 * 1000;
const DAILY_CAP = 20;
const DEBOUNCE_MS = 8000;

import { UpdateManager } from './update'; // 版本信息（错误上报上下文）；update 亦 import 本模块——环仅在调用期访问
import { defaultServerBase } from '../lib/server-url';
import { getWebVersion } from '../lib/webver';
import { isClean } from '../lib/buildflags';

export interface ErrEntry { t: number; k: string; m: string }

function _lsGet<T>(key: string, dflt: T): T {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '');
    return (v === null || v === undefined) ? dflt : v as T;
  } catch (e) { return dflt; }
}
function _lsSet(key: string, v: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 隐私模式等 localStorage 不可用 */ }
}

// 密钥打码（常见形态：sk- 开头 / user_ 开头长 token / Bearer 头）+ 截断
export function sanitize(msg: string): string {
  return String(msg || '')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[KEY]')
    .replace(/user_[A-Za-z0-9_-]{12,}/g, '[KEY]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [KEY]')
    .slice(0, 300);
}

function _sig(e: ErrEntry): string { return e.k + '|' + sanitize(e.m).slice(0, 80); }

// 与 update.ts 同源：用户改过社区服务器地址时，上报也走同一台
function _serverBase(): string {
  try {
    const sm = (globalThis as unknown as { StorageManager?: { get?: (k: string, d?: string) => string } }).StorageManager;
    const s = String((sm && sm.get ? sm.get('communityServer', '') : '') || '').trim().replace(/\/+$/, '');
    if (s) return s;
  } catch (e) { /* 未初始化/测试环境：保持默认 */ }
  return defaultServerBase();
}

function _platform(): string {
  try {
    return String((window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.() || 'web');
  } catch (e) { return 'web'; }
}

function _appVersion(): string {
  try {
    return String((UpdateManager as unknown as { local?: { versionName?: string } }).local?.versionName || '');
  } catch (e) { return ''; }
}

let _failAt = 0;
let _debounce: ReturnType<typeof setTimeout> | null = null;

// 待上报条目：__errLog 里尚未成功上报（24h 同签名去重）的条目
function pending(): ErrEntry[] {
  const sigs = _lsGet<Record<string, number>>(CL_SIG_KEY, {});
  const logs = _lsGet<ErrEntry[]>(CL_LOG_KEY, []);
  const now = Date.now();
  return logs.filter((e) => {
    if (!e || !e.k || !e.m) return false;
    const s = _sig(e);
    return !(sigs[s] && now - sigs[s] < DEDUPE_MS);
  });
}

// 上报（尽力而为）：成功记签名与配额；失败静默进冷却。fire-and-forget，调用方永不 await。
function flush(reason?: string): void {
  try {
    // 干净版：不做任何上报——日志只留在本机（localStorage + 控制台），一条都不出设备
    if (isClean()) return;
    if (_debounce) { clearTimeout(_debounce); _debounce = null; } // 顺带取消防抖任务（本次已合并执行）
    if (Date.now() - _failAt < FAIL_COOLDOWN_MS) return; // 冷却期：服务器刚失联，不再空试
    const items = pending();
    if (items.length === 0) return;
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const cnt = _lsGet<{ day: string; n: number }>(CL_DAY_KEY, { day: '', n: 0 });
    const used = cnt.day === day ? cnt.n : 0;
    if (used >= DAILY_CAP) return;
    const logs = items.slice(0, 8).map((e) => ({
      t: e.t, k: String(e.k).slice(0, 60), m: sanitize(e.m), v: _appVersion(), plat: _platform(),
      w: getWebVersion()   // 同一 APK 可能因热更在跑不同网页包，排查必须能区分（server 端 client_logs.web 列）
    }));
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    if (ac) setTimeout(() => { try { ac.abort(); } catch (e) { /* ignore */ } }, 8000);
    fetch(_serverBase() + '/api/client-logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs: logs }),
      signal: ac ? ac.signal : undefined
    })
      .then((r) => { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(() => {
        const sigs = _lsGet<Record<string, number>>(CL_SIG_KEY, {});
        const now = Date.now();
        items.forEach((e) => { sigs[_sig(e)] = now; });
        const keys = Object.keys(sigs);
        if (keys.length > 64) keys.sort((a, b) => sigs[a] - sigs[b]).slice(0, keys.length - 64).forEach((k) => { delete sigs[k]; });
        _lsSet(CL_SIG_KEY, sigs);
        _lsSet(CL_DAY_KEY, { day: day, n: used + 1 });
        try { console.log('[ClientLog] 上报 ' + logs.length + ' 条（' + (reason || 'timer') + '）'); } catch (e) { /* ignore */ }
      })
      .catch(() => { _failAt = Date.now(); /* 静默降级：第 1 级本地留档仍在 */ });
  } catch (e) { /* 上报通道自身异常绝不外抛 */ }
}

// index.html record() 钩子：新错误 → 防抖合并后节流直发
function notifyError(kind: string, msg: string): void {
  try {
    if (String(kind) === '资源加载失败') return; // CDN/favicon 类噪音不上报（本地留档仍在）
    if (_debounce) return; // 已有待发任务，届时把 __errLog 里的新条目一并带走
    _debounce = setTimeout(() => { _debounce = null; flush('error'); }, DEBOUNCE_MS);
  } catch (e) { /* ignore */ }
}

export const ClientLog = {
  notifyError: notifyError,
  flush: flush,
  pending: pending,
  sanitize: sanitize,
  note: note
};

// 主动记录一条诊断，走与未捕获错误相同的上报通道（用于「失败但静默」的链路，如记忆数据库填表：
// 它的失败只写 console.warn，手机上看不到，历史上完全无痕，出问题只能靠猜）。
// 约束：① 只记状态与计数——调用方不得传正文/密钥（sanitize 再兜一层）；② 环形缓冲只有 8 条，
// 同签名已在缓冲里就不重复入队（否则会把真正的错误挤出缓冲）。
export function note(title: string, msg: string): void {
  try {
    const entry: ErrEntry = { t: Date.now(), k: String(title || '诊断'), m: sanitize(msg) };
    const logs = _lsGet<ErrEntry[]>(CL_LOG_KEY, []);
    const s = _sig(entry);
    if (logs.some(function (e) { return _sig(e) === s; })) return;
    logs.push(entry);
    _lsSet(CL_LOG_KEY, logs.slice(-8));
    notifyError(entry.k, entry.m);
    // 再主动冲一次：诊断往往是"用户马上要关掉页面去看结果"的场景，只依赖 8 秒防抖会丢
    // （App 一关，待发条目就留在本地环形缓冲里，等到下次有错误才可能被带走）。冷却期内会被跳过，不会打服务器。
    flush('note');
  } catch (e) { /* 诊断通道自身异常绝不上抛 */ }
}
export default ClientLog;
// 挂载已移至 src/boot/compat.ts（单 bundle 改造 P3-A）：index.html 早捕获经 window.ClientLog 访问，
// update.ts 经 ES import 使用；clientlog.js 产物停发
