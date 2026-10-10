// 滥用面加固回归：安全响应头 / 代理限流 / 上传配额 / 列表分页上限 / 封面上限
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, baseUrl, req, seedCode, clearLimiters, embeddedTest } = require('./helpers');

before(async () => { await start(); });
after(async () => { await stop(); });

const EMAIL = 'limits@example.com';
const CODE = '654321';
const PASSWORD = 'pass1234';
let token = '';

async function ensureUser() {
  if (token) return token;
  seedCode(EMAIL, 'register', CODE);
  const r = await req('POST', '/api/auth/register', { body: { username: '限流测试', password: PASSWORD, email: EMAIL, code: CODE } });
  assert.equal(r.status, 200);
  token = r.json.token;
  return token;
}

test('安全响应头：nosniff / DENY / no-referrer', async () => {
  const r = await fetch(baseUrl + '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});

test('代理：白名单外 404（不触发任何上游请求）', async () => {
  await clearLimiters();
  const bad = await req('POST', '/api/proxy/nonexist/v1/chat/completions', { body: {} });
  assert.equal(bad.status, 404);
});

// 白名单内的代理限流（60 次/分钟）只能在嵌入模式验证：原用例用 globalThis.fetch 打桩拦下上游请求，
// 契约模式下目标是独立进程、打桩对它无效——真发 61 次请求到 opencode.ai 是不可接受的副作用（见 CONTRACT.md）。
embeddedTest('代理：白名单内同 IP 超过 60 次/分钟 → 429（上游不发真实请求）', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).startsWith(baseUrl)) return origFetch(url, opts); // helpers.req 自己走真服务
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    await clearLimiters();
    let last = 0;
    for (let i = 0; i < 61; i++) {
      const r = await req('POST', '/api/proxy/opencode/v1/chat/completions', { body: { messages: [] } });
      last = r.status;
    }
    assert.equal(last, 429, '第 61 次应被限流');
  } finally {
    globalThis.fetch = origFetch;
    await clearLimiters();
  }
});

test('世界书上传：每账号每小时 30 次配额（第 31 次 429）', async () => {
  const t = await ensureUser();
  await clearLimiters();
  const content = JSON.stringify({ entries: [{ type: '角色', name: '甲', content: 'x' }] });
  for (let i = 0; i < 30; i++) {
    const r = await req('POST', '/api/worldbook/upload', { token: t, body: { title: '配额' + i, content } });
    assert.equal(r.status, 200, '第 ' + (i + 1) + ' 次应成功');
  }
  const blocked = await req('POST', '/api/worldbook/upload', { token: t, body: { title: '超限', content } });
  assert.equal(blocked.status, 429);
  await clearLimiters();
});

test('封面大小上限 320KB（超出 400）', async () => {
  const t = await ensureUser();
  await clearLimiters();
  const content = JSON.stringify({ entries: [] });
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(330 * 1024);
  const r = await req('POST', '/api/worldbook/upload', { token: t, body: { title: '大封面', content, cover: big } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /封面图片过大/);
  await clearLimiters();
});

test('列表分页上限 50（请求 100 被夹到 50）', async () => {
  const t = await ensureUser();
  await clearLimiters();
  const r = await req('GET', '/api/worldbook/list?pageSize=100', { token: t });
  assert.equal(r.status, 200);
  assert.equal(r.json.pageSize, 50);
});
