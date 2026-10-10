// 比奇（BiqiAgent）的生图工具：draw_image
// 覆盖：门控（_drawToolsOn）、规则注入（在线=让画就直接画不反问 / 离线=不许提议生图）、
//      主机状态探测与 60 秒缓存、档位映射、出图链路（挂 imageIds / 存句柄 / 步骤行）、气泡内缩略图。
// 注：图方便直接用真 storage 与真 SettingSyncManager（与 biqi.test.ts 同套路），只把画图主机打桩。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import '../src/infra/storage';
import { PluginManager } from '../src/domain/plugins';
import { SettingSyncManager } from '../src/domain/settingsync';
import { WorldBookManager } from '../src/domain/worldbook';
import { BiqiAgent } from '../src/domain/biqi';
import { ImageCache } from '../src/lib/imagecache';
import { visionState, markVision, __resetVisionForTest } from '../src/lib/vision';

const g = globalThis as unknown as Record<string, any>;
const SM = () => (globalThis as unknown as { StorageManager: { get: (k: string, d?: unknown) => any; set: (k: string, v: unknown) => void; remove: (k: string) => void } }).StorageManager;

const ih = vi.hoisted(() => ({
  ready: true,
  statusCalls: 0,
  statusTimeouts: [] as any[],   // 每次 status 调用传的超时（探测 3000ms 的守卫）
  statusQueue: [] as any[],      // 依次返回的探测结果（测"失败重试"用；空了就用 statusResult）
  statusResult: { ok: true, reachable: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag', caps: ['img2img', 'hires'] } as any,
  drawCalls: [] as any[],
  drawResult: { ok: true, jobId: 'job1' } as any,
  waitResult: { ok: true, meta: { status: 'done', seed: 7, size: '768x768', elapsed: 9000 } } as any,
  image: 'data:image/png;base64,AAA'
}));

vi.mock('../src/domain/imagehost', () => ({
  IMAGE_HOST_KEY: 'imageHostConfig',
  AVATAR_SIZE: 768,
  DRAFT_SIZE: 512,
  DRAFT_STEPS: 20,
  FAST_SIZE: 512,
  FAST_STEPS: 12,
  HIGH_SIZE: 1024,
  HIGH_STEPS: 36,
  AVATAR_STORE_SIZE: 512,
  QUALITY_TIERS: {
    fast: { size: 512, steps: 12, label: '快' },
    draft: { size: 512, steps: 20, label: '草稿' },
    normal: { size: 768, steps: undefined, label: '标准' },
    high: { size: 1024, steps: 36, label: '精细' }
  },
  ImageHost: {
    ready: () => ih.ready,
    config: () => ({ enabled: ih.ready, base: 'http://h:1', token: 't' }),
    status: async (t: any) => {
      ih.statusCalls++; ih.statusTimeouts.push(t);
      if (ih.statusQueue.length) return ih.statusQueue.shift();
      return ih.statusResult;
    },
    draw: async (o: any) => { ih.drawCalls.push(o); return ih.drawResult; },
    waitJob: async (_id: any, o: any) => { if (o && o.onTick) o.onTick({ elapsed: 3000 }); return ih.waitResult; },
    imageDataUrl: async () => ih.image
  },
  default: {}
}));

const BOOK_ID = 'wb_biqi_img_test';

function seedBook() {
  WorldBookManager.saveAll([{ id: BOOK_ID, name: '测试书', entries: [{ id: 'e1', type: '角色', name: '苏黎', content: '性别：女', inject: true }] }] as never);
  WorldBookManager.setActiveId(BOOK_ID);
}

// 迷你 DOM：renderMessages 只写 innerHTML + 读 scrollTop/scrollHeight
const els: Record<string, any> = {};
const viewed: string[] = [];   // UIManager.viewAvatar 收到的原图（点缩略图看大图）
function setupDom() {
  for (const k of Object.keys(els)) delete els[k];
  els['biqiMessages'] = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  g.document = { getElementById: (id: string) => els[id] || null };
}

beforeAll(() => { /* biqi.ts 在 import 时就挂好了 globalThis.BiqiAgent */ });

beforeEach(() => {
  for (const k of ['worldBooks', 'activeWorldBookId', 'pluginEnabled:biqi', 'biqiHistory_' + BOOK_ID,
    'settingOverlay_' + BOOK_ID, 'settingDeltaPending_' + BOOK_ID, 'settingOverlaySnaps_' + BOOK_ID,
    'settingDeltaLog_' + BOOK_ID, 'settingDeltaMeta_' + BOOK_ID]) SM().remove(k);
  seedBook();
  PluginManager.setEnabled('biqi', true);
  ih.ready = true; ih.statusCalls = 0;
  ih.statusResult = { ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag', caps: ['img2img', 'hires'] };
  ih.drawCalls = []; ih.drawResult = { ok: true, jobId: 'job1' };
  ih.waitResult = { ok: true, meta: { status: 'done', seed: 7, size: '768x768', elapsed: 9000 } };
  ih.image = 'data:image/png;base64,AAA';
  g.App = { toast: () => undefined, collectRecentStoryText: () => ({ recentText: '正文片段：她在雨里站了很久。', fullEditorText: '' }) };
  g.UIManager = { viewAvatar: (src: any) => { viewed.push(String(src)); }, renderAgentPage: () => undefined, openAgentPage: () => undefined };
  g.htmlEscape = (x: unknown) => String(x == null ? '' : x);
  setupDom();
  viewed.length = 0;
  BiqiAgent.messages = [];
  BiqiAgent._isSending = false;
  BiqiAgent._steps = [];
  BiqiAgent._status = '';
  BiqiAgent._genImages.clear();
  BiqiAgent._imgSeq = 0;
  BiqiAgent._drawToolsOn = false;
  BiqiAgent._hostStatus = { at: 0, ok: false, model: '', hint: '' };
  BiqiAgent._mode = 'novel';
  BiqiAgent._loadedKey = 'biqiHistory_' + BOOK_ID;
  BiqiAgent._imgGone.clear();
  BiqiAgent._attachQueue = [];   // 待附图队列 / 看图能力逐例清干净（'yes' 泄漏会让后面的用例走附图分支）
  BiqiAgent._imgStripped = false;
  __resetVisionForTest();
  ImageCache.__resetForTest();   // 本地存档（内存后端）逐例清干净
});

function toolNames(): string[] {
  return (BiqiAgent._tools() as any[]).map((t: any) => t.function.name);
}
function drawTool(): any {
  return (BiqiAgent._tools() as any[]).find((t: any) => t.function.name === 'draw_image');
}

describe('比奇生图：门控与规则文案', () => {
  it('_tools：主机离线不给 draw_image；在线给，且描述带模型/画风与"直接调用"', () => {
    BiqiAgent._drawToolsOn = false;
    expect(toolNames()).not.toContain('draw_image');
    expect(toolNames()).toContain('read_worldbook');   // 原有工具不受影响

    BiqiAgent._drawToolsOn = true;
    BiqiAgent._hostStatus = { at: Date.now(), ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag', caps: ['img2img', 'hires'] };
    const d = drawTool();
    expect(d).toBeTruthy();
    expect(String(d.function.description)).toContain('miaomiaoRealskin_anima13');
    expect(String(d.function.description)).toContain('danbooru tag');
    expect(String(d.function.description)).toContain('直接调用');
    expect(String(d.function.description)).toContain('不要再问');
    expect(String(d.function.description)).toContain('base_image');   // 主机支持改图
    expect(d.function.parameters.required).toEqual(['prompt']);
    expect(Object.keys(d.function.parameters.properties)).not.toContain('strength');   // 比奇只做大改，不给幅度选项
    expect(String(d.function.parameters.properties.base_image.description)).toContain('角色名');
  });

  it('老主机（无 caps）：不给 base_image/strength，规则也不提"改图"参数', () => {
    BiqiAgent._drawToolsOn = true;
    BiqiAgent._hostStatus = { at: Date.now(), ok: true, model: 'm', hint: '', caps: [] };
    const props = Object.keys(drawTool().function.parameters.properties);
    expect(props).not.toContain('base_image');
    expect(props).not.toContain('strength');
  });

  it('比奇强制大改：带底图出图时 denoise=0.75（不给"小改"这个选项）', async () => {
    BiqiAgent.messages = [{ role: 'assistant', content: '' }];
    BiqiAgent._genImages.set('img1', { full: 'data:image/png;base64,SRC', thumb: 'data:image/png;base64,T', seed: 1, size: '768x768', seconds: 9, book: '' });
    BiqiAgent._imgSeq = 1;
    ih.drawCalls = [];
    await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', base_image: '图1', strength: 'slight' } } as any);
    expect(ih.drawCalls[0].initImage).toBe('data:image/png;base64,SRC');
    expect(ih.drawCalls[0].denoise).toBe(0.75);   // 就算模型传了 slight，也按大改走
  });

  it('_imageRuleMessage：在线=让画就直接画、不反问；离线=明确"没有画图能力"、不许提议', () => {
    BiqiAgent._drawToolsOn = true;
    BiqiAgent._hostStatus = { at: Date.now(), ok: true, model: 'm', hint: '', caps: ['img2img', 'hires'] };   // 规则里的默认识别角色头像要主机支持改图
    const on = BiqiAgent._imageRuleMessage();
    expect(on).toContain('不要再问');
    expect(on).toContain('别抢着画');
    expect(on).toContain('默认用 TA 的头像当底图');   // 用户 2026-10-06：画面里有角色时自动拿头像当底图（保脸）
    expect(on).toContain('大改');                 // 比奇只做大改（不暴露小改/中改）
    expect(on).toContain('配张图');               // 主场景：续写后直接配图，不问画什么
    expect(on).toContain('默认不看、更不要评价');   // 2026-10-08：只是跑图时不看也不评价
    expect(on).toContain('不要评价画面');
    expect(on).not.toContain('出图后软件会把刚画的图附给你看');   // 不再自动附图
    expect(on).not.toContain('你没有画图工具');

    BiqiAgent._drawToolsOn = false;
    const off = BiqiAgent._imageRuleMessage();
    expect(off).toContain('你没有画图工具');
    expect(off).toContain('不要提议"要不要我画一张"');
    expect(off).toContain('设置 → AI 与生成 → 画图主机');
    expect(off).not.toContain('不要再问');
  });

  it('_refreshHostStatus：未配置不发请求；在线置 true；60 秒内复用缓存；离线重试一次且只压 10 秒', async () => {
    ih.ready = false;
    await BiqiAgent._refreshHostStatus();
    expect(BiqiAgent._drawToolsOn).toBe(false);
    expect(ih.statusCalls).toBe(0);

    ih.ready = true;
    await BiqiAgent._refreshHostStatus();
    expect(BiqiAgent._drawToolsOn).toBe(true);
    expect(ih.statusCalls).toBe(1);
    expect(ih.statusTimeouts[0]).toBe(3000);           // 探测超时 3 秒（2026-10-08）
    await BiqiAgent._refreshHostStatus();
    expect(ih.statusCalls).toBe(1);                    // 缓存命中

    // 主机没答上话（reachable=false）→ 隔 700ms 重试一次，两次都失败才判离线（2026-10-08 用户要求）
    BiqiAgent._hostStatus = { at: 0, ok: false, model: '', hint: '' };
    ih.statusResult = { ok: false, reachable: false, error: '超时' };
    await BiqiAgent._refreshHostStatus();
    expect(BiqiAgent._drawToolsOn).toBe(false);
    expect(ih.statusCalls).toBe(3);                    // 1 首探 + 1 重试
    expect(BiqiAgent._hostStatus.err).toBe('超时');      // 诊断信息落进缓存（离线规则会念出来）

    // 2026-10-08：离线结果只压 10 秒（主机/ComfyUI 刚启动时 status 会先报 not ok，很快会恢复）
    ih.statusResult = { ok: true, reachable: true, model: 'm', hint: '', caps: ['img2img'] };
    await BiqiAgent._refreshHostStatus();
    expect(ih.statusCalls).toBe(3);                    // 10 秒内仍走缓存
    BiqiAgent._hostStatus.at = Date.now() - 11000;
    await BiqiAgent._refreshHostStatus();
    expect(ih.statusCalls).toBe(4);                    // 重新探测
    expect(BiqiAgent._drawToolsOn).toBe(true);
  });

  it('轮间重探（比奇）：强制重探忽略负缓存，探到在线就地改写生图规则；离线规则带诊断文案', async () => {
    BiqiAgent._drawToolsOn = false;
    BiqiAgent._hostStatus = { at: Date.now(), ok: false, model: '', hint: '', err: '超时', tookMs: 3000 };
    BiqiAgent._imgRuleMsg = { role: 'system', content: '【生图】本轮你没有画图工具——x\n' };
    BiqiAgent._hostReprobes = 0;
    BiqiAgent._lastReprobeAt = 0;
    // 离线规则里把"最近一次探测失败 + 等了几秒"带给模型（用户据此区分"连不上"和"慢/忙"）
    expect(BiqiAgent._imageRuleMessage()).toContain('最近一次探测失败');
    expect(BiqiAgent._imageRuleMessage()).toContain('等待 3.0 秒');

    ih.statusResult = { ok: true, reachable: true, model: 'm', hint: 'tag', caps: ['img2img'] };
    const got = await BiqiAgent._maybeReprobeHost();
    expect(got).toBe(true);
    expect(BiqiAgent._drawToolsOn).toBe(true);
    expect(ih.statusCalls).toBe(1);                    // force：不理会"刚判离线"的负缓存
    expect(String(BiqiAgent._imgRuleMsg.content)).toContain('你可以用 draw_image');   // 规则就地换在线版

    // 节流：紧接着再来一次不会再探（即使又回到离线态）
    BiqiAgent._drawToolsOn = false;
    await BiqiAgent._maybeReprobeHost();
    expect(ih.statusCalls).toBe(1);
  });
});

describe('比奇生图：draw_image 执行', () => {
  it('默认档 768×768：返回 image_id、挂到最后一条 assistant 消息、存句柄并落盘', async () => {
    BiqiAgent.messages = [{ role: 'user', content: '画一张' }, { role: 'assistant', content: '', _steps: [] }];
    const out = await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, rain, solo' } } as any);
    const j = JSON.parse(out);
    expect(j.ok).toBe(true);
    expect(j.image_id).toBe('img1');
    expect(j.size).toBe('768x768');
    expect(ih.drawCalls[0].width).toBe(768);
    expect(ih.drawCalls[0].height).toBe(768);
    expect(ih.drawCalls[0].steps).toBeUndefined();     // 标准档交回工作流（28 步）
    expect(BiqiAgent._genImages.size).toBe(1);
    expect(BiqiAgent._genImages.get('img1').seed).toBe(7);
    expect((BiqiAgent.messages[1] as any).imageIds).toEqual(['img1']);
    expect(SM().get('biqiHistory_' + BOOK_ID)[1].imageIds).toEqual(['img1']);  // 落盘（重开面板还在）
  });

  it('档位映射：fast=512/12、draft=512/20、high=1024/36、默认=768、旧 draft:true、未知回落', async () => {
    const cases: any[] = [
      [{ prompt: 'x', quality: 'fast' }, 512, 12],
      [{ prompt: 'x', quality: 'draft' }, 512, 20],
      [{ prompt: 'x', draft: true }, 512, 20],
      [{ prompt: 'x', quality: 'high' }, 1024, 36],
      [{ prompt: 'x', quality: '不存在' }, 768, undefined]
    ];
    for (const c of cases) {
      ih.drawCalls = [];
      await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: c[0] } as any);
      expect(ih.drawCalls[0].width).toBe(c[1]);
      expect(ih.drawCalls[0].steps).toBe(c[2]);
    }
  });

  it('失败分支：未配置 / 离线 / prompt 为空 / 出图失败 —— 都不挂图、错误透传', async () => {
    BiqiAgent.messages = [{ role: 'assistant', content: '' }];

    ih.ready = false;
    let j = JSON.parse(await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: { prompt: 'x' } } as any));
    expect(j.ok).toBe(false);
    expect(j.error).toContain('画图主机未配置或未启用');
    expect(ih.drawCalls.length).toBe(0);

    ih.ready = true;
    BiqiAgent._hostStatus = { at: 0, ok: false, model: '', hint: '' };
    ih.statusResult = { ok: false, error: '连不上画图主机' };
    j = JSON.parse(await BiqiAgent._executeTool({ id: 'c2', name: 'draw_image', arguments: { prompt: 'x' } } as any));
    expect(j.error).toContain('画图主机离线');
    expect(j.error).toContain('不要重试');

    ih.statusResult = { ok: true, model: 'm', hint: '' };
    j = JSON.parse(await BiqiAgent._executeTool({ id: 'c3', name: 'draw_image', arguments: {} } as any));
    expect(j.error).toMatch(/^工具调用参数无效/);
    expect(ih.drawCalls.length).toBe(0);

    ih.waitResult = { ok: false, error: '出图超时（180 秒）' };
    j = JSON.parse(await BiqiAgent._executeTool({ id: 'c4', name: 'draw_image', arguments: { prompt: 'x' } } as any));
    expect(j.ok).toBe(false);
    expect(j.error).toContain('出图超时');
    expect(BiqiAgent._genImages.size).toBe(0);
    expect((BiqiAgent.messages[0] as any).imageIds).toBeUndefined();
  });

  it('以图改图：作者指名图号（base_image="图1"）→ 带 initImage+denoise；步骤行写"改图"', async () => {
    BiqiAgent.messages = [{ role: 'assistant', content: '' }];
    BiqiAgent._genImages.set('img1', { full: 'data:image/png;base64,SRC', thumb: 'data:image/png;base64,T', seed: 1, size: '768x768', seconds: 9 });
    BiqiAgent._imgSeq = 1;   // 下一张是 img2
    const out = await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: { prompt: 'snow, winter', base_image: '图1', strength: 'strong' } } as any);
    const j = JSON.parse(out);
    expect(j.ok).toBe(true);
    expect(j.base).toBe('图1');
    expect(j.image_label).toBe('图2');
    expect(ih.drawCalls[0].initImage).toBe('data:image/png;base64,SRC');
    expect(ih.drawCalls[0].denoise).toBe(0.75);          // strong
    expect(BiqiAgent._stepLine({ id: 'c1', name: 'draw_image' } as any, out)).toContain('🎨 改图');
  });

  it('精细档：1024/36 单次直出（hires 不下发）；底图过期给出人话解释', async () => {
    BiqiAgent.messages = [{ role: 'assistant', content: '' }];
    ih.drawCalls = [];
    await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', quality: 'high' } } as any);
    expect(ih.drawCalls[0].width).toBe(1024);
    expect(ih.drawCalls[0].hires).toBeUndefined();
    ih.drawCalls = [];
    const bad = JSON.parse(await BiqiAgent._executeTool({ id: 'c2', name: 'draw_image', arguments: { prompt: 'x', base_image: '图9' } } as any));
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('本机存档');      // 新文案：本机存档里也没有才失败（重开 App 图还在）
    expect(bad.error).toContain('重新生成');
    expect(ih.drawCalls.length).toBe(0);
  });

  it('_stepLine：成功一行（尺寸/秒/图号）、失败一行（原因截断）', async () => {
    BiqiAgent.messages = [{ role: 'assistant', content: '' }];
    const out = await BiqiAgent._executeTool({ id: 'c1', name: 'draw_image', arguments: { prompt: 'x' } } as any);
    const line = BiqiAgent._stepLine({ id: 'c1', name: 'draw_image' } as any, out);
    expect(line).toContain('🎨 出图');
    expect(line).toContain('768x768');
    expect(line).toContain('图1');            // 步骤行用界面编号（与气泡上的「图1」一致）

    ih.waitResult = { ok: false, error: '出图失败' };
    const bad = await BiqiAgent._executeTool({ id: 'c2', name: 'draw_image', arguments: { prompt: 'x' } } as any);
    expect(BiqiAgent._stepLine({ id: 'c2', name: 'draw_image' } as any, bad)).toContain('⚠️ 出图失败');
  });
});

describe('比奇生图：气泡渲染', () => {
  it('缩略图 + 参数行进气泡；句柄没了先"读取存档"再"已过期"；空内容但有图不显示状态条', async () => {
    BiqiAgent._genImages.set('img1', { full: 'data:image/png;base64,AAA', thumb: 'data:image/png;base64,BBB', seed: 7, size: '768x768', seconds: 9.1, prompt: 'x' });
    BiqiAgent.messages = [{ role: 'assistant', content: '', imageIds: ['img1'], _steps: ['🎨 出图 → 768x768 · 9.1s · img1'] }];
    BiqiAgent._isSending = true;                       // 流式占位中：有图就不该再压状态条
    BiqiAgent.renderMessages();
    let html = els['biqiMessages'].innerHTML;
    expect(html).toContain('data:image/png;base64,BBB');
    expect(html).toContain('cw-img-meta');
    expect(html).toContain('768x768');
    expect(html).toContain('seed 7');
    expect(html).toContain("BiqiAgent.viewImage('img1')");  // 点开走 id（交给查看器的是原图，不是 420px 缩略图）
    expect(html).toContain('🎨 出图');
    expect(html).not.toContain('as-status');           // 有图 → 不再显示"正在出图…"

    BiqiAgent.viewImage('img1');
    expect(viewed).toEqual(['data:image/png;base64,AAA']); // full（原图），不是 thumb
    viewed.length = 0;
    BiqiAgent.viewImage('没有这个图');
    expect(viewed).toEqual([]);                        // 句柄没了不炸

    BiqiAgent._genImages.clear();                      // 重载后句柄失效
    BiqiAgent._imgGone.clear();
    BiqiAgent.renderMessages();
    html = els['biqiMessages'].innerHTML;
    // 两段式：句柄不在内存里时先显示"正在读取本地存档…"（异步水合），确认存档里也没有才变"已过期"
    expect(html).toContain('cw-img-loading');
    await new Promise((r) => setTimeout(r, 0));
    BiqiAgent.renderMessages();
    html = els['biqiMessages'].innerHTML;
    expect(html).toContain('cw-img-expired');
    expect(html).toContain('图片已过期');
    expect(BiqiAgent._imgGone.has('img1')).toBe(true);   // 确认没有 → 记下来，不再反复查
  });
});

describe('比奇生图：_runLoop 注入与全链路', () => {
  function stubApi(script: any[]) {
    const calls: any[] = [];
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _onData: any, onDone: any, onErr: any, opts: any) => {
        // 独立看图子调用（system 是看图助手）：2026-10-08 起出图后不再自动触发，只有模型自己调
        // look_at_image 才会走到这里；桩留着，不消耗脚本。
        const isVision = String(((msgs[0] || {}).content) || '').indexOf('图片核对助手') >= 0;
        calls.push({ msgs, tools: (opts && opts.tools) || [], vision: isVision });
        if (isVision) { onDone('（看图子调用的回答）画面正常，没有明显崩坏。'); return; }
        const step = script.shift() || { text: '（默认回答）' };
        if (step.err) { onErr(step.err); return; }
        if (step.tools) { opts.onTools(step.tools); return; }
        onDone(step.text);
      }
    };
    return calls;
  }

  it('在线：注入"直接画"规则 + 工具含 draw_image；一次调用后图片进气泡、结果回给模型', async () => {
    const calls = stubApi([
      { tools: [{ id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, rain' } }] },
      { text: '画好了，她在雨里。' }
    ]);
    BiqiAgent.messages = [{ role: 'user', content: '画一张她在雨里的图' }, { role: 'assistant', content: '', _steps: [] }];
    BiqiAgent._isSending = true;
    await BiqiAgent._runLoop('画一张她在雨里的图');

    // 调用分两类：主对话轮与独立看图子调用。2026-10-08 起出图**不再**自动看图 → 这里没有子调用
    const visionCalls = calls.filter((c: any) => c.vision);
    const mainCalls = calls.filter((c: any) => !c.vision);
    expect(mainCalls.length).toBe(2);                       // 出图轮 + 收尾轮
    expect(visionCalls.length).toBe(0);                     // 只是跑图：不看也不评价
    // 第一轮：系统消息 = 比奇人设 + 生图规则（正向），工具有 draw_image
    expect(mainCalls[0].msgs[0].role).toBe('system');
    expect(String(mainCalls[0].msgs[1].content)).toContain('不要再问');
    expect((mainCalls[0].tools as any[]).map((t: any) => t.function.name)).toContain('draw_image');
    expect((mainCalls[0].tools as any[]).map((t: any) => t.function.name)).toContain('look_at_image');
    // 工具结果回给模型：带 image_id
    const toolMsg = mainCalls[1].msgs.find((m: any) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(JSON.parse(toolMsg.content).image_id).toBe('img1');
    // 最终：图片挂在最后一条 assistant 消息上、文字是第二轮的回答、历史落盘
    const last: any = BiqiAgent.messages[BiqiAgent.messages.length - 1];
    expect(last.content).toContain('画好了');
    expect(last.imageIds).toEqual(['img1']);
    expect((last._steps || []).join(' ')).toContain('🎨 出图');
    expect(BiqiAgent._isSending).toBe(false);
    expect(SM().get('biqiHistory_' + BOOK_ID).slice(-1)[0].imageIds).toEqual(['img1']);
  });

  it('离线：反向规则 + 工具不含 draw_image（模型据此说明没配主机）', async () => {
    ih.statusResult = { ok: false, error: '连不上画图主机' };
    const calls = stubApi([{ text: '要画图的话，得先在设置里配好画图主机。' }]);
    BiqiAgent.messages = [{ role: 'user', content: '画一张' }, { role: 'assistant', content: '', _steps: [] }];
    BiqiAgent._isSending = true;
    await BiqiAgent._runLoop('画一张');

    expect(calls.length).toBe(1);
    expect(String(calls[0].msgs[1].content)).toContain('你没有画图工具');
    expect((calls[0].tools as any[]).map((t: any) => t.function.name)).not.toContain('draw_image');
    expect(BiqiAgent._isSending).toBe(false);
  });
});

describe('看图（视觉子调用）：工具门控 + 调用', () => {
  it('能给 look_at_image 时：调用走独立子调用（缩略图 + 问题），回答回给模型', async () => {
    BiqiAgent._drawToolsOn = true;
    expect(toolNames()).toContain('look_at_image');
    BiqiAgent._genImages.set('img1', { full: 'data:image/png;base64,F', thumb: 'data:image/jpeg;base64,THUMB', book: BOOK_ID });
    const calls: any[] = [];
    g.APIHandler = { fetchCompletions: (msgs: any[], _c: any, onDone: any) => { calls.push(msgs); onDone('画面里是一只黑猫趴在窗台上。'); } };
    try {
      const out = JSON.parse(await BiqiAgent._executeTool({ id: 'c1', name: 'look_at_image', arguments: { image_id: '图1', question: '画了什么' } } as any));
      expect(out.ok).toBe(true);
      expect(String(out.result)).toContain('黑猫');
      expect(String(calls[0][1].content[1].image_url.url)).toContain('data:image/jpeg;base64,THUMB');
    } finally { delete g.APIHandler; __resetVisionForTest(); }
  });

  it('看不了图的模型：不给工具；真调了也明确失败（不浪费请求）', async () => {
    BiqiAgent._drawToolsOn = true;
    BiqiAgent._genImages.set('img1', { full: 'F', thumb: 'data:image/jpeg;base64,T', book: BOOK_ID });
    markVision('no');
    const calls: any[] = [];
    g.APIHandler = { fetchCompletions: () => { calls.push(1); } };
    try {
      expect(toolNames()).not.toContain('look_at_image');
      const out = JSON.parse(await BiqiAgent._executeTool({ id: 'c1', name: 'look_at_image', arguments: { image_id: '图1', question: 'q' } } as any));
      expect(out.ok).toBe(false);
      expect(String(out.error)).toContain('看不了图片');
      expect(calls.length).toBe(0);
    } finally { delete g.APIHandler; __resetVisionForTest(); }
  });
});

describe('主对话看图（附图只由 look_at_image 触发 + 摘图重试）', () => {
  // 各轮**共用同一个 msgs 数组**（原地追加），所以必须在请求回调当场记录这一刻有几张图
  function snap(msgs: any[], o: any) {
    const imgs = (msgs || []).filter((m: any) => m && m.role === 'user' && Array.isArray(m.content));
    return {
      label: String((o && o.callLabel) || ''),
      imgs: imgs.map((m: any) => ({ text: String(m.content[0] && m.content[0].text || ''), url: String(m.content[1] && m.content[1].image_url && m.content[1].image_url.url || '') }))
    };
  }

  it("caps='yes'：出图后**不**自动附图（作者没要求就不看），也不发子调用", async () => {
    seedBook();
    BiqiAgent._genImages.clear(); BiqiAgent._imgSeq = 0;
    markVision('yes');
    const seen: any[] = [];
    let visionSubcalls = 0;
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _onData: any, onDone: any, onErr: any, opts: any) => {
        seen.push(snap(msgs, opts));
        if (opts && opts.callLabel === 'vision') { visionSubcalls++; onDone('不该被调用'); return; }
        if (seen.filter((x: any) => x.label !== 'vision').length === 1) { opts.onTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, rain' } }]); return; }
        onDone('画好了。');
      }
    };
    try {
      BiqiAgent.messages = [{ role: 'user', content: '画一张她在雨里的图' }, { role: 'assistant', content: '', _steps: [] }];
      BiqiAgent._isSending = true;
      await BiqiAgent._runLoop('画一张她在雨里的图');

      const mains = seen.filter((x: any) => x.label !== 'vision');
      expect(mains.length).toBe(2);                     // 出图轮 + 收尾轮
      expect(visionSubcalls).toBe(0);                   // 没有"没有预设"的子调用
      expect(mains[0].imgs.length).toBe(0);
      expect(mains[1].imgs.length).toBe(0);             // 出图后也不自动附图（用户只是跑图）
      expect(JSON.stringify(BiqiAgent.messages)).not.toContain('image_url');
      expect(BiqiAgent._attachQueue.length).toBe(0);
    } finally { delete g.APIHandler; __resetVisionForTest(); }
  });

  it("端点不接受图片（400 + image_url）→ 摘图同轮重试一次、记 no，对话不失败", async () => {
    seedBook();
    BiqiAgent._genImages.clear(); BiqiAgent._imgSeq = 0;
    BiqiAgent._genImages.set('img1', { full: 'data:image/png;base64,F', thumb: 'data:image/jpeg;base64,THUMB', book: BOOK_ID });
    markVision('yes');
    const seen: any[] = [];
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _onData: any, onDone: any, onErr: any, opts: any) => {
        seen.push(snap(msgs, opts));
        const n = seen.length;
        if (n === 1) { opts.onTools([{ id: 'c1', name: 'look_at_image', arguments: { image_id: '图1', question: '画了什么' } }]); return; }
        if (n === 2) { onErr('HTTP 400: image_url is not supported by this model'); return; }
        onDone('画好了。');
      }
    };
    try {
      BiqiAgent.messages = [{ role: 'user', content: '看看图1' }, { role: 'assistant', content: '', _steps: [] }];
      BiqiAgent._isSending = true;
      await BiqiAgent._runLoop('看看图1');

      expect(seen.length).toBe(3);                      // 看图轮 / 失败轮（带图）/ 重试轮（无图）
      expect(seen[1].imgs.length).toBe(1);
      expect(seen[2].imgs.length).toBe(0);
      expect(visionState()).toBe('no');
      expect(String(BiqiAgent.messages[BiqiAgent.messages.length - 1].content)).toContain('画好了');
    } finally { delete g.APIHandler; __resetVisionForTest(); }
  });

  it("caps='yes' + look_at_image：工具结果只说「已附」，模型不额外调用一次", async () => {
    seedBook();
    BiqiAgent._genImages.set('img1', { full: 'data:image/png;base64,F', thumb: 'data:image/jpeg;base64,THUMB', book: BOOK_ID });
    markVision('yes');
    const seen: any[] = [];
    let visionSubcalls = 0;
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _onData: any, onDone: any, _onErr: any, opts: any) => {
        seen.push(snap(msgs, opts));
        if (opts && opts.callLabel === 'vision') { visionSubcalls++; onDone('不该被调用'); return; }
        if (seen.filter((x: any) => x.label !== 'vision').length === 1) { opts.onTools([{ id: 'c1', name: 'look_at_image', arguments: { image_id: '图1', question: '画的是什么' } }]); return; }
        onDone('我看到是一只黑猫。');
      }
    };
    try {
      BiqiAgent.messages = [{ role: 'user', content: '看看图1' }, { role: 'assistant', content: '', _steps: [] }];
      BiqiAgent._isSending = true;
      await BiqiAgent._runLoop('看看图1');

      const mains = seen.filter((x: any) => x.label !== 'vision');
      expect(visionSubcalls).toBe(0);
      expect(mains[1].imgs.length).toBe(1);
      expect(mains[1].imgs[0].text).toContain('画的是什么');
      expect(mains[1].imgs[0].url).toContain('THUMB');
    } finally { delete g.APIHandler; __resetVisionForTest(); }
  });
});

describe('图片本地存档：重开后水合 + 清空对话删库', () => {
  it('_hydrateImages 取回原图并续排图号；clear() 只删这本书的存档与句柄', async () => {
    ImageCache.__resetForTest();
    BiqiAgent._imgGone.clear();
    await ImageCache.put({ book: BOOK_ID, id: 'img2', thumb: 'T2', full: 'F2', at: 1, seed: 5, size: '512x512', seconds: 3, prompt: 'p' });
    await ImageCache.put({ book: 'other_book', id: 'img2', thumb: 'T3', full: 'F3', at: 2 });
    BiqiAgent.messages = [{ role: 'assistant', content: '看图', imageIds: ['img2'] }];
    BiqiAgent._imgSeq = 0;
    await BiqiAgent._hydrateImages();
    expect(BiqiAgent._genImages.get('img2').full).toBe('F2');    // 取回的是原图（激活书那一份）
    expect(BiqiAgent._imgSeq).toBe(2);                           // 下一张是 img3

    BiqiAgent.clear();
    await new Promise((r) => setTimeout(r, 0));
    expect(await ImageCache.get(BOOK_ID, 'img2')).toBeNull();          // 这本书的存档删了
    expect(await ImageCache.get('other_book', 'img2')).toBeTruthy();   // 别的书不动
    expect(BiqiAgent._genImages.has('img2')).toBe(false);
  });
});
