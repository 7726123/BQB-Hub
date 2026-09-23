// 秒上传：世界书先落库（机械抽取兜底），AI 检索标签随后台回填
// 回归背景：原先上传要等 AI 生成标签（最长 20s 超时）才发 POST，用户体感是「卡住」。
const test = require('node:test');
const assert = require('node:assert');
const { start, stop, req, seedCode, approveAll } = require('./helpers');
const cardRoutes = require('../src/routes/card');

const U1 = 'metauser1', U2 = 'metauser2';
const PW = 'pass1234';
const CODE = '654321';
const META = {
  summary: '校园剑道部的日常故事，主角是二年级的林晚，篇幅中等。',
  genre: '校园日常', audience: '一般向', relation: '无恋爱线',
  franchise: '', nsfw: false,
};
const TAGS = '校园,剑道,日常';

test.before(async () => {
  await start();
  for (const u of [U1, U2]) {
    seedCode(u + '@example.com', 'register', CODE);
    const r = await req('POST', '/api/auth/register', { body: { username: u, password: PW, email: u + '@example.com', code: CODE } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
});
test.beforeEach(() => { cardRoutes._limiters.commentLimiter.clear(); cardRoutes._limiters.likeLimiter.clear(); });
test.after(async () => { await stop(); });

async function login(email) {
  const r = await req('POST', '/api/auth/login', { body: { email, password: PW } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.json.token;
}
async function upload(token, title, extra) {
  const content = JSON.stringify({ title, entries: [{ type: '角色', name: '林晚', content: '剑道部二年级。' }] });
  const r = await req('POST', '/api/worldbook/upload', { token, body: Object.assign({ title, description: '简介', category: '综合', content }, extra || {}) });
  approveAll(); // 审核门：本文件测的是元数据补写与检索，内容直接置为已通过
  return r;
}

test('不带 meta 上传：立即成功，服务端机械抽取兜底（标签可后补）', async () => {
  const t1 = await login(U1 + '@example.com');
  const up = await upload(t1, '秒上传测试-无标签');
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const id = up.json.id;

  const detail = await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 });
  assert.equal(detail.status, 200);
  assert.equal(detail.json.item.meta.entryCount, 1);      // 机械抽取：条目数
  assert.ok(detail.json.item.meta.entryNames.includes('林晚'), '机械抽取条目名应在');

  // 补写 AI 元数据（后台上传的那一步）
  const fill = await req('POST', '/api/worldbook/meta', { token: t1, body: { id, tags: TAGS, meta: Object.assign({ summaryBy: 'ai' }, META) } });
  assert.equal(fill.status, 200, JSON.stringify(fill.json));

  const after = await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 });
  assert.equal(after.json.item.meta.genre, '校园日常');    // AI 字段落库
  assert.equal(after.json.item.meta.summaryBy, 'ai');
  assert.equal(after.json.item.meta.entryCount, 1);        // 机械字段不被覆盖
  assert.ok(after.json.item.meta.entryNames.includes('林晚'));
  assert.ok(after.json.item.tags.includes('校园'));        // 标签回写
});

test('补写的元数据进检索索引：summary 里的词能搜到（不必重传）', async () => {
  const t1 = await login(U1 + '@example.com');
  const up = await upload(t1, '秒上传测试-检索', { tags: '综合' });
  const id = up.json.id;
  // 补写前：AI 摘要里的词搜不到
  const before = await req('GET', '/api/worldbook/search?q=' + encodeURIComponent('剑道部的日常故事'), { token: t1 });
  assert.ok(!before.json.items.some((x) => x.id === id));

  await req('POST', '/api/worldbook/meta', { token: t1, body: { id, tags: TAGS, meta: META } });
  const after = await req('GET', '/api/worldbook/search?q=' + encodeURIComponent('剑道部的日常故事'), { token: t1 });
  assert.ok(after.json.items.some((x) => x.id === id), '补写后应能被检索到');
});

test('权限：非上传者不能补写别人的卡；元数据格式非法 400', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const up = await upload(t1, '秒上传测试-权限');
  const id = up.json.id;

  const other = await req('POST', '/api/worldbook/meta', { token: t2, body: { id, tags: TAGS, meta: META } });
  assert.equal(other.status, 403);
  const bad = await req('POST', '/api/worldbook/meta', { token: t1, body: { id, meta: '不是对象' } });
  assert.equal(bad.status, 400);
  const missing = await req('POST', '/api/worldbook/meta', { token: t1, body: { id: 999999, meta: META } });
  assert.equal(missing.status, 404);
});
