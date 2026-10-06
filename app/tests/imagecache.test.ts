// 生成图本地存档（lib/imagecache）：重开 App 后图片还能看、点开还是原图；清空对话 / 删书即删。
// 环境说明：node 里没有 indexedDB → 模块自动用**内存后端**；真机走 IndexedDB。
// 两条路径共用同一套 prune / 降级逻辑，所以这里测的是真逻辑（后端差异只在读写原语）。
import { describe, it, expect, beforeEach } from 'vitest';
import { ImageCache, planPrune, cacheKey, BOOK_KEEP, TOTAL_BYTES, type CacheMeta } from '../src/lib/imagecache';

function rec(book: string, id: string, at: number, full = 'F'.repeat(100), thumb = 'T') {
  return { book: book, id: id, thumb: thumb, full: full, at: at, seed: 7, size: '768x768', seconds: 6, prompt: 'a girl' };
}

beforeEach(() => { ImageCache.__resetForTest(); });

describe('imagecache：存取与按书删', () => {
  it('put/get 往返（键 = 书|图号）：原图、缩略图、元数据都在；别的书取不到（按书隔离）', async () => {
    expect(await ImageCache.put(rec('wb1', 'img1', 100))).toBe('ok');
    const got = await ImageCache.get('wb1', 'img1');
    expect(got).toBeTruthy();
    expect(got!.full).toBe('F'.repeat(100));
    expect(got!.thumb).toBe('T');
    expect(got!.seed).toBe(7);
    expect(got!.size).toBe('768x768');
    expect(got!.key).toBe(cacheKey('wb1', 'img1'));
    expect(await ImageCache.get('wb2', 'img1')).toBeNull();
  });

  it('delByBook 只删这本书（清空讨论 / 删书用），返回删掉几张', async () => {
    await ImageCache.put(rec('wb1', 'img1', 1));
    await ImageCache.put(rec('wb1', 'img2', 2));
    await ImageCache.put(rec('wb2', 'img1', 3));
    expect(await ImageCache.delByBook('wb1')).toBe(2);
    expect(await ImageCache.get('wb1', 'img1')).toBeNull();
    expect(await ImageCache.get('wb1', 'img2')).toBeNull();
    expect(await ImageCache.get('wb2', 'img1')).toBeTruthy();
    expect(await ImageCache.delByBook('wb1')).toBe(0);
  });

  it('maxSeq / bookOf：重开后图号能续排；跨书引用能查到归属', async () => {
    await ImageCache.put(rec('wb1', 'img3', 1));
    await ImageCache.put(rec('wb1', 'img11', 2));
    await ImageCache.put(rec('wb2', 'img7', 3));
    expect(await ImageCache.maxSeq('wb1')).toBe(11);
    expect(await ImageCache.maxSeq('wb2')).toBe(7);
    expect(await ImageCache.maxSeq('wb9')).toBe(0);
    expect(await ImageCache.bookOf('img11')).toBe('wb1');
    expect(await ImageCache.bookOf('img7')).toBe('wb2');
    expect(await ImageCache.bookOf('img99')).toBe('');
  });
});

describe('imagecache：剔除（上限）', () => {
  it('planPrune：每书保留最新 bookKeep 张，多出来的（最旧）删掉', () => {
    const metas: CacheMeta[] = [1, 2, 3, 4].map(function (i) {
      return { key: 'b|img' + i, book: 'b', id: 'img' + i, at: i, bytes: 10 };
    });
    expect(planPrune(metas, { bookKeep: 2 }).sort()).toEqual(['b|img1', 'b|img2']);
  });

  it('planPrune：总量超上限时跨书按最旧删', () => {
    const metas: CacheMeta[] = [
      { key: 'a|x', book: 'a', id: 'x', at: 1, bytes: 60 },
      { key: 'b|y', book: 'b', id: 'y', at: 2, bytes: 60 }
    ];
    expect(planPrune(metas, { bookKeep: 10, totalBytes: 70 })).toEqual(['a|x']);
  });

  it('prune()：真的会删（内存后端）', async () => {
    for (let i = 1; i <= 3; i++) await ImageCache.put(rec('wb1', 'img' + i, i));
    expect(await ImageCache.prune({ bookKeep: 2 })).toBe(1);
    expect(await ImageCache.get('wb1', 'img1')).toBeNull();
    expect(await ImageCache.get('wb1', 'img2')).toBeTruthy();
    expect((await ImageCache.stats()).count).toBe(2);
  });

  it('常量：每书 12 张 / 总量 120MB', () => {
    expect(BOOK_KEEP).toBe(12);
    expect(TOTAL_BYTES).toBe(120 * 1024 * 1024);
  });
});

describe('imagecache：降级（绝不抛、绝不影响出图）', () => {
  it('配额满（QuotaExceededError）→ 自动降级只存缩略图，返回 thumb', async () => {
    const store = new Map<string, any>();
    ImageCache.__setBackendForTest({
      put: async (r: any) => {
        if (r.full) { const e: any = new Error('quota exceeded'); e.name = 'QuotaExceededError'; throw e; }
        store.set(r.key, r);
      },
      get: async (k: string) => store.get(k) || null,
      metas: async () => Array.from(store.values()).map((r: any) => ({ key: r.key, book: r.book, id: r.id, at: r.at, bytes: r.bytes })),
      del: async (keys: string[]) => { for (const k of keys) store.delete(k); }
    });
    expect(await ImageCache.put(rec('wb1', 'img1', 1))).toBe('thumb');
    expect(store.get('wb1|img1').full).toBe('');
    expect(store.get('wb1|img1').thumb).toBe('T');
    // 配额错误的这一次不该把整会话的存档关掉：下一张（只存缩略图那条路走通后）还能继续写
    expect(await ImageCache.get('wb1', 'img1')).toBeTruthy();
  });

  it('存储彻底不可用 → fail / null / 0，全都不抛', async () => {
    ImageCache.__setBackendForTest({
      put: async () => { throw new Error('boom'); },
      get: async () => null,
      metas: async () => [],
      del: async () => undefined
    });
    expect(await ImageCache.put(rec('wb1', 'img1', 1))).toBe('fail');
    expect(await ImageCache.get('wb1', 'img1')).toBeNull();
    expect(await ImageCache.delByBook('wb1')).toBe(0);
    expect(await ImageCache.prune()).toBe(0);
    expect(await ImageCache.maxSeq('wb1')).toBe(0);
    expect(await ImageCache.bookOf('img1')).toBe('');
    expect(await ImageCache.stats()).toEqual({ count: 0, bytes: 0 });
  });

  it('缺 id 或缺图 → fail（不写脏数据）', async () => {
    expect(await ImageCache.put({ book: 'b', id: '', thumb: 'T', full: 'F', at: 1 })).toBe('fail');
    expect(await ImageCache.put({ book: 'b', id: 'img1', thumb: '', full: '', at: 1 })).toBe('fail');
  });
});
