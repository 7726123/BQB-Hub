// 看图缩放（2026-10-06）：点开大图后能放大看细节。
// 覆盖：纯数学（fit/clamp/zoomAt）+ 手势接线（双击 / 双指捏合 / 拖动平移 / 滚轮 / 徽标切换 / 单击关闭）。
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { viewerFitScale, viewerClampPan, viewerZoomAt } from '../src/domain/ui';
import '../src/domain/ui';   // 只为副作用：模块尾部把 UIManager 挂到 globalThis（对象本身没有 export）

// 迷你 DOM：只给看图缩放需要的那几个元素。
// 图：原图 1600×1600，适应后布局 400×400（=natScale 4，即 1:1 需要 scale 4）；视口 400×800。
const els: Record<string, any> = {};
let UIManager: any;
function tick(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function touch(clientX: number, clientY: number) { return { clientX: clientX, clientY: clientY }; }
function ev(extra: any) { return Object.assign({ preventDefault: () => undefined }, extra || {}); }
function fakeClassList() {
  const s = new Set<string>();
  return { add: (c: string) => s.add(c), remove: (c: string) => s.delete(c), contains: (c: string) => s.has(c) };
}

beforeEach(() => {
  UIManager = (globalThis as any).UIManager;
  for (const k of Object.keys(els)) delete els[k];
  els['imgViewer'] = { style: {} };
  els['imgViewerImg'] = {
    style: {}, src: '',
    naturalWidth: 1600, naturalHeight: 1600,
    // 布局尺寸（不受 transform 影响）：适应后 400×400
    offsetWidth: 400, offsetHeight: 400,
    // 模拟真实浏览器：getBoundingClientRect 会把当前 transform 算进去 → 这里故意报"被放大后的"尺寸。
    // 实现必须用 offsetWidth 当基准，否则放大后 natScale/夹取/徽标会自我循环（回归修复 2026-10-06）。
    getBoundingClientRect: () => ({ width: 800, height: 800 })
  };
  els['imgViewerBar'] = { style: {}, classList: fakeClassList() };
  els['imgViewerSave'] = { style: {} };
  (globalThis as any).document = { getElementById: (id: string) => els[id] || null };
  (globalThis as any).innerWidth = 400;
  (globalThis as any).innerHeight = 800;
  delete (globalThis as any).HttpBridge;   // 默认"老 App"：没有原生保存方法 → 工具条整条隐藏
  (UIManager as any)._vReset();
});

describe('看图缩放：纯数学', () => {
  it('viewerFitScale：按视口留边求初始比例；非法输入回 1', () => {
    expect(viewerFitScale(800, 800, 400, 800)).toBeCloseTo(0.46, 5);      // min(400*0.92/800, 800*0.86/800)
    expect(viewerFitScale(800, 1600, 400, 800)).toBeCloseTo(0.43, 5);     // 竖图按高算
    expect(viewerFitScale(0, 800, 400, 800)).toBe(1);
  });

  it('viewerClampPan：图比视口小 → 居中（0）；比视口大 → 夹在边界内', () => {
    expect(viewerClampPan(1, 400, 400, 400, 800, 100, 100)).toEqual({ x: 0, y: 0 });
    expect(viewerClampPan(2, 400, 400, 400, 800, 999, -999)).toEqual({ x: 200, y: 0 });   // x 最多 ±200，y 方向放不满 → 0
    expect(viewerClampPan(2, 400, 400, 400, 800, -50, 30)).toEqual({ x: -50, y: 0 });
  });

  it('viewerZoomAt：锚点下的像素不动（放大 2 倍时，屏幕 +100px 处的图点平移到 -100）', () => {
    expect(viewerZoomAt(1, 2, 0, 0, 100, 0)).toEqual({ x: -100, y: 0 });
    expect(viewerZoomAt(2, 1, -100, 0, 100, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe('看图缩放：手势接线', () => {
  it('打开时是「适应」（无 transform）', () => {
    expect(String(els['imgViewerImg'].style.transform || '')).toBe('');
  });

  it('双击 → 1:1 原图（natScale=4 → scale(4)）；再双击 → 回到适应', () => {
    const tap = () => {
      UIManager.viewerTouchStart(ev({ touches: [touch(200, 400)] }));
      UIManager.viewerTouchEnd(ev({ touches: [], changedTouches: [touch(200, 400)] }));
    };
    tap(); tap();
    expect((UIManager as any)._viewerZoom.s).toBe(4);
    expect(String(els['imgViewerImg'].style.transform)).toContain('scale(4)');
    tap(); tap();
    expect((UIManager as any)._viewerZoom.s).toBe(1);
    expect(String(els['imgViewerImg'].style.transform || '')).toBe('');
  });

  it('双指捏合：两指间距翻倍 → scale 翻倍（可超过 1:1，上限 natScale*2）', () => {
    UIManager.viewerTouchStart(ev({ touches: [touch(150, 400), touch(250, 400)] }));      // d=100
    UIManager.viewerTouchMove(ev({ touches: [touch(100, 400), touch(300, 400)] }));       // d=200
    expect((UIManager as any)._viewerZoom.s).toBe(2);
    // 收拢回原距离 → 回适应
    UIManager.viewerTouchMove(ev({ touches: [touch(150, 400), touch(250, 400)] }));
    expect((UIManager as any)._viewerZoom.s).toBe(1);
  });

  it('拖动平移：放大后可拖，且被夹在图边界内（不拖飞）', () => {
    (UIManager as any)._vSetScale(2);                                                     // 800×800 图在 400×800 视口：x 最多 ±200
    UIManager.viewerTouchStart(ev({ touches: [touch(200, 400)] }));
    UIManager.viewerTouchMove(ev({ touches: [touch(260, 400)] }));
    expect((UIManager as any)._viewerZoom.tx).toBe(60);
    UIManager.viewerTouchMove(ev({ touches: [touch(9999, 400)] }));
    expect((UIManager as any)._viewerZoom.tx).toBe(200);
    // 拖动过（moved=true）→ 抬手不算"单击关闭"
    UIManager.viewerTouchEnd(ev({ touches: [], changedTouches: [touch(9999, 400)] }));
    expect(els['imgViewer'].style.display).toBeUndefined();
  });

  it('滚轮缩放（桌面/浏览器）：向上滚放大，向下滚回适应（不会缩到比适应更小）', () => {
    UIManager.viewerWheel(ev({ deltaY: -100, clientX: 200, clientY: 400 }));
    expect((UIManager as any)._viewerZoom.s).toBeCloseTo(1.15, 5);
    for (let i = 0; i < 8; i++) UIManager.viewerWheel(ev({ deltaY: 100, clientX: 200, clientY: 400 }));
    expect((UIManager as any)._viewerZoom.s).toBe(1);
  });

  it('基准尺寸用 offsetWidth（不受 transform 影响）：1:1 目标与夹取范围都按适应尺寸算', () => {
    UIManager.toggleViewerZoom();                    // 双击/内部路径：1:1 = 1600/400 = scale 4
    expect((UIManager as any)._viewerZoom.s).toBe(4);         // 用 rect（800）会错算成 scale 2
    // 放大后拖动：x 仍被夹在 ±600（(400*4-400)/2），说明夹取用的是适应尺寸而不是"放大后的 rect"
    UIManager.viewerTouchStart(ev({ touches: [touch(200, 400)] }));
    UIManager.viewerTouchMove(ev({ touches: [touch(9999, 400)] }));
    expect((UIManager as any)._viewerZoom.tx).toBe(600);
  });

  it('工具条精简：只显示「保存到相册」；老 App 没原生方法时整条隐藏；4 秒后自动变淡（仍可点）', async () => {
    (globalThis as any).HttpBridge = { saveFileBase64: () => '{"ok":true}' };
    UIManager.viewAvatar('data:image/png;base64,AAA', { id: 'img1', ctx: 'cardwriter' });
    expect(els['imgViewerBar'].style.display).toBe('flex');
    expect(els['imgViewerSave'].style.display).toBe('');
    expect(els['imgViewerBar'].classList.contains('dim')).toBe(false);
    await tick(4200);
    expect(els['imgViewerBar'].classList.contains('dim')).toBe(true);   // 变淡但不消失（还能点）
    // 老 App：没有 saveFileBase64 → 按钮与整条都隐藏（缩放/关闭不靠按钮）
    delete (globalThis as any).HttpBridge;
    UIManager.viewAvatar('data:image/png;base64,AAA');
    expect(els['imgViewerBar'].style.display).toBe('none');
    expect(els['imgViewerSave'].style.display).toBe('none');
    expect(els['imgViewerBar'].classList.contains('dim')).toBe(false);  // 重开时清掉上一次的变淡
    // 顺带锁住"工具条只有一个按钮"（用户 2026-10-06 要求删掉多余按钮，别再被加回来）
    const html = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
    const barHtml = /<div class="img-viewer-bar"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    expect(barHtml, '找不到看图工具条').toBeTruthy();
    const btnIds = [...String(barHtml![1]).matchAll(/<button[^>]*id="([^"]+)"/g)].map((m) => m[1]);
    expect(btnIds).toEqual(['imgViewerSave']);
    const btnNoId = [...String(barHtml![1]).matchAll(/<button(?![^>]*id=)/g)];
    expect(btnNoId.length).toBe(0);                                     // 也不许有空 id 的按钮（关闭按钮已删）
  });

  it('单击（没拖动）→ 关闭；刚做过手势后的 click 不会误关', async () => {
    UIManager.viewerTouchStart(ev({ touches: [touch(200, 400)] }));
    UIManager.viewerTouchEnd(ev({ touches: [], changedTouches: [touch(200, 400)] }));
    await tick(360);
    expect(els['imgViewer'].style.display).toBe('none');

    // 鼠标路径：刚滚过轮（手势时间内）不关；过一会儿再点才关
    els['imgViewer'].style.display = 'flex';
    UIManager.viewerWheel(ev({ deltaY: -100, clientX: 200, clientY: 400 }));
    UIManager.viewerClick();
    expect(els['imgViewer'].style.display).toBe('flex');
    (UIManager as any)._viewerZoom.gestureAt = 0;
    UIManager.viewerClick();
    expect(els['imgViewer'].style.display).toBe('none');
  });
});
