// 头像短地址：把 data URL 换成会话内的 blob: 短地址。
//
// 为什么需要：头像存的是 base64 data URL（几百 KB 一个）。以前每渲染一次就把那一长串塞进 DOM
// 一次，而对话模式流式输出时**每 200ms 要把整屏气泡连同头像重画一遍**——实测 121 个气泡：
// 头像 3.9KB → 单帧 7ms，273KB → 161ms，约 1MB → 637ms（桌面 Chrome，手机还要乘几倍）。
// 单帧一超过 200ms，JS 线程就被渲染占满：界面卡死、流式数据只能排队，等线程空出来一次性补上
// （用户看到的「卡住一会儿然后 3 秒输出 2000 字」就是这个）。
// 换成 blob: 后字符串从几百 KB 压到几十字节，图像解码也按地址只做一次。
//
// 缓存键 = 头像数据本身：换头像就是一个新键，天然不存在「缓存没清掉、气泡里还是旧头像」。
// 不做淘汰也不主动 revoke：revoke 掉仍在页面上的地址会让图片当场变空白，而一个会话里的不同头像
// 数量本来就有界（一本书的角色数），多出来的内存与条目里已有的 base64 同量级。
const _cache = new Map<string, string>();

function _b64ToBytes(b64: string): Uint8Array<ArrayBuffer> | null {
  try {
    const bin = atob(b64.replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch (e) { return null; }   // 非法 base64：调用方退回原 data URL
}

function _toBlob(src: string): Blob | null {
  const m = /^data:([^,]*),([\s\S]*)$/.exec(src);
  if (!m) return null;
  const meta = m[1] || '';
  const payload = m[2] || '';
  const mime = (meta.split(';')[0] || '').trim() || 'image/png';
  try {
    if (/;base64/i.test(meta)) {
      const bytes = _b64ToBytes(payload);
      return bytes ? new Blob([bytes], { type: mime }) : null;
    }
    // 非 base64 的 data URL（如 data:image/svg+xml,%3Csvg…）按百分号编码解
    return new Blob([decodeURIComponent(payload)], { type: mime });
  } catch (e) { return null; }
}

/** 可用的短地址环境（老 WebView / 测试环境缺能力时退回原样，显示正确优先） */
function _supported(): boolean {
  return typeof atob === 'function' && typeof Blob === 'function'
    && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

/**
 * data URL → 会话内短地址（同一份头像数据每次返回同一个地址）。
 * 非 data URL（blob:/http/相对路径）原样返回；空值返回 null；任何异常都退回原 data URL。
 */
export function avatarUrl(src: unknown): string | null {
  const s = String(src == null ? '' : src);
  if (!s) return null;
  if (s.slice(0, 5) !== 'data:') return s;
  const hit = _cache.get(s);
  if (hit) return hit;
  if (!_supported()) return s;
  try {
    const blob = _toBlob(s);
    if (!blob) return s;
    const url = URL.createObjectURL(blob);
    _cache.set(s, url);
    return url;
  } catch (e) { return s; }
}

/** 测试用：清空缓存并撤销已生成的地址 */
export function _clearAvatarUrlsForTest(): void {
  try {
    _cache.forEach(function (u) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } });
  } catch (e) { /* ignore */ }
  _cache.clear();
}

export default avatarUrl;
