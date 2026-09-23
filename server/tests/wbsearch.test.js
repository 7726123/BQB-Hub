// 世界书检索与 admin_only 隔离单测（回归背景：社区找卡 + 36 张仅管理员可见的测试数据集）
// 覆盖：问句分析（facet/题材/同人识别）、元数据机械抽取、多路召回排序、管理员可见性隔离
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-wbsearch-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');
process.env.CONFIG_FILE = path.join(tmp, 'config.json');
fs.writeFileSync(process.env.CONFIG_FILE, JSON.stringify({ regionBlock: false }));

const db = require('../src/db');
const wbsearch = require('../src/wbsearch');

function seedCard(o) {
  const book = { name: o.title, title: o.title, entries: o.entries };
  const content = JSON.stringify(book);
  const meta = Object.assign(wbsearch.extractMeta(content), {
    genre: o.genre || '', audience: o.audience || '', relation: o.relation || '',
    franchise: o.franchise || '', nsfw: !!o.nsfw,
  });
  const info = db.prepare('INSERT INTO world_books (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, search_text, admin_only, status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(o.title, o.desc || '', '综合', (o.tags || []).join(','), 1, o.author || 'tester', '', Buffer.byteLength(content), o.downloads || 0, o.created || Date.now(), '', JSON.stringify(meta), '', o.adminOnly ? 1 : 0, o.status || 'approved');
  const id = Number(info.lastInsertRowid);
  const st = wbsearch.buildSearchText({ title: o.title, description: o.desc || '', tags: (o.tags || []).join(','), category: '综合' }, meta);
  db.prepare('UPDATE world_books SET search_text = ? WHERE id = ?').run(st, id);
  wbsearch.upsertIndex({ id, title: o.title, description: o.desc || '', search_text: st });
  return id;
}

const roleEntries = (names) => names.map((n) => ({ type: '角色', name: n, content: '姓名：' + n + '。性别：女。性格：外冷内热。' }));

const idMagic = seedCard({ title: '誓剑与星烬', desc: '剑与魔法题材，含魔法学院、骑士团与公会设定。', genre: '剑与魔法', audience: '男性向', relation: '无恋爱线', tags: ['剑与魔法', '男性向'], entries: roleEntries(['亚瑟', '凛']) });
const idFem = seedCard({ title: '鹤见坂的糖与条款', desc: '女性向恋爱喜剧，甜品店与学校社团的日常。', genre: '恋爱喜剧', audience: '女性向', relation: '纯爱', tags: ['恋爱喜剧', '女性向', '纯爱'], entries: roleEntries(['鹤见坂遥', '九条葵']) });
const idFan = seedCard({ title: '石蕗高中·败犬们的日常', desc: '败犬女主太多了同人，八奈见与温水的日常。', genre: '校园日常', audience: '一般向', relation: '纯爱', franchise: '败犬女主太多了', tags: ['校园日常', '同人'], entries: roleEntries(['八奈见杏菜', '温水和彦']) });
const idAdminMagic = seedCard({ title: '天伤裂土', desc: '剑与魔法原创，星烬与铭刻体系。', genre: '剑与魔法', audience: '男性向', relation: '无恋爱线', tags: ['剑与魔法'], adminOnly: true, entries: roleEntries(['誓者', '录誓官']) });
const idPendingMagic = seedCard({ title: '未过审的剑与魔法', desc: '剑与魔法题材的待审稿。', genre: '剑与魔法', audience: '男性向', relation: '无恋爱线', tags: ['剑与魔法'], status: 'pending', entries: roleEntries(['丙', '丁']) });

test('问句分析：题材词 / 面向 / 关系 / 同人 都能识别出来', () => {
  const a = wbsearch.analyzeQuery('有没有剑与魔法的世界观');
  assert.equal(a.facets.genre, '剑与魔法');
  const b = wbsearch.analyzeQuery('想要男性向纯爱的赛博朋克卡');
  assert.equal(b.facets.audience, '男性向');
  assert.equal(b.facets.relation, '纯爱');
  assert.equal(b.facets.genre, '赛博朋克');
  const c = wbsearch.analyzeQuery('有没有败犬女主的同人');
  assert.equal(c.facets.fanfic, 1);
  assert.ok(c.terms.length > 0);
});

test('元数据机械抽取：角色名 / 条目名 / 条目数 / 字数', () => {
  const m = wbsearch.extractMeta(JSON.stringify({ entries: roleEntries(['八奈见杏菜', '温水和彦']).concat([{ type: '世界观', name: '世界背景', content: '这是一段设定。' }]) }));
  assert.equal(m.entryCount, 3);
  assert.deepEqual(m.chars, ['八奈见杏菜', '温水和彦']);
  assert.ok(m.entryNames.includes('世界背景'));
  assert.ok(m.words > 10);
});

test('管理员未开启：admin_only 卡片不可见、不可检索', () => {
  const r = wbsearch.search({ q: '有没有剑与魔法的世界观', admin: 0, pageSize: 10 });
  const titles = r.items.map((i) => i.title);
  assert.ok(titles.includes('誓剑与星烬'));
  assert.ok(!titles.includes('天伤裂土'));
});

test('管理员开启：admin_only 卡片进入检索结果', () => {
  const r = wbsearch.search({ q: '有没有剑与魔法的世界观', admin: 1, pageSize: 10 });
  const titles = r.items.map((i) => i.title);
  assert.ok(titles.includes('天伤裂土'));
});

test('按面向找：女性向的那张排第一（facet 精确匹配优先）', () => {
  const r = wbsearch.search({ q: '有没有女性向的世界书', admin: 0, pageSize: 5 });
  assert.equal(r.items[0].title, '鹤见坂的糖与条款');
});

test('按同人原作找：命中同人卡', () => {
  const r = wbsearch.search({ q: '有没有败犬女主的同人世界观', admin: 0, pageSize: 5 });
  assert.equal(r.items[0].title, '石蕗高中·败犬们的日常');
});

test('按角色名找：角色名入索引，能精确命中', () => {
  const r = wbsearch.search({ q: '有没有八奈见杏菜出场的世界书', admin: 0, pageSize: 5 });
  assert.equal(r.items[0].title, '石蕗高中·败犬们的日常');
});

test('没有命中时返回 browse 标记（调用方据此回答"没找到"）', () => {
  const r = wbsearch.search({ q: '赛博朋克义体改造的都市传说', admin: 0, pageSize: 5 });
  assert.equal(r.modes.browse, 1);
});

test('2 字关键词（trigram 不支持）走 LIKE 兜底仍能命中', () => {
  const r = wbsearch.search({ q: '魔法', admin: 0, pageSize: 5 });
  assert.ok(r.items.length > 0);
});

test('AI 规范化简介进入检索文本：只写在 summary 里的词也能命中', () => {
  const id = seedCard({ title: '无名手记', desc: '随手记的一些设定。', genre: '', audience: '', relation: '', entries: roleEntries(['甲']) });
  const row = db.prepare('SELECT meta FROM world_books WHERE id = ?').get(id);
  const meta = JSON.parse(row.meta);
  meta.summary = '克苏鲁恐怖题材，女性向纯爱，主要角色甲与乙，旧神与理智值设定。';
  meta.audience = '女性向';
  const st = wbsearch.buildSearchText({ title: '无名手记', description: '随手记的一些设定。', tags: '', category: '综合' }, meta);
  db.prepare('UPDATE world_books SET meta = ?, search_text = ? WHERE id = ?').run(JSON.stringify(meta), st, id);
  wbsearch.upsertIndex({ id, title: '无名手记', description: '', search_text: st });
  const r = wbsearch.search({ q: '有没有克苏鲁风格的', admin: 0, pageSize: 5 });
  assert.ok(r.items.some((i) => i.id === id));
  const r2 = wbsearch.search({ q: '有没有女性向的', admin: 0, pageSize: 5 });
  assert.ok(r2.items.slice(0, 3).some(function (i) { return i.id === id; }));   // 认的是 summary/字段里的规范化信息，而不是作者简介
});

test('已入库的行会被 rebuildIndex 补上 search_text 与索引', () => {
  db.prepare("UPDATE world_books SET search_text = '' WHERE id = ?").run(idMagic);
  const n = wbsearch.rebuildIndex();
  assert.ok(n >= 4);
  const row = db.prepare('SELECT search_text FROM world_books WHERE id = ?').get(idMagic);
  assert.ok(String(row.search_text).includes('剑与魔法'));
});

// 放在文件末尾：本用例会把一张卡从待审改为通过，避免影响上面的排序断言
test('审核门：待审稿不进检索（管理员也是），通过后无需重建索引即可命中', () => {
  const titles = (r) => r.items.map((i) => i.title);
  assert.ok(!titles(wbsearch.search({ q: '有没有剑与魔法题材的世界书', admin: 0, pageSize: 20 })).includes('未过审的剑与魔法'));
  assert.ok(!titles(wbsearch.search({ q: '有没有剑与魔法题材的世界书', admin: 1, pageSize: 20 })).includes('未过审的剑与魔法'), '搜索只列已通过，待审稿在审核面板里看');
  assert.ok(!titles(wbsearch.search({ q: '', admin: 1, pageSize: 50 })).includes('未过审的剑与魔法'), '浏览模式同样过滤待审稿');

  db.prepare("UPDATE world_books SET status = 'approved' WHERE id = ?").run(idPendingMagic);
  assert.ok(titles(wbsearch.search({ q: '有没有剑与魔法题材的世界书', admin: 0, pageSize: 20 })).includes('未过审的剑与魔法'), '通过后索引已在，无需重建');
});

// 回归背景：单字查询（「剑」「灰」）以前被当成"没有检索词"，直接返回全量列表，
// 用户看到列表毫无变化，以为搜索没生效。
test('单字中文检索词生效：过滤到少量结果，而不是退回全量列表', () => {
  const r = wbsearch.search({ q: '鹤', admin: 0, pageSize: 20 });
  assert.ok(r.terms.includes('鹤'), '单字应作为检索词：' + JSON.stringify(r.terms));
  const titles = r.items.map((i) => i.title);
  assert.ok(titles.includes('鹤见坂的糖与条款'), '应命中含该字的世界书');
  assert.ok(!titles.includes('誓剑与星烬'), '不含该字的不该出现（旧行为会返回全量）');
  assert.ok(r.total <= 3, '单字搜索应明显收窄结果，实际 ' + r.total + ' 条');
});

test('查询词被全部过滤时返回空结果，不退回全量；空查询仍是浏览模式', () => {
  const r = wbsearch.search({ q: '。。。', admin: 0, pageSize: 20 });
  assert.equal(r.items.length, 0);
  assert.equal(r.total, 0);
  assert.equal(r.modes.tooShort, 1);

  const b = wbsearch.search({ q: '', admin: 0, pageSize: 20 });
  assert.equal(b.modes.browse, 1);
  assert.ok(b.total > 0, '空查询（/list 不带 q）仍应返回浏览列表');
});
