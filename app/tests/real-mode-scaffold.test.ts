// 真实模式（real）脚手架守卫（2026-09-28）：第三种模式刚建立，本次只落"脚手架"——
// 模式枚举与门控、模块编辑器下拉/标签、世界书「初始记忆」类型与绑定校验。
// 用源码扫描 + 纯函数直测（与 module-kind / preset 两个测试同一套写法），不驱动 DOM：
// 生成链、注入行为、真页交互都不在本次范围内。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  moduleAppliesTo, moduleMode, pickModules, nativeModulesToModules,
  THINK_TAIL_FALLBACK, MINIMAL_PRESET_MODULES, MINIMAL_PRESET_LATE_MODULES_V5,
} from '../src/domain/preset';

const ROOT = path.resolve(__dirname, '..', '..');
const presetSrc = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'preset.ts'), 'utf8');
const modals = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'modals.ts'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'ui.ts'), 'utf8');
const worldbook = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'worldbook.ts'), 'utf8');

describe('真实模式（real）：模式枚举与门控', () => {
  it('预设模块编辑器的「适用模式」下拉含 real / 仅真实', () => {
    expect(modals).toContain('<option value="real">仅真实</option>');
  });

  it('模块列表标签含「仅真实」（与 ·仅续写 / ·仅演出 同一处）', () => {
    expect(ui).toContain("m.mode === 'real' ? '·仅真实'");
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
  it('migrateEntryTypes 白名单含「初始记忆」（否则下次启动被改写成「其他」）', () => {
    expect(worldbook).toContain("const KEEP = ['世界观', '角色', '初始', '初始记忆', '其他', '变量'];");
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
