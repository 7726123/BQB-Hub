// 写作页「回到底部」浮钮：显示阈值（离底约 50 行）+ 平滑滚动（不是生硬跳转）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/domain/editor';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const EM = () => g.EditorManager as Any;

function fakeBtn(): Any {
  const cls = new Set<string>();
  return {
    textContent: '', innerHTML: '', style: {},
    classList: {
      add: (c: string) => cls.add(c),
      remove: (c: string) => cls.delete(c),
      toggle: (c: string, on?: boolean) => { if (on === undefined) { cls.has(c) ? cls.delete(c) : cls.add(c); } else if (on) cls.add(c); else cls.delete(c); },
      contains: (c: string) => cls.has(c),
    },
    _cls: cls,
  };
}

let btn: Any;
beforeEach(() => {
  btn = fakeBtn();
  g.document.getElementById = (id: string) => (id === 'editorScrollBottom' ? btn : null);
  g.getComputedStyle = () => ({ lineHeight: '32px', fontSize: '16px' });
});
afterEach(() => { vi.restoreAllMocks(); });

function fakeEditor(scrollHeight: number, clientHeight: number, scrollTop: number): Any {
  return { scrollHeight, clientHeight, scrollTop };
}

describe('浮钮显示阈值', () => {
  it('离底部超过 50 行（50×32px=1600px）才显示', () => {
    const em = EM();
    em.editorEl = fakeEditor(20000, 600, 0);          // 离底 19400px
    em._syncScrollBottomBtn();
    expect(btn._cls.has('show')).toBe(true);

    em.editorEl = fakeEditor(20000, 600, 20000 - 600 - 1500);  // 离底 1500px < 1600
    em._syncScrollBottomBtn();
    expect(btn._cls.has('show')).toBe(false);

    em.editorEl = fakeEditor(20000, 600, 20000 - 600 - 1800);  // 离底 1800px > 1600
    em._syncScrollBottomBtn();
    expect(btn._cls.has('show')).toBe(true);

    em.editorEl = fakeEditor(20000, 600, 20000 - 600);         // 已在底部
    em._syncScrollBottomBtn();
    expect(btn._cls.has('show')).toBe(false);
  });
});

describe('点击后平滑滚动到底部', () => {
  it('多帧推进（非生硬跳转），终点为底部', () => {
    const em = EM();
    const el = fakeEditor(10000, 800, 0);
    em.editorEl = el;
    // 手动驱动 rAF + 可控时钟
    const cbs: Array<() => void> = [];
    g.requestAnimationFrame = (cb: () => void) => { cbs.push(cb); return cbs.length; };
    g.cancelAnimationFrame = () => {};
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    em.scrollEditorToBottom();
    expect(cbs.length).toBe(1);
    const seen: number[] = [];
    let guard = 0;
    while (cbs.length && guard++ < 50) {
      const cb = cbs.shift();
      if (!cb) break;
      cb();
      seen.push(el.scrollTop);
      now += 130;                                   // 每次推进 130ms（总时长 520ms）
    }
    expect(el.scrollTop).toBe(9200);                // scrollHeight - clientHeight
    expect(seen.length).toBeGreaterThan(2);         // 分多帧，不是一次跳到底
    expect(seen[0]).toBeLessThan(9200);             // 第一帧还没到底
    // 单调不减
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
  });

  it('已在底部时不动（也不启动动画）', () => {
    const em = EM();
    const el = fakeEditor(10000, 800, 9200);
    em.editorEl = el;
    const cbs: Array<() => void> = [];
    g.requestAnimationFrame = (cb: () => void) => { cbs.push(cb); return cbs.length; };
    em.scrollEditorToBottom();
    expect(cbs.length).toBe(0);
    expect(el.scrollTop).toBe(9200);
  });

  it('用户滚动（wheel/touch）会立即取消动画', () => {
    const em = EM();
    const el = fakeEditor(10000, 800, 0);
    em.editorEl = el;
    const cbs: Array<() => void> = [];
    g.requestAnimationFrame = (cb: () => void) => { cbs.push(cb); return cbs.length; };
    g.cancelAnimationFrame = vi.fn();
    vi.spyOn(performance, 'now').mockImplementation(() => 1000);
    em.scrollEditorToBottom();
    expect(cbs.length).toBe(1);
    em._cancelScrollAnim();
    expect(cbs.length).toBe(1);        // 已取消：不再有新的 rAF 排队
    expect(el.scrollTop).toBe(0);
  });
});
