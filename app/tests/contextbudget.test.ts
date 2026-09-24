// 正文窗口：默认「自动」（按模型可用上下文反推，自动值封顶 40 万字），也可手动固定。
// 口径依据（2026-09-26 真 API 实测 + 成本建模，见交接文档 §13.51）：
// 命中价 0.04 / miss 2 / 输出 8（元/百万 token，实测小说散文 1.408 字/token），
// 同一 prompt 重发命中 99.9%、改中段 47%、**窗口左移（滚动）0%**。
// 旧口径「上下文 256k × 1.4 × 50% = 17.9 万字」写死过一次，又改成写死 5 万字——
// 两次都是拍脑袋；现在只让用户对「模型能用多少 token」负责。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/archive';
import '../src/domain/app';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import {
  normalizeStoryWindow, storyWindowTrigger, estimateTokens, wanChars,
  normalizeModelContext, windowFromContext, recallNeeded,
  STORY_WINDOW_DEFAULT, STORY_WINDOW_MIN, STORY_WINDOW_MAX, STORY_WINDOW_AUTO, AUTO_WINDOW_CAP,
  MODEL_CONTEXT_DEFAULT, MODEL_CONTEXT_MIN, MODEL_CONTEXT_MAX, CHARS_PER_TOKEN,
} from '../src/lib/contextbudget';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
const AS = () => (globalThis as unknown as { ArchiveStore: typeof import('../src/domain/archive').ArchiveStore }).ArchiveStore;
const WL = () => (globalThis as unknown as { Waterline: typeof import('../src/domain/archive').Waterline }).Waterline;
const App = () => (globalThis as unknown as { App: any }).App;

const ROLLING = 5000; // Waterline.ROLLING：滚动区固定保留的原文（窗口之后）

describe('模型可用上下文：夹取与默认值', () => {
  it('默认 80 万（1M 上下文留边界）；非法值回默认，越界夹取', () => {
    expect(MODEL_CONTEXT_DEFAULT).toBe(800000);
    expect(normalizeModelContext(undefined)).toBe(MODEL_CONTEXT_DEFAULT);
    expect(normalizeModelContext('')).toBe(MODEL_CONTEXT_DEFAULT);
    expect(normalizeModelContext(0)).toBe(MODEL_CONTEXT_DEFAULT);
    expect(normalizeModelContext(-1)).toBe(MODEL_CONTEXT_DEFAULT);
    expect(normalizeModelContext('abc')).toBe(MODEL_CONTEXT_DEFAULT);
    expect(normalizeModelContext(1000)).toBe(MODEL_CONTEXT_MIN);
    expect(normalizeModelContext(99_999_999)).toBe(MODEL_CONTEXT_MAX);
    expect(normalizeModelContext('200000')).toBe(200000);
  });
});

describe('normalizeStoryWindow：0/空 = 自动，其余夹取', () => {
  it('默认「自动」（0）；空串/0/负/NaN 一律回自动', () => {
    expect(STORY_WINDOW_DEFAULT).toBe(STORY_WINDOW_AUTO);
    expect(STORY_WINDOW_AUTO).toBe(0);
    expect(normalizeStoryWindow(undefined)).toBe(0);
    expect(normalizeStoryWindow('')).toBe(0);
    expect(normalizeStoryWindow(0)).toBe(0);
    expect(normalizeStoryWindow(-100)).toBe(0);
    expect(normalizeStoryWindow('abc')).toBe(0);
    expect(normalizeStoryWindow(1)).toBe(STORY_WINDOW_MIN);        // 太小 → 下限（冻结前缀没意义）
    expect(normalizeStoryWindow(9_999_999)).toBe(STORY_WINDOW_MAX); // 太大 → 上限
    expect(normalizeStoryWindow(80000)).toBe(80000);               // 区间内原样
    expect(normalizeStoryWindow('60000')).toBe(60000);             // 表单字符串
  });

  it('触发线 = 窗口 × 1.5', () => {
    expect(storyWindowTrigger(50000)).toBe(75000);
    expect(storyWindowTrigger(STORY_WINDOW_MIN)).toBe(15000);
    expect(storyWindowTrigger(undefined)).toBe(0); // 自动（0）→ 0，由调用方给有效窗口
  });

  it('token 估算与万字显示（中文约 1.4 字/token）', () => {
    expect(estimateTokens(70000)).toBe(50000);
    expect(wanChars(50000)).toBe('5.0');
    expect(wanChars(12345)).toBe('1.2');
  });
});

describe('windowFromContext：自动窗口 = （可用 token × 字/token − 世界书 − 杂项）÷ 1.5', () => {
  it('默认 80 万 token：算式值 66 万字被自动天花板压到 40 万字，触发线 60 万字仍在预算内', () => {
    const win = windowFromContext({ contextTokens: MODEL_CONTEXT_DEFAULT, worldBookChars: 100000 });
    // (800000×1.4 − 100000 − 20000) ÷ 1.5 = 666666 → 取整到万位 → 超 AUTO_WINDOW_CAP(40万) → 压到 40 万
    expect(win).toBe(AUTO_WINDOW_CAP);
    expect(win).toBe(400000);
    const trig = storyWindowTrigger(win);
    expect(trig).toBe(600000);
    // 关键安全性质：触发线（真正塞进 prompt 的正文上限）不超过预算
    const budgetChars = MODEL_CONTEXT_DEFAULT * CHARS_PER_TOKEN - 100000 - 20000;
    expect(trig).toBeLessThanOrEqual(budgetChars);
  });

  it('小模型/大世界书时会算出比天花板更小的窗口（天花板只封顶、不抬底）', () => {
    const small = windowFromContext({ contextTokens: 200000, worldBookChars: 0 });
    expect(small).toBeLessThan(AUTO_WINDOW_CAP);
    expect(small).toBe(170000);   // (200000×1.4 − 20000) ÷ 1.5 = 173333 → 取整到万位
  });

  it('世界书越大窗口越小（同一份预算里让位给世界书）', () => {
    // 用 20 万 token 的小上下文，避开自动天花板（40 万），才看得到世界书的影响
    const big = windowFromContext({ contextTokens: 200000, worldBookChars: 100000 });
    const small = windowFromContext({ contextTokens: 200000, worldBookChars: 20000 });
    expect(small).toBeGreaterThan(big);
    // 世界书 0 字时窗口最大
    expect(windowFromContext({ contextTokens: 200000, worldBookChars: 0 }))
      .toBeGreaterThan(small);
  });

  it('上下文太小（连世界书都装不下）→ 回下限，不出现 0/负窗口', () => {
    expect(windowFromContext({ contextTokens: MODEL_CONTEXT_MIN, worldBookChars: 200000 })).toBe(STORY_WINDOW_MIN);
    // 0/空/非法 = 没设过 → 用默认 80 万（不是把窗口算成 0）
    expect(windowFromContext({ contextTokens: 0, worldBookChars: 0 }))
      .toBe(windowFromContext({ contextTokens: MODEL_CONTEXT_DEFAULT, worldBookChars: 0 }));
  });

  it('窗口随上下文单调不减，且一律不超过自动天花板', () => {
    const a = windowFromContext({ contextTokens: 200000, worldBookChars: 0 });
    const b = windowFromContext({ contextTokens: 500000, worldBookChars: 0 });
    const c = windowFromContext({ contextTokens: MODEL_CONTEXT_MAX, worldBookChars: 0 });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThanOrEqual(AUTO_WINDOW_CAP);
    expect(c).toBe(AUTO_WINDOW_CAP);
  });
});

describe('recallNeeded：只有正文真的滚进过归档才注入回读', () => {
  it('有归档块但窗口没左移（x=0）→ 不注入（全文都在 prompt 里，回读是重复且按 miss 计价）', () => {
    expect(recallNeeded(10, 0)).toBe(false);
    expect(recallNeeded(0, 50000)).toBe(false);
    expect(recallNeeded(0, 0)).toBe(false);
    expect(recallNeeded(undefined, undefined)).toBe(false);
  });
  it('归档块存在且窗口已左移 → 注入', () => {
    expect(recallNeeded(1, 8000)).toBe(true);
    expect(recallNeeded(10, 1)).toBe(true);
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

  it('大窗口（自动 40 万字）几乎不滚；5 万字窗口一半以上的轮次都在滚（每滚一次正文整段 miss）', () => {
    const auto = windowFromContext({ contextTokens: 800000, worldBookChars: 100000 });
    const sim = (win: number, rounds: number) => {
      WL().clear();
      let rollTurns = 0;
      for (let i = 1; i <= rounds; i++) {                 // 每轮追加 2.5 万字，共 100 万字
        const r = WL().update(text(i * 25000), win, storyWindowTrigger(win));
        if (r.rolled > 0) rollTurns++;
      }
      return rollTurns;
    };
    const bigTurns = sim(auto, 40);
    const smallTurns = sim(50000, 40);
    expect(smallTurns).toBeGreaterThan(15);   // 40 轮里近一半在滚
    expect(bigTurns).toBeLessThanOrEqual(3);
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

  it('设置项读写：setStoryWindow 夹取并落盘，_storyWindowChars 读回；空 = 自动', () => {
    expect(App().setStoryWindow(12000)).toBe(12000);
    expect(sm().get('storyWindowChars', -1)).toBe(12000);
    expect(App()._storyWindowChars()).toBe(12000);
    expect(App().setStoryWindow('')).toBe(0);                  // 清空 = 自动
    expect(App()._storyWindowChars()).toBe(0);
    expect(App().setStoryWindow('x')).toBe(0);                 // 非法输入也回自动
    expect(App()._storyWindowChars()).toBe(0);
  });

  it('有效窗口：手动值优先；自动时按模型上下文 + 世界书字号算', () => {
    App().setStoryWindow('');
    sm().set('modelContextTokens', 800000);
    const wb = WBM.getActive()!;
    wb.entries = [{ id: 'x1', type: '角色', name: '甲', content: '甲'.repeat(80000), inject: true } as any];
    WBM.saveAll(WBM.getAll());
    expect(App()._injectedWbChars()).toBeGreaterThan(70000);
    expect(App()._effectiveStoryWindow(100000)).toBe(AUTO_WINDOW_CAP);   // 算式 66 万字 → 自动天花板 40 万
    App().setStoryWindow(30000);
    expect(App()._effectiveStoryWindow(100000)).toBe(30000);   // 手动值说了算
    App().setStoryWindow('');
  });
});
