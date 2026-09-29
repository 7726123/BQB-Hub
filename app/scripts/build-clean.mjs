// 干净版（离线版）网页包构建：把同一份源码编成"没有我方服务器"的那一份。
//
// 产物形态（刻意做成 web/ 的整棵镜像，两个版本共用一份 index.html —— 2289 行 HTML 复制成两份必然漂移）：
//   web-clean/index.html、web-clean/assets/**、manifest.json   与 web/ 完全相同
//   web-clean/modules/main.js                                  干净版单 bundle
//                                                              （esbuild --define:__BQB_CLEAN__=true，
//                                                               各联网模块在 isClean() 处早退）
//   web-clean/version.json                                     干净版自己的版本号（「关于」页显示用）
//
// 若已生成 android-clean/（先跑 node scripts/make-android-clean.mjs），
// 顺带把 web-clean/ 拷进它的 assets/public —— 干净版 APK 的网页资源。
//
// 用法：node scripts/build-clean.mjs   （等价：cd app && npm run sync:legacy:clean）
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const WEB = path.join(REPO_ROOT, 'web');
const WEB_CLEAN = path.join(REPO_ROOT, 'web-clean');
const ANDROID_CLEAN = path.join(REPO_ROOT, 'android-clean');
const ANDROID_CLEAN_PUBLIC = path.join(ANDROID_CLEAN, 'app', 'src', 'main', 'assets', 'public');

/** 干净版版本号：取自 android-clean 的 build.gradle（还没生成时用 1.0.0/1）。 */
function readCleanVersion() {
  let versionName = '1.0.0';
  let versionCode = 1;
  try {
    const src = fs.readFileSync(path.join(ANDROID_CLEAN, 'app', 'build.gradle'), 'utf8');
    const n = /versionName\s+"([^"]+)"/.exec(src);
    const c = /versionCode\s+(\d+)/.exec(src);
    if (n) versionName = n[1];
    if (c) versionCode = parseInt(c[1], 10);
  } catch (e) { /* 还没生成 android-clean：用默认版本号 */ }
  return { versionName, versionCode };
}

if (!fs.existsSync(path.join(WEB, 'index.html'))) {
  console.error('✗ 找不到 web/index.html —— 干净版建立在完整版网页资源之上，请先确认仓库完整');
  process.exit(1);
}

// ① 镜像 web/ → web-clean/（只排除构建产物目录 modules/，其余整棵复制）
fs.rmSync(WEB_CLEAN, { recursive: true, force: true });
fs.mkdirSync(WEB_CLEAN, { recursive: true });
fs.cpSync(WEB, WEB_CLEAN, {
  recursive: true,
  filter: (src) => path.relative(WEB, src).split(path.sep)[0] !== 'modules',
});

// ② 干净版单 bundle
//    minify 不只是省体积：它会做死代码消除，把 server-url.ts 里
//    `const HOST = __BQB_CLEAN__ ? '' : '<服务器地址>'` 的另一支整支删掉——
//    干净版产物里**连服务器地址这个字符串都不存在**（不是"有地址但不调用"）。
const outfile = path.join(WEB_CLEAN, 'modules', 'main.js');
console.log('构建干净版 bundle → web-clean/modules/main.js');
await build({
  entryPoints: [path.join(APP_ROOT, 'src/legacy/main.entry.ts')],
  bundle: true,
  format: 'iife',
  outfile,
  logLevel: 'warning',
  sourcemap: false,
  minify: true,
  define: { __BQB_CLEAN__: 'true' },
});

// ③ 产物自检（三条都过才算干净版成立）
const code = fs.readFileSync(outfile, 'utf8');

/** 产物里的中文会被 esbuild 转义成 \uXXXX（minify 默认 charset=ascii，十六进制大写），两种形式都认。 */
function hasText(text, needle) {
  if (text.includes(needle)) return true;
  const esc = [...needle]
    .map((c) => (c.codePointAt(0) > 127 ? '\\u' + c.codePointAt(0).toString(16).padStart(4, '0') : c))
    .join('');
  return text.toLowerCase().includes(esc.toLowerCase());
}

if (code.includes('__BQB_CLEAN__')) {
  console.error('✗ 产物里仍有未替换的 __BQB_CLEAN__ 标识符：--define 未生效');
  process.exit(1);
}
{
  const serverUrlSrc = fs.readFileSync(path.join(APP_ROOT, 'src/lib/server-url.ts'), 'utf8');
  const ip = /(\d{1,3}(?:\.\d{1,3}){3})/.exec(serverUrlSrc);
  if (ip && code.includes(ip[1])) {
    console.error('✗ 干净版产物里仍有服务器地址 ' + ip[1] + '（常量折叠/死代码消除没生效？）');
    process.exit(1);
  }
}
if (!hasText(code, '十二、联机功能（本版本没有）')) {
  console.error('✗ 产物里没有干净版手册：开关没亮，这份产物其实是完整版');
  process.exit(1);
}

// ④ version.json（干净版自己的版本号；「关于」页显示它）
const ver = readCleanVersion();
fs.writeFileSync(path.join(WEB_CLEAN, 'version.json'),
  JSON.stringify({ versionCode: ver.versionCode, versionName: ver.versionName }), 'utf8');

// ⑤ 有 android-clean 就顺手拷进去（干净版 APK 的网页资源）
let copied = false;
if (fs.existsSync(ANDROID_CLEAN)) {
  fs.rmSync(ANDROID_CLEAN_PUBLIC, { recursive: true, force: true });
  fs.mkdirSync(ANDROID_CLEAN_PUBLIC, { recursive: true });
  fs.cpSync(WEB_CLEAN, ANDROID_CLEAN_PUBLIC, { recursive: true });
  copied = true;
}

const kb = Math.round(fs.statSync(outfile).size / 1024);
console.log('✔ 干净版网页包已生成：web-clean/（bundle ' + kb + ' KB，版本 '
  + ver.versionName + '/' + ver.versionCode + '）');
console.log(copied
  ? '✔ 已同步到 android-clean/app/src/main/assets/public'
  : '（未生成 android-clean/：跑 node scripts/make-android-clean.mjs 后重跑本脚本即会自动同步）');
