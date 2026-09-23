// 匿名使用统计：（客户端）上报接口的校验/去重/限流 + （管理员）统计接口的口径与权限。
// 口径关键：同一设备多次启动只算一台；「在线」按最后心跳时间判定；「近 7/30 天」是滚动窗口不是自然周月。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-stats-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.APK_DIR = path.join(tmp, 'apk');
process.env.APP_VERSION_FILE = path.join(tmp, 'app-version.json');
process.env.WEB_BUNDLE_DIR = path.join(tmp, 'web-bundles');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ smtp: {}, regionBlock: false }));
fs.writeFileSync(process.env.APP_VERSION_FILE, JSON.stringify({ versionCode: 157, versionName: '1.5.97', apk: 'a.apk' }));
process.env.PORT = String(16300 + (process.pid % 70));
// 与 auth.isAdminReq 同款凭证：管理员口令派生值 + 由它签发的令牌
process.env.ADMIN_PW_HASH = require('../src/adminpass').hashPassword('test-admin-pw-7x');

const app = require('../src/app');
const db = require('../src/db');
const { issueToken } = require('../src/adminpass');
const server = http.createServer(app);
const PORT = Number(process.env.PORT);
const base = 'http://127.0.0.1:' + PORT;
const ADMIN = issueToken(process.env.ADMIN_PW_HASH).token;

before(() => new Promise((r) => server.listen(PORT, '127.0.0.1', r)));
after(() => new Promise((r) => server.close(() => r())));

function ping(body) {
  return fetch(base + '/api/app/ping', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}
function stats(headers = {}) { return fetch(base + '/api/admin/stats', { headers }); }

test('上报：合法标识写入设备表与当天表', async () => {
  const r = await ping({ id: 'dev_aaaaaaaa1111', v: '1.5.97', w: '1.5.97w1', plat: 'android' });
  assert.equal(r.status, 200);
  const row = db.prepare('SELECT * FROM devices WHERE install_id = ?').get('dev_aaaaaaaa1111');
  assert.equal(row.app_version, '1.5.97');
  assert.equal(row.web_version, '1.5.97w1');
  assert.equal(row.platform, 'android');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_days WHERE install_id = ?').get('dev_aaaaaaaa1111').c, 1);
});

test('同一天多次上报只算一台（device_days 主键去重）', async () => {
  for (let i = 0; i < 4; i++) await ping({ id: 'dev_bbbbbbbb2222', v: '1.5.97', w: '', plat: 'android' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM devices WHERE install_id = ?').get('dev_bbbbbbbb2222').c, 1);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM device_days WHERE install_id = ?').get('dev_bbbbbbbb2222').c, 1);
});

test('版本字段每次覆盖：热包回退成内置后不再谎报旧热包版本', async () => {
  await ping({ id: 'dev_cccccccc3333', v: '1.5.97', w: '1.5.97w1', plat: 'android' });
  await ping({ id: 'dev_cccccccc3333', v: '1.5.97', w: '', plat: 'android' });
  const row = db.prepare('SELECT web_version FROM devices WHERE install_id = ?').get('dev_cccccccc3333');
  assert.equal(row.web_version, '');
});

test('非法/过短的安装标识一律 400（不入库）', async () => {
  for (const id of ['', 'abc', '带中文的标识', 'a b', 'x'.repeat(65), '{"a":1}']) {
    const r = await ping({ id, v: '1.5.97' });
    assert.equal(r.status, 400, JSON.stringify(id) + ' 应被拒');
  }
  assert.equal(db.prepare("SELECT COUNT(*) c FROM devices WHERE install_id NOT LIKE 'dev_%'").get().c, 0);
});

test('统计接口：未带令牌 401，带令牌返回四项口径', async () => {
  assert.equal((await stats()).status, 401);
  const r = await stats({ 'X-Admin-Token': ADMIN });
  assert.equal(r.status, 200);
  const j = await r.json();
  // 前面用例已写入 3 台设备（含今天）
  assert.ok(j.online >= 3, 'online=' + j.online);
  assert.ok(j.today >= 3, 'today=' + j.today);
  assert.ok(j.week >= 3 && j.month >= 3);
  assert.ok(j.total >= 3);
  assert.ok(j.newToday >= 3);
  assert.equal(j.day, new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()));
});

test('口径：昨天活跃但今天没来的设备不计入今日，但计入近 7 天', async () => {
  const yesterday = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - 86400000));
  const old = Date.now() - 30 * 3600 * 1000;
  db.prepare('INSERT INTO devices (install_id, first_ts, last_ts, first_day, last_day, app_version, web_version, platform) VALUES (?,?,?,?,?,?,?,?)')
    .run('dev_yesterday0001', old, old, yesterday, yesterday, '1.5.96', '', 'android');
  db.prepare('INSERT INTO device_days (install_id, day) VALUES (?, ?)').run('dev_yesterday0001', yesterday);

  const j = await (await stats({ 'X-Admin-Token': ADMIN })).json();
  const todayRow = db.prepare('SELECT COUNT(*) c FROM device_days WHERE day = ?').get(j.day).c;
  assert.equal(j.today, todayRow);                        // 今日不含这台
  assert.ok(j.week >= j.today + 1, '近 7 天应含这台');
  assert.equal(j.online < j.today + 1, true, '在线不应把只来过昨天的算进来');
});

test('口径：40 天前的设备不计入近 30 天，但计入累计', async () => {
  const day40 = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' })
    .format(new Date(Date.now() - 40 * 86400000));
  const t = Date.now() - 40 * 86400000;
  db.prepare('INSERT INTO devices (install_id, first_ts, last_ts, first_day, last_day, app_version, web_version, platform) VALUES (?,?,?,?,?,?,?,?)')
    .run('dev_old000000001', t, t, day40, day40, '1.5.90', '', 'android');
  db.prepare('INSERT INTO device_days (install_id, day) VALUES (?, ?)').run('dev_old000000001', day40);

  const j = await (await stats({ 'X-Admin-Token': ADMIN })).json();
  const inMonth = db.prepare('SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?')
    .get(new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(Date.now() - 29 * 86400000))).c;
  assert.equal(j.month, inMonth);
  assert.ok(j.total >= j.month + 1, '累计应含 40 天前那台');
});

test('统计接口带版本分布（APK 与网页包分开），供排查热更新是否落地', async () => {
  const j = await (await stats({ 'X-Admin-Token': ADMIN })).json();
  assert.ok(Array.isArray(j.versions) && j.versions.some((x) => x.v === '1.5.97'));
  assert.ok(Array.isArray(j.webs) && j.webs.some((x) => x.w === '1.5.97w1'));
});
