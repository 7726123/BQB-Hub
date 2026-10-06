// 「画图主机配置技能」：助手把一份自包含的 .md 发给用户，用户交给电脑上的 AI 编程助手照着配。
// 覆盖：工具挂牌与执行、拼装（读真实素材文件，占位符必须全部替换）、内容要点（SFW 链接/改名表/字节校验/
//      主机源码）、失败兜底、最终气泡挂卡片、保存走原生桥（text/markdown + UTF-8 base64 可解回）、复制。
// 注：素材就在仓库里（web/skill/**），这里**读真文件**——这样素材缺文件/占位符写错会直接测试失败。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import '../src/infra/storage';
import { UsageAssistant } from '../src/domain/assistant';
import { buildSetupSkillMd, SETUP_SKILL_FILE_NAME, utf8Bytes } from '../src/domain/setup-skill';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const ROOT = path.resolve(__dirname, '..', '..');

/** 用真素材当"服务器"：把 web/skill/<rel> 读出来按 URL 尾段派发。 */
function stubAssetFetch(): void {
  g.fetch = (url: string) => {
    const rel = String(url).split('?')[0];
    const idx = rel.indexOf('skill/');
    if (idx < 0) return Promise.reject(new Error('unexpected url: ' + rel));
    const file = path.join(ROOT, 'web', rel.slice(idx));
    if (!fs.existsSync(file)) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(fs.readFileSync(file, 'utf8')) });
  };
}

function el(): Any {
  return { innerHTML: '', textContent: '', value: '', style: { setProperty() {}, display: '' }, scrollTop: 0, scrollHeight: 0, classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {}, select() {}, children: [], querySelector: () => null, getContext: () => null, toDataURL: () => '' };
}

beforeEach(() => {
  const els = new Map<string, Any>();
  g.document = Object.assign({}, g.document, {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    body: el(),
  });
  g.App = { toast: vi.fn(), resetChatInput: vi.fn() };
  g.htmlEscape = (x: unknown) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
  g.renderMdStrong = undefined;   // 用真实现（import 进来的那个）
  UsageAssistant.messages = [];
  UsageAssistant._pendingSkill = null;
  UsageAssistant._needLogin = false;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete g.App;
  delete g.HttpBridge;
});

describe('工具挂牌与执行', () => {
  it('完整版挂牌 send_setup_skill，描述里点明"交给电脑上的 AI 编程助手"', () => {
    const tools = UsageAssistant._tools() as Any[];
    const t = tools.find((x) => x.function && x.function.name === 'send_setup_skill') as Any;
    expect(t).toBeTruthy();
    expect(t.function.description).toContain('AI 编程助手');
    expect(t.function.description).toContain('Claude Code');
    expect(t.function.description).toContain('画图主机');
  });

  it('执行：读真素材拼出完整 .md（占位符全部替换、含主机源码与工作流），并挂到 _pendingSkill', async () => {
    stubAssetFetch();
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} }));
    expect(out.ok).toBe(true);
    expect(String(out.result)).toContain(SETUP_SKILL_FILE_NAME);
    const s = UsageAssistant._pendingSkill;
    expect(s).toBeTruthy();
    const md = String(s!.markdown);
    // ① 给 AI 助手看的前言与完成标准
    expect(md).toContain('name: bqb-image-host-setup');
    expect(md).toContain('完成标准');
    // ② 模型页必须是 SFW 主站，且不许出现成人入口域名
    expect(md).toContain('https://civitai.com/models/2026594/miaoliao-realskin'.replace('miaoliao', 'miaomiao'));
    expect(md).toContain('https://civitai.com/models/2619830/turbo-for-anima-less-steps');
    expect(md).not.toContain('civitai.red');
    // ③ 登录要求 + 自己下载 + 精确字节校验
    expect(md).toContain('requires you to be logged in');
    expect(md).toContain('请用户自己下载');
    expect(md).toContain('4182218328');
    expect(md).toContain('1192135096');
    expect(md).toContain('253806246');
    // ④ 改名对照（工作流按这些名字找文件）
    expect(md).toContain('qwen_3_06b_base.safetensors');
    expect(md).toContain('anima-turbo-lora');
    // ⑤ 自包含：主机程序与工作流内嵌在附录里，且没有任何未替换的占位符
    expect(md).toContain('node serve.mjs --lan');
    expect(md).toContain('--lan');
    expect(md).toContain('comfy-workflow.mjs');
    expect(md).toContain('KSampler');
    expect(md).toContain('"class_type"');
    expect(md).toContain('UNETLoader');
    expect(md).not.toMatch(/\{\{[A-Z_]+\}\}/);
    // ⑥ 许可/署名与非商用提醒
    expect(md).toContain('非商用');
    expect(md).toContain('署名');
    // 大小写进卡片
    expect(s!.bytes).toBe(utf8Bytes(md));
    expect(s!.bytes).toBeGreaterThan(20000);
  });

  it('素材取不到（网络/缺文件）→ 如实失败，不发残包', async () => {
    g.fetch = () => Promise.reject(new Error('boom'));
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} }));
    expect(out.ok).toBe(false);
    expect(String(out.error)).toContain('技能包没取到');
    expect(UsageAssistant._pendingSkill).toBe(null);
  });

  it('缺一块素材（工作流 JSON 404）→ 也当失败处理', async () => {
    g.fetch = (url: string) => {
      const rel = String(url).split('?')[0];
      if (rel.indexOf('workflow.json') >= 0) return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') });
      const idx = rel.indexOf('skill/');
      const file = path.join(ROOT, 'web', rel.slice(idx));
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(fs.readFileSync(file, 'utf8')) });
    };
    const out = JSON.parse(await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} }));
    expect(out.ok).toBe(false);
  });
});

describe('文件条与两个图标按钮', () => {
  it('渲染成一行文件条：文件名 + 下载/转发两个图标（没有标题图标、没有说明文字、没有复制/预览）', async () => {
    stubAssetFetch();
    await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} });
    UsageAssistant.messages = [{ role: 'assistant', content: '这份文件交给电脑上的 AI 助手用 👇', skill: UsageAssistant._pendingSkill! } as unknown as any];
    UsageAssistant._pendingSkill = null;

    const box = g.document.getElementById('assistantMessages');
    UsageAssistant.renderMessages();
    const h = box.innerHTML;
    expect(h).toContain(SETUP_SKILL_FILE_NAME);          // 文件名 + 大小
    expect(h).toContain('KB');
    expect(h).toContain('UsageAssistant.saveSkill()');   // ⬇ 下载
    expect(h).toContain('UsageAssistant.shareSkill()');  // ↪ 转发
    expect(h).toContain('aria-label="下载"');
    expect(h).toContain('aria-label="转发"');
    expect(h).toContain('<svg');                          // 图标是内联 SVG
    // 用户明确不要的东西：标题小图标、说明文字、复制/预览
    expect(h).not.toContain('🧩');
    expect(h).not.toContain('复制');
    expect(h).not.toContain('预览');
    expect(h).not.toContain('模型要你自己先登录 Civitai 下载');
    expect(h).not.toContain('<pre');
    expect(typeof UsageAssistant.copySkill).not.toBe('function');
    expect(typeof UsageAssistant.toggleSkillPreview).not.toBe('function');
  });

  it('保存：走原生桥 saveFileBase64，文件名/mime 正确，base64 能解回同一份 UTF-8 文本', async () => {
    stubAssetFetch();
    await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} });
    UsageAssistant.messages = [{ role: 'assistant', content: 'x', skill: UsageAssistant._pendingSkill! } as unknown as any];
    const md = UsageAssistant._pendingSkill!.markdown;
    UsageAssistant._pendingSkill = null;

    const calls: Any[] = [];
    g.HttpBridge = {
      saveFileBase64: (name: string, b64: string, mime: string) => {
        calls.push({ name, b64, mime });
        return JSON.stringify({ ok: true, path: '下载/' + name });
      },
    };
    UsageAssistant.saveSkill();
    expect(calls.length).toBe(1);
    expect(calls[0].name).toBe(SETUP_SKILL_FILE_NAME);
    expect(calls[0].name.endsWith('.md')).toBe(true);
    expect(calls[0].mime).toBe('text/markdown');
    // base64 → 原文本（中文逐字一致）
    const bin = Buffer.from(calls[0].b64, 'base64');
    expect(bin.toString('utf8')).toBe(md);
    expect(g.App.toast).toHaveBeenCalled();
    expect(String((g.App.toast as Any).mock.calls[0][0])).toContain('已下载到');
  });

  it('下载：老 APK 没有原生方法 → 明确提示更新 App', async () => {
    stubAssetFetch();
    await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} });
    UsageAssistant.messages = [{ role: 'assistant', content: 'x', skill: UsageAssistant._pendingSkill! } as unknown as any];
    UsageAssistant._pendingSkill = null;
    g.HttpBridge = {};
    UsageAssistant.saveSkill();
    expect(String((g.App.toast as Any).mock.calls[0][0])).toContain('更新 App');
  });

  it('转发：走原生桥 shareFileBase64（弹分享面板），文件名/字节与下载完全一致', async () => {
    stubAssetFetch();
    await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} });
    UsageAssistant.messages = [{ role: 'assistant', content: 'x', skill: UsageAssistant._pendingSkill! } as unknown as any];
    const md = UsageAssistant._pendingSkill!.markdown;
    UsageAssistant._pendingSkill = null;
    const shares: Any[] = [];
    g.HttpBridge = {
      shareFileBase64: (name: string, b64: string, mime: string) => {
        shares.push({ name, b64, mime });
        return JSON.stringify({ ok: true });
      },
    };
    UsageAssistant.shareSkill();
    expect(shares.length).toBe(1);
    expect(shares[0].name).toBe(SETUP_SKILL_FILE_NAME);
    // 分享用 text/plain（所有 Android 版本都能列全分享目标；文件名仍带 .md）
    expect(shares[0].mime).toBe('text/plain');
    expect(Buffer.from(shares[0].b64, 'base64').toString('utf8')).toBe(md);
    expect((g.App.toast as Any).mock.calls.length).toBe(0);   // 成功不打扰
  });

  it('转发失败（老 APK / 无分享目标）→ 提示可以改用「⬇ 下载」', async () => {
    stubAssetFetch();
    await UsageAssistant._executeTool({ name: 'send_setup_skill', arguments: {} });
    UsageAssistant.messages = [{ role: 'assistant', content: 'x', skill: UsageAssistant._pendingSkill! } as unknown as any];
    UsageAssistant._pendingSkill = null;
    g.HttpBridge = { shareFileBase64: () => JSON.stringify({ ok: false, error: 'no target' }) };
    UsageAssistant.shareSkill();
    expect(String((g.App.toast as Any).mock.calls[0][0])).toContain('下载');
  });
});

describe('一轮对话：卡片挂在最终气泡上', () => {
  it('模型调用 send_setup_skill 后收尾 → 最后一条 assistant 带 skill，_pendingSkill 清空', async () => {
    stubAssetFetch();
    UsageAssistant.messages = [{ role: 'user', content: '怎么配画图主机？' }, { role: 'assistant', content: '' }];
    let round = 0;
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, _onErr: any, o: any) => {
        round++;
        if (round === 1) { o.onTools([{ id: 'c1', name: 'send_setup_skill', arguments: {} }]); return Promise.resolve(); }
        onDone('这份文件交给电脑上的 AI 助手用 👇', false, '');
        return Promise.resolve();
      },
    };
    UsageAssistant._isSending = true;
    await UsageAssistant._runLoop('怎么配画图主机？');

    const last = UsageAssistant.messages[UsageAssistant.messages.length - 1] as unknown as Any;
    expect(last.skill).toBeTruthy();
    expect(String(last.skill.name)).toBe(SETUP_SKILL_FILE_NAME);
    expect(String(last.content)).toContain('AI 助手');
    expect(UsageAssistant._pendingSkill).toBe(null);
    // 步骤留痕提醒用户"我做了什么"
    await new Promise((r) => setTimeout(r, 0));
  });

  it('模型什么都没说（只调了工具）→ 兜底给一句引导，不留空气泡', async () => {
    stubAssetFetch();
    UsageAssistant.messages = [{ role: 'user', content: '给我配置技能' }, { role: 'assistant', content: '' }];
    let round = 0;
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _onChunk: any, onDone: any, _onErr: any, o: any) => {
        round++;
        if (round === 1) { o.onTools([{ id: 'c1', name: 'send_setup_skill', arguments: {} }]); return Promise.resolve(); }
        onDone('', false, '');
        return Promise.resolve();
      },
    };
    UsageAssistant._isSending = true;
    await UsageAssistant._runLoop('给我配置技能');
    const last = UsageAssistant.messages[UsageAssistant.messages.length - 1] as unknown as Any;
    expect(last.skill).toBeTruthy();
    expect(String(last.content)).toContain('AI 编程助手');
  });
});

describe('setup-skill：拼装细节', () => {
  it('结尾补换行、bytes 用 UTF-8 计（中文不按字符数算）', async () => {
    stubAssetFetch();
    const r = await buildSetupSkillMd();
    expect(r.ok).toBe(true);
    expect(String(r.markdown).endsWith('\n')).toBe(true);
    const md = String(r.markdown);
    expect(r.bytes).toBe(utf8Bytes(md));
    expect(r.bytes!).toBeGreaterThan(md.length);   // 有中文 → 字节数大于字符数
  });
});
