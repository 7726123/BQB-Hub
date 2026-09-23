// MemoryQueryBuilder 判别词工具单测：countTermHits / rareBigrams。
import { describe, it, expect } from 'vitest';
import { MemoryQueryBuilder } from '../src/lib/bm25';

describe('MemoryQueryBuilder 判别词工具', () => {
  it('countTermHits：统计共享判别词数', () => {
    expect(MemoryQueryBuilder.countTermHits('剑术与师徒', ['剑术', '师徒', '绸缎'])).toBe(2);
    expect(MemoryQueryBuilder.countTermHits('剑术', ['剑术', '师徒'])).toBe(1);
  });

  it('rareBigrams：df 范围内升序取前 N（df=1 是唯一锚点，纳入）', () => {
    const m: Record<string, number> = { 剑术: 5, 师徒: 4, 绸缎: 30, 皇城: 1, 师兄: 6 };
    const rare = MemoryQueryBuilder.rareBigrams('剑术师徒绸缎皇城师兄', (t) => m[t] || 0, 8);
    // df 1..12（绸缎 30 出局），按 df 升序：皇城 df=1 是唯一锚点排最前
    expect(rare).toEqual(['皇城', '师徒', '剑术', '师兄']);
  });
});
