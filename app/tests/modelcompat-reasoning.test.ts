// 原生推理通道判定（modelcompat.hasNativeReasoning）：
// 写作端据此决定「要不要让模型把思维链写成正文」——判错会让模型白写一遍 CoT（正文进思维链/输出两遍）。
// 2026-09-25 实测火山方舟 coding 套餐：doubao-seed-2-1-lite-260915 / -pro-260915 / deepseek-v4-1-flash-260910
// 都回 reasoning_content（SSE 也是 reasoning_content 增量），所以 seed/doubao 系必须按"原生推理"处理。
import { describe, it, expect } from 'vitest';
import { hasNativeReasoning } from '../src/domain/modelcompat';

describe('hasNativeReasoning：自带 reasoning_content 通道的模型', () => {
  it('方舟实测会回 reasoning_content 的模型名', () => {
    expect(hasNativeReasoning('doubao-seed-2-1-lite-260915')).toBe(true);
    expect(hasNativeReasoning('doubao-seed-2-1-pro-260915')).toBe(true);
    expect(hasNativeReasoning('doubao-seed-1-6-thinking-250715')).toBe(true);
    expect(hasNativeReasoning('deepseek-v4-1-flash-260910')).toBe(true);
    expect(hasNativeReasoning('deepseek-chat')).toBe(true);
  });

  it('其他已知原生推理系（保持原有行为）', () => {
    ['kimi-k2-0905', 'glm-4-plus', 'qwen-max', 'qwen3-32b-20250429', 'opencode/gpt-5', 'moonshot-v1-8k', 'v3-0324']
      .forEach(m => expect(hasNativeReasoning(m), m).toBe(true));
  });

  it('未收录的模型名不再假设原生推理（保持旧的保守行为；Claude/GPT 走各自的 thinking 参数方言）', () => {
    expect(hasNativeReasoning('claude-3-7-sonnet')).toBe(false);
    expect(hasNativeReasoning('gpt-5.1')).toBe(false);
    expect(hasNativeReasoning('my-local-llama-3-8b')).toBe(false);
    expect(hasNativeReasoning('')).toBe(false);
  });
});
