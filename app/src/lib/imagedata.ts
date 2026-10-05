// 图片数据工具：二进制 → dataURL（分块 base64）、dataURL → 按长边缩放重编码。
//
// 为什么不直接用现成的：
//   · `String.fromCharCode(...bytes)` 展开 1MB 级图片会爆栈 → 分块拼；
//   · FileReader 面向 File/Blob，而我们从 fetch 拿到的是 Uint8Array；
//   · App._resizeImageDataUrl 只按**宽度**缩放且写死 JPEG 0.85，头像要求"长边 512 / 0.92"。

/** 按长边等比缩放的目标尺寸（纯函数，便于单测）。maxSide 小于原图时缩小，否则原样。 */
export function scaleSize(w: number, h: number, maxSide: number): { w: number; h: number } {
  const W = Math.max(1, Math.round(Number(w) || 0));
  const H = Math.max(1, Math.round(Number(h) || 0));
  const M = Math.max(1, Math.round(Number(maxSide) || 0));
  const s = Math.min(1, M / Math.max(W, H));
  return { w: Math.max(1, Math.round(W * s)), h: Math.max(1, Math.round(H * s)) };
}

/** 二进制 → dataURL（分块 btoa）。失败返回空串，调用方按"没有图"处理。 */
export function bytesToDataUrl(bytes: Uint8Array, mime?: string): string {
  try {
    if (!bytes || !bytes.length) return '';
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      const sub = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
      bin += String.fromCharCode.apply(null, sub as unknown as number[]);
    }
    const b64 = typeof btoa === 'function' ? btoa(bin) : '';
    return b64 ? ('data:' + (mime || 'image/png') + ';base64,' + b64) : '';
  } catch (e) { return ''; }
}

/** dataURL → 按长边缩放并重编码为 JPEG。失败返回 ''（调用方自行兜底）。 */
export function resizeDataUrlLongSide(dataUrl: string, maxSide: number, quality = 0.9): Promise<string> {
  return new Promise((resolve) => {
    try {
      const src = String(dataUrl || '');
      if (!src) { resolve(''); return; }
      const img = new Image();
      img.onload = () => {
        try {
          const t = scaleSize(img.width, img.height, maxSide);
          if (t.w === img.width && t.h === img.height) { resolve(src); return; }
          const cv = document.createElement('canvas');
          cv.width = t.w; cv.height = t.h;
          const ctx = cv.getContext('2d');
          if (!ctx) { resolve(''); return; }
          ctx.drawImage(img, 0, 0, t.w, t.h);
          resolve(cv.toDataURL('image/jpeg', quality));
        } catch (e) { resolve(''); }
      };
      img.onerror = () => resolve('');
      img.src = src;
    } catch (e) { resolve(''); }
  });
}
