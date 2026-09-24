import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { UsageStats, _wbKey } from '../src/lib/usage';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

// APIHandler 桩：可控的 _apiCalls
const calls: { label: string; promptTokens?: number; cachedTokens?: number; completionTokens?: number; cost?: number }[] = [];
(globalThis as unknown as Record<string, unknown>).APIHandler = { _apiCalls: calls };
(globalThis as unknown as Record<string, unknown>).App = { toast: () => {} };
(globalThis as unknown as Record<string, unknown>).document = { getElementById: (): null => null };
// P3-B：usage 经 import 使用真实 WorldBookManager，测试覆写其 getActive 模拟当前书
(WBM as unknown as { getActive(): any }).getActive = (): any => ({ id: 'wb9' });

describe('UsageStats', () => {
  beforeEach(() => {
    calls.length = 0;
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('usageHistory', []);
  });

  it('endSession 汇总 tokens/费用/命中率', () => {
    UsageStats.beginSession();
    calls.push(
      { label: 'generate', promptTokens: 1000, cachedTokens: 500, completionTokens: 200, cost: 0.01 },
      { label: 'summary', promptTokens: 1000, cachedTokens: 500, completionTokens: 100, cost: 0.02 }
    );
    const rec = UsageStats.endSession(300);
    expect(rec).not.toBeNull();
    expect(rec!.apiCalls).toBe(2);
    expect(rec!.promptTokens).toBe(2000);
    expect(rec!.cachedTokens).toBe(1000);
    expect(rec!.completionTokens).toBe(300);
    expect(rec!.cost).toBeCloseTo(0.03);
    expect(rec!.hitRate).toBe('50.0');
    expect(rec!.wordCount).toBe(300);
    expect(rec!.byLabel['generate'].count).toBe(1);
    expect(rec!.byLabel['summary'].completionTokens).toBe(100);
  });

  it('无调用时返回 null 并收尾；重复 endSession 也为 null', () => {
    UsageStats.beginSession();
    expect(UsageStats.endSession(10)).toBeNull();
    // 空收尾必须把会话状态清干净（否则 beginSession 的"不抢已开会话"守卫会挡住下一轮记账）
    expect((UsageStats as unknown as { _sessionStartIndex: number | null })._sessionStartIndex).toBeNull();
    UsageStats.beginSession();
    calls.push({ label: 'x', promptTokens: 1 });
    expect(UsageStats.endSession(10)).not.toBeNull();
    expect(UsageStats.endSession(10)).toBeNull(); // 已结束
  });

  it('历史按 MAX_HISTORY 截断', () => {
    for (let i = 0; i < UsageStats.MAX_HISTORY + 3; i++) {
      UsageStats.beginSession();
      calls.push({ label: 'g', promptTokens: 10, completionTokens: 5, cost: 0.001 });
      UsageStats.endSession(i);
    }
    expect(UsageStats.getHistory().length).toBe(UsageStats.MAX_HISTORY);
    // 最新在前
    expect(UsageStats.getHistory()[0].wordCount).toBe(UsageStats.MAX_HISTORY + 2);
  });

  it('格式化工具', () => {
    expect(UsageStats.formatDuration(500)).toBe('500ms');
    expect(UsageStats.formatDuration(1500)).toBe('1.5s');
    expect(UsageStats.formatCost(0.123456789)).toBe('¥0.123457');
  });

  it('输出速度：tokens/秒（取代旧的 输入tokens/字 效率）', () => {
    // 1000 tokens / 5s = 200 tokens/s → 取整显示
    expect(UsageStats.formatSpeed(1000, 5000)).toBe('200 tokens/s');
    // 小于 100 保留一位小数
    expect(UsageStats.formatSpeed(250, 5000)).toBe('50.0 tokens/s');
    // 缺数据（无输出/无耗时）→ 占位符，不显示 Infinity/NaN
    expect(UsageStats.formatSpeed(0, 5000)).toBe('—');
    expect(UsageStats.formatSpeed(100, 0)).toBe('—');
    expect(UsageStats.outputSpeed(0, 0)).toBe(0);
  });

  it('记录里存了 duration，可供速度渲染使用', () => {
    UsageStats.beginSession();
    calls.push({ label: 'generate', promptTokens: 100, completionTokens: 50, cost: 0.001 });
    const rec = UsageStats.endSession(20);
    expect(rec!.duration).toBeGreaterThanOrEqual(0);
    expect(rec!.completionTokens).toBe(50);
  });

  it('_wbKey 按当前世界书加作用域后缀', () => {
    expect(_wbKey('activeOpeningId')).toBe('activeOpeningId_wb_wb9');
  });
});
// 用户报「续写用量不计算」的另一半原因：端点没回 usage 时，APIHandler 以前什么都不记
// → 本轮从用量统计里彻底消失（明明跑过请求）。现在会记一条 usageMissing 的调用，
// 记录里带上 noUsage 计数，用量页据此显示"本轮未取到用量"。
describe('端点未回 usage', () => {
  it('调用记了但没 token：仍然产出一条记录，并标出 noUsage', () => {
    UsageStats.beginSession();
    calls.push({ label: 'generate', usageMissing: true } as never);
    const rec = UsageStats.endSession(120);
    expect(rec).not.toBeNull();
    expect(rec!.apiCalls).toBe(1);
    expect(rec!.noUsage).toBe(1);
    expect(rec!.promptTokens).toBe(0);
    expect(rec!.completionTokens).toBe(0);
    expect(rec!.wordCount).toBe(120);
  });

  it('beginSession 不抢已经开着的那一轮（两个模式交叠时不串账）', () => {
    UsageStats.beginSession();
    const first = (UsageStats as unknown as { _sessionStartIndex: number | null })._sessionStartIndex;
    calls.push({ label: 'generate', promptTokens: 10, completionTokens: 5, cost: 0 });
    UsageStats.beginSession();                       // 第二轮想插队 → 被挡住
    expect((UsageStats as unknown as { _sessionStartIndex: number | null })._sessionStartIndex).toBe(first);
    const rec = UsageStats.endSession(1);
    expect(rec!.apiCalls).toBe(1);                   // 先开那一轮的账没被抢走
  });
});
