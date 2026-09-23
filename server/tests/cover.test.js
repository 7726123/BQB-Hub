// 封面字段的整串校验 + 驳回/删除时的磁盘载荷清理。
// 回归背景：封面此前只校验 data URI 前缀，载荷里带一个 " 就能逃逸出 <img src="..."> 的属性
// 并注入 onerror（老客户端没转义且改不动）→ 存储型 XSS，可读取同源存储里的会话令牌与模型 key。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { start, stop, req, seedCode, clearLimiters } = require('./helpers');
const config = require('../src/config');
const { hashPassword, issueToken } = require('../src/adminpass');

const U = 'coveruser', PW = 'pass1234', CODE = '112233';
const HASH = hashPassword('pw-cover-test');
const UPLOADS = config.UPLOAD_DIR;
let adminToken = '';
let token = '';
const content = JSON.stringify({ entries: [{ type: '其他', name: 'x', content: 'y' }] });

// 属性逃逸载荷：前缀完全合法，靠后面的引号闭合 <img src="...">
const EVIL = 'data:image/png;base64,AAAA" onerror="localStorage.setItem(\'pwn\',\'1\')" x="';

before(async () => {
  await start();
  config.adminPasswordHash = HASH;
  adminToken = issueToken(HASH).token;
  seedCode(U + '@example.com', 'register', CODE);
  const r = await req('POST', '/api/auth/register', { body: { username: U, password: PW, email: U + '@example.com', code: CODE } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  token = r.json.token;
});
after(async () => { await stop(); });

async function review(type, id, action) {
  const r = await fetch('http://127.0.0.1:' + process.env.PORT + '/api/admin/review/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
    body: JSON.stringify({ type, id, action }),
  });
  return { status: r.status, json: await r.json() };
}

test('封面：属性逃逸载荷被拒（世界书 / 预设）', async () => {
  for (const p of ['/api/worldbook/upload', '/api/preset/upload']) {
    const r = await req('POST', p, { token, body: { title: '逃逸', category: '综合', content, cover: EVIL } });
    assert.equal(r.status, 400, p + ' 应拒绝');
    assert.match(r.json.error, /封面格式不正确/);
  }
  clearLimiters();
});

test('封面：前缀合法但尾部有杂质一律拒绝', async () => {
  const bad = [
    'data:image/png;base64,AAAA" x="',           // 引号
    'data:image/png;base64,AAAA\nBBBB',           // 换行
    'data:image/png;base64,AAA A',                // 空格
    'data:image/png;base64,<script>',             // 非 base64 字符
    'data:image/svg+xml;base64,PHN2Zz4=',         // 非允许的图片类型
    'data:text/html;base64,PHNjcmlwdD4=',         // 非图片
    'data:image/png,x-base64,AAAA',               // 畸形分隔
  ];
  for (const cover of bad) {
    const r = await req('POST', '/api/worldbook/upload', { token, body: { title: '杂质', category: '综合', content, cover } });
    assert.equal(r.status, 400, cover + ' 应拒绝');
  }
  clearLimiters();
});

test('封面：正常 data URI 照常通过（含填充与各类图片）', async () => {
  const good = [
    'data:image/png;base64,iVBORw0KGgo=',
    'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
    'data:image/jpg;base64,AAAA',
    'data:image/webp;base64,UklGRg==',
    'data:image/gif;base64,R0lGODlh',
  ];
  for (const cover of good) {
    const r = await req('POST', '/api/worldbook/upload', { token, body: { title: '正常封面', category: '综合', content, cover } });
    assert.equal(r.status, 200, cover + ' 应通过：' + JSON.stringify(r.json));
    const detail = await req('GET', '/api/worldbook/detail?id=' + r.json.id, { token });
    assert.equal(detail.json.item.cover, cover, '落库应与提交完全一致');
  }
  clearLimiters();
});

test('封面：超大仍提示「过大」而不是「格式不正确」', async () => {
  const big = 'data:image/jpeg;base64,' + 'A'.repeat(330 * 1024);
  const r = await req('POST', '/api/preset/upload', { token, body: { title: '大封面', category: '综合', content, cover: big } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /封面图片过大/);
  clearLimiters();
});

test('驳回：内容文件从磁盘移除，记录与留痕保留（世界书 / 预设）', async () => {
  const wb = await req('POST', '/api/worldbook/upload', { token, body: { title: '待驳回世界书', category: '综合', content, cover: '' } });
  const ps = await req('POST', '/api/preset/upload', { token, body: { title: '待驳回预设', category: '综合', content, cover: '' } });
  const wbFile = path.join(UPLOADS, 'worldbook', 'wb_' + wb.json.id + '.json');
  const psFile = path.join(UPLOADS, 'preset', 'ps_' + ps.json.id + '.json');
  assert.ok(fs.existsSync(wbFile), '驳回前世界书文件应在');
  assert.ok(fs.existsSync(psFile), '驳回前预设文件应在');

  assert.equal((await review('worldbook', wb.json.id, 'reject')).status, 200);
  assert.equal((await review('preset', ps.json.id, 'reject')).status, 200);
  assert.equal(fs.existsSync(wbFile), false, '驳回后世界书文件应被删除');
  assert.equal(fs.existsSync(psFile), false, '驳回后预设文件应被删除');

  // 记录保留：作者在「我的投稿」里仍能看到，且带 rejected 状态（可自行删除记录）
  const mine = await req('GET', '/api/my/submissions?limit=50', { token });
  const wbRow = mine.json.items.find((x) => x.type === 'worldbook' && x.id === wb.json.id);
  assert.ok(wbRow, '驳回的记录应仍可见');
  assert.equal(wbRow.status, 'rejected');
  // 内容已不在：预览按「文件已丢失」处理，不会泄露内容
  const pv = await req('GET', '/api/worldbook/preview?id=' + wb.json.id, { token });
  assert.equal(pv.status, 404);
  clearLimiters();
});

test('通过：内容文件保持不动（审核门只放行，不删内容）', async () => {
  const wb = await req('POST', '/api/worldbook/upload', { token, body: { title: '待通过世界书', category: '综合', content, cover: '' } });
  const file = path.join(UPLOADS, 'worldbook', 'wb_' + wb.json.id + '.json');
  assert.equal((await review('worldbook', wb.json.id, 'approve')).status, 200);
  assert.ok(fs.existsSync(file), '通过后文件应仍在');
  assert.equal((await req('GET', '/api/worldbook/preview?id=' + wb.json.id, { token })).status, 200);
  clearLimiters();
});

test('插件：驳回同时清掉清单与 zip 载荷', async () => {
  const manifest = { id: 'cover-demo', name: '封面演示插件', version: '0.0.1', type: 'regex', entry: 'main.js' };
  const up = await req('POST', '/api/plugin/upload', { token, body: { content: JSON.stringify(manifest) } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const pid = up.json.plugin_id;
  const mfile = path.join(UPLOADS, 'plugin', pid + '.json');
  assert.ok(fs.existsSync(mfile), '驳回前清单应在');

  assert.equal((await review('plugin', up.json.id, 'reject')).status, 200);
  assert.equal(fs.existsSync(mfile), false, '驳回后清单应被删除');
  clearLimiters();
});

test('作者删除：载荷同样清理（世界书）', async () => {
  const wb = await req('POST', '/api/worldbook/upload', { token, body: { title: '待自删世界书', category: '综合', content, cover: '' } });
  const file = path.join(UPLOADS, 'worldbook', 'wb_' + wb.json.id + '.json');
  assert.ok(fs.existsSync(file));
  assert.equal((await req('DELETE', '/api/worldbook/delete?id=' + wb.json.id, { token })).status, 200);
  assert.equal(fs.existsSync(file), false, '删除后文件应被删除');
  clearLimiters();
});
