import { describe, it, expect } from 'vitest';
import {
  detectEndpoint,
  resolveThinkingParams,
  resolveMessageCompat,
  TOOL_BRIDGE_ASSISTANT_TEXT,
} from '../src/domain/modelcompat';

describe('modelcompat：端点能力探测', () => {
  it('deepseek 端点 → deepseek thinkingKind + 需要 reasoning_content', () => {
    const p = detectEndpoint('https://api.deepseek.com/v1');
    expect(p.thinkingKind).toBe('deepseek');
    expect(p.needsReasoningContentOnAssistant).toBe(true);
  });
  it('zai/bigmodel 端点 → zai thinkingKind', () => {
    expect(detectEndpoint('https://open.bigmodel.cn/api/paas/v4').thinkingKind).toBe('zai');
    expect(detectEndpoint('https://api.z.ai/api/paas/v4').thinkingKind).toBe('zai');
  });
  it('dashscope 端点 → qwen thinkingKind', () => {
    expect(detectEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1').thinkingKind).toBe('qwen');
  });
  it('openrouter 端点 → openrouter thinkingKind', () => {
    expect(detectEndpoint('https://openrouter.ai/api/v1').thinkingKind).toBe('openrouter');
  });
  it('未知端点 → none（不盲发参数）', () => {
    const p = detectEndpoint('https://some-gateway.example.com/v1');
    expect(p.thinkingKind).toBe('none');
    expect(p.needsReasoningContentOnAssistant).toBe(false);
    expect(p.requiresAssistantAfterToolResult).toBe(false);
  });
});

describe('modelcompat：消息协议兼容', () => {
  it('deepseek → 需 reasoning_content 占位', () => {
    const c = resolveMessageCompat('https://api.deepseek.com/v1', 'deepseek-v4-flash');
    expect(c.needsReasoningContentOnAssistant).toBe(true);
    expect(c.requiresAssistantAfterToolResult).toBe(false);
  });
  it('qwen/dashscope → tool 后需桥接 assistant', () => {
    const c = resolveMessageCompat('https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.7-max');
    expect(c.requiresAssistantAfterToolResult).toBe(true);
  });
  it('GLM 模型名 → tool 后需桥接（模型名优先于未知端点）', () => {
    const c = resolveMessageCompat('https://open.bigmodel.cn/api/paas/v4', 'glm-5.1');
    expect(c.requiresAssistantAfterToolResult).toBe(true);
  });
  it('TOOL_BRIDGE_ASSISTANT_TEXT 存在', () => {
    expect(typeof TOOL_BRIDGE_ASSISTANT_TEXT).toBe('string');
    expect(TOOL_BRIDGE_ASSISTANT_TEXT.length).toBeGreaterThan(0);
  });
});

describe('modelcompat：思考档位 → 请求参数（resolveThinkingParams）', () => {
  it('auto：不发任何参数（最安全默认）', () => {
    expect(resolveThinkingParams('auto', 'https://any.com/v1', 'any-model')).toEqual({});
  });
  it('off：deepseek 系 → thinking.disabled + reasoning_effort:none', () => {
    expect(resolveThinkingParams('off', 'https://opencode.ai/zen/go/v1', 'deepseek-v4-flash'))
      .toEqual({ thinking: { type: 'disabled' }, reasoning_effort: 'none' });
  });
  it('off：GLM/zai 系 → 只发 thinking.disabled（不盲发 reasoning_effort）', () => {
    expect(resolveThinkingParams('off', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.1'))
      .toEqual({ thinking: { type: 'disabled' } });
  });
  it('off：openrouter 系 → reasoning.effort none；模型名判定优先于端点', () => {
    expect(resolveThinkingParams('off', 'https://openrouter.ai/api/v1', 'openrouter/meta-llama/llama-3.3-70b'))
      .toEqual({ reasoning: { effort: 'none' } });
    expect(resolveThinkingParams('off', 'https://openrouter.ai/api/v1', 'openrouter/deepseek/deepseek-v4'))
      .toEqual({ thinking: { type: 'disabled' }, reasoning_effort: 'none' });
  });
  it('off：qwen 系 → enable_thinking:false', () => {
    expect(resolveThinkingParams('off', 'https://dashscope.aliyuncs.com/v1', 'qwen3-max'))
      .toEqual({ enable_thinking: false });
  });
  it('off：未知端点 → 尝试 reasoning_effort:none（400 由 api 降级）', () => {
    expect(resolveThinkingParams('off', 'https://unknown.com/v1', 'm'))
      .toEqual({ reasoning_effort: 'none' });
  });
  it('low/medium/high：未知端点 → reasoning_effort 对应值', () => {
    expect(resolveThinkingParams('low', 'https://unknown.com/v1', 'm')).toEqual({ reasoning_effort: 'low' });
    expect(resolveThinkingParams('medium', 'https://unknown.com/v1', 'm')).toEqual({ reasoning_effort: 'medium' });
    expect(resolveThinkingParams('high', 'https://unknown.com/v1', 'm')).toEqual({ reasoning_effort: 'high' });
  });
  it('medium：muse 类（commandcode + muse 名）→ reasoning_effort:medium（能吐 reasoning）', () => {
    expect(resolveThinkingParams('medium', 'https://api.commandcode.ai/provider/v1', 'meta/muse-spark-1.3-contributor'))
      .toEqual({ reasoning_effort: 'medium' });
  });
  it('off：muse 类 → reasoning_effort:none（muse 不接受 none 会 400 → api 降级摘除）', () => {
    expect(resolveThinkingParams('off', 'https://api.commandcode.ai/provider/v1', 'meta/muse-spark-1.3-contributor'))
      .toEqual({ reasoning_effort: 'none' });
  });
  it('medium：deepseek 官方端点 → thinking.enabled + reasoning_effort:medium', () => {
    expect(resolveThinkingParams('medium', 'https://api.deepseek.com/v1', 'deepseek-chat'))
      .toEqual({ thinking: { type: 'enabled' }, reasoning_effort: 'medium' });
  });
});
