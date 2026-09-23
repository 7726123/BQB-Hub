// 请求面回归测试：node --test tests/
// 覆盖：健康检查 / 版本 / 注册登录会话 / 频道 / 世界书 CRUD+权限 / 预设 / 聊天历史 / APK / 助手反馈
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, stop, baseUrl, req, seedCode, db, tmp, approveAll } = require('./helpers');

let serverReady;
before(async () => { serverReady = start(); await serverReady; });
after(async () => { await stop(); });

const EMAIL = 'tester@example.com';
const CODE = '123456';
const PASSWORD = 'pass1234';
const USERNAME = '测试者';

test('健康检查 / 与 /api/health', async () => {
  for (const p of ['/', '/api/health']) {
    const r = await req('GET', p);
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
  }
});

test('App 版本接口（读 app-version.json）', async () => {
  const r = await req('GET', '/api/app/version');
  assert.equal(r.status, 200);
  assert.equal(r.json.versionCode, 99);
  assert.equal(r.json.versionName, '9.9-test');
  assert.ok(r.json.apkUrl.includes('/apk/novel-writer-99.apk'));
});

test('未登录访问受保护接口 → 401', async () => {
  const r = await req('GET', '/api/worldbook/list');
  assert.equal(r.status, 401);
  assert.match(r.json.error, /未登录/);
});

test('社区插件市场与代理路由已挂载（回归：App 端改动曾把挂载删掉一次）', async () => {
  const list = await req('GET', '/api/plugin/list');
  assert.equal(list.status, 401);           // 挂载上了才会走到鉴权（未挂载是 404）
  const bad = await req('POST', '/api/proxy/nonexist/v1/chat/completions', { body: {} });
  assert.equal(bad.status, 404);
  assert.match(bad.json.error, /未知代理目标/);
});

test('注册流程：发码(未配置SMTP→500) + 注册 + me + 登出', async () => {
  const send = await req('POST', '/api/auth/send-code', { body: { email: EMAIL } });
  assert.equal(send.status, 500); // 测试环境未配置 SMTP

  seedCode(EMAIL, 'register', CODE);
  const reg = await req('POST', '/api/auth/register', { body: { username: USERNAME, password: PASSWORD, email: EMAIL, code: CODE } });
  assert.equal(reg.status, 200);
  assert.ok(reg.json.token);
  const token = reg.json.token;

  const me = await req('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.json.user.username, USERNAME);

  // 验证码已用：重复注册同码 → 400
  const again = await req('POST', '/api/auth/register', { body: { username: '张三', password: PASSWORD, email: EMAIL, code: CODE } });
  assert.equal(again.status, 400);
});

test('登录 + 错误密码 401', async () => {
  const ok = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token);
  const bad = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: 'wrong-pwd' } });
  assert.equal(bad.status, 401);
});

test('退出登录后 token 失效', async () => {
  const login = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const token = login.json.token;
  const out = await req('POST', '/api/auth/logout', { token });
  assert.equal(out.status, 200);
  const me = await req('GET', '/api/auth/me', { token });
  assert.equal(me.status, 401);
});

test('世界书：上传→列表→详情→下载计数→删除', async () => {
  const login = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const token = login.json.token;
  const content = JSON.stringify({ name: '测试世界', entries: [] });
  const up = await req('POST', '/api/worldbook/upload', { token, body: { title: '测试世界书', category: '测试', content, cover: '' } });
  assert.equal(up.status, 200);
  const id = up.json.id;
  approveAll(); // 审核门：本用例测的是通过之后的 CRUD，直接置为已通过

  const list = await req('GET', '/api/worldbook/list', { token });
  assert.equal(list.status, 200);
  assert.ok(list.json.items.some((i) => i.id === id));
  // 分页过滤
  const filt = await req('GET', '/api/worldbook/list?q=不存在xx', { token });
  assert.ok(!filt.json.items.some((i) => i.id === id));

  const detail = await req('GET', '/api/worldbook/detail?id=' + id, { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.item.title, '测试世界书');

  const dl = await req('GET', '/api/worldbook/download?id=' + id, { token });
  assert.equal(dl.status, 200);
  assert.equal(dl.json.name, '测试世界');
  const after = await req('GET', '/api/worldbook/detail?id=' + id, { token });
  assert.equal(after.json.item.downloads, 1);

  // 非法内容 → 400
  const badJson = await req('POST', '/api/worldbook/upload', { token, body: { title: 'x', category: '测试', content: 'not-json' } });
  assert.equal(badJson.status, 400);

  const del = await req('DELETE', '/api/worldbook/delete?id=' + id, { token });
  assert.equal(del.status, 200);
  const gone = await req('GET', '/api/worldbook/detail?id=' + id, { token });
  assert.equal(gone.status, 404);
});

test('世界书删除权限：非作者 → 403', async () => {
  const login = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const token = login.json.token;
  const up = await req('POST', '/api/worldbook/upload', { token, body: { title: '别人的书', category: '测试', content: '{"a":1}' } });
  const id = up.json.id;

  const other = await req('POST', '/api/auth/register', { body: { username: '路人甲', password: PASSWORD, email: 'other@example.com', code: '654321' } });
  assert.equal(other.status, 400); // 无验证码
  seedCode('other@example.com', 'register', '654321');
  const other2 = await req('POST', '/api/auth/register', { body: { username: '路人甲', password: PASSWORD, email: 'other@example.com', code: '654321' } });
  assert.equal(other2.status, 200);

  const del = await req('DELETE', '/api/worldbook/delete?id=' + id, { token: other2.json.token });
  assert.equal(del.status, 403);
});

test('预设：上传→列表→详情→删除', async () => {
  const login = await req('POST', '/api/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  const token = login.json.token;
  const up = await req('POST', '/api/preset/upload', { token, body: { title: '测试预设', category: '测试', content: '{"p":1}' } });
  assert.equal(up.status, 200);
  const id = up.json.id;
  approveAll(); // 审核门：同上
  const list = await req('GET', '/api/preset/list', { token });
  assert.ok(list.json.items.some((i) => i.id === id));
  const detail = await req('GET', '/api/preset/detail?id=' + id, { token });
  assert.equal(detail.json.item.title, '测试预设');
  const dl = await req('GET', '/api/preset/download?id=' + id, { token });
  assert.equal(dl.status, 200);
  const del = await req('DELETE', '/api/preset/delete?id=' + id, { token });
  assert.equal(del.status, 200);
});

test('APK 下载：非法文件名 400 / 不存在 404', async () => {
  const bad = await req('GET', '/apk/..%2f..%2fetc%2fpasswd');
  assert.equal(bad.status, 400);
  const nf = await req('GET', '/apk/nonexist.apk');
  assert.equal(nf.status, 404);
  const nf2 = await req('GET', '/apk/nonexist.apk');
  assert.equal(nf2.status, 404);
});

test('使用助手反馈：空会话 400，有效会话落盘 jsonl', async () => {
  const empty = await req('POST', '/api/usage-assistant/miss', { body: { conversation: [] } });
  assert.equal(empty.status, 400);
  const ok = await req('POST', '/api/usage-assistant/miss', {
    body: { conversation: [{ role: 'user', content: '怎么新建世界书？' }, { role: 'assistant', content: '【手册未覆盖】我不确定' }] }
  });
  assert.equal(ok.status, 200);
  const file = path.join(tmp, 'assistant-misses.jsonl');
  assert.ok(fs.existsSync(file));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.conversation[1].content, '【手册未覆盖】我不确定');
});

test('未知路径 → 404 JSON', async () => {
  const r = await req('GET', '/api/definitely-not-exist');
  assert.equal(r.status, 404);
  assert.match(r.json.error, /未找到/);
});

test('非法 JSON body → 400', async () => {
  const r = await fetch(baseUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json'
  });
  assert.equal(r.status, 400);
});
// ===== 客户端错误上报（/api/client-logs）=====
test('客户端错误上报：POST 写入 + 空载荷 400', async () => {
  const _t0 = Date.now();
  const ok = await req('POST', '/api/client-logs', { body: { logs: [
    { t: _t0, k: '脚本错误', m: 'boom: cannot read x of undefined' },
    { t: _t0 + 1000, k: '写卡发送', m: 'CardWriterChat is not defined' } // 时间戳错开，保证 DESC 排序确定性
  ] } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.equal(ok.json.stored, 2);

  const empty = await req('POST', '/api/client-logs', { body: { logs: [] } });
  assert.equal(empty.status, 400);

  const junk = await req('POST', '/api/client-logs', { body: { logs: [{ k: '', m: '' }] } });
  assert.equal(junk.status, 400);
});

test('客户端错误上报：查看需 admin key（未带 403 / 正确 200 且含写入条目）', async () => {
  const denied = await req('GET', '/api/client-logs');
  assert.equal(denied.status, 403);

  const wrong = await req('GET', '/api/client-logs');
  assert.equal(wrong.status, 403);

  const r = await fetch(baseUrl + '/api/client-logs?limit=10', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.logs) && j.logs.length >= 2);
  assert.equal(j.logs[0].kind, '写卡发送'); // 按 ts DESC，最近写入在前
  assert.ok(typeof j.logs[0].msg === 'string' && j.logs[0].msg.length > 0);
});
