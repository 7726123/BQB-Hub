// 审核门回归：新上传一律「待审」——不进公开列表 / 检索 / 详情 / 预览 / 下载，也不能被点赞评论；
// 管理员通过后才公开，驳回保留记录（作者可见并可自行删除）；管理员自己上传直接公开；审核动作写 review_log。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, baseUrl, req, seedCode, db, adminToken } = require('./helpers');

const U1 = 'rvwuser1', U2 = 'rvwuser2';
const PW = 'pass1234', CODE = '246810';
let ADMIN = '';

before(async () => {
  await start();
  ADMIN = await adminToken();               // 走 HTTP 取管理员令牌（见 CONTRACT.md）
  for (const u of [U1, U2]) {
    seedCode(u + '@example.com', 'register', CODE);
    const r = await req('POST', '/api/auth/register', { body: { username: u, password: PW, email: u + '@example.com', code: CODE } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
});
after(async () => { await stop(); });

async function login(u) {
  const r = await req('POST', '/api/auth/login', { body: { email: u + '@example.com', password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}

/** 带管理员令牌的原始请求（helpers.req 只支持 Authorization；管理员上传两者都要） */
async function adminReq(method, pathname, body, userToken) {
  const headers = { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN };
  if (userToken) headers.Authorization = 'Bearer ' + userToken;
  const r = await fetch(baseUrl + pathname, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = text; }
  return { status: r.status, json };
}

function wbContent(title) {
  return JSON.stringify({ title, entries: [{ type: '角色', name: '甲', content: '说明' }] });
}
function uploadWb(token, title) {
  return req('POST', '/api/worldbook/upload', { token, body: { title, description: '', category: '综合', content: wbContent(title) } });
}
function uidOf(name) { return db.prepare('SELECT id FROM users WHERE username = ?').get(name).id; }

test('新上传默认待审：公开路径看不到，作者在「我的投稿」能看到', async () => {
  const t1 = await login(U1), t2 = await login(U2);
  const up = await uploadWb(t1, '待审世界书A');
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.status, 'pending');
  const id = up.json.id;

  assert.ok(!(await req('GET', '/api/worldbook/list', { token: t2 })).json.items.some((i) => i.id === id), '别人的列表不该出现待审稿');
  assert.ok(!(await req('GET', '/api/worldbook/list', { token: t1 })).json.items.some((i) => i.id === id), '公开列表只列已通过（作者自己的待审稿也不列）');
  const srch = await req('GET', '/api/worldbook/search?q=' + encodeURIComponent('待审世界书A'), { token: t2 });
  assert.ok(!srch.json.items.some((i) => i.id === id), '检索不该命中待审稿');

  assert.equal((await req('GET', '/api/worldbook/detail?id=' + id, { token: t2 })).status, 404);
  assert.equal((await req('GET', '/api/worldbook/preview?id=' + id, { token: t2 })).status, 404);
  assert.equal((await req('GET', '/api/worldbook/download?id=' + id, { token: t2 })).status, 404);
  assert.equal((await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 })).status, 200, '作者应能看到自己的待审稿');

  const mine = await req('GET', '/api/my/submissions', { token: t1 });
  assert.equal(mine.status, 200);
  const row = mine.json.items.find((x) => x.type === 'worldbook' && x.id === id);
  assert.ok(row, '作者应能在「我的投稿」里看到待审稿');
  assert.equal(row.status, 'pending');
  assert.ok(mine.json.counts.pending >= 1);
  assert.ok(!(await req('GET', '/api/my/submissions', { token: t2 })).json.items.some((x) => x.id === id), '别人的「我的投稿」不该有这条');
});

test('待审内容不能被点赞 / 评论', async () => {
  const t1 = await login(U1), t2 = await login(U2);
  const id = (await uploadWb(t1, '待审世界书B')).json.id;
  assert.equal((await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id } })).status, 404);
  assert.equal((await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: 'hi' } })).status, 404);
});

test('管理员通过后公开；驳回后仍隐藏但作者可见', async () => {
  const t1 = await login(U1), t2 = await login(U2);
  const a = (await uploadWb(t1, '待审世界书C')).json.id;
  const b = (await uploadWb(t1, '待审世界书D')).json.id;

  const ok = await adminReq('POST', '/api/admin/review/action', { type: 'worldbook', id: a, action: 'approve' }, t1);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.equal(ok.json.status, 'approved');
  assert.ok((await req('GET', '/api/worldbook/list', { token: t2 })).json.items.some((i) => i.id === a), '通过后应进公开列表');
  assert.equal((await req('GET', '/api/worldbook/detail?id=' + a, { token: t2 })).status, 200);
  assert.equal((await req('GET', '/api/worldbook/download?id=' + a, { token: t2 })).status, 200);
  assert.equal((await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id: a } })).status, 200, '通过后可以点赞');
  const srch = await req('GET', '/api/worldbook/search?q=' + encodeURIComponent('待审世界书C'), { token: t2 });
  assert.ok(srch.json.items.some((i) => i.id === a), '通过后应能被检索到');

  const no = await adminReq('POST', '/api/admin/review/action', { type: 'worldbook', id: b, action: 'reject' }, t1);
  assert.equal(no.status, 200, JSON.stringify(no.json));
  assert.equal(no.json.status, 'rejected');
  assert.equal((await req('GET', '/api/worldbook/detail?id=' + b, { token: t2 })).status, 404);
  assert.ok(!(await req('GET', '/api/worldbook/list', { token: t2 })).json.items.some((i) => i.id === b));
  const mine = await req('GET', '/api/my/submissions', { token: t1 });
  assert.equal((mine.json.items.find((x) => x.id === b) || {}).status, 'rejected', '作者应能看到驳回状态');
  assert.ok(mine.json.counts.rejected >= 1);
  assert.equal((await req('DELETE', '/api/worldbook/delete?id=' + b, { token: t1 })).status, 200, '作者可自行删除被驳回的稿子');
});

test('管理员自己上传直接公开；审核接口需要管理员令牌', async () => {
  const t1 = await login(U1);
  const up = await adminReq('POST', '/api/worldbook/upload', { title: '管理员直发', description: '', category: '综合', content: wbContent('管理员直发') }, t1);
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.status, 'approved');
  assert.equal((await req('GET', '/api/worldbook/detail?id=' + up.json.id, { token: t1 })).status, 200);

  const noTok = await fetch(baseUrl + '/api/admin/review', { headers: { 'Content-Type': 'application/json' } });
  assert.equal(noTok.status, 401);
  const badTok = await fetch(baseUrl + '/api/admin/review', { headers: { 'Content-Type': 'application/json', 'X-Admin-Token': '1.bad' } });
  assert.equal(badTok.status, 401);
  const badAction = await fetch(baseUrl + '/api/admin/review/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'worldbook', id: up.json.id, action: 'approve' }),
  });
  assert.equal(badAction.status, 401);
});

test('审核队列：待审计数、类型/状态过滤、动作留痕', async () => {
  const t1 = await login(U1);
  const id = (await uploadWb(t1, '待审世界书E')).json.id;

  const q = await adminReq('GET', '/api/admin/review?status=pending');
  assert.equal(q.status, 200, JSON.stringify(q.json));
  assert.ok(q.json.items.some((x) => x.type === 'worldbook' && x.id === id));
  assert.ok(q.json.items.every((x) => x.status === 'pending'), '默认队列只列待审');
  assert.ok(q.json.counts.worldbook >= 1, '应带回待审计数（角标用）');
  assert.equal(typeof q.json.counts.preset, 'number');

  const presets = await adminReq('GET', '/api/admin/review?type=preset&status=pending');
  assert.ok(presets.json.items.every((x) => x.type === 'preset'));

  await adminReq('POST', '/api/admin/review/action', { type: 'worldbook', id, action: 'approve' }, t1);
  const rows = db.prepare('SELECT action, admin FROM review_log WHERE target_type = ? AND target_id = ?').all('worldbook', id);
  assert.equal(rows.length, 1, '通过动作应写一条留痕');
  assert.equal(rows[0].action, 'approve');
  assert.ok(!(await adminReq('GET', '/api/admin/review?status=pending')).json.items.some((x) => x.id === id), '通过后不再出现在待审队列');

  const id2 = (await uploadWb(t1, '待审世界书F')).json.id;
  await adminReq('POST', '/api/admin/review/action', { type: 'worldbook', id: id2, action: 'reject' }, t1);
  const rows2 = db.prepare('SELECT action FROM review_log WHERE target_type = ? AND target_id = ?').all('worldbook', id2);
  assert.equal(rows2.length, 1, '驳回动作应写一条留痕');
  assert.equal(rows2[0].action, 'reject');

  assert.equal((await adminReq('GET', '/api/admin/review?status=bogus')).status, 400);
  assert.equal((await adminReq('GET', '/api/admin/review?type=bogus')).status, 400);
  assert.equal((await adminReq('POST', '/api/admin/review/action', { type: 'worldbook', id: 999999, action: 'approve' })).status, 404);
});

test('插件同一条门：待审不进列表，作者可下载，通过后公开', async () => {
  const t1 = await login(U1);
  const manifest = { id: 'rvw-demo', name: '审核测试插件', version: '1.0.0', type: 'memory' };
  const up = await req('POST', '/api/plugin/upload', { token: t1, body: { content: JSON.stringify(manifest) } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.equal(up.json.status, 'pending');
  const pid = up.json.id;

  assert.ok(!(await req('GET', '/api/plugin/list', { token: t1 })).json.items.some((x) => x.id === pid), '待审插件不进列表');
  assert.equal((await req('GET', '/api/plugin/download/rvw-demo', { token: t1 })).status, 200, '作者本人能下载自己的待审插件');

  await adminReq('POST', '/api/admin/review/action', { type: 'plugin', id: pid, action: 'approve' }, t1);
  assert.ok((await req('GET', '/api/plugin/list', { token: t1 })).json.items.some((x) => x.id === pid), '通过后应进列表');
  assert.equal((await req('DELETE', '/api/plugin/delete?id=rvw-demo', { token: t1 })).status, 200);
});

test('存量内容（迁移默认 approved）仍然公开', async () => {
  const t1 = await login(U1);
  const uid = uidOf(U1);
  const now = Date.now();
  // 直接入库模拟迁移前的老数据：不写 status，取列默认值
  const info = db.prepare("INSERT INTO world_books (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, search_text, admin_only) VALUES (?, '', '综合', '', ?, ?, '', 1, 0, ?, '', '{}', '', 0)")
    .run('存量世界书', uid, U1, now);
  const id = Number(info.lastInsertRowid);
  assert.equal(db.prepare('SELECT status FROM world_books WHERE id = ?').get(id).status, 'approved', '缺省应为 approved（老数据不动）');
  assert.ok((await req('GET', '/api/worldbook/list', { token: t1 })).json.items.some((i) => i.id === id), '存量内容应保持公开');
  assert.equal((await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 })).status, 200);
});
