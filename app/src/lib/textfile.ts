// 正文文件导入的解码/转义纯逻辑（供 App.handleImportNovelText 使用，便于单测）。
//
// 为什么需要：Windows 上的中文小说 txt 常见 GBK 编码，直接按 UTF-8 读会整篇乱码；
// 而编辑器是 contenteditable，写入必须走 HTML 转义（否则正文里的 < > & 会被当标签解析）。

/** 解码：先按严格 UTF-8 试，失败回落 GBK；统一换行并去掉 BOM、归一全角空格 */
export function decodeNovelText(input: ArrayBuffer | Uint8Array): string {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    text = new TextDecoder('gbk').decode(buf);
  }
  return text
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ');
}

/** 正文 → 编辑器 HTML：转义 & < >，换行转 <br>（EditorManager.setContent 直接赋 innerHTML） */
export function novelTextToEditorHtml(text: string): string {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/** 追加合并：已有内容与导入内容之间补一个空行，避免两段贴在一起 */
export function mergeChapterText(existing: string, incoming: string): string {
  const a = String(existing || '').replace(/\s+$/, '');
  const b = String(incoming || '').replace(/^\s+/, '');
  if (!a) return b;
  if (!b) return a;
  return a + '\n\n' + b;
}
