// 测试夹具：隔离的数据目录 + 随机端口，起一个真实 HTTP 服务供 fetch 回归
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-server-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.APK_DIR = path.join(tmp, 'apk');
process.env.APP_VERSION_FILE = path.join(tmp, 'app-version.json');
process.env.ADMIN_KEY = 'test-admin-key'; // client-logs 查看接口测试用
// 隔离配置：测试环境不读线上 config.json（避免真实 SMTP 发信 / 地区限制影响）
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ smtp: { host: '', port: 465, user: '', pass: '' }, regionBlock: false }));
fs.writeFileSync(process.env.APP_VERSION_FILE, JSON.stringify({ versionCode: 99, versionName: '9.9-test', note: '测试', apk: 'novel-writer-99.apk' }));

const PORT = 13000 + (process.pid % 1000);
process.env.PORT = String(PORT);

const app = require('../src/app');
const db = require('../src/db');

const server = http.createServer(app);

function start() {
  clearLimiters();
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
}
function stop() {
  return new Promise((resolve) => server.close(() => { try { db.close(); } catch (e) {} resolve(); }));
}
const baseUrl = 'http://127.0.0.1:' + PORT;

// 便捷请求
async function req(method, pathname, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(baseUrl + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: r.status, json };
}

// 直接给邮箱发验证码（绕开 SMTP，验证码写入 DB）
function seedCode(email, type, code) {
  db.prepare('INSERT INTO verify_codes (email, code, type, expires_at, created_at, used) VALUES (?, ?, ?, ?, ?, 0)')
    .run(email, code, type, Date.now() + 600000, Date.now());
}

// 限流器清零：测试进程内多次请求会累积计数，跨用例误报 429（每个测试文件独立进程，start 时清一次即可）
function clearLimiters() {
  const limits = require('../src/limits');
  [limits.readLimiter, limits.uploadLimiter, limits.metaLimiter, limits.reviewLimiter].forEach((l) => l.clear());
  const list = [
    require('../src/app')._graceLimiters.authIpLimiter,
    require('../src/routes/auth')._limiters.loginLimiter,
    require('../src/routes/auth')._limiters.codeGuessLimiter,
    require('../src/routes/auth')._limiters.sendCodeLimiter,
    require('../src/routes/auth')._limiters.registerLimiter,
    require('../src/routes/system')._limiters.clLimiter,
    require('../src/routes/system')._limiters.missLimiter,
    require('../src/routes/card')._limiters.likeLimiter,
    require('../src/routes/card')._limiters.commentLimiter,
    require('../src/routes/proxy')._limiters.proxyLimiter,
  ];
  list.forEach((l) => l.clear());
}

/** 审核门测试辅助：把三类内容全部置为已通过。
 *  多数用例关心的是「内容通过审核之后」的行为（列表/社交/检索），审核流程本身由 review.test.js 覆盖。 */
function approveAll() {
  for (const t of ['world_books', 'presets', 'plugins']) {
    try { db.prepare("UPDATE " + t + " SET status = 'approved'").run(); } catch (e) { /* 表不存在时忽略 */ }
  }
}

module.exports = { start, stop, baseUrl, req, seedCode, db, tmp, clearLimiters, approveAll };