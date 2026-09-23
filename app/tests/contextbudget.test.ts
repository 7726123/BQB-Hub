// 正文窗口：单一设置（字），取代旧的「上下文 tokens × 每 token 字符数 × 50%」。
// 回归背景：默认 256k × 1.4 会算出 17.9 万字窗口，每次续写光正文就喂 ≈12.8 万 token，
// 加上世界书 10 万 + 回读 3 万 ≈ 22 万 token；而用户填的 tokens 未必是模型真实窗口。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/archive';
import '../src/domain/app';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import {
  normalizeStoryWindow, storyWindowTrigger, estimateTokens, wanChars,
  STORY_WINDOW_DEFAULT, STORY_WINDOW_MIN, STORY_WINDOW_MAX,
} from '../src/lib/contextbudget';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
const AS = () => (globalThis as unknown as { ArchiveStore: typeof import('../src/domain/archive').ArchiveStore }).ArchiveStore;
const WL = () => (globalThis as unknown as { Waterline: typeof import('../src/domain/archive').Waterline }).Waterline;
const App = () => (globalThis as unknown as { App: any }).App;

const ROLLING = 5000; // Waterline.ROLLING：滚动区固定保留的原文（窗口之后）

describe('normalizeStoryWindow：夹取与默认值', () => {
  it('默认 5 万字；非法值（空/0/负/NaN/超大）一律回默认或夹到边界', () => {
    expect(STORY_WINDOW_DEFAULT).toBe(50000);
    expect(normalizeStoryWindow(undefined)).toBe(STORY_WINDOW_DEFAULT);
    expect(normalizeStoryWindow('')).toBe(STORY_WINDOW_DEFAULT);
    expect(normalizeStoryWindow(0)).toBe(STORY_WINDOW_DEFAULT);
    expect(normalizeStoryWindow(-100)).toBe(STORY_WINDOW_DEFAULT);
    expect(normalizeStoryWindow('abc')).toBe(STORY_WINDOW_DEFAULT);
    expect(normalizeStoryWindow(1)).toBe(STORY_WINDOW_MIN);        // 太小 → 下限（冻结前缀没意义）
    expect(normalizeStoryWindow(9_999_999)).toBe(STORY_WINDOW_MAX); // 太大 → 上限
    expect(normalizeStoryWindow(80000)).toBe(80000);               // 区间内原样
    expect(normalizeStoryWindow('60000')).toBe(60000);             // 表单字符串
  });

  it('触发线 = 窗口 × 1.5（5 万字 → 7.5 万字）', () => {
    expect(storyWindowTrigger(50000)).toBe(75000);
    expect(storyWindowTrigger(STORY_WINDOW_MIN)).toBe(15000);
    expect(storyWindowTrigger(undefined)).toBe(75000); // 默认值推导
  });

  it('token 估算与万字显示（中文约 1.4 字/token）', () => {
    expect(estimateTokens(70000)).toBe(50000);
    expect(wanChars(50000)).toBe('5.0');
    expect(wanChars(12345)).toBe('1.2');
  });
});

describe('Waterline 按新口径滚动（窗口 = 设定值，1.5 倍触发）', () => {
  let bookId = '';
  beforeEach(() => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    const wb = WBM.createBook('书1');
    bookId = wb.id;
    sm().remove('archive_' + bookId); sm().remove('wline_' + bookId);
  });
  const text = (n: number) => '一'.repeat(n);

  it('窗口未超触发线：不滚动（滚动区固定留最后 5000 字）', () => {
    const win = 50000;
    const r = WL().update(text(60000), win, storyWindowTrigger(win));
    expect(r.rolled).toBe(0);
    expect(r.head).toBe(60000 - ROLLING); // 全部留在窗口里（未超 7.5 万）
  });

  it('超过触发线：滚到 ≤ 窗口，滚出的原文进归档（不丢字）', () => {
    const win = 50000;
    const total = 100000;
    const r = WL().update(text(total), win, storyWindowTrigger(win));
    expect(r.rolled).toBeGreaterThan(0);
    expect(r.head).toBeLessThanOrEqual(win);           // 回落到窗口以内
    expect(AS().count()).toBeGreaterThan(0);           // 原文进归档，可被回读
    const archived = AS().allBlocks().reduce((n, b) => n + b.text.length, 0);
    expect(archived + r.head + ROLLING).toBe(total);   // 归档 + 窗口 + 滚动区 == 全文
  });

  it('窗口调小后同样按新值收敛（老用户从 17.9 万降到 5 万）', () => {
    const big = 179200;                               // 旧默认：256k × 1.4 × 50%
    const first = WL().update(text(big), big, Math.floor(big * 1.5));
    expect(first.rolled).toBe(0);
    expect(first.head).toBe(big - ROLLING);
    const r = WL().update(text(big), 50000, storyWindowTrigger(50000));
    expect(r.head).toBeLessThanOrEqual(50000);
    expect(r.rolled).toBeGreaterThan(0);
  });

  it('设置项读写：setStoryWindow 夹取并落盘，_storyWindowChars 读回', () => {
    expect(App().setStoryWindow(12000)).toBe(12000);
    expect(sm().get('storyWindowChars', 0)).toBe(12000);
    expect(App()._storyWindowChars()).toBe(12000);
    expect(App().setStoryWindow('x')).toBe(STORY_WINDOW_DEFAULT); // 非法输入回默认
    expect(sm().get('storyWindowChars', 0)).toBe(STORY_WINDOW_DEFAULT);
    expect(App()._storyWindowChars()).toBe(STORY_WINDOW_DEFAULT);
  });
});
