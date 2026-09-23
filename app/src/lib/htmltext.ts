// HTML → 纯文本（供水位线 / 归档检索 / 提示词组装 / TXT 导出共用）：
// `<br>` 与块级元素边界产生 '\n'，段落结构必须保留。
//
// 为什么不能用 innerText：对「分离节点」（cloneNode 产物、createElement 后没挂进文档的 div），
// Chrome 会把 innerText 退化成 textContent —— `<br>`/块级边界不再算换行。实测（无头 Chrome）：
//   附着节点  "甲<br><br>乙<br>丙"  → "甲\n\n乙\n丙"
//   分离克隆  同一内容              → "甲乙丙"
//   分离 div  同一内容              → "甲乙丙"
// 后果（真机留档实测）：整篇正文拼成一整行 → 水位线块只能按字数硬切（注入片段正好落在 8000 的
// 整数倍）、BM25 检索单元从 ~800 字退化成整块 8000 字、注入给模型的「已完成正文」失去段落结构。
//
// 本实现不依赖渲染（纯遍历已解析的 DOM），node 测试环境同样可测。与真实附着 innerText 的差异
// 只有三处，均可接受：
//   · 连续 3 个以上换行折叠成 2 个（保留段落结构，不堆空行）
//   · 首尾换行去掉
//   · 依赖 CSS 的块级（如 <span style="display:block">）不按块处理——编辑器不使用这种写法

const BLOCK_TAGS: Record<string, boolean> = {
  DIV: true, P: true, LI: true, UL: true, OL: true, DL: true, DT: true, DD: true,
  H1: true, H2: true, H3: true, H4: true, H5: true, H6: true,
  BLOCKQUOTE: true, PRE: true, SECTION: true, ARTICLE: true, ADDRESS: true,
  TABLE: true, TR: true, FIGURE: true, FIGCAPTION: true, HR: true, DETAILS: true,
};

/** 极简节点接口：真实 DOM 节点（Node/Element/Text）结构上即满足，便于用普通对象写单测 */
export interface TextNodeLike {
  nodeType: number;
  data?: string;
  tagName?: string;
  childNodes?: ArrayLike<TextNodeLike>;
}

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

/** 遍历已解析的 DOM，按渲染语义拼出纯文本（换行见文件头说明） */
export function domToPlainText(root: TextNodeLike): string {
  let out = '';
  const kids = root.childNodes || [];
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (!c) continue;
    if (c.nodeType === TEXT_NODE) { out += c.data || ''; continue; }
    if (c.nodeType !== ELEMENT_NODE) continue;
    const tag = String(c.tagName || '').toUpperCase();
    if (tag === 'BR') { out += '\n'; continue; }
    const inner = domToPlainText(c);
    if (BLOCK_TAGS[tag]) {
      // 块级边界：块前补一个换行（若前面不是换行），块后再补一个
      if (out && out.charAt(out.length - 1) !== '\n') out += '\n';
      out += inner;
      if (out.charAt(out.length - 1) !== '\n') out += '\n';
    } else {
      out += inner;
    }
  }
  return out;
}

/** HTML → 纯文本（换行折叠、首尾去空）。无 DOM 环境退化为原字符串 */
export function htmlToPlainText(html: string): string {
  const src = String(html || '');
  if (!src) return '';
  const doc = (globalThis as unknown as { document?: Document }).document;
  if (!doc || typeof doc.createElement !== 'function') return src;
  const host = doc.createElement('div');
  host.innerHTML = src;
  return domToPlainText(host as unknown as TextNodeLike)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
}

export default htmlToPlainText;
