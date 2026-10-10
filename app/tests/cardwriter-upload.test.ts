// 写卡「🖼 上传图片」（2026-10-08 用户要求）：用户自己的图 → 图号句柄 + 待发预览 → 随消息发给 AI，
// 之后"把图5改成…""看看图5""参考图5画一张"全部走已有的改图 / 看图同一条路。
// 覆盖：注册与压缩兜底（测环境没有 canvas/Image → 回落原图）、待发队列与预览条、移除语义
//（发过的不能删）、发送时挂 imageIds + 清空队列 + 注入"这一轮上传了图片"的系统说明、
// 带图的消息不算设计轮、上传图的参数行不再显示 seed/耗时。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { ImageCache } from '../src/lib/imagecache';
import { genImagesHtml } from '../src/domain/imagedraw';

const anyG = globalThis as unknown as Record<string, unknown>;

const ih = vi.hoisted(() => ({
  ready: true,
  statusResult: { ok: true, model: 'm.safetensors', hint: 'tag', caps: ['img2img'] } as any,
  statusCalls: 0,
  image: 'data:image/png;base64,FULLBYTES'
}));

vi.mock('../src/domain/imagehost', () => ({
  IMAGE_HOST_KEY: 'imageHostConfig',
  AVATAR_SIZE: 768,
  DRAFT_SIZE: 512,
  DRAFT_STEPS: 20,
  AVATAR_STORE_SIZE: 512,
  QUALITY_TIERS: {
    normal: { size: 768, steps: 8, label: '标准' },
    fast: { size: 512, steps: 12, label: '快' },
    draft: { size: 512, steps: 20, label: '草稿' },
    high: { size: 1024, steps: 36, label: '精细' }
  },
  ImageHost: {
    ready: () => ih.ready,
    config: () => ({ enabled: true, base: 'http://h:1', token: 't' }),
    save: (p: any) => p,
    status: async () => { ih.statusCalls++; return ih.statusResult; },
    draw: async () => ({ ok: true, jobId: 'job1' }),
    waitJob: async () => ({ ok: true, meta: { status: 'done', seed: 7, size: '768x768', elapsed: 5000 } }),
    imageDataUrl: async () => ih.image,
    applyAvatarToCharacter: () => ({ ok: true, message: '已设头像' })
  },
  default: {}
}));

let WB_BOOKS: any[] = [];
const wbm = WBM as unknown as Record<string, any>;
wbm.getActiveId = () => 'wb1';
wbm.getAll = () => WB_BOOKS;
wbm.getActive = () => WB_BOOKS[0] || null;
wbm.saveAll = (arr: any[]) => { WB_BOOKS = arr; };
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined, viewAvatar: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.CharacterManager = { getByWorldBook: () => [] };
anyG.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' }) };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
anyG.escapeHTML = (x: unknown) => String(x == null ? '' : x);
anyG.ChatMode = { ensureTempCharacter: () => '' };

function el(): any {
  return {
    value: '', innerHTML: '', textContent: '', style: { setProperty() {}, display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    children: [], scrollTop: 0, checked: false,
    querySelector: () => el(),
  };
}

let C: any;
/** 直接拿输入框/预览条的桩元素（anyG.document 是 unknown，统一在这里收口）。 */
function inputEl(): any { return (anyG.document as any).getElementById('cardwriterInput'); }
function stripEl(): any { return els.get('cwUploadStrip'); }
beforeAll(async () => {
  await import('../src/domain/cardwriter');
  C = anyG.CardWriterChat;
});

const els = new Map<string, any>();
beforeEach(() => {
  els.clear();
  anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), getElementsByClassName: () => [], body: el(),
    addEventListener() {}, removeEventListener() {}, visibilityState: 'visible',
  };
  anyG.StorageManager = { get: (_k: string, d: unknown) => d, set: () => undefined, remove: () => undefined };
  anyG.App = { toast() {}, resetChatInput() {}, getBackendAPIConfig() { return null; }, thinkingLevel() { return 'auto'; } };
  WB_BOOKS = [{ id: 'wb1', name: '测试书', entries: [] }];
  ImageCache.__resetForTest();
  C.messages = [];
  C._draft = { characters: [], entries: [], deleted: [] };
  C._genImages.clear(); C._imgSeq = 0; C._imgGone.clear();
  C._uploads = [];
  C._isSending = false;
  C._hostStatus = { at: 0, ok: false, model: '', hint: '' };
  C._drawToolsOn = false;
  C._statusText = '';
  delete anyG.FileReader;
});

describe('写卡上传图片：注册 / 预览条 / 移除', () => {
  it('addUploadedImage：存句柄（uploaded 标记 + 尺寸 + 归属书）、进待发队列、落本地存档、预览条出现图号', async () => {
    const id = await C.addUploadedImage('data:image/png;base64,ORIGIN', '800×600');
    expect(id).toBe('img1');
    const g = C._genImages.get('img1');
    expect(g.uploaded).toBe(true);
    expect(g.size).toBe('800×600');
    expect(g.book).toBe('wb1');
    expect(g.full).toBe('data:image/png;base64,ORIGIN');   // 测环境没有 canvas → 压缩回落原图（真机会压到长边 1280）
    expect(C._uploads).toEqual(['img1']);
    const rec = await ImageCache.get('wb1', 'img1');
    expect(rec).toBeTruthy();
    expect(rec!.uploaded).toBe(true);
    const strip = stripEl();
    expect(strip.style.display).toBe('flex');
    expect(strip.innerHTML).toContain('图1');
    expect(strip.innerHTML).toContain('removeUpload');
    // 2026-10-08 用户要求：预览条里**只放缩略图本身**——不加尺寸，也不加"发送时带给 AI"这类文字
    expect(strip.innerHTML).not.toContain('800×600');
    expect(strip.innerHTML).not.toContain('发送时带给 AI');
  });

  it('addUploadedImage：不是图片 dataURL → 空串、什么都不建', async () => {
    expect(await C.addUploadedImage('data:text/plain;base64,AAA')).toBe('');
    expect(await C.addUploadedImage('')).toBe('');
    expect(C._genImages.size).toBe(0);
    expect(C._uploads.length).toBe(0);
  });

  it('待发队列封顶 5 张：第 6 张不建句柄（提示由 handleImageFile 统一给，单张调用不弹）', async () => {
    const toasts: string[] = [];
    anyG.App = { toast: (m: string) => { toasts.push(String(m)); }, resetChatInput() {}, thinkingLevel() { return 'auto'; } };
    for (let i = 0; i < 5; i++) expect(await C.addUploadedImage('data:image/png;base64,X' + i, '')).toBeTruthy();
    expect(await C.addUploadedImage('data:image/png;base64,SIXTH', '')).toBe('');
    expect(C._uploads.length).toBe(5);
    expect(C._genImages.size).toBe(5);
    expect(toasts.length).toBe(0);                      // 单张路径不再自己弹提示（避免多选时每张弹一次）
  });

  it('一次多选：5 张一起选全部进来、预览条里 5 个缩略图都在，第 6 张被挡下并汇总提示', async () => {
    const toasts: string[] = [];
    anyG.App = { toast: (m: string) => { toasts.push(String(m)); }, resetChatInput() {}, thinkingLevel() { return 'auto'; } };
    let seq = 0;
    anyG.FileReader = class {
      result = '';
      onload: any = null;
      onerror: any = null;
      readAsDataURL() {
        seq++;
        this.result = 'data:image/png;base64,MULTI' + seq;
        setTimeout(() => { if (this.onload) this.onload({}); }, 0);
      }
    };
    const files = [0, 1, 2, 3, 4, 5].map(() => ({ type: 'image/png', size: 1024 }));
    await C.handleImageFile({ target: { files: files } });

    expect(C._uploads.length).toBe(5);                  // 前 5 张进来
    expect(C._genImages.size).toBe(5);
    const strip = stripEl();
    expect((strip.innerHTML.match(/<img /g) || []).length).toBe(5);   // 输入栏上方 5 张都看得到
    expect(strip.innerHTML).toContain('图5');
    expect(toasts.join(' ')).toContain('已添加 5 张图（图1 ~ 图5）');
    expect(toasts.join(' ')).toContain('最多同时放 5 张');
  });

  it('上传图的参数行写"上传的图片"，不再显示 seed/耗时', async () => {
    await C.addUploadedImage('data:image/png;base64,ORIGIN', '800×600');
    const html = genImagesHtml(C._genImages, { imageIds: ['img1'] }, 'CardWriterChat.viewImage', { gone: C._imgGone });
    expect(html).toContain('上传的图片');
    expect(html).not.toContain('seed');
    expect(html).toContain('图1');
  });

  it('removeUpload：还没发出去 → 连句柄一起删、预览条收起；已发出去的不许删（历史消息还要显示）', async () => {
    await C.addUploadedImage('data:image/png;base64,ORIGIN', '800×600');
    C.removeUpload('img1');
    expect(C._uploads.length).toBe(0);
    expect(C._genImages.has('img1')).toBe(false);
    expect(stripEl().style.display).toBe('none');

    const id2 = await C.addUploadedImage('data:image/png;base64,SECOND', '');
    C.messages = [{ role: 'user', content: '把这张改成雪夜', imageIds: [id2] }];
    C.removeUpload(id2);
    expect(C._uploads.length).toBe(0);
    expect(C._genImages.has(id2)).toBe(true);           // 发过 → 句柄留着（气泡里要继续显示）
  });

  it('handleImageFile：非图片 / 超大直接拒；正常图片走 FileReader 注册', async () => {
    const toasts: string[] = [];
    anyG.App = { toast: (m: string) => { toasts.push(String(m)); }, resetChatInput() {}, thinkingLevel() { return 'auto'; } };

    await C.handleImageFile({ target: { files: [{ type: 'text/plain', size: 10 }] } });
    expect(toasts.join(' ')).toContain('不是图片或读不出来');
    await C.handleImageFile({ target: { files: [{ type: 'image/png', size: 21 * 1024 * 1024 }] } });
    expect(toasts.join(' ')).toContain('太大');
    expect(C._uploads.length).toBe(0);

    // 桩 FileReader（node 测环境没有）：模拟选中一张 PNG
    anyG.FileReader = class {
      result = 'data:image/png;base64,PICKED';
      onload: any = null;
      onerror: any = null;
      readAsDataURL() { setTimeout(() => { if (this.onload) this.onload({}); }, 0); }
    };
    await C.handleImageFile({ target: { files: [{ type: 'image/png', size: 1024 }] } });
    expect(C._uploads).toEqual(['img1']);
    expect(C._genImages.get('img1').full).toBe('data:image/png;base64,PICKED');
    expect(toasts.join(' ')).toContain('已添加 1 张图（图1）');
  });
});

describe('写卡上传图片：随消息发给 AI', () => {
  /** 同 cardwriter-vision-attach 的桩：不真落盘/重绘，只观察每一轮请求的 msgs。 */
  function primeTurn(): any {
    const c: any = anyG.CardWriterChat;
    c._save = () => {};
    c._saveDraft = () => {};
    c.renderMessages = () => {};
    c.renderDraft = () => {};
    c._snapshotNow = () => {};
    c._syncDraftFromWorldbook = () => {};
    c.refreshContext = function () {
      (this as any)._context = { wb: { id: 'wb1' }, bookName: '测试书', charsText: '', charCount: 0, worldSetting: true, wbParts: [] };
    };
    return c;
  }
  function scriptedApi(seen: any[]): any {
    return {
      probeToolsSupport: () => Promise.resolve(true),
      abort: () => undefined,
      fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, _onErr: any, o: any) => {
        seen.push({ msgs: msgs, label: String((o && o.callLabel) || '') });
        _onChunk('好，我看看。');
        onDone('好，我看看。', false, '');
        return Promise.resolve();
      },
    };
  }
  function sysText(msgs: any[]): string {
    return (msgs || []).filter((m: any) => m && m.role === 'system').map((m: any) => String(m.content)).join('\n');
  }

  it('只选图不写字也能发：默认文案 + 图挂在这条 user 消息上 + 队列清空 + 系统说明带图号', async () => {
    const c = primeTurn();
    await c.addUploadedImage('data:image/png;base64,ORIGIN', '800×600');
    const seen: any[] = [];
    anyG.APIHandler = scriptedApi(seen);
    inputEl().value = '';

    c._sendMessageInner();
    await new Promise((r) => setTimeout(r, 0));

    const um = c.messages.find((m: any) => m.role === 'user');
    expect(um.content).toBe('看看我上传的这张图。');
    expect(um.imageIds).toEqual(['img1']);
    expect(c._uploads.length).toBe(0);
    expect(stripEl().style.display).toBe('none');
    const note = sysText(seen[0].msgs);
    expect(note).toContain('【用户这一轮上传了图片】');
    expect(note).toContain('图1（800×600）');
    expect(note).toContain('base_image');
    expect(note).toContain('look_at_image');
  });

  it('带图的消息不算设计轮（看 + 改要能跨两轮工具）；普通问句没有图时仍是设计轮', async () => {
    const c = primeTurn();
    await c.addUploadedImage('data:image/png;base64,ORIGIN', '800×600');
    const seen: any[] = [];
    anyG.APIHandler = scriptedApi(seen);
    inputEl().value = '这张图怎么样？';
    c._sendMessageInner();
    await new Promise((r) => setTimeout(r, 0));
    expect(c._designTurn).toBe(false);

    c.messages = []; c._uploads = []; c._genImages.clear(); c._imgSeq = 0;
    c._isSending = false;
    inputEl().value = '这张图怎么样？';
    c._sendMessageInner();
    await new Promise((r) => setTimeout(r, 0));
    expect(c._designTurn).toBe(true);
  });

  it('没有图时行为不变：空输入不发送；普通消息也不注入上传说明', async () => {
    const c = primeTurn();
    const seen: any[] = [];
    anyG.APIHandler = scriptedApi(seen);
    inputEl().value = '';
    c._sendMessageInner();
    expect(c.messages.length).toBe(0);                  // 空输入直接返回
    expect(seen.length).toBe(0);

    inputEl().value = '帮我想想世界观';
    c._sendMessageInner();
    await new Promise((r) => setTimeout(r, 0));
    expect(c.messages.length).toBeGreaterThan(0);
    expect(sysText(seen[0].msgs)).not.toContain('【用户这一轮上传了图片】');
  });
});
