// StorageManager：indexedDB（主存，kv store 'lnw_storage'）+ localStorage（备份/降级）。
// 迁移自 www/modules/storage.js（v2.0），行为逐行保持一致；挂 window 全局供未迁移模块使用。
// 约定：key 统一加 'lnw_' 前缀；>200KB 的大值（base64 头像等）跳过 localStorage 备份。
interface KVRow {
  [key: string]: unknown;
}

class StorageManagerClass {
  _cache: KVRow | null = null;
  _db: IDBDatabase | null = null;
  _initPromise: Promise<void> | null = null;

  /** 打开 indexedDB 并全量载入缓存；失败时降级为空缓存（只走 localStorage）。 */
  async init(): Promise<void> {
    if (this._initPromise) return this._initPromise;
    this._initPromise = (async () => {
      try {
        console.log('[IDB] init start');
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const req = indexedDB.open('lnw_storage', 1);
          req.onupgradeneeded = (e) => {
            console.log('[IDB] onupgradeneeded');
            const d = (e.target as IDBOpenDBRequest).result as IDBDatabase;
            if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        console.log('[IDB] db opened, name=', db.name, 'version=', db.version);
        this._db = db;
        // 全量载入缓存
        const tx = db.transaction('kv', 'readonly');
        const store = tx.objectStore('kv');
        const data = await new Promise<KVRow>((resolve, reject) => {
          const r1 = store.getAll();
          const r2 = store.getAllKeys();
          let vals: unknown[] | undefined;
          let keys: IDBValidKey[] | undefined;
          const finish = () => {
            const m: KVRow = {};
            const ks = keys as IDBValidKey[];
            const vs = vals as unknown[];
            for (let i = 0; i < ks.length; i++) m[String(ks[i])] = vs[i];
            resolve(m);
          };
          r1.onsuccess = () => { vals = r1.result; if (keys !== undefined) finish(); };
          r2.onsuccess = () => { keys = r2.result; if (vals !== undefined) finish(); };
          r1.onerror = () => reject(r1.error);
          r2.onerror = () => reject(r2.error);
        });
        // 从 localStorage 迁移（indexedDB 优先）
        for (let i = localStorage.length - 1; i >= 0; i--) {
          const k = localStorage.key(i);
          if (k && k.startsWith('lnw_') && !(k in data)) {
            try { data[k] = JSON.parse(localStorage.getItem(k) as string); } catch { /* 解析失败跳过 */ }
          }
        }
        console.log('[IDB] cache loaded, keys:', Object.keys(data).length);
        this._cache = data;
      } catch (e) {
        console.error('[IDB] init failed:', e);
        this._cache = {};
      }
    })();
    return this._initPromise;
  }

  get<T = unknown>(key: string, fallback: T | null = null): T | null {
    const k = 'lnw_' + key;
    if (this._cache && k in this._cache) return this._cache[k] as T;
    try { const raw = localStorage.getItem(k); return raw ? JSON.parse(raw) as T : fallback; }
    catch { return fallback; }
  }

  set(key: string, value: unknown): void {
    const k = 'lnw_' + key;
    if (this._cache) this._cache[k] = value;
    if (this._db) {
      try {
        const tx = this._db.transaction('kv', 'readwrite');
        tx.objectStore('kv').put(value, k);
      } catch (e) { console.warn('[IDB] set error:', e); }
    }
    // localStorage 备份：大数据（如 base64 头像，>200KB）跳过，避免撑爆配额。
    try {
      const json = JSON.stringify(value);
      const backup = !this._db || json.length <= 200 * 1024;
      if (backup) {
        localStorage.setItem(k, json);
      }
    } catch (e) {
      console.warn('[Storage] localStorage write failed for', k, '- quota?');
      if (!this._db) {
        console.error('[Storage] CRITICAL: No persistent storage available! Data for', k, 'may be lost.');
      }
    }
  }

  remove(key: string): void {
    const k = 'lnw_' + key;
    if (this._cache) delete this._cache[k];
    if (this._db) {
      try {
        const tx = this._db.transaction('kv', 'readwrite');
        tx.objectStore('kv').delete(k);
      } catch (e) { /* 尽力而为 */ }
    }
    localStorage.removeItem(k);
  }
}

const StorageManager = new StorageManagerClass();
// 顶层副作用保持不变：立即开始加载
const _storageInit = StorageManager.init();

// 挂全局：未迁移模块通过全局符号访问（与旧 storage.js 兼容）。
// 注意：lib.dom 已有全局 StorageManager（Web Storage API），故用断言而非 interface Window 合并。
const g = globalThis as unknown as {
  StorageManager: StorageManagerClass;
  _storageInit: Promise<void>;
};
g.StorageManager = StorageManager;
g._storageInit = _storageInit;

export { StorageManager, StorageManagerClass, _storageInit };