// 意见反馈：（用户）提交接口的校验/限流/去重/裁剪 + （管理员）列表、标记已读、删除。
// 关键口径：
//   · 用户可见的限流只有「每分钟 2 条」；另有设备 24h/20 条、IP 1h/20 条、全站 1h/200 条三条兜底。
//   · 单条上限 300 字，按**码点**计（emoji 算 1 个，不能按 UTF-16 长度算）。
//   · 保留 1000 条：超限**优先删最旧的已查看**，未读是管理员还没处理的工作。
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, baseUrl, db, clearLimiters, adminToken } = require('./helpers');

let ADMIN = '';

before(async () => { await start(); ADMIN = await adminToken(); });
// 每个用例前清空限流桶：测试全在同一 IP 上跑，IP 兜底（20 条/小时）会被测试自己撞满
// （契约模式下这是重启目标进程，见 helpers.js / CONTRACT.md）
beforeEach(async () => { await clearLimiters(); });
after(async () => { await stop(); });

let seq = 0;
const newId = () => 'fb-' + Date.now().toString(36) + '-' + (seq++);

function send(body, headers) {
  return fetch(baseUrl + '/api/feedback', {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    body: JSON.stringify(body),
  });
}
function adminGet(qs, headers) {
  return fetch(baseUrl + '/api/admin/feedback' + (qs || ''), { headers: Object.assign({ 'X-Admin-Token': ADMIN }, headers || {}) });
}
function adminPost(p, body, headers) {
  return fetch(baseUrl + '/api/admin/feedback' + p, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN }, headers || {}),
    body: JSON.stringify(body || {}),
  });
}
const rowOf = (id) => db.prepare('SELECT * FROM feedback WHERE id = ?').get(id);

test('提交成功：入库内容/IP 不入库/未读；返回 ok', async () => {
  const id = newId();
  const res = await send({ id, text: '  希望能加个章节字数统计  ', v: '1.5.97', plat: 'android' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const row = db.prepare('SELECT * FROM feedback WHERE install_id = ?').get(id);
  assert.equal(row.text, '希望能加个章节字数统计');       // 首尾空白被清掉
  assert.equal(row.read_at, null);                          // 新提交默认未读
  assert.equal(row.version, '1.5.97');
  assert.equal(row.platform, 'android');
  // 隐私：不留 IP 字段
  assert.equal(Object.keys(row).some((k) => /ip/i.test(k)), false);
});

test('空内容 / 纯空白 → 400；非法安装标识 → 400', async () => {
  assert.equal((await send({ id: newId(), text: '   \n  ' })).status, 400);
  assert.equal((await send({ id: 'short', text: '你好' })).status, 400);
  assert.equal((await send({ id: 'x'.repeat(80), text: '你好' })).status, 400);
});

test('300 字上限按码点计：300 个 emoji 可以，301 个拒绝，301 个汉字也拒绝', async () => {
  const ok = await send({ id: newId(), text: '🙂'.repeat(300) });
  assert.equal(ok.status, 200);
  const tooManyEmoji = await send({ id: newId(), text: '🙂'.repeat(301) });
  assert.equal(tooManyEmoji.status, 400);
  const tooManyHan = await send({ id: newId(), text: '字'.repeat(301) });
  assert.equal(tooManyHan.status, 400);
});

test('去重：同设备 10 分钟内完全相同的两条只入库一条，但都答"收到"', async () => {
  const id = newId();
  const text = '同一句话说两遍';
  assert.equal((await send({ id, text })).status, 200);
  const second = await send({ id, text });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).deduped, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback WHERE install_id = ?').get(id).c, 1);
});

test('限流：同一设备每分钟只放行 2 条（第 3 条 429）', async () => {
  const id = newId();
  assert.equal((await send({ id, text: '第一条' })).status, 200);
  assert.equal((await send({ id, text: '第二条' })).status, 200);
  const third = await send({ id, text: '第三条' });
  assert.equal(third.status, 429);
  assert.match((await third.json()).error, /频繁/);
  // 换设备不受影响（限的是设备维度，不是全局限速）
  assert.equal((await send({ id: newId(), text: '另一台设备' })).status, 200);
});

test('裁剪：超过 1000 条时优先删最旧的已查看，未查看保留', async () => {
  db.prepare('DELETE FROM feedback').run();
  db.prepare("DELETE FROM feedback_meta WHERE k = 'trimmed'").run();
  const ins = db.prepare('INSERT INTO feedback (text, install_id, version, platform, created_at, read_at) VALUES (?,?,?,?,?,?)');
  const now = Date.now();
  // 1000 条：前 600 条已读（最旧） + 400 条未读。
  // 时间戳必须落在 **1 小时以外**——否则这批种子会把「全站最近 1 小时 200 条」的兜底撞满，
  // 后面所有提交都变成 429（第一版就踩了这个，表现是三条用例莫名其妙一起红）。
  const old = now - 3 * 3600000;
  for (let i = 0; i < 600; i++) ins.run('旧已读' + i, 'seed-dev', '', '', old + i, now);
  for (let i = 0; i < 400; i++) ins.run('未读' + i, 'seed-dev', '', '', old + 1000 + i, null);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback').get().c, 1000);

  const id = newId();
  assert.equal((await send({ id, text: '第 1001 条' })).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback').get().c, 1000);
  // 被删掉的是最旧的已读那条，未读一条没少
  assert.equal(db.prepare("SELECT COUNT(*) c FROM feedback WHERE text = '旧已读0'").get().c, 0);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL').get().c, 401); // 400 未读 + 新提交
  assert.equal(db.prepare("SELECT v FROM feedback_meta WHERE k = 'trimmed'").get().v, 1);
});

test('管理员列表：需要令牌；状态筛选与计数正确', async () => {
  assert.equal((await fetch(baseUrl + '/api/admin/feedback')).status, 401);
  assert.equal((await adminGet('', { 'X-Admin-Token': 'bad' })).status, 401);

  const body = await (await adminGet('?status=unread')).json();
  assert.ok(body.unread >= 1);
  assert.equal(body.items.every((x) => x.read_at === null), true);
  assert.equal(typeof body.trimmed, 'number');
  const all = await (await adminGet('?status=all')).json();
  assert.equal(all.total, all.unread + all.read);
  assert.equal((await adminGet('?status=nope')).status, 400);
});

test('统计接口带上反馈未读数（管理页进页一次拿到，不用另开轮询）', async () => {
  const j = await (await fetch(baseUrl + '/api/admin/stats', { headers: { 'X-Admin-Token': ADMIN } })).json();
  const unread = db.prepare('SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL').get().c;
  assert.equal(j.feedbackUnread, unread);
});

test('标记已读：逐条 + 全部；已读时间落库，重复标记不再改动', async () => {
  const id = newId();
  await send({ id, text: '待标记的反馈' });
  const row = db.prepare('SELECT id FROM feedback WHERE install_id = ?').get(id);
  const r1 = await (await adminPost('/read', { ids: [row.id] })).json();
  assert.equal(r1.changed, 1);
  assert.ok(rowOf(row.id).read_at > 0);
  const r2 = await (await adminPost('/read', { ids: [row.id] })).json();
  assert.equal(r2.changed, 0);                       // 已读过的不再改
  const r3 = await (await adminPost('/read', { all: true })).json();
  assert.equal(r3.ok, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL').get().c, 0);
});

test('删除：管理员可删单条；无令牌 401；无 id 400', async () => {
  const id = newId();
  await send({ id, text: '要被删掉的反馈' });
  const row = db.prepare('SELECT id FROM feedback WHERE install_id = ?').get(id);
  assert.equal((await fetch(baseUrl + '/api/admin/feedback/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: row.id }) })).status, 401);
  assert.equal((await adminPost('/delete', {})).status, 400);
  const del = await (await adminPost('/delete', { id: row.id })).json();
  assert.equal(del.changed, 1);
  assert.equal(rowOf(row.id), undefined);
});
