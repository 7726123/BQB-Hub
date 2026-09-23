// 管理员口令：派生/校验纯函数 + /api/admin/verify 接口行为（未配置 403 / 口令错 401 / 正确 200 / 限流 429）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// 与 helpers 同款隔离（这里单独起环境，避免与 api.test 共享限流状态）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-admin-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.APK_DIR = path.join(tmp, 'apk');
process.env.APP_VERSION_FILE = path.join(tmp, 'app-version.json');
process.env.ADMIN_KEY = 'test-admin-key';
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ smtp: {}, regionBlock: false }));
fs.writeFileSync(process.env.APP_VERSION_FILE, JSON.stringify({ versionCode: 1, versionName: '1.0', apk: 'a.apk' }));
process.env.PORT = String(15900 + (process.pid % 90));

const { hashPassword, verifyPassword, issueToken, verifyToken } = require('../src/adminpass');
const app = require('../src/app');
const http = require('node:http');
const server = http.createServer(app);
const PORT = Number(process.env.PORT);
const base = 'http://127.0.0.1:' + PORT;

const PW = 'pw-for-test-9f3a';
const HASH = hashPassword(PW);

before(() => new Promise((r) => server.listen(PORT, '127.0.0.1', r)));
after(() => new Promise((r) => server.close(() => r())));

test('派生值不含明文；同口令不同盐派生出不同值', () => {
  const h1 = hashPassword(PW), h2 = hashPassword(PW);
  assert.ok(!h1.includes(PW) && !h2.includes(PW));
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(verifyPassword(PW, h1), true);
  assert.equal(verifyPassword(PW, h2), true);
});

test('verifyPassword：错误口令 / 空值 / 异常格式一律 false', () => {
  assert.equal(verifyPassword('wrong', HASH), false);
  assert.equal(verifyPassword('', HASH), false);
  assert.equal(verifyPassword(PW, ''), false);
  assert.equal(verifyPassword(PW, undefined), false);
  assert.equal(verifyPassword(PW, 'bcrypt$1$2$3$xx$yy'), false);
  assert.equal(verifyPassword(PW, 'scrypt$16384$8$1$@@@$###'), false);
});

test('未配置口令时接口 403；配置后：错口令 401、正确 200、超限 429', async () => {
  const post = (body) => fetch(base + '/api/admin/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });

  // 未配置（helpers 用的隔离 config 里没有 adminPasswordHash）
  let r = await post({ password: PW });
  assert.equal(r.status, 403);

  // 配置后（直接改内存里的 config 对象，路由每次读取）
  const config = require('../src/config');
  config.adminPasswordHash = HASH;

  r = await post({ password: 'wrong-password' });
  assert.equal(r.status, 401);
  assert.equal((await r.json()).ok, false);

  r = await post({});
  assert.equal(r.status, 401);

  r = await post({ password: PW });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);

  // 限流：8 次/分钟。前两次已用掉 2 次（错口令 + 空口令 + 正确 1 次 = 3 次），继续打到超限
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const rr = await post({ password: 'x' });
    if (rr.status === 429) { limited = true; break; }
  }
  assert.equal(limited, true, '连续尝试应触发 429');
});

test('留档令牌：签发/校验/过期/换密钥失效', async () => {
  const h = hashPassword('token-test-pw');
  const t = issueToken(h);
  assert.ok(t && t.token && t.exp > Date.now());
  assert.equal(verifyToken(h, t.token), true);
  assert.equal(verifyToken(h, t.token.slice(0, -1) + 'x'), false);
  assert.equal(verifyToken(hashPassword('another'), t.token), false);
  assert.equal(verifyToken(h, ''), false);
  assert.equal(verifyToken('', t.token), false);
  const short = issueToken(h, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(verifyToken(h, short.token), false, '过期令牌必须拒绝');
});

test('留档接口：无令牌 401 / 令牌可写 / adminKey 可读可清 / 未配置 adminKey 403', async () => {
  const config = require('../src/config');
  config.adminPasswordHash = HASH;
  const token = issueToken(HASH).token;
  const body = JSON.stringify({
    book: '测试书', round: 3, model: 'test-model', windowChars: 10000, budget: 30000,
    instruction: '让小鞠出场', continuation: '第一段正文……',
    recall: { pieces: [{ head: '旧正文片段', chars: 800, src: '直收' }], chars: 800, candidates: 42 },
  });

  let r = await fetch(base + '/api/admin/trace', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  assert.equal(r.status, 401, '无令牌应 401');

  r = await fetch(base + '/api/admin/trace', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad.token' }, body });
  assert.equal(r.status, 401, '坏令牌应 401');

  r = await fetch(base + '/api/admin/trace', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);

  // 读取需要 adminKey（本测试进程 env ADMIN_KEY=test-admin-key）
  r = await fetch(base + '/api/admin/traces?limit=5');
  assert.equal(r.status, 403, '缺 adminKey 应 403');

  r = await fetch(base + '/api/admin/traces?limit=5', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.traces.length, 1);
  assert.equal(j.traces[0].instruction, '让小鞠出场');
  assert.match(j.traces[0].recall_json, /旧正文片段/);

  // HTML 视图
  r = await fetch(base + '/api/admin/traces?limit=5&format=html', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /管理员模式留档/);
  assert.match(html, /让小鞠出场/);

  // 清空
  r = await fetch(base + '/api/admin/traces', { method: 'DELETE', headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).deleted, 1);
  r = await fetch(base + '/api/admin/traces?limit=5', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal((await r.json()).traces.length, 0);
});
