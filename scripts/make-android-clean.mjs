// 生成 android-clean/ —— 干净版（离线版）的 Android 工程。
//
// 为什么是"生成"而不是"手工维护第二个工程"：
//   完整版与干净版的差异只有下面这几个点（appId / 版本 / 权限 / 证书锚 / 两个原生插件 / 名称），
//   其余（Gradle 配置、MainActivity 的其它逻辑、资源、cordova 插件壳）与完整版逐字相同。
//   生成器把差异写成一处代码，完整版工程照旧演进，重跑本脚本就同步过去——不会漂移。
//
// 产出的 android-clean/ 是**构建产物**（.gitignore 忽略），随时可删可重建。
//
// 用法：node scripts/make-android-clean.mjs
//   之后：cd app && npm run sync:legacy:clean   （网页包会顺带拷进 android-clean 的 assets/public）
//   打包：cd android-clean && ./gradlew assembleRelease   （需先配好 release 签名，见 docs/离线版构建与上架.md）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(REPO_ROOT, 'android');
const DST = path.join(REPO_ROOT, 'android-clean');

// ===== 干净版的差异点（要改就改这里）=====

/** 独立包名：与完整版共存、独立签名，应用商店里是两个应用。 */
const APP_ID = 'com.bqbhub.app';
/** 干净版自己的版本号（应用商店的首版）。 */
const VERSION_CODE = 1;
const VERSION_NAME = '1.0.0';
/** 应用名（桌面图标下的名字，也是商店里要一致的名称）。改这里要连带确认：软著名称、
 *  App 备案名称、商店列表名称三者与它完全一致（应用名不一致是审核退回的常见原因）。 */
const APP_NAME = 'BQB-Hub';
/** 要摘掉的原生类（文件级删除）：APK 自更新 + 网页包热更新——商店审核的两条红线。 */
const DROP_JAVA = ['UpdateCheckerPlugin.java', 'HotBundlePlugin.java', 'HotBundleCore.java'];

const APP = path.join(DST, 'app');
const MAIN = path.join(APP, 'src', 'main');

function must(p) { if (!fs.existsSync(p)) { console.error('✗ 缺少文件：' + p); process.exit(1); } }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s, 'utf8'); }
function patchRe(file, re, to, { optional = false } = {}) {
  const p = path.join(DST, file);
  const src = read(p);
  if (!re.test(src)) {
    if (optional) return false;
    console.error('✗ 正则补丁没匹配上（完整版工程改过？）：' + file + ' / 正则 ' + String(re));
    process.exit(1);
  }
  write(p, src.replace(re, to));
  return true;
}

function patch(file, from, to, { optional = false } = {}) {
  const p = path.join(DST, file);
  const src = read(p);
  if (src.indexOf(from) < 0) {
    if (optional) return false;
    console.error('✗ 补丁没匹配上（完整版工程改过？）：' + file + '\n  找不到：' + from.slice(0, 80));
    process.exit(1);
  }
  write(p, src.split(from).join(to));
  return true;
}

must(path.join(SRC, 'app', 'build.gradle'));
must(path.join(SRC, 'gradlew'));

// ① 整棵复制（排除构建产物与 IDE 目录；local.properties 要带上，里面有 sdk.dir）
fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });
fs.cpSync(SRC, DST, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(SRC, src);
    if (!rel) return true;
    const seg = rel.split(path.sep);
    if (seg.includes('build') || seg.includes('.gradle') || seg.includes('.idea')) return false;
    return true;
  },
});

// ② 包名 / 版本号
patch('app/build.gradle', 'applicationId "com.novelwriter.app"', 'applicationId "' + APP_ID + '"');
// 版本号用正则改：完整版每发一版都会变（160 → 161 → …），写死字面量下次就匹配不上
patchRe('app/build.gradle', /(versionCode\s+)\d+/, '$1' + VERSION_CODE);
patchRe('app/build.gradle', /(versionName\s+)"[^"]*"/, '$1"' + VERSION_NAME + '"');
// 干净版没有热更新/自更新插件，但保留 release 签名脚手架（BQB_RELEASE_* 从 ~/.gradle/gradle.properties 读）
patch('app/build.gradle',
  '// release 签名配置（本轮不切换，仅供将来发布正式包）：',
  '// release 签名配置（干净版上架必须用 release 签名；密钥只从 ~/.gradle/gradle.properties 读，不入库）：',
  { optional: true });

// ③ 权限：去掉「安装应用包」（那是应用内自更新用的，商店明确禁止引导安装非商店包）
{
  const p = path.join(MAIN, 'AndroidManifest.xml');
  const src = read(p);
  const out = src
    .replace(/\s*<!--[^>]*?-->\s*<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES" \/>\s*/g, '\n')
    .replace(/\s*<uses-permission android:name="android\.permission\.REQUEST_INSTALL_PACKAGES" \/>\s*/g, '\n');
  if (out === src) { console.error('✗ 没找到 REQUEST_INSTALL_PACKAGES（完整版清单改过？）'); process.exit(1); }
  write(p, out);
}

// ④ 网络安全配置：去掉内置自签 CA 与服务器域例外（干净版不连我方服务器）
write(path.join(MAIN, 'res', 'xml', 'network_security_config.xml'), [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<!--',
  '  干净版（离线版）网络安全配置：没有任何我方服务器，因此没有域例外、也没有内置 CA。',
  '  保留 base-config 允许明文：用户自配的模型端点可能是局域网明文',
  '  （http://192.168.x.x:11434 的 Ollama、LM Studio 等），禁掉会直接让这些用户用不了。',
  '  本应用自己的请求只去用户配置的端点，不含任何写死的服务器地址。',
  '-->',
  '<network-security-config>',
  '    <base-config cleartextTrafficPermitted="true">',
  '        <trust-anchors>',
  '            <certificates src="system" />',
  '        </trust-anchors>',
  '    </base-config>',
  '</network-security-config>',
  '',
].join('\n'));

// ⑤ 摘掉内置 CA 证书文件
{
  const ca = path.join(MAIN, 'res', 'raw', 'bqb_ca.crt');
  if (fs.existsSync(ca)) fs.rmSync(ca);
}

// ⑥ 名称
{
  const p = path.join(MAIN, 'res', 'values', 'strings.xml');
  let src = read(p);
  src = src.replace(/(<string name="app_name">)[^<]*(<\/string>)/, '$1' + APP_NAME + '$2');
  src = src.replace(/(<string name="title_activity_main">)[^<]*(<\/string>)/, '$1' + APP_NAME + '$2');
  write(p, src);
}

// ⑦ 删掉两个原生插件（APK 自更新 / 网页包热更新），并摘掉 MainActivity 里的注册
for (const f of DROP_JAVA) {
  const p = path.join(MAIN, 'java', 'com', 'novelwriter', 'app', f);
  if (fs.existsSync(p)) fs.rmSync(p);
}
{
  const p = path.join(MAIN, 'java', 'com', 'novelwriter', 'app', 'MainActivity.java');
  let src = read(p);
  src = src
    .replace(/\s*registerPlugin\(UpdateCheckerPlugin\.class\);.*\r?\n/, '\n')
    .replace(/\s*registerPlugin\(HotBundlePlugin\.class\);.*\r?\n/, '\n');
  if (/registerPlugin\(/.test(src)) { console.error('✗ MainActivity 里还有 registerPlugin 没摘干净'); process.exit(1); }
  write(p, src);
}

// ⑧ 自检：干净版工程里不应再出现这两个插件的类名
{
  const leftovers = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(java|xml|gradle)$/.test(e.name)) continue;
      const s = read(p);
      if (/UpdateCheckerPlugin|HotBundlePlugin|HotBundleCore|REQUEST_INSTALL_PACKAGES|bqb_ca/.test(s)) leftovers.push(path.relative(DST, p));
    }
  };
  walk(DST);
  if (leftovers.length) {
    console.error('✗ 干净版工程里仍有联机/热更残留：' + leftovers.join('、'));
    process.exit(1);
  }
}

console.log('✔ android-clean/ 已生成');
console.log('  · 包名 ' + APP_ID + '，版本 ' + VERSION_NAME + '/' + VERSION_CODE + '，名称「' + APP_NAME + '」');
console.log('  · 已摘掉：REQUEST_INSTALL_PACKAGES 权限、内置自签 CA、' + DROP_JAVA.join(' / '));
console.log('  下一步：cd app && npm run sync:legacy:clean  →  cd android-clean && ./gradlew assembleRelease');
