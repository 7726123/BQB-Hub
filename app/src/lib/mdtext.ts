// 模型输出里的 **小标题** → 高亮显示（写卡/助手/比奇共用）。
// 调用约定：入参必须是**已完成 HTML 转义**的文本（各渲染点都在转义之后调用本函数），
// 这样插入的 <strong> 标签不会被二次转义，也不会引入新的注入面。
// 只处理不跨行、内容非空的 **...**；单个 * 或未闭合的 ** 原样保留。
export function renderMdStrong(escaped: string): string {
  return String(escaped || '').replace(/\*\*([^*\n]+?)\*\*/g, function (m: string, inner: string) {
    if (!String(inner).trim()) return m;
    return '<strong class="md-strong">' + inner + '</strong>';
  });
}

export default renderMdStrong;
