// 价格表口径（app.ts）：默认价与一次性迁移。
// 背景：旧默认 1 / 0.1 / 2 把缓存价按"输入的 10%"估，而真实是 2%（命中便宜 50 倍）——
// 用量页显示的"常驻大正文"费用会虚高，误导窗口决策。只迁「从没被改过」的那份。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/app';

const g = globalThis as unknown as Record<string, any>;
const App = () => g.App;
const SM = () => g.StorageManager as { get: (k: string, d?: any) => any; set: (k: string, v: any) => void; remove: (k: string) => void };

describe('价格表：新默认与存量迁移', () => {
  beforeEach(() => {
    SM().remove('apiChannels');
    SM().remove('apiConfig');
    SM().remove('_pricesV2');
  });

  it('默认价 = 2 / 0.04 / 8（元/百万 token，DeepSeek V4.1 峰时；缓存 = 输入的 2%）', () => {
    expect(App().getPricingConfig()).toEqual({ input: 2e-6, cached: 0.04e-6, output: 8e-6 });
  });

  it('从没改过价格的渠道（1 / 0.1 / 2）迁到新默认，且只迁一次', () => {
    SM().set('apiChannels', [{ id: 'c1', name: '某供应商', priceInput: 1, priceCached: 0.1, priceOutput: 2 }]);
    expect(App().migrateLegacyPrices()).toBe(1);
    const ch = SM().get('apiChannels')[0];
    expect([ch.priceInput, ch.priceCached, ch.priceOutput]).toEqual([2, 0.04, 8]);
    expect(App().migrateLegacyPrices()).toBe(0);          // 标记已置 → 不再动
  });

  it('自己填过价格的渠道一律不动（迁移只认"恰好等于旧默认"）', () => {
    SM().set('apiChannels', [{ id: 'c1', name: 'x', priceInput: 3, priceCached: 0.5, priceOutput: 6 }]);
    expect(App().migrateLegacyPrices()).toBe(0);
    const ch = SM().get('apiChannels')[0];
    expect([ch.priceInput, ch.priceCached, ch.priceOutput]).toEqual([3, 0.5, 6]);
  });

  it('一个价格字段都没有的渠道/配置不动（还没填过，界面默认值生效）', () => {
    SM().set('apiChannels', [{ id: 'c1', name: 'x' }]);
    expect(App().migrateLegacyPrices()).toBe(0);
    expect(SM().get('apiChannels')[0].priceCached).toBeUndefined();
  });

  it('旧版单渠道 apiConfig 同样迁移', () => {
    SM().set('apiConfig', { endpoint: 'https://x/v1', priceInput: 1, priceCached: 0.1, priceOutput: 2 });
    expect(App().migrateLegacyPrices()).toBe(1);
    expect(SM().get('apiConfig').priceInput).toBe(2);
  });

  it('用户当前模型 deepseek/deepseek-v4.1-flash 在内置价格表里，且与实测口径一致', () => {
    expect(App().resolveModelPricing('deepseek/deepseek-v4.1-flash')).toEqual({ input: 2, cached: 0.04, output: 8 });
    expect(App().resolveModelPricing('deepseek-v4.1-flash')).toEqual({ input: 2, cached: 0.04, output: 8 });
  });
});

describe('窗口设置：旧默认 5 万字 → 自动（一次性）', () => {
  beforeEach(() => {
    SM().remove('storyWindowChars');
    SM().remove('_storyWindowAutoV2');
  });

  it('存着旧默认 50000 的切到「自动」（否则永远走不到按模型上下文算的大窗口）', () => {
    SM().set('storyWindowChars', 50000);
    expect(App().migrateLegacyStoryWindow()).toBe(true);
    expect(App()._storyWindowChars()).toBe(0);              // 0 = 自动
    expect(App().migrateLegacyStoryWindow()).toBe(false);   // 只迁一次
  });

  it('用户手填过的其它值一律不动（明确选择）', () => {
    SM().set('storyWindowChars', 80000);
    expect(App().migrateLegacyStoryWindow()).toBe(false);
    expect(App()._storyWindowChars()).toBe(80000);
  });

  it('没存过值时不写入任何东西（本来就是自动）', () => {
    expect(App().migrateLegacyStoryWindow()).toBe(false);
    expect(App()._storyWindowChars()).toBe(0);
  });
});

describe('端点上下文上限 → 窗口预算自动收窄（A 类修复）', () => {
  const g = globalThis as unknown as Record<string, any>;
  it('端点档案里学到 131072 时：有效上下文按它算，窗口同步收窄（换到小上下文渠道不会撑爆请求）', () => {
    const prevAH = g.APIHandler, prevPM = g.PresetManager;
    try {
      SM().set('modelContextTokens', 800000);
      g.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://ark.example/api/coding/v3', model: 'doubao-seed-2-1-lite' }) };
      g.APIHandler = { endpointContextCap: (ep: string) => (ep.indexOf('ark.example') >= 0 ? 131072 : 0) };
      expect(App()._modelContextTokens()).toBe(800000);        // 用户填的还是 80 万
      expect(App()._effectiveContextTokens()).toBe(131072);    // 但算窗口时按端点实测上限
      // (131072×1.4 − 0 − 20000) ÷ 1.5 = 109000 → 取整到万位
      expect(App()._effectiveStoryWindow(0)).toBe(100000);
      // 别的端点没有上限 → 仍按 80 万算（40 万封顶）
      g.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://other.example/v1', model: 'm' }) };
      expect(App()._effectiveContextTokens()).toBe(800000);
      expect(App()._effectiveStoryWindow(0)).toBe(400000);
    } finally {
      g.APIHandler = prevAH; g.PresetManager = prevPM;
      SM().remove('modelContextTokens');
    }
  });
  it('拿不到端点档案（老环境/异常）不影响：按全局值算', () => {
    const prevAH = g.APIHandler;
    try {
      g.APIHandler = undefined;
      SM().set('modelContextTokens', 800000);
      expect(App()._effectiveContextTokens()).toBe(800000);
    } finally { g.APIHandler = prevAH; SM().remove('modelContextTokens'); }
  });
});
