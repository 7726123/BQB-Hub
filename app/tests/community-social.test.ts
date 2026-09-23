// 社区卡片社交（客户端）：点赞开关（乐观更新/失败回滚/未登录拦下）、排序切换、评论渲染与相对时间
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/community';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const CC = () => g.CommunityChat as Any;

const els: Record<string, Any> = {};
const socialEls: Record<string, Any> = {};
const origDoc = (globalThis as unknown as { document: Any }).document;
const origQuerySelector = origDoc.querySelector;

function fakeEl(extra: Any = {}): Any {
  return Object.assign({
    innerHTML: '', textContent: '', value: '', style: {}, dataset: {},
    classList: { _has: new Set<string>(), add(c: string) { this._has.add(c); }, remove(c: string) { this._has.delete(c); }, toggle(c: string, on?: boolean) { if (on) this._has.add(c); else this._has.delete(c); }, contains(c: string) { return this._has.has(c); } },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  }, extra);
}

beforeEach(() => {
  els['cmtBox'] = fakeEl();
  els['wbDetailSocial'] = fakeEl();
  els['predDetailSocial'] = fakeEl();
  origDoc.getElementById = (id: string) => (els[id] = els[id] || fakeEl());
  origDoc.querySelector = (sel: string) => (socialEls[sel] = socialEls[sel] || fakeEl({ querySelector: () => null }));
  g.App = { toast: vi.fn() };
  CC().server = 'http://x:8899'; CC().token = ''; CC().user = null;
  CC().wbItems = []; CC().predItems = [];
  CC().currentWbDetail = null; CC().currentPredDetail = null;
  CC().wbSort = 'new'; CC().predSort = 'new';
});
afterEach(() => {
  origDoc.getElementById = undefined;
  origDoc.querySelector = origQuerySelector;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.keys(els).forEach((k) => delete els[k]);
  Object.keys(socialEls).forEach((k) => delete socialEls[k]);
});

describe('点赞', () => {
  it('未登录：不请求，提示并拉起登录', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const openLogin = vi.spyOn(CC(), 'openLogin').mockImplementation(() => {});
    CC().toggleLike('worldbook', 1, { stopPropagation() {} });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(openLogin).toHaveBeenCalled();
    expect(g.App.toast).toHaveBeenCalledWith('登录后才能点赞');
  });

  it('已登录：乐观更新 → 服务端确认后按返回值对齐', async () => {
    CC().token = 'tok'; CC().user = { id: 5, username: '我' };
    CC().wbItems = [{ id: 1, likes: 3, comments: 1, liked: false }];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, liked: true, likes: 4 }), { status: 200 }))));
    const item = CC().wbItems[0];
    const p = CC().toggleLike('worldbook', 1, { stopPropagation() {} });
    expect(item.likes).toBe(4);       // 乐观：立刻 +1
    expect(item.liked).toBe(true);
    await p;
    expect(item.likes).toBe(4);       // 服务端口径一致
    expect(item.liked).toBe(true);
  });

  it('失败：回滚到点击前的数值并提示', async () => {
    CC().token = 'tok'; CC().user = { id: 5, username: '我' };
    CC().wbItems = [{ id: 2, likes: 7, liked: false }];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: '操作过于频繁' }), { status: 429 }))));
    const item = CC().wbItems[0];
    await CC().toggleLike('worldbook', 2, { stopPropagation() {} });
    expect(item.likes).toBe(7);       // 回滚
    expect(item.liked).toBe(false);
    expect(g.App.toast).toHaveBeenCalledWith('操作过于频繁');
  });

  it('点爱心不会冒泡到卡片（不误开详情）', () => {
    CC().token = 'tok'; CC().user = { id: 5, username: '我' };
    CC().wbItems = [{ id: 3, likes: 0, liked: false }];
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, liked: true, likes: 1 }), { status: 200 }))));
    const ev = { stopPropagation: vi.fn() };
    CC().toggleLike('worldbook', 3, ev);
    expect(ev.stopPropagation).toHaveBeenCalled();
  });
});

describe('排序切换', () => {
  it('世界书：换档后按新 sort 重新拉列表（同档不重复请求）', () => {
    const load = vi.spyOn(CC(), 'loadWorldbookList').mockImplementation(() => {});
    CC().setSort('worldbook', 'hot');
    expect(CC().wbSort).toBe('hot');
    expect(CC().wbPage).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);
    CC().setSort('worldbook', 'hot');
    expect(load).toHaveBeenCalledTimes(1); // 同档不重复
    CC().setSort('worldbook', 'active');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('预设：同一套切换逻辑', () => {
    const load = vi.spyOn(CC(), 'loadPresetList').mockImplementation(() => {});
    CC().setSort('preset', 'active');
    expect(CC().predSort).toBe('active');
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('评论区渲染', () => {
  it('渲染昵称/内容/相对时间，自己的评论才有删除按钮', () => {
    CC().token = 'tok'; CC().user = { id: 9, username: '我' };
    CC().currentWbDetail = { id: 1, author_id: 77 };
    CC()._cmt = { type: 'worldbook', id: 1, total: 2, mine: 9, loading: false, hasMore: false,
      items: [{ id: 11, user_id: 9, username: '我', content: '我的评论', created_at: Date.now() - 30 * 1000 },
              { id: 12, user_id: 8, username: '别人', content: '别人的评论', created_at: Date.now() - 3 * 3600 * 1000 }] };
    CC().renderComments();
    const html = els['cmtBox'].innerHTML;
    expect(html).toContain('评论 · 2');
    expect(html).toContain('刚刚');
    expect(html).toContain('3 小时前');
    // 只给自己的那条挂删除
    expect(html.split('deleteComment(').length - 1).toBe(1);
    expect(html).toContain('deleteComment(11)');
  });

  it('卡作者能删自己卡下的评论', () => {
    CC().token = 'tok'; CC().user = { id: 42, username: '作者' };
    CC().currentWbDetail = { id: 1, author_id: 42 };
    CC()._cmt = { type: 'worldbook', id: 1, total: 1, mine: 42, loading: false, hasMore: false,
      items: [{ id: 21, user_id: 8, username: '读者', content: '写得不错', created_at: Date.now() }] };
    CC().renderComments();
    expect(els['cmtBox'].innerHTML).toContain('deleteComment(21)');
  });

  it('无关读者看不到别人的删除按钮', () => {
    CC().token = 'tok'; CC().user = { id: 5, username: '路人' };
    CC().currentWbDetail = { id: 1, author_id: 42 };
    CC()._cmt = { type: 'worldbook', id: 1, total: 1, mine: 5, loading: false, hasMore: false,
      items: [{ id: 31, user_id: 8, username: '读者', content: 'x', created_at: Date.now() }] };
    CC().renderComments();
    expect(els['cmtBox'].innerHTML).not.toContain('deleteComment(');
  });

  it('空评论区有引导文案', () => {
    CC()._cmt = { type: 'worldbook', id: 1, total: 0, mine: 1, loading: false, hasMore: false, items: [] };
    CC().renderComments();
    expect(els['cmtBox'].innerHTML).toContain('还没有评论');
  });

  it('评论内容做 HTML 转义', () => {
    CC()._cmt = { type: 'worldbook', id: 1, total: 1, mine: 0, loading: false, hasMore: false,
      items: [{ id: 41, user_id: 8, username: '<b>x</b>', content: '<script>alert(1)</script>', created_at: Date.now() }] };
    CC().renderComments();
    const html = els['cmtBox'].innerHTML;
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('发评论与计数联动', () => {
  it('成功发布：插到最前、计数 +1、列表卡片上的 💬 同步', async () => {
    CC().token = 'tok'; CC().user = { id: 5, username: '我' };
    CC().wbItems = [{ id: 1, likes: 0, comments: 2, liked: false }];
    els['cmtInput'] = fakeEl({ value: '  一条评论  ' });
    CC()._cmt = { type: 'worldbook', id: 1, total: 2, mine: 5, loading: false, hasMore: false, items: [] };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, comment: { id: 99, user_id: 5, username: '我', content: '一条评论', created_at: Date.now() } }), { status: 200 }))));
    await CC().postComment();
    expect(CC().wbItems[0].comments).toBe(3);
    expect(CC()._cmt.total).toBe(3);
    expect(CC()._cmt.items[0].id).toBe(99);
  });

  it('空内容不发请求', async () => {
    CC().token = 'tok'; CC().user = { id: 5, username: '我' };
    els['cmtInput'] = fakeEl({ value: '   ' });
    CC()._cmt = { type: 'worldbook', id: 1, total: 0, mine: 5, loading: false, hasMore: false, items: [] };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await CC().postComment();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
