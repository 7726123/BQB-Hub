// 死代码扫描（本项目专用）：找出「用户已经够不到、代码却还留着」的东西。
//
// 为什么不用 knip：本项目的调用面大量是**字符串**——HTML 内联事件（onclick="App.foo()"）、
// 运行时拼接的 HTML（'cwPresetBlock_' + k）、测试里直接调全局。通用工具会把它们判成"未使用"。
//
// 判"死"的三条口径（每条都踩过误报，判据都写在这里）：
//   ① 方法/函数：标识符在**剥离注释后**的源码里只出现定义那么多次，且没有任何带引号的字符串引用。
//      剥注释用 esbuild——正则剥注释会被 HTML/CSS 模板串里的 /* 骗到、把后面的代码一起吞掉。
//   ② 交互控件：既没有内联 handler、也没有 JS 引用、也不是动态拼接出来的（= 点了没反应 / 没人读它的值）；
//      另附"僵尸标记"：既无引用也无 CSS 选择的容器（通常是被删功能留下的空壳）。
//   ③ 孤岛面板：panel-tab 没有任何导航入口能到达（按 mobile.ts 的 view→tab 映射反查）。
//
// 用法：
//   node tools/deadscan.mjs                    全量扫描（改代码后跑一遍）
//   node tools/deadscan.mjs verify <名字...>    打印某个名字的全部引用位置（人工复核用）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BT = String.fromCharCode(96);

let esbuild = null;
try { esbuild = (await import('esbuild')).default; } catch (e) { /* 缺 esbuild 时退化为不剥注释 */ }

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/node_modules|\.git|dist|build/.test(e.name)) walk(p, out); continue; }
    if (/\.(ts|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = [
  ...walk(path.join(ROOT, 'app', 'src')),
  ...walk(path.join(ROOT, 'app', 'tests')),
  path.join(ROOT, 'web', 'index.html'),
].filter((f) => fs.existsSync(f));

function codeOf(f) {
  const raw = fs.readFileSync(f, 'utf8');
  if (/\.html$/.test(f) || !esbuild) return raw;
  try { return esbuild.transformSync(raw, { loader: 'ts', legalComments: 'none' }).code; } catch (e) { return raw; }
}
const texts = new Map(files.map((f) => [f, codeOf(f)]));
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const html = texts.get(path.join(ROOT, 'web', 'index.html')) || '';
const tsText = [...texts].filter(([f]) => /\.ts$/.test(f)).map(([, t]) => t).join('\n');

if (process.argv[2] === 'verify') {
  for (const name of process.argv.slice(3)) {
    const re = new RegExp('\\b' + name.replace(/\$/g, '\\$').replace(/-/g, '\\-') + '\\b');
    const hits = [];
    for (const [f, t] of texts) {
      t.split('\n').forEach((l, i) => { if (re.test(l)) hits.push(rel(f) + ':' + (i + 1) + ': ' + l.trim().slice(0, 130)); });
    }
    console.log('\n===== ' + name + '（' + hits.length + ' 处）=====');
    hits.forEach((h) => console.log('  ' + h));
  }
  process.exit(0);
}

// ── ① 方法/函数 ─────────────────────────────────────────────────────────
const CANDIDATE_RE = /^(?: {2}| {4})([A-Za-z_$][\w$]*)\s*\(|^export function ([A-Za-z_$][\w$]*)\s*\(/gm;
const candidates = new Map();
for (const [f, t] of texts) {
  if (!/\.ts$/.test(f) || /[\\/]tests[\\/]/.test(f)) continue;
  for (const m of t.matchAll(CANDIDATE_RE)) {
    const name = m[1] || m[2];
    if (!name || name.length < 3) continue;
    if (!candidates.has(name)) candidates.set(name, []);
    candidates.get(name).push(rel(f));
  }
}
const allText = [...texts.values()].join('\n');
const deadFns = [];
for (const [name, defs] of candidates) {
  const occ = (allText.match(new RegExp('\\b' + name.replace(/\$/g, '\\$') + '\\b', 'g')) || []).length;
  const quoted = (allText.match(new RegExp('["\']' + name + '["\']', 'g')) || []).length;
  if (occ <= new Set(defs).size && quoted === 0) deadFns.push({ name, defs: [...new Set(defs)] });
}
deadFns.sort((a, b) => a.name.localeCompare(b.name));

// ── ② 交互控件 / 僵尸标记 ────────────────────────────────────────────────
const prefixes = new Set();
for (const m of tsText.matchAll(/['"]([A-Za-z][\w-]{2,})['"]\s*\+/g)) prefixes.add(m[1]);
for (const m of tsText.matchAll(new RegExp(BT + '([A-Za-z][\\w-]{2,})\\$\\{', 'g'))) prefixes.add(m[1]);

const deadControls = [];
const deadMarkup = [];
const elRe = /<([a-zA-Z]+)([^>]*?)\sid="([^"]+)"([^>]*?)>/g;
for (const m of html.matchAll(elRe)) {
  const tag = m[1].toLowerCase();
  const attrs = (m[2] || '') + (m[4] || '');
  const id = m[3];
  const inline = /\son(click|input|change|keydown|keyup|blur|focus|submit)=/.test(attrs);
  const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || '';
  const interactive = /^(button|input|select|textarea|a)$/.test(tag) || /btn/.test(cls);
  const quoted = tsText.includes("'" + id + "'") || tsText.includes('"' + id + '"') || tsText.includes('#' + id);
  const composed = [...prefixes].some((p) => id.startsWith(p) && id.length > p.length);
  const styled = html.includes('#' + id) || /style="/.test(attrs);   // 内联 style 也算有样式（rvwTypeTabs 这类 flex 容器）
  if (quoted || composed) continue;
  const i = html.indexOf('id="' + id + '"');
  const where = html.slice(Math.max(0, i - 80), i).split('\n').pop().trim().slice(-70);
  if (interactive && !inline) deadControls.push(id + '  <' + tag + '>  ' + where);
  else if (!interactive && !styled) deadMarkup.push(id + '  <' + tag + '>  ' + where);
}

// ── ③ 孤岛面板 ─────────────────────────────────────────────────────────
// 可达 = 存在某个导航入口 view（data-view），使 tabForView(view) === 该 tab（settings→advanced 这种映射也算）
const tabs = [...html.matchAll(/panel-tab"\s+id="([a-z-]+)"/g)].map((m) => m[1]);
const navViews = [...html.matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]);
const mobileTs = [...texts].find(([f]) => /mobile\.ts$/.test(f))?.[1] || '';
const mapPairs = [...mobileTs.matchAll(/([a-z]+):\s*'([a-z-]+)'/g)].map((m) => [m[1], m[2]]);
const tabForView = (v) => (mapPairs.find(([k]) => k === v) || [])[1] || v;
const reachableTabs = new Set(navViews.map((v) => 'tab-' + tabForView(v)));
const orphanTabs = tabs.filter((t) => !reachableTabs.has(t));

// ── ④ 孤岛弹窗 ─────────────────────────────────────────────────────────
// 弹窗 id（modalXxx）在源码里是字符串定义的；除定义处外再无引用，说明没有任何 openModal 打开它。
const modalIds = [...new Set(
  [...tsText.matchAll(/id="(modal[A-Za-z]+)"/g)].map((m) => m[1])
    .concat([...html.matchAll(/id="(modal[A-Za-z]+)"/g)].map((m) => m[1]))
)];
const orphanModals = modalIds.filter((id) => {
  const occ = (allText.match(new RegExp('\\b' + id + '\\b', 'g')) || []).length;
  return occ <= 1;
}).sort();

// ── 输出 ────────────────────────────────────────────────────────────────
console.log('扫描文件数：', files.length, '（注释已用 esbuild 剥离）');
console.log('\n=== ① 疑似无人调用的方法/函数（' + deadFns.length + '）===');
deadFns.forEach((d) => console.log('  ' + d.name.padEnd(34) + ' 定义于 ' + d.defs.join(', ')));
console.log('\n=== ② 交互控件：既无 handler 也无引用（僵尸控件，' + deadControls.length + '）===');
deadControls.forEach((x) => console.log('  ' + x));
console.log('\n=== ②b 容器：既无引用也无样式（僵尸标记，' + deadMarkup.length + '）===');
deadMarkup.forEach((x) => console.log('  ' + x));
console.log('\n=== ③ 没有导航入口能到达的 panel-tab（孤岛面板，' + orphanTabs.length + '）===');
console.log('  ' + (orphanTabs.join(' ') || '(无)'));

console.log('\n=== ④ 定义了但没人打开的弹窗（孤岛弹窗，' + orphanModals.length + '）===');
console.log('  ' + (orphanModals.join(' ') || '(无)'));
