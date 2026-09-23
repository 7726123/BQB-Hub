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
// 挂载已移除（单 bundle 改造 P3-A）：api.ts 直接 import 本模块；modelcompat.js 产物停发
