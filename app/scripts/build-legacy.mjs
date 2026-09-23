// 遗留模块构建：TS 迁移产物 → web/modules/*.js（全局脚本兼容）。
// 用法：node scripts/build-legacy.mjs [模块名...]（缺省 = 全部已登记模块）
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.resolve(APP_ROOT, '..', 'web');

// 单 bundle 构建（P4 完成态）：全部前端模块合成 modules/main.js。
// 历史：P3 分批 import 化（usage/settingsync/regex/plugins/modelcompat/clientlog/tavern-adapter/
// worldbook/book/protagonist/character/memory/database/variables/summary/update 已停发独立产物，
// 由消费方 import）；archive 因与 bm25 的 ArchiveIndex 互引随本单 bundle 一并合入。
const MODULES = {
  main: { entry: 'src/legacy/main.entry.ts', out: 'modules/main.js' },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODULES);
for (const name of names) {
  const mod = MODULES[name];
  if (!mod) { console.error('未知模块:', name, '（可选:', Object.keys(MODULES).join(', '), '）'); process.exit(1); }
  console.log(`构建 ${name} → web/${mod.out}`);
  await build({
    entryPoints: [path.join(APP_ROOT, mod.entry)],
    bundle: true,
    format: 'iife',
    outfile: path.join(WEB, mod.out),
    logLevel: 'warning',
    // 遗留产物直接进 web（Capacitor 静态目录，webDir=web），保留映射便于调试
    sourcemap: false
  });
}
console.log('✔ 遗留模块产物已生成（如 index.html 缓存戳未变可手动更新 ?v=）');