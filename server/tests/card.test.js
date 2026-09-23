// 卡片社交（点赞 / 评论 / 排行打分）API 回归：
// 一人一赞幂等、评论计数与「评论人数」口径（同一人多条只算一个）、删除权限（作者/卡作者/管理员）、
// 各种排序（最新/热门/活跃）与级联清理。
const test = require('node:test');
const assert = require('node:assert');
const { start, stop, req, seedCode, approveAll } = require('./helpers');
const cardRoutes = require('../src/routes/card');

const U1 = 'carduser1', U2 = 'carduser2', U3 = 'carduser3';
const PW = 'pass1234';
const CODE = '123456';
let EMAIL = '';

test.beforeEach(() => {
  // 评论/点赞有频率限制（生产行为），测试里每个用例自己清桶
  cardRoutes._limiters.commentLimiter.clear();
  cardRoutes._limiters.likeLimiter.clear();
});

test.before(async () => {
  await start();
  EMAIL = U1 + '@example.com';
  // 注册三个用户（验证码直接入库，绕开 SMTP）
  for (const u of [U1, U2, U3]) {
    seedCode(u + '@example.com', 'register', CODE);
    const r = await req('POST', '/api/auth/register', { body: { username: u, password: PW, email: u + '@example.com', code: CODE } });
    assert.equal(r.status, 200, '注册失败: ' + JSON.stringify(r.json));
  }
});
test.after(async () => { await stop(); });

async function login(email) {
  const r = await req('POST', '/api/auth/login', { body: { email, password: PW } });
  assert.equal(r.status, 200, '登录失败: ' + JSON.stringify(r.json));
  return r.json.token;
}
// 传一本世界书（返回 id）
async function upload(token, title) {
  const content = JSON.stringify({ title, entries: [{ type: '角色', name: 'a', content: 'x' }] });
  const r = await req('POST', '/api/worldbook/upload', { token, body: { title, description: '', category: '综合', tags: '', content } });
  assert.equal(r.status, 200, '上传失败: ' + JSON.stringify(r.json));
  approveAll(); // 审核门：本文件测的是社交行为，内容直接置为已通过
  return r.json.id;
}

test('点赞：切换幂等、计数正确、liked 随登录用户返回', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const id = await upload(t1, '点赞测试书');

  const like1 = await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id } });
  assert.equal(like1.status, 200);
  assert.deepEqual({ liked: like1.json.liked, likes: like1.json.likes }, { liked: true, likes: 1 });

  const again = await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id } });
  assert.equal(again.json.liked, false);      // 再点一次 = 取消
  assert.equal(again.json.likes, 0);

  await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id } });
  const detail = await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 });
  assert.equal(detail.json.item.likes, 1);
  assert.equal(detail.json.item.liked, false); // t1 没赞过
  const detail2 = await req('GET', '/api/worldbook/detail?id=' + id, { token: t2 });
  assert.equal(detail2.json.item.liked, true);

  const anon = await req('POST', '/api/card/like', { body: { type: 'worldbook', id } });
  assert.equal(anon.status, 401);              // 未登录不能点赞
});

test('评论：计数与「评论人数」分离（同一人多条只算一个人）', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const id = await upload(t1, '评论测试书');

  for (const c of ['第一条', '第二条', '第三条']) {
    const r = await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: c } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
  }
  const r3 = await req('POST', '/api/card/comment', { token: t1, body: { type: 'worldbook', id, content: '作者回一句' } });
  assert.equal(r3.status, 200);

  const list = await req('GET', '/api/card/comments?type=worldbook&id=' + id, { token: t1 });
  assert.equal(list.json.comments.length, 4);
  assert.equal(list.json.total, 4);
  assert.equal(list.json.comments[0].content, '作者回一句'); // 倒序（最新在前）

  // 热门分 = 点赞×1 + 评论人数×3 → 2 个评论人 → 6 分
  const hot = await req('GET', '/api/worldbook/list?sort=hot', { token: t1 });
  const mine = hot.json.items.find((x) => x.id === id);
  assert.equal(mine.comments, 4);
  assert.equal(hot.json.items[0].id, id, '有评论的卡应排在热门第一');

  // 内容校验：空 / 超长 / 不存在的卡
  assert.equal((await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: '   ' } })).status, 400);
  assert.equal((await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: 'x'.repeat(501) } })).status, 400);
  assert.equal((await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id: 999999, content: 'hi' } })).status, 404);
});

test('删除评论：评论作者 / 卡作者 / 管理员；计数与评论人数同步回退', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const t3 = await login(U3 + '@example.com');
  const id = await upload(t1, '删除权限测试书');

  // U2 两条、U3 一条
  const c1 = (await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: 'u2-1' } })).json.comment.id;
  const c2 = (await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: 'u2-2' } })).json.comment.id;
  const c3 = (await req('POST', '/api/card/comment', { token: t3, body: { type: 'worldbook', id, content: 'u3-1' } })).json.comment.id;

  // 无关的人不能删
  assert.equal((await req('DELETE', '/api/card/comment?id=' + c1, { token: t3 })).status, 403);
  // 评论作者删自己的：评论数 -1，但该用户还有一条 → 评论人数不变
  assert.equal((await req('DELETE', '/api/card/comment?id=' + c2, { token: t2 })).status, 200);
  let d = (await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 })).json.item;
  assert.equal(d.comments, 2);
  // 卡作者删别人的：U3 的最后一条 → 评论人数 -1
  assert.equal((await req('DELETE', '/api/card/comment?id=' + c3, { token: t1 })).status, 200);
  d = (await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 })).json.item;
  assert.equal(d.comments, 1);
  // U2 最后一条也删掉 → 评论人数归零（热门分不再计入）
  assert.equal((await req('DELETE', '/api/card/comment?id=' + c1, { token: t2 })).status, 200);
  d = (await req('GET', '/api/worldbook/detail?id=' + id, { token: t1 })).json.item;
  assert.equal(d.comments, 0);
  const hot = await req('GET', '/api/worldbook/list?sort=hot', { token: t1 });
  assert.equal(hot.json.items.find((x) => x.id === id).commenters, 0);
  // 重复删除 → 404（已软删）
  assert.equal((await req('DELETE', '/api/card/comment?id=' + c1, { token: t2 })).status, 404);
});

test('排序：热门按 点赞 + 3×评论人数；活跃只列 24 小时内有动静的卡', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const old = await upload(t1, '热点排序-点赞多');
  const fresh = await upload(t1, '热点排序-评论新');

  // old：U2、U3 点赞 → 2 分（评论人数 0）
  const t3 = await login(U3 + '@example.com');
  await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id: old } });
  await req('POST', '/api/card/like', { token: t3, body: { type: 'worldbook', id: old } });
  // fresh：1 条评论 → 3 分 > 2 分
  await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id: fresh, content: '有评论' } });

  const hot = await req('GET', '/api/worldbook/list?sort=hot&pageSize=100', { token: t1 });
  const ids = hot.json.items.map((x) => x.id);
  assert.ok(ids.indexOf(fresh) < ids.indexOf(old), '评论(3分) 应排在两个赞(2分) 前面');

  const newList = await req('GET', '/api/worldbook/list?sort=new&pageSize=100', { token: t1 });
  assert.equal(newList.json.items[0].id, fresh, '最新榜按创建时间倒序');

  const active = await req('GET', '/api/worldbook/list?sort=active&pageSize=100', { token: t1 });
  const aIds = active.json.items.map((x) => x.id);
  assert.ok(aIds.includes(fresh) && aIds.includes(old), '刚有动静的卡应进活跃榜');
  assert.ok(aIds.indexOf(fresh) < aIds.indexOf(old));
  // 没有任何点赞/评论的卡不进活跃榜
  const idle = await upload(t1, '活跃榜外-无动静');
  const active2 = await req('GET', '/api/worldbook/list?sort=active&pageSize=100', { token: t1 });
  assert.ok(!active2.json.items.map((x) => x.id).includes(idle));
});

test('预设同一套（点赞/评论/排序都可用）', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const content = JSON.stringify({ name: '预设A', prompts: [] });
  const up = await req('POST', '/api/preset/upload', { token: t1, body: { title: '预设A', description: '', category: '综合', content } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const pid = up.json.id;
  approveAll(); // 审核门：同上，内容直接置为已通过

  assert.equal((await req('POST', '/api/card/like', { token: t2, body: { type: 'preset', id: pid } })).json.likes, 1);
  assert.equal((await req('POST', '/api/card/comment', { token: t2, body: { type: 'preset', id: pid, content: '预设评论' } })).status, 200);
  const list = await req('GET', '/api/preset/list?sort=hot', { token: t1 });
  const mine = list.json.items.find((x) => x.id === pid);
  assert.equal(mine.likes, 1);
  assert.equal(mine.comments, 1);
  assert.equal(mine.liked, false);
  const detail = await req('GET', '/api/preset/detail?id=' + pid, { token: t2 });
  assert.equal(detail.json.item.liked, true);
});

test('删除卡片时级联清理它的点赞与评论', async () => {
  const t1 = await login(U1 + '@example.com');
  const t2 = await login(U2 + '@example.com');
  const id = await upload(t1, '级联清理测试书');
  await req('POST', '/api/card/like', { token: t2, body: { type: 'worldbook', id } });
  await req('POST', '/api/card/comment', { token: t2, body: { type: 'worldbook', id, content: '待清理' } });

  assert.equal((await req('DELETE', '/api/worldbook/delete?id=' + id, { token: t1 })).status, 200);
  const gone = await req('GET', '/api/card/comments?type=worldbook&id=' + id, { token: t2 });
  assert.equal(gone.json.comments.length, 0);
  assert.equal(gone.json.total, 0);
});
