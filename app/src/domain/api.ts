// APIHandler：OpenAI 兼容流式客户端（迁移自 www/modules/api.js）。
// 能力：SSE 流式（含尾帧兜底）、深度思考通道（reasoning 多格式兼容）、工具调用增量拼装、
// 指数退避重试（网络瞬时错误/5xx）、空闲超时、本地 CORS 代理（火山方舟 coding 端点）、
// usage 记账（cached_tokens + 按价格表估算成本）。
//
// 模型兼容判定（thinking 禁用参数 / developer role / reasoning_content 占位 /
// tool 结果后插 assistant）统一走 ./modelcompat（借鉴 pi-ai detectCompat 的按需精简版）。
// 单 bundle 改造 P3-A：modelcompat 为无副作用纯函数模块，直接 import（原独立 IIFE 全局协议废弃，
// 全局挂载已移除，见 modelcompat.ts 尾部注释）。
import * as ModelCompatAgg from './modelcompat';
export interface ChatMessage { role: string; content: string }
export interface ToolCallParsed { id: string; name: string; arguments: Record<string, unknown>;
  // arguments 非法 JSON 时的解析错误原文（消费方应把它作为失败结果回传给模型自愈，
  // 而不是当作「缺少参数」——模型看不到根因会原样重试坏转义）
  argsError?: string }

// 工具调用历史（assistant 侧）：带调用与可选推理占位字段（deepseek 系协议要求）
export interface ToolCallInvocation {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  reasoningContent?: string;
}
export interface ChatToolMessage {
  role: 'tool';
  content: string;
  tool_call_id: string;
}
// 供调用方声明"该轮 assistant 是否输出过原生推理通道"（fetchCompletions 内部如需
// 在 assistant 消息补 reasoning_content 占位，需此标记决定是否保留空串）。
export type OutgoingChatMessage = ChatMessage | ChatToolMessage | (ChatMessage & { tool_calls?: ToolCallInvocation[]; reasoning_content?: string });

export interface FetchOverrides {
  apiConfig?: Record<string, unknown>;
  timeout?: number;
  idleTimeout?: number;
  temperature?: number;
  maxTokens?: number;
  tools?: unknown[];
  toolChoice?: unknown;
  callLabel?: string;
  onToolCallStart?: () => void;
  onTools?: (calls: ToolCallParsed[]) => void;
  // 流结束原因透出（'stop'|'length'|'tool_calls'|string|null）：文本被 max_tokens 截断时调用方可见
  onFinishReason?: (reason: string | null) => void;
  // 深度思考（reasoning_content 等多格式）流式增量回调：写卡端实时显示思维链用
  onReasoning?: (chunk: string) => void;
}

export interface ApiCallLog {
  label: string;
  time?: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cost?: number;
  usageMissing?: boolean;   // 这次请求端点没回 usage（token 记 0）：用量页会提示"本轮未取到用量"
}

// 默认输出上限（"不限制"）：项目不再提供 max_tokens 设置项，一律按各端能接受的最大值发送。
// 65535 覆盖市面绝大多数模型的输出上限；端点若拒绝（报 too large / 值域错误），
// 由下面的降级阶梯逐级下调（65535→32768→16384→8192→4096→2048）并按端点记住，
// 而不是把参数整个摘掉——摘掉等于回落到端点默认（常见 4096 甚至更小），输出反而更短。
export const DEFAULT_MAX_TOKENS = 65535;
// 输出上限下调阶梯（值域被拒时使用；到 2048 以下不再降）
const _MAX_TOKENS_STEPS = [65535, 32768, 16384, 8192, 4096, 2048];
export function nextMaxTokensStep(cur: number): number {
  for (const s of _MAX_TOKENS_STEPS) if (s < cur) return s;
  return cur > 1024 ? Math.floor(cur / 2) : cur;
}

// 本地 CORS 代理端口（与 Android 内置 LocalProxyServer 配套）：
// 优先 window.__PROXY_PORT__（Java 注入），无代理环境返回 0（保持直连）。
export function pickProxyPort(): number {
  try {
    const w = globalThis as unknown as { __PROXY_PORT__?: unknown };
    const p = typeof w.__PROXY_PORT__ === 'number' ? w.__PROXY_PORT__ : 0;
    return p > 0 ? p : 0;
  } catch (e) { return 0; }
}

// 纯函数：给定原始 https endpoint URL，返回应请求的 URL（有本地代理端口则改写为 localhost 转发）。
// 仅改写 https；http 端点保持直连（LocalProxyServer 只直连 443）。
export function pickProxyUrl(rawUrl: string, proxyPort: number): string {
  if (proxyPort > 0 && /^https:\/\//i.test(rawUrl)) {
    return rawUrl.replace(/^https:\/\//, 'http://127.0.0.1:' + proxyPort + '/');
  }
  return rawUrl;
}

// 页面是否可见（无 document 的测试/Node 环境按"可见"处理）。
// 后台不计时全靠它：可见时才推进超时预算。
export function pageVisible(): boolean {
  try {
    if (typeof document === 'undefined' || !document.visibilityState) return true;
    return document.visibilityState === 'visible';
  } catch (e) { return true; }
}

// 可见时长账本（纯逻辑，可注入时间）：只累计"页面可见"的那部分时间。
// 用途见 fetchCompletions：切后台期间不消耗超时预算，避免回到前台被误判超时。
export function createVisibleBudget(start: number, visible: boolean) {
  let acc = 0;      // 之前各段可见时长之和
  let since = start; // 本段可见的起点
  let vis = visible;
  return {
    visible(): boolean { return vis; },
    // 已累计的可见时长（含当前这一段）
    elapsed(now: number): number { return acc + (vis ? Math.max(0, now - since) : 0); },
    // 隐藏：结算当前段
    hide(now: number): number { if (vis) { acc += Math.max(0, now - since); vis = false; } return acc; },
    // 可见：起新的一段
    show(now: number): number { if (!vis) { since = now; vis = true; } return since; },
  };
}

// 端点地址净化 + 归一化：实现移到了 lib/endpoint.ts（app.ts 也要用同一套逻辑，避免两份），
// 这里 import 进来自己用，同时原样再导出，既有调用方不受影响。
import { sanitizeEndpointUrl, chatCompletionsUrl, modelsUrl } from '../lib/endpoint';
export { sanitizeEndpointUrl, chatCompletionsUrl, modelsUrl };

// 代理端口统一解析：window.__PROXY_PORT__（Java 注入，每次 Activity 创建时刷新）
// → localStorage __proxyPort（**原生侧为"页面内重载"持久化的那一份**，见下）
// → URL ?proxy=（桌面浏览器调试）→ localStorage devProxyPort（旧调试约定）。
//
// 为什么要读 __proxyPort（2026-09-26 修）：热更新是"换资源目录 + 页面内重载"，不会重建 Activity，
// MainActivity 注入的 window.__PROXY_PORT__ 随之丢失；原生侧早就把端口写进 localStorage('__proxyPort')
// 作为兜底，但这里此前读的键名是 devProxyPort（不一致）→ 兜底永远不生效 → 重载后所有请求绕过本地代理
// 直连，遇到不放行 Authorization 的 CORS 端点（火山方舟 coding）就报「端点跨域受限」。
export function resolveProxyPort(): number {
  let _urlProxy = 0;
  try { _urlProxy = parseInt(new URLSearchParams((typeof location !== 'undefined' && location.search) || '').get('proxy') || '0', 10) || 0; } catch (e) { /* ignore */ }
  try {
    const _ls = (typeof localStorage !== 'undefined') ? localStorage : null;
    const _persisted = _ls ? (parseInt(_ls.getItem('__proxyPort') || '0', 10) || 0) : 0;
    const _dev = _ls ? (parseInt(_ls.getItem('devProxyPort') || '0', 10) || 0) : 0;
    return pickProxyPort() || _persisted || _urlProxy || _dev;
  } catch (e) { return pickProxyPort() || _urlProxy; }
}

// 接口失败链路留档（走服务端 client_logs）：记"端点主机 + 模型 + 代理端口 + 是否被改写成代理地址 +
// 上游状态 + 报错头"，**不含 API Key**（Bearer 一律打码）。为什么要有：方舟 coding 这类端点的失败原因
// 常常只在客户端可见（CORS / 本地代理没生效 / 套餐不含该模型），用户描述成"端点受限"，靠猜要来回好几轮。
function _apiFailLog(label: string, status: number, body: string): void {
  try {
    const g = globalThis as any;
    if (!g.ClientLog || !g.ClientLog.note) return;
    let ep = '', model = '';
    try {
      const cfg = (g.PresetManager && g.PresetManager.getActiveAPIConfig && g.PresetManager.getActiveAPIConfig()) || {};
      ep = String(cfg.endpoint || ''); model = String(cfg.model || '');
    } catch (e) { /* 拿不到配置就留空 */ }
    let host = ep;
    try { host = new URL(ep).host || ep; } catch (e) { /* 非法地址保留原文 */ }
    const pp = resolveProxyPort();
    const willProxy = !!(pp && /^https:\/\//i.test(ep));
    const detail = String(body || '').replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/\s+/g, ' ').slice(0, 180);
    g.ClientLog.note('接口', label + ' 失败 | 端点 ' + (host || '(空)') + ' | 模型 ' + (model || '(空)') +
      ' | 代理端口 ' + (pp || 0) + (willProxy ? '(改写)' : '(直连)') +
      ' | 状态 ' + (status || '网络层') + ' | ' + detail);
  } catch (e) { /* 留档失败绝不影响报错 */ }
}

// ---- 模型兼容判定（modelcompat 纯函数模块，直接 import，见文件头） ----
function _mc(): any {  return ModelCompatAgg;
}
// 运行时安全获取：探测/兼容函数可能未加载（测试环境等）时返回合理默认
function _resolveMessageCompat(ep: string, model: string): any {
  const mc = _mc();
  return mc && mc.resolveMessageCompat ? mc.resolveMessageCompat(ep, model)
    : { needsReasoningContentOnAssistant: false, requiresAssistantAfterToolResult: false, supportsDeveloperRole: false };
}
function _resolveThinkingParams(level: string, ep: string, model: string): Record<string, unknown> {
  const mc = _mc();
  return mc && mc.resolveThinkingParams ? mc.resolveThinkingParams(level, ep, model) : {};
}
function _toolBridgeAssistantText(): string {
  const mc = _mc();
  return mc && mc.TOOL_BRIDGE_ASSISTANT_TEXT ? mc.TOOL_BRIDGE_ASSISTANT_TEXT : 'I have processed the tool results.';
}

// 读取思考档位（'auto'|'off'|'low'|'medium'|'high'），兼容旧 boolean（true→auto 保持原行为，false→off）
/** 数值或默认值：只有"取不到数"（undefined/null/''/非数字）才用默认——0 是合法值（惩罚项 0） */
function _numOr(v: unknown, d: number): number {
  if (v === undefined || v === null || v === '') return d;
  const n = parseFloat(String(v));
  return isFinite(n) ? n : d;
}

function _thinkingLevelFromConfig(cfgVal: unknown): string {
  if (cfgVal === undefined || cfgVal === null) return 'auto';
  if (typeof cfgVal === 'boolean') return cfgVal ? 'auto' : 'off';
  const s = String(cfgVal);
  if (s === 'off' || s === 'low' || s === 'medium' || s === 'high') return s;
  if (s === '0' || s === 'false') return 'off';
  return 'auto'; // 未知/旧 true 语义 → auto（保持"不干预模型"的默认）
}

// ---- 消息标准化：把调用方宽松构造的消息（assistant 可同时带 content+tool_calls、
// 带 reasoning/reasoningLive、tool 结果后直接跟 user）统一成 OpenAI 服务端要的形态。
// 规则（借鉴 pi-ai convertMessages 的按需精简）：
// 1) 保留多条 system（不合并），丢弃空 system；
// 2) 一条 assistant 要么 content 要么 tool_calls（content 有值时拆出独立 tool_calls 消息）；
//    assistant 历史若带 reasoning/reasoningLive（deepseek 原生思考）→ 转成 reasoning_content 占位字段；
//    需要占位且没有 → 补 reasoning_content:''（部分模型要求 assistant 必须带）；
// 3) tool 消息后不允许直接跟 user（zai/qwen/moonshot 等）→ 插入占位 assistant；
// 4) 纯空白消息丢弃（服务端会 400）。 ----
export function normalizeOutgoingMessages(messages: any[], compat: any): any[] {
  const out: any[] = [];
  // 上一轮是否有 tool 结果（用于判断是否需要插 assistant 桥）
  let lastHadToolResult = false;
  const needsRC = !!(compat && compat.needsReasoningContentOnAssistant);
  const needsBridge = !!(compat && compat.requiresAssistantAfterToolResult);
  const useDeveloperRole = !!(compat && compat.supportsDeveloperRole);
  let developerApplied = false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] || {};
    const role = m.role;
    if (role === 'system') {
      if (m.content && String(m.content).trim()) {
        // o1/o3/gpt-5 等只接受 developer role（openai 原生端点）：第一条 system 转 developer，其余保持 system
        const isFirstSystem = !developerApplied && !out.some((x: any) => x.role === 'system' || x.role === 'developer');
        if (useDeveloperRole && isFirstSystem) { developerApplied = true; out.push({ role: 'developer', content: String(m.content) }); }
        else out.push({ role: 'system', content: String(m.content) });
      }
      continue;
    }
    if (role === 'tool') {
      const tcId = m.tool_call_id;
      if (tcId) {
        out.push({ role: 'tool', tool_call_id: String(tcId), content: String(m.content == null ? '' : m.content) });
        lastHadToolResult = true;
      }
      continue;
    }
    if (role === 'assistant') {
      // 提取文本（支持 content 字符串或 content 数组的 text 块）
      let text = '';
      if (typeof m.content === 'string') text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content.map((b: any) => (b && b.type === 'text' ? b.text : '')).join('');
      }
      const tcs = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      // 推理文本（deepseek 原生思考/兼容思考占位）——来自历史消息的 reasoning/reasoningLive
      const reasoningText = (typeof m.reasoning === 'string' && m.reasoning.trim()) ? m.reasoning
        : ((typeof m.reasoningLive === 'string' && m.reasoningLive.trim()) ? m.reasoningLive : '');
      // 纯空白 & 无 tool_calls → 丢弃
      if (!text.trim() && tcs.length === 0 && !reasoningText && !needsRC) continue;
      const hasText = !!text.trim();
      const hasTools = tcs.length > 0;
      if (hasText && hasTools) {
        // 拆成两条：纯文本 assistant + 纯 tool_calls assistant
        out.push({ role: 'assistant', content: text });
        out.push({ role: 'assistant', content: null, tool_calls: tcs.map(normalizeToolCall) });
      } else if (hasTools) {
        out.push({ role: 'assistant', content: null, tool_calls: tcs.map(normalizeToolCall) });
      } else if (hasText) {
        const msg: any = { role: 'assistant', content: text };
        if (needsRC && reasoningText) msg.reasoning_content = reasoningText;
        else if (needsRC) msg.reasoning_content = '';
        out.push(msg);
      } else {
        // 只有推理/占位：给 content 空串 + reasoning_content（若有）
        const msg: any = { role: 'assistant', content: '' };
        if (needsRC && (reasoningText || true)) msg.reasoning_content = reasoningText || '';
        out.push(msg);
      }
      lastHadToolResult = false;
      continue;
    }
    if (role === 'user') {
      // tool 结果后直接跟 user：部分模型要求中间有 assistant 消息
      if (needsBridge && lastHadToolResult) {
        out.push({ role: 'assistant', content: _toolBridgeAssistantText() });
      }
      out.push({ role: 'user', content: typeof m.content === 'string' ? m.content : String(m.content || '') });
      lastHadToolResult = false;
      continue;
    }
    // 未知 role：原样透传（保底）
    out.push(m);
  }
  return out;
}
function normalizeToolCall(t: any): any {
  if (!t || typeof t !== 'object') return { type: 'function', function: { name: '', arguments: '{}' } };
  // 兼容两种形态：{name, arguments} 与 {function:{name, arguments}}
  const fn = t.function || {};
  const name = t.name || fn.name || '';
  const rawArgs = t.arguments !== undefined ? t.arguments : fn.arguments;
  let argsStr = '{}';
  if (typeof rawArgs === 'string') argsStr = rawArgs;
  else if (rawArgs && typeof rawArgs === 'object') { try { argsStr = JSON.stringify(rawArgs); } catch (e) { argsStr = '{}'; } }
  return { id: t.id, type: 'function', function: { name, arguments: argsStr } };
}

// ==================== 端点能力档案（按 endpoint|model 学习；同一个坑只踩一次）====================
export interface EndpointProfile {
  drop?: string[];                  // 该端点拒绝过的请求参数（后续请求不再发送）
  useMaxCompletionTokens?: boolean; // 该端点要求 max_completion_tokens（OpenAI o 系 / gpt-5）
  usageUnavailable?: boolean;       // stream_options 被拒 → 流式用量不可用
  toolsUnsupported?: boolean;       // tools / tool_choice 被拒 → 该端点不支持工具调用
  thinkingOverride?: Record<string, string>; // 端点只接受特定取值的思考参数（如 reasoning_effort:'low'）
  maxTokensCap?: number;            // 该端点接受的输出上限（报"太大"时学到；发送前取 min）
  contextCap?: number;              // 该端点接受的上下文上限（token；报"上下文超长"时学到；Windows 预算取 min）
}

function _profileKey(endpoint: string, model: string): string {
  const raw = String(endpoint || '') + '|' + String(model || '');
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return 'endpointProfile_' + Math.abs(h);
}

export function readEndpointProfile(endpoint: string, model: string): EndpointProfile {
  try {
    const sm = (globalThis as any).StorageManager;
    const p = sm && sm.get ? sm.get(_profileKey(endpoint, model), null) : null;
    return (p && typeof p === 'object') ? (p as EndpointProfile) : {};
  } catch (e) { return {}; }
}

/** 该端点学到的上下文上限（token；0 = 不知道）。app.ts 算正文窗口时用它收窄预算。 */
export function contextCapFor(endpoint: unknown, model: unknown): number {
  try {
    const p = readEndpointProfile(String(endpoint || ''), String(model || ''));
    const n = Number(p.contextCap) || 0;
    return (n >= 2000 && n <= 40000000) ? n : 0;
  } catch (e) { return 0; }
}

function _saveEndpointProfile(endpoint: string, model: string, learned: string[], delta: EndpointProfile): void {
  try {
    const sm = (globalThis as any).StorageManager;
    if (!sm || !sm.set) return;
    const cur = readEndpointProfile(endpoint, model);
    const drop = new Set<string>(cur.drop || []);
    for (const k of learned) drop.add(k);
    const next: EndpointProfile = { ...cur, drop: Array.from(drop) };
    if (delta.useMaxCompletionTokens || cur.useMaxCompletionTokens) next.useMaxCompletionTokens = true;
    if (delta.maxTokensCap || cur.maxTokensCap) {
      next.maxTokensCap = Math.min(delta.maxTokensCap || Number.MAX_SAFE_INTEGER, cur.maxTokensCap || Number.MAX_SAFE_INTEGER);
    }
    if (delta.usageUnavailable || cur.usageUnavailable) next.usageUnavailable = true;
    if (delta.toolsUnsupported || cur.toolsUnsupported) next.toolsUnsupported = true;
    if (delta.thinkingOverride || cur.thinkingOverride) next.thinkingOverride = { ...(cur.thinkingOverride || {}), ...(delta.thinkingOverride || {}) };
    // 上下文上限：学到的更小值才收窄（端点/套餐改大时不自动放宽，避免来回抖动；用户可清档案重置）
    if (delta.contextCap || cur.contextCap) {
      next.contextCap = Math.min(delta.contextCap || Number.MAX_SAFE_INTEGER, cur.contextCap || Number.MAX_SAFE_INTEGER);
    }
    sm.set(_profileKey(endpoint, model), next);
  } catch (e) { /* 档案写入失败不影响请求本身 */ }
}

// 可降级参数名单（出现在请求体里才可能被摘）
const _DROPPABLE_PARAMS = ['max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'top_k', 'min_p',
  'presence_penalty', 'frequency_penalty', 'repetition_penalty', 'stream_options', 'tools', 'tool_choice',
  'thinking', 'reasoning_effort', 'enable_thinking', 'reasoning'];

// 思考参数：取值被端点拒绝时应"降到允许的最小档"而不是摘掉——
// 摘掉参数 = 端点按默认（往往是思考全开）跑；实测 deepseek-v4.1-flash 在 6000 token 预算下
// 把 token 全花在 reasoning 上（正文 0 字、finish_reason=length），填表/摘要类调用直接失败。
const _THINKING_PARAMS = ['thinking', 'reasoning_effort', 'enable_thinking', 'reasoning'];
// 从"最想关掉思考"到"思考最强"排序，取端点允许集合里最靠前的一个
const _THINKING_VALUE_PREF = ['none', 'disabled', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
// 报错文本含这些词 = "参数名合法、取值非法"（区别于 unknown parameter / not supported）
const _ENUM_ERR_RE = /invalid option|invalid value|unsupported value|expected one of|must be one of|supported values? (?:are|is)|allowed values?/i;

// 从错误文本里收集候选取值：带引号的词 + "one of / values are" 后面的裸词列表
function _allowedValuesIn(errText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (v: string) => {
    const s = String(v || '').trim().toLowerCase();
    if (!s || seen.has(s)) return;
    seen.add(s); out.push(s);
  };
  for (const m of errText.matchAll(/["'`‘’“”]([a-z_][a-z0-9_-]{0,15})["'`‘’“”]/gi)) add(m[1]);
  const tail = errText.match(/(?:one of|values? (?:are|is)|allowed values?)\s*[:：]?\s*([^\n.。]{0,120})/i);
  if (tail && tail[1]) for (const m of tail[1].matchAll(/[a-z_][a-z0-9_-]{1,15}/gi)) add(m[0]);
  return out;
}

// 允许集合里的最小思考档（取不到返回空串 → 调用方回退摘除）
function _minThinkingValue(allowed: string[]): string {
  for (const p of _THINKING_VALUE_PREF) if (allowed.indexOf(p) >= 0) return p;
  return '';
}

export interface RejectedParamAct { key: string; action: 'drop' | 'rename_max_tokens' | 'set_value' | 'clamp_max_tokens'; value?: string }

// 报错文本形态判别：参数名合法但取值/大小不合法（区别于 unknown parameter / not supported）
const _UNKNOWN_PARAM_RE = /unsupported|unknown parameter|unrecognized|unexpected|invalid[_ ]parameter|no such parameter|not supported|isn't supported|不支持|未知参数/i;
const _SIZE_ERR_RE = /too large|too long|too many|exceed|greater than|less than|at most|at least|out of range|must be|maximum|max_|limit|超出|不能超过|最大/i;

/**
 * 从报错文本里取端点允许的输出上限（token 数）。取窗口内最小的合理数字——
 * 典型形态 `max_tokens is too large: 65535, maximum is 8192` 里两个数都在，小的那个才是允许值。
 * 取不到返回 0（调用方改用下调阶梯）。
 */
export function parseMaxTokensCap(errText: string): number {
  const txt = String(errText || '');
  const i = txt.search(/max_?(?:completion_)?tokens?/i);
  if (i < 0) return 0;
  const win = txt.slice(i, i + 260);
  let best = 0;
  for (const m of win.matchAll(/\b(\d{2,8})\b/g)) {
    const n = parseInt(m[1], 10);
    if (n < 256 || n > 2000000) continue;
    if (!best || n < best) best = n;
  }
  return best;
}

/**
 * 解析 400/422 错误文本 → 要处理的参数动作。覆盖主流网关措辞：
 *   Unsupported parameter: 'X' / Unsupported value: 'X' / unknown parameter "X" /
 *   X is not supported / Unrecognized request argument supplied: X / 不支持的参数: X
 * 取值非法（枚举报错）且是本项目主动发起的思考参数时，改为"降到允许的最小档"（set_value）。
 * 无法定位任何参数时返回 []（调用方回退到"摘思考参数"，与旧行为一致）。
 */
export function parseRejectedParams(errText: string, body: Record<string, unknown>): RejectedParamAct[] {
  const txt = String(errText || '');
  const lower = txt.toLowerCase();
  const out: RejectedParamAct[] = [];
  const seen = new Set<string>();
  const enumErr = _ENUM_ERR_RE.test(txt);
  const allowed = enumErr ? _allowedValuesIn(txt) : [];
  // 候选参数名：显式 param 字段 → 引号词 → 错误文本里直接点名的已知参数（保持原有优先级）
  const named: string[] = [];
  const pm = txt.match(/"param"\s*:\s*"([a-z_][a-z0-9_]{1,40})"/i);
  if (pm) named.push(pm[1]);
  const quoted = txt.match(/['"`‘’]([a-z_][a-z0-9_]{1,40})['"`‘’]/gi) || [];
  for (const q of quoted) named.push(q.replace(/['"`‘’]/g, ''));
  for (const k of _DROPPABLE_PARAMS) if (new RegExp('(^|[^a-z0-9_])' + k + '([^a-z0-9_]|$)', 'i').test(lower)) named.push(k);
  for (const rawKey of named) {
    const key = String(rawKey || '').toLowerCase();
    if (!key || seen.has(key) || !(key in body)) continue;
    seen.add(key);
    if (key === 'max_tokens' || key === 'max_completion_tokens') {
      // 值域报错（too large / maximum / must be…）→ 下调数值重试，而不是改名或摘除：
      // 摘掉参数 = 端点按自己的默认（常见 4096）跑，输出反而更短。
      if (_SIZE_ERR_RE.test(txt) && !_UNKNOWN_PARAM_RE.test(txt)) {
        out.push({ key, action: 'clamp_max_tokens', value: String(parseMaxTokensCap(txt) || 0) });
        continue;
      }
      // 参数名不被接受：max_tokens → max_completion_tokens（OpenAI o 系 / gpt-5）；
      // 已经叫 max_completion_tokens 还是被拒 → 只能摘掉
      if (key === 'max_tokens') { out.push({ key, action: 'rename_max_tokens' }); continue; }
      out.push({ key, action: 'drop' });
      continue;
    }
    if (enumErr && _THINKING_PARAMS.indexOf(key) >= 0) {
      const cur = body[key];
      // 只处理字符串取值：thinking 的对象方言（{type:'disabled'}）形状不确定，保守走摘除
      if (typeof cur === 'string') {
        const v = _minThinkingValue(allowed);
        if (v && cur.toLowerCase() !== v) { out.push({ key, action: 'set_value', value: v }); continue; }
      }
    }
    out.push({ key, action: 'drop' });
  }
  return out;
}

// 把档案里学到的结果应用到请求体（在发送前调用）
function _applyProfileToBody(body: Record<string, unknown>, profile: EndpointProfile): void {
  for (const k of profile.drop || []) { delete body[k]; }
  if (profile.useMaxCompletionTokens && 'max_tokens' in body) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  // 输出上限：档案里学到的端点上限优先（同一个 400 只踩一次）
  if (profile.maxTokensCap) {
    for (const k of ['max_tokens', 'max_completion_tokens']) {
      const v = body[k];
      if (typeof v === 'number' && v > profile.maxTokensCap) body[k] = profile.maxTokensCap;
    }
  }
  if (profile.toolsUnsupported) { delete body.tools; delete body.tool_choice; }
  // 端点只接受特定取值（如 reasoning_effort 只认 low..max）：只在请求体里已有该参数时替换取值
  if (profile.thinkingOverride) {
    for (const k of Object.keys(profile.thinkingOverride)) {
      if (k in body) body[k] = profile.thinkingOverride[k];
    }
  }
}

/**
 * 非 SSE 响应的内容提取（整段 JSON / NDJSON 行）：
 * - OpenAI 兼容：choices[0].delta.content / choices[0].message.content
 * - Ollama 原生：message.content（新）/ response（旧）
 */
export function pickNonSseContent(j: any): { content?: string; reasoning?: string } {
  if (!j || typeof j !== 'object') return {};
  const out: { content?: string; reasoning?: string } = {};
  const d = (j.choices && j.choices[0] && (j.choices[0].delta || j.choices[0].message)) || null;
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || null;
  if (d && typeof d.content === 'string' && d.content) out.content = d.content;
  // 深度思考通道（与流式同一套字段阶梯）：reasoning_content / reasoning / thinking / thought / analysis。
  // 用户实测（commandcode 端点，2026-09-25）：网关把思考放在 message.reasoning 里，以前只认
  // reasoning_content → 非流式路径的思考全丢；正文为空时更看不出"额度被思考吃掉"的原因。
  // 同帧多字段重复出现时只取第一个非空（部分网关 reasoning 与 reasoning_content 内容相同）。
  const rcFields = [
    d && d.reasoning_content, d && d.reasoning, d && d.thinking, d && d.thought, d && d.analysis,
    msg && msg.reasoning_content, msg && msg.reasoning, msg && msg.thinking, msg && msg.thought,
    j.reasoning_content, j.reasoning, j.thinking,
  ];
  for (const f of rcFields) {
    if (typeof f === 'string' && f.length > 0) { out.reasoning = f; break; }
    if (f && typeof f.text === 'string' && f.text.length > 0) { out.reasoning = f.text; break; }
  }
  if (!out.content && j.message && typeof j.message.content === 'string' && j.message.content) out.content = j.message.content;
  if (!out.content && typeof j.response === 'string' && j.response) out.content = j.response;
  if (!out.reasoning && j.message && typeof j.message.reasoning === 'string' && j.message.reasoning) out.reasoning = j.message.reasoning;
  return out;
}

export const APIHandler = {
  abortController: null as AbortController | null,
  _apiCalls: [] as ApiCallLog[],


  _toolsSupport: null as boolean | null,  // 线路工具能力探测结果（按 endpoint+model 缓存）
  // 原生兜底（CapacitorHttp）拿到的上游错误：有它时报真实状态码，而不是把失败一律说成"CORS 受限"
  _lastFallbackError: null as { status: number; body: string } | null,
  // 该端点学到/实测过的上下文上限（token；0 = 未知）。app.ts 算正文窗口时用它收窄预算——
  // 之前算窗口只看用户填的全局「模型可用上下文」，换到 128k/256k 的渠道就会把请求撑爆。
  endpointContextCap(endpoint: unknown, model: unknown): number { return contextCapFor(endpoint, model); },
  _toolsSupportKey: '',

  // 工具能力探测：发一条带 tools 的最小请求，是否返回结构化 tool_calls。
  // 结果缓存；请求失败/无 tool_calls/未配 Key 一律视为不支持（false）。
  // 注意：探测必须与 fetchCompletions 走同一通道——HTTPS 端点先按本地代理改写，
  // 直连失败时用原生 CapacitorHttp 兜底。否则像 opencode.ai 这类不带 CORS 头的端点，
  // WebView fetch 被拦后会把"探测失败"误判成"不支持工具"（写卡右上角误报）。
  async probeToolsSupport(overrides: FetchOverrides = {}): Promise<boolean> {
    const apiConfig = (overrides.apiConfig || (typeof PresetManager !== 'undefined' ? PresetManager.getActiveAPIConfig() : null) || {}) as Record<string, string | number | undefined>;
    const endpoint = String(apiConfig.endpoint || '');
    const apiKey = String(apiConfig.apiKey || '');
    const model = String(apiConfig.model || '');
    const key = endpoint + '|' + model;
    if (this._toolsSupport !== null && this._toolsSupportKey === key) return this._toolsSupport;
    // 端点能力档案：该端点明确拒绝过 tools → 不再重复探测
    if (readEndpointProfile(endpoint, model).toolsUnsupported) {
      this._toolsSupport = false; this._toolsSupportKey = key; return false;
    }
    if (!apiKey) { this._toolsSupport = false; this._toolsSupportKey = key; return false; }
    let url = chatCompletionsUrl(endpoint);
    const _pp = resolveProxyPort();
    if (_pp && /^https:\/\//i.test(url)) {
      url = pickProxyUrl(url, _pp);
    }
    const body = JSON.stringify({
      model: model || 'deepseek-v4-flash',
      messages: [{ role: 'user', content: '请调用 ping 工具。' }],
      tools: [{ type: 'function', function: { name: 'ping', description: '测试工具', parameters: { type: 'object', properties: {} } } }],
      tool_choice: 'auto', max_tokens: 32, stream: false, temperature: 0
    });
    const _hasTools = (j: any): boolean => {
      const mc = j && j.choices && j.choices[0] && j.choices[0].message;
      return !!(mc && Array.isArray(mc.tool_calls) && mc.tool_calls.length > 0);
    };
    let has = false;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body,
      });
      if (resp.ok) {
        const j = await resp.json();
        has = _hasTools(j);
      }
    } catch (e) {
      // fetch 被 CORS 拦截（无代理环境）→ Capacitor 原生请求兜底（同 _nativeHttpFallback）
      const g = globalThis as any;
      const Cap = (g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.CapacitorHttp) || g.CapacitorHttp;
      if (Cap && Cap.request) {
        try {
          const nativeResp = await Cap.request({
            url, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            data: JSON.parse(body), responseType: 'json',
            connectTimeout: 30000, readTimeout: 60000,
          });
          if (nativeResp && nativeResp.status >= 200 && nativeResp.status < 300) {
            has = _hasTools(nativeResp.data);
          }
        } catch (e2) { /* ignore */ }
      }
    }
    this._toolsSupport = has;
    this._toolsSupportKey = key;
    return has;
  },

  // 拉取渠道可用模型：GET {endpoint}/models（OpenAI 兼容），走与 fetchCompletions 相同的
  // 本地代理/原生回退通道（opencode 等无 CORS 端点也能拉取）。
  // 返回 { models, status }：status=0 表示未配置/网络彻底失败，401 表示密钥无效（明确提示），
  // 404/405 表示端点不支持 /models（降级手动输入）。调用方据此给用户明确反馈。
  async fetchModels(apiConfig: Record<string, unknown>): Promise<{ models: string[]; status: number }> {
    const endpoint = sanitizeEndpointUrl(apiConfig.endpoint || '');
    if (!endpoint) return { models: [], status: 0 };
    // 真实 https URL（原生回退始终用这个）：归一化后的基址 + /models
    const realUrl = modelsUrl(apiConfig.endpoint || '');
    const apiKey = String(apiConfig.apiKey || '');
    const parse = (j: any): string[] => {
      const list = (j && Array.isArray(j.data) && j.data) || (j && Array.isArray(j.models) && j.models) || null;
      if (!list) return [];
      return list.map((m: any) => (typeof m === 'string' ? m : (m && (m.id || m.model || m.name)) || '')).filter(Boolean) as string[];
    };
    // 通道1：浏览器 fetch（有 __PROXY_PORT__ 时改写为本地代理；代理已支持 GET，旧版代理回 405）
    try {
      let url = realUrl;
      let proxied = false;
      const _pp = resolveProxyPort();
      if (_pp && /^https:\/\//i.test(url)) { url = pickProxyUrl(url, _pp); proxied = true; }
      const resp = await fetch(url, { method: 'GET', headers: { 'Authorization': 'Bearer ' + apiKey } });
      if (resp.ok) { const j = await resp.json(); return { models: parse(j), status: resp.status }; }
      // 405 且请求被代理改写 → 旧版代理只放行 POST，落通道2 原生直连真实 URL
      if (proxied && resp.status === 405) { /* 落到通道2 */ }
      else { return { models: [], status: resp.status }; } // 真实 404/401/405 直接报告
    } catch (e) { /* 直连失败（CORS/网络）→ 通道2 */ }
    // 通道2：Capacitor 原生请求直达真实 https（不受 CORS 限制）
    try {
      const g = globalThis as any;
      const Cap = (g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.CapacitorHttp) || g.CapacitorHttp;
      if (Cap && Cap.request) {
        const resp = await Cap.request({
          url: realUrl, method: 'GET',
          headers: { 'Authorization': 'Bearer ' + apiKey },
          responseType: 'json', connectTimeout: 30000, readTimeout: 60000,
        });
        if (resp && resp.status >= 200 && resp.status < 300 && resp.data) return { models: parse(resp.data), status: resp.status };
        return { models: [], status: resp ? resp.status : 0 };
      }
    } catch (e) { /* ignore */ }
    return { models: [], status: 0 };
  },

  // 通用非流式 POST JSON 网关：端点净化 → 本地代理改写 → 网络失败时 Capacitor 原生兜底。
  // 供摘要生成等非 SSE 场景复用传输层（fetchCompletions 为流式专用，勿混用）。
  // path 传 '' 时直接请求 endpoint 本身（搜索 API 这类完整 URL 场景）；auth 传 null/省略则不带 Authorization。
  // 返回结构化结果，业务方自行决定提示或静默——成功时 json 为解析后的响应体。
  async postJSON(
    endpoint: string,
    path: string,
    body: Record<string, unknown>,
    opts: { auth?: string | null; timeoutMs?: number } = {}
  ): Promise<{ ok: boolean; status?: number; json?: unknown; error?: string }> {
    const ep = sanitizeEndpointUrl(endpoint).replace(/\/+$/, '');
    let url = ep + path;
    const _pp = resolveProxyPort();
    if (_pp && /^https:\/\//i.test(url)) url = pickProxyUrl(url, _pp);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.auth) headers['Authorization'] = 'Bearer ' + opts.auth;
    const payload = JSON.stringify(body);
    const timeoutMs = opts.timeoutMs || 120000;
    const _ac = new AbortController();
    const _timer = setTimeout(function () { _ac.abort(); }, timeoutMs);
    try {
      const resp = await fetch(url, { method: 'POST', headers: headers, body: payload, signal: _ac.signal });
      let json: unknown = null;
      try { json = await resp.json(); } catch (e) { /* 非 JSON 响应体按 null 处理 */ }
      if (resp.ok) return { ok: true, status: resp.status, json: json };
      const _e = json && (json as { error?: unknown }).error;
      const detail = typeof _e === 'string' ? _e : (_e && (_e as { message?: string }).message) || '';
      return { ok: false, status: resp.status, error: 'HTTP ' + resp.status + (detail ? ': ' + detail : '') };
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return { ok: false, error: '请求超时 (' + timeoutMs + 'ms)' };
      // 代理/直连失败（CORS、代理未起、断网）：原生环境用 CapacitorHttp 直达真实 https（不受 CORS 限制）
      const g = globalThis as any;
      const Cap = (g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.CapacitorHttp) || g.CapacitorHttp;
      if (g.Capacitor && g.Capacitor.isNativePlatform && g.Capacitor.isNativePlatform() && Cap && Cap.request) {
        try {
          const resp = await Cap.request({
            url: ep + path, method: 'POST', headers: headers,
            data: body, responseType: 'json', connectTimeout: 30000, readTimeout: timeoutMs,
          });
          if (resp && resp.status >= 200 && resp.status < 300) return { ok: true, status: resp.status, json: resp.data };
          return { ok: false, status: resp && resp.status, error: 'HTTP ' + (resp && resp.status) };
        } catch (e2) {
          return { ok: false, error: String((e2 as Error).message || e2) };
        }
      }
      return { ok: false, error: String(err.message || err) };
    } finally {
      clearTimeout(_timer);
    }
  },

  async fetchCompletions(
    messages: OutgoingChatMessage[],
    onChunk: (s: string) => void,
    onDone: (full: string | null, aborted: boolean, reasoning?: string) => void,
    onError: (msg: string) => void,
    overrides: FetchOverrides = {}
  ): Promise<void> {
    // 配置解析：优先调用方传的 → 当前预设的「生效配置」（全局配置 + 预设自带采样参数，
    // 见 preset.ts getEffectiveAPIConfig）→ 全局配置。老实现直接读全局，导入的酒馆预设
    // 那一套 temperature/top_p/惩罚/思考强度全丢（实测：预设 1/0.95/0/0/medium 发成 0.9/0.95/0.4/0.3/无）。
    const _pm: any = (typeof PresetManager !== 'undefined') ? PresetManager : null;
    const apiConfig = (overrides.apiConfig
      || (_pm && typeof _pm.getEffectiveAPIConfig === 'function' ? _pm.getEffectiveAPIConfig() : null)
      || (_pm ? _pm.getActiveAPIConfig() : {})) as Record<string, string | number | undefined>;
    const endpoint = sanitizeEndpointUrl(apiConfig.endpoint || 'https://api.deepseek.com/v1') || 'https://api.deepseek.com/v1';
    const apiKey = String(apiConfig.apiKey || '');
    const modelId = String(apiConfig.model || '');
    const url0 = chatCompletionsUrl(apiConfig.endpoint || 'https://api.deepseek.com/v1');
    // 兼容判定（纯函数，见 modelcompat.ts）
    const _compatEndpoint = endpoint;
    const _compatModel = modelId || 'deepseek-v4-flash';
    let url = url0;
    // 本地 CORS 代理（与手机版内置 LocalProxyServer 配套）：window.__PROXY_PORT__ 存在时，
    // 任意 https 端点都走 http://127.0.0.1:PORT/{host/path} 转发（LocalProxyServer 按 target
    // 的 host:443 直连上游，天然支持所有 API），绕过 WebView 对 Authorization 的 CORS 限制。
    const _pp = resolveProxyPort();
    if (_pp && /^https:\/\//i.test(url)) {
      url = pickProxyUrl(url, _pp);
    }
    if (!apiKey) { onError('请先在高级设置中配置 API Key'); return; }
    const _ac = new AbortController();
    this.abortController = _ac;
    const _timeout = overrides.timeout || 0;
    const _idleTimeout = overrides.idleTimeout || 0;
    let _timedOut = false;
    let _idleTimedOut = false;
    let _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
    let _idleTimer: ReturnType<typeof setTimeout> | null = null;
    // —— 超时只在"前台可见"时计时 ——
    // 切到后台/锁屏时系统会节流甚至冻结 WebView 的 JS：定时器不会按时触发，回到前台的
    // 那一瞬间逾时的定时器会集体触发，把还在跑的流式请求误判成「请求超时/输出中断」。
    // 所以总超时按累计可见时长算，空闲超时在隐藏期间挂起、回到前台重新开始计。
    const _budget = createVisibleBudget(Date.now(), pageVisible());
    const _clearTimeoutTimer = () => { if (_timeoutTimer) { clearTimeout(_timeoutTimer); _timeoutTimer = null; } };
    const _clearIdleTimer = () => { if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; } };
    const _armTimeout = () => {
      _clearTimeoutTimer();
      if (_timeout > 0) {
        const rest = Math.max(1000, _timeout - _budget.elapsed(Date.now()));
        _timeoutTimer = setTimeout(function () { _timedOut = true; _ac.abort(); }, rest);
      }
    };
    // 空闲超时：流式过程中距上次收到数据超过 idleTimeout 毫秒 → 判定连接挂起，强制断开
    const _resetIdle = () => {
      _clearIdleTimer();
      if (_idleTimeout > 0) {
        _idleTimer = setTimeout(function () { _idleTimedOut = true; _timedOut = true; _ac.abort(); }, _idleTimeout);
      }
    };
    // 请求结束统一收尾：清两个定时器 + 摘掉可见性监听（所有出口都经 _done/_err，不会漏）
    let _visHandler: (() => void) | null = null;
    const _finishTimers = () => {
      _clearTimeoutTimer();
      _clearIdleTimer();
      if (_visHandler && typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', _visHandler);
        _visHandler = null;
      }
    };
    const _done = (full: string | null, aborted: boolean, reasoning?: string) => { _finishTimers(); onDone(full, aborted, reasoning); };
    const _err = (msg: string) => { _finishTimers(); onError(msg); };
    _armTimeout();
    _resetIdle();
    if (typeof document !== 'undefined' && document.addEventListener) {
      _visHandler = () => {
        if (!pageVisible()) { _budget.hide(Date.now()); _clearTimeoutTimer(); _clearIdleTimer(); }
        else { _budget.show(Date.now()); _armTimeout(); _resetIdle(); }
      };
      document.addEventListener('visibilitychange', _visHandler);
    }
    // 消息标准化：system 保留多条/丢弃空；assistant content+tool_calls 拆分；reasoning_content
    // 占位（deepseek 系）；tool 结果后插 assistant（zai/qwen/moonshot 系）。见 normalizeOutgoingMessages。
    const _compat = _resolveMessageCompat(_compatEndpoint, _compatModel);
    messages = normalizeOutgoingMessages(messages, _compat);
    const body: Record<string, unknown> = {
      model: modelId || 'deepseek-v4-flash', messages: messages,
      // 采样参数：先看调用方覆盖 → 配置里的值（预设自带参数会经 getEffectiveAPIConfig 合进来）。
      // 注意用 _numOr 而不是 `|| 默认值`：`parseFloat('0') || 0.4` 会把**合法的 0** 吞掉——
      // 酒馆预设的惩罚项默认就是 0/0，实测导进来仍然发 0.4/0.3（2026-09-26 与预设对齐时发现）。
      temperature: overrides.temperature != null ? overrides.temperature : _numOr(apiConfig.temperature, 0.9),
      max_tokens: overrides.maxTokens || DEFAULT_MAX_TOKENS,
      top_p: _numOr(apiConfig.topP, 0.95),
      presence_penalty: _numOr(apiConfig.presencePenalty, 0.4),
      frequency_penalty: _numOr(apiConfig.frequencyPenalty, 0.3),
      stream: true,
      // 流式下默认不返回 usage，显式要求在最后一个 chunk 带 usage（含 cached_tokens）。
      stream_options: { include_usage: true },
    };
    const _tk = parseInt(String(apiConfig.topK)); if (_tk) body.top_k = _tk;
    const _mp = parseFloat(String(apiConfig.minP)); if (_mp) body.min_p = _mp;
    const _rp = parseFloat(String(apiConfig.repetitionPenalty)); if (_rp && _rp !== 1) body.repetition_penalty = _rp;
    // 工具调用（function calling）：模型通过结构化 tool_calls 提交变更，前端执行后回传（agent 循环）
    if (overrides.tools) body.tools = overrides.tools;
    if (overrides.toolChoice) body.tool_choice = overrides.toolChoice;
    // 思考档位（写作/写卡共用，高级设置「思考强度」）：auto/off/low/medium/high。
    // 按档位决定请求体附加的思考参数（modelcompat.resolveThinkingParams，通用策略+已知方言分派）：
    // - auto：不发任何思考参数（模型默认；对未知模型最安全）
    // - off：尝试禁用思考（thinking.disabled 等，各系方言）
    // - low/medium/high：reasoning_effort 对应值（OpenAI 标准）或各系开启思考的方言
    // 模型若不接受附加参数（400），由下方请求循环降级摘除重试（_thinkingParamsApplied 标记）。
    let _thinkingLevel = 'auto';
    try {
      const _cfgVal = (overrides as any).apiConfig ? (overrides as any).apiConfig.deepseekThinking : (apiConfig as any).deepseekThinking;
      if (_cfgVal === undefined || _cfgVal === null) {
        // api.ts 为遗留无 import 模块（运行时全局）：用 globalThis 访问 StorageManager，不用裸 SM()
        const _sm = (globalThis as any).StorageManager;
        _thinkingLevel = _sm ? _thinkingLevelFromConfig(_sm.get('deepseekThinking')) : 'auto';
      } else {
        _thinkingLevel = _thinkingLevelFromConfig(_cfgVal);
      }
    } catch (e) { _thinkingLevel = 'auto'; }
    // 附加思考参数 + 是否已应用（用于 400 降级摘除）
    let _thinkingParams: Record<string, unknown> = {};
    let _thinkingParamsApplied = false;
    const _applyThinkingParams = () => {
      if (_thinkingLevel === 'auto') return;
      _thinkingParams = _resolveThinkingParams(_thinkingLevel, _compatEndpoint, _compatModel);
      if (Object.keys(_thinkingParams).length > 0) {
        Object.assign(body, _thinkingParams);
        _thinkingParamsApplied = true;
      }
    };
    _applyThinkingParams();
    // 保留原行为：火山方舟 coding 端点固定禁用 thinking（该产品线不接受/不需要 thinking 参数）
    if (/ark\.cn-beijing\.volces\.com\/api\/coding/i.test(endpoint)) {
      body.thinking = { type: 'disabled' };
    }
    // 自动重试：网络错误/5xx/超时等瞬时错误指数退避（最多 2 次）；读流中途失败不重试
    const RETRYABLE_MSG = /network|fetch|timeout|timed out|econn|etimedout|socket|connection|load failed|getaddrinfo|503|502|504|500|429/i;
    const _sleep = function (ms: number) { return new Promise(function (r) { setTimeout(r, ms); }); };
    // 端点能力档案：先把上次学到的"该端点不吃什么参数"应用上（同一个坑只踩一次）
    const _profile = readEndpointProfile(_compatEndpoint, _compatModel);
    _applyProfileToBody(body, _profile);
    if (_profile.toolsUnsupported) this._toolsSupport = false;
    // 参数降级阶梯轮数（每轮必须摘掉/改掉至少一个参数，否则终止，防死循环）
    let _ladderRounds = 0;
    let _contextOverflowCap = 0;   // >0 = 本轮因"上下文超长"失败，并学到了端点上限
    let _response: Response | null = null;
    let _requestError: { status?: number; body?: string; name?: string; message?: string } | null = null;
    for (let _attempt = 0; _attempt <= 2; _attempt++) {
      if (_attempt > 0) {
        await _sleep(1500 * Math.pow(2, _attempt - 1)); // 1.5s → 3s
      }
      try {
        _response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          body: JSON.stringify(body),
          signal: this.abortController?.signal
        });
        if (_response.ok) break;
        const _status = _response.status;
        // 参数降级阶梯（400/422）：解析被拒参数 → 摘除 / max_tokens 改名 → 重试
        if ((_status === 400 || _status === 422) && _ladderRounds < 5) {
          const _errText = await _response.text().catch(function () { return ''; });
          // 上下文超长不是"参数问题"：既没有可摘的参数，也不该按参数降级白跑几轮
          // （报错文本里常带 max_tokens 字样，会被误当成值域问题）。这里直接学上限 + 报清楚。
          if (_mc().isContextOverflowError(_errText)) {
            const _cap = _mc().parseContextOverflowCap(_errText) || 0;
            if (_cap > 0) _saveEndpointProfile(_compatEndpoint, _compatModel, [], { contextCap: _cap });
            _contextOverflowCap = _cap;
            _requestError = { status: _status, body: _errText };
            break;
          }
          const _acts = parseRejectedParams(_errText, body);
          const _learned: string[] = [];
          const _profDelta: EndpointProfile = {};
          let _persist = true;
          if (_acts.length === 0 && _thinkingParamsApplied) {
            // 错误文本定位不到参数：回退摘除思考参数（旧行为，对"unknown parameter"类通用报错有效）。
            // 该猜测不写入能力档案——泛化报错不足以断定端点长期不吃思考参数。
            for (const _k of Object.keys(_thinkingParams)) { delete body[_k]; _learned.push(_k); }
            _thinkingParamsApplied = false;
            _thinkingParams = {};
            _persist = false;
          } else {
            for (const _a of _acts) {
              if (_a.action === 'rename_max_tokens') {
                body.max_completion_tokens = body.max_tokens;
                delete body.max_tokens;
                _profDelta.useMaxCompletionTokens = true;
                _learned.push('max_tokens');
              } else if (_a.action === 'clamp_max_tokens') {
                // 输出上限被端点判为过大 → 取报错里给的允许值，取不到就按阶梯下调一档。
                // 学到后写入档案（maxTokensCap），后续请求发送前就取 min，不再重复踩。
                const _cur = Number(body[_a.key]) || 0;
                let _cap = parseInt(String(_a.value || '0'), 10) || 0;
                if (!_cap || _cap >= _cur) _cap = nextMaxTokensStep(_cur);
                if (_cap > 0 && _cap < _cur) {
                  body[_a.key] = _cap;
                  _profDelta.maxTokensCap = _cap;
                  _learned.push(_a.key + '=' + _cap);
                }
              } else if (_a.action === 'set_value') {
                // 取值非法（如 reasoning_effort:'none' 不被端点接受）→ 降到允许的最小档，
                // 而不是摘掉参数：摘掉等于放开思考（思考型模型会把 token 预算全吃掉）。
                body[_a.key] = _a.value;
                _profDelta.thinkingOverride = Object.assign({}, _profDelta.thinkingOverride, { [_a.key]: _a.value });
                _learned.push(_a.key + '=' + _a.value);
              } else {
                delete body[_a.key];
                _learned.push(_a.key);
                if (_a.key === 'stream_options') _profDelta.usageUnavailable = true;
                if (_a.key === 'tools' || _a.key === 'tool_choice') { _profDelta.toolsUnsupported = true; this._toolsSupport = false; }
                if (_a.key === 'thinking' || _a.key === 'reasoning_effort' || _a.key === 'enable_thinking' || _a.key === 'reasoning') _thinkingParamsApplied = false;
              }
            }
          }
          if (_learned.length > 0) {
            _ladderRounds++;
            if (_persist) _saveEndpointProfile(_compatEndpoint, _compatModel, _learned, _profDelta);
            console.warn('[API] 端点拒绝参数，已降级重试:', _learned.join(','), '|', _errText.slice(0, 200));
            _attempt = -1; // 重置循环（0 起），参数问题非瞬态，不加退避
            continue;
          }
        }
        if (_attempt < 2 && _status >= 500) continue; // 5xx 瞬时可重试
        _requestError = { status: _status, body: await _response.text() };
        break;
      } catch (e) {
        const err = e as Error;
        if (err.name === 'AbortError') { _requestError = err; break; }
        if (_attempt < 2 && RETRYABLE_MSG.test(err.message || '')) continue;
        _requestError = err;
        break;
      }
    }
    const _label = overrides.callLabel || 'generate';
    _clearTimeoutTimer();
    if (_requestError) {
      if (_requestError.name === 'AbortError') {
        if (_timedOut) { _err(_idleTimedOut ? '网络超时（长时间无响应，连接已断开）' : '请求超时 (' + _timeout + 'ms)'); return; }
        else { _done(null, true); return; }
      }
      if (_requestError.status) {
        const _b = String(_requestError.body || '');
        _apiFailLog('生成(' + _label + (_contextOverflowCap ? '·上下文超长' : '') + ')', _requestError.status, _b);
        _err('API 请求失败 (' + _requestError.status + '): ' + _b +
          (_contextOverflowCap || _mc().isContextOverflowError(_b)
            ? _mc().contextOverflowHint(_contextOverflowCap)
            : _mc().explainUpstreamError(_requestError.status, _b)));
        return;
      }
      // 原生端 CORS 降级：endpoint 无 CORS 头时 WebView fetch 被浏览器拦截（TypeError: Failed to fetch），
      // 改用 CapacitorHttp 原生请求（不受 CORS 限制）。整段 SSE 文本返回后本地分帧、节流喂给同一解析逻辑。
      if (typeof (globalThis as any).Capacitor !== 'undefined' && (globalThis as any).Capacitor.isNativePlatform && (globalThis as any).Capacitor.isNativePlatform()) {
        try {
          const ok = await this._nativeHttpFallback(url, apiKey, body, onChunk, _done, _resetIdle, overrides, chatCompletionsUrl(apiConfig.endpoint || 'https://api.deepseek.com/v1'));
          if (ok) { this.abortController = null; return; }
        } catch (e) { /* fallback 也失败 → 继续报原网络错误 */ }
        // 原生兜底拿到的是上游的真实状态码时，报它而不是"CORS 受限"——否则 400/404（模型不在套餐里
        // 这类参数/权限问题）会被误报成网络问题，用户反复去查网络。
        const _fb = this._lastFallbackError;
        if (_fb && _fb.status) {
          _apiFailLog('生成(' + _label + '，原生兜底)', _fb.status, _fb.body);
          _err('API 请求失败 (' + _fb.status + '): ' + _fb.body + _mc().explainUpstreamError(_fb.status, _fb.body));
          return;
        }
      }
      const _errMsg = String(_requestError.message || _requestError || '');
      // 提示细分：Failed to parse URL 多为地址里混入了空格/全角字符；Failed to fetch 多为端点
      // 跨域策略拦截（如火山方舟 coding 端点的 CORS 不允许 Authorization 头）或网络不可达。
      const _hint = /failed to parse|invalid url/i.test(_errMsg) ? '（API 地址格式有误：请检查是否混入了空格或全角字符）'
        : (/failed to fetch|load failed|networkerror/i.test(_errMsg) ? '（端点跨域受限或网络不可达）' : '');
      _apiFailLog('生成(' + _label + '，直连失败)', 0, _errMsg);
      _err('网络错误: ' + (_errMsg || _requestError) + _hint);
      return;
    }
    const response = _response!;
    try {
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '', fullContent = '', reasoning = '';
      // 形态自适应：没见到标准 SSE 帧之前累积原文，用于"整段 JSON"兜底（部分中转忽略 stream:true）
      let _sawFrame = false;
      let _rawBuf = '';
      let _proxyError: string | null = null;
      // 流式工具调用拼装：delta.tool_calls 按 index 累积 name + arguments(JSON 碎片)
      const toolCalls: { id: string; name: string; arguments: string }[] = [];
      let toolCallStarted = false;
      // 部分网关（如 opencode router）流式每帧都带 usage——若每帧入账一次，
      // 一次续写会被用量统计记成几千次调用（token/费用也重复累加）。
      // 只暂存最后一帧，流结束后统一入账一次。
      let lastUsage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number } | null = null;
      // 流结束原因（stop=模型自然收笔 / length=输出额度到顶被截断）：用于向用户区分「模型自己停」与「额度不够」
      let _finishReason: string | null = null;
      type DeltaLike = { content?: string; reasoning_content?: string; reasoning?: string; thinking?: string | { text?: string }; thought?: string; analysis?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) _resetIdle();
        const _text = decoder.decode(value, { stream: true });
        if (!_sawFrame) {
          _rawBuf += _text;
          if (_rawBuf.length > 2000000) _rawBuf = _rawBuf.slice(-500000); // 只留尾部，防内存膨胀
        }
        buffer += _text;
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // SSE 帧：`data: {...}` 与规范允许的无空格形态 `data:{...}` 都认
          const _dm = /^data:\s?/.exec(trimmed);
          if (!_dm) {
            // NDJSON / 裸 JSON 行（Ollama 原生 /api/chat 等无 data: 前缀的流）
            if (trimmed.startsWith('{')) {
              try {
                const _nj = JSON.parse(trimmed) as Record<string, unknown>;
                const _np = pickNonSseContent(_nj);
                if (_np.reasoning) { reasoning += _np.reasoning; if (overrides.onReasoning) overrides.onReasoning(String(_np.reasoning)); }
                if (_np.content) { fullContent += _np.content; onChunk(_np.content); }
                if (_np.content || _np.reasoning) _sawFrame = true;
                if (_nj && (_nj as any).usage) lastUsage = (_nj as any).usage;
                const _nfr = (_nj && (_nj as any).done === true) ? 'stop' : (((_nj as any).choices && (_nj as any).choices[0] && (_nj as any).choices[0].finish_reason) || null);
                if (_nfr) _finishReason = _nfr;
              } catch (e) { /* 非 JSON 行忽略 */ }
            }
            continue;
          }
          const data = trimmed.slice(_dm[0].length);
          if (data === '[DONE]') continue;
          _sawFrame = true;
          try {
            const p = JSON.parse(data) as {
              __proxy_error__?: boolean; type?: string; message?: string;
              choices?: { delta?: DeltaLike; message?: DeltaLike; finish_reason?: string }[];
              usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number };
              reasoning_content?: string; reasoning?: string; thinking?: string;
            };
            const _fr = p.choices?.[0]?.finish_reason;
            if (_fr) _finishReason = _fr;
            // LocalProxyServer 注入的流内错误帧：记录真实原因，停止读取
            if (p && p.__proxy_error__) {
              _proxyError = (p.type ? p.type + ': ' : '') + (p.message || '上游连接中断');
              continue;
            }
            // 深度思考通道兼容（多格式）：取第一个非空字段，避免同帧多字段重复累计
            // （部分网关如 chutes.ai 同时返回 reasoning_content 与 reasoning 且内容相同）
            // 注意：reasoning 必须先于 content 回调——editor 流式渲染靠"reasoning 建框、
            // content 首字闭框"衔接，若 content 先到会把正文吞进思考框（正文进思维链的根因）。
            const _delta = p.choices?.[0]?.delta || {};
            const _msg = p.choices?.[0]?.message || {};
            const _rcFields = [_delta.reasoning_content, _delta.reasoning, _delta.thinking, _delta.thought, _delta.analysis,
              _msg.reasoning_content, _msg.reasoning, _msg.thinking, _msg.thought,
              p.reasoning_content, p.reasoning, p.thinking];
            let _rc: unknown = null;
            for (const _f of _rcFields) {
              if (typeof _f === 'string' && _f.length > 0) { _rc = _f; break; }
              if (_f && typeof (_f as { text?: string }).text === 'string' && (_f as { text: string }).text.length > 0) { _rc = (_f as { text: string }).text; break; }
            }
            if (_rc) { reasoning += _rc; if (overrides.onReasoning) overrides.onReasoning(String(_rc)); }
            const c = p.choices?.[0]?.delta?.content;
            if (c) { fullContent += c; onChunk(c); }
            const tc = p.choices?.[0]?.delta?.tool_calls;
            if (tc) {
              // 首次检测到工具调用增量：通知前端回滚过渡文字
              if (!toolCallStarted) {
                toolCallStarted = true;
                if (overrides.onToolCallStart) overrides.onToolCallStart();
              }
              tc.forEach(function (t) {
                const idx = t.index || 0;
                if (!toolCalls[idx]) toolCalls[idx] = { id: '', name: '', arguments: '' };
                if (t.id) toolCalls[idx].id = t.id;
                if (t.function) {
                  if (t.function.name) toolCalls[idx].name += t.function.name;
                  if (t.function.arguments) toolCalls[idx].arguments += t.function.arguments;
                }
              });
            }
            if (p && p.usage) {
              lastUsage = p.usage; // 只暂存，流结束后入账一次
            }
          } catch { /* 非 JSON 行忽略 */ }
        }
      }
      // SSE 最后一帧可能没有结尾换行：done 后处理残余 buffer
      const _tailDm = /^data:\s?/.exec(buffer.trim());
      if (_tailDm) {
        const _tailData = buffer.trim().slice(_tailDm[0].length);
        if (_tailData && _tailData !== '[DONE]') {
          try {
            const _tp = JSON.parse(_tailData) as { choices?: { delta?: DeltaLike; message?: DeltaLike; finish_reason?: string }[]; reasoning_content?: string; reasoning?: string; thinking?: string };
            const _td = _tp.choices?.[0]?.delta || {};
            const _tm = _tp.choices?.[0]?.message || {};
            const _frTail = _tp.choices?.[0]?.finish_reason;
            if (_frTail) _finishReason = _frTail;
            // 与主循环一致：取第一个非空字段，reasoning 先于 content 回调（防正文被吞进思考框）
            const _trFields = [_td.reasoning_content, _td.reasoning, _td.thinking, _td.thought, _td.analysis,
              _tm.reasoning_content, _tm.reasoning, _tm.thinking, _tm.thought,
              _tp.reasoning_content, _tp.reasoning, _tp.thinking];
            let _tr: unknown = null;
            for (const _f of _trFields) {
              if (typeof _f === 'string' && _f.length > 0) { _tr = _f; break; }
              if (_f && typeof (_f as { text?: string }).text === 'string' && (_f as { text: string }).text.length > 0) { _tr = (_f as { text: string }).text; break; }
            }
            if (_tr) { reasoning += _tr; if (overrides.onReasoning) overrides.onReasoning(String(_tr)); }
            const _tc = _td.content ?? _tm.content;
            if (typeof _tc === 'string' && _tc) { fullContent += _tc; onChunk(_tc); }
          } catch (e) { console.warn('[API] 无法解析SSE尾帧:', (e as Error).message); }
        }
      }
      // 形态兜底：整段不是 SSE（中转忽略 stream:true 直接返回一个 JSON 对象）→ 本地解析后一次性喂出
      if (!_sawFrame && !fullContent && _rawBuf.trim()) {
        try {
          const _j = JSON.parse(_rawBuf.trim());
          const _picked = pickNonSseContent(_j);
          if (_picked.reasoning) { reasoning += _picked.reasoning; if (overrides.onReasoning) overrides.onReasoning(String(_picked.reasoning)); }
          if (_picked.content) { fullContent += _picked.content; onChunk(_picked.content); }
          const _fr2 = (_j && (_j as any).choices && (_j as any).choices[0] && (_j as any).choices[0].finish_reason) || null;
          if (_fr2) _finishReason = _fr2;
          if (_j && (_j as any).usage) lastUsage = (_j as any).usage;
          if (_picked.content || _picked.reasoning) _sawFrame = true;
        } catch (e) { /* 不是 JSON：保持零输出，交由上层报"未收到有效回复" */ }
      }
      _finishTimers();
      if (_proxyError) {
        _err('网络错误（输出中断，已收到 ' + fullContent.replace(/\s/g, '').length + ' 字）: ' + _proxyError);
        return;
      }
      // 本次请求用量入账（一次请求一条记录，取最后一帧 usage = 最终累计值）
      const label = overrides.callLabel || 'unknown';
      if (lastUsage) {
        const u = lastUsage;
        // 缓存命中 token：两种方言都要认。OpenAI/火山方舟走 prompt_tokens_details.cached_tokens；
        // DeepSeek 直连走顶层 prompt_cache_hit_tokens（只认前者的后果：命中率恒显 0%、费用按全 miss 估，偏贵）。
        const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0;
        const uncached = (u.prompt_tokens || 0) - cached;
        const prices = App.getPricingConfig?.() ?? { input: 0, cached: 0, output: 0 };
        this._apiCalls.push({
          label, time: Date.now(),
          promptTokens: u.prompt_tokens || 0,
          completionTokens: u.completion_tokens || 0,
          cachedTokens: cached,
          totalTokens: u.total_tokens || 0,
          cost: uncached * prices.input + cached * prices.cached + (u.completion_tokens || 0) * prices.output
        });
      } else if (!_proxyError) {
        // 端点没回 usage（流式未带 usage / stream_options 被拒 / 非标准网关）：
        // **也要记一条**（token 记 0，标 usageMissing）。以前这里什么都不记 → 整轮从用量统计里消失，
        // 用户看到的是"续写不算用量"（本轮明明跑过一次请求）。记下来才能显示"本轮未取到用量"。
        this._apiCalls.push({ label, time: Date.now(), promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0, cost: 0, usageMissing: true });
      }
      // 有工具调用：交给 onTools 处理；无则普通文本流程
      if (toolCalls.length > 0 && overrides.onTools) {
        const parsed = toolCalls.map(function (t) {
          let args: Record<string, unknown> = {};
          let argsError: string | null = null;
          try { args = JSON.parse(t.arguments || '{}'); } catch (e) { argsError = (e && (e as Error).message) ? (e as Error).message : String(e); }
          return { id: t.id, name: t.name, arguments: args, argsError: argsError || undefined };
        }).filter(function (t) { return !!t.name; });
        overrides.onTools(parsed);
        return;
      }
      // 流结束原因透出（'stop'|'length'|'tool_calls'|...）：调用方据此判断是模型自然收笔还是被截断
      if (overrides.onFinishReason) {
        try { overrides.onFinishReason(_finishReason); } catch (e) { /* 回调异常不影响主流程 */ }
      }
      // 流被输出额度截断时明确告知（区别于模型自然收笔 stop）。
      // 仅前台交互（主写作 generate / 比奇 / 助手等）提示——后台任务（记忆填表/摘要/
      // 场景分析/角色提取/上传元数据等）label 一律静默，避免用户以为正文被截断。
      // 输出上限已不再由用户设置（一律按端点能接受的最大值发送），所以措辞是"重试/换端点"而非"调大设置"。
      const _bgLabel = /^(archiveHead|sceneAnalysis|fillMemoryTable|optionRetry|cardwriter|wbUploadMeta|settingDeltaReview)$/.test(overrides.callLabel || '');
      if (_finishReason === 'length' && !_bgLabel) {
        try { (globalThis as any).App?.toast?.('本次输出达到该模型的输出上限被截断，可直接重试'); } catch (e) { /* ignore */ }
      }
      _done(fullContent, false, reasoning);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') {
        if (_timedOut) {
          _err(_idleTimedOut ? '网络超时（长时间无响应，连接已断开）' : '请求超时 (' + _timeout + 'ms)');
          return;
        }
        else { _done(null, true); return; }
      }
      _err('网络错误: ' + err.message);
    }
  },

  // 原生端 CORS 降级（仅 fetch 被跨域拦截时使用）：CapacitorHttp 原生请求不受 CORS 限制。
  // 服务端把整段 SSE 返回，本地按帧解析、节流喂给 onChunk（近似流式）。
  // realUrl：未走本地代理的真实 https 地址。传入后，若代理地址请求失败（本地代理进程
  // 已死/端口失效），再直连真实端点重试一次，避免两条通道一起失效。
  async _nativeHttpFallback(url: string, apiKey: string, body: Record<string, unknown>,
    onChunk: (c: string) => void, onDone: (full: string | null, aborted: boolean, reasoning?: string) => void,
    resetIdle: () => void, overrides: any, realUrl?: string): Promise<boolean> {
    // Capacitor 6：插件挂在 window.Capacitor.Plugins.CapacitorHttp（不是全局 CapacitorHttp）
    const g = globalThis as any;
    const Cap = (g.Capacitor && g.Capacitor.Plugins && g.Capacitor.Plugins.CapacitorHttp) || g.CapacitorHttp;
    if (!Cap || !Cap.request) return false;
    console.log('[NativeFallback] 触发原生请求（无 CORS 端点）', url);
    this._lastFallbackError = null;
    resetIdle();
    let resp: any;
    try {
      resp = await Cap.request({
        url, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        data: body, responseType: 'text',
        connectTimeout: 120000, readTimeout: 300000,
      });
    } catch (e) {
      console.warn('[NativeFallback] 请求失败:', e);
      if (!realUrl || realUrl === url) return false;
      console.log('[NativeFallback] 代理地址失败，改直连真实端点重试', realUrl);
      resetIdle();
      try {
        resp = await Cap.request({
          url: realUrl, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          data: body, responseType: 'text',
          connectTimeout: 120000, readTimeout: 300000,
        });
      } catch (e2) {
        console.warn('[NativeFallback] 直连真实端点也失败:', e2);
        return false;
      }
    }
    if (resp && (resp.status === 502 || resp.status === 504) && realUrl && realUrl !== url) {
      // 502/504 来自本地代理自身（上游转发失败）而非业务端点 → 直连真实端点重试
      console.log('[NativeFallback] 代理返回 ' + resp.status + '，改直连真实端点重试', realUrl);
      resetIdle();
      try {
        resp = await Cap.request({
          url: realUrl, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
          data: body, responseType: 'text',
          connectTimeout: 120000, readTimeout: 300000,
        });
      } catch (e2) {
        console.warn('[NativeFallback] 直连真实端点也失败:', e2);
        return false;
      }
    }
    if (!resp || resp.status < 200 || resp.status >= 300) {
      console.warn('[NativeFallback] 非 2xx:', resp && resp.status);
      this._lastFallbackError = { status: Number(resp && resp.status) || 0, body: String((resp && resp.data) || '').slice(0, 400) };
      return false;
    }
    const text = String(resp.data || '');
    if (!text.trim()) { onDone(null, false); return true; }
    const lines = text.split('\n');
    let fullContent = '', reasoning = '';
    let toolCallStarted = false;
    const toolCalls: any[] = [];
    let idx = 0, finished = false;
    const finish = (aborted: boolean) => {
      if (finished) return; finished = true;
      if (toolCalls.length > 0 && overrides.onTools) {
        const list = toolCalls.filter(Boolean).map(function (t: any) {
          let args: Record<string, unknown> = {};
          let argsError: string | null = null;
          try { args = JSON.parse(t.arguments || '{}'); } catch (e) { argsError = (e && (e as Error).message) ? (e as Error).message : String(e); }
          return { id: t.id || '', name: t.name, arguments: args, argsError: argsError || undefined };
        });
        // 工具处理可以是异步的（写卡的生图工具要等 10 秒级出图）：返回值是 Promise 就等它跑完再收尾；
        // 同步回调行为完全不变（biqi/助手等不受影响）。不等的话 onDone 会先到，把这一轮当成已结束。
        const _toolRet: any = overrides.onTools(list);
        if (_toolRet && typeof _toolRet.then === 'function') {
          _toolRet.then(function () { onDone(null, false); }, function () { onDone(null, false); });
        } else {
          onDone(null, false);
        }
      } else {
        onDone(fullContent || null, aborted, reasoning || undefined);
      }
    };
    const step = () => {
      resetIdle();
      for (let guard = 0; guard < 300 && idx < lines.length; guard++) {
        const line = (lines[idx++] || '').trim();
        if (!line) continue;
        // 与主循环同一套形态容错：`data:` 无空格也认；无前缀的裸 JSON 行按 NDJSON 处理
        const _dm2 = /^data:\s?/.exec(line);
        if (!_dm2) {
          if (line.startsWith('{')) {
            try {
              const _nj = JSON.parse(line) as any;
              const _np = pickNonSseContent(_nj);
              if (_np.reasoning) { reasoning += _np.reasoning; if (overrides.onReasoning) overrides.onReasoning(String(_np.reasoning)); }
              if (_np.content) { fullContent += _np.content; onChunk(_np.content); }
            } catch (e) { /* ignore */ }
          }
          continue;
        }
        const data = line.slice(_dm2[0].length);
        if (data === '[DONE]') { finish(false); return; }
        try {
          const p = JSON.parse(data) as any;
          // reasoning 先于 content 回调（见主循环注释：防正文被吞进思考框）
          const _delta = (p.choices && p.choices[0] && p.choices[0].delta) || {};
          const _msg = (p.choices && p.choices[0] && p.choices[0].message) || {};
          const _rcFields = [_delta.reasoning_content, _delta.reasoning, _delta.thinking, _delta.thought, _delta.analysis,
            _msg.reasoning_content, _msg.reasoning, _msg.thinking, _msg.thought,
            p.reasoning_content, p.reasoning, p.thinking];
          let _rc: unknown = null;
          for (const _f of _rcFields) {
            if (typeof _f === 'string' && _f.length > 0) { _rc = _f; break; }
            if (_f && typeof (_f as { text?: string }).text === 'string' && (_f as { text: string }).text.length > 0) { _rc = (_f as { text: string }).text; break; }
          }
          if (_rc) { reasoning += _rc; if (overrides.onReasoning) overrides.onReasoning(String(_rc)); }
          const c = p.choices && p.choices[0] && p.choices[0].delta ? p.choices[0].delta.content : null;
          if (c) { fullContent += c; onChunk(c); }
          const tc = _delta.tool_calls;
          if (tc) {
            if (!toolCallStarted) { toolCallStarted = true; if (overrides.onToolCallStart) overrides.onToolCallStart(); }
            tc.forEach(function (t: any) {
              const i = t.index || 0;
              if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', arguments: '' };
              if (t.id) toolCalls[i].id = t.id;
              if (t.function) {
                if (t.function.name) toolCalls[i].name += t.function.name;
                if (t.function.arguments) toolCalls[i].arguments += t.function.arguments;
              }
            });
          }
        } catch { /* 非 JSON 帧忽略 */ }
      }
      if (idx < lines.length) { setTimeout(step, 25); } // 本地节流，视觉近似流式
      else finish(false);
    };
    step();
    return true;
  },

  abort(): void {
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }
  }
};

// 自类型引用已内联（ApiCallLog）

(globalThis as unknown as { APIHandler: typeof APIHandler }).APIHandler = APIHandler;
export default APIHandler;