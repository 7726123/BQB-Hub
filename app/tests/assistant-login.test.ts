// 找卡需要登录社区：未登录/登录失效时，助手必须明确提醒用户去登录，
// 而不是丢一句「检索失败：http 401」让用户以为卡不存在或软件坏了。
// 回归背景：社区检索接口是登录后才开放的（不做匿名检索），
// 未登录时客户端会带着空 Bearer 发请求 → 服务端 401 → 旧实现只显示"检索失败"。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import {
  UsageAssistant, ASSISTANT_SYSTEM, isLoginError, withLoginHint,
  renderCardRefs, COMMUNITY_LOGIN_HINT, LOGIN_REF,
} from '../src/domain/assistant';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const origDoc = g.document;   // setup.ts 的最小 document 桩

beforeEach(() => {
  UsageAssistant._needLogin = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete g.CommunityChat;
  delete g.App;
  g.document = origDoc;
  UsageAssistant._card = null;
});

function stubCommunity(over?: Any): Any {
  const c: Any = Object.assign({
    token: 'tok', user: { id: 1, username: 'u' },
    loadState: vi.fn(),
    searchCards: vi.fn(() => Promise.resolve({ ok: true, items: [], total: 0 })),
    previewCard: vi.fn(() => Promise.resolve({ title: 't', entries: [] })),
    importCardById: vi.fn(() => Promise.resolve({ name: 'n', entries: 1 })),
  }, over || {});
  g.CommunityChat = c;
  return c;
}

describe('isLoginError：把 401/403 认出来', () => {
  it('401/403 算登录问题，其它不算', () => {
    expect(isLoginError('http 401')).toBe(true);
    expect(isLoginError('HTTP 403')).toBe(true);
    expect(isLoginError('http 500')).toBe(false);
    expect(isLoginError('Failed to fetch')).toBe(false);
    expect(isLoginError('')).toBe(false);
  });
});

describe('withLoginHint：最终回答必须给出登录出路', () => {
  it('未登录且模型没提登录 → 补完整提示 + 按钮标记', () => {
    const s = withLoginHint('这家社区里可能没有你要的卡。', true);
    expect(s).toContain('这家社区里可能没有你要的卡。');
    expect(s).toContain(COMMUNITY_LOGIN_HINT);
    expect(s).toContain(LOGIN_REF);
  });

  it('模型自己说了"登录" → 只补按钮，不重复整句', () => {
    const s = withLoginHint('找卡需要先登录社区。', true);
    expect(s.startsWith('找卡需要先登录社区。')).toBe(true);
    expect(s).toContain(LOGIN_REF);
    expect(s).not.toContain(COMMUNITY_LOGIN_HINT);
  });

  it('模型已经带上按钮标记 → 原样返回（不重复堆提示）', () => {
    const raw = '请先去登录 ' + LOGIN_REF;
    expect(withLoginHint(raw, true)).toBe(raw);
  });

  it('不是登录问题 → 一个字都不加', () => {
    expect(withLoginHint('今天天气不错', false)).toBe('今天天气不错');
  });

  it('模型什么都没说 + 未登录 → 至少给出登录提示（不能空着）', () => {
    expect(withLoginHint('', true)).toContain(COMMUNITY_LOGIN_HINT);
  });
});

describe('renderCardRefs：登录按钮与书名蓝链共存', () => {
  it('按钮标记渲染成可点击入口（onclick 指向真实方法）', () => {
    const html = renderCardRefs('需要登录 ' + LOGIN_REF);
    expect(html).toContain('onclick="UsageAssistant.gotoCommunityLogin()"');
    expect(html).toContain('去社区登录');
  });

  it('卡片标记照旧渲染（登录按钮不吞掉书名蓝链）', () => {
    const html = renderCardRefs('推荐 [[card:12|雾港调律]] ' + LOGIN_REF);
    expect(html).toContain('onclick="UsageAssistant.openCard(12)"');
    expect(html).toContain('雾港调律');
    expect(html).toContain('gotoCommunityLogin');
  });
});

describe('_executeTool：未登录时不发请求，直接返回 needLogin', () => {
  it('没有 token → 不发 fetch，结果带 needLogin 与登录提示', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const c = stubCommunity({ token: '', user: null });
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'search_cards', arguments: { query: '剑与魔法' } }));
    expect(out.ok).toBe(false);
    expect(out.needLogin).toBe(true);
    expect(String(out.hint)).toContain('社区');
    expect(c.searchCards).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(UsageAssistant._needLogin).toBe(true);
  });

  it('token 存在但已失效（服务端 401）→ 同样归为需要登录', async () => {
    stubCommunity({ searchCards: vi.fn(() => Promise.reject(new Error('http 401'))) });
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'search_cards', arguments: { query: 'x' } }));
    expect(out.needLogin).toBe(true);
    expect(UsageAssistant._needLogin).toBe(true);
  });

  it('其它错误不算登录问题（不误导用户去登录）', async () => {
    stubCommunity({ searchCards: vi.fn(() => Promise.reject(new Error('http 500'))) });
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'search_cards', arguments: { query: 'x' } }));
    expect(out.needLogin).toBeUndefined();
    expect(out.error).toContain('500');
    expect(UsageAssistant._needLogin).toBe(false);
  });

  it('已登录且正常 → 行为不变（ok:true + 条目）', async () => {
    stubCommunity({
      searchCards: vi.fn(() => Promise.resolve({ ok: true, total: 1, items: [{ id: 7, title: '雾港调律', meta: {} }], modes: {} })),
    });
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'search_cards', arguments: { query: '校园' } }));
    expect(out.ok).toBe(true);
    expect(out.items[0].id).toBe(7);
    expect(UsageAssistant._needLogin).toBe(false);
  });

  it('调用前先 loadState（社区页没打开过时 token 还没从存储读出）', async () => {
    const c = stubCommunity();
    await UsageAssistant._executeTool({ name: 'search_cards', arguments: { query: 'x' } });
    expect(c.loadState).toHaveBeenCalled();
  });
});

describe('_stepLine：未登录留痕说人话', () => {
  it('needLogin 结果 → 提示登录，而不是"检索失败"', () => {
    const line = UsageAssistant._stepLine({ name: 'search_cards', arguments: { query: 'x' } },
      JSON.stringify({ ok: false, needLogin: true, error: '未登录社区' }));
    expect(line).toContain('登录');
    expect(line).not.toContain('检索失败');
  });

  it('普通失败仍然是"检索失败"', () => {
    const line = UsageAssistant._stepLine({ name: 'search_cards', arguments: { query: 'x' } },
      JSON.stringify({ ok: false, error: 'http 500' }));
    expect(line).toContain('检索失败');
  });
});

describe('详情弹层 / 下载按钮：登录失效也说人话', () => {
  it('openCard 遇到 401 → 弹层里给出「去社区登录」入口', async () => {
    stubCommunity({
      detailWb: vi.fn(() => Promise.reject(new Error('http 401'))),
      previewCard: vi.fn(() => Promise.reject(new Error('http 401'))),
    });
    const g2 = globalThis as unknown as Any;
    const body: Any = { innerHTML: '' };
    const title: Any = { textContent: '' };
    const modal: Any = { classList: { add: () => undefined } };
    g2.document = Object.assign({}, g2.document, {
      getElementById: (id: string) => ({ asCardModal: modal, asCardBody: body, asCardTitle: title, asCardMeta: { textContent: '' } }[id] || null),
    });
    await UsageAssistant.openCard(12);
    expect(body.innerHTML).toContain('需要先登录社区');
    expect(body.innerHTML).toContain('gotoCommunityLogin');
  });

  it('downloadCard 遇到 401 → toast 提示去登录（而不是"导入失败：http 401"）', async () => {
    const toast = vi.fn();
    (globalThis as unknown as Any).App = { toast };
    stubCommunity({ importCardById: vi.fn(() => Promise.reject(new Error('http 401'))) });
    UsageAssistant._card = { id: 7, title: 'x', entries: [] };
    await UsageAssistant.downloadCard();
    expect(String(toast.mock.calls[0][0])).toContain('登录');
  });

  it('downloadCard 遇到 500 → 仍然是"导入失败"（不误导）', async () => {
    const toast = vi.fn();
    (globalThis as unknown as Any).App = { toast };
    stubCommunity({ importCardById: vi.fn(() => Promise.reject(new Error('http 500'))) });
    UsageAssistant._card = { id: 7, title: 'x', entries: [] };
    await UsageAssistant.downloadCard();
    expect(String(toast.mock.calls[0][0])).toContain('导入失败');
  });
});

describe('提示词与手册：助手知道"没登录要提醒登录"', () => {
  it('系统提示写明 needLogin 的处理方式', () => {
    expect(ASSISTANT_SYSTEM).toContain('needLogin');
    expect(ASSISTANT_SYSTEM).toContain('需要先登录');
  });

  it('使用手册「使用助手」一节写明找卡要登录', () => {
    expect(ASSISTANT_SYSTEM).toContain('找卡需要先登录社区');
  });
});
