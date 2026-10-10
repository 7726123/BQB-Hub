// 系统版（内部构建）运行期判定。
//
// 依据是**安装包本身**（Android flavor `system`：applicationId 带 .system 后缀、资源里预置机器凭据），
// 由原生 HotBundle 插件的 getState() 在启动时上报；热更包改不了它——所以同一份签名网页包
// 在正式版里这些分支恒为 false（行为零变化），在系统版里恒为 true。
//
// 为什么不用构建期开关（像 __BQB_CLEAN__ 那样）：系统版要收热更包，热更包是全设备同一份产物，
// 构建期写死的标志会被下一次热更顶掉。
//
// 系统版的作用：① 管理员能力常开（无手势、无口令框，见 domain/adminmode.ts）；
//              ② 内测渠道（/api/app/web-bundle?channel=beta，服务端按机器凭据放行）。
export type Edition = 'normal' | 'system';

let _edition: Edition = 'normal';
let _systemKey = '';
const _listeners: Array<() => void> = [];

/** 当前是否系统版（原生上报到达前一律 false = 正式版行为） */
export function isSystemEdition(): boolean { return _edition === 'system'; }

/** 系统版机器凭据（正式版恒为空串）。只放内存：不落 localStorage、不进日志/上报。 */
export function systemKey(): string { return _systemKey; }

/** 系统版鉴权头（正式版返回空对象，可直接展开进 fetch headers）。 */
export function systemKeyHeaders(): Record<string, string> {
  return _edition === 'system' && _systemKey ? { 'X-System-Key': _systemKey } : {};
}

/** 订阅版本变化（原生上报到达 / 测试切开关时触发），供 UI 刷新用。 */
export function onEditionChange(fn: () => void): void { _listeners.push(fn); }

/** 原生状态到达时调用（见 domain/hotbundle.ts 的 init）。返回是否发生变化。 */
export function applyEditionFromNative(o: { edition?: unknown; systemKey?: unknown } | null | undefined): boolean {
  const ed: Edition = o && String(o.edition || '') === 'system' ? 'system' : 'normal';
  const key = ed === 'system' ? String((o && o.systemKey) || '') : '';
  const changed = ed !== _edition || key !== _systemKey;
  _edition = ed;
  _systemKey = key;
  if (changed) {
    for (const fn of _listeners) { try { fn(); } catch (e) { /* UI 刷新失败不影响自身 */ } }
  }
  return changed;
}

/** 仅测试用：直接切换版本（不必造原生插件），与 __setCleanForTest 同风格。 */
export function __setEditionForTest(ed: Edition, key?: string): void {
  applyEditionFromNative({ edition: ed, systemKey: key || '' });
}
