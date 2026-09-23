// 归档回读注入的预算闸门与去重键（三条通道共用）。
// 回归背景：点名锚/实体直收原先无条件塞入，真机留档实测注入 42182 字（预算 10000 的 4.2 倍），
// 且同一片段被塞 3 次，预算吃光后「按分数填充」通道一条都进不来。
import { describe, it, expect } from 'vitest';
import { recallKey, recallFits } from '../src/lib/recallgate';

describe('recallFits：首条可超预算，其余不得超', () => {
  it('首条即使比预算大也给（避免整轮空注入）', () => {
    expect(recallFits(0, 9000, 10000, 0)).toBe(true);
    expect(recallFits(0, 60000, 10000, 0)).toBe(true);
  });

  it('已有片段后严格不超预算（旧行为在此放行 → 4.2 倍超支）', () => {
    expect(recallFits(42000, 8000, 10000, 6)).toBe(false);
    expect(recallFits(6000, 3000, 10000, 3)).toBe(true);
    expect(recallFits(6000, 4001, 10000, 3)).toBe(false);
    expect(recallFits(6000, 4000, 10000, 3)).toBe(true);
  });

  it('模拟整块 8000 字的真机回归：6 条点名锚只进 1 条', () => {
    const budget = 10000;
    const blocks = Array.from({ length: 6 }, (_, i) => 'B' + i + '字'.repeat(7998));
    const seen: Record<string, number> = {};
    let used = 0;
    const picked: string[] = [];
    blocks.forEach(function (text) {
      const key = recallKey(text);
      if (!key || seen[key]) return;
      if (!recallFits(used, text.length, budget, picked.length)) return;
      seen[key] = 1; picked.push(text); used += text.length;
    });
    expect(picked.length).toBe(1);                       // 修复前是 6 条 = 42k 字
    expect(used).toBeLessThanOrEqual(Math.max(budget, blocks[0].length));
  });

  it('同片段重复（点名 + 直收撞块）只进一次', () => {
    const budget = 10000;
    const text = '同'.repeat(3000);
    const seen: Record<string, number> = {};
    let used = 0;
    let count = 0;
    for (let i = 0; i < 3; i++) {
      const key = recallKey(text);
      if (!key || seen[key]) continue;
      if (!recallFits(used, text.length, budget, count)) continue;
      seen[key] = 1; count++; used += text.length;
    }
    expect(count).toBe(1);
    expect(used).toBe(3000);
  });
});

describe('recallKey：忽略空白、取前 40 字', () => {
  it('空白差异视为同片段', () => {
    expect(recallKey('甲 乙\n丙')).toBe(recallKey('甲乙丙'));
  });

  it('长度上限 40 字，空输入返回空串', () => {
    expect(recallKey('字'.repeat(100)).length).toBe(40);
    expect(recallKey('')).toBe('');
    expect(recallKey('   ')).toBe('');
  });
});
