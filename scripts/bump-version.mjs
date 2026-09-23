// 版本同步：以 android/app/build.gradle 的 versionCode/versionName 为单一来源，
// 同步 web/version.json、android assets 与 server/app-version.json（保留 note/apk 等额外字段）。
// 注意：APK 内 version.json 取自 android/app/src/main/assets/public/，漏同步会导致
// 装完新版本仍提示更新（v45 事故），故此处必须与 web 一起写入。
// 用法：node scripts/bump-version.mjs [versionName] [versionCode]
//   versionName 可选（缺省只按当前值同步各处）；versionCode 可选（缺省 = 当前 + 1）
// 示例：node scripts/bump-version.mjs 1.2        # versionCode 42, versionName 1.2
//       node scripts/bump-version.mjs            # 仅同步，不升版本
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const gradleFile = path.join(root, 'android', 'app', 'build.gradle');
const webVersion = path.join(root, 'web', 'version.json');
const assetsVersion = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public', 'version.json');
const serverVersion = path.join(root, 'server', 'app-version.json');

const src = fs.readFileSync(gradleFile, 'utf8');
const mCode = src.match(/versionCode\s+(\d+)/);
const mName = src.match(/versionName\s+"([^"]+)"/);
if (!mCode || !mName) {
  console.error('build.gradle 中未找到 versionCode/versionName');
  process.exit(1);
}

let nextCode = parseInt(mCode[1], 10);
let nextName = mName[1];
const argName = process.argv[2];
const argCode = process.argv[3] ? parseInt(process.argv[3], 10) : NaN;

if (argName) nextName = argName;
if (!Number.isNaN(argCode)) nextCode = argCode;
else if (argName) nextCode += 1; // 指定了新版本名 → 版本号 +1

const gradleNext = src
  .replace(/versionCode\s+\d+/, `versionCode ${nextCode}`)
  .replace(/versionName\s+"[^"]+"/, `versionName "${nextName}"`);
fs.writeFileSync(gradleFile, gradleNext);

const webData = { versionCode: nextCode, versionName: nextName };
fs.writeFileSync(webVersion, JSON.stringify(webData), 'utf8');
fs.writeFileSync(assetsVersion, JSON.stringify(webData), 'utf8');

// server/app-version.json：保留原有 note/apk 字段
let serverData = { versionCode: nextCode, versionName: nextName, note: '', apk: `novel-writer-${nextCode}.apk` };
try { serverData = Object.assign(JSON.parse(fs.readFileSync(serverVersion, 'utf8')), { versionCode: nextCode, versionName: nextName }); }
catch (e) { /* 文件不存在则用默认 */ }
fs.writeFileSync(serverVersion, JSON.stringify(serverData, null, 2), 'utf8');

// 前端 bundle 缓存戳：按 main.js 内容哈希写 index.html 的 ?v=（原先手工递增，漏改会出缓存事故）
// 说明：只在 bundle 存在时更新；cap copy 之后无需再动 index.html。
const bundleFile = path.join(root, 'web', 'modules', 'main.js');
const indexFile = path.join(root, 'web', 'index.html');
let stampMsg = '  - web/index.html ?v=（跳过：web/modules/main.js 不存在，先跑 sync:legacy）';
try {
  const buf = fs.readFileSync(bundleFile);
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h << 5) + h + buf[i]) >>> 0;
  const stamp = String(h) + '-' + nextCode;
  const html = fs.readFileSync(indexFile, 'utf8');
  const next = html.replace(/(modules\/main\.js\?v=)[^"']*/g, '$1' + stamp);
  if (next !== html) {
    fs.writeFileSync(indexFile, next, 'utf8');
    stampMsg = '  - web/index.html ?v=' + stamp;
  } else {
    stampMsg = '  - web/index.html ?v=（未找到 modules/main.js?v= 引用）';
  }
} catch (e) {
  stampMsg = '  - web/index.html ?v=（跳过：' + e.message + '）';
}

console.log(`✔ 版本已同步：${nextName} (versionCode ${nextCode})`);
console.log(`  - android/app/build.gradle`);
console.log(`  - web/version.json`);
console.log(`  - android/app/src/main/assets/public/version.json`);
console.log(`  - server/app-version.json (apk 指向 ${serverData.apk})`);
console.log(stampMsg);
console.log(`下一步：构建 APK 后上传到服务器的 APK 目录（见本地部署文档）并确认字节一致。`);