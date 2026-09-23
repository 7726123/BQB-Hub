// 正文窗口（Waterline 常驻 prompt 的旧正文上限）：单一用户设置，单位「字」。
//
// 旧口径是「模型上下文 tokens × 每 token 字符数」再取 50% 当窗口——默认 256k × 1.4 会算出
// 17.9 万字窗口：每次续写光正文就喂 ≈12.8 万 token，加上世界书（10 万字）+ 回读（3 万字）
// 合计 ≈22 万 token；而用户填的 tokens 往往不是模型的真实窗口（填大了直接 400）。
// 现在只让用户对一个数负责：窗口多大。触发线固定为窗口的 1.5 倍，超出即把最旧块滚入归档
// （原文保留、可被 BM25 回读召回），窗口回落到设定值。
export const STORY_WINDOW_DEFAULT = 50000; // 5 万字 ≈ 3.6 万 token
export const STORY_WINDOW_MIN = 10000;
export const STORY_WINDOW_MAX = 500000;
export const STORY_WINDOW_TRIGGER_RATIO = 1.5;

// 中文平均每 token 承载的字符数（仅用于 UI 上的 token 估算显示，不再让用户填）
export const CHARS_PER_TOKEN = 1.4;

/** 夹取到合法区间；非法值（NaN/0/负数/超大）一律回默认值 */
export function normalizeStoryWindow(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return STORY_WINDOW_DEFAULT;
  if (n < STORY_WINDOW_MIN) return STORY_WINDOW_MIN;
  if (n > STORY_WINDOW_MAX) return STORY_WINDOW_MAX;
  return n;
}

/** 滚动触发线：窗口的 1.5 倍（窗口 5 万字 → 7.5 万字触发归档） */
export function storyWindowTrigger(v: unknown): number {
  return Math.floor(normalizeStoryWindow(v) * STORY_WINDOW_TRIGGER_RATIO);
}

/** 字符数 → 估算 token（UI 显示用） */
export function estimateTokens(chars: number): number {
  const n = Number(chars) || 0;
  return Math.round(n / CHARS_PER_TOKEN);
}

/** 估算 token 的「万字」显示（如 3.6） */
export function wanChars(chars: number): string {
  return ((Number(chars) || 0) / 10000).toFixed(1);
}
