// 正文导入的纯逻辑：UTF-8（含 BOM）/ GBK 解码、换行归一、HTML 转义、章节追加合并。
import { describe, it, expect } from 'vitest';
import { decodeNovelText, novelTextToEditorHtml, mergeChapterText } from '../src/lib/textfile';

const enc = (s: string, encName: string) => {
  // Node 不内置 GBK 编码器：用手写字节数组覆盖常见汉字（我/你/的/了 + 「」）
  if (encName === 'utf-8') return new TextEncoder().encode(s);
  throw new Error('仅支持 utf-8 编码');
};

// 手工构造 GBK 字节：'我'=CE D2、'你'=C4 E3、'的'=B5 C4、'了'=C1 CB、'。'=A1 A3
const GBK_SAMPLE = new Uint8Array([0xce, 0xd2, 0xc4, 0xe3, 0xb5, 0xc4, 0xc1, 0xcb, 0xa1, 0xa3]);

describe('decodeNovelText', () => {
  it('UTF-8 正常解码并去掉 BOM、统一换行', () => {
    const buf = enc('\uFEFF第一行\r\n第二行\r第三行', 'utf-8');
    expect(decodeNovelText(buf)).toBe('第一行\n第二行\n第三行');
  });

  it('全角空格归一为半角（与项目正文清洗一致）', () => {
    expect(decodeNovelText(enc('甲\u3000乙', 'utf-8'))).toBe('甲 乙');
  });

  it('非法 UTF-8 字节回落 GBK 解码（Windows 中文 txt 常见）', () => {
    expect(decodeNovelText(GBK_SAMPLE)).toBe('我你的了。');
  });

  it('纯 ASCII 两种编码结果一致', () => {
    expect(decodeNovelText(enc('hello\nworld', 'utf-8'))).toBe('hello\nworld');
  });

  it('空输入不炸', () => {
    expect(decodeNovelText(new Uint8Array(0))).toBe('');
  });
});

describe('novelTextToEditorHtml', () => {
  it('转义 & < >（防正文被当标签解析）', () => {
    expect(novelTextToEditorHtml('<script>a & b</script>')).toBe('&lt;script&gt;a &amp; b&lt;/script&gt;');
  });

  it('换行转 <br>（setContent 直接赋 innerHTML）', () => {
    expect(novelTextToEditorHtml('甲\n乙\n\n丙')).toBe('甲<br>乙<br><br>丙');
  });

  it('中文与引号原样保留', () => {
    expect(novelTextToEditorHtml('「你好」')).toBe('「你好」');
  });
});

describe('mergeChapterText', () => {
  it('空章节 → 直接用导入内容', () => {
    expect(mergeChapterText('', '正文')).toBe('正文');
    expect(mergeChapterText('   \n ', '正文')).toBe('正文');
  });

  it('已有内容 → 中间补空行追加', () => {
    expect(mergeChapterText('旧文', '新文')).toBe('旧文\n\n新文');
  });

  it('两端空白被清理，不产生多余空行', () => {
    expect(mergeChapterText('旧文\n\n', '\n\n新文')).toBe('旧文\n\n新文');
  });

  it('导入为空 → 保持原样', () => {
    expect(mergeChapterText('旧文', '   ')).toBe('旧文');
  });
});
