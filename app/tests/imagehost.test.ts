// 画图主机客户端 + 图片数据工具的单测。
// 环境：app/tests/setup.ts（内存 localStorage / 断网 fetch / 最小 document），
// 这里按需覆写 StorageManager（真存）与 fetch（假响应），并按需给 WorldBookManager/SettingsSyncManager 打桩。
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => ({
  books: [] as any[],
  saved: 0,
  temp: null as any,
  uiWB: 0, uiAgent: 0, uiDB: 0, chatRefresh: 0, realRender: 0
}));

vi.mock('../src/domain/worldbook', () => ({
  WorldBookManager: {
    getAll: () => h.books,
    getActive: () => h.books[0] || null,
    saveAll: () => { h.saved++; }
  }
}));
vi.mock('../src/domain/settingsync', () => ({
  SettingSyncManager: {
    setTempAvatar: (id: string, url: string) => { h.temp = { id, url }; return true; },
    withMode: (_m: string, fn: any) => fn()
  }
}));

let ImageHost: any;
let scaleSize: any;
let bytesToDataUrl: any;
let AVATAR_SIZE = 0, DRAFT_SIZE = 0, DRAFT_STEPS = 0, AVATAR_STORE_SIZE = 0;
let FAST_SIZE = 0, FAST_STEPS = 0, HIGH_SIZE = 0, HIGH_STEPS = 0, QUALITY_TIERS: any = null;

const store = new Map<string, any>();

beforeAll(async () => {
  (globalThis as any).StorageManager = {
    get: (k: string, d?: any) => (store.has('lnw_' + k) ? store.get('lnw_' + k) : (store.has(k) ? store.get(k) : d)),
    set: (k: string, v: any) => { store.set(k, v); store.set('lnw_' + k, v); },
    remove: (k: string) => { store.delete(k); store.delete('lnw_' + k); }
  };
  (globalThis as any).UIManager = {
    renderWBEntries: () => { h.uiWB++; },
    renderAgentPage: () => { h.uiAgent++; },
    renderDBRecords: () => { h.uiDB++; }
  };
  (globalThis as any).ChatMode = { refreshAvatars: () => { h.chatRefresh++; }, ensureTempCharacter: () => '' };
  (globalThis as any).RealMode = { render: () => { h.realRender++; } };
  const dataMod = await import('../src/lib/imagedata');
  scaleSize = dataMod.scaleSize; bytesToDataUrl = dataMod.bytesToDataUrl;
  const mod = await import('../src/domain/imagehost');
  ImageHost = mod.ImageHost; AVATAR_SIZE = mod.AVATAR_SIZE; DRAFT_SIZE = mod.DRAFT_SIZE; DRAFT_STEPS = mod.DRAFT_STEPS; AVATAR_STORE_SIZE = mod.AVATAR_STORE_SIZE;
  FAST_SIZE = mod.FAST_SIZE; FAST_STEPS = mod.FAST_STEPS; HIGH_SIZE = mod.HIGH_SIZE; HIGH_STEPS = mod.HIGH_STEPS; QUALITY_TIERS = mod.QUALITY_TIERS;
});

beforeEach(() => {
  store.clear();
  h.books = []; h.saved = 0; h.temp = null;
  h.uiWB = h.uiAgent = h.uiDB = h.chatRefresh = h.realRender = 0;
  (globalThis as any).fetch = () => Promise.reject(new Error('network disabled in tests'));
});

function fakeFetch(handler: (url: string, opt?: any) => any) {
  (globalThis as any).fetch = vi.fn(async (url: string, opt?: any) => handler(String(url), opt));
}
const jsonRes = (obj: any, status = 200) => ({ ok: status < 400, status, json: async () => obj });

describe('imagedata', () => {
  it('scaleSize 按长边等比缩放，小于上限则原样', () => {
    expect(scaleSize(768, 768, 512)).toEqual({ w: 512, h: 512 });
    expect(scaleSize(896, 1344, 512)).toEqual({ w: 341, h: 512 });
    expect(scaleSize(400, 300, 512)).toEqual({ w: 400, h: 300 });
  });
  it('bytesToDataUrl 分块 base64（跨 chunk 边界也正确）', () => {
    const bytes = new Uint8Array(0x8000 + 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    const got = bytesToDataUrl(bytes, 'image/png');
    expect(got).toBe('data:image/png;base64,' + Buffer.from(bytes).toString('base64'));
    expect(bytesToDataUrl(new Uint8Array(0))).toBe('');
  });
});

describe('ImageHost 配置', () => {
  it('默认关闭；save 会归一化地址、去 token 空白', () => {
    expect(ImageHost.config()).toEqual({ enabled: false, base: '', token: '' });
    const saved = ImageHost.save({ enabled: true, base: ' 192.168.1.5:8787/ ', token: ' abc ' });
    expect(saved).toEqual({ enabled: true, base: 'http://192.168.1.5:8787', token: 'abc' });
    expect(ImageHost.config()).toEqual(saved);
    expect(ImageHost.ready()).toBe(true);
  });
  it('尺寸/步数与档位表（头像 768 / 草稿 512+20 / 快 512+12 / 精细 1024+36）', () => {
    expect([AVATAR_SIZE, DRAFT_SIZE, AVATAR_STORE_SIZE, FAST_SIZE, FAST_STEPS, HIGH_SIZE, HIGH_STEPS]).toEqual([768, 512, 512, 512, 12, 1024, 36]);
    expect(DRAFT_STEPS).toBe(20);
    expect(QUALITY_TIERS.normal.steps).toBeUndefined();       // 标准档交回工作流
    expect(Object.keys(QUALITY_TIERS)).toEqual(['fast', 'draft', 'normal', 'high']);
  });
});

describe('ImageHost.status', () => {
  beforeEach(() => { ImageHost.save({ enabled: true, base: 'http://h:1', token: 't' }); });

  it('解析工作流信息（模型/风格说明/步数/尺寸）', async () => {
    fakeFetch((url, opt) => {
      expect(url).toBe('http://h:1/api/comfy/status');
      expect((opt.headers || {}).Authorization).toBe('Bearer t');
      return jsonRes({ ok: true, version: '0.38.2', workflow: { model: 'miaomiao.safetensors', hint: 'tag 风格', steps: 12, size: '896x1344' } });
    });
    const st = await ImageHost.status();
    expect(st.ok).toBe(true);
    expect(st.model).toBe('miaomiao.safetensors');
    expect(st.hint).toBe('tag 风格');
    expect(st.steps).toBe(12);
  });

  it('401 报"配对 token 不对"，连不上报超时/网络错误', async () => {
    fakeFetch(() => jsonRes({ error: '未授权' }, 401));
    expect((await ImageHost.status()).error).toContain('token');
    (globalThis as any).fetch = () => Promise.reject(new Error('Failed to fetch'));
    expect((await ImageHost.status()).ok).toBe(false);
  });

  it('没配地址时完全不发请求', async () => {
    ImageHost.save({ base: '' });
    fakeFetch(() => { throw new Error('不该发请求'); });
    const st = await ImageHost.status();
    expect(st.ok).toBe(false);
    expect(st.error).toContain('未配置');
  });
});

describe('ImageHost.draw / waitJob', () => {
  beforeEach(() => { ImageHost.save({ enabled: true, base: 'http://h:1', token: 't' }); });

  it('提交后轮询到 done，onTick 收到进度', async () => {
    let n = 0;
    fakeFetch((url, opt) => {
      if (url.endsWith('/api/comfy/draw')) {
        expect(opt.method).toBe('POST');
        expect(JSON.parse(opt.body).width).toBe(768);
        return jsonRes({ jobId: 'job1' });
      }
      n++;
      return jsonRes(n < 2 ? { status: 'running', elapsed: 3000, seed: 7, size: '768x768' } : { status: 'done', elapsed: 9800, seed: 7, size: '768x768' });
    });
    const d = await ImageHost.draw({ prompt: 'p', width: 768, height: 768 });
    expect(d).toEqual({ ok: true, jobId: 'job1' });
    const ticks: any[] = [];
    const w = await ImageHost.waitJob('job1', { intervalMs: 5, timeoutMs: 2000, onTick: (j: any) => ticks.push(j) });
    expect(w.ok).toBe(true);
    expect(w.meta.size).toBe('768x768');
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });

  it('出图失败/超时都返回结构化错误', async () => {
    fakeFetch(() => jsonRes({ status: 'failed', error: 'ComfyUI 拒绝：HTTP 500' }));
    const w = await ImageHost.waitJob('j', { intervalMs: 5, timeoutMs: 1000 });
    expect(w.ok).toBe(false);
    expect(w.error).toContain('ComfyUI 拒绝');
    fakeFetch(() => jsonRes({ status: 'running', elapsed: 1 }));
    const t = await ImageHost.waitJob('j', { intervalMs: 5, timeoutMs: 30 });
    expect(t.ok).toBe(false);
    expect(t.error).toContain('超时');
  });

  it('imageDataUrl 把 PNG 字节转成 dataURL', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    fakeFetch(() => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }));
    const url = await ImageHost.imageDataUrl('job1');
    expect(url).toBe('data:image/png;base64,' + Buffer.from(bytes).toString('base64'));
  });
});

describe('ImageHost.applyAvatarToCharacter', () => {
  it('原书角色：写 entry.avatar + saveAll + 全量刷新', () => {
    const entries: any[] = [
      { id: 'e1', type: '角色', name: '林晚', content: '…' },
      { id: 'e2', type: '世界观', name: '世界观', content: '…' }
    ];
    h.books = [{ id: 'wb1', entries }];
    const r = ImageHost.applyAvatarToCharacter('林晚', 'data:image/jpeg;base64,AAA');
    expect(r.ok).toBe(true);
    expect(entries[0].avatar).toBe('data:image/jpeg;base64,AAA');
    expect(entries[1].avatar).toBeUndefined();
    expect(h.saved).toBe(1);
    expect(h.uiWB).toBe(1);
    expect(h.uiAgent).toBe(1);
    expect(h.uiDB).toBe(1);
    expect(h.chatRefresh).toBe(1);
    expect(h.realRender).toBe(1);
  });

  it('临时角色：走 overlay（ensureTempCharacter 返回 id）', () => {
    h.books = [{ id: 'wb1', entries: [] }];
    (globalThis as any).ChatMode.ensureTempCharacter = () => 'tmp7';
    const r = ImageHost.applyAvatarToCharacter('新角色', 'data:image/jpeg;base64,BBB');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('临时角色');
    expect(h.temp).toEqual({ id: 'tmp7', url: 'data:image/jpeg;base64,BBB' });
  });

  it('找不到角色时以"未找到"开头（命中写卡失败判据），缺参数以"工具调用参数无效"开头', () => {
    h.books = [{ id: 'wb1', entries: [] }];
    (globalThis as any).ChatMode.ensureTempCharacter = () => '';
    expect(ImageHost.applyAvatarToCharacter('张三', 'data:x,1').message).toMatch(/^未找到角色条目/);
    expect(ImageHost.applyAvatarToCharacter('', 'data:x,1').message).toMatch(/^工具调用参数无效/);
    expect(ImageHost.applyAvatarToCharacter('林晚', '').message).toMatch(/^失败：/);
  });
});
