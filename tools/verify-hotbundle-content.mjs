// 热包内容核对（每次发热包前跑）：解出 zip 里的 modules/main.js，逐条确认本次改动的文案确实进包。
// 注意：esbuild 会把非 ASCII 全部转成 \uXXXX（含 …、全角标点），所以比对要按 [^\x00-\x7F] 全转义。
import fs from 'node:fs';
import zlib from 'node:zlib';

const zipPath = process.argv[2];
if (!zipPath) { console.error('用法：node tools/verify-hotbundle-content.mjs server/web-bundles/web-<版本>.zip'); process.exit(2); }
const zip = fs.readFileSync(zipPath);
const files = {};
for (let i = 0; i + 30 < zip.length; i++) {
  if (zip.readUInt32LE(i) !== 0x04034b50) continue;
  const size = zip.readUInt32LE(i + 18);
  const nLen = zip.readUInt16LE(i + 26);
  const eLen = zip.readUInt16LE(i + 28);
  const name = zip.slice(i + 30, i + 30 + nLen).toString('utf8');
  const data = zip.slice(i + 30 + nLen + eLen, i + 30 + nLen + eLen + size);
  files[name] = zlib.inflateRawSync(data).toString('utf8');
  i += 30 + nLen + eLen + size;
}
const js = files['modules/main.js'] || '';   // 保留：下面提示用
console.log('modules/main.js 解出', js.length, '字节；zip 内条目:', Object.keys(files).join(', '));

const esc = (s) => s.replace(/[^\x00-\x7F]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
// 默认核对项（热包常青内容）；也可以用命令行追加要核对的字符串：
//   node tools/verify-hotbundle-content.mjs <zip> "要核对的字符串" ...
const DEFAULT_CHECKS = [
  'min_20_ai_flavor',
  '看穿与身体反应',
  '收尾停在动作、对白或画面上，不要总结、升华，也不要预告后文。',
  'minimalPresetForceSyncDone',
  'chatCompletionsUrl',
];
const extra = process.argv.slice(3);
const checks = DEFAULT_CHECKS.concat(extra);
const all = Object.entries(files).map(([n, t]) => [n, t]);
let ok = true;
for (const c of checks) {
  const where = all.find(([, t]) => t.includes(c) || t.includes(esc(c)));
  if (!where) ok = false;
  console.log((where ? '✔' : '✘') + ' ' + c + (where ? '  [' + where[0] + ']' : ''));
}
console.log(ok ? '\n全部命中：本次改动已在热包内' : '\n有缺失，不要上传');
process.exit(ok ? 0 : 1);
