// 输入框自动增高（lib/inputgrow）：写作页与对话模式共用同一套实现。
//
// 这里守的是 2026-09-25 用户实测的真因：**空值不能用 scrollHeight**。
// 空 textarea 的 scrollHeight 会把 placeholder 的高度算进去，而 placeholder 在窄屏会折行——
// 412px 宽的手机上实测：空值 scrollHeight=94px（placeholder 两行），两行正文才 70px，
// 于是"输入多行、删光之后输入框还是好几行高"。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { autoGrow, bindAutoGrow } from '../src/lib/inputgrow';

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, any>;

// max-height 由 CSS 决定（#writingInput/#chatInput 都是 calc(5*1.5em+22px) → 142px）
beforeEach(() => {
  g.getComputedStyle = () => ({ maxHeight: '142px' });
});
afterEach(() => {
  delete g.getComputedStyle;
  vi.restoreAllMocks();
});

function fakeTa(o: Record<string, any> = {}): any {
  return {
    value: '', style: { height: '' }, scrollHeight: 46, clientHeight: 46, scrollTop: 0,
    selectionStart: 0, _listeners: {} as Record<string, Function[]>,
    addEventListener(t: string, fn: Function) { (this._listeners[t] ||= []).push(fn); },
    _fire(t: string) { (this._listeners[t] || []).forEach((fn: Function) => fn()); },
    ...o,
  };
}

describe('自动增高', () => {
  it('空值：回落 CSS 高度（不看 scrollHeight——那里有 placeholder 的折行高度）', () => {
    const ta = fakeTa({ value: '', scrollHeight: 94, style: { height: '142px' } });
    autoGrow(ta);
    expect(ta.style.height).toBe('');
  });

  it('一行/两行：按 content 高度，不吃 max-height', () => {
    const one = fakeTa({ value: '第一行', scrollHeight: 46 });
    autoGrow(one);
    expect(one.style.height).toBe('46px');
    const two = fakeTa({ value: '第一行\n第二行', scrollHeight: 70 });
    autoGrow(two);
    expect(two.style.height).toBe('70px');
  });

  it('超过上限：clamp 到 max-height，且在光标位于末尾时把滚动条贴到最后一行', () => {
    const ta = fakeTa({ value: 'x\n'.repeat(12) + 'x', scrollHeight: 400, clientHeight: 142, selectionStart: 25 });
    autoGrow(ta);
    expect(ta.style.height).toBe('142px');
    expect(ta.scrollTop).toBe(400);
  });

  it('光标不在末尾（上移改前面的内容）：不强行滚动，避免把光标顶出视口', () => {
    const ta = fakeTa({ value: 'aaaa\nbbbb\ncccc', scrollHeight: 400, clientHeight: 142, selectionStart: 2 });
    autoGrow(ta);
    expect(ta.style.height).toBe('142px');
    expect(ta.scrollTop).toBe(0);
  });

  it('空元素/null 不炸', () => {
    expect(() => autoGrow(null)).not.toThrow();
    const bare = fakeTa();
    expect(() => autoGrow(bare)).not.toThrow();
  });

  it('形如 {value} 的假元素 / 没有 getComputedStyle 的环境也不炸（真实模式与测试里都会遇到）', () => {
    const saved = g.getComputedStyle;
    delete g.getComputedStyle;
    try {
      expect(() => autoGrow({ value: '有字' } as any)).not.toThrow();        // 连 style 都没有
      expect(() => bindAutoGrow({ value: '有字' } as any)).not.toThrow();    // 也没有 addEventListener
      const noCs = fakeTa({ value: '有字', scrollHeight: 46, style: { height: '' } });
      autoGrow(noCs);
      expect(noCs.style.height).toBe('46px');                               // 没有 CSS 时兜底 120
    } finally {
      g.getComputedStyle = saved;
    }
  });

  it('真实模式输入框（#realInput）也走这一套实现', () => {
    const src = readFileSync(resolve(here, '../src/domain/realmode.ts'), 'utf8');
    expect(src).toContain("from '../lib/inputgrow'");
    expect(src).toContain('bindAutoGrow(ta)');
  });
});

describe('绑定与共用', () => {
  it('bindAutoGrow 绑 input/change/blur 三条（IME 删除、粘贴、收键盘都不发 input 的路径兜住）', () => {
    const ta = fakeTa({ value: '', style: { height: '142px' } });
    bindAutoGrow(ta);
    expect(Object.keys(ta._listeners).sort()).toEqual(['blur', 'change', 'input']);
    ta._fire('blur');
    expect(ta.style.height).toBe('');
  });

  it('写作页与对话模式的输入框都走这一套实现（不再各写一份）', () => {
    const src = (p: string) => readFileSync(resolve(here, p), 'utf8');
    expect(src('../src/domain/mobile.ts')).toContain('inputgrow');
    expect(src('../src/domain/chatmode.ts')).toContain('inputgrow');
    expect(src('../src/domain/app.ts')).toContain('inputgrow');
  });
});
