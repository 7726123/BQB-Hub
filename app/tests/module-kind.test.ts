// 模块「类型」守卫（2026-09-26 晚）：类型名就是模块的去处——system / user（思维链），
// 不再用「非思维链（默认）」「末尾模块（导入的酒馆用户条目）」这类按"思考语义"起的名字
// （那种叫法把位置藏起来了：多数酒馆预设的条目都在 system 侧，用户看着下拉不知道选哪个）。
// 三处必须一致：编辑弹窗的下拉、列表里的标签、kind→role/slot 的落盘映射。
// 用源码扫描而不是 DOM 驱动：这三处都是纯字符串/一次性映射，DOM 桩的成本远高于收益，
// 端到端行为由真页验收覆盖（模块列表标签 + 编辑保存后的 role/slot）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const modals = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'modals.ts'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'ui.ts'), 'utf8');

describe('模块类型（system / user）', () => {
  it('编辑弹窗：常态两项 = system + user（思维链），并写明位置与思考开关', () => {
    expect(modals).toContain('<option value="system">system</option>');
    expect(modals).toContain('<option value="user_think">user（思维链）</option>');
    // 引导文案：位置由软件负责 + user 槽讲思考要求 + 关闭思考时跳过
    expect(modals).toContain('最前面的系统提示词');
    expect(modals).toContain('最后一条用户消息的末尾');
    expect(modals).toContain('思考强度设为关闭');
    // 旧标签（把位置藏起来、只讲思考语义）不得回归
    expect(modals).not.toContain('非思维链（默认）');
    expect(modals).not.toContain('末尾模块（导入的酒馆用户条目）');
  });

  it('导入的酒馆 user 条目（role=user 且没有 slot）单列一项，编辑一次不会静默改位置', () => {
    expect(ui).toContain('<option value="user_tail">user（末尾·非思维链）</option>');
    expect(ui).toContain("kindSel.value = isTail ? (isThink ? 'user_think' : 'user_tail') : 'system';");
  });

  it('kind → role/slot：只有 user_think 打 slot=think（user_tail 不能在关思考时被跳过）', () => {
    expect(ui).toContain("m.role = (kind === 'user_think' || kind === 'user_tail') ? 'user' : 'system';");
    expect(ui).toContain("if (kind === 'user_think') m.slot = 'think'; else delete m.slot;");
  });

  it('列表标签与类型名同一套词（system / user·思维链 / user·末尾）', () => {
    expect(ui).toContain("_think ? 'user·思维链' : 'user·末尾'");
    expect(ui).not.toContain('末尾·导入');
  });
});
