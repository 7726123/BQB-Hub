// 输入框自动增高（QQ 式：初高一行，最多 max-height，超出滚动）。
//
// 为什么单独成模块：写作页（mobile.ts 绑 #writingInput）与对话模式（chatmode.ts 绑 #chatInput）
// 必须是**同一套行为**——以前是两份各自实现的代码，行为会漂移（用户实测：对话输入框删到空之后
// 还挂着好几行高，写作页却没这问题）。
//
// 关键点（2026-09-25 实测确认的坑）：**空值不能用 scrollHeight**。
// 空 textarea 的 scrollHeight 会把 placeholder 的高度也算进去，而 placeholder 在窄屏会折行：
// 412px 宽的手机上 #chatInput 空值 scrollHeight=94px（placeholder 两行），比两行正文的 70px 还高
// ——于是"删光了输入框还是好几行高"。空值直接交回 CSS（min-height 就是一行）。
//
// 另一个细节：只有「光标原本在末尾」时才把滚动条拉到最底（用户在最后一行追加输入）；
// 光标在中间（上移修改前面的内容）时不干预——强制 scrollTop=scrollHeight 会把光标顶出视口。

export function autoGrow(ta: HTMLTextAreaElement | null): void {
  if (!ta || !ta.style) return;
  const val = String(ta.value || '');
  if (!val) { ta.style.height = ''; return; }        // 空值：回落 CSS 高度，别看 scrollHeight
  ta.style.height = 'auto';
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(ta) : null;   // 测试环境没有它
  const max = (cs && parseFloat(cs.maxHeight)) || 120;
  ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  const atEnd = ta.selectionStart == null || ta.selectionStart >= val.length;
  if (atEnd && ta.scrollHeight > ta.clientHeight + 1) ta.scrollTop = ta.scrollHeight;
}

/** 绑上自动增高：input 是主路径，change/blur 兜住 IME 删除、粘贴、收起键盘这些不发 input 的路径。 */
export function bindAutoGrow(ta: HTMLTextAreaElement | null): void {
  if (!ta || typeof ta.addEventListener !== 'function') return;   // 形如 {value} 的假元素（测试/爱用兜底）不炸
  const run = () => autoGrow(ta);
  ta.addEventListener('input', run);
  ta.addEventListener('change', run);
  ta.addEventListener('blur', run);
}

export default { autoGrow, bindAutoGrow };
