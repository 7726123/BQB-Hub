// 加固回归：登录爆破保护 / 验证码防猜码 / 发信防轰炸 / client-logs 鉴权（等长错误 key 也 403）
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { start, stop, baseUrl, req, clearLimiters } = require('./helpers');

before(async () => { await start(); });
after(async () => { await stop(); });

test('登录爆破保护：同 IP+账号 连续 10 次失败后 → 429，清桶后恢复', async () => {
  await clearLimiters();
  const email = 'brute@example.com'; // 未注册 → 每次 401
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/api/auth/login', { body: { email, password: 'wrong' } });
    assert.equal(r.status, 401, '第 ' + (i + 1) + ' 次应仍为 401');
  }
  const blocked = await req('POST', '/api/auth/login', { body: { email, password: 'wrong' } });
  assert.equal(blocked.status, 429);
  await clearLimiters();
  const recovered = await req('POST', '/api/auth/login', { body: { email, password: 'wrong' } });
  assert.equal(recovered.status, 401);
});

test('验证码防猜码：同邮箱 10 次错误验证码后 → 429', async () => {
  await clearLimiters();
  const email = 'guess@example.com';
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/api/auth/login-code', { body: { email, code: '000000' } });
    assert.equal(r.status, 400, '第 ' + (i + 1) + ' 次应为验证码错误');
  }
  const blocked = await req('POST', '/api/auth/login-code', { body: { email, code: '000000' } });
  assert.equal(blocked.status, 429);
  await clearLimiters();
});

test('发信防轰炸：同 IP 超限后 send-code → 429', async () => {
  await clearLimiters();
  // 触发限流：直接打满 10 次（前若干次可能是 400/500，都不影响计数）
  for (let i = 0; i < 10; i++) {
    await req('POST', '/api/auth/send-code', { body: { email: `bomb${i}@example.com` } });
  }
  const blocked = await req('POST', '/api/auth/send-code', { body: { email: 'bomb-final@example.com' } });
  assert.equal(blocked.status, 429);
  await clearLimiters();
});

test('client-logs 查看：等长错误 admin key → 403（常量时间比较路径）', async () => {
  const wrongSameLen = 'test-admin-keY'; // 与 test-admin-key 等长、仅大小写不同
  const r = await fetch(baseUrl + '/api/client-logs?limit=1', { headers: { 'x-admin-key': wrongSameLen } });
  assert.equal(r.status, 403);
  const ok = await fetch(baseUrl + '/api/client-logs?limit=1', { headers: { 'x-admin-key': 'test-admin-key' } });
  assert.equal(ok.status, 200);
});

// CORS 预检（浏览器路径）：App 在 WebView 里跨域请求，带自定义头时会先发 OPTIONS 预检；
// 允许头清单漏了任何一个，浏览器直接拦掉请求——表现就是 App 里「网络错误」，而 curl 直连一切正常
// （curl 不做预检）。2026-10-11 系统版连不上服务器就是踩的这条：新加的 X-System-Key / X-Install-Id 不在清单里。
test('CORS 预检：允许头清单覆盖 App 实际会发的自定义头（含系统版凭据头）', async () => {
  const need = ['authorization', 'content-type', 'x-admin-token', 'x-system-key', 'x-install-id'];
  for (const path of ['/api/app/web-bundle?channel=beta', '/api/admin/stats']) {
    const r = await req('OPTIONS', path, {
      headers: {
        Origin: 'https://localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': need.join(','),
      },
    });
    assert.equal(r.status, 204, path + ' 预检应 204');
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    const allow = String(r.headers.get('access-control-allow-headers') || '').toLowerCase().split(',').map((x) => x.trim());
    for (const h of need) {
      assert.ok(allow.includes(h), path + ' 的 Access-Control-Allow-Headers 缺少 ' + h + '（当前：' + allow.join(', ') + '）');
    }
  }
});
