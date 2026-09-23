// SETTING_DELTA 标记的容错识别（纯函数，无依赖；settingsync 解析/剥离与 editor 流式过滤共用）。
// 模型漏抄模板时会写出变体：复数 SETTINGS_DELTA、误写 SERIES_DELTA、大小写混乱、
// 字母间插入空格或下划线、闭标记漏写斜杠——字面量匹配会整块漏剥、漏进正文。
// 统一识别规则：方括号内只由字母/下划线/空白组成、且以 DELTA 结尾（忽略大小写）。
// 中文正文不会出现这种形态，故容错匹配不会误伤正文。
const OPEN_SRC = '\\[\\s*[\\sA-Za-z0-9_\\-]*DELTA\\s*\\]';
const CLOSE_SRC = '\\[\\s*\\/\\s*[\\sA-Za-z0-9_\\-]*DELTA\\s*\\]';
const TAG_SRC = '\\[\\s*\\/?\\s*[\\sA-Za-z0-9_\\-]*DELTA\\s*\\]';

/** 开标记（非全局：exec 恒从头部搜索） */
export const DELTA_OPEN_RE = new RegExp(OPEN_SRC, 'i');
/** 闭标记（非全局） */
export const DELTA_CLOSE_RE = new RegExp(CLOSE_SRC, 'i');
/** 任意单标记（开/闭，含误写），用于残标记清理 */
export const DELTA_TAG_RE_G = new RegExp(TAG_SRC, 'gi');
/** 任一标记存在性判定（含漏闭的半截块入口——此时不该跳过剥离） */
export const DELTA_ANY_RE = new RegExp(TAG_SRC, 'i');
/** 完整块（开…闭，跨行惰性） */
export const DELTA_BLOCK_RE_G = new RegExp(OPEN_SRC + '[\\s\\S]*?' + CLOSE_SRC, 'gi');
export const DELTA_BLOCK_RE = new RegExp(OPEN_SRC + '[\\s\\S]*?' + CLOSE_SRC, 'i');
/** 半截块：开标记起至文末（配合 JSON 载荷判据决定删除范围） */
export const DELTA_HALF_RE = new RegExp(OPEN_SRC + '[\\s\\S]*$', 'i');
/** 末尾疑似「开标记前缀」（跨 chunk 被劈开）：`[` 起、其后仅 ASCII 字母/数字/下划线/连字符/空白 */
export const DELTA_PARTIAL_RE = /^\[\/?\s*[A-Za-z0-9_\s\-]*$/;

/**
 * 从字符串开头（跳过空白）解析一段 JSON 载荷，返回载荷结束位置的下标。
 * 用于剔除「漏写闭标记」的半截块，同时不误吞 JSON 之后可能存在的正文：
 * - 开头不是 `[` / `{` → 返回 -1（不是 JSON 载荷，调用方按「其后是正文」保守处理）
 * - 括号闭合平衡处 → 返回该处下标（其后文本保留）
 * - 括号未闭合（输出被截断）→ 返回字符串长度（整段删除）
 * 字符串字面量与转义按 JSON 规则处理，content 里的方括号/引号不会误判平衡。
 */
export function leadingJsonEnd(s: string): number {
  const str = String(s || '');
  let i = 0;
  while (i < str.length && /\s/.test(str[i])) i++;
  const first = str[i];
  if (first !== '[' && first !== '{') return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < str.length; i++) {
    const ch = str[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '[' || ch === '{') { depth++; continue; }
    if (ch === ']' || ch === '}') {
      depth--;
      if (depth <= 0) return i + 1;
    }
  }
  return str.length; // 未闭合：输出被截断，其后全是提议内容
}
