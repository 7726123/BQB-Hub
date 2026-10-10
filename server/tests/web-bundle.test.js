// 网页包热更新接口：manifest 下发（未发布为空对象）/ zip 托管（路径穿越与非法名拒绝）
//   与 APK 分发同款隔离环境；manifest 内容不做校验（那是客户端验签的事，见 tools/hotbundle-selftest）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { start, stop, baseUrl, paths, db, SYSTEM_TEST_KEY } = require('./helpers');

const WEB_BUNDLE_DIR = paths.webBundleDir;

before(async () => { await start(); });
after(async () => { await stop(); });

test('未发布热包时返回空对象（客户端据此跳过，不报错）', async () => {
  const r = await fetch(baseUrl + '/api/app/web-bundle');
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.deepEqual(j, {});
});

test('发布后原样下发 payload 与 sig', async () => {
  fs.mkdirSync(WEB_BUNDLE_DIR, { recursive: true });
  const man = { payload: 'aG90YnVuZGxlLXYxCg==', sig: 'c2lnbmF0dXJl', v: '1.5.97w1', code: 157001, minNative: 157 };
  fs.writeFileSync(path.join(WEB_BUNDLE_DIR, 'manifest.json'), JSON.stringify(man));

  const r = await fetch(baseUrl + '/api/app/web-bundle');
  const j = await r.json();
  assert.equal(j.payload, man.payload);
  assert.equal(j.sig, man.sig);
  assert.equal(j.v, '1.5.97w1');
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

test('manifest 结构不完整时按未发布处理', async () => {
  fs.writeFileSync(path.join(WEB_BUNDLE_DIR, 'manifest.json'), JSON.stringify({ v: 'x' }));
  const j = await (await fetch(baseUrl + '/api/app/web-bundle')).json();
  assert.deepEqual(j, {});
  // 恢复，供后续用例使用
  fs.writeFileSync(path.join(WEB_BUNDLE_DIR, 'manifest.json'),
    JSON.stringify({ payload: 'p', sig: 's' }));
});

test('zip 下载：存在则 200 且字节一致', async () => {
  const zipName = 'web-1.5.97w1.zip';
  const body = Buffer.from('PK\u0003\u0004fake-zip-bytes-中文');
  fs.writeFileSync(path.join(WEB_BUNDLE_DIR, zipName), body);

  const r = await fetch(baseUrl + '/web-bundle/' + zipName);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  const got = Buffer.from(await r.arrayBuffer());
  assert.deepEqual(got, body);
});

test('zip 下载：不存在则 404', async () => {
  const r = await fetch(baseUrl + '/web-bundle/web-9.9.9w9.zip');
  assert.equal(r.status, 404);
});

test('zip 下载：非法文件名与路径穿越一律 400（永不读目录外文件）', async () => {
  // 故意放一个"目录外"的敏感文件，确认拿不到
  fs.writeFileSync(path.join(paths.data, 'secret.txt'), 'top-secret');
  for (const bad of ['..%2Fsecret.txt', '..%5Csecret.txt', '%2Fetc%2Fpasswd', 'a%2Fb.zip', 'a b.zip', 'a;b.zip']) {
    const r = await fetch(baseUrl + '/web-bundle/' + bad);
    assert.ok(r.status === 400 || r.status === 404, bad + ' → ' + r.status);
  }
  // 直接试探真实穿越（express 会先规范化，最终仍需 400/404）
  const r2 = await fetch(baseUrl + '/web-bundle/....//secret.txt');
  assert.ok(r2.status === 400 || r2.status === 404);
});

test('客户端上报带网页包版本（client_logs.web 列）', async () => {
  const r = await fetch(baseUrl + '/api/client-logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logs: [{ t: Date.now(), k: '诊断', m: '热更新检查失败', v: '1.5.97', plat: 'android', w: '1.5.97w1' }] }),
  });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.stored, 1);

  // 直查库确认落进 web 列（写入后由夹具直读库核对）
  const row = db.prepare('SELECT app_version, web, platform FROM client_logs ORDER BY ts DESC LIMIT 1').get();
  assert.equal(row.web, '1.5.97w1');
  assert.equal(row.app_version, '1.5.97');
  assert.equal(row.platform, 'android');
});

// ---- 内测渠道（channel=beta，系统版专用；见 CONTRACT.md「系统版」）----
// 规则：只有「精确 channel=beta + X-System-Key 命中」才读 manifest-beta.json；其余一律正式包。
// beta 缺失/损坏也必须回落正式——系统版永远拿得到可用包。
const STABLE_MAN = { payload: 'c3RhYmxl', sig: 'c2lnLXN0YWJsZQ==', v: '1.5.100.10', code: 161010, minNative: 161 };
const BETA_MAN = { payload: 'YmV0YQ==', sig: 'c2lnLWJldGE=', v: '1.5.100.11', code: 161011, minNative: 161 };

test('channel=beta：无凭据/坏凭据一律回落正式包（含"只有精确 beta 才切渠道"）', async () => {
  fs.writeFileSync(path.join(WEB_BUNDLE_DIR, 'manifest.json'), JSON.stringify(STABLE_MAN));
  fs.writeFileSync(path.join(WEB_BUNDLE_DIR, 'manifest-beta.json'), JSON.stringify(BETA_MAN));

  let j = await (await fetch(baseUrl + '/api/app/web-bundle?channel=beta')).json();
  assert.equal(j.code, STABLE_MAN.code, '无凭据必须回落正式');

  j = await (await fetch(baseUrl + '/api/app/web-bundle?channel=beta', { headers: { 'X-System-Key': 'wrong-key' } })).json();
  assert.equal(j.code, STABLE_MAN.code, '坏凭据必须回落正式');

  for (const url of ['/api/app/web-bundle', '/api/app/web-bundle?channel=stable', '/api/app/web-bundle?channel=whatever']) {
    j = await (await fetch(baseUrl + url, { headers: { 'X-System-Key': SYSTEM_TEST_KEY } })).json();
    assert.equal(j.code, STABLE_MAN.code, url + ' 应发正式包（只有精确 channel=beta 才切渠道）');
  }
});

test('channel=beta：凭据命中且 beta 存在 → 发 beta；beta 损坏/缺失 → 回落正式', async () => {
  const betaPath = path.join(WEB_BUNDLE_DIR, 'manifest-beta.json');
  const withKey = { headers: { 'X-System-Key': SYSTEM_TEST_KEY } };

  let j = await (await fetch(baseUrl + '/api/app/web-bundle?channel=beta', withKey)).json();
  assert.equal(j.code, BETA_MAN.code, '凭据命中应发 beta');

  fs.writeFileSync(betaPath, JSON.stringify({ v: 'broken' }));
  j = await (await fetch(baseUrl + '/api/app/web-bundle?channel=beta', withKey)).json();
  assert.equal(j.code, STABLE_MAN.code, 'beta 结构不完整时必须回落正式');

  fs.unlinkSync(betaPath);
  j = await (await fetch(baseUrl + '/api/app/web-bundle?channel=beta', withKey)).json();
  assert.equal(j.code, STABLE_MAN.code, 'beta 不存在时必须回落正式');
});
