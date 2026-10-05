// 把图片存到手机本地 / 分享：data URL 拆分、文件名、原生桥调用与不可用时的降级。
// 原生侧（HttpBridge.saveFileBase64/shareFileBase64）只能装包后在真机上验；这里锁的是"交给原生的东西对不对"。
import { describe, it, expect } from 'vitest';
import { splitDataUrl, imageFileName, canSaveImage, canShareImage, saveImageToDevice, shareImageFromDevice } from '../src/lib/saveimage';

const PNG = 'data:image/png;base64,AAAB';
const JPG = 'data:image/jpeg;base64,/9j/4AAQ';

function bridge(over?: any) {
  const calls: any[] = [];
  const b: any = {
    calls: calls,
    saveFileBase64: (name: string, b64: string, mime: string) => { calls.push({ fn: 'save', name: name, b64: b64, mime: mime }); return JSON.stringify(over && over.save || { ok: true, path: '相册/BQB Hub/' + name }); },
    shareFileBase64: (name: string, b64: string, mime: string) => { calls.push({ fn: 'share', name: name, b64: b64, mime: mime }); return JSON.stringify(over && over.share || { ok: true }); }
  };
  return b;
}

describe('splitDataUrl', () => {
  it('拆出 mime 与 base64（带不带分号参数都认）', () => {
    expect(splitDataUrl(PNG)).toEqual({ mime: 'image/png', base64: 'AAAB' });
    expect(splitDataUrl('data:image/jpeg;charset=utf-8;base64,/9j')).toEqual({ mime: 'image/jpeg', base64: '/9j' });
    expect(splitDataUrl('data:image/png;base64,AA A\nB')).toEqual({ mime: 'image/png', base64: 'AAAB' });   // 空白会被去掉
  });
  it('不是 data URL / 空 base64 → null（外链头像存不了）', () => {
    expect(splitDataUrl('http://x/a.png')).toBeNull();
    expect(splitDataUrl('')).toBeNull();
    expect(splitDataUrl('data:image/png;base64,')).toBeNull();
    expect(splitDataUrl(null)).toBeNull();
  });
});

describe('imageFileName', () => {
  it('按 mime 给扩展名，时间戳可读（BQB_20261006_153012.png）', () => {
    const d = new Date(2026, 9, 6, 15, 30, 12);   // 2026-10-06 15:30:12
    expect(imageFileName('image/png', d)).toBe('BQB_20261006_153012.png');
    expect(imageFileName('image/jpeg', d)).toBe('BQB_20261006_153012.jpg');
    expect(imageFileName('image/webp', d)).toBe('BQB_20261006_153012.webp');
    expect(imageFileName('', d)).toBe('BQB_20261006_153012.png');
  });
});

describe('saveImageToDevice / shareImageFromDevice', () => {
  it('可用时：把文件名、纯 base64、mime 交给原生，返回保存路径', () => {
    const b = bridge();
    const r = saveImageToDevice(PNG, b);
    expect(r.ok).toBe(true);
    expect(r.path).toContain('相册/BQB Hub/BQB_');
    expect(b.calls[0].fn).toBe('save');
    expect(b.calls[0].b64).toBe('AAAB');            // 只给字节，不给 data: 前缀
    expect(b.calls[0].mime).toBe('image/png');
    expect(b.calls[0].name.endsWith('.png')).toBe(true);
    const s = shareImageFromDevice(JPG, b);
    expect(s.ok).toBe(true);
    expect(b.calls[1].fn).toBe('share');
    expect(b.calls[1].mime).toBe('image/jpeg');
  });

  it('老 APK（没有原生方法）：按钮不显示、直接调用也给出人话解释', () => {
    const old: any = { saveFile: () => '{}' };      // 只有旧的文本方法
    expect(canSaveImage(old)).toBe(false);
    expect(canShareImage(old)).toBe(false);
    const r = saveImageToDevice(PNG, old);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('更新到新版');
    expect(shareImageFromDevice(PNG, old).ok).toBe(false);
    expect(canSaveImage(null)).toBe(false);
  });

  it('原生报错 / 返回坏 JSON → 结构化失败，不抛', () => {
    const bad = bridge({ save: { ok: false, error: 'MediaStore insert failed' } });
    const r = saveImageToDevice(PNG, bad);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('MediaStore');
    const broke = { saveFileBase64: () => { throw new Error('boom'); } };
    expect(saveImageToDevice(PNG, broke).ok).toBe(false);
    expect(saveImageToDevice('http://x/a.png', bridge()).error).toContain('本地图片');
  });
});
