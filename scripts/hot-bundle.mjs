// 热更新包打包 + 签名（网页包，无需装 APK 即可更新 web/ 资源）。
//
// 安全模型（本脚本是整条链的源头，改动前先读这段）：
//   - 客户端只信任「payload」（一段规范化文本）与「sig」（RSA-SHA256 签名）；
//     payload 里含每个文件的 sha256、包版本、最低 APK 版本要求与 zip 的 sha256。
//   - 私钥离线保管（keys/hot-bundle.key，已被 .gitignore 覆盖），公钥硬编码在 APK 里；
//     泄露私钥 = 任何人可向全部用户下发任意 JS（见交接文档「热更新」章节）。
//   - payload 用「LF 分隔的 key=value 行」而非 JSON：跨语言（JS/Java）逐字节可复现，
//     避免 canonical JSON 的坑。路径放在每行最后，因此路径里允许出现 `=` 与空格。
//
// 用法：
//   node scripts/hot-bundle.mjs keygen                        生成密钥对（私钥落盘，公钥打印）
//   node scripts/hot-bundle.mjs pack [选项]                    打包并签名（默认写出到 server/web-bundles/）
//   node scripts/hot-bundle.mjs promote [--out dir]            beta → 正式：把 manifest-beta.json 提升为 manifest.json
//   node scripts/hot-bundle.mjs verify <manifest.json> [zip]   校验签名与 zip/文件哈希
// 选项：--version <v>  --min-native <code>  --code <n>  --channel <stable|beta>  --out <dir>  --key <path>  --force
//
// 渠道（系统版内测，见交接文档「系统版」）：
//   pack --channel beta → 写 manifest-beta.json（beta 的 zip 与正式包同目录平铺，共享同一个 code 序列）；
//   服务端只对带系统版凭据的请求下发 manifest-beta.json，普通用户永远拿 manifest.json。
//   验收满意后 promote：把 beta manifest 原样拷成正式 manifest（同一签名产物，build once → promote）。
//   注意：客户端拒绝降级（code 必须严格递增），promote 会拦下「beta code ≤ 正式 code」。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
let WEB_DIR = path.join(root, 'web');
let ASSETS_DIR = path.join(root, 'android', 'app', 'src', 'main', 'assets', 'public');
const DEFAULT_OUT = path.join(root, 'server', 'web-bundles');
const DEFAULT_KEY = path.join(root, 'keys', 'hot-bundle.key');

// ===== 规范化 payload =====
// 格式（LF 连接、末尾无换行）：
//   hotbundle-v1
//   v=<包版本，形如 1.5.97.5>（第 4 段 = 第几次热更新；历史包用过 wN 老格式，序号连续）
//   code=<整数，必须严格递增（客户端拒绝降级）>
//   minNative=<能安装此包的最低 APK versionCode>
//   zip=<zip 文件名>
//   zipSha256=<hex>
//   file=<sha256hex> <字节数> <相对路径>      ← 按路径字节序排序，每个文件一行
const PAYLOAD_MAGIC = 'hotbundle-v1';

export function buildPayload(meta, files) {
  const lines = [
    PAYLOAD_MAGIC,
    'v=' + meta.v,
    'code=' + String(meta.code),
    'minNative=' + String(meta.minNative),
    'zip=' + meta.zip,
    'zipSha256=' + meta.zipSha256,
  ];
  const sorted = files.slice().sort((a, b) => Buffer.compare(Buffer.from(a.p), Buffer.from(b.p)));
  for (const f of sorted) {
    if (/[\r\n]/.test(f.p)) throw new Error('文件路径含换行，无法签名：' + f.p);
    lines.push('file=' + f.h + ' ' + String(f.s) + ' ' + f.p);
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ===== 最小 zip 写入（固定时间戳 → 同内容同哈希，便于复现）=====
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const DOS_DATE = 0x0021; // 1980-01-01
const DOS_TIME = 0x0000;

export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const e of entries.slice().sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0x0800, 6);          // flag: UTF-8 名
    local.writeUInt16LE(8, 8);               // method: deflate
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);                 // version made by
    cd.writeUInt16LE(20, 6);                 // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(0, 42);                 // 本地头偏移
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(central.length / 2, 8);
  eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

// ===== 工具 =====
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir, out = []) {
  for (const name of fs.readdirSync(dir).sort()) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    else opts._.push(a);
  }
  return opts;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

// ===== 子命令 =====
function keygen(opts) {
  const keyPath = String(opts.key || DEFAULT_KEY);
  if (fs.existsSync(keyPath) && !opts.force) {
    console.error('✘ 私钥已存在，拒绝覆盖：' + keyPath);
    console.error('  换新密钥会让「装过旧 APK 的用户」再也收不到热更新（必须重新发 APK），');
    console.error('  确实要换请显式加 --force。');
    process.exit(1);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  // 公钥可入库/可分发（verify 子命令与 Java 自测都要用）；私钥才需要保管
  fs.writeFileSync(keyPath.replace(/\.key$/, '') + '.pub.pem', publicKey, 'utf8');
  const der = crypto.createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  const b64 = der.toString('base64');
  console.log('✔ 私钥已生成：' + keyPath + '（已被 .gitignore 覆盖，务必离线备份）');
  console.log('  指纹(SHA-256)：' + sha256(der));
  console.log('');
  console.log('把下面两行贴进 android/app/src/main/java/com/novelwriter/app/HotBundlePlugin.java：');
  console.log('  private static final String PUBLIC_KEY_B64 =');
  console.log('      "' + b64 + '";');
  return 0;
}

function pack(opts) {
  const outDir = path.resolve(String(opts.out || DEFAULT_OUT));
  const keyPath = path.resolve(String(opts.key || DEFAULT_KEY));
  if (!fs.existsSync(keyPath)) {
    console.error('✘ 找不到签名私钥：' + keyPath + '\n  先执行：node scripts/hot-bundle.mjs keygen');
    return 1;
  }
  const bundleName = path.join(WEB_DIR, 'modules', 'main.js');
  if (!fs.existsSync(bundleName)) {
    console.error('✘ 缺少 ' + bundleName + '\n  先构建：cd app && npm run sync:legacy');
    return 1;
  }
  const webVersion = readJson(path.join(WEB_DIR, 'version.json'));
  const appVerCode = Number(webVersion.versionCode) || 0;
  const appVerName = String(webVersion.versionName || '');
  if (!appVerCode) { console.error('✘ web/version.json 里没有 versionCode'); return 1; }

  // 包版本号：<APK 版本名>.<序号>（如 1.5.97.5），序号按 out 目录里已有的同名包自动 +1。
  // 用普通版本号而不是 1.5.97w5 之类的专用命名——用户要求"不要叫网页包，就正常的版本号"
  // （热更新不改 APK 版本号，这个第四段只表示"第几次热更新"，历史包用的是 wN 老格式，一并计入序号）。
  let v = opts.version ? String(opts.version) : '';
  if (!v) {
    let n = 0;
    const esc = appVerName.replace(/\./g, '\\.');
    try {
      for (const f of fs.readdirSync(outDir)) {
        const m = new RegExp('^web-' + esc + '(?:w|\\.)(\\d+)\\.zip$').exec(f);
        if (m) n = Math.max(n, parseInt(m[1], 10));
      }
    } catch (e) { /* 目录不存在 → 第 1 次 */ }
    v = appVerName + '.' + (n + 1);
  }
  const seq = parseInt((/(?:w|\.)(\d+)$/.exec(v) || [])[1] || '1', 10);
  const code = Number(opts.code) || (appVerCode * 1000 + seq);
  const minNative = Number(opts['min-native']) || appVerCode;

  // 文件清单：与 APK 内置资源逐字节相同的文件不进包（客户端安装时会从 APK 资源补齐），
  // 但只允许 assets/** 与 version.json 被排除——其余一律进包，否则「包里没有、客户端资源里也没有」
  // 会直接 404（version.json 必须留在 APK 侧：它决定 APK 更新提示，热包改掉它会让用户收不到新 APK）。
  const excluded = [];
  const entries = [];
  const files = [];
  for (const rel of walk(WEB_DIR)) {
    const buf = fs.readFileSync(path.join(WEB_DIR, rel));
    const canExclude = rel === 'version.json' || rel.startsWith('assets/');
    const assetPath = path.join(ASSETS_DIR, rel);
    let identical = false;
    if (canExclude && fs.existsSync(assetPath)) {
      try { identical = fs.readFileSync(assetPath).equals(buf); } catch (e) { identical = false; }
    }
    if (identical) { excluded.push(rel); continue; }
    entries.push({ name: rel, data: buf });
    files.push({ p: rel, s: buf.length, h: sha256(buf) });
  }
  if (excluded.includes('version.json') === false) {
    console.warn('⚠ version.json 与 APK 内置资源不一致——热包会带上它，可能影响新 APK 的更新提示。');
    console.warn('  正常流程：先 npm run sync:legacy → bump → npx cap copy android，再打包。');
  }
  if (!files.some((f) => f.p === 'index.html')) { console.error('✘ web/index.html 缺失，拒绝打包'); return 1; }
  if (!excluded.some((p) => p === 'version.json')) { console.error('✘ version.json 未排除，拒绝打包'); return 1; }

  const zipBuf = buildZip(entries);
  const zipName = 'web-' + v + '.zip';
  const payload = buildPayload({ v, code, minNative, zip: zipName, zipSha256: sha256(zipBuf) }, files);
  const priv = fs.readFileSync(keyPath, 'utf8');
  const sig = crypto.createSign('sha256').update(payload).sign(priv);

  // 渠道：stable（默认，写 manifest.json）或 beta（系统版内测，写 manifest-beta.json）。
  // zip 一律与正式包同目录平铺（客户端从签名 payload 里取 zip 名 → 原生无需区分渠道）。
  const channel = String(opts.channel || 'stable').toLowerCase();
  if (channel !== 'stable' && channel !== 'beta') {
    console.error('✘ --channel 只支持 stable / beta，收到：' + opts.channel);
    return 1;
  }
  const manName = channel === 'beta' ? 'manifest-beta.json' : 'manifest.json';

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, zipName), zipBuf);
  const manifest = {
    payload: payload.toString('base64'),
    sig: sig.toString('base64'),
    v, code, minNative,   // 仅便于人工核对；客户端只信 payload（这两个字段不入签名）
    channel,
    built: new Date().toISOString(),
    apkVersionName: appVerName,
    apkVersionCode: appVerCode,
  };
  fs.writeFileSync(path.join(outDir, manName), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const rawTotal = entries.reduce((n, e) => n + e.data.length, 0);
  console.log('✔ 热更新包已生成：' + v + '（code ' + code + '，最低 APK ' + minNative + '，渠道 ' + channel + '）');
  console.log('  zip      : ' + zipName + '  ' + zipBuf.length + ' 字节（未压缩 ' + rawTotal + ' 字节，'
    + entries.length + ' 个文件）');
  console.log('  zipSha256: ' + sha256(zipBuf));
  console.log('  排除（与 APK 资源相同，客户端自动从 APK 补齐）：'
    + (excluded.length ? excluded.length + ' 个，如 ' + excluded.slice(0, 3).join(', ') : '无'));
  console.log('  输出目录 : ' + outDir + '（' + manName + '）');
  console.log('  下一步：把 ' + zipName + ' 与 ' + manName + ' 传到服务器 web-bundles 目录。');
  if (channel === 'beta') console.log('  注意：beta 只对系统版（机器凭据）下发；验收满意后 node scripts/hot-bundle.mjs promote');
  return 0;
}

/**
 * beta → 正式：把 manifest-beta.json 原样提升为 manifest.json（同一签名产物，不重建不重签）。
 * 守卫：① 签名可校验（有公钥时）；② beta code 必须严格大于正式 code（客户端拒绝降级，
 * 否则正式用户装不上）；③ payload 指向的 zip 必须在同目录。
 */
function promote(opts) {
  const outDir = path.resolve(String(opts.out || DEFAULT_OUT));
  const fromPath = path.resolve(String(opts.from || path.join(outDir, 'manifest-beta.json')));
  const toPath = path.resolve(String(opts.to || path.join(outDir, 'manifest.json')));
  let beta = null;
  try { beta = readJson(fromPath); } catch (e) { beta = null; }
  if (!beta || typeof beta.payload !== 'string' || typeof beta.sig !== 'string') {
    console.error('✘ 找不到可用的 beta manifest：' + fromPath + '（先 pack --channel beta）');
    return 1;
  }
  // 签名校验（公钥存在就必须过——防提升一个被改过的/不开源的 manifest）
  const pubPath = opts.pub ? path.resolve(String(opts.pub)) : path.join(root, 'keys', 'hot-bundle.pub.pem');
  if (fs.existsSync(pubPath)) {
    const ok = crypto.createVerify('sha256')
      .update(Buffer.from(beta.payload, 'base64'))
      .verify(fs.readFileSync(pubPath, 'utf8'), Buffer.from(beta.sig, 'base64'));
    if (!ok) { console.error('✘ 拒绝提升：beta manifest 签名校验不过（' + fromPath + '）'); return 1; }
  } else {
    console.warn('⚠ 没找到公钥 ' + pubPath + '，跳过签名校验（只做 code / zip 守卫）');
  }
  let stable = null;
  try { stable = readJson(toPath); } catch (e) { stable = null; }
  const betaCode = Number(beta.code) || 0;
  const stableCode = Number(stable && stable.code) || 0;
  if (!betaCode) { console.error('✘ 拒绝提升：beta manifest 里没有 code'); return 1; }
  if (betaCode <= stableCode) {
    console.error('✘ 拒绝提升：beta code ' + betaCode + ' ≤ 正式 code ' + stableCode
      + '（客户端拒绝降级，正式用户会装不上）');
    return 1;
  }
  const zipName = (/^zip=(.+)$/m.exec(Buffer.from(beta.payload, 'base64').toString('utf8')) || [])[1];
  if (!zipName || !fs.existsSync(path.join(outDir, zipName))) {
    console.error('✘ 拒绝提升：manifest 指向的 zip 不在 ' + outDir + '（' + (zipName || 'payload 里没有 zip=') + '）');
    return 1;
  }
  const man = Object.assign({}, beta, { channel: 'stable', promotedAt: new Date().toISOString() });
  fs.mkdirSync(path.dirname(toPath), { recursive: true });
  fs.writeFileSync(toPath, JSON.stringify(man, null, 2) + '\n', 'utf8');
  console.log('✔ 已提升为正式包：' + beta.v + '（code ' + betaCode + '，此前正式 code ' + stableCode + '）');
  console.log('  ' + fromPath + ' → ' + toPath);
  console.log('  下一步：把 manifest.json 传到服务器 web-bundles 目录覆盖旧文件（zip 已在服务器上就不用重传）。');
  return 0;
}

function verify(opts) {
  const manifestPath = opts._[1];
  if (!manifestPath) { console.error('用法：node scripts/hot-bundle.mjs verify <manifest.json> [zip]'); return 1; }
  const man = readJson(manifestPath);
  const payload = Buffer.from(String(man.payload || ''), 'base64');
  const sig = Buffer.from(String(man.sig || ''), 'base64');
  const pubPath = opts.pub ? path.resolve(String(opts.pub)) : path.join(root, 'keys', 'hot-bundle.pub.pem');
  if (!fs.existsSync(pubPath)) { console.error('✘ 缺少公钥文件 ' + pubPath + '（keygen 时会一并写出）'); return 1; }
  const ok = crypto.createVerify('sha256').update(payload).verify(fs.readFileSync(pubPath, 'utf8'), sig);
  const lines = payload.toString('utf8').split('\n');
  const meta = {};
  const files = [];
  for (const ln of lines) {
    if (ln.startsWith('v=')) meta.v = ln.slice(2);
    else if (ln.startsWith('code=')) meta.code = Number(ln.slice(5));
    else if (ln.startsWith('minNative=')) meta.minNative = Number(ln.slice(10));
    else if (ln.startsWith('zip=')) meta.zip = ln.slice(4);
    else if (ln.startsWith('zipSha256=')) meta.zipSha256 = ln.slice(10);
    else if (ln.startsWith('file=')) {
      const rest = ln.slice(5);
      const sp1 = rest.indexOf(' ');
      const sp2 = rest.indexOf(' ', sp1 + 1);
      files.push({ h: rest.slice(0, sp1), s: Number(rest.slice(sp1 + 1, sp2)), p: rest.slice(sp2 + 1) });
    }
  }
  const zipPath = opts._[2] || path.join(path.dirname(path.resolve(manifestPath)), meta.zip);
  let zipOk = null;
  if (fs.existsSync(zipPath)) zipOk = sha256(fs.readFileSync(zipPath)) === meta.zipSha256;
  console.log('签名      : ' + (ok ? '✔ 通过' : '✘ 不通过'));
  console.log('包版本    : ' + meta.v + '（code ' + meta.code + '，最低 APK ' + meta.minNative + '）');
  console.log('文件      : ' + files.length + ' 个');
  console.log('zip       : ' + meta.zip + (zipOk === null ? '（未找到，跳过）' : (zipOk ? ' 哈希一致 ✔' : ' 哈希不一致 ✘')));
  return (ok && zipOk !== false) ? 0 : 1;
}

// ===== 端到端自测 =====
// 造一份假 web/ + 假「APK 内置资源」→ 真实打包签名 → 交给 Java 侧做真实验签、解包、
// 补齐与攻击样本（篡改/换密钥/zip-slip/穿越路径）验证。这层是热更新的安全边界，
// 必须在桌面 JVM 上可复现（真机只验证"装得上、起得来、能回退"）。
function selftest() {
  const tmp = path.join(os.tmpdir(), 'bqb-hotbundle-selftest');
  fs.rmSync(tmp, { recursive: true, force: true });
  const webDir = path.join(tmp, 'web');
  const assetsDir = path.join(tmp, 'assets', 'public');
  const keyPath = path.join(tmp, 'keys', 'hot-bundle.key');
  const outDir = path.join(tmp, 'out');
  const attackDir = path.join(tmp, 'attack');

  // ① 假 web/：含中文（验证 UTF-8 全链路）、一个不可压缩的"字体"、以及 version.json
  const html = '<!doctype html><html><head><meta charset="utf-8">'
    + '<style>@font-face{font-family:x;src:url(assets/fonts/font.bin)}</style></head>'
    + '<body><h1>中文标题：写卡助手</h1><script src="modules/main.js"></script></body></html>';
  const js = 'var greeting = "你好，世界";\n' + 'var filler = "' + 'x'.repeat(200000) + '";\n';
  const font = crypto.randomBytes(120000);
  writeFixture(webDir, {
    'index.html': html,
    'modules/main.js': js,
    'manifest.json': '{"name":"BQB Hub"}',
    'cordova.js': '// cordova stub',
    'version.json': '{"versionCode":157,"versionName":"1.5.97"}',
    'assets/fonts/font.bin': font,
  });
  // ② 假"APK 内置资源"：与 web/ 完全一致（正常流程下 cap copy 就是这么来的）
  copyDir(webDir, assetsDir);

  // ③ 测试密钥 + 打包签名
  if (keygen({ key: keyPath }) !== 0) return 1;
  const saveWeb = WEB_DIR, saveAssets = ASSETS_DIR;
  WEB_DIR = webDir; ASSETS_DIR = assetsDir;
  const rc = pack({ key: keyPath, out: outDir, version: '1.5.97.9', 'min-native': '157', code: '157999' });
  WEB_DIR = saveWeb; ASSETS_DIR = saveAssets;
  if (rc !== 0) return 1;

  // ④ 攻击/异常样本
  fs.mkdirSync(attackDir, { recursive: true });
  const man = readJson(path.join(outDir, 'manifest.json'));
  const payloadBytes = Buffer.from(man.payload, 'base64');
  const payloadText = payloadBytes.toString('utf8');
  // (a) 改 payload 里的 code（等长替换，签名不动）→ 必须验签失败
  const cm = /code=(\d+)/.exec(payloadText);
  const forged = payloadText.replace('code=' + cm[1], 'code=' + '9'.repeat(cm[1].length));
  fs.writeFileSync(path.join(attackDir, 'forged-code.json'), JSON.stringify({
    payload: Buffer.from(forged, 'utf8').toString('base64'), sig: man.sig, v: man.v, code: 999999,
  }, null, 2));
  // (b) 用另一把密钥签同一份 payload → 必须验签失败
  const otherKey = path.join(attackDir, 'other.key');
  if (keygen({ key: otherKey, force: true }) !== 0) return 1;
  const otherSig = crypto.createSign('sha256').update(payloadBytes).sign(fs.readFileSync(otherKey, 'utf8'));
  fs.writeFileSync(path.join(attackDir, 'wrong-key.json'), JSON.stringify({
    payload: man.payload, sig: otherSig.toString('base64'), v: man.v, code: man.code,
  }, null, 2));
  // (c) 篡改 zip（改中间一个字节）→ 必须哈希不符
  const zipName = fs.readdirSync(outDir).find((f) => f.endsWith('.zip'));
  const zbuf = Buffer.from(fs.readFileSync(path.join(outDir, zipName)));
  const mid = Math.floor(zbuf.length / 2);
  zbuf[mid] = zbuf[mid] ^ 0xFF;
  fs.writeFileSync(path.join(attackDir, 'tampered.zip'), zbuf);
  // (d) zip-slip：条目名带 ../
  fs.writeFileSync(path.join(attackDir, 'zipslip.zip'),
    buildZip([{ name: '../evil.txt', data: Buffer.from('pwned') }]));
  // (e) payload 里列了不存在于 zip 的文件（用真实签名重签，模拟"包内容不全"）
  const { privateKey: privPem } = { privateKey: fs.readFileSync(keyPath, 'utf8') };
  const missingText = payloadText.replace('file=', 'file=' + 'a'.repeat(64) + ' 5 ghost.txt\nfile=')
    .replace('code=' + cm[1], 'code=' + String(Number(cm[1]) + 1));
  const missingSig = crypto.createSign('sha256').update(Buffer.from(missingText, 'utf8')).sign(privPem);
  fs.writeFileSync(path.join(attackDir, 'missing-file.json'), JSON.stringify({
    payload: Buffer.from(missingText, 'utf8').toString('base64'), sig: missingSig.toString('base64'),
  }, null, 2));

  console.log('');
  console.log('=== 交给 Java 侧验证 ===');
  const classes = path.join(tmp, 'classes');
  fs.mkdirSync(classes, { recursive: true });
  const coreSrc = path.join(root, 'android', 'app', 'src', 'main', 'java', 'com', 'novelwriter', 'app', 'HotBundleCore.java');
  const testSrc = path.join(root, 'tools', 'hotbundle-selftest', 'SelfTest.java');
  if (run('javac', ['-encoding', 'UTF-8', '-d', classes, coreSrc, testSrc]) !== 0) {
    console.error('✘ javac 编译失败');
    return 1;
  }
  // 显式 UTF-8：Windows 控制台默认 GBK，会把中文断言输出写成乱码（读日志时会误判）
  const javaRc = run('java', [
    '-Dfile.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-Dsun.stderr.encoding=UTF-8',
    '-cp', classes, 'SelfTest', tmp,
  ]);
  console.log('');
  console.log(javaRc === 0 ? '✔ 自测全部通过（样本目录：' + tmp + '）' : '✘ 自测失败（样本目录：' + tmp + '）');
  return javaRc;
}

function writeFixture(dir, files) {
  for (const [rel, data] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, data);
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const rel of walk(src)) {
    const target = path.join(dst, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(src, rel), target);
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false });
  if (r.error) { console.error('✘ 无法执行 ' + cmd + '：' + r.error.message); return 1; }
  return r.status === null ? 1 : r.status;
}

const opts = parseArgs(process.argv.slice(2));
const cmd = opts._[0];
let rc = 0;
if (cmd === 'keygen') rc = keygen(opts);
else if (cmd === 'pack') rc = pack(opts);
else if (cmd === 'promote') rc = promote(opts);
else if (cmd === 'verify') rc = verify(opts);
else if (cmd === 'selftest') rc = selftest();
else {
  console.log('用法：');
  console.log('  node scripts/hot-bundle.mjs keygen                      生成签名密钥对');
  console.log('  node scripts/hot-bundle.mjs pack [--version v] [--code n] [--min-native c] [--channel stable|beta] [--out dir]');
  console.log('  node scripts/hot-bundle.mjs promote [--out dir] [--from f] [--to f]   beta → 正式（含 code/zip/签名守卫）');
  console.log('  node scripts/hot-bundle.mjs verify <manifest.json> [zip]');
  console.log('  node scripts/hot-bundle.mjs selftest                    端到端自测（造样本 → 打包签名 → Java 真实验签/解包）');
  rc = 1;
}
process.exit(rc);
