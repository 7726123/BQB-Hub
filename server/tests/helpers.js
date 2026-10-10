// 测试夹具：双模式（嵌入 / 契约），详见 tests/CONTRACT.md。
//
// 嵌入模式（默认，npm test）：本进程内 require('../src/app') 起真实 HTTP 服务，DB 直连 ../src/db。
// 契约模式（CONTRACT=1，npm run test:contract）：**不 require 任何 src 模块**，
//   而是 spawn 一个独立目标进程（默认 node src/main.js），只通过
//   「进程 + 环境变量 + HTTP + SQLite 库文件」与目标实现交互。
//   于是同一套用例既能验收现在的 Node 版，也能在换成 Java 版后原样验收
//   （CONTRACT_CMD="java -jar server-java\target\app.jar"）。
//
// 两个模式对用例暴露同一套 API，用例不写模式分支：
//   · db        —— 直连目标使用的 chat.db（前提：数据库仍是 SQLite，见 CONTRACT.md）；
//                  契约模式是跨进程访问，带 busy_timeout。
//   · seedCode / approveAll —— 直写库的后门夹具（验证码、审核直通），两模式同一实现。
//   · clearLimiters() —— 嵌入模式清进程内内存桶；契约模式的等价物是「重启目标进程」
//                  （内存态归零；会话/内容都在库里与磁盘上，不受影响），发过请求才重启。
//   · adminToken(pw) —— 走 HTTP POST /api/admin/verify 取管理员令牌，不再 require src/adminpass。
//   · adminHash(pw)  —— 按约定的存储格式 scrypt$N$r$p$salt$hash 现场派生（格式属契约）。
//   · embeddedTest   —— 纯内部实现的单元用例标记（契约模式下自动 skip）。
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const nodeTest = require('node:test');

const IS_CONTRACT = String(process.env.CONTRACT || '') === '1' || !!process.env.CONTRACT_CMD;
const SERVER_ROOT = path.join(__dirname, '..');
// 目标进程命令行：默认 Node 版；换实现时设 CONTRACT_CMD（例：java -jar server-java/target/app.jar）
const TARGET_CMD = process.env.CONTRACT_CMD
  || JSON.stringify(process.execPath) + ' --experimental-sqlite ' + JSON.stringify(path.join(SERVER_ROOT, 'src', 'main.js'));
const BOOT_TIMEOUT_MS = Number(process.env.CONTRACT_BOOT_MS) || 30000;
// 端口：每个用例文件一个固定值（由文件名决定），不再用 pid 取模——
// 并行跑文件时两个 pid 可能刚好差 1000，取模后会撞同一个端口（EADDRINUSE，2026-10-10 实测）。
const FILE_PORTS = {
  'adminpass.test.js': 15100,
  'api.test.js': 15101,
  'card.test.js': 15102,
  'cover.test.js': 15103,
  'feedback.test.js': 15104,
  'hardening-limits.test.js': 15105,
  'hardening.test.js': 15106,
  'ratelimit.test.js': 15107,
  'review.test.js': 15108,
  'stats.test.js': 15109,
  'wbsearch.test.js': 15110,
  'web-bundle.test.js': 15111,
  'worldbook-meta.test.js': 15112,
  'tls.test.js': 15113,
  'system-key.test.js': 15114,
};
const FILE_NAME = path.basename((require.main && require.main.filename) || 'helpers.js');
const PORT = FILE_PORTS[FILE_NAME] || (15150 + (process.pid % 50));

// ---- 隔离环境（两模式共用一套：嵌入模式由本进程直接读，契约模式随环境变量交给目标进程） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), IS_CONTRACT ? 'novel-contract-' : 'novel-server-test-'));
const paths = {
  data: tmp,
  uploads: path.join(tmp, 'uploads'),
  apk: path.join(tmp, 'apk'),
  appVersionFile: path.join(tmp, 'app-version.json'),
  webBundleDir: path.join(tmp, 'web-bundles'),
  configFile: path.join(tmp, 'config.json'),
};
process.env.DATA_DIR = paths.data;
process.env.UPLOAD_DIR = paths.uploads;
process.env.APK_DIR = paths.apk;
process.env.APP_VERSION_FILE = paths.appVersionFile;
process.env.WEB_BUNDLE_DIR = paths.webBundleDir;
process.env.PORT = String(PORT);
process.env.CONFIG_FILE = paths.configFile;
// 隔离配置：不读线上 config.json（避免真实 SMTP 发信 / 地区限制影响）
// 系统版（内部构建）机器凭据：属接口契约（X-System-Key / X-Install-Id，见 CONTRACT.md「系统版」）
const SYSTEM_TEST_KEY = process.env.SYSTEM_KEY || 'test-system-key-2b7f4c9d1e';
process.env.SYSTEM_KEY = SYSTEM_TEST_KEY;
fs.writeFileSync(paths.configFile, JSON.stringify({ smtp: { host: '', port: 465, user: '', pass: '' }, regionBlock: false, systemKey: SYSTEM_TEST_KEY }));
fs.writeFileSync(paths.appVersionFile, JSON.stringify({ versionCode: 99, versionName: '9.9-test', note: '测试', apk: 'novel-writer-99.apk' }));
// 管理员模式口令：固定测试口令，用例经 HTTP /api/admin/verify 换令牌（不再直接改内存 config）
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'test-admin-key';
const ADMIN_TEST_PW = 'test-admin-pw';
process.env.ADMIN_PW_HASH = process.env.ADMIN_PW_HASH || adminHash(ADMIN_TEST_PW);
// TLS（对应 server/src/tls.js）：HTTP 与 HTTPS 双端口并存，证书不可读时只跑 HTTP。
//   · 契约模式：**启动时用 openssl 现签一张自签证书**喂给目标（临时目录，不进仓库——
//     仓库里放 PEM 私钥会被 GitHub/Gitee 的密钥扫描与 push protection 拦下，而推送是非交互脚本）；
//     TLS 端口 = HTTP 端口 + 1000（按用例文件分配，避免并行互撞），于是 tls.test.js 能真验双端口。
//     外部可用 TLS_CERT_FILE/TLS_KEY_FILE 覆盖测试证书（比如换 PKCS#1 私钥覆盖解析路径）。
//     没有 openssl → 不喂证书，目标只跑 HTTP，tls.test.js 的用例运行时 skip（原因写在跳过信息里）。
//   · 嵌入模式：helpers 不起 TLS 监听，指向不存在的证书（tls.test.js 的用例整组跳过）。
const TLS_PORT = PORT + 1000;
process.env.TLS_PORT = String(TLS_PORT);
const tlsOrigin = 'https://127.0.0.1:' + TLS_PORT;
let tlsReady = false;

/** 现签一张测试自签证书（openssl 缺失/失败则返回 null）；只落在临时目录里 */
function generateTestCert() {
  try {
    const dir = path.join(tmp, 'tls');
    fs.mkdirSync(dir, { recursive: true });
    const cert = path.join(dir, 'test.crt');
    const key = path.join(dir, 'test.key');
    const r = require('node:child_process').spawnSync('openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
        '-days', '2', '-subj', '/CN=localhost',
        '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'],
      { stdio: 'ignore', timeout: 30000, windowsHide: true });
    if (r.status === 0 && fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
  } catch (e) { /* 落到「没有证书」分支 */ }
  return null;
}

/** 契约模式启动前准备证书（返回是否可用） */
function prepareTls() {
  if (!IS_CONTRACT) return false;
  if (process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) return true;
  const fx = generateTestCert();
  if (!fx) return false;
  process.env.TLS_CERT_FILE = fx.cert;
  process.env.TLS_KEY_FILE = fx.key;
  return true;
}

if (!IS_CONTRACT) {
  process.env.TLS_CERT_FILE = paths.configFile + '.no-cert.crt';
  process.env.TLS_KEY_FILE = paths.configFile + '.no-cert.key';
}

/** 管理员口令派生值。存储格式属接口契约（线上 config.json 存的就是它）：scrypt$N$r$p$<salt base64>$<hash base64> */
function adminHash(password, saltBuf) {
  const N = 16384, R = 8, P = 1, KEYLEN = 32, SALT_LEN = 16;
  const salt = saltBuf || crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(Buffer.from(String(password || ''), 'utf8'), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

// ---- 数据库夹具：直连目标使用的库（契约模式要在目标建库之后首次访问时才打开） ----
let _db = null;
function realDb() {
  if (_db) return _db;
  if (IS_CONTRACT) {
    const { DatabaseSync } = require('node:sqlite'); // 需 Node ≥22.5（22.x 要 --experimental-sqlite，运行器已带）
    _db = new DatabaseSync(path.join(paths.data, 'chat.db'));
    try { _db.exec('PRAGMA busy_timeout = 5000'); } catch (e) { /* 驱动不支持则忽略 */ }
  } else {
    _db = require('../src/db');
  }
  return _db;
}
const db = {
  prepare(sql) { return realDb().prepare(sql); },
  exec(sql) { return realDb().exec(sql); },
  close() { try { if (_db && typeof _db.close === 'function') _db.close(); } catch (e) { /* ignore */ } _db = null; },
};

// ---- 目标进程管理（仅契约模式） ----
let server = null;            // 嵌入模式：进程内 HTTP 服务
let child = null;             // 契约模式：目标进程
let childExit = null;
let childLog = [];
let dirty = 0;                // 契约模式：上次清桶以来是否发过请求（决定要不要为清桶而重启）
let fetchPatched = false;
let restartCount = 0;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 命令行切分：支持双/单引号（路径含空格时用得上）；不经过 shell（避免 Windows/Linux 差异与杀不干净）
function tokenize(cmd) {
  const out = []; let cur = ''; let q = null;
  for (const ch of String(cmd)) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) { if (cur) { out.push(cur); cur = ''; } }
    else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function childTail(n) {
  const lines = childLog.join('').split(/\r?\n/).filter(Boolean);
  return lines.slice(-(n || 25)).join('\n');
}

async function spawnTarget() {
  const [bin, ...args] = tokenize(TARGET_CMD);
  childLog = [];
  childExit = null;
  child = spawn(bin, args, { cwd: SERVER_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => childLog.push(d.toString()));
  child.stderr.on('data', (d) => childLog.push(d.toString()));
  child.on('exit', (code, signal) => { childExit = { code, signal }; });
  child.on('error', (e) => { childExit = { error: String((e && e.message) || e) }; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  for (;;) {
    if (childExit) throw new Error('目标进程提前退出（' + JSON.stringify(childExit) + '）：' + TARGET_CMD + '\n--- 目标输出 ---\n' + childTail());
    try {
      const r = await fetch(baseUrl + '/api/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch (e) { /* 还没起来，继续等 */ }
    if (Date.now() > deadline) {
      const log = childTail();
      await killChild();
      throw new Error('目标进程 ' + BOOT_TIMEOUT_MS + 'ms 内未通过 /api/health：' + TARGET_CMD + '\n--- 目标输出 ---\n' + log);
    }
    await sleep(150);
  }
}

async function killChild() {
  const c = child;
  child = null;
  if (!c) return;
  await new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    c.once('exit', done);
    try { c.kill(); } catch (e) { done(); }
    setTimeout(() => { try { c.kill('SIGKILL'); } catch (e) { /* ignore */ } done(); }, 5000).unref();
  });
}

// 契约模式：全局 fetch 记一笔「发过请求」，让 clearLimiters() 知道该不该为清桶重启
function patchFetch() {
  if (fetchPatched) return;
  fetchPatched = true;
  const orig = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    try {
      const u = typeof input === 'string' ? input : ((input && input.url) || '');
      if (String(u).startsWith(baseUrl)) dirty++;
    } catch (e) { /* ignore */ }
    return orig.call(globalThis, input, init);
  };
}

// ---- 启动 / 停止 ----
async function start() {
  if (IS_CONTRACT) {
    tlsReady = prepareTls();   // 先备好测试证书（环境变量要在 spawn 之前就位，目标启动时读）
    db.close();          // 换目标进程时旧连接先放掉
    await spawnTarget();
    patchFetch();
    return;
  }
  if (!server) {
    const app = require('../src/app');
    server = http.createServer(app);
  }
  clearLimitersEmbedded();
  if (server.listening) return;
  try {
    await new Promise((resolve, reject) => {
      const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
      const onOk = () => { server.removeListener('error', onErr); resolve(); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(PORT, '127.0.0.1');
    });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') {
      throw new Error('端口 ' + PORT + ' 被占用（用例文件 ' + FILE_NAME + '）：多半是上一次运行残留的进程没退出。\n'
        + '排查：Windows `netstat -ano | findstr ' + PORT + '` 找到 PID 后 `taskkill /F /PID <pid>`；'
        + 'Linux `ss -ltnp | grep ' + PORT + '`。');
    }
    throw e;
  }
}

/** 契约模式的硬约束：测试进程不得加载任何 src 模块 —— 否则「不偷看实现」的承诺就破了。
 *  在 stop() 时自检：发现加载过 src 就直接失败（详见 tests/CONTRACT.md）。 */
function assertNoSrcLoaded() {
  if (!IS_CONTRACT) return;
  const srcDir = path.join(SERVER_ROOT, 'src') + path.sep;
  const hits = Object.keys(require.cache).filter((p) => p.startsWith(srcDir));
  if (hits.length) {
    throw new Error('契约模式不应加载 src 模块，但发现 ' + hits.length + ' 个：\n' + hits.join('\n'));
  }
}

async function stop() {
  if (IS_CONTRACT) {
    await killChild();
    db.close();
    assertNoSrcLoaded();
    return;
  }
  await new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  db.close();
}

const baseUrl = 'http://127.0.0.1:' + PORT;

// ---- 请求便捷方法 ----
async function req(method, pathname, { token, body, headers } = {}) {
  const r = await fetch(baseUrl + pathname, {
    method,
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {},
      token ? { Authorization: 'Bearer ' + token } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: r.status, json, headers: r.headers };
}

// 直接给邮箱发验证码（绕开 SMTP，验证码写入 DB）
function seedCode(email, type, code) {
  db.prepare('INSERT INTO verify_codes (email, code, type, expires_at, created_at, used) VALUES (?, ?, ?, ?, ?, 0)')
    .run(email, code, type, Date.now() + 600000, Date.now());
}

/** 审核门测试辅助：把三类内容全部置为已通过。
 *  多数用例关心的是「内容通过审核之后」的行为（列表/社交/检索），审核流程本身由 review.test.js 覆盖。 */
function approveAll() {
  for (const t of ['world_books', 'presets', 'plugins']) {
    try { db.prepare("UPDATE " + t + " SET status = 'approved'").run(); } catch (e) { /* 表不存在时忽略 */ }
  }
}

// 管理员令牌：统一走 HTTP（不 require src/adminpass）。同一口令缓存一次。
const _tokenCache = new Map();
async function adminToken(password) {
  const pw = password || ADMIN_TEST_PW;
  if (_tokenCache.has(pw)) return _tokenCache.get(pw);
  const r = await req('POST', '/api/admin/verify', { body: { password: pw } });
  const token = r.json && r.json.token;
  if (r.status !== 200 || !token) {
    throw new Error('取管理员令牌失败：HTTP ' + r.status + ' ' + JSON.stringify(r.json)
      + '（契约要求：POST /api/admin/verify 正确口令 → 200 {ok:true,token}，见 CONTRACT.md）');
  }
  _tokenCache.set(pw, token);
  return token;
}

// ---- 限流桶清零 ----
// 嵌入模式：清进程内所有内存桶（与既有实现一致）。
// 契约模式：重启目标进程（内存桶随进程消失；会话/内容都在库里与磁盘上，不受影响）。
//   只在「上次清桶后确实发过请求」时重启，避免每个文件开头白白重启一次。
function clearLimitersEmbedded() {
  const limits = require('../src/limits');
  [limits.readLimiter, limits.uploadLimiter, limits.metaLimiter, limits.reviewLimiter].forEach((l) => l.clear());
  const groups = [
    require('../src/app')._graceLimiters.authIpLimiter,
    require('../src/routes/auth')._limiters,
    require('../src/routes/system')._limiters,
    require('../src/routes/card')._limiters,
    require('../src/routes/proxy')._limiters,
    require('../src/routes/feedback').__limiters,
  ];
  groups.flatMap((x) => (x && typeof x.clear === 'function' ? [x] : Object.values(x || {})))
    .forEach((l) => { try { l.clear(); } catch (e) { /* ignore */ } });
}

async function clearLimiters() {
  if (!IS_CONTRACT) { clearLimitersEmbedded(); return; }
  if (dirty === 0) return;
  await killChild();
  await spawnTarget();
  dirty = 0;
  restartCount++;
}

/** 契约模式：无条件重启目标进程（内存态归零；会话/内容都在库里与磁盘上，不受影响）。嵌入模式无操作。 */
async function restartTarget() {
  if (!IS_CONTRACT) return;
  db.close();
  await killChild();
  await spawnTarget();
  dirty = 0;
}

/** 运行期改目标配置：契约模式 = 改写 config.json + 重启目标（配置在启动时读取）；
 *  嵌入模式 = 直接改进程内配置对象。用于驱动「部署态开关」类用例（如 systemInstallIds 白名单），
 *  用完请还原，避免影响同文件后续用例。 */
async function updateConfig(patch) {
  const base = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
  fs.writeFileSync(paths.configFile, JSON.stringify(Object.assign(base, patch)));
  if (IS_CONTRACT) { await restartTarget(); return; }
  Object.assign(require('../src/config'), patch);
}

// 纯内部实现的单元用例：契约模式自动 skip（见 CONTRACT.md「排除清单」）
const embeddedTest = IS_CONTRACT
  ? (name, fn) => nodeTest.test(name, { skip: '嵌入模式专用（契约模式下无此实现细节可断言）' }, fn)
  : nodeTest.test;

// 只在契约模式可验的用例（嵌入模式的进程内服务没有独立 TLS 监听）：嵌入模式自动 skip
const contractOnly = IS_CONTRACT
  ? nodeTest.test
  : (name, fn) => nodeTest.test(name, { skip: '契约模式专用（嵌入模式没有独立 TLS 监听）' }, fn);

module.exports = {
  isContract: IS_CONTRACT,
  targetCmd: TARGET_CMD,
  embeddedTest,
  contractOnly,
  start, stop, baseUrl, req,
  tlsOrigin, TLS_PORT,
  tlsAvailable: () => tlsReady,
  tmp, paths, db,
  seedCode, approveAll, clearLimiters, updateConfig, restartTarget,
  adminHash, adminToken, ADMIN_TEST_PW, SYSTEM_TEST_KEY,
  restartCount: () => restartCount,
};
