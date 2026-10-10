// 契约模式运行器：同一套用例，目标实现可换（详见 tests/CONTRACT.md）。
//
//   npm run test:contract
//     → 目标 = 现在的 Node 版（基线；默认 node --experimental-sqlite src/main.js）
//
//   CONTRACT_CMD="node --experimental-sqlite src/main.js"  npm run test:contract
//   CONTRACT_CMD="java -jar ../server-java/target/app.jar" npm run test:contract
//     → 换成别的实现（Windows PowerShell: $env:CONTRACT_CMD="java -jar ..."; npm run test:contract）
//
// 用例进程本身要读 SQLite 库（夹具直读，见 helpers.js），所以带上 --experimental-sqlite
// （Node 24 接受该参数；Node 22.x 需要它才能真正 require('node:sqlite')）。
const { spawn } = require('node:child_process');
const path = require('node:path');

// 契约文件清单：全部只能用「环境变量 + HTTP + SQLite 库文件」与目标交互。
// 排除的两个是纯内部实现单元用例：ratelimit.test.js（限流算法）、wbsearch.test.js（检索实现）。
const FILES = [
  'api.test.js',
  'adminpass.test.js',
  'card.test.js',
  'cover.test.js',
  'feedback.test.js',
  'hardening.test.js',
  'hardening-limits.test.js',
  'review.test.js',
  'stats.test.js',
  'tls.test.js',
  'web-bundle.test.js',
  'worldbook-meta.test.js',
];

const env = Object.assign({}, process.env, { CONTRACT: '1' });
const target = env.CONTRACT_CMD || ('(默认) ' + process.execPath + ' --experimental-sqlite src/main.js');

console.log('== 契约测试模式 ==');
console.log('   目标实现：' + target);
console.log('   用例文件：' + FILES.length + ' 个（另有 2 个纯内部单元文件不参与契约模式）');
console.log('');

// 额外参数原样转给 node --test（如 --test-name-pattern=xxx）
const args = ['--experimental-sqlite', '--test', ...process.argv.slice(2), ...FILES.map((f) => path.join(__dirname, f))];
const child = spawn(process.execPath, args, { stdio: 'inherit', env, cwd: path.join(__dirname, '..') });
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code || 0)));
