// 输入行那几个图标（发送 / 继续 / 停止）：写作页、对话模式、真实模式共用同一份字符串，
// 避免三处各写一套 SVG 慢慢走形。
//
// 停止图标（2026-10-11 用户指定）："圆角方框套实心方块"（⏹ 的形态）——以前三处都是 ✕，
// 用户觉得语义不对（✕ 更像"关闭"）。而且现在**生成中发送键自己就是停止键**（同一颗按钮、
// 同一个位置），图标切换必须跟着这颗键走（见 App._syncWriteSendBtn / ChatMode._renderHead /
// RealMode.refreshSendLabel）。
export const ICON_SEND =
  '<svg class="ic-20 rot-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">'
  + '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"></path></svg>';

/** 空输入时的"继续"（播放三角）：真实模式/写作页的空输入发送保持这个语义 */
export const ICON_CONTINUE =
  '<svg class="ic-20" fill="none" stroke="currentColor" viewBox="0 0 24 24">'
  + '<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 4l14 8-14 8V4z"></path></svg>';

/** 停止：外圈圆角方框（描边）+ 内圈实心方块（与 ⏹ 的观感一致） */
export const ICON_STOP =
  '<svg class="ic-20" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">'
  + '<rect x="3.4" y="3.4" width="17.2" height="17.2" rx="5" stroke-width="2"></rect>'
  + '<rect x="8.6" y="8.6" width="6.8" height="6.8" rx="1.6" fill="currentColor" stroke="none"></rect></svg>';
