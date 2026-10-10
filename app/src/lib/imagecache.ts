// 生成图片的本地存档（IndexedDB 专库）——解决"重开 App 后图片全变「已过期」"。
//
// 为什么不走 StorageManager：SM 启动时会把所有值全量读进内存，且 <200KB 的值还会镜像到
// localStorage（5MB 配额）——一张原图 dataURL 就 1~2MB，塞进去会把 localStorage 挤爆。
// 这里单开一个库：store 'imgs' 放重数据（thumb/full/元数据），store 'idx' 放轻索引
// （key/book/id/at/bytes）——剔除（prune）只看 idx，不把大字符串读进内存。
//
// 约定：
//  · 所有函数都不抛（配额满 / 没有 indexedDB / 被无痕模式禁掉都只降级，绝不影响出图与渲染）；
//  · 没有 indexedDB 时退化成内存后端（只在本会话有效；测试环境走的就是这条）；
//  · 一张图归一本书（book）所有：按书删（清空对话 / 删书）不会碰到别的书。
export interface CachedImage {
  key: string;
  book: string;
  id: string;
  thumb: string;
  full: string;
  at: number;
  bytes: number;
  seed?: unknown;
  size?: string;
  seconds?: number;
  prompt?: string;
  base?: string;
  hires?: boolean;
  jobId?: string;
  /** true = 用户自己上传的图片（写卡「上传图片」），不是生成的：没有 seed/耗时，界面上要标出来 */
  uploaded?: boolean;
}
export type CachedImageInput = Omit<CachedImage, 'key' | 'bytes'>;

export interface CacheMeta { key: string; book: string; id: string; at: number; bytes: number }

/** 每本书最多留几张（与内存句柄表上限一致）。2026-10-08 用户定了淘汰口径：
 *  **只在本对话（当前书）里淘汰、只删这本书里最早的图；别的书——尤其没打开过的——一张都不动**。
 *  原来那条"全库合计 120MB、超了删全局最旧的"规则**已删除**（它会让老会话的图无故消失）；
 *  超限时**不提示**用户（用户明确不要提示）。 */
export const BOOK_KEEP = 12;

export function cacheKey(book: string, id: string): string {
  return String(book || '') + '|' + String(id || '');
}

/** 纯逻辑：给定索引行 → 该删哪些 key。2026-10-08 起**只处理一本书**（opts.book）：
 *  该书按 at 倒序保留最新 bookKeep 张，多出来的（最早的）删掉；**别的书一律不参与**——
 *  这是用户定的口径："不要删没打开的书的图，只删这本书的老的图"。
 *  opts.book 缺省（undefined）= 仍按"每本书各自裁剪"处理（测试/兜底用）；传 '' 表示只处理"无归属"那一组。 */
export function planPrune(metas: CacheMeta[], opts?: { book?: string; bookKeep?: number }): string[] {
  const bookKeep = (opts && opts.bookKeep) || BOOK_KEEP;
  const only = (opts && typeof opts.book === 'string') ? String(opts.book) : null;
  const byKey = new Map<string, CacheMeta>();
  for (const m of metas || []) {
    if (!m || !m.key) continue;
    if (only !== null && String(m.book || '') !== only) continue;   // 不是这本书：连看都不看
    byKey.set(m.key, m);
  }
  const out = new Set<string>();
  // 每本书（这里最多只有一本）保留最新 bookKeep 张，按 at 倒序，多出来的删
  const groups = new Map<string, CacheMeta[]>();
  for (const m of byKey.values()) {
    const arr = groups.get(m.book) || [];
    arr.push(m);
    groups.set(m.book, arr);
  }
  for (const arr of groups.values()) {
    arr.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    for (let i = bookKeep; i < arr.length; i++) out.add(arr[i].key);
  }
  return Array.from(out);
}

interface Backend {
  put(rec: CachedImage, meta: CacheMeta): Promise<void>;
  get(key: string): Promise<CachedImage | null>;
  metas(): Promise<CacheMeta[]>;
  del(keys: string[]): Promise<void>;
}

function memoryBackend(): Backend {
  const m = new Map<string, CachedImage>();
  return {
    async put(rec) { m.set(rec.key, rec); },
    async get(key) { return m.get(key) || null; },
    async metas() {
      return Array.from(m.values()).map(function (r) {
        return { key: r.key, book: r.book, id: r.id, at: r.at, bytes: r.bytes };
      });
    },
    async del(keys) { for (const k of keys) m.delete(k); }
  };
}

const DB_NAME = 'bqb-images';
const DB_VER = 1;

function idbBackend(): Backend | null {
  const g = globalThis as unknown as { indexedDB?: IDBFactory };
  if (!g.indexedDB) return null;
  let openP: Promise<IDBDatabase | null> | null = null;
  const db = (): Promise<IDBDatabase | null> => {
    if (!openP) {
      openP = new Promise(function (resolve) {
        try {
          const req = (g.indexedDB as IDBFactory).open(DB_NAME, DB_VER);
          req.onupgradeneeded = function () {
            const d = req.result;
            if (!d.objectStoreNames.contains('imgs')) d.createObjectStore('imgs', { keyPath: 'key' });
            if (!d.objectStoreNames.contains('idx')) d.createObjectStore('idx', { keyPath: 'key' });
          };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(null); };
          req.onblocked = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }
    return openP;
  };
  const wrap = <T>(req: IDBRequest<T>): Promise<T> => new Promise(function (resolve, reject) {
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error || new Error('idb error')); };
  });
  const txDone = (t: IDBTransaction): Promise<void> => new Promise(function (resolve, reject) {
    t.oncomplete = function () { resolve(); };
    t.onerror = function () { reject(t.error || new Error('idb tx error')); };
    t.onabort = function () { reject(t.error || new Error('idb tx abort')); };
  });
  return {
    async put(rec, meta) {
      const d = await db();
      if (!d) throw new Error('idb unavailable');
      const t = d.transaction(['imgs', 'idx'], 'readwrite');
      t.objectStore('imgs').put(rec);
      t.objectStore('idx').put(meta);
      await txDone(t);
    },
    async get(key) {
      const d = await db();
      if (!d) return null;
      try {
        const r = await wrap<CachedImage | undefined>(d.transaction('imgs', 'readonly').objectStore('imgs').get(key));
        return r || null;
      } catch (e) { return null; }
    },
    async metas() {
      const d = await db();
      if (!d) return [];
      try { return await wrap<CacheMeta[]>(d.transaction('idx', 'readonly').objectStore('idx').getAll()); }
      catch (e) { return []; }
    },
    async del(keys) {
      if (!keys || !keys.length) return;
      const d = await db();
      if (!d) throw new Error('idb unavailable');
      const t = d.transaction(['imgs', 'idx'], 'readwrite');
      const li = t.objectStore('imgs');
      const lx = t.objectStore('idx');
      for (const k of keys) { li.delete(k); lx.delete(k); }
      await txDone(t);
    }
  };
}

let _injected: Backend | null = null;   // 测试注入
let _mem: Backend | null = null;        // indexedDB 不可用时的会话内降级
let _idbBroken = false;                 // IDB 打开/读写失败过 → 本次会话改用内存后端

function backend(): Backend {
  if (_injected) return _injected;
  if (!_idbBroken) {
    const idb = idbBackend();
    if (idb) return idb;
    _idbBroken = true;
  }
  if (!_mem) _mem = memoryBackend();
  return _mem;
}

function bytesOf(rec: CachedImageInput): number {
  return String(rec.thumb || '').length + String(rec.full || '').length;
}

export const ImageCache = {
  /** 写一张。超配额时自动降级：先试完整 → 只存缩略图。返回 'ok' | 'thumb' | 'fail'。 */
  async put(rec: CachedImageInput): Promise<'ok' | 'thumb' | 'fail'> {
    const book = String((rec && rec.book) || '');
    const id = String((rec && rec.id) || '');
    if (!id || (!rec.thumb && !rec.full)) return 'fail';
    const key = cacheKey(book, id);
    const meta: CacheMeta = { key: key, book: book, id: id, at: Number(rec.at) || Date.now(), bytes: bytesOf(rec) };
    try {
      await backend().put(Object.assign({}, rec, { key: key, book: book, id: id, bytes: meta.bytes }) as CachedImage, meta);
      return 'ok';
    } catch (e) {
      // 配额满 → 只可能是这一张太大，IDB 本身没坏（别把整会话的存档关掉）；
      // 其他错误（IDB 打不开/被禁）→ 本次会话降级到内存后端。
      const quota = String((e as Error) && (e as Error).name) === 'QuotaExceededError';
      if (!quota) _idbBroken = true;
      if (rec.full) {
        try {
          const light = Object.assign({}, rec, { key: key, book: book, id: id, full: '', bytes: String(rec.thumb || '').length }) as CachedImage;
          await backend().put(light, { key: key, book: book, id: id, at: meta.at, bytes: light.bytes });
          return 'thumb';
        } catch (e2) { /* 彻底存不下 */ }
      }
      return 'fail';
    }
  },

  async get(book: string, id: string): Promise<CachedImage | null> {
    try { return await backend().get(cacheKey(book, id)); } catch (e) { return null; }
  },

  /** 这本书的图全删（清空对话 / 删书）。返回删了几张。 */
  async delByBook(book: string): Promise<number> {
    const b = String(book || '');
    try {
      const metas = await backend().metas();
      const keys = metas.filter(function (m) { return m.book === b; }).map(function (m) { return m.key; });
      if (!keys.length) return 0;
      await backend().del(keys);
      return keys.length;
    } catch (e) { return 0; }
  },

  /** 只淘汰**指定这本书**里超出 BOOK_KEEP 的老图（2026-10-08：不再跨书删除、不提示用户）。
   *  调用点都是"刚往这本书写了一张图"（出图 / 上传）→ 于是只有正在用的这本书会被裁剪。 */
  async prune(book: string, opts?: { bookKeep?: number }): Promise<number> {
    try {
      const keys = planPrune(await backend().metas(), Object.assign({ book: String(book || '') }, opts || {}));
      if (!keys.length) return 0;
      await backend().del(keys);
      return keys.length;
    } catch (e) { return 0; }
  },

  /** 这本书已用过的最大图号（imgN 的 N）。重开 App 后新出图要接着这个号排，免得覆盖旧记录。 */
  async maxSeq(book: string): Promise<number> {
    const b = String(book || '');
    try {
      const metas = await backend().metas();
      let max = 0;
      for (const m of metas) {
        if (m.book !== b) continue;
        const mm = /(\d+)\s*$/.exec(String(m.id || ''));
        if (mm) max = Math.max(max, Number(mm[1]) || 0);
      }
      return max;
    } catch (e) { return 0; }
  },

  /** 某张图现在存在哪本书里（跨书引用时给准确报错用）。找不到返回 ''。 */
  async bookOf(id: string): Promise<string> {
    const want = String(id || '');
    if (!want) return '';
    try {
      const metas = await backend().metas();
      const hit = metas.find(function (m) { return m.id === want; });
      return hit ? String(hit.book || '') : '';
    } catch (e) { return ''; }
  },

  async stats(): Promise<{ count: number; bytes: number }> {
    try {
      const metas = await backend().metas();
      let bytes = 0;
      for (const m of metas) bytes += m.bytes || 0;
      return { count: metas.length, bytes: bytes };
    } catch (e) { return { count: 0, bytes: 0 }; }
  },

  async clearAll(): Promise<void> {
    try {
      const metas = await backend().metas();
      await backend().del(metas.map(function (m) { return m.key; }));
    } catch (e) { /* 忽略 */ }
  },

  /** 测试用：注入后端（不传 = 还原） */
  __setBackendForTest(b: Backend | null): void { _injected = b; },
  /** 测试用：重置内存后端与降级标记（每个用例之间调用） */
  __resetForTest(): void { _injected = null; _mem = null; _idbBroken = false; }
};

export default ImageCache;
