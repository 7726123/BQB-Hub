// 社区搜索：查询词走组件状态，而不是回头读 DOM。
// 回归背景：页面上曾有两个 id="wbSearch"（编辑器条目过滤框 + 社区搜索框），
// getElementById 永远返回靠前的那个，社区世界书搜索因此静默失效。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/community';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const CC = () => g.CommunityChat as Any;
const origDoc = (globalThis as unknown as { document: Any }).document;

beforeEach(() => {
  g.App = { toast: vi.fn() };
  CC().server = 'http://x:8899';
  CC().token = 'tok';
  CC().user = { id: 1, username: 'u' };
  CC().wbQuery = '';
  CC().predQuery = '';
  CC().wbItems = [];
  CC().predItems = [];
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  CC().token = '';
});

function stubFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((u: string) => {
    urls.push(String(u));
    return Promise.resolve(new Response(JSON.stringify({ ok: true, items: [], total: 0, page: 1 }), { status: 200 }));
  }));
  return urls;
}

describe('社区搜索词来源', () => {
  it('世界书：onWbSearchSync 存状态，列表请求带该词', async () => {
    const urls = stubFetch();
    CC().onWbSearchSync('校园');
    expect(CC().wbQuery).toBe('校园');
    CC().loadWorldbookList();
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toContain('q=' + encodeURIComponent('校园'));
  });

  it('预设：onPredSearchSync 存状态，列表请求带该词', async () => {
    const urls = stubFetch();
    CC().onPredSearchSync('奇幻');
    expect(CC().predQuery).toBe('奇幻');
    CC().loadPresetList();
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toContain('q=' + encodeURIComponent('奇幻'));
  });

  it('不读 DOM：页面上存在同名 wbSearch 元素时也不取它的值', async () => {
    const urls = stubFetch();
    const els: Any = { wbSearch: { value: '编辑器的过滤词' }, predSearch: { value: '编辑器的过滤词' } };
    origDoc.getElementById = (id: string) => els[id] || null;
    CC().onWbSearchSync('社区词');
    CC().loadWorldbookList();
    CC().onPredSearchSync('预设词');
    CC().loadPresetList();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const all = urls.join(' ');
    expect(all).toContain(encodeURIComponent('社区词'));
    expect(all).toContain(encodeURIComponent('预设词'));
    expect(all).not.toContain(encodeURIComponent('编辑器的过滤词'));
  });
});
