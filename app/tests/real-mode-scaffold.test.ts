// 真实模式（real）脚手架守卫（2026-09-28）：第三种模式刚建立，本次只落"脚手架"——
// 模式枚举与门控、模块编辑器下拉/标签、世界书「初始记忆」类型与绑定校验。
// 用源码扫描 + 纯函数直测（与 module-kind / preset 两个测试同一套写法），不驱动 DOM：
// 生成链、注入行为、真页交互都不在本次范围内。
//
// 2026-10-08 追加：真实模式收进管理员模式（入口 / 世界书条目类型 / 预设选项 / 手册 / 写卡预设）
// ——本节末尾的「只在管理员模式里开放」一组守卫就是这次的门闩。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  moduleAppliesTo, moduleMode, pickModules, nativeModulesToModules,
  THINK_TAIL_FALLBACK, MINIMAL_PRESET_MODULES, MINIMAL_PRESET_LATE_MODULES_V5,
} from '../src/domain/preset';
import { manualForViewer, USAGE_MANUAL } from '../src/domain/assistant';
import { visibleEntriesFor } from '../src/domain/ui';
import { stripRealModeGuidance } from '../src/domain/cardwriter';
import { __setEditionForTest } from '../src/lib/edition';

const ROOT = path.resolve(__dirname, '..', '..');
const presetSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'preset.ts'), 'utf8');
const modals = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'modals.ts'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'ui.ts'), 'utf8');
const worldbook = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'worldbook.ts'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const realmodeSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'realmode.ts'), 'utf8');
const adminmodeSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'adminmode.ts'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'app.ts'), 'utf8');
const cardwriterSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'cardwriter.ts'), 'utf8');
const biqiSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'biqi.ts'), 'utf8');
const communitySrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'community.ts'), 'utf8');

describe('真实模式（real）：模式枚举与门控', () => {
  it('预设模块编辑器的「适用模式」下拉含 real / 仅真实', () => {
    expect(modals).toContain('<option value="real">仅真实</option>');
  });

  it('模块列表标签含「仅真实」（与 ·仅续写 / ·仅对话 同一处）', () => {
    expect(ui).toContain("m.mode === 'real' ? '·仅真实'");
  });

  // 2026-10-09 用户要求：预设里不出现"演出模式"这个叫法——模式一律叫「对话」（与侧栏「对话模式」一致）
  it('「适用模式」下拉与模块标签都用「对话」：不出现"演出模式" / "·仅演出"', () => {
    expect(modals).toContain('<option value="chat">只用在对话模式</option>');
    expect(modals).toContain('<option value="both">续写 + 对话都用</option>');
    expect(modals).not.toContain('演出模式');
    expect(ui).toContain("m.mode === 'chat' ? '·仅对话'");
    expect(ui).not.toContain('·仅演出');
  });

  it('moduleMode / moduleAppliesTo：real 是合法模式，门控与 novel/chat 一致', () => {
    expect(moduleMode({ mode: 'real' })).toBe('real');
    expect(moduleMode({ mode: 'bogus' })).toBe('both');
    // real 模块只对 real 生效
    expect(moduleAppliesTo({ mode: 'real' }, 'real')).toBe(true);
    expect(moduleAppliesTo({ mode: 'real' }, 'novel')).toBe(false);
    expect(moduleAppliesTo({ mode: 'real' }, 'chat')).toBe(false);
    // both（含缺省）对续写/演出生效；**对真实模式不生效**（真实模式只吃显式标了 real 的模块，
    // 否则导入的小说/群像预设会被整套注进去，把"一轮只扮演一个人"盖掉——2026-09-28 用户实测）
    for (const mode of ['novel', 'chat'] as const) {
      expect(moduleAppliesTo({ mode: 'both' }, mode)).toBe(true);
      expect(moduleAppliesTo({}, mode)).toBe(true);
    }
    expect(moduleAppliesTo({ mode: 'both' }, 'real')).toBe(false);
    expect(moduleAppliesTo({}, 'real')).toBe(false);
    // novel/chat 模块对 real 不生效
    expect(moduleAppliesTo({ mode: 'novel' }, 'real')).toBe(false);
    expect(moduleAppliesTo({ mode: 'chat' }, 'real')).toBe(false);
  });

  it('pickModules(mods, "real")：只选 mode=real 的（both 不进真实模式），按 order 排序', () => {
    const mods = [
      { id: 'n', enabled: true, content: 'n', mode: 'novel', order: 0 },
      { id: 'r2', enabled: true, content: 'r2', mode: 'real', order: 5 },
      { id: 'b', enabled: true, content: 'b', mode: 'both', order: 2 },
      { id: 'c', enabled: true, content: 'c', mode: 'chat', order: 1 },
      { id: 'off', enabled: false, content: 'off', mode: 'real', order: 3 },   // 关掉的不算
    ];
    expect(pickModules(mods, 'real').map((m: any) => m.id)).toEqual(['r2']);
    expect(pickModules(mods, 'novel').map((m: any) => m.id)).toEqual(['n', 'b']);   // 续写照旧吃 both
    expect(mods.map((m) => m.id)).toEqual(['n', 'r2', 'b', 'c', 'off']);   // 不改动入参数组
  });

  it('THINK_TAIL_FALLBACK.real 存在且非空；内置 real 尾部模块字段齐全', () => {
    expect(typeof THINK_TAIL_FALLBACK.real).toBe('string');
    expect(THINK_TAIL_FALLBACK.real.trim().length).toBeGreaterThan(0);
    const mod = MINIMAL_PRESET_MODULES.find((m) => m.id === 'min_27_think_tail_real')!;
    expect(mod).toBeTruthy();
    expect([mod.role, mod.mode, mod.slot, mod.enabled]).toEqual(['user', 'real', 'think', true]);
    expect(mod.content).toBe(THINK_TAIL_FALLBACK.real);   // 兜底 = 出厂模块那一条
  });

  it('V5 补装批次挂上 real 尾部模块（存量设备的 V4 标记已置位，必须用新批次键）', () => {
    expect(MINIMAL_PRESET_LATE_MODULES_V5.some((e) => e.id === 'min_27_think_tail_real')).toBe(true);
    expect(presetSrc).toContain("minimalPresetLateModulesV5");
  });

  it('nativeModulesToModules：mode=real 透传，未知值忽略（保持对象形状）', () => {
    const out = nativeModulesToModules([
      { content: '真实', role: 'user', mode: 'real', slot: 'think' },
      { content: '未知', role: 'system', mode: 'nonsense' },
    ]);
    expect(out[0].mode).toBe('real');
    expect('mode' in out[1]).toBe(false);
  });
});

describe('世界书：初始记忆类型与绑定角色', () => {
  it('migrateEntryTypes 白名单含「初始记忆」「部分人知道」（否则下次启动被改写成「其他」）', () => {
    expect(worldbook).toContain("const KEEP = ['世界观', '角色', '初始', '初始记忆', '部分人知道', '其他', '变量'];");
  });

  it('条目编辑器类型下拉含「初始记忆」', () => {
    expect(modals).toContain('<option>初始记忆</option>');
  });

  it('绑定角色下拉：编辑区一行，选项 = 当前书里的角色条目（显示条目名）', () => {
    expect(modals).toContain('id="wbEntryBindRow"');
    expect(modals).toContain('id="wbEntryBindId"');
    // 出现/填充逻辑在 toggleWBEntryFields：按 type='角色' 过滤，用条目名做选项文字
    expect(ui).toContain("type === '初始记忆' ? '' : 'none'");
    expect(ui).toContain("entries.filter(function (e) { return e.type === '角色'; })");
    expect(ui).toContain("htmlEscape(e.name || '未命名')");
  });

  it('bindId / bindName 落盘（切换回其它类型不清除，保存只写不删）', () => {
    expect(ui).toContain('data.bindId = bindId;');
    expect(ui).toContain('data.bindName = bindName;');
    // 只在 type=初始记忆 时写：非该类型走原路径，已有字段不会被清掉（updateEntry 是合并写）
    expect(ui).toContain("if (data.type === '初始记忆') {");
  });

  it('1 对 1 校验：同一角色已有另一条初始记忆 → toast 并拒绝保存（不覆盖）', () => {
    // 查重条件：排除自己（editId）、type=初始记忆、绑定命中（bindId 相同，或 bindName 兜底
    // ——绑定字段可能被老版本的 addEntry 丢过，只按 bindId 查会漏）
    expect(ui).toContain("e.id !== editId && e.type === '初始记忆'");
    expect(ui).toContain('(e as any).bindId === bindId || sameName');
    expect(ui).toContain('已经有初始记忆了，一条只能绑一个角色');
    // 命中重复时先 return（拒绝保存），不会走到写 bindId 的那两行
    const toastAt = ui.indexOf('已经有初始记忆了，一条只能绑一个角色');
    expect(toastAt).toBeGreaterThan(0);
    expect(ui.indexOf('data.bindId = bindId;')).toBeGreaterThan(toastAt);
  });
});

// 2026-10-08：真实模式收进管理员模式。普通用户看不到入口、建不了真实模式专用的条目、
// 手册与写卡 agent 也不提它；管理员模式一开全部原样回来（数据一步都没动）。
describe('真实模式：只在管理员模式里开放（2026-10-08）', () => {
  it('侧栏入口出厂隐藏，由 RealMode.syncEntry() 按管理员模式放出来；退出时退回写作页', () => {
    expect(html).toMatch(/data-view="real" id="navRealBtn" style="display:none"/);
    expect(realmodeSrc).toContain('syncEntry(): void {');
    expect(realmodeSrc).toContain("const nav = el('navRealBtn');");
    expect(realmodeSrc).toContain('AdminMode.isOn()');
    expect(realmodeSrc).toContain('UIManager?.syncRealModeUI?.()');
    // 正停在真实页时关掉管理员模式 → 退回写作页（别留一个打不开的空页）
    expect(realmodeSrc).toContain("MobileUI.switchView('writing')");
  });

  it('开关一翻就联动（与「管理」入口同一条规矩），冷启动也同步一次', () => {
    expect(adminmodeSrc).toContain('RM.syncEntry');
    expect(adminmodeSrc).toContain('RealMode');
    expect(appSrc).toContain('RealMode.syncEntry');
  });

  it('世界书：类型下拉的两项按管理员模式增删；列表/书架/换书下拉都走 visibleEntriesFor', () => {
    // 出厂 HTML 仍带全部 7 类（modals.ts 静态），由 ui.ts 在运行时增删
    expect(modals).toContain('<option>初始记忆</option>');
    expect(modals).toContain('<option>部分人知道</option>');
    expect(ui).toContain('function syncWbEntryTypeOptions(');
    expect(ui).toContain("const ALL = ['世界观', '角色', '初始', '初始记忆', '部分人知道', '其他', '变量'];");
    expect(ui).toContain('syncWbEntryTypeOptions();   // 类型下拉按管理员模式刷新一次');
    // 三处计数/列表同口径
    expect(ui).toContain('const visible = visibleEntriesFor(wb ? (wb.entries || []) : []);');
    expect(ui).toContain('const cnt = visibleEntriesFor(wb.entries || []).length;');
    // 变量页那类"注入 N/M 条"的分母也不含它们（它们对小说/对话本来就不注入）
    expect(ui).toContain("REAL_ONLY_ENTRY_TYPES.indexOf(String(e.type || '')) < 0");
    // 统一刷新入口
    expect(ui).toContain('syncRealModeUI()');
  });

  it('visibleEntriesFor：普通用户看不到真实模式条目，系统版（管理员模式）全看；原数组一个字不动', () => {
    const entries = [
      { id: 'a', type: '角色', name: '千纱' },
      { id: 'b', type: '初始记忆', name: '千纱的开局' },
      { id: 'c', type: '部分人知道', name: '两人初中就认识' },
      { id: 'd', type: '世界观', name: '世界背景' },
    ];
    try {
      __setEditionForTest('normal');
      expect(visibleEntriesFor(entries).map((e: any) => e.id)).toEqual(['a', 'd']);
      __setEditionForTest('system', 'k-test');
      expect(visibleEntriesFor(entries).map((e: any) => e.id)).toEqual(['a', 'b', 'c', 'd']);
    } finally {
      __setEditionForTest('normal');
    }
    expect(entries.length).toBe(4);
  });

  it('预设：模块列表与「适用模式」下拉里的「仅真实」只在管理员模式里出现', () => {
    expect(ui).toContain("if (!_admin && m.mode === 'real') return;");
    // 过滤后 data-drag-idx 仍是全数组下标（否则拖动排序会串位）
    expect(ui).toContain('data-drag-idx="\' + i + \'"');
    expect(ui).toContain('function syncModuleModeOptions(');
    expect(ui).toContain("o.value = 'real'; o.text = '仅真实';");
    expect(ui).toContain('syncModuleModeOptions();   // 「仅真实」只在管理员模式里出现');
    // 数据层不动：real 仍是合法模式（管理员自己的模块照旧生效）
    expect(moduleMode({ mode: 'real' })).toBe('real');
    expect(pickModules([{ id: 'r', enabled: true, content: 'r', mode: 'real', order: 0 }], 'real').length).toBe(1);
  });

  it('使用助手手册：普通用户那份没有真实模式一节，管理员那份原样', () => {
    const user = manualForViewer(false);
    const admin = manualForViewer(true);
    expect(admin).toBe(USAGE_MANUAL);
    expect(admin).toContain('十七、真实模式（多角色各自独立记忆的演出）');
    expect(user).not.toContain('真实模式');
    expect(user).not.toContain('初始记忆');
    expect(user).not.toContain('部分人知道');
    // 其余小节逐字还在（整节删，不是重写手册）
    expect(user).toContain('十四、对话模式');
    expect(user).toContain('十六、写预设');
    expect(user).toContain('十八、生图（画图主机）');
    expect(user.split('\n')[0]).toBe(USAGE_MANUAL.split('\n')[0]);
    // 定位那一句（2026-10-08 改 Role Play）两版都在——它讲的是"这软件是什么"，与模式无关
    expect(user).toContain('AI 角色扮演（Role Play）工作台');
    expect(admin).toContain('AI 角色扮演（Role Play）工作台');
    // 缩进/emoji 之类的杂项：行数只少了真实模式那一节
    expect(USAGE_MANUAL.split('\n').length - user.split('\n').length).toBeGreaterThan(5);
  });

  it('写卡预设：base 里的真实模式段只发给管理员（存量副本、用户改过标题的都删得掉）', () => {
    const base = '【写卡基础指令】\n- 甲\n'
      + '【如果这本书以后还要用「真实模式」】（多角色各自独立记忆的演出）\n'
      + '- 秘密、隐情写进「初始记忆」\n'
      + '【写卡方法论】\n- 乙\n';
    const out = stripRealModeGuidance(base);
    expect(out).not.toContain('真实模式');
    expect(out).not.toContain('初始记忆');
    expect(out).toContain('【写卡基础指令】');
    expect(out).toContain('【写卡方法论】');
    expect(stripRealModeGuidance(out)).toBe(out);   // 幂等
    // 段落在末尾（后面没有别的分块）也删得掉
    expect(stripRealModeGuidance('【写卡基础指令】\n- 甲\n【如果这本书以后还要用「真实模式」】\n- x\n')).not.toContain('真实模式');
    // 出厂文案：段落收在一个 const 里，普通用户那份由 _composePresetText 现删
    expect(cardwriterSrc).toContain('const REAL_MODE_GUIDANCE =');
    expect(cardwriterSrc).toContain('stripRealModeGuidance(blocks.base ||');
    // 写卡草稿列表也不给普通用户看真实模式条目（但草稿数组原样保留，写回时不会丢）
    expect(cardwriterSrc).toContain('REAL_ONLY_ENTRY_TYPES.indexOf');
  });

  it('条目类型名单只有一处（worldbook.ts），界面各处引用同一份', () => {
    expect(worldbook).toContain("export const REAL_ONLY_ENTRY_TYPES = ['初始记忆', '部分人知道'];");
    expect(ui).toContain('REAL_ONLY_ENTRY_TYPES');
    expect(cardwriterSrc).toContain('REAL_ONLY_ENTRY_TYPES');
    // 比奇读世界书（read_worldbook 工具）也同口径：读到的不比用户看到的多
    expect(biqiSrc).toContain('REAL_ONLY_ENTRY_TYPES');
    expect(biqiSrc).toContain('if (!AdminMode.isOn())');
  });

  it('社区：上传 / 卡片预览 / 导入都按可见集合走（看不见的内容不会被悄悄分享或塞进书里）', () => {
    expect(communitySrc).toContain("import { visibleEntriesFor } from './ui';");
    expect(communitySrc).toContain('entries: visibleEntriesFor(wb.entries || []),');
    expect(communitySrc).toContain('entries = visibleEntriesFor(Array.isArray(entries) ? entries : []);');   // 卡片预览
    // 两处导入（卡下载 / 助手 import_card）也过滤
    expect((communitySrc.match(/visibleEntriesFor\(Array\.isArray\(data\.entries\) \? data\.entries : \[\]\)/g) || []).length).toBe(2);
  });
});
