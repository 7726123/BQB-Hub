// 探针：某名字在 src/tests 各文件的「真实代码行」出现（跳过 // 注释行与疑似字符串行）
const fs = require('fs');
const names = process.argv.slice(2);
const STR = /on(?:click|change|input|keydown|keyup|blur|focus|submit|load|error|contextmenu)\s*=\s*['"]/;
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) files.push(p);
  }
})('src');
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = d + '/' + e.name;
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.ts')) files.push(p);
  }
})('tests');
for (const n of names) {
  const re = new RegExp('\\b' + n + '\\b');
  console.log('== ' + n);
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    const hits = [];
    lines.forEach((ln, i) => {
      if (!re.test(ln)) return;
      if (ln.trim().startsWith('//') || STR.test(ln)) return;
      if (/import\s*[^;]*\b'/.test(ln) && ln.includes(n)) return; // import 行
      hits.push((i + 1) + ': ' + ln.trim().slice(0, 90));
    });
    if (hits.length) { console.log('  ' + f); hits.slice(0, 4).forEach(h => console.log('    ' + h)); }
  }
}
