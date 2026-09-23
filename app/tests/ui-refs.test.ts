// UI 引用完整性：扫描所有内联事件字符串（HTML 静态 + domain 源码里运行时拼接的
// onclick="X.method(...)"），与运行时全局对象比对——防「按钮没反应」
// （方法改名/漏挂/typo 后字符串 onclick 无编译期检查，tsc 抓不到）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// 载入所有 domain 模块（副作用：挂载 globalThis.Xxx）
import '../src/infra/storage';
import '../src/domain/editor';
import '../src/domain/worldbook';
import '../src/domain/preset';
import '../src/domain/ui';
import '../src/domain/app';
import '../src/domain/cardwriter';
import '../src/domain/community';
import '../src/domain/biqi';
import '../src/domain/assistant';
import '../src/domain/update';
import '../src/domain/plugins';
import '../src/domain/feedback';   // 反馈页的内联 onclick（Feedback.submit/render/onInput）
import '../src/domain/chatmode';   // 对话模式的内联 onclick（ChatMode.send/continueIt/openProfile/...）
import '../src/domain/settingsync';
import '../src/lib/variables';
import '../src/boot/compat'; // 白名单挂载（D1：字符串 onclick 引用的名字在此可解析）

const ROOT = path.resolve(__dirname, '..', '..'); // app/.. = 仓库根

// 非 UI 全局（Math/document/event/...）——事件处理器里出现但不应按 UI 对象校验
const SKIP_OBJS = new Set([
  'Math', 'document', 'event', 'JSON', 'console', 'window', 'Object', 'Array',
  'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error', 'Promise', 'screen',
  'navigator', 'location', 'localStorage', 'top', 'self', 'globalThis',
  'NodeFilter', 'setTimeout', 'setInterval', 'clearTimeout',
  'requestAnimationFrame', 'getComputedStyle', 'encodeURIComponent',
  'decodeURIComponent', 'parseInt', 'parseFloat', 'Uint8Array', 'XMLHttpRequest',
]);

interface Ref { obj: string; meth: string; src: string }

function extractRefs(): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  const push = (obj: string, meth: string, src: string) => {
    if (SKIP_OBJS.has(obj)) return;
    const key = obj + '.' + meth;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ obj, meth, src: src.slice(0, 80) });
  };

  // 1) web/index.html 静态属性型 onXXX="..."
  const html = path.join(ROOT, 'web', 'index.html');
  if (fs.existsSync(html)) {
    const s = fs.readFileSync(html, 'utf-8');
    const attrRe = /\son(?:click|change|input|keydown|keyup|keypress|blur|focus|submit|touchstart|paste|load|error|contextmenu)\s*=\s*"([^"]*)"/gi;
    const callRe = /\b([A-Z][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
    for (const m of s.matchAll(attrRe)) {
      for (const c of m[1].matchAll(callRe)) push(c[1], c[2], m[1]);
    }
  }

  // 2) domain 源码里运行时拼接的 onclick="...X.method(...)"（含字符串拼 id 的动态 HTML）
  const srcRoot = path.join(ROOT, 'app', 'src');
  const walk = (dir: string): string[] => {
    let acc: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) acc = acc.concat(walk(p));
      else if (e.name.endsWith('.ts')) acc.push(p);
    }
    return acc;
  };
  const callRe2 = /\b([A-Z][A-Za-z0-9_]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g;
  for (const f of walk(srcRoot)) {
    const s = fs.readFileSync(f, 'utf-8');
    // 只扫 onXXX=" 出现后的 160 字符窗口（字符串拼接的 HTML 片段）
    const openRe = /on(?:click|change|input|keydown|keyup|keypress|blur|focus|submit|touchstart|paste|load|error|contextmenu)\s*=\s*['"]/gi;
    for (const m of s.matchAll(openRe)) {
      const seg = s.slice(m.index + m[0].length, m.index + m[0].length + 160);
      for (const c of seg.matchAll(callRe2)) push(c[1], c[2], seg);
    }
  }
  return out;
}

const G = globalThis as unknown as Record<string, any>;
const refs = extractRefs();

describe('UI 内联事件引用完整性（防按钮没反应）', () => {
  it('扫描到内联引用（自检）', () => {
    expect(refs.length).toBeGreaterThan(80);
  });

  it('引用的对象应存在于运行时全局', () => {
    const objs = Array.from(new Set(refs.map(r => r.obj)));
    const missing = objs.filter(o => !G[o]);
    expect(missing).toEqual([]);
  });

  it('引用的方法应存在于对应对象', () => {
    const missing: string[] = [];
    for (const r of refs) {
      const obj = G[r.obj];
      if (!obj) { missing.push(r.obj + '（对象缺失）'); continue; }
      if (typeof obj[r.meth] !== 'function') missing.push(r.obj + '.' + r.meth + '  ← ' + r.src);
    }
    expect(missing).toEqual([]);
  });
});
