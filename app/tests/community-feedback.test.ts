// 管理端「意见反馈」渲染（客户端）：未查看/已查看/全部 三档筛选、逐条标记已读/删除按钮、已清理提示。
// 服务端的限流/裁剪/鉴权在 server/tests/feedback.test.js 里测；这里只管渲染与动作接线。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/community';

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
  }, extra);
}

beforeEach(() => {
  origDoc.getElementById = (id: string) => (els[id] = els[id] || fakeEl({ id }));
  g.App = { toast: vi.fn() };
  g.UIManager = { showConfirm: vi.fn() };
  CC().server = 'http://x:8899';
  CC().token = 'tok';
  CC()._fbStatus = 'unread';
  CC()._fbItems = [];
  CC()._fbMeta = null;
});

afterEach(() => {
  origDoc.getElementById = origGetById;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.keys(els).forEach((k) => delete els[k]);
});

const unread = { id: 1, text: '希望支持导出 epub', version: '1.5.97', platform: 'android', created_at: Date.now(), read_at: null };
const read = { id: 2, text: '已经看过的建议', version: '1.5.96', platform: 'android', created_at: Date.now() - 1000, read_at: Date.now() };

describe('管理端意见反馈', () => {
  it('未查看：高亮未读、给出「标记已读」；已读条目不再给这个按钮', () => {
    CC()._fbItems = [unread, read];
    CC()._fbMeta = { unread: 1, read: 1, total: 2, trimmed: 0 };
    CC().renderAdminFeedback();
    const html = els['fbList'].innerHTML;
    expect(html).toContain('希望支持导出 epub');
    expect(html).toContain('已经看过的建议');
    expect(html).toContain('markFeedbackRead(1)');            // 未读那条能标已读
    expect(html).not.toContain('markFeedbackRead(2)');         // 已读那条不给
    expect(html).toContain('deleteFeedback(1)');               // 两条都能删
    expect(html).toContain('deleteFeedback(2)');
    expect(els['fbAdminMeta'].textContent).toContain('未查看 1');
    expect(els['fbAdminMeta'].textContent).toContain('共 2');
  });

  it('内容一律转义（不能把用户输入当 HTML 渲染）', () => {
    CC()._fbItems = [Object.assign({}, unread, { text: '<img src=x onerror=alert(1)>' })];
    CC()._fbMeta = { unread: 1, read: 0, total: 1 };
    CC().renderAdminFeedback();
    expect(els['fbList'].innerHTML).toContain('&lt;img');
    expect(els['fbList'].innerHTML).not.toContain('<img');
  });

  it('空列表：给出空状态文案，且清掉旧内容', () => {
    CC()._fbItems = [];
    CC()._fbMeta = { unread: 0, read: 0, total: 0, trimmed: 3 };
    CC().renderAdminFeedback();
    expect(els['fbList'].innerHTML).toBe('');
    expect(els['fbEmpty'].style.display).toBe('');
    expect(els['fbEmpty'].textContent).toContain('没有未查看的反馈');
    expect(els['fbAdminMeta'].textContent).toContain('已清理 3 条');   // 裁剪对管理员可见
  });

  it('切换筛选：非法值回落到未查看，并带上状态参数重新拉取', () => {
    const calls: string[] = [];
    g.fetch = vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ items: [], unread: 0, read: 0, total: 0 }) };
    });
    CC().setFeedbackStatus('read');
    expect(CC()._fbStatus).toBe('read');
    CC().setFeedbackStatus('乱七八糟');
    expect(CC()._fbStatus).toBe('unread');
    expect(calls.some((u) => u.includes('status=read'))).toBe(true);
    expect(calls.some((u) => u.includes('status=unread'))).toBe(true);
  });

  it('服务器没更新到这一版（404）：提示需要部署服务端，而不是空列表', async () => {
    g.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }));
    CC().loadAdminFeedback();
    await new Promise((r) => setTimeout(r, 0));
    expect(els['fbList'].innerHTML).toContain('服务器还没更新到这个版本');
  });

  it('标记已读 / 全部已读 / 删除：走 POST，并回头刷新列表与统计', async () => {
    const calls: Array<{ url: string; body: any }> = [];
    g.fetch = vi.fn(async (url: string, init: Any) => {
      calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
      return { ok: true, status: 200, json: async () => ({ ok: true, changed: 1, items: [], unread: 0, read: 0, total: 0 }) };
    });
    vi.spyOn(CC(), 'loadAdminFeedback').mockImplementation(() => {});
    const statsSpy = vi.spyOn(CC(), 'loadAdminStats').mockImplementation(() => {});
    CC().markFeedbackRead(7);
    CC().markAllFeedbackRead();
    CC().deleteFeedback(9);
    const confirmCb = g.UIManager.showConfirm.mock.calls[0][1];
    confirmCb();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.some((c) => c.url.endsWith('/api/admin/feedback/read') && c.body.ids[0] === 7)).toBe(true);
    expect(calls.some((c) => c.body && c.body.all === true)).toBe(true);
    expect(calls.some((c) => c.url.endsWith('/api/admin/feedback/delete') && c.body.id === 9)).toBe(true);
    expect(statsSpy).toHaveBeenCalled();
  });
});
