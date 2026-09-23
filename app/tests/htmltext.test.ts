// HTML → 纯文本：<br>/块级边界必须产生换行。
// 回归背景：原先 getPlainText 走「克隆节点 + innerText」，Chrome 对分离节点会退化成
// textContent（<br> 不算换行）→ 整篇正文拼成一整行 → 水位线块只能按字数硬切、
// BM25 检索单元从 ~800 字退化成整块 8000 字。真机留档实测注入 42182 字（预算 10000）。
import { describe, it, expect } from 'vitest';
import { domToPlainText, htmlToPlainText, type TextNodeLike } from '../src/lib/htmltext';

const txt = (data: string): TextNodeLike => ({ nodeType: 3, data });
const el = (tagName: string, children: TextNodeLike[] = []): TextNodeLike => ({ nodeType: 1, tagName, childNodes: children });

describe('domToPlainText：换行语义（与附着节点 innerText 对齐）', () => {
  it('<br> 产生换行，连续 <br> 保留空行', () => {
    const root = el('DIV', [txt('甲'), el('BR'), el('BR'), txt('乙'), el('BR'), txt('丙')]);
    expect(domToPlainText(root)).toBe('甲\n\n乙\n丙');
  });

  it('块级兄弟元素之间换行，内联元素之间不换行', () => {
    expect(domToPlainText(el('DIV', [el('DIV', [txt('甲')]), el('DIV', [txt('乙')])]))).toBe('甲\n乙\n');
    expect(domToPlainText(el('DIV', [el('SPAN', [txt('甲')]), el('B', [txt('乙')])]))).toBe('甲乙');
  });

  it('空块只贡献一个换行（不产生额外空行）', () => {
    expect(domToPlainText(el('DIV', [txt('甲'), el('DIV', []), txt('乙')]))).toBe('甲\n乙');
  });

  it('嵌套块 + 内联混合', () => {
    const root = el('DIV', [el('DIV', [txt('甲'), el('BR'), el('SPAN', [txt('乙'), el('BR'), txt('丙')])])]);
    expect(domToPlainText(root)).toBe('甲\n乙\n丙\n');
  });

  it('缩进与全角空格原样保留（编辑器 white-space: pre-wrap）', () => {
    const root = el('DIV', [txt('   甲'), el('BR'), el('BR'), txt('    乙')]);
    expect(domToPlainText(root)).toBe('   甲\n\n    乙');
  });

  it('ai-generated 包裹（模型输出）段落结构不丢', () => {
    const root = el('DIV', [el('DIV', [txt('甲'), el('BR'), el('BR'), txt('乙')]), el('DIV', [txt('丙')])]);
    expect(domToPlainText(root)).toBe('甲\n\n乙\n丙\n');
  });
});

describe('htmlToPlainText：折叠与首尾去空', () => {
  it('无 DOM 环境（node 测试）退化为原样返回——有 DOM 时由浏览器解析', () => {
    // 项目测试跑在 node 环境，document 是桩（无 createElement）→ 走退化分支
    expect(htmlToPlainText('<div>甲<br>乙</div>')).toBe('<div>甲<br>乙</div>');
    expect(htmlToPlainText('')).toBe('');
  });

  it('折叠逻辑：3 个以上换行收敛为 2 个、去掉首尾换行', () => {
    // 用 DOM 走不通时，直接验证 domToPlainText 的输出形态符合调用方预期
    const many = el('DIV', [el('BR'), el('BR'), el('BR'), txt('甲'), el('BR'), el('BR'), el('BR')]);
    const folded = domToPlainText(many).replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
    expect(folded).toBe('甲');
  });
});
