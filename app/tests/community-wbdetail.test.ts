// 社区世界书详情：不导入也能看内容（走 /api/worldbook/preview，不计下载数）+ 条目展开渲染
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/community';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const CC = () => g.CommunityChat as Any;

const els: Record<string, Any> = {};
const origGetById = (globalThis as unknown as { document: Any }).document?.getElementById;

beforeEach(() => {
  (g.document as Any).getElementById = (id: string) => (els[id] = els[id] || { innerHTML: '', textContent: '', style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } } });
  CC().server = 'http://x:8899'; CC().token = 'tok';
  g.App = { toast: vi.fn() };            // 详情链路里的失败分支会调 App.toast（测试环境需有桩）
  g.UIManager = { closeModal: vi.fn(), showModal: vi.fn() };
});
afterEach(() => {
  (g.document as Any).getElementById = origGetById;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.keys(els).forEach((k) => delete els[k]);
});

describe('_renderWbEntries：详情弹层里的条目列表', () => {
  it('条目数 / 类型 / 字数齐全，缺 name 有条目 N 兜底', () => {
    const html = CC()._renderWbEntries([
      { type: '角色', name: '林晚', content: '设定'.repeat(20) },
      { content: '' },
    ]);
    expect(html).toContain('共 2 条');
    expect(html).toContain('角色');
    expect(html).toContain('林晚');
    expect(html).toContain('40 字');       // 内容字数透出
    expect(html).toContain('条目 2');       // 无名条目兜底
    expect(html).not.toContain('undefined');
    expect(html).toContain('onclick="CommunityChat.toggleWbEntry(this)"');
  });

  it('条目内容做 HTML 转义（防注入）', () => {
    const html = CC()._renderWbEntries([{ type: '其他', name: '<img onerror=1>', content: '<script>alert(1)</script>' }]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img onerror');
    expect(html).toContain('&lt;script&gt;');
  });

  it('空世界书有明确提示', () => {
    expect(CC()._renderWbEntries([])).toContain('没有条目');
  });

  it('极端大书截断到 500 条（详情弹层不卡）', () => {
    const many = Array.from({ length: 700 }, (_, i) => ({ type: '其他', name: 'e' + i, content: 'x' }));
    const html = CC()._renderWbEntries(many);
    expect(html).toContain('共 700 条');
    expect(html.split('class="wbd-entry"').length - 1).toBe(500);
  });
});

describe('_loadWbPreview：读预览接口 + 过期响应丢弃', () => {
  it('请求 /api/worldbook/preview（不是 download → 不计下载数）并渲染', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      urls.push(String(u));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, title: 't', entries: [{ type: '世界观', name: '学院', content: '内容' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }));
    CC()._loadWbPreview(7);
    await new Promise((r) => setTimeout(r, 0));
    expect(urls[0]).toContain('/api/worldbook/preview?id=7');
    expect(urls[0]).not.toContain('/download');
    expect(els['wbDetailContent'].innerHTML).toContain('学院');
  });

  it('切到别的卡后旧响应被丢弃（不覆盖新内容）', async () => {
    let resolveFetch: (r: Response) => void = () => {};
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => { resolveFetch = res as (r: Response) => void; })));
    CC()._loadWbPreview(1);
    CC()._wbPreviewFor = 2;                    // 模拟用户已点开第 2 张卡
    resolveFetch(new Response(JSON.stringify({ entries: [{ name: '旧卡条目', content: 'x' }] }), { status: 200 }));
    await new Promise((r) => setTimeout(r, 0));
    expect(els['wbDetailContent'].innerHTML).not.toContain('旧卡条目');
  });

  it('读取失败给可操作的提示（先导入再查看）', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));
    CC()._loadWbPreview(9);
    await new Promise((r) => setTimeout(r, 0));
    expect(els['wbDetailContent'].innerHTML).toContain('内容读取失败');
  });
});

// 回归背景：cover 此前原样拼进 <img src="...">，服务端也只校验前缀 —— 载荷里带一个引号
// 就能闭合属性注入 onerror（存储型 XSS，可读同源存储里的会话令牌与模型 key）。
// 服务端已改成整串校验（server/src/media.js），客户端这里也必须转义（老版本客户端改不动，
// 但新版本不能再依赖服务端不出错）。
describe('封面字段的属性转义（防属性逃逸 XSS）', () => {
  const EVIL = 'data:image/png;base64,AAAA" onerror="localStorage.setItem(\'pwn\',\'1\')" x="';

  it('列表卡片：封面被转义，拼不出 onerror 事件属性', () => {
    CC().wbItems = [{ id: 1, title: '书', author_name: '作者', cover: EVIL, likes: 0, comments: 0, downloads: 0 }];
    CC().wbTotal = 1;
    CC().renderWorldbookList();
    const html = els['wbList'].innerHTML;
    expect(html).toContain('&quot;');
    expect(html).not.toContain('" onerror=');
    expect(html).not.toContain("onerror=\"localStorage");
  });

  it('详情弹层：封面同样转义', async () => {
    vi.stubGlobal('fetch', vi.fn((u: string) => {
      const url = String(u);
      if (url.includes('/api/worldbook/detail')) {
        return Promise.resolve(new Response(JSON.stringify({ item: { id: 1, title: '书', author_name: '作者', category: '综合', description: '', cover: EVIL, likes: 0 } }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ items: [], entries: [] }), { status: 200 }));
    }));
    CC().openWbDetail(1);
    await new Promise((r) => setTimeout(r, 0));
    const html = els['wbDetailBody'].innerHTML;
    expect(html).toContain('detail-cover');
    expect(html).not.toContain('" onerror=');
  });

  it('正常 base64 封面不受影响（转义后仍是可用的 data URI）', () => {
    const ok = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
    CC().wbItems = [{ id: 2, title: '书', author_name: '作者', cover: ok, likes: 0, comments: 0, downloads: 0 }];
    CC().wbTotal = 1;
    CC().renderWorldbookList();
    expect(els['wbList'].innerHTML).toContain('src="' + ok + '"');
  });
});
