import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/preset';
import { MINIMAL_PRESET_MODULES, MINIMAL_PRESET_PATCHES } from '../src/domain/preset';
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
    for (const k of ['presets', 'systemPrompts', 'currentPresetId', 'currentSysPromptId', 'apiConfig', 'regexRules', 'builtinMinimalPresetV1', 'minimalPresetLateModulesV1', 'minimalPresetForceSyncDone']) sm().remove(k);
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
    expect(mods.filter((m) => m.enabled)).toHaveLength(12);   // 2026-09-25 增补三条（去主角中心/出场角色/情绪）
    expect(mods.every((m) => m.role === 'system')).toBe(true);
    const sp = mods.filter((m) => m.enabled).map((m) => m.content).join('\n\n');
    expect(sp).not.toContain('<thinking>');            // 原生推理模型会被诱导弹标签
    expect(sp).not.toMatch(/\$\{/);                    // 预设展开会剥壳
    expect(sp.replace(/\{\{user\}\}/g, '')).not.toMatch(/\buser\b/i); // app 会把任意 user 换成主角名
    expect(/writing_process|<!--\s*梳理|梳理：/.test(sp)).toBe(true);  // 触发「预设要求先梳理」判定
  });

  // 防「在思考里先写一遍正文草稿、再审查后输出」（用户实测常见，浪费额度且成稿与草稿对不上）
  it('思维链模块：明确禁止在思考里写正文', () => {
    PSM.initDefaults();
    const mods = ((PSM.getPresets()[0] as unknown as { promptModules: Array<{ id: string; content: string; enabled: boolean }> }).promptModules);
    const cot = mods.find((m) => m.id === 'min_18_cot_full')!;
    expect(cot.enabled).toBe(true);
    expect(cot.content).toContain('思考里禁止写正文');
    expect(cot.content).toContain('正文只写这一次');
    expect(cot.content).toContain('不要写出那句话');   // 定结尾只写要点
    expect(cot.content).not.toContain('写多长都可以');
    const short = mods.find((m) => m.id === 'min_19_cot_short')!;
    expect(short.content).toContain('不要在思考里写正文或对白');
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
    expect(mod.content).toContain('破折号按《叙事规则》节制使用');   // 不与 min_04 的「破折号≤3 处」打架
    expect(mod.content).toContain('避免书面腔');
    expect(mod.content).not.toContain('视角');   // 视角只由 min_09..min_12 决定
    expect(mod.content).not.toContain('字数');

    // 老设备：模块内容还是旧文案 → 启动同步后换成新版
    const patch = MINIMAL_PRESET_PATCHES.find((x) => x.moduleId === 'min_05_style_kei')!;
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
    expect(ids.indexOf('min_09_pov_1')).toBe(ids.indexOf('min_20_ai_flavor') + 1);
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