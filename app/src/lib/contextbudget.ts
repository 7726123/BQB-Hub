// 正文窗口（Waterline 常驻 prompt 的旧正文上限）：单位「字」。
//
// 口径（2026-09-26 三改，实测见交接文档 §13.51）：
//   窗口 = 能常驻的正文上限；超过它的 1.5 倍时，最旧的块滚入归档（原文保留、可被 BM25 回读）。
//   默认「自动」：由「模型可用上下文（token）」反推，不再写死 5 万字。
//
// 为什么不再写死（真 API 实测 + 成本建模）：
//   命中价 0.04、miss 价 2、输出 8（元/百万 token，实测小说散文 1.408 字/token）——
//   缓存里的文字比"新鲜注入"的便宜 50 倍。实测同一 prompt 再发一次命中 99.9%；
//   末尾追加命中 99.5%；**窗口左移（滚动那一刀）命中 0%**（整段正文按 miss 计费）。
//   所以「常驻正文尽量大、只用追加」是最优解：把整本书（100 万字）常驻，
//   总花费只比"5 万字窗口 + 每轮回读 3 千字"贵约 17%，但模型看到的是全书。
//   5 万字是"上下文只有 20 万 token"时代的遗留值，会让 100 万字的书滚 37 次、
//   每次都把 5.5 万字正文打成 miss（约 0.078 元/次），纯白扔。
export const CHARS_PER_TOKEN = 1.4;

// 模型可用上下文（token）：只用于算窗口，不参与请求。
// 默认 80 万 = 1M 上下文模型留边界（用户口径：1M 最好当 800k 用，防意外）。
export const MODEL_CONTEXT_DEFAULT = 800000;
export const MODEL_CONTEXT_MIN = 64000;
export const MODEL_CONTEXT_MAX = 2000000;

// 除正文外还要占 prompt 的部分（预设 + 主角 + 常驻角色 + 临时修订 + user 尾部）
export const CTX_MISC_CHARS = 20000;

// 0 = 自动（按模型上下文 + 本书世界书字号算）
export const STORY_WINDOW_AUTO = 0;
export const STORY_WINDOW_DEFAULT = STORY_WINDOW_AUTO;
export const STORY_WINDOW_MIN = 10000;
export const STORY_WINDOW_MAX = 1000000;
export const STORY_WINDOW_TRIGGER_RATIO = 1.5;

/** 夹取模型上下文（token）；非法值一律回默认 */
export function normalizeModelContext(v: unknown): number {
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return MODEL_CONTEXT_DEFAULT;
  if (n < MODEL_CONTEXT_MIN) return MODEL_CONTEXT_MIN;
  if (n > MODEL_CONTEXT_MAX) return MODEL_CONTEXT_MAX;
  return n;
}

/** 夹取到合法区间；0/空/非法值 = 自动 */
export function normalizeStoryWindow(v: unknown): number {
  if (v === null || v === undefined || v === '') return STORY_WINDOW_AUTO;
  const n = Math.floor(Number(v));
  if (!isFinite(n) || n <= 0) return STORY_WINDOW_AUTO;
  if (n < STORY_WINDOW_MIN) return STORY_WINDOW_MIN;
  if (n > STORY_WINDOW_MAX) return STORY_WINDOW_MAX;
  return n;
}

/**
 * 自动窗口：由模型可用上下文反推"能常驻多少正文"。
 * 触发线 = 窗口 × 1.5 才是真正塞进 prompt 的正文上限，所以这里先把预算当触发线、再除以 1.5。
 * 例（默认 80 万 token、世界书 10 万字）：(80万×1.4 − 10万 − 2万) ÷ 1.5 ≈ 66 万字，
 * 即正文常驻 66 万字、涨到 99 万字才滚一次 —— 都还在 80 万 token 预算内。
 */
export function windowFromContext(opts: { contextTokens?: unknown; worldBookChars?: unknown; miscChars?: number }): number {
  const ctx = normalizeModelContext(opts.contextTokens);
  const wb = Math.max(0, Math.floor(Number(opts.worldBookChars) || 0));
  const misc = Math.max(0, Math.floor(Number(opts.miscChars) || CTX_MISC_CHARS));
  const raw = ctx * CHARS_PER_TOKEN - wb - misc;
  if (!(raw > 0)) return STORY_WINDOW_MIN;
  const win = Math.floor(raw / STORY_WINDOW_TRIGGER_RATIO / 10000) * 10000;
  if (win < STORY_WINDOW_MIN) return STORY_WINDOW_MIN;
  if (win > STORY_WINDOW_MAX) return STORY_WINDOW_MAX;
  return win;
}

/** 滚动触发线：窗口的 1.5 倍（窗口 66 万字 → 99 万字触发归档） */
export function storyWindowTrigger(v: unknown): number {
  return Math.floor(normalizeStoryWindow(v) * STORY_WINDOW_TRIGGER_RATIO);
}

/** 字符数 → 估算 token（UI 显示用） */
export function estimateTokens(chars: number): number {
  const n = Number(chars) || 0;
  return Math.round(n / CHARS_PER_TOKEN);
}

/**
 * 归档回读要不要注入：只有正文真的滚进过归档（窗口左缘 x > 0）才需要。
 * 没滚过 = 全文都常驻在 prompt 里，再注入回读是重复内容；而回读走的是 miss 价
 * （命中价的 50 倍），每轮都按全价买 —— 纯亏。
 */
export function recallNeeded(archivedBlocks: unknown, windowX: unknown): boolean {
  return (Number(archivedBlocks) || 0) > 0 && (Number(windowX) || 0) > 0;
}

/** 估算 token 的「万字」显示（如 3.6） */
export function wanChars(chars: number): string {
  return ((Number(chars) || 0) / 10000).toFixed(1);
}
