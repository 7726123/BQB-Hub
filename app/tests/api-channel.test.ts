import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/infra/storage';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;

// App 渠道逻辑是 app.ts 的方法（需 App 全局），这里聚焦存储层契约：
// apiChannels / activeApiChannelId 与 apiConfig 同步的语义
describe('多渠道供应商存储契约', () => {
  beforeEach(() => {
    sm().set('apiChannels', []);
    sm().set('activeApiChannelId', '');
  });

  it('apiChannels 为数组且可持久化', async () => {
    const chs = [{ id: 'ch1', name: 'opencode', endpoint: 'https://opencode.ai/zen/go/v1', apiKey: 'k1', model: 'deepseek-v4-flash' }];
    await sm().set('apiChannels', chs);
    const read = sm().get<any[]>('apiChannels', []) || [];
    expect(read).toHaveLength(1);
    expect(read[0].name).toBe('opencode');
    const active = sm().get<string>('activeApiChannelId', '');
    expect(active).toBe('');
  });

  it('活跃渠道 id 独立存储', async () => {
    await sm().set('activeApiChannelId', 'ch2');
    expect(sm().get<string>('activeApiChannelId', '')).toBe('ch2');
  });

  it('渠道字段与 apiConfig 字段命名对齐（同步时可直接赋值）', async () => {
    const ch = { id: 'ch9', name: 'deepseek-官方', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-x', model: 'deepseek-v4', priceInput: 2, priceCached: 0.5, priceOutput: 8 };
    await sm().set('apiConfig', {
      endpoint: ch.endpoint, apiKey: ch.apiKey, model: ch.model,
      priceInput: ch.priceInput, priceCached: ch.priceCached, priceOutput: ch.priceOutput,
    });
    const cfg = sm().get<any>('apiConfig', {});
    expect(cfg.endpoint).toBe('https://api.deepseek.com/v1');
    expect(cfg.model).toBe('deepseek-v4');
    expect(cfg.priceOutput).toBe(8);
  });
});
