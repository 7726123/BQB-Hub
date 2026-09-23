import { describe, it, expect } from 'vitest';
import { nodeRawLen, rawOffsetOf, selectedRawText, roundIndexOf, roundMembers, collectRoundDeletes, type MsgLike } from '../src/lib/msgslice';

// 构造与气泡 DOM 同形的假节点树：正文转义后按 \n → <br> 渲染
function text(data: string) { return { nodeType: 3, data, nodeName: '#text', childNodes: [] }; }
function br() { return { nodeType: 1, nodeName: 'BR', childNodes: [] }; }
function el(children: any[]) { return { nodeType: 1, nodeName: 'DIV', childNodes: children }; }

describe('选区 → 原文切片（复制不丢换行）', () => {
  const raw = '第一行\n第二行\n第三行';
  // DOM：文本 "第一行" + <br> + "第二行" + <br> + "第三行"
  const root = el([text('第一行'), br(), text('第二行'), br(), text('第三行')]);

  it('nodeRawLen：文本按字符数、<br> 按 1 个换行计', () => {
    expect(nodeRawLen(text('abc'))).toBe(3);
    expect(nodeRawLen(br())).toBe(1);
    expect(nodeRawLen(root)).toBe(raw.length);
  });

  it('整条选区 → 原文逐字一致', () => {
    const range = { startContainer: root, startOffset: 0, endContainer: root, endOffset: 5 };
    expect(selectedRawText(root, raw, range)).toBe(raw);
  });

  it('跨 <br> 的局部选区保留换行', () => {
    // 从"第一行"的第 1 字 到 第三行开头
    const range = { startContainer: root.childNodes[0], startOffset: 1, endContainer: root.childNodes[4], endOffset: 0 };
    expect(selectedRawText(root, raw, range)).toBe('一行\n第二行\n');
  });

  it('同一文本节点内的选区', () => {
    const range = { startContainer: root.childNodes[2], startOffset: 1, endContainer: root.childNodes[2], endOffset: 3 };
    expect(selectedRawText(root, raw, range)).toBe('二行');
  });

  it('逆序选区（从后往前拖）自动归一', () => {
    const range = { startContainer: root.childNodes[4], startOffset: 0, endContainer: root.childNodes[0], endOffset: 1 };
    expect(selectedRawText(root, raw, range)).toBe('一行\n第二行\n');
  });

  it('端点映射失败 / 无 range → 退回整条（不会复制出空串）', () => {
    expect(selectedRawText(root, raw, null)).toBe(raw);
    const outside = { startContainer: text('x'), startOffset: 0, endContainer: text('x'), endOffset: 1 };
    expect(selectedRawText(root, raw, outside)).toBe(raw);
  });

  it('偏移越界被夹取，不抛异常', () => {
    const range = { startContainer: root.childNodes[0], startOffset: 0, endContainer: root.childNodes[0], endOffset: 999 };
    expect(selectedRawText(root, raw, range)).toBe('第一行');
  });

  it('rawOffsetOf：元素节点的 offset 指子节点序号', () => {
    expect(rawOffsetOf(root, root, 2)).toBe(4); // "第一行"(3) + <br>(1)
  });
});

describe('轮次配对与批量删除', () => {
  const msgs = (): MsgLike[] => ([
    { role: 'user', content: 'u0' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'u2' },
    { role: 'assistant', content: 'a3' },
    { role: 'user', content: 'u4' },   // 孤立，还没回答
  ]);

  it('轮内两条消息映射到同一锚点', () => {
    const m = msgs();
    expect(roundIndexOf(m, 0)).toBe(0);
    expect(roundIndexOf(m, 1)).toBe(0);
    expect(roundIndexOf(m, 2)).toBe(2);
    expect(roundIndexOf(m, 3)).toBe(2);
    expect(roundIndexOf(m, 4)).toBe(4);
    expect(roundIndexOf(m, 9)).toBe(-1);
  });

  it('roundMembers 返回成对下标；孤立消息只有自己', () => {
    const m = msgs();
    expect(roundMembers(m, 0)).toEqual([0, 1]);
    expect(roundMembers(m, 2)).toEqual([2, 3]);
    expect(roundMembers(m, 4)).toEqual([4]);
  });

  it('删一轮 = 删两条（提问 + 回答）', () => {
    const m = msgs();
    expect(collectRoundDeletes(m, [0])).toEqual({ indices: [1, 0], hadPending: false });
  });

  it('点同轮的两条消息都指向同一轮，不会重复计数', () => {
    const m = msgs();
    expect(collectRoundDeletes(m, [0, 1]).indices).toEqual([1, 0]);
  });

  it('多轮批量删除：去重 + 降序（先删后面的，下标不漂移）', () => {
    const m = msgs();
    expect(collectRoundDeletes(m, [2, 0, 4]).indices).toEqual([4, 3, 2, 1, 0]);
    const mixed = collectRoundDeletes(m, [1, 2]);
    expect(mixed.indices).toEqual([3, 2, 1, 0]);
  });

  it('轮内带未应用变更时回报 hadPending（提示语用）', () => {
    const m = msgs();
    m[1].pendingChanges = [{ op: 'add' }];
    expect(collectRoundDeletes(m, [0]).hadPending).toBe(true);
    expect(collectRoundDeletes(m, [2]).hadPending).toBe(false);
  });

  it('越界锚点被忽略，不产生负下标', () => {
    const m = msgs();
    expect(collectRoundDeletes(m, [99]).indices).toEqual([]);
  });
});
