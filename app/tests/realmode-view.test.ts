// 真实模式（real）视图骨架守卫（2026-09-28）：第三种模式的第三件事是把"线"接好——
// 侧栏入口、#tab-real 容器与全部固定 id、内联 on* 指向的调用点、切视图时的 init、
// 场景编辑弹窗与 UIManager 上的两个函数、globals 声明。
// 追加（扮演者不再固定在场景栏）：输入框上方 #realSpeakerRow（#realSpeakerSel「上帝模式 / 已加入的角色」+
// #realAddCharBtn「＋ 添加角色」）与选人弹窗 modalRealCast（候选=世界书「角色」条目，列表由
// RealMode._renderCastModal 渲染）。角色清单的业务逻辑在 domain/realmode.ts（另一条线）；
// 这里只做源码扫描（与 module-kind / real-mode-scaffold 同一套写法），不驱动 DOM：真页交互由端到端验收覆盖。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tabForView } from '../src/domain/mobile';

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const mobile = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'mobile.ts'), 'utf8');
const modals = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'modals.ts'), 'utf8');
const ui = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'ui.ts'), 'utf8');
const globals = fs.readFileSync(path.join(ROOT, 'app', 'src', 'globals.d.ts'), 'utf8');
const realmode = fs.readFileSync(path.join(ROOT, 'app', 'src', 'domain', 'realmode.ts'), 'utf8');

// 同事的 RealMode 按这些 id 取元素（不许改名）；漏一个就是"页面在、控件不在"
const REAL_IDS = [
  'realSceneBar', 'realSceneText', 'realSceneEditBtn',
  'realStream', 'realStatus',
  'realSpeakerRow', 'realSpeakerSel', 'realAddCharBtn',
  'realInput', 'realSendBtn', 'realStopBtn', 'realUndoBtn',
];

describe('真实模式：侧栏入口与 #tab-real 容器', () => {
  it('侧栏写作组有第三项 data-view="real"（与 chat 同级的 nav-sub）', () => {
    expect(html).toContain('data-view="real"');
    expect(html).toMatch(/class="nav-item nav-sub" data-view="real"/);
  });

  it('#tab-real 是 panel-tab 同级容器，固定 id 齐全', () => {
    expect(html).toContain('id="tab-real"');
    expect(html).toMatch(/class="panel-tab" id="tab-real"/);
    for (const id of REAL_IDS) {
      expect(html, '缺 id=' + id).toContain('id="' + id + '"');
    }
  });

  it('内联 on* 只指向 RealMode 的既有方法（send / stop / undoLast / select / openCast / openScene / refreshSendLabel）', () => {
    for (const call of [
      'RealMode.select(this.value)',
      'RealMode.openCast()',
      'RealMode.openScene()',
      'RealMode.refreshSendLabel()',
      'RealMode.send()',
      'RealMode.stop()',
      'RealMode.undoLast()',
    ]) {
      expect(html, '缺 ' + call).toContain(call);
    }
  });

  it('内心 / 壳两条新样式进样式区（其余复用 chat 的 class）', () => {
    expect(html).toContain('.real-inner{');
    expect(html).toContain('.real-shell{');
  });
});

describe('真实模式：扮演者下拉搬到输入框上方', () => {
  it('场景栏不再有 realPlayerSel（场景栏只剩场景文本 + 场景编辑）', () => {
    expect(html).not.toContain('realPlayerSel');
    expect(html).toContain('id="realSceneEditBtn"');
  });

  it('#realSpeakerRow 在 #realInputRow 之前（同一个输入条容器里）', () => {
    const row = html.indexOf('id="realSpeakerRow"');
    const input = html.indexOf('id="realInputRow"');
    expect(row).toBeGreaterThan(0);
    expect(input).toBeGreaterThan(row);
    expect(html).toContain('id="realSpeakerSel"');
    expect(html).toContain('id="realAddCharBtn"');
    expect(html).toContain('class="ghost-btn" type="button" onclick="RealMode.openCast()"');
    expect(html).toContain('title="把世界书里的角色加进来"');
  });

  it('这一行有自己的小 CSS（窄屏不撑破：下拉 flex:1;min-width:0）', () => {
    expect(html).toContain('#realSpeakerRow{');
    expect(html).toMatch(/#realSpeakerSel\{[^}]*flex:1;min-width:0/);
  });
});

describe('真实模式：视图映射与切换（mobile.ts）', () => {
  it('tabForView(real) → real', () => {
    expect(tabForView('real')).toBe('real');
    expect(mobile).toContain("real: 'real',");
  });

  it('switchView 切到 real 时初始化，且带存在性守卫（RealMode 未入库时不炸）', () => {
    expect(mobile).toMatch(/viewName === 'real'[\s\S]{0,160}typeof RealMode !== 'undefined'[\s\S]{0,80}RealMode\.init\(\)/);
  });
});

describe('真实模式：角色清单弹窗（modalRealCast）', () => {
  it('modals.ts 有 modalRealCast：候选下拉 + 添加按钮 + 已加入列表 + 关闭', () => {
    expect(modals).toContain('modalRealCast');
    expect(modals).toContain('id="realCastSel"');
    expect(modals).toContain('id="realCastList"');
    expect(modals).toContain('RealMode.addCastFromModal()');
    expect(modals).toContain("UIManager.closeModal('modalRealCast')");
    // 顶部灰字说明（口径：加进来 → 输入框上方随时切；上帝模式 = 不发言、只推进）
    expect(modals).toContain('把世界书里的角色加进来');
    expect(modals).toContain('上帝模式');
  });

  it('切换与移除的两个调用点：RealMode.select（输入框上方）与 RealMode.removeCast（弹窗列表行）', () => {
    expect(modals).toContain('RealMode.select');
    expect(modals).toContain('RealMode.removeCast');
    expect(html).toContain('RealMode.select(this.value)');
    expect(realmode).toContain('removeCast(');
  });
});

describe('真实模式：场景编辑弹窗与保存', () => {
  it('modals.ts 有 modalRealScene 与时间 / 地点 / 在场三个字段', () => {
    expect(modals).toContain('modalRealScene');
    expect(modals).toContain('id="realSceneTime"');
    expect(modals).toContain('id="realScenePlace"');
    expect(modals).toContain('id="realScenePresent"');
    expect(modals).toContain("UIManager.closeModal('modalRealScene')");
    expect(modals).toContain('UIManager.saveRealScene()');
  });

  it('ui.ts 挂了 openRealScene / saveRealScene（读 sceneInfo、写 saveScene）', () => {
    expect(ui).toContain('openRealScene()');
    expect(ui).toContain('saveRealScene()');
    expect(ui).toContain('RealMode.sceneInfo()');
    expect(ui).toContain('RealMode.saveScene(');
    // 弹窗不在时也要能关（关弹窗不依赖逻辑层就绪）
    expect(ui).toContain("this.closeModal('modalRealScene')");
  });

  it('globals.d.ts 声明了 RealMode（内联 on* 与切页钩子按全局访问）', () => {
    expect(globals).toContain('declare const RealMode');
  });
});
