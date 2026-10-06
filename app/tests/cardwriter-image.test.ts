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
  statusResult: { ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag', caps: ['img2img', 'hires'] } as any,
  drawCalls: [] as any[],
  drawResult: { ok: true, jobId: 'job1' } as any,
  waitResult: { ok: true, meta: { status: 'done', seed: 42, size: '768x768', elapsed: 9800 } } as any,
  image: 'data:image/png;base64,AAA',
  applies: [] as any[],
  applyResult: null as any,
  viewed: [] as string[]
}));

vi.mock('../src/domain/imagehost', () => ({
  IMAGE_HOST_KEY: 'imageHostConfig',
  AVATAR_SIZE: 768,
  DRAFT_SIZE: 512,
  DRAFT_STEPS: 20,
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
    save: (p: any) => p,
    status: async () => { ih.statusCalls++; return ih.statusResult; },
    draw: async (o: any) => { ih.drawCalls.push(o); return ih.drawResult; },
    waitJob: async (id: any, o: any) => { if (o && o.onTick) o.onTick({ elapsed: 3000 }); return ih.waitResult; },
    imageDataUrl: async () => ih.image,
    applyAvatarToCharacter: (name: string, url: string, bookId?: string) => {
      ih.applies.push({ name: name, url: url, bookId: bookId });
      if (ih.applyResult) return ih.applyResult;
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
anyG.UIManager = { renderWBEntries: () => undefined, renderWorldBooks: () => undefined, showConfirm: () => undefined, viewAvatar: (src: any) => { ih.viewed.push(String(src)); } };
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
  ih.statusResult = { ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag', caps: ['img2img', 'hires'] };
  ih.drawCalls = []; ih.drawResult = { ok: true, jobId: 'job1' };
  ih.waitResult = { ok: true, meta: { status: 'done', seed: 42, size: '768x768', elapsed: 9800 } };
  ih.image = 'data:image/png;base64,AAA'; ih.applies = []; ih.applyResult = null; ih.viewed = [];
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
    C._hostStatus = { at: Date.now(), ok: true, model: 'miaomiaoRealskin_anima13.safetensors', hint: 'tag 风格，用 danbooru tag', caps: ['img2img', 'hires'] };
    const tools = C._tools();
    names = tools.map((t: any) => t.function.name);
    expect(names).toContain('draw_image');
    expect(names).toContain('set_avatar');
    const draw = tools.find((t: any) => t.function.name === 'draw_image');
    expect(draw.function.description).toContain('miaomiaoRealskin_anima13');
    expect(draw.function.description).toContain('danbooru tag');
    expect(draw.function.description).toContain('先问用户要不要画');
    expect(draw.function.description).toContain('base_image');            // 主机支持改图 → 给底图参数
    expect(Object.keys(draw.function.parameters.properties)).toContain('base_image');
    expect(draw.function.parameters.properties.base_image.description).toContain('图3');
    expect(draw.function.parameters.properties.base_image.description).toContain('角色名');
    const av = tools.find((t: any) => t.function.name === 'set_avatar');
    expect(av.function.description).toContain('只在用户看到图之后明确同意时调用');
  });

  it('老主机（无 caps）：不给 base_image/strength 参数，规则里也不提改图', () => {
    C._drawToolsOn = true;
    C._hostStatus = { at: Date.now(), ok: true, model: 'm', hint: '', caps: [] };
    const props = Object.keys((C._tools().find((t: any) => t.function.name === 'draw_image') as any).function.parameters.properties);
    expect(props).not.toContain('base_image');
    expect(props).not.toContain('strength');
    expect(C._imageRuleMessage()).not.toContain('base_image');
  });

  it('改图时机规则（用户 2026-10-06 校准）：默认画新图；只有"改现有画面/保留现有形象做局部调整"才改图；改角色主体也要新图', () => {
    C._drawToolsOn = true;
    C._hostStatus = { at: Date.now(), ok: true, model: 'm', hint: '', caps: ['img2img'] };
    const rule = C._imageRuleMessage();
    expect(rule).toContain('**默认画新图**');
    expect(rule).toContain('给她带上围巾');       // 局部增减 → 改图
    expect(rule).toContain('这张有点糊了');       // 修瑕疵 → 改图
    expect(rule).toContain('这个角色不够成熟');   // 改角色主体 → 新图（不许带底图）
    expect(rule).toContain('**要改角色主体 → 仍然画新图**');
    const draw = C._tools().find((t: any) => t.function.name === 'draw_image');
    expect(draw.function.description).toContain('**默认画新图**');
    expect(draw.function.parameters.properties.base_image.description).toContain('默认不填');
    expect(draw.function.parameters.properties.base_image.description).toContain('不够成熟');
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

  it('档位映射：fast=512/12、draft=512/20、high=1024/36、默认=768 且步数交给工作流', async () => {
    const cases: any[] = [
      [{ prompt: 'x', quality: 'fast' }, 512, 12],
      [{ prompt: 'x', quality: 'draft' }, 512, 20],
      [{ prompt: 'x', draft: true }, 512, 20],        // 旧参数 draft:true 仍然兼容
      [{ prompt: 'x', quality: 'high' }, 1024, 36]
    ];
    for (const c of cases) {
      ih.drawCalls = [];
      await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: c[0] }], '');
      expect(ih.drawCalls[0].width).toBe(c[1]);
      expect(ih.drawCalls[0].height).toBe(c[1]);
      expect(ih.drawCalls[0].steps).toBe(c[2]);
    }
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c2', name: 'draw_image', arguments: { prompt: 'x' } }], '');
    expect(ih.drawCalls[0].width).toBe(768);
    expect(ih.drawCalls[0].steps).toBeUndefined();     // 标准档交回工作流自己的步数
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c3', name: 'draw_image', arguments: { prompt: 'x', quality: '不存在的档' } }], '');
    expect(ih.drawCalls[0].width).toBe(768);           // 认不出的档位回落到标准
  });

  it('主机声明档位（workflow.tiers）优先：按声明发尺寸/步数；没声明的档仍走内置兜底', async () => {
    // 2026-10-06：turbo LoRA 让 8 步就够——步数不该写死在 App 里，工作流声明优先（谁配模型谁定步数）
    ih.statusResult = {
      ok: true, model: 'm', hint: '', caps: ['img2img'],
      tiers: { normal: { size: 768, steps: 8 }, high: { size: 1024, steps: 10 }, fast: { size: 512, steps: null } }
    };
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x' } }], '');
    expect(ih.drawCalls[0].width).toBe(768);
    expect(ih.drawCalls[0].steps).toBe(8);             // 标准档：工作流声明 8 步
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c2', name: 'draw_image', arguments: { prompt: 'x', quality: 'high' } }], '');
    expect(ih.drawCalls[0].width).toBe(1024);
    expect(ih.drawCalls[0].steps).toBe(10);
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c3', name: 'draw_image', arguments: { prompt: 'x', quality: 'fast' } }], '');
    expect(ih.drawCalls[0].steps).toBeUndefined();     // steps:null = 用工作流自己的步数
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c4', name: 'draw_image', arguments: { prompt: 'x', quality: 'draft' } }], '');
    expect(ih.drawCalls[0].steps).toBe(20);            // draft 没被声明 → 内置兜底
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

  // 用户 2026-10-06：不一定是"上一张"，要能指名第几张 → base_image 传图号（界面上那个「图3」）
  it('以图改图：base_image 传图号 → 带 initImage+denoise 提交；回执标"基于图1改的"，新图标"改自图1"', async () => {
    C._genImages.set('img1', { full: 'data:image/png;base64,SRC', thumb: 'data:image/png;base64,T', seed: 1, size: '768x768', seconds: 9 });
    C._imgSeq = 1;   // 已有 img1，下一张是 img2
    C.messages = [{ role: 'assistant', content: '' }];
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'snow, winter', base_image: '图1', strength: 'slight' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(true);
    expect(ih.drawCalls[0].initImage).toBe('data:image/png;base64,SRC');
    expect(ih.drawCalls[0].denoise).toBe(0.35);          // slight
    expect(ih.drawCalls[0].hires).toBeUndefined();       // 标准档不重修
    expect(r.message).toContain('基于图1改的');
    expect(r.message).toContain('界面编号：图2');
    expect(C._genImages.get('img2').base).toBe('图1');
    expect(C.messages[0].imageIds).toEqual(['img2']);
  });

  it('精细档：1024/36 单次直出（hires 两步重修实测 3 倍耗时且没更好，档位不带它）', async () => {
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', quality: 'high' } }], '');
    expect(ih.drawCalls[0].width).toBe(1024);
    expect(ih.drawCalls[0].steps).toBe(36);
    expect(ih.drawCalls[0].hires).toBeUndefined();
    expect(C._genImages.get('img1').hires).toBe(false);
  });

  it('底图引用过期 → 如实失败、不提交（不再静默画成全新一张）', async () => {
    ih.drawCalls = [];
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', base_image: '图9' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('图9');
    expect(r.message).toContain('只在本会话内存');
    expect(ih.drawCalls.length).toBe(0);
  });

  it('老主机不支持改图 → 明确失败（不会悄悄变成全新出图）', async () => {
    ih.statusResult = { ok: true, model: 'm', hint: '', caps: [] };
    C._genImages.set('img1', { full: 'data:image/png;base64,SRC' });
    ih.drawCalls = [];
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', base_image: '图1' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('不支持以图改图');
    expect(ih.drawCalls.length).toBe(0);
  });

  it('角色还没有头像：不报错、照常按描述画，并在回执里说明（"默认用角色头像当底图"的前提）', async () => {
    WB_BOOKS = [{ id: 'wb1', entries: [{ id: 'e1', type: '角色', name: '林晚', content: '…' }] }];   // 没有 avatar
    ih.drawCalls = [];
    const out = await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', base_image: '林晚', strength: 'strong' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(true);
    expect(ih.drawCalls[0].initImage).toBeUndefined();   // 不带头像照常画
    expect(r.message).toContain('还没有头像');
    expect(r.message).toContain('如实告诉用户');
  });

  // 用户 2026-10-06 报的串台：写卡能换"讨论目标书"，而图片/头像那条链路以前只认"当前激活书"
  it('跨书隔离：目标是乙书时，底图用乙书的头像、设头像也写进乙书', async () => {
    WB_BOOKS = [
      { id: 'wb1', name: '甲书', entries: [{ id: 'e1', type: '角色', name: '林晚', content: '…', avatar: 'data:image/jpeg;base64,A' }] },
      { id: 'wb2', name: '乙书', entries: [{ id: 'e2', type: '角色', name: '林晚', content: '…', avatar: 'data:image/jpeg;base64,B' }] }
    ];
    C._getTargetId = () => 'wb2';
    ih.drawCalls = [];
    await C._handleTools([{ id: 'c1', name: 'draw_image', arguments: { prompt: 'x', base_image: '林晚' } }], '');
    expect(ih.drawCalls[0].initImage).toBe('data:image/jpeg;base64,B');   // 不是甲书那张 A
    ih.applies = [];
    C._genImages.set('img1', { full: 'data:image/png;base64,AAA' });
    await C._handleTools([{ id: 'c2', name: 'set_avatar', arguments: { character: '林晚', image_id: 'img1' } }], '');
    expect(ih.applies[0].bookId).toBe('wb2');                              // 写进乙书
    C._getTargetId = () => 'wb1';
  });

  it('三档强度的场景说明写进工具描述（小改只修细节；换姿势/衣服/背景用 strong）', () => {
    C._drawToolsOn = true;
    C._hostStatus = { at: Date.now(), ok: true, model: 'm', hint: '', caps: ['img2img', 'hires'] };
    const props = (C._tools().find((t: any) => t.function.name === 'draw_image') as any).function.parameters.properties;
    expect(props.strength.description).toContain('只修小毛病');
    expect(props.strength.description).toContain('换姿势');
    expect(props.strength.description).toContain('一律用 strong');
    expect(props.base_image.description).toContain('头像');
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
    expect(ih.applies[0].name).toBe('林晚');
    expect(ih.applies[0].url).toBe('data:image/png;base64,AAA');
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

  // 用户 2026-10-06 反馈："工具调用了，但世界书里没有头像"——根因是没找到角色时以前会现造临时角色、
  // 还写进对话模式那一层，却回报成功。现在：失败要如实报，并把"下一步该干什么"写进文案里。
  it('角色还没进世界书（只在草稿里）：如实失败，并点明「还在草稿里」', async () => {
    C._genImages.set('img1', { full: 'data:image/png;base64,AAA' });
    C._draft = { characters: [{ name: '新角色', content: 'x' }], entries: [], deleted: [] };
    ih.applyResult = { ok: false, message: '未找到角色条目：新角色（只能给世界书里已有的角色设头像：…）' };
    const out = await C._handleTools([{ id: 'c1', name: 'set_avatar', arguments: { character: '新角色', image_id: 'img1' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^未找到角色条目/);      // 命中写卡失败判据
    expect(r.message).toContain('只在草稿里');
    expect(r.message).toContain('写进世界书');
  });

  it('名字对不上世界书条目：失败文案要求「完全一致」', async () => {
    C._genImages.set('img1', { full: 'data:image/png;base64,AAA' });
    C._draft = { characters: [], entries: [], deleted: [] };
    ih.applyResult = { ok: false, message: '未找到角色条目：小林（…）' };
    const out = await C._handleTools([{ id: 'c1', name: 'set_avatar', arguments: { character: '小林', image_id: 'img1' } }], '');
    const r = JSON.parse(out[0]);
    expect(r.ok).toBe(false);
    expect(r.message).toContain('完全一致');
  });
});

describe('看图：点缩略图给的是原图（1024 档不该看起来和 512 一样）', () => {
  it('气泡里显示 420px 缩略图，onclick 走 viewImage(id)；viewImage 交给查看器的是 full', () => {
    C._genImages.set('img1', { full: 'data:image/png;base64,FULL', thumb: 'data:image/png;base64,THUMB', seed: 1, size: '1024x1024', seconds: 30, prompt: 'x' });
    const html = C._imagesHtml({ imageIds: ['img1'] });
    expect(html).toContain('data:image/png;base64,THUMB');            // 气泡里是缩略图
    expect(html).toContain("CardWriterChat.viewImage('img1')");       // 点开走 id（不再把缩略图当大图）
    C.viewImage('img1');
    expect(ih.viewed).toEqual(['data:image/png;base64,FULL']);        // 全屏看到的是原图
    ih.viewed = [];
    C.viewImage('不存在的id');
    expect(ih.viewed).toEqual([]);                                    // 句柄没了不炸也不白屏
  });
});
