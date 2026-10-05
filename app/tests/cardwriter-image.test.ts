// 写卡 Agent 的生图工具：draw_image / set_avatar
// 覆盖：门控（_drawToolsOn）、主机状态探测与 60s 缓存、异步工具执行、图片句柄、
//      两段确认的数据流（draw 出的 id 只有被 set_avatar 引用才写进世界书）。
// 注：cardwriter.ts 模块顶层即 init()（读全局桩），所以必须先建桩再动态 import。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;

const ih = vi.hoisted(() => ({
  ready: true,
  statusCalls: 0,
  statusResult: { ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag' } as any,
  drawCalls: [] as any[],
  drawResult: { ok: true, jobId: 'job1' } as any,
  waitResult: { ok: true, meta: { status: 'done', seed: 42, size: '768x768', elapsed: 9800 } } as any,
  image: 'data:image/png;base64,AAA',
  applies: [] as any[]
}));

vi.mock('../src/domain/imagehost', () => ({
  IMAGE_HOST_KEY: 'imageHostConfig',
  AVATAR_SIZE: 768,
  DRAFT_SIZE: 512,
  AVATAR_STORE_SIZE: 512,
  ImageHost: {
    ready: () => ih.ready,
    config: () => ({ enabled: ih.ready, base: 'http://h:1', token: 't' }),
    save: (p: any) => p,
    status: async () => { ih.statusCalls++; return ih.statusResult; },
    draw: async (o: any) => { ih.drawCalls.push(o); return ih.drawResult; },
    waitJob: async (id: any, o: any) => { if (o && o.onTick) o.onTick({ elapsed: 3000 }); return ih.waitResult; },
    imageDataUrl: async () => ih.image,
    applyAvatarToCharacter: (name: string, url: string) => {
      ih.applies.push({ name: name, url: url });
      return { ok: true, message: '已把「' + name + '」的头像设为这张图（已写入世界书）' };
    }
  },
  default: {}
}));

let WB_BOOKS: any[] = [];
const wbm = WBM as unknown as Record<string, any>;
wbm.getActiveId = () => 'wb1';
wbm.getAll = () => WB_BOOKS;
wbm.getActive = () => WB_BOOKS[0] || null;
wbm.saveAll = (arr: any[]) => { WB_BOOKS = arr; };
anyG.UIManager = { renderWBEntries: () => undefined, renderWorldBooks: () => undefined, showConfirm: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.CharacterManager = { getByWorldBook: () => [] };
anyG.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' }) };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
anyG.escapeHTML = (x: unknown) => String(x == null ? '' : x);
anyG.ChatMode = { ensureTempCharacter: () => '' };

let C: any;
beforeAll(async () => {
  await import('../src/domain/cardwriter');
  C = anyG.CardWriterChat;
});

beforeEach(() => {
  ih.ready = true; ih.statusCalls = 0;
  ih.statusResult = { ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag' };
  ih.drawCalls = []; ih.drawResult = { ok: true, jobId: 'job1' };
  ih.waitResult = { ok: true, meta: { status: 'done', seed: 42, size: '768x768', elapsed: 9800 } };
  ih.image = 'data:image/png;base64,AAA'; ih.applies = [];
  WB_BOOKS = [{ id: 'wb1', entries: [{ id: 'e1', type: '角色', name: '林晚', content: '…' }] }];
  C.messages = [];
  C._draft = { characters: [], entries: [], deleted: [] };
  C._genImages.clear(); C._imgSeq = 0;
  C._drawToolsOn = false; C._drawCancelled = false; C._drawAbort = null;
  C._hostStatus = { at: 0, ok: false, model: '', hint: '' };
  C._writeOk = false; C._toolsOk = false;
});

describe('生图规则注入（_imageRuleMessage）', () => {
  it('主机在线 → 正向规则（先问再画 / 设头像要再确认）', () => {
    C._drawToolsOn = true;
    const t = C._imageRuleMessage();
    expect(t).toContain('你可以用 draw_image');
    expect(t).toContain('先问用户要不要画');
    expect(t).toContain('必须等用户明确同意');
    expect(t).not.toContain('你没有画图工具');
  });

  it('主机没配/没开 → 反向规则：明确"没有画图能力"、不许提议生图', () => {
    C._drawToolsOn = false;
    const t = C._imageRuleMessage();
    expect(t).toContain('你没有画图工具');
    expect(t).toContain('不要提议"要不要我画一张"');
    expect(t).toContain('不要输出生图提示词');
    expect(t).toContain('设置 → AI 与生成 → 画图主机');
    expect(t).not.toContain('你可以用 draw_image');
  });
});

describe('门控与主机状态', () => {
  it('_drawToolsOn=false 不给画图工具；=true 时两个工具都在，且描述带模型与画风说明', () => {
    C._drawToolsOn = false;
    let names = C._tools().map((t: any) => t.function.name);
    expect(names).not.toContain('draw_image');
    expect(names).not.toContain('set_avatar');
    expect(names).toContain('apply_character'); // 原有工具不受影响

    C._drawToolsOn = true;
    // 生产路径里 _drawToolsOn=true 总是伴随探测结果（_refreshHostStatus 写入），这里照做
    C._hostStatus = { at: Date.now(), ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag' };
    const tools = C._tools();
    names = tools.map((t: any) => t.function.name);
    expect(names).toContain('draw_image');
    expect(names).toContain('set_avatar');
    const draw = tools.find((t: any) => t.function.name === 'draw_image');
    expect(draw.function.description).toContain('miaomiaoRealskin_anima13');
    expect(draw.function.description).toContain('danbooru tag');
    expect(draw.function.description).toContain('先问用户要不要画');
    const av = tools.find((t: any) => t.function.name === 'set_avatar');
    expect(av.function.description).toContain('只在用户看到图之后明确同意时调用');
  });

  it('_refreshHostStatus：未启用不发请求；在线置 true；60 秒内复用缓存；失败置 false', async () => {
    ih.ready = false;
    await C._refreshHostStatus();
    expect(C._drawToolsOn).toBe(false);
    expect(ih.statusCalls).toBe(0);

    ih.ready = true;
    await C._refreshHostStatus();
    expect(C._drawToolsOn).toBe(true);
    expect(ih.statusCalls).toBe(1);
    await C._refreshHostStatus();               // 缓存命中
    expect(ih.statusCalls).toBe(1);

    C._hostStatus = { at: 0, ok: false, model: '', hint: '' };
    ih.statusResult = { ok: false, error: '超时' };
    await C._refreshHostStatus();
    expect(C._drawToolsOn).toBe(false);
    expect(ih.statusCalls).toBe(2);
  });
});

describe('draw_image', () => {
  it('按 768×768 出图、存句柄、把 imageIds 挂到最后一条 assistant 消息上', async () => {
    C.messages = [{ role: 'user', content: '画一个头像' }, { role: 'assistant', content: '' }];
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'boy, solo' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('图片 id：img1');
    expect(ih.drawCalls[0].width).toBe(768);
    expect(ih.drawCalls[0].height).toBe(768);
    expect(ih.drawCalls[0].steps).toBeUndefined();
    expect(C._genImages.size).toBe(1);
    expect(C.messages[1].imageIds).toEqual(['img1']);
    expect(C._genImages.get('img1').seed).toBe(42);
  });

  it('draft:true 走 512×512 / 8 步', async () => {
    await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', draft: true } }], '');
    expect(ih.drawCalls[0].width).toBe(512);
    expect(ih.drawCalls[0].steps).toBe(8);
  });

  it('未配置 → 失败文案引导去设置；离线 → 提示不要重试', async () => {
    ih.ready = false;
    let out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x' } }], '');
    expect(JSON.parse(out[0]).ok).toBe(false);
    expect(JSON.parse(out[0]).message).toContain('画图主机未配置或未启用');
    expect(ih.drawCalls.length).toBe(0);

    ih.ready = true;
    C._hostStatus = { at: 0, ok: false, model: '', hint: '' };
    ih.statusResult = { ok: false, error: '连不上画图主机' };
    out = await C._handleTools([{ id: 'c2', name: 'draw_image', arguments: { prompt: 'x' } }], '');
    expect(JSON.parse(out[0]).message).toContain('画图主机离线');
    expect(JSON.parse(out[0]).message).toContain('不要重试');
  });

  it('prompt 为空以「工具调用参数无效」开头（命中写卡失败判据）', async () => {
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: {} }], '');
    expect(JSON.parse(out[0]).message).toMatch(/^工具调用参数无效/);
    expect(ih.drawCalls.length).toBe(0);
  });

  it('出图失败/超时透传为 ok=false', async () => {
    ih.waitResult = { ok: false, error: '出图超时（180 秒）' };
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('出图超时');
    expect(C._genImages.size).toBe(0);
  });
});

describe('set_avatar（第二段确认）', () => {
  async function drawOne() {
    C.messages = [{ role: 'assistant', content: '' }];
    await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'girl, solo' } }], '');
    return C.messages[C.messages.length - 1].imageIds[0];
  }

  it('用 draw 返回的 id 写头像：把（名字，图片数据）交给 ImageHost，回执带用户原话', async () => {
    const id = await drawOne();
    const out = await C._handleTools([{ id: 'c2', name: 'set_avatar', arguments: { character: '林晚', image_id: id, user_said: '用这张' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(true);
    expect(ih.applies).toEqual([{ name: '林晚', url: 'data:image/png;base64,AAA' }]);
    expect(r.message).toContain('用户原话');
  });

  it('未知 id / 缺参数都被拦下，且不写世界书', async () => {
    let out = await C._handleTools([{ id: 'c2', name: 'set_avatar', arguments: { character: '林晚', image_id: 'img999' } }], '');
    expect(JSON.parse(out[0]).message).toMatch(/^未找到图片：img999/);
    out = await C._handleTools([{ id: 'c3', name: 'set_avatar', arguments: { image_id: 'img1' } }], '');
    expect(JSON.parse(out[0]).message).toMatch(/^工具调用参数无效：缺少角色名/);
    out = await C._handleTools([{ id: 'c4', name: 'set_avatar', arguments: { character: '林晚' } }], '');
    expect(JSON.parse(out[0]).message).toMatch(/^工具调用参数无效：缺少 image_id/);
    expect(ih.applies.length).toBe(0);
  });

  it('同一批里先 apply_character 再 set_avatar：头像写入照常（角色名由模型提供）', async () => {
    const id = await drawOne();
    const out = await C._handleTools([
      { id: 'c2', name: 'apply_character', arguments: { name: '新角色', content: '姓名：新角色' } },
      { id: 'c3', name: 'set_avatar', arguments: { character: '新角色', image_id: id } }
    ], '');
    expect(JSON.parse(out[0]).ok).toBe(true);
    expect(ih.applies[0].name).toBe('新角色');
  });
});
