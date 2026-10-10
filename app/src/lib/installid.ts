// 本机安装标识（匿名使用统计 / 意见反馈 / 系统版设备白名单共用）。
//
// 隐私红线（与 clientlog / stats 同级，改动前先读）：
//   · 标识是本地随机生成的 32 位十六进制串，清应用数据即重置；不跨 App、不跨站点，不是硬件设备号；
//   · 只用于「同一台设备去重 / 限流 / 白名单」，不含任何设备信息。
// 独立成叶子模块（不 import 任何业务模块）：stats / 反馈 / 管理凭据都要用它，
// 放在 stats 里会让 hotbundle → stats → clientlog → update → hotbundle 出现环。
const ID_KEY = 'usageInstallId';

function _ls(key: string): string {
  try { return String(localStorage.getItem(key) || ''); } catch (e) { return ''; }
}
function _lsSet(key: string, v: string): void {
  try {
    if (v) localStorage.setItem(key, v); else localStorage.removeItem(key);
  } catch (e) { /* 隐私模式等 */ }
}

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
