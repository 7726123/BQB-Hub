// 限流器单测（纯函数，无网络）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, middleware, startSweeper } = require('../src/ratelimit');

test('滑动窗：窗口内超限拒绝，窗口外放行', async () => {
  const l = createLimiter({ windowMs: 1000, max: 3 });
  assert.equal(l.allow('k'), true);
  assert.equal(l.allow('k'), true);
  assert.equal(l.allow('k'), true);
  assert.equal(l.allow('k'), false);       // 第 4 次超限
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(l.allow('k'), true);        // 窗口滑过 → 恢复
});

test('按 key 分桶：不同 key 互不影响', () => {
  const l = createLimiter({ windowMs: 60000, max: 1 });
  assert.equal(l.allow('a'), true);
  assert.equal(l.allow('a'), false);
  assert.equal(l.allow('b'), true);
  assert.equal(l.size(), 2);
});

test('reset 只清指定桶；clear 清空全部', () => {
  const l = createLimiter({ windowMs: 60000, max: 1 });
  l.allow('a'); l.allow('b');
  l.reset('a');
  assert.equal(l.allow('a'), true);
  assert.equal(l.allow('b'), false);
  l.clear();
  assert.equal(l.size(), 0);
});

test('sweep 回收窗口外的空桶（防 Map 无限增长）', async () => {
  const l = createLimiter({ windowMs: 50, max: 5 });
  l.allow('x'); l.allow('y');
  assert.equal(l.size(), 2);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(l.sweep(), 0);
});

test('middleware：超限返回 429 JSON，未超限透传', () => {
  const l = createLimiter({ windowMs: 60000, max: 1 });
  const mw = middleware(l, (req) => req.ipKey);
  const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  mw({ ipKey: 'ip1' }, res, () => { passed = true; });
  assert.equal(passed, true);
  const res2 = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  mw({ ipKey: 'ip1' }, res2, () => {});
  assert.equal(res2.statusCode, 429);
  assert.ok(res2.body.error);
});

test('startSweeper 返回可 unref 的定时器（不阻塞退出）', () => {
  const l = createLimiter({ windowMs: 1000, max: 1 });
  const t = startSweeper([l], 1000);
  assert.ok(t && typeof t.unref === 'function');
  clearInterval(t);
});
