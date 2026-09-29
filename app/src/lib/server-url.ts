// 社区/更新服务地址解析：按系统版本选择协议（多端共用的唯一入口）。
//
// 背景：服务器同时监听 HTTP 与 HTTPS 两个端口。HTTPS 用自签证书，
// App 通过 network_security_config.xml 内置同一张 CA 作为信任锚——
// 但该配置只在 Android 7.0（API 24）及以上生效。Android 5.x/6.x 不认这张
// 证书，强制走 HTTPS 会直接连不上，因此按系统版本分流：
//   Android 7.0+ → HTTPS 端口（加密）
//   更早 / 非 Android → HTTP 端口（明文，保持原行为）
//
// 端口取值由后端 config 的 TLS_PORT / PORT 决定（部署侧文档不入库），
// 端口只影响连接，不影响 TLS 本身。
//
// 为什么用 UA 里的 Android 版本号判断：Capacitor 未暴露 API level，而 WebView 的
// UA `(Linux; Android X; ...)` 是唯一同步可得的信息。Chrome 的 UA 缩减（Chrome 110+）
// 会把版本号下调到固定值 "Android 10"，但**缩减只发生在 Chrome 113+ 这类较新内核上**，
// 而 Android 5/6 设备的 WebView 最高只到 Chrome 106（之后不再支持），拿不到缩减后的
// 字符串——因此 ">= 7" 这个边界在两端都判断正确，不会把老设备误判成新设备。
//
// 判断不出来时一律回落到 HTTP：明文是「当前线上行为」，不改动 = 不引入新故障；
// 误判成 HTTPS 则会让老设备社区功能直接不可用。
//
// 用户手动改过 communityServer（StorageManager）时以用户配置为准（见各处调用方）。

// 干净版（离线版）：这里**直接引用构建期开关**而不是 isClean()——esbuild 的 --define 会把条件折叠成常量，
// 于是"服务器地址"这个字符串根本不会出现在干净版产物里（不是"不调用"，是"没有"）。
// 各调用方即便漏了 isClean() 守卫，拿到的也是空串：defaultServerBase() 返回 '' → 相对路径，
// 打不到任何服务器（纵深防御，见 tests/clean-mode.test.ts）。
declare const __BQB_CLEAN__: boolean;
const CLEAN_BUILD = typeof __BQB_CLEAN__ !== 'undefined' && __BQB_CLEAN__ === true;

const HOST = CLEAN_BUILD ? '' : '43.155.128.242';
const HTTP_PORT = 8899;
const HTTPS_PORT = 80;

/** 当前系统是否信任 App 内置的自签 CA（即 network_security_config 是否生效）。 */
export function supportsCustomCa(): boolean {
  try {
    const cap = (globalThis as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    if (!cap || cap.getPlatform?.() !== 'android') return false;
    const ua = String((globalThis as unknown as { navigator?: { userAgent?: string } }).navigator?.userAgent || '');
    const m = /Android\s+(\d+)/i.exec(ua);
    if (!m) return false;
    return parseInt(m[1], 10) >= 7;
  } catch (e) { return false; }
}

/** 默认服务基址（无尾斜杠）。判断不出系统能力时返回明文地址（保持原行为）。
 *  干净版没有服务器，返回空串（调用方一律按"没有服务器"处理）。 */
export function defaultServerBase(): string {
  if (!HOST) return '';
  return supportsCustomCa()
    ? 'https://' + HOST + ':' + HTTPS_PORT
    : 'http://' + HOST + ':' + HTTP_PORT;
}

export { HOST as SERVER_HOST, HTTP_PORT as SERVER_HTTP_PORT, HTTPS_PORT as SERVER_HTTPS_PORT };