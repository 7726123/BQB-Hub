import { describe, it, expect, beforeEach } from 'vitest';
import { StorageManager } from '../src/infra/storage';

describe('StorageManager（降级环境：无 IndexedDB，localStorage 桩）', () => {
  beforeEach(() => {
    (globalThis as unknown as { localStorage: Storage }).localStorage.clear();
    // 重置内部状态，模拟新会话
    StorageManager._cache = null;
    StorageManager._db = null;
    StorageManager._initPromise = null;
  });

  it('init 在无 IndexedDB 时降级为空缓存而不抛错', async () => {
    await StorageManager.init();
    expect(StorageManager._cache).toEqual({});
  });

  it('set/get/remove 往返', async () => {
    await StorageManager.init();
    StorageManager.set('testKey', { a: 1 });
    expect(StorageManager.get('testKey')).toEqual({ a: 1 });
    expect((globalThis as unknown as { localStorage: Storage }).localStorage.getItem('lnw_testKey')).toBe('{"a":1}');
    StorageManager.remove('testKey');
    expect(StorageManager.get('testKey')).toBeNull();
  });

  it('get 未命中时返回 fallback', () => {
    expect(StorageManager.get('no-such-key', 'fb')).toBe('fb');
  });

  it('大值（>200KB）在有 IDB 时跳过 localStorage 备份', () => {
    // 伪造一个最小 IDB 对象：让 _db 为 truthy，backup 判断走 json.length <= 200KB
    const fakeDb = {
      transaction: () => ({ objectStore: () => ({ put: () => {}, delete: () => {} }) })
    } as unknown as IDBDatabase;
    StorageManager._db = fakeDb;
    StorageManager._cache = {};
    const big = 'x'.repeat(300 * 1024);
    StorageManager.set('bigVal', big);
    expect(StorageManager.get('bigVal')).toBe(big); // cache 有
    expect((globalThis as unknown as { localStorage: Storage }).localStorage.getItem('lnw_bigVal')).toBeNull(); // 备份跳过
    StorageManager._db = null;
  });

  it('小值始终备份到 localStorage', () => {
    StorageManager._cache = {};
    StorageManager.set('smallVal', 'hi');
    expect((globalThis as unknown as { localStorage: Storage }).localStorage.getItem('lnw_smallVal')).toBe('"hi"');
  });
});