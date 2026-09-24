// 模型能力判定（借鉴 @earendil-works/pi-ai 的 detectCompat/getCompat 思想，按需精简）。
// 纯函数模块：输入 endpoint/model → 输出"该模型该发什么参数"，供流式与非流式通道共用。
// 设计：detect 层按 endpoint 域名 + model 名前缀判定（新模型没登记也能兜底），
// override 层留待需要精确修正单模型时扩展（modelCompatibilityOverrides）。
// 当前覆盖能力点：思考档位 → 请求参数（见 resolveThinkingParams）。

// ---- 端点能力探测（域名判定） ----
export interface EndpointProfile {
  thinkingKind: 'none' | 'deepseek' | 'zai' | 'qwen' | 'openrouter' | 'anthropic';
  // 是否必须在 assistant 消息上带 reasoning_content 字段（deepseek 系协议要求）
  needsReasoningContentOnAssistant: boolean;
  // 工具结果（role=tool）后是否允许直接跟 user 消息（部分模型要求中间有 assistant 消息）
  requiresAssistantAfterToolResult: boolean;
  // system 提示是否用 developer role（o1/o3/gpt-5 等仅接受 developer；普通模型仅接受 system）
  supportsDeveloperRole: boolean;
}

export function detectEndpoint(endpoint: string): EndpointProfile {
  const ep = String(endpoint || '').toLowerCase();
  const isDeepseek = /deepseek\.com/.test(ep);
  const isZai = /z\.ai|bigmodel\.cn/.test(ep);
  const isQwen = /dashscope|aliyun|qwen/.test(ep);
  const isOpenRouter = /openrouter\.ai/.test(ep);
  const isAnthropic = /anthropic\.com/.test(ep);
  const isOpenAI = /api\.openai\.com/.test(ep);
  const isArk = /ark\.cn-beijing\.volces\.com/.test(ep);
  const isOpencode = /opencode\.ai/.test(ep);
  const isVolc = /volces\.com/.test(ep);
  const isMoonshot = /moonshot\.ai|api\.moonshot\./.test(ep);
  const isGrok = /x\.ai/.test(ep);
  const isNonStandard = isDeepseek || isZai || isQwen || isOpenRouter || isAnthropic ||
    isOpenAI || isArk || isOpencode || isVolc || isMoonshot || isGrok;
  // 需要显式禁用 thinking 的端点：多数 OpenAI 兼容端点不接受 thinking 参数，不盲发
  let thinkingKind: EndpointProfile['thinkingKind'] = 'none';
  if (isDeepseek) thinkingKind = 'deepseek';
  else if (isZai) thinkingKind = 'zai';
  else if (isQwen) thinkingKind = 'qwen';
  else if (isOpenRouter) thinkingKind = 'openrouter';
  else if (isAnthropic) thinkingKind = 'anthropic';
  return {
    thinkingKind,
    needsReasoningContentOnAssistant: isDeepseek,
    requiresAssistantAfterToolResult: isZai || isQwen || isMoonshot,
    supportsDeveloperRole: isOpenAI && !isNonStandard,
  };
}

// ---- 模型名判定 ----
function detectModelKind(modelId: string): {
  isDeepseekFamily: boolean; isZaiFamily: boolean; isQwenFamily: boolean;
  isOpenrouterFamily: boolean; isAnthropicFamily: boolean; isOpencodeFamily: boolean;
} {
  const m = String(modelId || '').toLowerCase();
  return {
    isDeepseekFamily: /deepseek|^ds\b/.test(m),
    isZaiFamily: /^glm|^zai|bigmodel|z\.ai/.test(m),
    isQwenFamily: /^qwen|^qwq/.test(m),
    isOpenrouterFamily: /^openrouter\//.test(m),
    isAnthropicFamily: /^claude|anthropic/.test(m),
    isOpencodeFamily: /opencode/.test(m),
  };
}

// ---- 思考档位 → 请求参数（四档 + 自动；通用策略 + 已知方言分派） ----
export type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high';

// 档位 → 请求体应追加的思考参数。
// 通用策略（对未知端点/模型也安全，配合 api.ts 的 400 降级重试）：
// - auto：什么都不发（模型默认行为，最安全；muse 等默认不吐 reasoning 但不会 400）
// - off：尝试禁用思考——deepseek/opencode 系发 thinking:{type:disabled}+reasoning_effort:none，
//        zai/anthropic 系发 thinking:{type:disabled}，qwen 系发 enable_thinking:false，
//        openrouter 发 reasoning:{effort:none}，其余尝试 thinking:{type:disabled}
// - low/medium/high：OpenAI 标准 reasoning_effort 字段（muse/deepseek/OpenAI 认）；
//        qwen 系映射 enable_thinking:true（无强度概念）；zai 系附 thinking:{type:enabled}
// 模型名判定优先于端点判定（同一网关下模型差异更大，如 openrouter 上跑 deepseek）。
export function resolveThinkingParams(level: ThinkingLevel, endpoint: string, modelId: string): Record<string, unknown> {
  if (level === 'auto') return {};
  const ep = detectEndpoint(endpoint);
  const mk = detectModelKind(modelId);
  const isDeepseekLike = mk.isDeepseekFamily || mk.isOpencodeFamily || ep.thinkingKind === 'deepseek';
  const isZaiLike = mk.isZaiFamily || ep.thinkingKind === 'zai';
  const isQwenLike = mk.isQwenFamily || ep.thinkingKind === 'qwen';
  const isOpenrouterLike = mk.isOpenrouterFamily || ep.thinkingKind === 'openrouter';
  const isAnthropicLike = mk.isAnthropicFamily || ep.thinkingKind === 'anthropic';
  // 保守：已知"纯 OpenAI 兼容"端点（api.openai.com / 未知端点）不确定是否接受 thinking 字段，
  // 但 OpenAI 官方对未知字段是忽略而非 400——统一走 reasoning_effort（OpenAI 标准），
  // 400 时由 api.ts 降级摘除。off 档对纯 OpenAI 端点用 reasoning_effort:'none'（o1/o3/gpt-5 官方语义）。
  if (level === 'off') {
    if (isDeepseekLike) return { thinking: { type: 'disabled' }, reasoning_effort: 'none' };
    if (isZaiLike) return { thinking: { type: 'disabled' } };
    if (isQwenLike) return { enable_thinking: false };
    if (isOpenrouterLike) return { reasoning: { effort: 'none' } };
    if (isAnthropicLike) return { thinking: { type: 'disabled' } };
    return { reasoning_effort: 'none' };
  }
  // low / medium / high
  const effort = level;
  if (isQwenLike) return { enable_thinking: true }; // qwen 无强度概念，开思考即可
  if (isOpenrouterLike) return { reasoning: { effort } };
  if (isDeepseekLike) return { thinking: { type: 'enabled' }, reasoning_effort: effort };
  if (isAnthropicLike) return { thinking: { type: 'enabled' } };
  return { reasoning_effort: effort };
}

// ---- 是否自带推理（reasoning_content）通道 ----
// 用途：写作端据此决定「要不要让模型把思维链写成正文」（两套机制叠加会把正文写进思维链、
// 甚至输出两遍）。2026-09-25 实测：火山方舟 coding 套餐里 doubao-seed-2-1-lite/pro、
// deepseek-v4-1-flash 都会回 reasoning_content（SSE 增量也是 reasoning_content），
// 所以 seed/doubao 系（以及 doubao-thinking）也要按"原生推理"处理——之前只认 deepseek/v3/v4 等，
// 导致 doubao-seed 走"文本思维链"模式，白送一遍 CoT。
export function hasNativeReasoning(modelId: string): boolean {
  const m = String(modelId || '').toLowerCase();
  return /deepseek|opencode|doubao|seed|ark\.|v3|v4|kimi|glm|qwen|moonshot|volc|dashscope/.test(m);
}

// ---- 消息协议兼容位 ----
export interface MessageCompat {
  needsReasoningContentOnAssistant: boolean;
  requiresAssistantAfterToolResult: boolean;
  supportsDeveloperRole: boolean;
}

export function resolveMessageCompat(endpoint: string, modelId: string): MessageCompat {
  const ep = detectEndpoint(endpoint);
  const mk = detectModelKind(modelId);
  return {
    needsReasoningContentOnAssistant:
      mk.isDeepseekFamily || (mk.isOpencodeFamily && !mk.isQwenFamily) || ep.needsReasoningContentOnAssistant,
    requiresAssistantAfterToolResult: ep.requiresAssistantAfterToolResult || mk.isZaiFamily || mk.isQwenFamily,
    supportsDeveloperRole: ep.supportsDeveloperRole,
  };
}

// 工具调用后追加的占位 assistant 消息（模型要求 user 不能紧跟 tool 结果）
export const TOOL_BRIDGE_ASSISTANT_TEXT = 'I have processed the tool results.';

// ---- 上游 4xx 的可读解释 ----
// 起因（2026-09-26）：火山方舟 coding 套餐（/api/coding/v3）只放行部分模型，
// 选到不在套餐里的模型时上游回 404 {"code":"UnsupportedModel","message":"The requested model
// does not support the coding plan..."}，App 只把英文原文抛出来，用户看到的是「端点受限」这种
// 猜不透的提示，反复以为是网络/CORS 问题。这里按上游错误码补一句中文，原文照旧保留在后面。
export function explainUpstreamError(status: number, bodyText: string): string {
  const t = String(bodyText || '');
  if (/UnsupportedModel/i.test(t)) return '（这个模型不在该端点/套餐里：请在渠道里换一个模型，或换回该端点支持的入口地址）';
  if (/InvalidEndpointOrModel/i.test(t)) return '（这个模型或入口地址该 key 没权限：核对端点地址与模型名是否搭配）';
  if (/model[^"]{0,24}(not found|does not exist|not exist)/i.test(t)) return '（模型名不被识别：检查模型 ID 拼写，或从端点支持的模型里选）';
  if (/InvalidParameter\.Model/i.test(t)) return '（模型参数不被接受：检查模型名与端点搭配）';
  if (status === 401) return '（API Key 无效或已过期；也请确认该端点接受 Authorization: Bearer 形式的密钥——Azure 系要 api-key、Anthropic 系要 x-api-key，本软件只发 Bearer）';
  if (status === 403) return '（该 key 无权访问这个模型/端点；或端点要求别的认证头形式）';
  if (status === 429) return '（请求过于频繁或额度已用尽）';
  return '';
}

// ---- 上下文超长（A 类：端点上下文小于本地窗口预算）----
// 为什么需要（2026-09-26）：窗口按「模型可用上下文」算，那个值是用户填的全局值（默认 80 万）。
// 换到小上下文渠道（128k/256k）后，小说写到一定长度请求就会超长，而上游回的是英文 400
// （"This model's maximum context length is N tokens..." / "input is too long" 等），
// 旧代码既不认识它、也没法自愈。这里把它认出来并抽出上限，供 api.ts 学进端点档案、窗口据此收窄。
const CONTEXT_OVERFLOW_RE = new RegExp([
  'maximum\\s+context\\s+length',
  'context[_ ]length[_ ]exceeded',
  'max(?:imum)?\\s+(?:input|prompt|context)\\s+(?:length|tokens?)',
  'input\\s+(?:is\\s+)?too\\s+long',
  'prompt\\s+(?:is\\s+)?too\\s+long',
  'too\\s+many\\s+(?:input\\s+)?tokens',
  'exceed(?:s|ed)?\\s+the\\s+(?:maximum\\s+)?(?:context|token)',
  'context\\s+(?:window|limit)',
  '上下文长度', '超出(?:最大)?(?:上下文|长度)', '输入(?:过长|太长)', '上下文(?:窗口|限制|上限)',
].join('|'), 'i');

/** 是否是"上下文超长"类报错（这类不该走参数降级阶梯，也抽不出可摘的参数） */
export function isContextOverflowError(bodyText: string): boolean {
  return CONTEXT_OVERFLOW_RE.test(String(bodyText || ''));
}

/**
 * 从上下文超长报错里抽出端点的上下文上限（token）。抽不到返回 0。
 * 例："This model's maximum context length is 131072 tokens." → 131072
 *     "maximum context length is 262144 tokens, however your messages resulted in 300000" → 262144
 */
export function parseContextOverflowCap(bodyText: string): number {
  const t = String(bodyText || '');
  if (!isContextOverflowError(t)) return 0;
  const cands: number[] = [];
  const push = (s: string | undefined) => { const n = parseInt(String(s || '').replace(/[,_ ]/g, ''), 10); if (n >= 2000 && n <= 40000000) cands.push(n); };
  let m: RegExpExecArray | null;
  // ① 明确说上限的句式：maximum context length is N / max context N / 上限 N
  const re1 = /(?:maximum\s+context\s+length|max(?:imum)?\s+(?:context|input|prompt)\s+(?:length|tokens?|limit)|context\s+(?:window|limit)|上下文(?:长度|窗口)?(?:上限)?|最多)\D{0,12}([0-9][0-9,_]{3,12})/gi;
  while ((m = re1.exec(t)) !== null) push(m[1]);
  // ② 中文/英文"上限为 N token"变体：limit of N / up to N tokens
  const re2 = /(?:limit\s+of|up\s+to|at\s+most|不超过|上限为?)\D{0,8}([0-9][0-9,_]{3,12})\s*(?:tokens?)?/gi;
  while ((m = re2.exec(t)) !== null) push(m[1]);
  if (cands.length > 0) return Math.min.apply(null, cands);
  // ③ 抽不到：兜底从全部大数字里取最小的（"resulted in 300000 tokens" 这类大数不会是上限）
  const all: number[] = [];
  const re3 = /\b([0-9]{5,9})\b/g;
  while ((m = re3.exec(t)) !== null) {
    const n = parseInt(m[1], 10);
    if (n >= 8000 && n <= 40000000) all.push(n);
  }
  return all.length ? Math.min.apply(null, all) : 0;
}

/**
 * 上下文超长的用户提示 + 自愈说明（窗口已按学到的上限收窄，重试即可）。
 * capTokens 为 0（没抽到上限）时只给通用建议。
 */
export function contextOverflowHint(capTokens: number): string {
  const cap = Number(capTokens) || 0;
  let tail = '请调小「模型可用上下文」或「正文窗口」，也可以换上下文更大的模型。';
  if (cap > 0) {
    // 与 windowFromContext 同一套算式（窗口 =(上限 × 字/token − 杂项) ÷ 1.5，正文最多 = 窗口 × 1.5），
    // 让这里的数字与设置页提示行里的"最多 X 万"完全对得上。
    const win = Math.floor(((cap * 1.4 - 20000) / 1.5) / 10000) * 10000;
    const trig = win * 1.5;
    tail = '已把该端点的上限记成 ' + cap + ' token，正文最多将收到约 ' + (trig / 10000).toFixed(0) + ' 万字——再发送一次即可。';
  }
  return '（输入超出该端点的上下文上限：' + tail + '）';
}
// 挂载已移除（单 bundle 改造 P3-A）：api.ts 直接 import 本模块；modelcompat.js 产物停发
