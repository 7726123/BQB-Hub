// 系统版设备白名单（config.systemInstallIds）：非空时 X-System-Key 必须叠加白名单内的
// X-Install-Id 才生效（防系统版 APK 外流后异地滥用）。
// 这个文件会改写目标配置并重启目标进程（helpers.updateConfig），因此单独一个文件、单独一个端口，
// 避免影响其它用例文件的内存态。
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, req, clearLimiters, updateConfig, SYSTEM_TEST_KEY } = require('./helpers');

before(async () => { await start(); });
after(async () => { await stop(); });

const KEY = { 'X-System-Key': SYSTEM_TEST_KEY };
const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OTHER = 'ffffffffffffffffffffffffffffffff';

test('白名单未配置：系统版凭据即可（基线，对应线上默认部署）', async () => {
  await clearLimiters();
  const r = await req('GET', '/api/admin/stats', { headers: KEY });
  assert.equal(r.status, 200);
});

test('白名单配置后：缺 X-Install-Id / 不在名单 → 401；命中名单 → 200；普通接口不受影响', async () => {
  await updateConfig({ systemInstallIds: [ID] });   // 契约模式：改写 config.json 并重启目标
  try {
    let r = await req('GET', '/api/admin/stats', { headers: KEY });
    assert.equal(r.status, 401, '缺 X-Install-Id 应 401');

    r = await req('GET', '/api/admin/stats', { headers: Object.assign({ 'X-Install-Id': OTHER }, KEY) });
    assert.equal(r.status, 401, '不在白名单应 401');

    r = await req('GET', '/api/admin/stats', { headers: Object.assign({ 'X-Install-Id': ID }, KEY) });
    assert.equal(r.status, 200, '白名单命中应 200');

    // 没带系统版凭据的普通请求不受白名单影响（正式版体验不变）
    r = await req('GET', '/api/app/web-bundle');
    assert.equal(r.status, 200);
  } finally {
    await updateConfig({ systemInstallIds: [] });   // 还原，保证重复运行/后续用例幂等
  }
});

test('白名单还原后：系统版凭据恢复可用', async () => {
  const r = await req('GET', '/api/admin/stats', { headers: KEY });
  assert.equal(r.status, 200);
});
