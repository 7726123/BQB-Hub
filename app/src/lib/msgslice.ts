// 写卡消息区纯逻辑：选区 → 原文切片、轮次配对、批量删除索引。
// 独立成文件是为了可单测：函数只依赖"鸭子类型"的最小节点形状
// （nodeType / data / nodeName / childNodes），node 测试环境无需 DOM。

export interface MsgLike { role?: string; content?: string; pendingChanges?: any; [k: string]: any }

// ---- 选区 → 原文切片 ----
// 气泡 DOM 是把原文转义后按 \n → <br> 渲染的：文本节点长度 = 原文长度，每个 <br> = 1 个换行。
// 用 Range.toString() 复制会丢换行（<br> 不算文本），所以把选区端点映射回原文下标再切片。

export function nodeRawLen(n: any): number {
  if (!n) return 0;
  if (n.nodeType === 3) return String(n.data == null ? '' : n.data).length;
  if (String(n.nodeName || '').toUpperCase() === 'BR') return 1;
  const kids = (n.childNodes || []) as any[];
  let s = 0;
  for (let i = 0; i < kids.length; i++) s += nodeRawLen(kids[i]);
  return s;
}

// 节点内某位置 → 原文下标（找不到返回 -1）
export function rawOffsetOf(root: any, node: any, offset: number): number {
  let found = -1;
  let pos = 0;
  const visit = (n: any) => {
    if (found >= 0 || !n) return;
    if (n === node) {
      if (n.nodeType === 3) {
        const len = String(n.data == null ? '' : n.data).length;
        found = pos + Math.max(0, Math.min(offset, len));
      } else {
        const kids = (n.childNodes || []) as any[];
        let p = pos;
        for (let k = 0; k < offset && k < kids.length; k++) p += nodeRawLen(kids[k]);
        found = p;
      }
      return;
    }
    if (n.nodeType === 3) { pos += String(n.data == null ? '' : n.data).length; return; }
    if (String(n.nodeName || '').toUpperCase() === 'BR') { pos += 1; return; }
    const kids = (n.childNodes || []) as any[];
    for (let i = 0; i < kids.length; i++) { visit(kids[i]); if (found >= 0) return; }
  };
  visit(root);
  return found;
}

// 选区覆盖的原文（端点映射失败 → 退回整条）
export function selectedRawText(root: any, raw: string, range: any): string {
  const s = String(raw == null ? '' : raw);
  if (!root || !range) return s;
  let a = rawOffsetOf(root, range.startContainer, range.startOffset);
  let b = rawOffsetOf(root, range.endContainer, range.endOffset);
  if (a < 0 || b < 0) return s;
  if (a > b) { const t = a; a = b; b = t; }
  a = Math.max(0, Math.min(a, s.length));
  b = Math.max(0, Math.min(b, s.length));
  return s.slice(a, b);
}

// ---- 轮次（一轮 = 一条 user + 紧邻的 assistant）----

// 任一条消息 → 所属轮的锚点（该轮第一条的下标；孤立消息锚点=自己；无此条返回 -1）
export function roundIndexOf(messages: MsgLike[], i: number): number {
  const m = messages[i];
  if (!m) return -1;
  if (m.role === 'user' && messages[i + 1] && messages[i + 1].role === 'assistant') return i;
  if (m.role === 'assistant' && i > 0 && messages[i - 1].role === 'user') return i - 1;
  return i;
}

// 锚点所在轮的成员下标（升序）
export function roundMembers(messages: MsgLike[], anchor: number): number[] {
  const m = messages[anchor];
  if (!m) return [];
  if (m.role === 'user' && messages[anchor + 1] && messages[anchor + 1].role === 'assistant') return [anchor, anchor + 1];
  if (m.role === 'assistant' && anchor > 0 && messages[anchor - 1].role === 'user') return [anchor - 1, anchor];
  return [anchor];
}

// 多个锚点 → 去重后的删除下标（降序，供 splice）+ 是否含未应用的变更
export function collectRoundDeletes(messages: MsgLike[], anchors: number[]): { indices: number[]; hadPending: boolean } {
  const set: Record<number, boolean> = {};
  (anchors || []).forEach((a) => {
    const key = roundIndexOf(messages, a);
    if (key < 0) return;
    roundMembers(messages, key).forEach((ix) => { set[ix] = true; });
  });
  const indices = Object.keys(set).map(Number).sort((x, y) => y - x);
  let hadPending = false;
  indices.forEach((ix) => { if (messages[ix] && messages[ix].pendingChanges) hadPending = true; });
  return { indices, hadPending };
}
