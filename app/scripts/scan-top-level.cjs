// P2 审计：找出各 domain/lib 文件里的「顶层可执行语句」（模块求值期执行，非声明/注释/对象体内）。
// 若顶层语句解引用其他模块的绑定 → 单 bundle 合并时 TDZ 风险点（D2 铁律违反者）。
const fs = require('fs');
const dirs = ['src/domain', 'src/lib', 'src/boot'];
const DECL = /^(const|let|var|function|export|import|interface|type|declare|enum|namespace|class)\b/;
const SKIP = /^(\s*$|\s*\/\/|\s*\/\*|\s*\*|\s*[}\]],?$|^\s*[({]\s*$)/;

for (const d of dirs) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (!f.endsWith('.ts')) continue;
    const p = d + '/' + f;
    const lines = fs.readFileSync(p, 'utf8').split('\n');
    const hits = [];
    lines.forEach((ln, i) => {
      // 顶层 = 无缩进
      if (ln[0] !== undefined && ln[0] !== ' ' && ln[0] !== '\t') {
        const t = ln.trim();
        if (!t || DECL.test(t) || SKIP.test(t)) return;
        // 对象方法行如 `  method(...) {` 是缩进的；顶层只可能是可执行语句或裸表达式
        if (/^[A-Za-z_$][\w$]*\s*[:=]/.test(t)) return; // 顶层对象/变量片段
        hits.push((i + 1) + ': ' + t.slice(0, 100));
      }
    });
    if (hits.length) {
      console.log('== ' + p);
      hits.forEach(h => console.log('   ' + h));
    }
  }
}
console.log('--- 审计完成 ---');
