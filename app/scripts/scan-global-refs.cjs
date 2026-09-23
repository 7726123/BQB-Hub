// 单 bundle 改造辅助：源码级跨模块全局引用扫描（docs/single-bundle-refactor.md P2/P3 复用）。
// 用法：cd app && node scripts/scan-global-refs.cjs
// 输出：全局名总数、双向引用对（import 化后的潜在环）、各文件引用外部模块出度。
// 注意：统计含字符串/注释噪声，处置前逐对人工核对引用点。
const fs = require('fs');
const path = require('path');
const ROOT = 'src';
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    const s = fs.statSync(p);
    if (s.isDirectory()) walk(p);
    else if (f.endsWith('.ts')) files.push(p);
  }
})(ROOT);

const dts = fs.readFileSync('src/globals.d.ts', 'utf8');
const names = new Set();
for (const m of dts.matchAll(/declare (?:const|var|function) (\w+)/g)) names.add(m[1]);
// 每个全局名 → 定义它的文件（挂载点）
const defOf = {};
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/globalThis as unknown as \{ (\w+):/g)) { names.add(m[1]); defOf[m[1]] = f; }
  for (const m of s.matchAll(/window\.(\w+)\s*=/g)) { names.add(m[1]); defOf[m[1]] = f; }
  // __pl.X = X 风格挂载（__pl 多为 globalThis 别名）
  for (const m of s.matchAll(/(?:__pl|globalThis)\.(\w+)\s*=\s*\1\b/g)) { names.add(m[1]); defOf[m[1]] = f; }
}

const byFile = {};
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  const txt = s.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const own = new Set();
  for (const m of txt.matchAll(/globalThis as unknown as \{ (\w+):/g)) own.add(m[1]);
  const used = new Set();
  for (const n of names) {
    if (own.has(n) || defOf[n] === f) continue;
    const re = new RegExp('\\b' + n + '\\s*(\\.|\\()', 'g');
    if (re.test(txt)) used.add(n);
  }
  byFile[f] = used;
}

const fnames = Object.keys(byFile);
const pairs = [];
for (let i = 0; i < fnames.length; i++) for (let j = i + 1; j < fnames.length; j++) {
  const a = fnames[i], b = fnames[j];
  const aRefsB = [...byFile[a]].filter(n => defOf[n] === b).length;
  const bRefsA = [...byFile[b]].filter(n => defOf[n] === a).length;
  if (aRefsB > 0 && bRefsA > 0) pairs.push([path.basename(a), path.basename(b), aRefsB, bRefsA]);
}
console.log('全局名总数(去重):', names.size, ' 定义文件数:', new Set(Object.values(defOf)).size);
console.log('--- 双向引用对（import 化后的潜在环）---');
for (const [a, b, x, y] of pairs.sort()) console.log(a.padEnd(22), '<->', b.padEnd(22), '(' + x + '/' + y + ')');
console.log('共', pairs.length, '对');
console.log('--- 各文件引用外部模块数（出度，找 hub 与叶子）---');
const outs = fnames.map(f => [path.basename(f), byFile[f].size]).sort((p, q) => q[1] - p[1]);
for (const [n, c] of outs) console.log(n.padEnd(22), c);
