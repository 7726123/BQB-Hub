// 管理员口令：接口行为（口令错 401 / 正确 200 / 限流 429 / 未配置 403）+ 留档令牌接口。
// 派生格式 scrypt$N$r$p$salt$hash 属接口契约（线上 config.json 存的就是它）；
// 纯函数与无状态令牌格式属内部实现细节，只在嵌入模式断言（见 CONTRACT.md）。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, req, clearLimiters, adminToken, adminHash, embeddedTest, ADMIN_TEST_PW } = require('./helpers');

const PW = ADMIN_TEST_PW;

before(async () => { await start(); });
after(async () => { await stop(); });

test('口令派生值：契约格式 scrypt$N$r$p$salt$hash；不含明文；同口令不同盐不同值', () => {
  const h1 = adminHash(PW), h2 = adminHash(PW);
  assert.ok(!h1.includes(PW) && !h2.includes(PW));
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  // 同盐可复现：Java 侧对拍（tools/scrypt-parity）依赖的正是这个性质
  const salt = Buffer.from(h1.split('$')[4], 'base64');
  assert.equal(adminHash(PW, salt), h1);
  assert.notEqual(adminHash('other', salt), h1);
});

test('/api/admin/verify：错口令 401、空口令 401、正确 200 带令牌、连续尝试 429', async () => {
  await clearLimiters();
  const post = (body) => req('POST', '/api/admin/verify', { body });

  let r = await post({ password: 'wrong-password' });
  assert.equal(r.status, 401);
  assert.equal(r.json.ok, false);

  r = await post({});
  assert.equal(r.status, 401);

  r = await post({ password: PW });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.ok(r.json.token, '正确口令应签发令牌');

  // 限流：8 次/分钟（上面已用掉 3 次），继续打到超限
  let limited = false;
  for (let i = 0; i < 12; i++) {
    const rr = await post({ password: 'x' });
    if (rr.status === 429) { limited = true; break; }
  }
  assert.equal(limited, true, '连续尝试应触发 429');
});

// 未配置口令 → 403 是部署态开关，只能改运行时配置，属嵌入模式专用
embeddedTest('未配置口令时 /api/admin/verify → 403', async () => {
  await clearLimiters();   // 上面把 verify 的桶打满过，先清桶再断言配置态
  const config = require('../src/config');
  const keep = config.adminPasswordHash;
  config.adminPasswordHash = '';
  try {
    const r = await req('POST', '/api/admin/verify', { body: { password: PW } });
    assert.equal(r.status, 403);
  } finally { config.adminPasswordHash = keep; }
});

embeddedTest('adminpass.hashPassword 与契约格式一致（helpers.adminHash 对拍，防格式漂移）', async () => {
  const { hashPassword, verifyPassword, issueToken, verifyToken } = require('../src/adminpass');
  const h1 = hashPassword(PW), h2 = hashPassword(PW);
  assert.ok(!h1.includes(PW) && !h2.includes(PW));
  assert.notEqual(h1, h2);
  assert.match(h1, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.equal(verifyPassword(PW, h1), true);
  assert.equal(verifyPassword(PW, h2), true);
  assert.equal(verifyPassword('wrong', h1), false);
  assert.equal(verifyPassword('', h1), false);
  assert.equal(verifyPassword(PW, ''), false);
  assert.equal(verifyPassword(PW, undefined), false);
  assert.equal(verifyPassword(PW, 'bcrypt$1$2$3$xx$yy'), false);
  assert.equal(verifyPassword(PW, 'scrypt$16384$8$1$@@@$###'), false);
  // 与 helpers.adminHash（契约实现）互认：同盐同口令必须逐字节一致
  const salt = Buffer.from(h1.split('$')[4], 'base64');
  assert.equal(adminHash(PW, salt), h1);

  // 无状态留档令牌（实现细节：签发/校验/过期/换密钥失效）
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

test('留档接口：无令牌 401 / 坏令牌 401 / 令牌可写 / adminKey 可读可清 / HTML 视图', async () => {
  await clearLimiters();   // 上面把 verify 的桶打满过（契约模式靠重启目标进程清桶）
  const ADMIN = await adminToken();
  const body = {
    book: '测试书', round: 3, model: 'test-model', windowChars: 10000, budget: 30000,
    instruction: '让小鞠出场', continuation: '第一段正文……',
    recall: { pieces: [{ head: '旧正文片段', chars: 800, src: '直收' }], chars: 800, candidates: 42 },
  };

  let r = await req('POST', '/api/admin/trace', { body });
  assert.equal(r.status, 401, '无令牌应 401');

  r = await req('POST', '/api/admin/trace', { token: 'bad.token', body });
  assert.equal(r.status, 401, '坏令牌应 401');

  r = await req('POST', '/api/admin/trace', { token: ADMIN, body });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);

  // 读取需要 adminKey（helpers 环境里 ADMIN_KEY=test-admin-key）
  r = await req('GET', '/api/admin/traces?limit=5');
  assert.equal(r.status, 403, '缺 adminKey 应 403');

  r = await req('GET', '/api/admin/traces?limit=5', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.traces.length, 1);
  assert.equal(r.json.traces[0].instruction, '让小鞠出场');
  assert.match(r.json.traces[0].recall_json, /旧正文片段/);

  // HTML 视图（返回 HTML 文本，helpers.req 落到 json 字段里）
  r = await req('GET', '/api/admin/traces?limit=5&format=html', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  assert.match(String(r.json), /管理员模式留档/);
  assert.match(String(r.json), /让小鞠出场/);

  // 清空
  r = await req('DELETE', '/api/admin/traces', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.deleted, 1);
  r = await req('GET', '/api/admin/traces?limit=5', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.json.traces.length, 0);
});
