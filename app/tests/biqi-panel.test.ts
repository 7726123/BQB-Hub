// 比奇面板：下边缘胶囊拖动改高度 + 输入中占满可视区（用户实测反馈的两个问题）。
//   · 半屏窗是顶边锚定的，绝对定位在 #editor-wrap 里；键盘弹出时 WebView 被 adjustResize 压低 →
//     容器变矮 → height:50% 跟着变矮 → 列表(flex:1) 被挤到几乎 0（"内容被折叠、看不到上下文"）。
//     修法：输入框聚焦时给面板加 .kb-open（高度 100% = 键盘以上的可视区），失焦还原。
//   · 拖动范围 25%~90%，拖过 90% 吸附整屏；比例不持久化，每次开窗回到半屏。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/infra/storage';
import { PluginManager } from '../src/domain/plugins';
import { MobileUI } from '../src/domain/mobile';
import {
  BiqiAgent, biqiResolveDrag,
  BIQI_MIN_RATIO, BIQI_MAX_RATIO, BIQI_SNAP_RATIO, BIQI_UNSNAP_RATIO, BIQI_DEFAULT_RATIO
} from '../src/domain/biqi';

const g = globalThis as unknown as Record<string, any>;

// ---- 迷你 DOM：classList / style / clientHeight 都要真行为（被测的就是这些）----
function makeEl(id: string, parent: any = null): any {
  const classes = new Set<string>();
  const listeners: Record<string, ((e: any) => void)[]> = {};
  const el: any = {
    id, parentElement: parent, style: {}, clientHeight: 0, scrollTop: 0, scrollHeight: 100, innerHTML: '',
    classList: {
      add: (...cs: string[]) => cs.forEach((c) => classes.add(c)),
      remove: (...cs: string[]) => cs.forEach((c) => classes.delete(c)),
      toggle: (c: string, on?: boolean) => { const v = on === undefined ? !classes.has(c) : !!on; if (v) classes.add(c); else classes.delete(c); return v; },
      contains: (c: string) => classes.has(c),
    },
    addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: () => undefined,
    focus: () => undefined,
    // 挪面板要用（panelHost）：把子节点从旧父节点摘下来挂到新父节点
    appendChild: (child: any) => {
      const old = child.parentElement;
      if (old && Array.isArray(old._children)) { const i = old._children.indexOf(child); if (i >= 0) old._children.splice(i, 1); }
      child.parentElement = el;
      if (!Array.isArray(el._children)) el._children = [];
      el._children.push(child);
      return child;
    },
    _children: [],
    _classes: classes,
    _fire: (t: string, e: any = {}) => (listeners[t] || []).forEach((fn) => fn(e)),
  };
  return el;
}

const els: Record<string, any> = {};
function setupDom() {
  for (const k of Object.keys(els)) delete els[k];
  const wrap = makeEl('editor-wrap');
  const panel = makeEl('biqiPanel', wrap);
  const grip = makeEl('biqiGrip', panel);
  const input = makeEl('biqiInput', panel);
  wrap.clientHeight = 800;                       // 常态容器高
  els['editor-wrap'] = wrap; els['biqiPanel'] = panel; els['biqiGrip'] = grip; els['biqiInput'] = input;
  els['biqiMessages'] = makeEl('biqiMessages', panel);
  els['biqiToolbarBtn'] = makeEl('biqiToolbarBtn');
  g.document = {
    getElementById: (id: string) => els[id] || null,
    addEventListener: (t: string, fn: (e: any) => void) => { (g._docListeners ||= {}); (g._docListeners[t] ||= []).push(fn); },
    removeEventListener: (t: string, fn: (e: any) => void) => {
      const list = (g._docListeners || {})[t] || [];
      const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1);
    },
  };
  g._docListeners = {};
  const fireDoc = (t: string, e: any) => ((g._docListeners || {})[t] || []).slice().forEach((fn: any) => fn(e));
  return { wrap, panel, grip, input, fireDoc };
}

beforeEach(() => {
  g.App = { toast: () => undefined };
  g.WorldBookManager = { getActiveId: () => 'wb1' };
  // 顺序要紧：先装内存版 StorageManager，再 setEnabled——isEnabled() 读的是 SM()，
  // 装反了会写成"开"，读到的却是空（首轮就是踩了这个 → open() 直接提前返回）。
  (globalThis as unknown as { StorageManager: any }).StorageManager = {
    _m: new Map<string, string>(),
    get(k: string, d?: any) { return this._m.has(k) ? JSON.parse(this._m.get(k)) : d; },
    set(k: string, v: any) { this._m.set(k, JSON.stringify(v)); },
    remove(k: string) { this._m.delete(k); },
  };
  // biqi.ts 里 isEnabled() 走的是模块导入的 PluginManager（不是全局），必须用真的 setEnabled
  PluginManager.setEnabled('biqi', true);
  BiqiAgent.messages = [];
  BiqiAgent._open = false;
});

describe('biqiResolveDrag：拖动比例与整屏吸附（纯函数）', () => {
  it('常态下跟随手指位移（容器 800px，往下拖 160px → 0.5→0.7）', () => {
    const r = biqiResolveDrag(0.5, false, 160, 800);
    expect(r.ratio).toBeCloseTo(0.7, 5);
    expect(r.snapped).toBe(false);
  });

  it('下限 25%：一直往上拖也不会更矮', () => {
    expect(biqiResolveDrag(0.3, false, -400, 800).ratio).toBe(BIQI_MIN_RATIO);
  });

  it('拖过 90% 吸附整屏', () => {
    const r = biqiResolveDrag(0.85, false, 80, 800);      // 0.85 + 0.1 = 0.95 > 0.90
    expect(r.snapped).toBe(true);
    expect(r.ratio).toBe(BIQI_MAX_RATIO);                 // 记住回退用的常态上限
  });

  it('整屏后往回拖：位移小于 2% 回差仍保持整屏，超过才解除吸附并跟随手指', () => {
    expect(biqiResolveDrag(BIQI_MAX_RATIO, true, -8, 800).snapped).toBe(true);       // 1 - 0.01 > 0.88
    const back = biqiResolveDrag(BIQI_MAX_RATIO, true, -160, 800);                   // 1 - 0.2 = 0.8 < 0.88
    expect(back.snapped).toBe(false);
    expect(back.ratio).toBeCloseTo(0.8, 5);
  });

  it('刚好在阈值上：0.90 不吸附（要"拖过"），解除阈值比吸附阈值低（防抖）', () => {
    expect(biqiResolveDrag(0.8, false, 80, 800).snapped).toBe(false);                // 正好 0.90
    expect(BIQI_UNSNAP_RATIO).toBeLessThan(BIQI_SNAP_RATIO);
  });

  it('容器高度为 0 / 位移非有限：原样返回，不产生 NaN', () => {
    expect(biqiResolveDrag(0.5, false, 100, 0)).toEqual({ ratio: 0.5, snapped: false });
    const nan = biqiResolveDrag(0.5, false, NaN, 800);
    expect(Number.isFinite(nan.ratio)).toBe(true);
    expect(nan.ratio).toBe(0.5);
  });
});

describe('比奇面板：DOM 行为', () => {
  it('开窗回到半屏（比例不持久化），胶囊与输入框已绑定', () => {
    const { panel } = setupDom();
    BiqiAgent.open();
    expect(panel._classes.has('open')).toBe(true);
    expect(BiqiAgent._ratio).toBe(BIQI_DEFAULT_RATIO);
    expect(panel.style.height).toBe('50%');
    expect(panel.classList.contains('full')).toBe(false);
  });

  it('拖动胶囊改高度；拖过 90% 变整屏并挂 full；往回拖解除', () => {
    const { panel, grip, fireDoc } = setupDom();
    BiqiAgent.open();
    grip._fire('pointerdown', { clientY: 100, preventDefault: () => undefined });
    fireDoc('pointermove', { clientY: 260 });            // +160px / 800 = +0.2
    expect(panel.style.height).toBe('70%');
    fireDoc('pointermove', { clientY: 500 });            // +400px = +0.5 → 1.0 → 吸附
    expect(panel.style.height).toBe('100%');
    expect(panel.classList.contains('full')).toBe(true);
    // 往回拖过解除阈值：以手指当前位置重新起算 → 先落回 90%（不跳一截），再跟着手指继续变矮
    fireDoc('pointermove', { clientY: 200 });
    expect(panel.classList.contains('full')).toBe(false);
    expect(panel.style.height).toBe('90%');
    fireDoc('pointermove', { clientY: 150 });            // -50px / 800 ≈ -0.0625 → 83.75% → 84%
    expect(panel.style.height).toBe('84%');
    fireDoc('pointerup', {});
    // 松手后再移动不应再改高度
    fireDoc('pointermove', { clientY: 700 });
    expect(panel.style.height).toBe('84%');
  });

  it('输入框聚焦 → 占满可视区（kb-open 且清掉内联高度，让位给 CSS）+ 滚到底', () => {
    const { panel, input } = setupDom();
    BiqiAgent.open();
    expect(panel.style.height).toBe('50%');
    input._fire('focus');
    expect(panel.classList.contains('kb-open')).toBe(true);
    expect(panel.style.height).toBe('');                 // 内联高度让位，CSS .kb-open{height:100%} 生效
    expect(els['biqiMessages'].scrollTop).toBe(els['biqiMessages'].scrollHeight);
    input._fire('blur');
    expect(panel.classList.contains('kb-open')).toBe(false);
    expect(panel.style.height).toBe('50%');              // 失焦还原到用户拖出来的比例
  });

  it('输入中拖动胶囊无效（高度归键盘模式管）', () => {
    const { panel, grip } = setupDom();
    BiqiAgent.open();
    els['biqiInput']._fire('focus');
    grip._fire('pointerdown', { clientY: 100, preventDefault: () => undefined });
    expect(BiqiAgent._snapped).toBe(false);
    expect(panel.style.height).toBe('');
  });

  it('关窗清掉 open/kb-open/full 三个状态；再开窗仍是半屏', () => {
    const { panel, grip, fireDoc } = setupDom();
    BiqiAgent.open();
    grip._fire('pointerdown', { clientY: 100, preventDefault: () => undefined });
    fireDoc('pointermove', { clientY: 500 });            // 整屏
    els['biqiInput']._fire('focus');
    BiqiAgent.close();
    expect(panel._classes.has('open')).toBe(false);
    expect(panel._classes.has('kb-open')).toBe(false);
    expect(panel._classes.has('full')).toBe(false);
    BiqiAgent.open();
    expect(BiqiAgent._snapped).toBe(false);
    expect(panel.style.height).toBe('50%');
  });

  it('插件被关掉时 render() 一并收回面板与状态类', () => {
    const { panel } = setupDom();
    BiqiAgent.open();
    els['biqiInput']._fire('focus');
    PluginManager.setEnabled('biqi', false);
    BiqiAgent.render();
    expect(panel._classes.has('open')).toBe(false);
    expect(panel._classes.has('kb-open')).toBe(false);
  });

  it('拖动跟手：连续 pointermove 与手指位移 1:1（回归：基准比例被每帧重置 → 位移算重、越拖越快）', () => {
    const { grip, panel, wrap, fireDoc } = setupDom();
    wrap.clientHeight = 800;
    BiqiAgent._ratio = 0.5; BiqiAgent._snapped = false; BiqiAgent._kbOpen = false;
    BiqiAgent.open();
    grip._fire('pointerdown', { clientY: 100, preventDefault: () => undefined });
    fireDoc('pointermove', { clientY: 180 });   // +80px = 容器 10% → 0.50 + 0.10
    expect(panel.style.height).toBe('60%');
    fireDoc('pointermove', { clientY: 260 });   // 累计 +160px = 20% → 0.70（算重的话会到 80% 以上）
    expect(panel.style.height).toBe('70%');
    fireDoc('pointermove', { clientY: 340 });   // 累计 +240px = 30% → 0.80
    expect(panel.style.height).toBe('80%');
    fireDoc('pointermove', { clientY: 440 });   // 累计 +340px = 42.5% → r=0.925 > 0.90 → 吸附整屏
    expect(panel.style.height).toBe('100%');
    expect(panel._classes.has('full')).toBe(true);
    fireDoc('pointermove', { clientY: 320 });   // 上拖 120px = 15% → r=0.85 < 0.88 → 解除吸附（回到 90% 基准）
    expect(panel.style.height).toBe('90%');
    fireDoc('pointermove', { clientY: 240 });   // 再上拖 80px = 10%：与手指 1:1 → 0.90-0.10 = 80%（算重会到 70%）
    expect(panel.style.height).toBe('80%');
    fireDoc('pointerup', {});
  });
  it('开窗不自动聚焦输入框（真机反馈：聚焦会进输入中模式 → 开窗即整屏，与「半屏 + 可拖 25%~90%」冲突）', () => {
    const { panel, input } = setupDom();
    input.focus = () => input._fire('focus');   // 模拟真实聚焦：迷你 DOM 默认 focus 是空操作，上一轮正是因此漏判了这个 bug
    BiqiAgent.messages = [];
    BiqiAgent.open();
    expect(panel._classes.has('kb-open')).toBe(false);
    expect(panel.style.height).toBe('50%');
  });

  it('切视图时面板跟着挪：进对话页挂到对话页宿主，切回写作挂回正文区（真机反馈的回归：只在非写作视图里挪过一次 → 小说模式点开看不见）', () => {
    const wrap = makeEl('editor-wrap');
    const chatBody = makeEl('chatBody');
    const bpanel = makeEl('biqiPanel', wrap);
    const navWriting = makeEl('navWriting'); navWriting.dataset = { view: 'writing' };
    els['editor-wrap'] = wrap; els['chatBody'] = chatBody; els['biqiPanel'] = bpanel; els['navWriting'] = navWriting;
    els['editor-area'] = makeEl('editor-area'); els['panel'] = makeEl('panel');
    g.document.querySelectorAll = () => [];   // switchView 里的导航/tab 查询：本用例不需要
    g.document.querySelector = () => null;
    (MobileUI as any).switchView('chat');
    expect(bpanel.parentElement).toBe(chatBody);
    (MobileUI as any).switchView('writing');
    expect(bpanel.parentElement).toBe(wrap);  // bug 就是这一步没发生（面板留在了隐藏的对话页里）
  });
  it('面板元素缺失时全部降级不抛错（元素被删/测试环境）', () => {
    g.document = { getElementById: () => null, addEventListener: () => undefined, removeEventListener: () => undefined };
    expect(() => { BiqiAgent.open(); BiqiAgent._setKbMode(true); BiqiAgent._applyHeight(); BiqiAgent._bindPanel(); }).not.toThrow();
  });
});
