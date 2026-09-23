// P3-B 辅助：枚举数据簇管理器名的全部消费文件（含是否已 import 该名）
const fs = require('fs');
const dirs = ['src/domain', 'src/lib', 'src/boot', 'src/infra'];
const files = [];
for (const d of dirs) for (const f of fs.readdirSync(d)) if (f.endsWith('.ts')) files.push(d + '/' + f);

const DEF_HINT = {
  WorldBookManager: 'worldbook', BookManager: 'book', CharacterManager: 'character',
  StoryMemoryManager: 'memory', ProtagonistManager: 'protagonist', VariableManager: 'variable',
  DatabaseManager: 'database', ArchiveStore: 'archive', ArchiveIndex: 'bm25',
  Waterline: 'archive', SummaryManager: 'summary', UsageAssistant: 'assistant',
};

for (const n of Object.keys(DEF_HINT)) {
  const consumers = [];
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    if (!s.includes(n)) continue;
    const isDef = f.includes(DEF_HINT[n]) && /\.ts$/.test(f);
    if (isDef) continue;
    const named = new RegExp('import\\s*\\{[^}]*\\b' + n + '\\b[^}]*\\}\\s*from').test(s);
    consumers.push(f + (named ? '  [已import]' : ''));
  }
  console.log('== ' + n + '（定义在 *' + DEF_HINT[n] + '.ts）消费方 ' + consumers.length + ' 个:');
  consumers.forEach(c => console.log('   ' + c));
}
