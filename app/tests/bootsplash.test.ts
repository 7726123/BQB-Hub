// 启动画面：门面（domain/bootsplash.ts）+ index.html 里的画面与引导脚本。
//
// 门面只做展示，所以这里主要守两件事：
//   ① 没有画面时必须全是空操作（老 index.html / 浏览器 / 单测都不能被它带崩）；
//   ② index.html 的结构性不变量：画面存在、main.js 改成注入（否则画面根本画不出来）、
//      缓存戳仍能被 bump-version 的正则改写、层级在弹窗之下（APK 更新弹窗不能被盖住）。
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { BootSplash } from '../src/domain/bootsplash';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(here, '../../web/index.html'), 'utf8');
const g = globalThis as unknown as Record<string, unknown>;

describe('启动画面门面', () => {
  afterEach(() => { delete g.__bootSplash; });

  it('没有画面时全部空操作，且不抛错', () => {
    expect(BootSplash.available()).toBe(false);
    expect(() => {
      BootSplash.text('正在检查更新…');
      BootSplash.busy(true);
      BootSplash.onSkip(() => { /* noop */ });
      BootSplash.onSkip(null);
      BootSplash.hide();
    }).not.toThrow();
  });

  it('有画面时把调用透传过去（文字/进度/稍后/收起）', () => {
    const calls: string[] = [];
    const skipFn: (() => void)[] = [];
    g.__bootSplash = {
      text: (s: string) => calls.push('text:' + s),
      busy: (on: boolean) => calls.push('busy:' + on),
      skip: (fn: (() => void) | null) => { if (fn) { skipFn.push(fn); } calls.push('skip:' + (fn ? 'on' : 'off')); },
      hide: () => calls.push('hide'),
      live: () => calls.push('live'),
    };
    expect(BootSplash.available()).toBe(true);
    BootSplash.text('正在同步最新版本…');
    BootSplash.busy(true);
    BootSplash.onSkip(() => { /* noop */ });
    BootSplash.onSkip(null);
    BootSplash.hide();
    expect(calls).toEqual(['text:正在同步最新版本…', 'busy:true', 'skip:on', 'skip:off', 'hide']);
    expect(skipFn.length).toBe(1);
  });

  it('画面方法抛错时门面兜住（展示失败不能影响更新流程）', () => {
    g.__bootSplash = { text: () => { throw new Error('boom'); }, hide: () => { throw new Error('boom'); } };
    expect(() => { BootSplash.text('x'); BootSplash.hide(); BootSplash.busy(true); }).not.toThrow();
  });
});

describe('index.html 的启动画面与引导脚本（结构不变量）', () => {
  it('画面存在，且状态行/进度条/稍后按钮的 id 齐全', () => {
    for (const id of ['bootSplash', 'bootSplashText', 'bootSplashBar', 'bootSplashSkip']) {
      expect(html.includes('id="' + id + '"'), id).toBe(true);
    }
  });

  it('main.js 改成"画一帧后注入"：不得再有同步 script src（否则画面永远画不出来）', () => {
    expect(html).not.toContain('<script src="modules/main.js');   // 只剩 data-src + createElement 注入
    expect(html).toContain('id="bootMain" data-src="modules/main.js?v=');
    expect(html).toContain("document.createElement('script')");
    expect(html).toContain('__bootSplash');
  });

  it('缓存戳仍能被 bump-version.mjs 的正则改写（data-src 里的写法）', () => {
    const m = /(modules\/main\.js\?v=)[^"']*/.exec(html);
    expect(m).toBeTruthy();
    expect(m![1] + '225270759-157').toContain('modules/main.js?v=225270759-157');
  });

  it('层级在弹窗/提示之下（APK 更新弹窗、toast 不能被启动画面盖住）', () => {
    const z = /#bootSplash\{[^}]*z-index:(\d+)/.exec(html);
    expect(z).toBeTruthy();
    expect(Number(z![1])).toBeLessThan(2000);
  });

  it('兜底：bundle 加载失败与 12 秒超时都会收起画面（界面永不被锁死）', () => {
    expect(html).toContain('setTimeout(hide, 12000)');
    expect(html).toContain('s.onerror = function () { hide(); }');
  });

  it('尊重 prefers-reduced-motion（关掉动画仍能看到画面）', () => {
    expect(html).toContain('prefers-reduced-motion');
  });
});
