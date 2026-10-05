// 生图公共部件：图号 / 底图引用解析 / 改图幅度 / 缩略图 HTML。
// 覆盖用户 2026-10-06 的要求："可以指名第几张图让它改"——图号与界面上看到的「图3」必须一致。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  books: [] as any[],
  mode: 'novel',
  overlays: { novel: { added: [] as any[] }, chat: { added: [] as any[] } }
}));

vi.mock('../src/domain/worldbook', () => ({
  WorldBookManager: { getActive: () => h.books[0] || null, getAll: () => h.books, saveAll: () => undefined }
}));
vi.mock('../src/domain/settingsync', () => ({
  SettingSyncManager: {
    getOverlay: () => (h.overlays as any)[h.mode],
    withMode: (_m: string, fn: any) => { const prev = h.mode; h.mode = _m; try { return fn(); } finally { h.mode = prev; } }
  }
}));

let m: any;
beforeEach(async () => {
  m = await import('../src/domain/imagedraw');
  h.books = []; h.mode = 'novel';
  h.overlays = { novel: { added: [] }, chat: { added: [] } };
  (globalThis as any).fetch = () => Promise.reject(new Error('network disabled in tests'));
});

function store(pairs: Array<[string, any]>): Map<string, any> {
  const s = new Map<string, any>();
  pairs.forEach(([k, v]) => s.set(k, v));
  return s;
}

describe('imageLabel / strengthDenoise / resolveTier', () => {
  it('图号与 id 一一对应（img3 → 图3；异常值给空串）', () => {
    expect(m.imageLabel('img3')).toBe('图3');
    expect(m.imageLabel('img12')).toBe('图12');
    expect(m.imageLabel('')).toBe('');
    expect(m.imageLabel(null)).toBe('');
  });

  it('改图幅度：slight/medium/strong → 0.35/0.55/0.75，认不出按 medium', () => {
    expect(m.strengthDenoise('slight')).toBe(0.35);
    expect(m.strengthDenoise('strong')).toBe(0.75);
    expect(m.strengthDenoise('')).toBe(0.55);
    expect(m.strengthDenoise('不认识')).toBe(0.55);
  });

  it('档位：high=1024/36 单次直出（hires 实测没赢，档位不用它），认不出的档回落标准档', () => {
    expect(m.resolveTier('high')).toMatchObject({ size: 1024, steps: 36 });
    expect(m.resolveTier('high').hires).toBe(false);
    expect(m.resolveTier('fast')).toMatchObject({ size: 512, steps: 12 });
    expect(m.resolveTier('fast').hires).toBe(false);
    expect(m.resolveTier('不存在的档')).toMatchObject({ key: 'normal', size: 768 });
    expect(m.resolveTier(undefined, true)).toMatchObject({ key: 'draft', size: 512, steps: 20 });   // 旧参数 draft:true
  });
});

describe('resolveBaseImage：指名第几张', () => {
  it('"图3" / "img3" / "3" / 大小写 → 都指向同一张（句柄在）', async () => {
    const s = store([['img1', { full: 'data:image/png;base64,ONE' }], ['img3', { full: 'data:image/png;base64,THREE' }]]);
    for (const ref of ['图3', 'img3', 'IMG3', '3']) {
      const r = await m.resolveBaseImage(ref, s);
      expect(r.ok).toBe(true);
      expect(r.dataUrl).toBe('data:image/png;base64,THREE');
      expect(r.label).toBe('图3');
    }
  });

  it('"last" / "上一张" → 最近生成的那张', async () => {
    const s = store([['img1', { full: 'A' }], ['img7', { full: 'G' }]]);
    expect((await m.resolveBaseImage('last', s)).dataUrl).toBe('G');
    expect((await m.resolveBaseImage('上一张', s)).dataUrl).toBe('G');
    expect((await m.resolveBaseImage('last', store([]))).ok).toBe(false);   // 一张都没有
  });

  it('句柄过期（本会话没有这张）：明确说清"只在本会话内存里"', async () => {
    const r = await m.resolveBaseImage('图9', store([['img1', { full: 'A' }]]));
    expect(r.ok).toBe(false);
    expect(r.error).toContain('图9');
    expect(r.error).toContain('只在本会话内存');
  });

  it('角色名 → 用它的头像（原书条目 / 临时层都找）', async () => {
    h.books = [{ id: 'wb1', entries: [{ id: 'e1', type: '角色', name: '林晚', avatar: 'data:image/jpeg;base64,AV' }] }];
    const r1 = await m.resolveBaseImage('林晚', store([]));
    expect(r1.ok).toBe(true);
    expect(r1.dataUrl).toBe('data:image/jpeg;base64,AV');
    expect(r1.label).toBe('林晚的头像');
    // 临时新增的角色（比奇登记的）
    h.books = [{ id: 'wb1', entries: [] }];
    h.overlays.novel.added = [{ id: 'a1', type: '角色', name: '苏黎', avatar: 'data:image/jpeg;base64,TMP' }];
    const r2 = await m.resolveBaseImage('苏黎', store([]));
    expect(r2.ok).toBe(true);
    expect(r2.dataUrl).toBe('data:image/jpeg;base64,TMP');
    expect(h.mode).toBe('novel');   // 模式用完还原
  });

  it('角色没头像：软失败（soft=true），调用方可以照常按描述画', async () => {
    h.books = [{ id: 'wb1', entries: [{ id: 'e1', type: '角色', name: '林晚', content: '没头像' }] }];
    const r = await m.resolveBaseImage('林晚', store([]));
    expect(r.ok).toBe(false);
    expect(r.soft).toBe(true);           // 关键：不是硬失败——比奇默认拿角色头像当底图，新角色没头像不该整张画不出来
    expect(r.error).toContain('还没有头像');
    expect(r.error).toContain('按描述画');
  });
});

describe('跨书隔离：图号 / 上一张 / 角色头像都跟着"这本书"走', () => {
  it('同名角色在两本书里：按传进来的书取头像；别本书的图号不许拿来改', async () => {
    h.books = [
      { id: 'wbA', name: '甲书', entries: [{ id: 'eA', type: '角色', name: '林晚', avatar: 'data:image/jpeg;base64,A' }] },
      { id: 'wbB', name: '乙书', entries: [{ id: 'eB', type: '角色', name: '林晚', avatar: 'data:image/jpeg;base64,B' }] }
    ];
    expect((await m.resolveBaseImage('林晚', store([]), 'wbB')).dataUrl).toBe('data:image/jpeg;base64,B');
    expect((await m.resolveBaseImage('林晚', store([]), 'wbA')).dataUrl).toBe('data:image/jpeg;base64,A');
    const s2 = store([['img1', { full: 'ONE', book: 'wbA' }], ['img2', { full: 'TWO', book: 'wbB' }]]);
    const r = await m.resolveBaseImage('图1', s2, 'wbB');       // 甲书画的图，不能在乙书里用
    expect(r.ok).toBe(false);
    expect(r.error).toContain('另一本书');
    expect(r.error).toContain('甲书');
    expect((await m.resolveBaseImage('last', s2, 'wbB')).dataUrl).toBe('TWO');   // "上一张"跳过别本书的
    expect((await m.resolveBaseImage('图1', s2)).dataUrl).toBe('ONE');           // 不传 bookId 时照旧（比奇/旧调用）
  });
});

describe('genImagesHtml：编号徽标 + 改图/重修标注', () => {
  it('缩略图带「图3」、参数行含编号与"改自"/"两步重修"；过期图没有编号', () => {
    const s = store([
      ['img3', { full: 'data:image/png;base64,F', thumb: 'data:image/png;base64,T', seed: 7, size: '1024x1024', seconds: 31, prompt: 'x', base: '图1', hires: true }]
    ]);
    const html = m.genImagesHtml(s, { imageIds: ['img3'] }, 'BiqiAgent.viewImage');
    expect(html).toContain('cw-img-no">图3<');
    expect(html).toContain("BiqiAgent.viewImage('img3')");
    expect(html).toContain('图3 · 1024x1024');
    expect(html).toContain('改自图1');
    expect(html).toContain('两步重修');
    const expired = m.genImagesHtml(s, { imageIds: ['img9'] }, 'BiqiAgent.viewImage');
    expect(expired).toContain('cw-img-expired');
    expect(expired).not.toContain('cw-img-no');
  });
});
