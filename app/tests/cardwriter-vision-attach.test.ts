// 主对话「直接看图」（2026-10-06 用户要求：图片不再只走「没有预设」的独立子调用）；
// **2026-10-08 用户要求：出图后不再自动附图/自动核对**——只有模型自己调 look_at_image 才会附图。
// 三条路（visionCaps 三态，见 imagedraw.ts IMG_TURN_FLAG）：
//   · 'yes'     → 把图作为**临时 user 消息**附进主对话本轮请求（模型带着角色卡/用户原话自己看），不额外调用；
//   · 'unknown' → 转一次独立子调用（探针 + 把回答当工具结果）；
//   · 'no'      → 什么都不做。
// 兜底：端点不接受图片（4xx + image/vision 词）时**摘掉图片、记 no、同轮重试一次**，主对话不能因此失败。
// 另：附图消息不落库、不进历史（否则 40 轮窗口里每轮都重发图片 token）。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { visionState, markVision, __resetVisionForTest } from '../src/lib/vision';

const anyG = globalThis as unknown as Record<string, unknown>;

const ih = vi.hoisted(() => ({
  ready: true,
  statusResult: { ok: true, model: 'm.safetensors', hint: 'tag', caps: ['img2img'] } as any,
  image: 'data:image/png;base64,FULLBYTES'
}));

vi.mock('../src/domain/imagehost', () => ({
  IMAGE_HOST_KEY: 'imageHostConfig',
  AVATAR_SIZE: 768,
  DRAFT_SIZE: 512,
  DRAFT_STEPS: 20,
  AVATAR_STORE_SIZE: 512,
  QUALITY_TIERS: { normal: { size: 768, steps: 8, label: '标准' } },
  ImageHost: {
    ready: () => ih.ready,
    config: () => ({ enabled: true, base: 'http://h:1', token: 't' }),
    save: (p: any) => p,
    status: async () => ih.statusResult,
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
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
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

beforeAll(async () => {
  await import('../src/domain/cardwriter');
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
  __resetVisionForTest();
  const c: any = anyG.CardWriterChat;
  c.messages = [];
  c._draft = { characters: [], entries: [], deleted: [] };
  c._genImages.clear(); c._imgSeq = 0; c._imgGone.clear();
  c._attachQueue = []; c._imgStripped = false; c._visionNoToast = false;
  c._hostStatus = { at: 0, ok: false, model: '', hint: '' };
  c._statusText = '';
});

// 给 `_callAPI` 打桩：不真落盘/重绘，只观察每一轮请求的 msgs
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

/** 图片消息 = role 为 user 且 content 是数组（附图专用形态）。 */
function imageTurns(msgs: any[]): any[] {
  return (msgs || []).filter((m: any) => m && m.role === 'user' && Array.isArray(m.content));
}

// 注意：agent 循环里各轮**共用同一个 msgs 数组**（原地追加），所以每次请求必须在回调当场
// 记录"这一刻有几张图"，事后回看 seen[i] 会看到被后续轮追加过的同一个数组。
interface TurnSnap { msgs: any[]; label: string; imgs: any[] }
function snap(msgs: any[], o: any): TurnSnap {
  const imgs = imageTurns(msgs);
  return { msgs, label: String((o && o.callLabel) || ''), imgs: imgs.map((m: any) => ({ text: String(m.content[0] && m.content[0].text || ''), url: String(m.content[1] && m.content[1].image_url && m.content[1].image_url.url || '') })) };
}

/** 一次"出图（或别的工具）→ 收尾"的脚本化 API：第一轮回 opts.tool，之后回文字。 */
function scriptedApi(seen: TurnSnap[], opts: { failSecondWith?: string; tool?: any } = {}): any {
  const tool = opts.tool || { id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, rain' } };
  return {
    probeToolsSupport: () => Promise.resolve(true),
    abort: () => undefined,
    fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, onErr: any, o: any) => {
      seen.push(snap(msgs, o));
      if (seen.length === 1) { (o && o.onTools)([tool]); return Promise.resolve(); }
      if (opts.failSecondWith && seen.length === 2) { onErr(opts.failSecondWith); return Promise.resolve(); }
      // 正文走流式回调（真实现只在 onChunk 累积过文本时才写气泡，见 cardwriter 的 onDone）
      _onChunk('画好了。');
      onDone('画好了。', false, '');
      return Promise.resolve();
    },
  };
}

describe('主对话直接看图：默认不看（2026-10-08 起）', () => {
  it("caps='yes'：出图后**不**自动附图（作者没要求就不看），也不发子调用", async () => {
    const c = primeTurn();
    markVision('yes');
    const seen: TurnSnap[] = [];
    let visionSubcalls = 0;
    const base = scriptedApi(seen);
    anyG.APIHandler = {
      probeToolsSupport: base.probeToolsSupport,
      abort: base.abort,
      fetchCompletions: (msgs: any[], onChunk: any, onDone: any, onErr: any, o: any) => {
        if (o && o.callLabel === 'vision') visionSubcalls++;
        return (base.fetchCompletions as any)(msgs, onChunk, onDone, onErr, o);
      },
    };

    await c._callAPI('画一张雨里的她');

    expect(seen.length).toBe(2);                        // 出图轮 + 收尾轮
    expect(visionSubcalls).toBe(0);                     // 没有"没有预设"的看图子调用
    expect(seen[0].imgs.length).toBe(0);                // 第一轮（还没出图）没有图
    expect(seen[1].imgs.length).toBe(0);                // 第二轮：出图后**也不**自动附图（用户只是跑图）
    // 附图只活在请求里：消息历史里一个 image_url 都没有（否则每轮都要重发图片 token）
    expect(JSON.stringify(c.messages)).not.toContain('image_url');
    expect(c._attachQueue.length).toBe(0);              // 队列也没堆东西
  });

  it("caps='unknown'：出图也不发独立子调用（不自动看图，能力不猜）", async () => {
    const c = primeTurn();
    expect(visionState()).toBe('unknown');
    const seen: TurnSnap[] = [];
    let visionSubcalls = 0;
    anyG.APIHandler = {
      probeToolsSupport: () => Promise.resolve(true),
      abort: () => undefined,
      fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, _onErr: any, o: any) => {
        seen.push(snap(msgs, o));
        if (o && o.callLabel === 'vision') { visionSubcalls++; onDone('不该被调用'); return Promise.resolve(); }
        if (seen.filter((x) => x.label !== 'vision').length === 1) {
          (o && o.onTools)([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, rain' } }]);
          return Promise.resolve();
        }
        _onChunk('画好了。');
        onDone('画好了。', false, '');
        return Promise.resolve();
      },
    };

    await c._callAPI('画一张雨里的她');

    const mainCalls = seen.filter((x) => x.label !== 'vision');
    expect(mainCalls.length).toBe(2);
    expect(visionSubcalls).toBe(0);                                 // 出图不再触发探针
    expect(mainCalls[1].imgs.length).toBe(0);
    const injected = mainCalls[1].msgs.find((m: any) => m.role === 'system' && String(m.content).indexOf('软件替你看过') >= 0);
    expect(injected).toBeFalsy();                                   // 也不再有"软件替你看过"的记录
    expect(visionState()).toBe('unknown');                          // 要看图得等模型自己调 look_at_image
  });

  it("出图后模型自己调 look_at_image：图照常附上（'yes' 时附图不额外调模型）", async () => {
    const c = primeTurn();
    markVision('yes');
    const seen: TurnSnap[] = [];
    let visionSubcalls = 0;
    anyG.APIHandler = {
      probeToolsSupport: () => Promise.resolve(true),
      abort: () => undefined,
      fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, _onErr: any, o: any) => {
        seen.push(snap(msgs, o));
        if (o && o.callLabel === 'vision') { visionSubcalls++; onDone('不该被调用'); return Promise.resolve(); }
        const n = seen.filter((x) => x.label !== 'vision').length;
        if (n === 1) { (o && o.onTools)([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, rain' } }]); return Promise.resolve(); }
        if (n === 2) { (o && o.onTools)([{ id: 'c2', name: 'look_at_image', arguments: { image_id: '图1', question: '这张的手有没有问题' } }]); return Promise.resolve(); }
        _onChunk('画好了，也看过了。');
        onDone('画好了，也看过了。', false, '');
        return Promise.resolve();
      },
    };

    await c._callAPI('画一张，顺手看看手有没有问题');

    expect(visionSubcalls).toBe(0);                     // 能看图 → 附图、不额外调用
    const mains = seen.filter((x) => x.label !== 'vision');
    expect(mains[1].imgs.length).toBe(0);               // 出图后不自动附
    expect(mains[2].imgs.length).toBe(1);               // 自己去看了才附
    expect(mains[2].imgs[0].text).toContain('手有没有问题');
  });

  it("caps='yes' + look_at_image：图由软件附上、工具结果只回一句「已附」，不再调模型", async () => {
    const c = primeTurn();
    markVision('yes');
    c._genImages.set('img1', { full: 'data:image/png;base64,F', thumb: 'data:image/jpeg;base64,THUMB', book: 'wb1' });
    const seen: TurnSnap[] = [];
    let visionSubcalls = 0;
    anyG.APIHandler = {
      probeToolsSupport: () => Promise.resolve(true),
      abort: () => undefined,
      fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, _onErr: any, o: any) => {
        seen.push(snap(msgs, o));
        if (o && o.callLabel === 'vision') { visionSubcalls++; onDone('不该被调用'); return Promise.resolve(); }
        if (seen.filter((x) => x.label !== 'vision').length === 1) { (o && o.onTools)([{ id: 'c1', name: 'look_at_image', arguments: { image_id: '图1', question: '她的发色是什么' } }]); return Promise.resolve(); }
        _onChunk('我看到她是黑发。');
        onDone('我看到她是黑发。', false, '');
        return Promise.resolve();
      },
    };

    await c._callAPI('看看图1');

    expect(visionSubcalls).toBe(0);                                 // 能看图 → 不再有独立子调用
    const mainCalls = seen.filter((x) => x.label !== 'vision');
    const toolMsg = mainCalls[1].msgs.find((m: any) => m.role === 'tool');
    expect(String(toolMsg.content)).toContain('已附在你这条消息后面');
    expect(mainCalls[1].imgs.length).toBe(1);
    expect(mainCalls[1].imgs[0].text).toContain('她的发色是什么');
    expect(mainCalls[1].imgs[0].url).toContain('THUMB');
  });
});

describe('主对话直接看图：端点不接受图片时的兜底（摘图重试）', () => {
  const LOOK = { id: 'c1', name: 'look_at_image', arguments: { image_id: '图1', question: '手有没有问题' } };

  it('400 + image_url → 摘掉图片同轮重试一次、记 visionCaps=no，主对话不失败', async () => {
    const c = primeTurn();
    markVision('yes');
    c._genImages.set('img1', { full: 'data:image/png;base64,F', thumb: 'data:image/jpeg;base64,THUMB', book: 'wb1' });
    const seen: TurnSnap[] = [];
    anyG.APIHandler = scriptedApi(seen, { failSecondWith: 'HTTP 400: image_url is not supported by this model', tool: LOOK });

    await c._callAPI('看看图1的手');

    expect(seen.length).toBe(3);                                    // 看图轮 / 失败轮（带图）/ 重试轮（无图）
    expect(seen[1].imgs.length).toBe(1);                            // 第二次确实带了图（于是才失败）
    expect(seen[2].imgs.length).toBe(0);                            // 第三次把图摘掉了
    expect(visionState()).toBe('no');                               // 记住这个模型看不了图，之后不再附
    const last = c.messages[c.messages.length - 1];
    expect(String(last.content)).toContain('画好了');                // 主对话照常收尾
    expect(c._isSending).toBe(false);
  });

  it('不像能力问题的报错（超时）→ 不摘图、不记 no（走原来的断线保留逻辑）', async () => {
    const c = primeTurn();
    markVision('yes');
    c._genImages.set('img1', { full: 'data:image/png;base64,F', thumb: 'data:image/jpeg;base64,THUMB', book: 'wb1' });
    const seen: TurnSnap[] = [];
    anyG.APIHandler = scriptedApi(seen, { failSecondWith: '请求超时 (300000ms)', tool: LOOK });

    await c._callAPI('看看图1的手');

    expect(seen.length).toBe(2);                                    // 没有摘图重试
    expect(visionState()).toBe('yes');                              // 能力判定不受影响
    expect(String(c.messages[c.messages.length - 1].content)).toContain('连接中断');
    expect(c._pausedResume).toBeTruthy();                           // 仍挂着「点继续接着跑」
  });
});
