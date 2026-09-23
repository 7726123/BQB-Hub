// 思考协议共用常量与工具（生成侧指令见 app/src/domain/app.ts 的 generate）。
//
// 背景：思维链长度没有上界（模型可以写上万字），所以"思考有没有闭合"绝不能用长度判定——
// 显式边界是唯一可靠的依据。协议要求模型：
//   ① 思考写在 `<thinking>…</thinking>`（或 `<!-- … -->`）；
//   ② `</thinking>` 独占一行闭合；
//   ③ 正文另起一行、以 `【正文】` 开头（只出现一次）。
// 本文件提供标记的查找/剥离，以及跨 chunk 的标记前缀扣留（网络分帧会把标记劈开）。
export const BODY_MARKER = '【正文】';

// 思考相关标记全集：跨 chunk 扣留时用来判断"尾巴是不是某个标记的前缀"
export const THINK_TOKENS = ['<!--', '<thinking>', '<think>', '</thinking>', '</think>', '-->', BODY_MARKER];

// 闭标记正则：容忍 `</think >`（> 前有空格）与大小写；`-->` 对应注释式思考
export const THINK_CLOSE_RE = /(-->|<\/think(?:ing)?\s*>)/i;

// 开标记正则：容忍 `<thinking >`（> 前有空格）与大小写
export const THINK_OPEN_RE = /<!--|<think(?:ing)?\s*>/i;

// 返回文本末尾"可能是某个标记前缀"的最长后缀（跨 chunk 扣留用，防止标记被分帧劈开后误判）。
// 无则返回 ''。完整标记不会被返回（完整标记应当被正常处理，而不是扣留）。
export function tailPartialToken(s: string, maxLen = 10): string {
  if (!s) return '';
  const tail = s.slice(Math.max(0, s.length - maxLen));
  for (let keep = tail.length; keep >= 1; keep--) {
    const cand = tail.slice(tail.length - keep);
    for (const t of THINK_TOKENS) {
      if (t.length > cand.length && t.startsWith(cand)) return cand;
    }
  }
  return '';
}

// 剥离正文起点的 `【正文】` 标记：只认"标记前全是空白"的位置（正文中间偶然出现的
// 【正文】四个字不动）；剥离后去掉紧随的空白/换行。
export function stripLeadingBodyMarker(s: string): string {
  const str = String(s || '');
  const head = str.slice(0, 24);
  const i = head.indexOf(BODY_MARKER);
  if (i < 0) return str;
  if (head.slice(0, i).trim() !== '') return str;
  return str.slice(i + BODY_MARKER.length).replace(/^\s+/, '');
}
