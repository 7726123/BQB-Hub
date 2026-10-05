// 把图片存到手机本地 / 分享出去。
//
// 为什么要走原生：App 里导 TXT/备份用的 `HttpBridge.saveFile` 是把内容按 **UTF-8 文本**写盘
// （Java 侧 `content.getBytes("UTF-8")`），拿它存 PNG 只会存出一个坏文本文件。2026-10-06 给
// HttpBridge 加了 `saveFileBase64` / `shareFileBase64`（先 base64 解码再写字节）：
//   · saveFileBase64 → 图片进系统相册（MediaStore.Images，Android 10+ 免权限）
//   · shareFileBase64 → 直接弹分享面板（微信/QQ/…）
// 老 APK 没有这两个方法 → 调用方按"不可用"处理（看图页的按钮直接不显示）。

export interface DataUrlParts { mime: string; base64: string }

/** 拆 data URL。不是 data URL 或格式不对 → null（老头像可能是外链）。 */
export function splitDataUrl(dataUrl: unknown): DataUrlParts | null {
  const s = String(dataUrl || '');
  const m = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(s);
  if (!m) return null;
  const b64 = m[2].replace(/\s/g, '');
  if (!b64) return null;
  return { mime: m[1].toLowerCase(), base64: b64 };
}

/** 交给系统的文件名：BQB_20261006_153012.png（按 mime 给扩展名；不认识就当 png）。 */
export function imageFileName(mime: string, d?: Date): string {
  const t = d || new Date();
  const p = (n: number) => (n < 10 ? '0' + n : String(n));
  const stamp = '' + t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '_' + p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
  const m = String(mime || '').toLowerCase();
  const ext = m.indexOf('jpeg') >= 0 || m.indexOf('jpg') >= 0 ? 'jpg' : (m.indexOf('webp') >= 0 ? 'webp' : 'png');
  return 'BQB_' + stamp + '.' + ext;
}

export interface NativeSaveResult { ok: boolean; path?: string; error?: string }

/** 原生桥是否支持存图片（老 APK 没有 → false，调用方隐藏入口）。 */
export function canSaveImage(bridge: any): boolean {
  return !!(bridge && typeof bridge.saveFileBase64 === 'function');
}
export function canShareImage(bridge: any): boolean {
  return !!(bridge && typeof bridge.shareFileBase64 === 'function');
}

/** 存到相册。bridge = window.HttpBridge（或测试桩）。任何失败都返回 {ok:false,error}，不抛。 */
export function saveImageToDevice(dataUrl: unknown, bridge: any): NativeSaveResult {
  const parts = splitDataUrl(dataUrl);
  if (!parts) return { ok: false, error: '这不是一张可保存的本地图片' };
  if (!canSaveImage(bridge)) return { ok: false, error: '当前 App 版本不支持保存图片（需要更新到新版）' };
  try {
    const r = JSON.parse(String(bridge.saveFileBase64(imageFileName(parts.mime), parts.base64, parts.mime)));
    if (r && r.ok) return { ok: true, path: String(r.path || '') };
    return { ok: false, error: String((r && r.error) || '保存失败') };
  } catch (e) {
    return { ok: false, error: String((e && (e as Error).message) || e) };
  }
}

/** 分享（微信/QQ/…）。 */
export function shareImageFromDevice(dataUrl: unknown, bridge: any): NativeSaveResult {
  const parts = splitDataUrl(dataUrl);
  if (!parts) return { ok: false, error: '这不是一张可分享的本地图片' };
  if (!canShareImage(bridge)) return { ok: false, error: '当前 App 版本不支持分享图片（需要更新到新版）' };
  try {
    const r = JSON.parse(String(bridge.shareFileBase64(imageFileName(parts.mime), parts.base64, parts.mime)));
    if (r && r.ok) return { ok: true };
    return { ok: false, error: String((r && r.error) || '分享失败') };
  } catch (e) {
    return { ok: false, error: String((e && (e as Error).message) || e) };
  }
}
