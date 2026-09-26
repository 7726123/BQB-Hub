import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/preset';
import { MINIMAL_PRESET_MODULES, MINIMAL_PRESET_PATCHES, THINK_TAIL_FALLBACK, stPromptsToModules, nativeModulesToModules, moduleLooksLikeCot, moduleIsCotSpec, stReasoningToLevel, samplerFromJson, stRegexScriptsToRules } from '../src/domain/preset';
import { RegexEngine as RE } from '../src/lib/regex'; // P3-A：regex 不再挂全局，直接 import

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
const PSM = (globalThis as unknown as { PresetManager: typeof import('../src/domain/preset').PresetManager }).PresetManager;

const toasts: string[] = [];
(globalThis as unknown as Record<string, unknown>).App = { toast: (m: string) => toasts.push(m) };
(globalThis as unknown as Record<string, unknown>).UIManager = {
  populateSystemPromptUI: () => {}, renderPresets: () => {}, renderModuleList: () => {}, renderRegexRules: () => {}
};

describe('PresetManager', () => {
  beforeEach(() => {
    for (const k of ['presets', 'systemPrompts', 'currentPresetId', 'currentSysPromptId', 'apiConfig', 'regexRules', 'builtinMinimalPresetV1', 'minimalPresetLateModulesV1', 'minimalPresetLateModulesV2', 'minimalPresetLateModulesV3', 'minimalPresetLateModulesV4', 'minimalPresetForceSyncDone']) sm().remove(k);
    toasts.length = 0;
  });

  it('initDefaults 注入 3 个系统提示词 + 内置最小预设 + apiConfig', () => {
    PSM.initDefaults();
    expect(PSM.getSystemPrompts()).toHaveLength(3);
    expect(PSM.getSystemPrompts().map((p) => p.name)).toEqual(['日式轻小说', '都市爽文', '悬疑推理']);
    expect(PSM.getCurrentSystemPromptId()).toBe('sp_default');
    const presets = PSM.getPresets();
    expect(presets).toHaveLength(1);
    expect(presets[0].name).toBe('轻小说·最小预设');
    expect(presets[0].id).toBe('preset_minimal');
    expect(((presets[0] as { promptModules?: unknown[] }).promptModules || []).length).toBeGreaterThan(10);
    expect(PSM.getCurrentPresetId()).toBe('preset_minimal');
    expect(PSM.getActiveAPIConfig().endpoint).toBe('https://api.deepseek.com/v1');
  });

  // 内置最小预设的文本约束：这些不是文风问题，而是与 app 注入管线的耦合点，改错会直接坏功能
  it('内置最小预设：启用文本满足注入管线约束', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as { promptModules: Array<{ content: string; enabled: boolean; role: string }> }).promptModules);
    // 启用 = 12 个系统模块 + 2 个「思维链」尾部模块（role='user' 不进 system；
    // 系统侧那两条细则自 2026-09-26 合并起默认关闭）
    expect(mods.filter((m) => m.enabled)).toHaveLength(14);
    expect(mods.filter((m) => m.enabled && m.role === 'user')).toHaveLength(2);
    expect(mods.filter((m) => m.enabled && m.role !== 'user')).toHaveLength(12);
    // 进系统提示词的那部分：文本里的 user 会被 app 换成主角名，标签会诱导弹标签
    const sp = mods.filter((m) => m.enabled && m.role !== 'user').map((m) => m.content).join('\n\n');
    expect(sp).not.toContain('<thinking>');            // 原生推理模型会被诱导弹标签
    expect(sp).not.toMatch(/\$\{/);                    // 预设展开会剥壳
    expect(sp.replace(/\{\{user\}\}/g, '')).not.toMatch(/\buser\b/i); // app 会把任意 user 换成主角名
    // 合并后系统里不再有"梳理"字样 → 「预设要求先梳理」改由"有启用的思维链模块"触发（见 app.ts）
    // 尾部思考模块同样会被 _expandSTInMessages 展开，约束一致
    const tail = mods.filter((m) => m.enabled && m.role === 'user').map((m) => m.content).join('\n\n');
    expect(tail).not.toContain('<thinking>');
    expect(tail).not.toMatch(/\$\{/);
    expect(tail.replace(/\{\{user\}\}/g, '')).not.toMatch(/\buser\b/i);
  });

  // 防「在思考里先写一遍正文草稿、再审查后输出」（用户实测常见，浪费额度且成稿与草稿对不上）。
  // 2026-09-26 合并后这条规则只在尾部那条生效；系统侧两条默认关闭但文案保留（想分开用可开回来）。
  it('思维链规则：只在尾部那条生效，系统侧两条默认关闭但文案保留', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as { promptModules: Array<{ id: string; content: string; enabled: boolean; slot?: string; role?: string }> }).promptModules);
    const tail = mods.find((m) => m.id === 'min_25_think_tail_novel')!;
    expect(tail.enabled).toBe(true);
    expect(tail.slot).toBe('think');
    expect(tail.role).toBe('user');
    expect(tail.content).toContain('对白原句');          // 文体级禁令（不写正文句子/对白原句/场景描写）
    expect(tail.content).toContain('不要"先写一版再检查"');
    expect(tail.content).toContain('不要写出那句话');    // 落点只写要点
    expect(tail.content).toContain('只写一次');
    // 系统侧两条：关闭但内容还在（用户可自行打开）
    const cot = mods.find((m) => m.id === 'min_18_cot_full')!;
    expect(cot.enabled).toBe(false);
    expect(cot.content).toContain('思考里禁止写正文');
    expect(cot.content).toContain('正文只写这一次');
    const short = mods.find((m) => m.id === 'min_19_cot_short')!;
    expect(short.enabled).toBe(false);
    expect(short.content).toContain('不要在思考里写正文或对白');
  });

  // 合并迁移：设备上还开着的系统侧细则要被一次性关掉（只改开关，不动文案/名字）
  it('合并迁移：一次性关停系统侧思维链细则', () => {
    PSM.initDefaults();
    const list = PSM.getPresets();
    const p = list.find((x) => x.id === 'preset_minimal') as any;
    p.promptModules.find((m: any) => m.id === 'min_18_cot_full').enabled = true;   // 模拟旧设备上还开着
    PSM.savePresets(list);
    sm().remove('minimalPresetForceDisableDone');
    PSM.applyMinimalPresetForceDisable();
    const q = (id: string) => (PSM.getPresets().find((x) => x.id === 'preset_minimal') as any).promptModules.find((m: any) => m.id === id);
    expect(q('min_18_cot_full').enabled).toBe(false);
    expect(q('min_18_cot_full').content).toContain('思考里禁止写正文');   // 文案保留
    // 只处理一次：用户再开回来不会被关
    q('min_18_cot_full').enabled = true;
    PSM.applyMinimalPresetForceDisable();
    expect(q('min_18_cot_full').enabled).toBe(true);
  });

  // 内置预设文案补丁：v1.5.75 首发版已写进设备，改源码不会自动生效，靠补丁在启动时同步
  it('内置预设文案补丁：出厂原文→自动同步，用户改过→保留，且只处理一次', () => {
    PSM.initDefaults();
    const patch = MINIMAL_PRESET_PATCHES.find((x) => x.moduleId === 'min_18_cot_full')!;
    // 模拟设备上的首发版副本：思维链模块是旧文本
    const legacy = PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules.map((mm) => (mm.id === patch.moduleId ? { ...mm, content: patch.oldContent } : mm)) }
      : p));
    PSM.savePresets(legacy as never);
    sm().remove('minimalPresetPatchApplied');
    PSM.applyMinimalPresetPatches();
    const after = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules;
    expect(after.find((mm) => mm.id === patch.moduleId)!.content).toBe(MINIMAL_PRESET_MODULES.find((mm) => mm.id === patch.moduleId)!.content);
    expect(after.find((mm) => mm.id === patch.moduleId)!.content).toContain('思考里禁止写正文');

    // 用户自己改过 → 不覆盖
    sm().remove('minimalPresetPatchApplied');
    PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules.map((mm) => (mm.id === patch.moduleId ? { ...mm, content: '我自己的梳理要求' } : mm)) }
      : p)) as never);
    PSM.applyMinimalPresetPatches();
    const kept = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules;
    expect(kept.find((mm) => mm.id === patch.moduleId)!.content).toBe('我自己的梳理要求');
  });

  // 文风模块（min_05_style_kei）：2026-09-25 按桌面上两部台版轻小说（败犬女主 / 路人女主）重写。
  // 用户反馈「预设太弱、玩起来很奇怪」——旧文案只有 6 条抽象要求，新文案把可执行的写法钉进去。
  it('文风模块：关键写法齐全，且旧文案会被补丁同步到老设备（改过则保留）', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as { promptModules: Array<{ id: string; content: string; enabled: boolean }> }).promptModules);
    const mod = mods.find((m) => m.id === 'min_05_style_kei')!;
    expect(mod.enabled).toBe(true);
    expect(mod.content).toContain('文风：轻小说·日常（台版腔）');
    expect(mod.content).toContain('对白独立成行');
    expect(mod.content).toContain('每个角色有自己的声音');
    expect(mod.content).toContain('句尾习惯');
    expect(mod.content).toContain('不写「气氛有些尴尬」');
    expect(mod.content).toContain('省略号是常用的标点');
    expect(mod.content).toContain('破折号不出现（见《禁令》）');   // 破折号绝对禁用（用户 2026-09-25 要求）
    expect(mod.content).toContain('避免书面腔');
    expect(mod.content).not.toContain('视角');   // 视角只由 min_09..min_12 决定
    expect(mod.content).not.toContain('字数');

    // 老设备：模块内容还是旧文案 → 启动同步后换成新版
    const patch = MINIMAL_PRESET_PATCHES.find((x) => x.id === 'style-kei-v2')!;
    expect(patch.id).toBe('style-kei-v2');
    PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules.map((mm) => (mm.id === patch.moduleId ? { ...mm, content: patch.oldContent } : mm)) }
      : p)) as never);
    sm().remove('minimalPresetPatchApplied');
    PSM.applyMinimalPresetPatches();
    const after = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules;
    expect(after.find((mm) => mm.id === patch.moduleId)!.content).toContain('台版腔');

    // 用户自己改过文风 → 不覆盖（与其它内置文案补丁一致）
    sm().remove('minimalPresetPatchApplied');
    PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules.map((mm) => (mm.id === patch.moduleId ? { ...mm, content: '我自己的文风要求' } : mm)) }
      : p)) as never);
    PSM.applyMinimalPresetPatches();
    const kept = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules;
    expect(kept.find((mm) => mm.id === patch.moduleId)!.content).toBe('我自己的文风要求');
  });

  // 用户要求「把禁令加上」：把酒馆预设的去欧规范改写成我们自己的《禁令》模块；破折号绝对禁用
  // （与旧的「不超过三处」冲突时以禁用为准）——三处旧文案都靠补丁同步给老设备。
  it('禁令模块：破折号绝对禁用 + 具体套路清单；三处旧文案补丁同步（改过则保留）', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as { promptModules: Array<{ id: string; name: string; content: string; enabled: boolean; order: number }> }).promptModules);
    const ban = mods.find((m) => m.id === 'min_24_bans')!;
    expect(ban.name).toBe('禁令·套路与套话');
    expect(ban.enabled).toBe(true);
    expect(ban.content).toContain('破折号一个字都不出现');
    expect(ban.content).toContain('全文各限一次');
    expect(ban.content).toContain('x 了 x 叠词');
    expect(ban.content).toContain('「那+量词」');
    expect(ban.content).toContain('环境过渡三句封顶');
    expect(ban.content).toContain('等待式结尾');
    expect(ban.content).toContain('数数式排比');
    expect(ban.content).not.toContain('字数');   // 不与字数模块抢规则
    const ids = mods.map((m) => m.id);
    expect(ids.indexOf('min_24_bans')).toBe(ids.indexOf('min_20_ai_flavor') + 1);   // 紧跟「反 AI 味」
    expect(ids.indexOf('min_09_pov_1')).toBe(ids.indexOf('min_24_bans') + 1);       // 仍在视角之前
    // 破折号：连老规则也改了（用户要求冲突时以禁用为准）
    expect(mods.find((m) => m.id === 'min_04_narrative')!.content).toContain('破折号不出现');
    expect(mods.find((m) => m.id === 'min_04_narrative')!.content).not.toContain('不超过三处');
    expect(mods.find((m) => m.id === 'min_20_ai_flavor')!.content).toContain('破折号不出现（见《禁令》）');

    // 老设备：三条旧文案（数值≤3 / 节制使用 / 真正需要时用）→ 补丁换成出厂新版
    const snapshot = (id: string) => (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules.find((m) => m.id === id)!.content;
    const setContent = (id: string, text: string) => {
      PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
        ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules.map((m) => (m.id === id ? { ...m, content: text } : m)) }
        : p)) as never);
    };
    const shipped04 = snapshot('min_04_narrative');
    const shipped20 = snapshot('min_20_ai_flavor');
    const p04 = MINIMAL_PRESET_PATCHES.find((x) => x.id === 'dash-ban-narrative')!;
    const p05 = MINIMAL_PRESET_PATCHES.find((x) => x.id === 'dash-ban-style-kei')!;
    const p20 = MINIMAL_PRESET_PATCHES.find((x) => x.id === 'dash-ban-ai-flavor')!;
    expect(p04.oldContent).toContain('破折号全文不超过三处');
    expect(p05.oldContent).toContain('破折号按《叙事规则》节制使用');
    expect(p20.oldContent).toContain('破折号只在真正需要时用');
    setContent('min_04_narrative', p04.oldContent);
    setContent('min_20_ai_flavor', p20.oldContent);
    sm().remove('minimalPresetPatchApplied');
    PSM.applyMinimalPresetPatches();
    expect(snapshot('min_04_narrative')).toBe(shipped04);
    expect(snapshot('min_20_ai_flavor')).toBe(shipped20);
    // 用户自己改过 → 保留
    sm().remove('minimalPresetPatchApplied');
    setContent('min_20_ai_flavor', '我自己的反 AI 味版本');
    PSM.applyMinimalPresetPatches();
    expect(snapshot('min_20_ai_flavor')).toBe('我自己的反 AI 味版本');

    // V3 补装：老设备没有禁令模块时补一次，插在视角之前；删掉后不再加回
    const strip = () => PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string }> }).promptModules.filter((m) => m.id !== 'min_24_bans') }
      : p)) as never);
    strip();
    sm().remove('minimalPresetLateModulesV3');
    PSM.applyMinimalPresetLateModules();
    const after = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; order: number }> }).promptModules;
    expect(after.some((m) => m.id === 'min_24_bans')).toBe(true);
    const a = after.map((m) => m.id);
    expect(a.indexOf('min_24_bans')).toBe(a.indexOf('min_20_ai_flavor') + 1);
    expect(after.map((m) => m.order)).toEqual(after.map((_m, i) => i));
    strip();
    PSM.applyMinimalPresetLateModules();
    const fin = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string }> }).promptModules;
    expect(fin.some((m) => m.id === 'min_24_bans')).toBe(false);
  });

  // 用户 2026-09-25 反馈的三条体验问题 → 三条默认开启的新模块（酒馆预设同款思路：去user中心化/NPC不围主角/防全知）
  it('新增三模块：叙事焦点·去主角中心 / 出场角色·克制 / 情绪·不冷静（默认开启、位置与要点）', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as { promptModules: Array<{ id: string; name: string; content: string; enabled: boolean; order: number }> }).promptModules);
    const focus = mods.find((m) => m.id === 'min_21_ensemble')!;
    const cast = mods.find((m) => m.id === 'min_22_cast')!;
    const emo = mods.find((m) => m.id === 'min_23_emotion')!;
    for (const m of [focus, cast, emo]) { expect(m.enabled).toBe(true); expect(m.order).toBeGreaterThanOrEqual(0); }
    expect(focus.content).toContain('主角是视角，不是世界的中心');
    expect(focus.content).toContain('功能位');
    expect(focus.content).toContain('未必属于主角');
    expect(cast.content).toContain('1~3 个人');
    expect(cast.content).toContain('清点式写人');
    expect(cast.content).toContain('凭空添新面孔');
    expect(emo.content).toContain('镇定是偶尔的');
    expect(emo.content).toContain('本能反应');
    expect(emo.content).toContain('允许不体面');
    expect(emo.content).toContain('洞悉一切');
    // 顺序：叙事规则 → 叙事焦点 → 出场角色 → 文风……；情绪在 反AI味 之前
    const ids = mods.map((m) => m.id);
    expect(ids.indexOf('min_21_ensemble')).toBe(ids.indexOf('min_04_narrative') + 1);
    expect(ids.indexOf('min_22_cast')).toBe(ids.indexOf('min_21_ensemble') + 1);
    expect(ids.indexOf('min_23_emotion')).toBe(ids.indexOf('min_20_ai_flavor') - 1);
    // 三条互不越界：不重定义视角/字数/主控权
    for (const m of [focus, cast, emo]) {
      expect(m.content).not.toContain('字数');
      expect(m.content).not.toContain('主控权');
    }
    // 老设备（V2 补装）：设备上没有这三条时补一次，插到各自锚点之前
    const strip = () => PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string }> }).promptModules.filter((m) => ['min_21_ensemble', 'min_22_cast', 'min_23_emotion'].indexOf(m.id) < 0) }
      : p)) as never);
    strip();
    sm().remove('minimalPresetLateModulesV2');
    PSM.applyMinimalPresetLateModules();
    const after = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string; order: number; enabled: boolean }> }).promptModules;
    const a = after.map((m) => m.id);
    expect(a).toContain('min_21_ensemble');
    expect(a.indexOf('min_21_ensemble')).toBe(a.indexOf('min_04_narrative') + 1);
    expect(a.indexOf('min_23_emotion')).toBe(a.indexOf('min_20_ai_flavor') - 1);
    expect(after.find((m) => m.id === 'min_22_cast')!.enabled).toBe(true);
    expect(after.map((m) => m.order)).toEqual(after.map((_m, i) => i));
    // 只处理一次：标记已置位后再删掉也不加回
    strip();
    PSM.applyMinimalPresetLateModules();
    const fin = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as { promptModules: Array<{ id: string }> }).promptModules;
    expect(fin.some((m) => m.id === 'min_21_ensemble')).toBe(false);
  });

  it('内置预设补全：老用户升级补一条、不抢当前预设、删掉后不再自动加回', () => {
    PSM.savePresets([{ id: 'mine', name: '我的预设', prompts: [], createdAt: 0 }]);
    PSM.setCurrentPresetId('mine');
    PSM.initDefaults();
    expect(PSM.getPresets().map((p) => p.name)).toEqual(['我的预设', '轻小说·最小预设']);
    expect(PSM.getCurrentPresetId()).toBe('mine');           // 不抢占
    expect(toasts.some((t) => t.includes('已新增内置预设'))).toBe(true);
    // 用户删掉后再启动：SM 标记已置位 → 不再加回
    PSM.savePresets([{ id: 'mine', name: '我的预设', prompts: [], createdAt: 0 }]);
    PSM.initDefaults();
    expect(PSM.getPresets().map((p) => p.name)).toEqual(['我的预设']);
  });

  // 反 AI 味（min_20_ai_flavor）：v1.5.97.10 新增，专治最扎眼的机器腔（章末升华 / 模板句式 / 套话）
  it('反 AI 味模块：默认开启、只讲写作约束，位置在文风之后视角之前', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as {
      promptModules: Array<{ id: string; name: string; content: string; enabled: boolean; role: string }>
    }).promptModules);
    const mod = mods.find((m) => m.id === 'min_20_ai_flavor')!;
    expect(mod.name).toBe('反 AI 味');
    expect(mod.enabled).toBe(true);
    expect(mod.role).toBe('system');
    expect(mod.content).toContain('章末不总结');
    expect(mod.content).toContain('不是……而是……');
    expect(mod.content).toContain('markdown');
    expect(mod.content).toContain('看穿与身体反应');      // v2：脸红不是"被看穿"的证据
    expect(mod.content).toContain('身体反应不是证据');
    expect(mod.content).toContain('一被说破就承认');
    expect(mod.content).not.toContain('视角');   // 视角只由 min_09..min_12 决定，两套规则不能打架
    expect(mod.content).not.toContain('字数');
    const ids = mods.map((m) => m.id);
    expect(ids.indexOf('min_20_ai_flavor')).toBe(ids.indexOf('min_08_style_custom') + 2);   // 中间多了「情绪·不冷静」
    expect(ids.indexOf('min_09_pov_1')).toBe(ids.indexOf('min_20_ai_flavor') + 2);   // 中间多了「禁令·套路与套话」
  });

  // 老设备上 preset_minimal 的模块表是存量数据，源码里新增模块不会自己出现（v1.5.75 首发版踩过）
  it('内置模块补装：老设备补一次、插在视角之前、删掉后不再加回', () => {
    PSM.initDefaults();
    const strip = () => PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string }> }).promptModules.filter((m) => m.id !== 'min_20_ai_flavor') }
      : p)) as never);

    strip();                                    // 模拟老设备：设备上没有这个模块
    sm().remove('minimalPresetLateModulesV1');
    toasts.length = 0;
    PSM.initDefaults();
    const mods = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as {
      promptModules: Array<{ id: string; enabled: boolean; order: number }>
    }).promptModules;
    const idx = mods.findIndex((m) => m.id === 'min_20_ai_flavor');
    expect(idx).toBeGreaterThan(-1);
    expect(mods[idx].enabled).toBe(true);
    expect(mods.findIndex((m) => m.id === 'min_09_pov_1')).toBe(idx + 1);  // 插在「视角」之前
    expect(mods.map((m) => m.order)).toEqual(mods.map((_m, i) => i));      // order = 数组下标（与模块管理页一致）
    expect(toasts.some((t) => t.includes('已新增预设模块'))).toBe(true);

    // 用户删掉后再启动：标记已置位 → 不再加回
    strip();
    PSM.initDefaults();
    const after = (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as {
      promptModules: Array<{ id: string }>
    }).promptModules;
    expect(after.some((m) => m.id === 'min_20_ai_flavor')).toBe(false);
  });

  // 一次性强制覆盖（用户 2026-09-23 要求：「反 AI 味」这次不管用户改没改过都统一覆盖一遍）。
  // 常规路径是逐字比对、用户改过就不动（见上一条用例），这条是明确的例外，所以边界要钉死：
  // 只覆盖已存在的模块、删掉的不加回、开/关状态不动、只处理一次（之后用户的编辑重新受保护）。
  it('强制覆盖：改过的文案被换成出厂版、删掉的不加回、只处理一次', () => {
    PSM.initDefaults();
    const shipped = MINIMAL_PRESET_MODULES.find((m) => m.id === 'min_20_ai_flavor')!.content;
    const modsOf = () => (PSM.getPresets().find((p) => p.id === 'preset_minimal') as unknown as {
      promptModules: Array<{ id: string; content: string; enabled: boolean }>
    }).promptModules;
    const edit = (patch: (m: { id: string; content: string; enabled: boolean }) => void) => {
      // 注意：SM().get 每次返回的是重新解析出来的新对象，必须在同一次 getPresets() 的返回值上改再存
      PSM.savePresets(PSM.getPresets().map((p) => {
        if (p.id !== 'preset_minimal') return p;
        const mods = ((p as unknown as { promptModules?: Array<{ id: string; content: string; enabled: boolean }> }).promptModules) || [];
        mods.forEach((m) => { if (m.id === 'min_20_ai_flavor') patch(m); });
        return p;
      }) as never);
    };

    // ① 用户改过文案并关掉了开关 → 文案被强制覆盖，但开关状态保持用户的选择
    edit((m) => { m.content = '我自己删减过的版本'; m.enabled = false; });
    sm().remove('minimalPresetForceSyncDone');
    PSM.initDefaults();
    const mod = modsOf().find((m) => m.id === 'min_20_ai_flavor')!;
    expect(mod.content).toBe(shipped);
    expect(mod.content).toContain('身体反应不是证据');
    expect(mod.enabled).toBe(false);            // 开/关不动

    // ② 只处理一次：之后用户再改，启动不再覆盖（编辑重新受保护）
    edit((m) => { m.content = '第二次我自己的版本'; });
    PSM.initDefaults();
    expect(modsOf().find((m) => m.id === 'min_20_ai_flavor')!.content).toBe('第二次我自己的版本');

    // ③ 用户把这条删掉 → 不加回（补装标记与强制覆盖都不碰缺失的模块）
    PSM.savePresets(PSM.getPresets().map((p) => (p.id === 'preset_minimal'
      ? { ...p, promptModules: (p as unknown as { promptModules: Array<{ id: string }> }).promptModules.filter((m) => m.id !== 'min_20_ai_flavor') }
      : p)) as never);
    sm().remove('minimalPresetForceSyncDone');
    PSM.initDefaults();
    expect(modsOf().some((m) => m.id === 'min_20_ai_flavor')).toBe(false);
  });

  it('getActiveSystemPrompt：按 id 优先，否则第一个', () => {
    PSM.initDefaults();
    expect(PSM.getActiveSystemPrompt()).toContain('日式轻小说');
    PSM.setCurrentSystemPromptId('sp_urban');
    expect(PSM.getActiveSystemPrompt()).toContain('都市');
  });

  it('applyPreset 切换预设与系统提示词', () => {
    PSM.initDefaults();
    PSM.savePresets([...PSM.getPresets(), { id: 'p2', name: '预设2', prompts: [], systemPromptId: 'sp_mystery', createdAt: 0 }]);
    PSM.applyPreset('p2');
    expect(PSM.getCurrentPresetId()).toBe('p2');
    expect(PSM.getCurrentSystemPromptId()).toBe('sp_mystery');
    expect(toasts.at(-1)).toBe('已切换预设: 预设2');
  });

  it('正则跟随预设：带正则预设 → 备份全局并加载预设正则；无正则预设 → 还原备份', () => {
    RE.saveRules([{ name: '全局规则', enabled: true, timing: 'before', order: 0, findRegex: 'a', replaceString: 'b' } as never]);
    PSM.savePresets([
      { id: 'withRegex', name: '带正则', prompts: [], createdAt: 0, regexScripts: [{ name: '预设正则', enabled: true, timing: 'after', findRegex: 'x', replaceString: 'y' }] },
      { id: 'noRegex', name: '不带', prompts: [], createdAt: 0 }
    ]);
    // 切到带正则预设
    PSM.applyPreset('withRegex');
    expect(RE.getRules()).toHaveLength(1);
    expect((RE.getRules() as { name: string }[])[0].name).toBe('预设正则');
    // 切到不带正则预设 → 还原全局备份
    PSM.applyPreset('noRegex');
    expect((RE.getRules() as { name: string }[])[0].name).toBe('全局规则');
  });

  it('initDefaults 清理旧 Haruki/默认预设', () => {
    PSM.savePresets([
      { id: 'x1', name: 'Haruki风格', prompts: [], createdAt: 0 },
      { id: 'x2', name: '默认预设', prompts: [], createdAt: 0 },
      { id: 'x3', name: '保留', prompts: [], createdAt: 0 }
    ]);
    PSM.initDefaults();
    // 保留项 + 同一次 initDefaults 里补全的内置最小预设
    expect(PSM.getPresets().map((p) => p.name)).toEqual(['保留', '轻小说·最小预设']);
  });

  // 「＋ 新建预设」：空预设（不带模块/正则），模块由用户在模块管理里自己加
  it('createEmptyPreset：新建的是空预设，且不改动原预设', () => {
    PSM.initDefaults();
    const src = PSM.getCurrentPreset()!;
    const srcMods = (src as unknown as { promptModules: Array<{ id: string; content: string }> }).promptModules;
    const srcFirst = srcMods[0].content;

    const created = PSM.createEmptyPreset('我的预设');
    expect(created.id).not.toBe(src.id);
    expect(created.name).toBe('我的预设');
    expect((created as unknown as { promptModules: unknown[] }).promptModules).toEqual([]);
    expect(created.regexScripts).toBeUndefined();
    expect(created.systemPromptId).toBe(src.systemPromptId); // 有系统提示词兜底
    expect(created.isDefault).toBe(false);
    expect(PSM.getCurrentPresetId()).toBe(created.id);        // 创建后切到新预设
    const srcAfter = PSM.getPresets().find((p) => p.id === src.id) as unknown as { promptModules: Array<{ content: string }> };
    expect(srcAfter.promptModules[0].content).toBe(srcFirst);

    // 重名自动加后缀，原预设仍在
    const second = PSM.createEmptyPreset('我的预设');
    expect(second.name).toBe('我的预设 (2)');
    expect(PSM.getPresets().filter((p) => p.name === '我的预设')).toHaveLength(1);
    expect(PSM.getPresets().map((p) => p.id)).toContain(src.id);
  });

  it('createEmptyPreset：没有当前预设时也能建（systemPromptId 兜底为当前系统提示词）', () => {
    PSM.initDefaults();
    PSM.savePresets([]);
    PSM.setCurrentPresetId('not-exist');
    const created = PSM.createEmptyPreset('副本');
    expect(created.systemPromptId).toBe('sp_default');
    expect((created as unknown as { promptModules: unknown[] }).promptModules).toEqual([]);
    expect(PSM.getCurrentPresetId()).toBe(created.id);
  });
});

// 尾部模块（role='user'）与三个字段（2026-09-26）：位置归软件、内容归预设。
// 背景（实测见 preset.ts 里两条模块的注释）：思考纪律只写在 system 里 → 思考中位约 3689 字、
// 常在思考里预演正文；同一段话挪到最后一条用户消息末尾 → 中位约 600 字、正文不变甚至更长。
describe('尾部模块：位置/模式/思考标记', () => {
  // 本 describe 在原 describe 之外 → 没有它的 beforeEach，存储会跨用例残留（上一个用例的自定义预设
  // 会让 initDefaults() 走"已有预设"分支、装不进内置预设）。这里自己清一遍。
  beforeEach(() => {
    for (const k of ['presets', 'systemPrompts', 'currentPresetId', 'currentSysPromptId', 'apiConfig', 'regexRules',
      'builtinMinimalPresetV1', 'minimalPresetLateModulesV1', 'minimalPresetLateModulesV2', 'minimalPresetLateModulesV3', 'minimalPresetLateModulesV4', 'minimalPresetForceSyncDone']) sm().remove(k);
  });
  const setMods = (mods: any[]) => {
    PSM.savePresets([{ id: 'p_tail', name: '尾部测试', prompts: [], promptModules: mods, systemPromptId: 'sp_default', isDefault: false, createdAt: 1 } as any]);
    PSM.setCurrentPresetId('p_tail');
  };
  const sysMod = (id: string, content: string, extra: any = {}) => ({ id, name: id, content, enabled: true, role: 'system', order: 1, ...extra });
  const tailMod = (id: string, content: string, extra: any = {}) => ({ id, name: id, content, enabled: true, role: 'user', order: 9, ...extra });

  it('内置预设自带两条思考尾部模块（按模式分开），内容与兜底一致', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as any).promptModules as any[]);
    const novel = mods.find((m) => m.id === 'min_25_think_tail_novel')!;
    const chat = mods.find((m) => m.id === 'min_26_think_tail_chat')!;
    expect([novel.role, novel.mode, novel.slot]).toEqual(['user', 'novel', 'think']);
    expect([chat.role, chat.mode, chat.slot]).toEqual(['user', 'chat', 'think']);
    expect(novel.content).toBe(THINK_TAIL_FALLBACK.novel);
    expect(chat.content).toBe(THINK_TAIL_FALLBACK.chat);
    // 清单式：两条都必须是"清单 + 禁自我否决"，且都交代"停在哪儿"
    expect(novel.content).toContain('清单：');
    expect(chat.content).toContain('清单：');
    expect(novel.content).toContain('不列备选、不比较方案、不自我否决');
    expect(chat.content).toContain('不列备选、不比较方案、不自我否决');
    expect(novel.content).toContain('不要写出那句话');
    expect(chat.content).toContain('不要写出那句话');
    // 头尾各一次「不要遗漏」的格式/硬要求回顾（两条酒馆预设的共同做法，格式遵守靠它）
    expect(novel.content).toContain('过要求【不要遗漏】');
    expect(novel.content).toContain('动笔前再确认【不要遗漏】');
    expect(chat.content).toContain('过要求【不要遗漏】');
    expect(chat.content).toContain('过格式【不要遗漏】');
    expect(chat.content).toContain('开演前确认【不要遗漏】');
    // 收尾仪式已删除（实测：写了这句的样本 78% 漏通道，没写的 21%）——保留首行「先看再写」
    expect(novel.content).not.toContain('思考的最后一行只写');
    expect(chat.content).not.toContain('思考的最后一行只写');
    expect(novel.content).not.toContain('先看再写');
    expect(chat.content).not.toContain('先看再写');
    expect(novel.content).toContain('清单：');
    expect(chat.content).toContain('清单：');
    // 续写版禁"在思考里写文章"（文体级表述，避免"不许写正文"漏到输出上）；演出版不能禁——
    // 它的思考要兼职排练气泡格式（引号/白行）
    expect(novel.content).toContain('对白原句');
    expect(novel.content).toContain('写出来的一律删掉');
    expect(chat.content).toContain('格式过一遍');
  });

  it('尾部模块不进系统提示词；system 模块不受影响', () => {
    PSM.initDefaults();
    const sys = PSM.activeModules('novel').filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
    const tails = PSM.activeModules('novel').filter((m: any) => m.role === 'user');
    expect(sys).not.toContain('先看再写');
    expect(tails.map((m: any) => m.id)).toEqual(['min_25_think_tail_novel']);
  });

  it('模式门控：续写版只在续写生效，演出版只在演出生效', () => {
    PSM.initDefaults();
    expect(PSM.activeModules('novel').some((m: any) => m.mode === 'chat')).toBe(false);
    expect(PSM.activeModules('chat').some((m: any) => m.mode === 'novel')).toBe(false);
    // 兜底也因此按模式各取一份（续写预设里没有演出版的思考模块 → 演出模式吃兜底）
    expect(PSM.tailText('novel', { nativeReasoning: true })).toBe(THINK_TAIL_FALLBACK.novel);
    expect(PSM.tailText('chat', { nativeReasoning: true })).toBe(THINK_TAIL_FALLBACK.chat);
  });

  it('预设自带思考尾部模块 → 用作者那份，不再插软件兜底', () => {
    setMods([sysMod('s1', '# 人设'), tailMod('t1', '【我的思考要求】只写三行。', { slot: 'think', mode: 'novel' })]);
    const out = PSM.tailText('novel', { nativeReasoning: true });
    expect(out).toBe('【我的思考要求】只写三行。');
    expect(out).not.toContain('先看再写');   // 兜底文案没被叠加进来
  });

  it('没有任何尾部思考模块 → 软件兜底（老预设/导入预设也能拿到改进）', () => {
    setMods([sysMod('s1', '# 人设'), tailMod('t1', '【本轮附加】收尾停在动作上。')]);
    const out = PSM.tailText('novel', { nativeReasoning: true });
    expect(out).toContain(THINK_TAIL_FALLBACK.novel);
    expect(out).toContain('【本轮附加】收尾停在动作上。');   // 普通尾部模块照常下发
  });

  it('思考强度 off / 无原生推理通道 → 思考条款整条不下发（普通尾部模块仍在）', () => {
    PSM.initDefaults();
    expect(PSM.tailText('novel', { nativeReasoning: true, thinkingOff: true })).toBe('');
    expect(PSM.tailText('novel', { nativeReasoning: false })).toBe('');
    setMods([tailMod('t1', '【格式契约】', {}), tailMod('t2', '【思考要求】', { slot: 'think' })]);
    const off = PSM.tailText('novel', { nativeReasoning: true, thinkingOff: true });
    expect(off).toBe('【格式契约】');
    expect(off).not.toContain('【思考要求】');
  });

  it('closing：多模块按 order 拼接（顺序稳定）', () => {
    setMods([
      tailMod('t9', '【后】', { slot: 'think', order: 9 }),
      tailMod('t2', '【前】', { order: 2 }),
    ]);
    expect(PSM.tailText('novel', { nativeReasoning: true })).toBe('【前】\n\n【后】');
  });

  // 2026-09-26 用户反馈：文案里写错了字数（「这五个字：先看再写」其实是四个字），
  // 还写了「思考强度：低」——思考强度有专门的设置项，写在正文里会让模型自己疑惑（思考反而变长）。
  it('两条思维链文案：不出现「思考强度」（与设置项冲突）、不出现字数计数（写错会误导模型）', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as any).promptModules as any[]);
    [THINK_TAIL_FALLBACK.novel, THINK_TAIL_FALLBACK.chat].forEach((c) => {
      expect(c).not.toContain('思考强度');            // 强度归设置项，文案只说长度上限
      expect(c).not.toMatch(/[一二两三四五六七八九十]个字/);   // 「先看再写」是四个字，别再数了
      expect(c).toContain('这只是思考的上限，想完还要接着写');   // 预算明确 + 说明它只是思考的上限
    });
    expect(THINK_TAIL_FALLBACK.novel).toContain('2000 字');   // 续写：清单更长、预算放宽
    expect(THINK_TAIL_FALLBACK.chat).toContain('1500 字');    // 演出：轮次短，预算略紧
    // 首行仪式保留（在思考内部、不带通道切换含义）；收尾仪式已删（漏通道的首要嫌疑，见 preset.ts 注释）
    expect(THINK_TAIL_FALLBACK.novel).toContain('一、读指令 →');
    expect(THINK_TAIL_FALLBACK.chat).toContain('一、读指令 →');
    expect(THINK_TAIL_FALLBACK.novel).not.toContain('先看再写');   // 首行仪式也已去掉（正文里会看到它）
    expect(THINK_TAIL_FALLBACK.chat).not.toContain('先看再写');
    // 系统侧那条（细则）与尾部两条用名字区分开
    expect(mods.find((m) => m.id === 'min_18_cot_full')!.name).toBe('思维链细则（系统）');
    expect(mods.find((m) => m.id === 'min_25_think_tail_novel')!.name).toBe('思维链·续写');
    expect(mods.find((m) => m.id === 'min_26_think_tail_chat')!.name).toBe('思维链·演出');
  });

  // 1.5.99.5 那两条错文案上线只有几分钟：一次性覆盖为修正版（不比对用户是否改过），并同步新名字；
  // 系统侧那两条只改名、不动内容，且用户改过名字就尊重。
  it('迁移：错文案一次性覆盖 + 名字同步（用户改过名字的模块不动）', () => {
    PSM.initDefaults();
    const list = PSM.getPresets();
    const p = list.find((x) => x.id === 'preset_minimal') as any;
    const byId = (id: string) => p.promptModules.find((m: any) => m.id === id);
    byId('min_25_think_tail_novel').content = '【思考要求】旧文案（含思考强度：低）';
    byId('min_26_think_tail_chat').content = '【思考要求】旧文案';
    byId('min_18_cot_full').name = '思维链·标准';          // 设备上的旧名
    byId('min_19_cot_short').name = '我自己改的名字';        // 用户改过 → 不动
    PSM.savePresets(list);
    // initDefaults 刚才已经跑过一次这两个迁移（标记已置位）——要模拟"设备上是旧文案"，得先清标记
    sm().remove('minimalPresetForceSyncDone');
    sm().remove('minimalPresetPatchApplied');
    PSM.applyMinimalPresetForceSync();
    PSM.applyMinimalPresetPatches();
    const list2 = PSM.getPresets();
    const p2 = list2.find((x) => x.id === 'preset_minimal') as any;
    const b2 = (id: string) => p2.promptModules.find((m: any) => m.id === id);
    expect(b2('min_25_think_tail_novel').content).toBe(THINK_TAIL_FALLBACK.novel);
    expect(b2('min_26_think_tail_chat').content).toBe(THINK_TAIL_FALLBACK.chat);
    expect(b2('min_25_think_tail_novel').name).toBe('思维链·续写');
    expect(b2('min_26_think_tail_chat').name).toBe('思维链·演出');
    expect(b2('min_18_cot_full').name).toBe('思维链细则（系统）');   // 旧名命中 → 同步
    expect(b2('min_18_cot_full').content).toContain('思考里禁止写正文'); // 内容没被动
    expect(b2('min_19_cot_short').name).toBe('我自己改的名字');      // 用户改过 → 保留
  });

  // 老设备上的内置预设是存量数据：新模块不会自己出现，靠 V4 补装批次带回（只补一次、删过不加回）
  it('补装批次 V4：老设备能拿到两条思考尾部模块（字段完整）', () => {
    PSM.initDefaults();
    const IDS = ['min_25_think_tail_novel', 'min_26_think_tail_chat'];
    const strip = () => {
      const list = PSM.getPresets();
      const p = list.find((x) => x.id === 'preset_minimal') as any;
      p.promptModules = p.promptModules.filter((m: any) => IDS.indexOf(m.id) < 0);
      PSM.savePresets(list);
    };
    const mods = () => (PSM.getPresets().find((x) => x.id === 'preset_minimal') as any).promptModules;
    strip();
    expect(mods().some((m: any) => IDS.indexOf(m.id) >= 0)).toBe(false);   // 先造出"老设备"状态
    sm().remove('minimalPresetLateModulesV4');                              // 该设备还没跑过 V4
    PSM.applyMinimalPresetLateModules();
    const novel = mods().find((m: any) => m.id === 'min_25_think_tail_novel');
    const chat = mods().find((m: any) => m.id === 'min_26_think_tail_chat');
    expect(novel && novel.role === 'user' && novel.mode === 'novel' && novel.slot === 'think').toBe(true);
    expect(chat && chat.role === 'user' && chat.mode === 'chat' && chat.slot === 'think').toBe(true);
    // 补过一次后不再补：用户删掉的模块不会被加回
    strip();
    PSM.applyMinimalPresetLateModules();
    expect(mods().some((m: any) => IDS.indexOf(m.id) >= 0)).toBe(false);
  });
});

// 导入还原度（2026-09-26）：酒馆预设里 role='user' 的条目要接成尾部模块，
// enabled/顺序取自 prompt_order——老实现这两件事都做错，导入后 content 大半不生效。
describe('酒馆预设导入映射（stPromptsToModules / nativeModulesToModules）', () => {
  beforeEach(() => {
    for (const k of ['presets', 'currentPresetId']) sm().remove(k);
  });
  it('role=user → 尾部模块；assistant → system（不再静默丢弃）', () => {
    const out = stPromptsToModules({
      prompts: [
        { identifier: 'a', role: 'system', content: '系统条目' },
        { identifier: 'b', role: 'user', content: '用户条目' },
        { identifier: 'c', role: 'assistant', content: '预填条目' },
        { identifier: 'd', role: 'user', content: '   ' },     // 空内容：丢弃
      ],
    });
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'system']);
    expect(out.map((m) => m.content)).toEqual(['系统条目', '用户条目', '预填条目']);
    expect(nativeModulesToModules([{ content: 'x', role: 'assistant' }])[0].role).toBe('system');
  });

  it('有 prompt_order 时按它取 enabled 与顺序（被关掉的条目不进提示词）', () => {
    const out = stPromptsToModules({
      prompts: [
        { identifier: 'b', role: 'user', content: '第二条' },
        { identifier: 'off', role: 'system', content: '被关掉的' },
        { identifier: 'a', role: 'system', content: '第一条' },
      ],
      prompt_order: [{ character_id: 100000, order: [
        { identifier: 'a', enabled: true },
        { identifier: 'off', enabled: false },
        { identifier: 'b', enabled: true },
      ] }],
    });
    // 映射保持 prompts 数组原序，只把 prompt_order 的下标写进 order（注入时按 order 排序）
    expect(out.map((m) => m.content)).toEqual(['第二条', '被关掉的', '第一条']);
    expect(out.map((m) => m.enabled)).toEqual([true, false, true]);
    expect(out.map((m) => m.order)).toEqual([2, 1, 0]);
    // 只有启用（且模式匹配）的才进 activeModules，且按 order 排序
    const PSM2 = PSM as any;
    PSM2.savePresets([{ id: 'p_imp', name: '导入', prompts: [], promptModules: out, createdAt: 1 }]);
    PSM2.setCurrentPresetId('p_imp');
    expect(PSM2.activeModules('novel').map((m: any) => m.content)).toEqual(['第一条', '第二条']);
  });

  it('原生预设格式：mode/slot 透传，未知值忽略（不写进模块，保持对象形状）', () => {
    const out = nativeModulesToModules([
      { content: '思考', role: 'user', mode: 'chat', slot: 'think' },
      { content: '普通', role: 'system', mode: 'nonsense', slot: 'nope' },
    ]);
    expect(out[0].mode).toBe('chat');
    expect(out[0].slot).toBe('think');
    expect('mode' in out[1]).toBe(false);
    expect('slot' in out[1]).toBe(false);
  });
});
// 2026-09-26（梦鲸思客V4 事件）：酒馆预设自带的思维链必须被认出来，否则软件会在它后面再补一条
// 自己的思考条款（"≤2000 字、别发散"），两套要求打架 → 用户看到的"思维链非常不稳定"。
describe('预设自带思维链的识别与采样参数跟随（酒馆对齐）', () => {
  beforeEach(() => {
    for (const k of ['presets', 'systemPrompts', 'currentPresetId', 'currentSysPromptId', 'apiConfig', 'regexRules',
      'builtinMinimalPresetV1', 'minimalPresetLateModulesV1', 'minimalPresetLateModulesV2', 'minimalPresetLateModulesV3', 'minimalPresetLateModulesV4', 'minimalPresetForceSyncDone']) sm().remove(k);
  });
  const setMods = (mods: any[]) => {
    PSM.savePresets([{ id: 'p_cot', name: '思维链测试', prompts: [], promptModules: mods, systemPromptId: 'sp_default', isDefault: false, createdAt: 1 } as any]);
    PSM.setCurrentPresetId('p_cot');
  };
  const tailMod = (id: string, content: string, extra: any = {}) => ({ id, name: id, content, enabled: true, role: 'user', order: 9, ...extra });

  it('moduleLooksLikeCot：只认思维链骨架；只引用 </thought_of_chain> 的"写作模式"不算', () => {
    expect(moduleLooksLikeCot('{{setvar::cot::\n【思维模式要求】\n<thought_of_chain>\n…')).toBe(true);
    expect(moduleLooksLikeCot('【思考要求】按清单过一遍')).toBe(true);
    expect(moduleLooksLikeCot('梦鲸思客，开始根据"</thought_of_chain>"进行思考，最终输出内容必须为一个xml文档。')).toBe(false);
    expect(moduleLooksLikeCot('# 文风设定：白话')).toBe(false);
  });

  it('moduleIsCotSpec：专用思维链块才打 slot=think；"模式块里的 CoT" 不打（否则关思考时整块模式消失）', () => {
    // 专用思维链块：名字像 / 骨架就在开头
    expect(moduleIsCotSpec('默认思维链', '{{setvar::cot:: 【思维模式要求】 <thought_of_chain>…')).toBe(true);
    expect(moduleIsCotSpec('随便什么名', '【思维模式要求】 <thinking_step>…')).toBe(true);
    // 「聊天模式」把 CoT 写在正文深处（真实预设里在 142 字处）→ 不是专用思维链块，不能打标
    const prefix = '以下要求定义为 DREAM_CHAT 模式。'.padEnd(130, '·');
    const chatMode = prefix + '【思维模式要求】在{{getvar::sleep_var_thinking_flag}}之后，请遵守以下思考规则…';
    expect(moduleIsCotSpec('聊天模式', chatMode)).toBe(false);
    expect(moduleLooksLikeCot(chatMode)).toBe(true);   // 但它**提到**了 CoT → 仍算"预设自带思维链"，兜底照样不补
    // 「叙事者：自定义思维链」名字带"思维链"但内容是叙事者设定 → 不算
    expect(moduleIsCotSpec('叙事者：自定义思维链', '{{setvar::sleep_var_tuijin:: 叙事者：中庸之白 * 高度遵守叙事设定')).toBe(false);
  });

  it('启用模块里有自带思维链（内容签名认出来，没有 slot） → 不再插软件兜底', () => {
    setMods([
      tailMod('t1', '{{setvar::cot::\n【思维模式要求】\n<thought_of_chain>\n终、定乾坤\n}}'),
      tailMod('t2', '【写作要求】{{getvar::cot}}'),
    ]);
    const out = PSM.tailText('novel', { nativeReasoning: true });
    expect(out).not.toContain(THINK_TAIL_FALLBACK.novel);   // 关键：兜底不再叠加
    expect(out).toContain('【写作要求】');
  });

  it('思维链模块关掉 / 只有普通尾部模块 → 兜底照旧（老行为不变）', () => {
    setMods([
      tailMod('t1', '{{setvar::cot::\n【思维模式要求】\n<thought_of_chain>\n}}', { enabled: false }),
      tailMod('t2', '【本轮附加】收尾停在动作上。'),
    ]);
    const out = PSM.tailText('novel', { nativeReasoning: true });
    expect(out).toContain(THINK_TAIL_FALLBACK.novel);
  });

  it('导入酒馆预设：思维链条目自动打上 slot=think（思考关闭时不发它）；写作模式不打', () => {
    const out = stPromptsToModules({
      prompts: [
        { identifier: 'a', name: '默认思维链', role: 'user', content: '{{setvar::cot::<thought_of_chain>…}}' },
        { identifier: 'b', name: '写作模式', role: 'user', content: '根据"</thought_of_chain>"思考' },
        { identifier: 'c', name: '梦境思客', role: 'system', content: '你本无名' },
      ],
      prompt_order: [{ order: [{ identifier: 'a', enabled: true }, { identifier: 'b', enabled: true }, { identifier: 'c', enabled: true }] }],
    });
    const byName = Object.fromEntries(out.map((m: any) => [m.name, m]));
    expect(byName['默认思维链'].slot).toBe('think');
    expect('slot' in byName['写作模式']).toBe(false);
    expect('slot' in byName['梦境思客']).toBe(false);
  });

  it('stRegexScriptsToRules：酒馆正则搬进来（跳过 HTML 美化 / 提示词专用 / 已关闭）', () => {
    const { rules, skipped } = stRegexScriptsToRules([
      // 酒馆自带的"剥壳"类：AI 输出侧 → after
      { scriptName: '隐藏多余格式内容', findRegex: '/(<dream_body>|</dream_body>)/g', replaceString: '', placement: [2], disabled: false },
      // 用户输入侧 → before
      { scriptName: '清一下输入', findRegex: '/\[\[.*?\]\]/g', replaceString: '', placement: [1], disabled: false },
      // HTML "美化" → 跳过（本软件是纯文本编辑器，塞进去会当正文显示）
      { scriptName: '梦境状态栏美化', findRegex: '/<dream_scene>[\\s\\S]*?<\\/dream_scene>/gm', replaceString: '```html\\n<div style="x">$1</div>', placement: [2], disabled: false },
      // 只给"发给模型的历史"用 → 跳过
      { scriptName: '对AI屏蔽MVU变量更新', findRegex: '/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi', replaceString: '', placement: [2], disabled: false, promptOnly: true },
      // 酒馆里关着的备选 → 跳过
      { scriptName: '备用方案', findRegex: '/x/g', replaceString: '', placement: [2], disabled: true },
      // 没写 placement（老版本）→ 默认 after
      { scriptName: '老版本脚本', findRegex: '/y/g', replaceString: '', disabled: false },
    ]);
    expect(rules.map((r) => r.name)).toEqual(['隐藏多余格式内容', '清一下输入', '老版本脚本']);
    expect(rules.map((r) => r.timing)).toEqual(['after', 'before', 'after']);
    expect(rules.every((r) => r.enabled && r.findRegex && r.order >= 0)).toBe(true);
    expect(skipped).toEqual({ html: 1, promptOnly: 1, disabled: 1 });
  });

  it('samplerFromJson：只收 JSON 里真写了的字段（缺字段不许填默认值覆盖全局）', () => {
    // 原生预设：顶层 sampler
    expect(samplerFromJson({ sampler: { temperature: 1, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0, reasoningEffort: 'medium' } }))
      .toEqual({ temperature: 1, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0, reasoningEffort: 'medium' });
    // 酒馆预设：顶层原始字段（缺的就不写进去）
    expect(samplerFromJson({ temperature: 1, top_p: 0.95 })).toEqual({ temperature: 1, topP: 0.95 });
    // 什么都没有 → 空对象（不许出现 0.8/0.9/0/0 这类凭空默认值）
    expect(samplerFromJson({ prompts: [] })).toEqual({});
    expect(samplerFromJson(null)).toEqual({});
    // 0 是合法值
    expect(samplerFromJson({ presence_penalty: 0, frequency_penalty: 0 })).toEqual({ presencePenalty: 0, frequencyPenalty: 0 });
  });

  it('stReasoningToLevel：酒馆 reasoning_effort → 本软件思考档位', () => {
    expect(stReasoningToLevel('medium')).toBe('medium');
    expect(stReasoningToLevel('low')).toBe('low');
    expect(stReasoningToLevel('minimal')).toBe('low');
    expect(stReasoningToLevel('high')).toBe('high');
    expect(stReasoningToLevel('max')).toBe('high');
    expect(stReasoningToLevel('none')).toBe('off');
    expect(stReasoningToLevel('auto')).toBe('');
    expect(stReasoningToLevel(undefined)).toBe('');
  });

  it('getEffectiveAPIConfig：预设采样参数覆盖全局；用户显式选过思考档位则以用户为准', () => {
    PSM.initDefaults();
    sm().set('apiConfig', { endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm', temperature: 0.9, topP: 0.95, presencePenalty: 0.4, frequencyPenalty: 0.3, deepseekThinking: 'auto' });
    const presets = PSM.getPresets();
    (presets[0] as any).sampler = { temperature: 1, topP: 0.95, presencePenalty: 0, frequencyPenalty: 0, reasoningEffort: 'medium' };
    PSM.savePresets(presets);
    const eff = PSM.getEffectiveAPIConfig();
    expect(eff.temperature).toBe(1);
    expect(eff.presencePenalty).toBe(0);
    expect(eff.frequencyPenalty).toBe(0);
    expect(eff.deepseekThinking).toBe('medium');            // 用户没选过 → 跟预设
    expect(eff.endpoint).toBe('https://x.test/v1');         // 端点等仍来自全局
    // 用户显式选过 low → 预设不得覆盖
    sm().set('apiConfig', Object.assign({}, PSM.getActiveAPIConfig(), { deepseekThinking: 'low' }));
    expect(PSM.getEffectiveAPIConfig().deepseekThinking).toBe('low');
    // 没有 sampler 的预设：完全等于全局配置
    const p2 = PSM.getPresets(); delete (p2[0] as any).sampler; PSM.savePresets(p2);
    expect(PSM.getEffectiveAPIConfig().temperature).toBe(0.9);
    expect(PSM.getEffectiveAPIConfig().deepseekThinking).toBe('low');
  });
});
