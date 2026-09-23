// 秒上传（客户端）：POST 立即发出（不等 AI 标签），标签随后台回填
// 回归背景：原先 doWbUpload 先等 _genUploadMeta（最长 20s）才 POST，用户体感是「卡住」。
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
    value: '', textContent: '', innerHTML: '', disabled: false, style: {},
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
  CC()._wbBooks = [{ title: '测试书', description: '', entries: [{ type: '角色', name: '林晚', content: '设定' }] }];
  els['wbUploadSelect'] = fakeEl({ value: '0' });
  els['wbUploadDesc'] = fakeEl({ value: '简介文本' });
  els['wbUploadCategory'] = fakeEl({ value: '综合' });
  els['wbUploadBtn'] = fakeEl({ disabled: false, textContent: '上传' });
  vi.spyOn(CC(), 'loadWorldbookList').mockImplementation(() => {});
});
afterEach(() => {
  origDoc.getElementById = origGetById;
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.keys(els).forEach((k) => delete els[k]);
});

describe('doWbUpload：秒上传 + 后台补标签', () => {
  it('POST 先发（payload 不含 meta/tags），标签生成在后台并行跑', async () => {
    const events: string[] = [];
    let postedBody: Any | null = null;
    vi.stubGlobal('fetch', vi.fn((url: string, init: Any) => {
      events.push('POST ' + String(url).split('/api')[1]);
      postedBody = JSON.parse(init.body);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, id: 77 }), { status: 200 }));
    }));
    const gen = vi.fn(() => { events.push('gen-meta'); return Promise.resolve(null); });
    CC()._genUploadMeta = gen;

    CC().doWbUpload();
    await new Promise((r) => setTimeout(r, 0));

    expect((postedBody as unknown as Any).meta).toBeUndefined();          // 上传时不带 AI 元数据
    expect((postedBody as unknown as Any).tags).toBeUndefined();
    expect((postedBody as unknown as Any).title).toBe('测试书');
    expect(events[0]).toContain('POST /worldbook/upload'); // 上传先发生
    expect(events).toContain('gen-meta');                  // 标签生成也启动了
    expect(g.UIManager.closeModal).toHaveBeenCalledWith('modalCommunityWbUpload');
    expect(g.App.toast).toHaveBeenCalledWith(expect.stringContaining('后台生成检索标签'));
    expect(gen).toHaveBeenCalled();
  });

  it('标签生成成功 → 回填 /api/worldbook/meta（带 tags 与 summaryBy:ai）', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: Any) => {
      urls.push(String(url));
      const body = init && init.body ? JSON.parse(init.body) : null;
      if (String(url).includes('/worldbook/meta')) {
        expect(body.id).toBe(88);
        expect(body.tags).toBe('校园,剑道');
        expect(body.meta.summaryBy).toBe('ai');
        expect(body.meta.summary).toContain('剑道');
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true, id: 88 }), { status: 200 }));
    }));
    CC()._genUploadMeta = () => Promise.resolve({
      summary: '校园剑道部的日常', genre: '校园日常', audience: '一般向', relation: '无恋爱线', franchise: '', nsfw: false, tags: ['校园', '剑道'],
    });

    CC().doWbUpload();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(urls.some((u) => u.includes('/worldbook/upload'))).toBe(true);
    expect(urls.some((u) => u.includes('/worldbook/meta'))).toBe(true);
    expect(g.App.toast).toHaveBeenCalledWith('检索标签已生成');
  });

  it('标签生成失败/超时 → 不再回填、不报错（卡片保留机械抽取的标签）', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      urls.push(String(url));
      return Promise.resolve(new Response(JSON.stringify({ ok: true, id: 99 }), { status: 200 }));
    }));
    CC()._genUploadMeta = () => Promise.resolve(null);

    CC().doWbUpload();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(urls.filter((u) => u.includes('/worldbook/meta')).length).toBe(0);
    expect(g.App.toast).not.toHaveBeenCalledWith('检索标签已生成');
  });

  it('上传失败：按钮恢复可用并提示，不进入补标签流程', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: '世界书内容不能为空且需小于 2MB' }), { status: 400 }))));
    const gen = vi.spyOn(CC(), '_genUploadMeta');
    CC().doWbUpload();
    await new Promise((r) => setTimeout(r, 0));
    expect(gen).not.toHaveBeenCalled();
    expect(els['wbUploadBtn'].disabled).toBe(false);
    expect(g.App.toast).toHaveBeenCalledWith('世界书内容不能为空且需小于 2MB');
  });
});
