// P2 处置表辅助：早批次候选模块在「真实代码行」里引用的外部全局名（字符串事件行除外）。
const fs = require('fs');

const cands = ['clientlog', 'modelcompat', 'optionball', 'plugins', 'tavern-adapter',
  'archive', 'character', 'database', 'memory', 'regex', 'bm25', 'variables',
  'worldbook', 'protagonist', 'book', 'summary', 'preset', 'api', 'settingsync'];
const defOf = {};
const files = [];
for (const d of ['src/domain', 'src/lib', 'src/infra']) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.ts')) continue;
    const p = d + '/' + f;
    files.push(p);
    const s = fs.readFileSync(p, 'utf8');
    for (const m of s.matchAll(/globalThis as unknown as \{ (\w+):/g)) defOf[m[1]] = p;
    for (const m of s.matchAll(/window\.(\w+)\s*=/g)) defOf[m[1]] = p;
    for (const m of s.matchAll(/(?:__pl|globalThis)\.(\w+)\s*=\s*\1\b/g)) defOf[m[1]] = p;
  }
}
// d.ts 声明（无 defOf）也算外部名候选
const dts = fs.readFileSync('src/globals.d.ts', 'utf8');
for (const m of dts.matchAll(/declare (?:const|var|function) (\w+)/g)) if (!defOf[m[1]]) defOf[m[1]] = '(d.ts)';

const STR = /on(?:click|change|input|keydown|keyup|blur|focus|submit|load|error|contextmenu)\s*=\s*['"]/;

for (const c of cands) {
  const p = files.find(f => f.endsWith('/' + c + '.ts'));
  if (!p) { console.log(c.padEnd(14), '(无此文件)'); continue; }
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const used = new Map();
  lines.forEach(ln => {
    if (ln.trim().startsWith('//') || STR.test(ln)) return;
    for (const [n, def] of Object.entries(defOf)) {
      if (def === p) continue;
      const re = new RegExp('\\b' + n + '\\s*(\\.|\\()', 'g');
      if (re.test(ln)) used.set(n, (used.get(n) || 0) + 1);
    }
  });
  const list = [...used.entries()].sort((a, b) => b[1] - a[1]).map(([n, v]) => n + (v > 1 ? 'x' + v : '')).join(', ');
  console.log(c.padEnd(14), '→', list || '(无)');
}
