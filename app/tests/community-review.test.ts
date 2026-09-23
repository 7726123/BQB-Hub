// 审核门（客户端）：上传后的待审提示、「我的投稿」状态徽标、管理员审核队列入口与通过/驳回动作。
// 回归背景：新上传必须经管理员审核才公开，作者要能看见自己的待审/已驳回稿子，管理员要能在 App 里点通过。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/community';
import { AdminMode } from '../src/domain/adminmode';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const CC = () => g.CommunityChat as Any;

const els: Record<string, Any> = {};
const origDoc = (globalThis as unknown as { document: Any }).document;
const origGetById = origDoc.getElementById;

function fakeEl(extra: Any = {}): Any {
  return Object.assign({
    value: '', textContent: '', innerHTML: '', disabled: false, style: {}, id: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; }, querySelectorAll() { return []; },
  }, extra);
}

beforeEach(() => {
  origDoc.getElementById = (id: string) => (els[id] = els[id] || fakeEl());
  g.App = { toast: vi.fn() };
  g.UIManager = { closeModal: vi.fn(), showModal: vi.fn(), showConfirm: vi.fn() };
  CC().server = 'http://x:8899'; CC().token = 'tok'; CC().user = { id: 1, username: '我' };
  CC()._wbCover = '';
  CC()._wbBooks = [{ title: '测试书', description: '', entries: [] }];
  els['wbUploadSelect'] = fakeEl({ value: '0' });
  els['wbUploadDesc'] = fakeEl({ value: '' });
  els['wbUploadCategory'] = fakeEl({ value: '综合' });
  els['wbUploadBtn'] = fakeEl({ disabled: false, textContent: '上传' });
  vi.spyOn(CC(), 'loadWorldbookList').mockImplementation(() => {});
});
afterEach(() => {
  origDoc.getElementById = origGetById;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.keys(els).forEach((k) => delete els[k]);
});

describe('上传后的审核提示', () => {
  it('服务端返回 pending → 提示「审核通过后公开」，不再提示后台补标签', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, id: 12, status: 'pending' }), { status: 200 }))));
    CC()._genUploadMeta = () => Promise.resolve(null);
    CC().doWbUpload();
    await new Promise((r) => setTimeout(r, 0));

    expect(g.App.toast).toHaveBeenCalledWith(expect.stringContaining('管理员审核通过后公开'));
    expect(g.App.toast).not.toHaveBeenCalledWith(expect.stringContaining('后台生成检索标签'));
  });

  it('管理员上传（status=approved）→ 沿用「已分享 + 后台生成标签」提示', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, id: 13, status: 'approved' }), { status: 200 }))));
    CC()._genUploadMeta = () => Promise.resolve(null);
    CC().doWbUpload();
    await new Promise((r) => setTimeout(r, 0));

    expect(g.App.toast).toHaveBeenCalledWith(expect.stringContaining('后台生成检索标签'));
  });
});

describe('我的投稿（个人中心）', () => {
  it('拉 /api/my/submissions：待审/已驳回带徽标，已通过不带', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({
        items: [
          { type: 'worldbook', id: 1, title: '待审的书', status: 'pending', downloads: 0 },
          { type: 'worldbook', id: 2, title: '通过的书', status: 'approved', downloads: 3 },
          { type: 'preset', id: 9, title: '被驳回的预设', status: 'rejected', downloads: 0 },
        ],
        total: 3, counts: { pending: 1, rejected: 1 },
      }), { status: 200 }));
    }));

    CC().loadMySubmissions();
    await new Promise((r) => setTimeout(r, 0));

    expect(urls[0]).toContain('/api/my/submissions');
    const wb = els['cpWbPane'].innerHTML;
    const pr = els['cpPresetPane'].innerHTML;
    expect(wb).toContain('待审的书');
    expect(wb).toContain('通过的书');
    expect((wb.match(/cup-badge/g) || []).length).toBe(1);   // 只有待审那条带徽标
    expect(wb).toContain('待审核');
    expect(wb).toContain('审核通过后别人才能看到');            // 提示文案
    expect(pr).toContain('被驳回的预设');
    expect(pr).toContain('cup-badge rejected');
  });

  it('加载失败：两个面板都给出失败提示，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))));
    CC().loadMySubmissions();
    await new Promise((r) => setTimeout(r, 0));
    expect(els['cpWbPane'].innerHTML).toContain('加载失败');
    expect(els['cpPresetPane'].innerHTML).toContain('加载失败');
  });
});

describe('审核动作（管理员）', () => {
  it('通过：POST /api/admin/review/action 带 X-Admin-Token，随后刷新公开列表', async () => {
    const calls: Any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: Any) => {
      calls.push({ url: String(url), init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }));
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(true);
    vi.spyOn(AdminMode, 'traceToken').mockReturnValue('tk-123');
    vi.spyOn(CC(), 'loadReviewQueue').mockImplementation(() => {});

    CC().reviewAction('worldbook', 5, 'approve');
    await new Promise((r) => setTimeout(r, 0));

    const post = calls.find((c) => c.url.includes('/api/admin/review/action'));
    expect(post).toBeTruthy();
    expect(post!.init.method).toBe('POST');
    expect(post!.init.headers['X-Admin-Token']).toBe('tk-123');
    expect(post!.init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(post!.init.body)).toEqual({ type: 'worldbook', id: 5, action: 'approve' });
    expect(g.App.toast).toHaveBeenCalledWith(expect.stringContaining('已通过'));
    expect(CC().loadWorldbookList).toHaveBeenCalled();   // 通过后公开列表刷新
  });

  it('驳回：先弹确认框，确认前不发请求', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    CC().reviewAction('worldbook', 6, 'reject');
    await new Promise((r) => setTimeout(r, 0));
    expect(g.UIManager.showConfirm).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();   // 桩不回调 → 没有请求
  });

  it('队列加载失败：面板给出令牌过期提示', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 401 }))));
    CC().loadReviewQueue();
    await new Promise((r) => setTimeout(r, 0));
    expect(els['rvwList'].innerHTML).toContain('管理员令牌');
  });
});

describe('世界书列表空态', () => {
  it('搜索无结果时提示「没有找到匹配」，普通空列表仍提示「暂无世界书」', () => {
    CC().wbItems = []; CC().wbTotal = 0; CC().wbQuery = '不存在的词';
    CC().renderWorldbookList();
    expect(els['wbList'].innerHTML).toContain('没有找到匹配的世界书');

    CC().wbQuery = '';
    CC().renderWorldbookList();
    expect(els['wbList'].innerHTML).toContain('暂无世界书');
  });
});

describe('管理入口显隐（社区/用量统计同级的页面 tab，仅管理员模式可见）', () => {
  function mountAdminEls() {
    const store: Any = {
      navAdminBtn: fakeEl(), navAdminLabel: fakeEl(), tabBtnAdmin: fakeEl(), tabAdmin: fakeEl(),
    };
    store['tab-admin'] = store.tabAdmin;
    store.tabAdmin.classList = { toggle() {}, add() { store.tabAdminActive = true; }, remove() {}, contains() { return false; } };
    origDoc.getElementById = (id: string) => (store[id] = store[id] || fakeEl());
    return store;
  }

  it('非管理员：入口隐藏、不发待审请求', () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(false);
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    const store = mountAdminEls();
    /// 未开启时三个入口都应隐藏（侧边栏项 / 面板 tab / 页面容器不新增）
    CC().syncAdminEntry();
    expect(store.navAdminBtn.style.display).toBe('none');
    expect(store.tabBtnAdmin.style.display).toBe('none');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('管理员：显示入口并拉待审计数（有待审时带数量）', async () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(true);
    vi.spyOn(AdminMode, 'traceToken').mockReturnValue('tk');
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ items: [], total: 2, counts: { worldbook: 2, preset: 0, plugin: 0 } }), { status: 200 }));
    }));
    const store = mountAdminEls();
    CC().syncAdminEntry();
    await new Promise((r) => setTimeout(r, 0));
    expect(store.navAdminBtn.style.display).toBe('');
    expect(store.tabBtnAdmin.style.display).toBe('');
    expect(urls[0]).toContain('/api/admin/review');
    expect(store.navAdminLabel.textContent).toBe('管理 · 待审 2');
    expect(store.tabBtnAdmin.textContent).toBe('管理 · 待审 2');
  });

  it('退出管理员模式时正停在管理页 → 退回社区页（不留打不开的空页）', () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(false);
    const switches: string[] = [];
    g.MobileUI = { switchView: (v: string) => switches.push(v) };
    const store = mountAdminEls();
    store.tabAdmin.classList = { toggle() {}, add() {}, remove() {}, contains: () => true };
    CC().syncAdminEntry();
    expect(switches).toEqual(['community']);
  });
});

// 管理面板（v1.5.97w2）：使用统计 + 审核队列合并到「社区 → 管理」，审核原有元素 id 不变。
describe('管理面板：使用统计', () => {
  function stubStats(body: unknown, ok = true) {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify(body), { status: ok ? 200 : 401 }));
    }));
    return urls;
  }
  function mount() {
    const store: Any = {};
    origDoc.getElementById = (id: string) => (store[id] = store[id] || fakeEl());
    return store;
  }

  it('面板顶部渲染四项人数与累计/版本分布', async () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(true);
    const store = mount();
    stubStats({
      online: 3, today: 12, week: 40, month: 88, total: 120, newToday: 2,
      day: '2026-09-22', onlineWindowMs: 300000,
      versions: [{ v: '1.5.97', c: 10 }, { v: '1.5.96', c: 2 }],
      webs: [{ w: '1.5.97w2', c: 9 }, { w: '', c: 3 }],
    });

    CC().loadAdminStats();
    await new Promise((r) => setTimeout(r, 0));

    expect(store['admStatOnline'].textContent).toBe('3');
    expect(store['admStatToday'].textContent).toBe('12');
    expect(store['admStatWeek'].textContent).toBe('40');
    expect(store['admStatMonth'].textContent).toBe('88');
    expect(store['admStatMeta'].textContent).toContain('累计设备 120');
    expect(store['admStatMeta'].textContent).toContain('今日新增 2');
    expect(store['admStatVersions'].textContent).toContain('1.5.97 × 10');
    expect(store['admStatVersions'].textContent).toContain('1.5.97w2 × 9');
    expect(store['admStatVersions'].textContent).toContain('内置 × 3');
    expect(store['admStatsUpdated'].textContent).toContain('2026-09-22');
    expect(store['admStatsUpdated'].textContent).toContain('在线');
  });

  it('缺字段/为 0 时显示 0 而不是空白或 undefined', async () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(true);
    const store = mount();
    stubStats({});
    CC().loadAdminStats();
    await new Promise((r) => setTimeout(r, 0));
    expect(store['admStatOnline'].textContent).toBe('0');
    expect(store['admStatToday'].textContent).toBe('0');
    expect(store['admStatVersions'].textContent).toBe('版本：—　｜　代码版本：—');
  });

  it('令牌过期（401）：给出「连点 10 下检查更新」的自救提示，不抛错', async () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(true);
    const store = mount();
    stubStats({ error: '需要管理员令牌' }, false);
    expect(() => CC().loadAdminStats()).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    expect(store['admStatMeta'].textContent).toContain('连点 10 下');
  });

  it('进入管理页：切到 admin 视图并同时拉统计与审核队列', async () => {
    vi.spyOn(AdminMode, 'isOn').mockReturnValue(true);
    mount();
    const urls = stubStats({ items: [], counts: { worldbook: 0, preset: 0, plugin: 0 } });
    CC().token = 'tok';
    g.MobileUI = { switchView: vi.fn() };
    CC().openAdminPanel();
    await new Promise((r) => setTimeout(r, 0));
    expect(g.MobileUI.switchView).toHaveBeenCalledWith('admin');
    expect(urls.some((u) => u.includes('/api/admin/stats'))).toBe(true);
    expect(urls.some((u) => u.includes('/api/admin/review'))).toBe(true);
  });

  it('按钮文案：无待审就是「管理」，有待审带上数量', () => {
    CC()._rvwPending = 0;
    expect(CC()._adminBtnText()).toBe('管理');
    CC()._rvwPending = 5;
    expect(CC()._adminBtnText()).toBe('管理 · 待审 5');
  });
});
