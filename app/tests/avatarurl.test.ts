// 头像短地址（lib/avatarurl.ts）：data URL → 会话内 blob: 短地址。
// 这是「对话模式流式卡死」的修复：以前每 200ms 重画整屏气泡时会把每个头像的几百 KB base64
// 重新塞进 DOM 一次，单帧成本随头像大小线性上涨（实测 121 个气泡：3.9KB→7ms，273KB→161ms）。
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { avatarUrl, _clearAvatarUrlsForTest } from '../src/lib/avatarurl';

const b64 = (text: string) => 'data:image/png;base64,' + Buffer.from(text).toString('base64');

beforeEach(() => { _clearAvatarUrlsForTest(); });

describe('avatarUrl：data URL 换成会话内短地址', () => {
  it('同一份头像数据每次返回同一个短地址（缓存命中，不重复解码）', () => {
    const src = b64('fake-image-bytes');
    const a = avatarUrl(src);
    const b = avatarUrl(src);
    expect(a).toBe(b);
    expect(String(a).startsWith('blob:')).toBe(true);
    expect(String(a).length).toBeLessThan(80);          // 短地址：几十字节，而不是几百 KB
  });

  it('不同头像 → 不同短地址；换头像 = 新键（不存在"缓存没清掉还是旧头像"）', () => {
    const u1 = avatarUrl(b64('img-1'));
    const u2 = avatarUrl(b64('img-2'));
    expect(u1).not.toBe(u2);
    // 同一角色换了头像：旧地址不受影响，新数据拿到新地址
    expect(avatarUrl(b64('img-1'))).toBe(u1);
  });

  it('非 data URL 原样返回（blob:/http/相对路径已经是短地址）', () => {
    expect(avatarUrl('blob:http://x/y')).toBe('blob:http://x/y');
    expect(avatarUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(avatarUrl('assets/av.png')).toBe('assets/av.png');
  });

  it('空值返回 null；非法/异常数据退回原 data URL（显示正确优先，绝不抛错）', () => {
    expect(avatarUrl(null)).toBeNull();
    expect(avatarUrl(undefined)).toBeNull();
    expect(avatarUrl('')).toBeNull();
    const broken = 'data:image/png;base64,!!!not-base64!!!';
    expect(avatarUrl(broken)).toBe(broken);
  });

  it('非 base64 的 data URL（百分号编码，如 SVG）也能转成短地址', () => {
    const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3C%2Fsvg%3E';
    const u = avatarUrl(svg);
    expect(String(u).startsWith('blob:')).toBe(true);
    expect(avatarUrl(svg)).toBe(u);
  });

  it('环境不支持 createObjectURL 时退回原 data URL（老 WebView 也不能白屏）', () => {
    const orig = URL.createObjectURL;
    // @ts-expect-error 故意摘掉能力
    delete URL.createObjectURL;
    try {
      const src = b64('no-blob-support');
      expect(avatarUrl(src)).toBe(src);
    } finally {
      URL.createObjectURL = orig;
    }
  });

  it('解码出的字节与原文一致（不是空壳地址）', async () => {
    const spy = vi.spyOn(URL, 'createObjectURL');
    const src = 'data:image/png;base64,' + Buffer.from('hello-avatar').toString('base64');
    avatarUrl(src);
    const blob = spy.mock.calls[0][0] as Blob;
    spy.mockRestore();
    expect(blob.type).toBe('image/png');
    expect(Buffer.from(await blob.arrayBuffer()).toString('utf8')).toBe('hello-avatar');
  });

  it('测试清理会撤销已生成的地址', () => {
    const spy = vi.spyOn(URL, 'revokeObjectURL');
    const u = String(avatarUrl(b64('to-revoke')));
    _clearAvatarUrlsForTest();
    expect(spy).toHaveBeenCalledWith(u);
    spy.mockRestore();
    // 清空后同一份数据会生成新地址（旧地址已撤销，不会继续被引用）
    expect(avatarUrl(b64('to-revoke'))).not.toBe(u);
  });
});
