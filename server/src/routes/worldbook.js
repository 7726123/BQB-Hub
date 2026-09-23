// 世界书路由：列表 / 检索 / 上传 / 详情 / 删除 / 下载
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { requireAuth, isAdminReq } = require('../auth');
const visibility = require('../visibility');
const reviewlog = require('../reviewlog');
const wbsearch = require('../wbsearch');
const card = require('./card');
const config = require('../config');
const limits = require('../limits');
const media = require('../media');

const router = express.Router();

function validCategory(c) { return typeof c === 'string' && /^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,12}$/.test(c); }
function validTitle(t) { return typeof t === 'string' && t.trim().length >= 1 && t.trim().length <= 60; }
// 标签：逗号分隔、去重、单个 ≤ 12 字、最多 12 个（检索 facet 用，格式必须可控）
function normalizeTags(raw) {
  const arr = String(raw || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const t of arr) {
    if (t.length > 12) continue;
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 ·_-]+$/.test(t)) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 12) break;
  }
  return out.join(',');
}
// 元数据（客户端可用自己的 key 生成，服务器只校验与截断；不调任何模型）
function normalizeMeta(raw) {
  let m = raw;
  if (typeof m === 'string') { try { m = JSON.parse(m); } catch (e) { m = null; } }
  if (!m || typeof m !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const list = (v, n, each) => (Array.isArray(v) ? v.map((x) => str(x, each)).filter(Boolean).slice(0, n) : []);
  return {
    genre: str(m.genre, 12), audience: str(m.audience, 8), relation: str(m.relation, 8),
    franchise: str(m.franchise, 40), nsfw: !!m.nsfw,
    chars: list(m.chars, 30, 20), entryNames: list(m.entryNames, 60, 40),
    entryCount: Number(m.entryCount) || 0, words: Number(m.words) || 0,
    summary: str(m.summary, 240),
    summaryBy: str(m.summaryBy, 12),
  };
}

// 列表（分页 + 分类过滤；带 q 时走检索，facet/排序随之生效）
// sort：new（默认，最新）| hot（热门 = 点赞×1 + 评论人数×3）| active（最近 24 小时同一口径，只列有动静的卡）
router.get('/list', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const admin = isAdminReq(req) ? 1 : 0;
  const q = String(req.query.q || '').trim().slice(0, 120);
  if (q) {
    const r = wbsearch.search({ q, page: req.query.page, pageSize: req.query.pageSize, sort: req.query.sort, strict: req.query.strict, admin, nsfw: req.query.nsfw });
    return res.json({ items: card.withLiked('worldbook', r.items, req.user.id), total: r.total, page: parseInt(req.query.page || '1', 10) || 1, pageSize: parseInt(req.query.pageSize || '20', 10) || 20, modes: r.modes, facets: r.facets });
  }
  const category = String(req.query.category || '').trim();
  const sort = String(req.query.sort || 'new');
  let page = parseInt(req.query.page || '1', 10) || 1;
  if (page < 1) page = 1;
  let pageSize = parseInt(req.query.pageSize || '20', 10) || 20;
  if (pageSize < 1) pageSize = 20; if (pageSize > 50) pageSize = 50;
  const offset = (page - 1) * pageSize;
  const conds = [], args = [];
  if (!admin) conds.push('admin_only = 0');
  conds.push(visibility.approvedSql()); // 未过审的稿子不进公开列表（作者在「我的投稿」里看自己的）
  if (category) { conds.push('category = ?'); args.push(category); }
  const whereSql = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  const COLS = 'id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, meta, admin_only, likes, comments, commenters';

  // 活跃榜：先取 24 小时窗口内的得分（只扫最近增量行），再按分数把卡排出来；无动静的卡不进榜
  if (sort === 'active') {
    const act = card.activeScores('worldbook', Date.now() - card.ACTIVE_WINDOW_MS);
    if (!act.size) return res.json({ items: [], total: 0, page, pageSize, sort });
    const ids = [...act.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const ph = ids.map(() => '?').join(',');
    const extra = conds.concat(['id IN (' + ph + ')']);
    const rows = db.prepare('SELECT ' + COLS + ' FROM world_books WHERE ' + extra.join(' AND ')).all(...args, ...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean); // 按分数序（SQL IN 不保序）
    const pageRows = ordered.slice(offset, offset + pageSize);
    return res.json({ items: card.withLiked('worldbook', pageRows.map(wbsearch.decorate), req.user.id), total: ordered.length, page, pageSize, sort });
  }

  const order = sort === 'hot' ? '(likes + ' + card.SCORE_COMMENT_WEIGHT + ' * commenters) DESC, created_at DESC' : 'created_at DESC';
  const total = db.prepare('SELECT COUNT(*) c FROM world_books' + whereSql).get(...args).c;
  const rows = db.prepare('SELECT ' + COLS + ' FROM world_books' + whereSql + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?').all(...args, pageSize, offset);
  return res.json({ items: card.withLiked('worldbook', rows.map(wbsearch.decorate), req.user.id), total, page, pageSize, sort });
});

// 检索（助手找卡用）：整句口语查询 → 候选列表
router.get('/search', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const q = String(req.query.q || '').trim().slice(0, 200);
  if (!q) return res.status(400).json({ error: '缺少查询词' });
  const r = wbsearch.search({
    q,
    page: req.query.page,
    pageSize: req.query.pageSize || 20,
    sort: req.query.sort,
    strict: req.query.strict,
    admin: isAdminReq(req) ? 1 : 0,
    nsfw: req.query.nsfw,
  });
  return res.json(r);
});

// 上传（封面可选 base64 data URL）
router.post('/upload', requireAuth, (req, res) => {
  if (limits.uploadLimited(req)) return res.status(429).json({ error: '上传过于频繁，请稍后再试' });
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim().slice(0, 500);
  const category = String(req.body.category || '综合').trim();
  const content = String(req.body.content || '');
  const tags = normalizeTags(req.body.tags);
  let meta = normalizeMeta(req.body.meta);
  // admin_only 只允许管理员请求设置（测试数据集用；普通上传一律 0）
  const wantsAdminOnly = !!Number(req.body.adminOnly);
  if (wantsAdminOnly && !isAdminReq(req)) return res.status(403).json({ error: '设置 adminOnly 需要管理员令牌' });
  const adminOnly = wantsAdminOnly ? 1 : 0;
  let cover = String(req.body.cover || '');
  if (!validTitle(title)) return res.status(400).json({ error: '标题需 1-60 字符' });
  if (!validCategory(category)) return res.status(400).json({ error: '分类格式不正确' });
  if (!content || content.length > 2 * 1024 * 1024) return res.status(400).json({ error: '世界书内容不能为空且需小于 2MB' });
  try { JSON.parse(content); } catch { return res.status(400).json({ error: '文件内容不是有效的 JSON' }); }
  if (cover) {
    if (cover.length > media.COVER_MAX) return res.status(400).json({ error: '封面图片过大（需小于 320KB）' });
    // 整串校验：只接受纯 base64 的图片 data URI（多一个引号就能在老客户端的 <img src> 里逃逸出属性）
    if (!media.validCover(cover)) return res.status(400).json({ error: '封面格式不正确' });
  } else {
    cover = '';
  }
  // 机械抽取补全元数据（角色名/条目名/条目数/字数），与客户端 AI 摘要合并
  const auto = wbsearch.extractMeta(content);
  meta = Object.assign({}, auto, meta || {}, {
    chars: (meta && meta.chars && meta.chars.length) ? meta.chars : auto.chars,
    entryNames: (meta && meta.entryNames && meta.entryNames.length) ? meta.entryNames : auto.entryNames,
    entryCount: auto.entryCount, words: auto.words,
  });
  const now = Date.now();
  // 审核门：管理员自己上传直接公开（他就是审核者），其余人一律待审
  const status = isAdminReq(req) ? 'approved' : 'pending';
  const info = db.prepare('INSERT INTO world_books (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, search_text, admin_only, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)')
    .run(title, description, category, tags, req.user.id, req.user.username, '', Buffer.byteLength(content), now, cover, JSON.stringify(meta), '', adminOnly, status);
  const id = Number(info.lastInsertRowid);
  const filename = 'wb_' + id + '.json';
  const dir = path.join(config.UPLOAD_DIR, 'worldbook');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
  const searchText = wbsearch.buildSearchText({ title, description, tags, category }, meta);
  db.prepare('UPDATE world_books SET filename = ?, search_text = ? WHERE id = ?').run(filename, searchText, id);
  // 索引照建：检索侧按 status 过滤，审核通过后无需重建索引
  wbsearch.upsertIndex({ id, title, description, search_text: searchText });
  return res.json({ ok: true, id, status });
});

// 补写检索元数据（客户端「秒上传」用）：上传先落库（机械抽取兜底），AI 摘要随后台回填。
// 只允许上传者本人或管理员补写，且只动 meta / search_text / 检索索引，不碰正文文件。
router.post('/meta', requireAuth, (req, res) => {
  if (limits.metaLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const id = parseInt(req.body.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, title, description, category, tags, author_id, meta FROM world_books WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '未找到该世界书' });
  if (row.author_id !== req.user.id && !isAdminReq(req)) return res.status(403).json({ error: '只能补写自己上传的世界书' });
  const incoming = normalizeMeta(req.body.meta);
  if (!incoming) return res.status(400).json({ error: '元数据格式不正确' });
  // 与上传时同样的合并口径：机械抽取的结构字段（角色名/条目名/条目数/字数）不被 AI 摘要覆盖
  let prev = {};
  try { prev = row.meta ? JSON.parse(row.meta) : {}; } catch (e) { prev = {}; }
  const meta = Object.assign({}, prev, incoming, {
    chars: (prev.chars && prev.chars.length) ? prev.chars : (incoming.chars || []),
    entryNames: (prev.entryNames && prev.entryNames.length) ? prev.entryNames : (incoming.entryNames || []),
    entryCount: prev.entryCount || incoming.entryCount || 0,
    words: prev.words || incoming.words || 0,
  });
  const tags = normalizeTags(req.body.tags);
  const searchText = wbsearch.buildSearchText({ title: row.title, description: row.description, category: row.category, tags: tags || row.tags }, meta);
  db.prepare('UPDATE world_books SET meta = ?, search_text = ?, tags = ? WHERE id = ?')
    .run(JSON.stringify(meta), searchText, tags || row.tags, id);
  wbsearch.upsertIndex({ id, title: row.title, description: row.description, search_text: searchText });
  return res.json({ ok: true });
});

// 详情（admin_only 行对非管理员按不存在处理）
router.get('/detail', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, admin_only, status, likes, comments, commenters FROM world_books WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '未找到该世界书' });
  if (row.admin_only && !isAdminReq(req)) return res.status(404).json({ error: '未找到该世界书' });
  if (!visibility.canSee(req, row)) return res.status(404).json({ error: '未找到该世界书' }); // 未过审：仅作者与管理员可见
  return res.json({ item: card.withLiked('worldbook', [wbsearch.decorate(row)], req.user.id)[0] });
});

// 删除（作者本人；管理员可删 admin_only 测试数据）
router.delete('/delete', requireAuth, (req, res) => {
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, author_id, filename, admin_only FROM world_books WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '未找到该世界书' });
  const isOwner = row.author_id === req.user.id;
  if (!isOwner && !(row.admin_only && isAdminReq(req))) return res.status(403).json({ error: '只能删除自己上传的世界书' });
  db.prepare('DELETE FROM world_books WHERE id = ?').run(id);
  if (!isOwner) reviewlog.logAction('worldbook', id, 'delete', '', 'admin'); // 管理员删他人内容 → 留痕
  wbsearch.removeIndex(id);
  card.purgeCard('worldbook', id); // 级联清掉它的点赞与评论
  if (row.filename) {
    const abs = path.normalize(path.join(config.UPLOAD_DIR, 'worldbook', row.filename));
    if (abs.startsWith(path.normalize(config.UPLOAD_DIR))) { try { fs.unlinkSync(abs); } catch (e) {} }
  }
  return res.json({ ok: true });
});

// 预览（返回内容但**不计下载数**：助手/详情弹层里"查看全部条目"用，避免看一眼就涨下载量）
router.get('/preview', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, title, filename, admin_only, author_id, status FROM world_books WHERE id = ?').get(id);
  if (!row || !row.filename) return res.status(404).json({ error: '未找到该世界书' });
  if (row.admin_only && !isAdminReq(req)) return res.status(404).json({ error: '未找到该世界书' });
  if (!visibility.canSee(req, row)) return res.status(404).json({ error: '未找到该世界书' }); // 未过审：仅作者与管理员可见
  const abs = path.normalize(path.join(config.UPLOAD_DIR, 'worldbook', row.filename));
  if (!abs.startsWith(path.normalize(config.UPLOAD_DIR))) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  let book = null;
  try { book = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (e) { return res.status(500).json({ error: '内容解析失败' }); }
  return res.json({ ok: true, title: row.title, entries: Array.isArray(book.entries) ? book.entries : [] });
});

// 下载（返回文件内容并计数；admin_only 行对非管理员按不存在处理）
router.get('/download', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, title, filename, admin_only, author_id, status FROM world_books WHERE id = ?').get(id);
  if (!row || !row.filename) return res.status(404).json({ error: '未找到该世界书' });
  if (row.admin_only && !isAdminReq(req)) return res.status(404).json({ error: '未找到该世界书' });
  if (!visibility.canSee(req, row)) return res.status(404).json({ error: '未找到该世界书' }); // 未过审：仅作者与管理员可见
  const abs = path.normalize(path.join(config.UPLOAD_DIR, 'worldbook', row.filename));
  if (!abs.startsWith(path.normalize(config.UPLOAD_DIR))) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  db.prepare('UPDATE world_books SET downloads = downloads + 1 WHERE id = ?').run(id);
  const body = fs.readFileSync(abs);
  res.status(200)
    .set('Content-Type', 'application/json; charset=utf-8')
    .set('Content-Length', body.length)
    .set('Content-Disposition', 'attachment; filename="worldbook_' + id + '.json"')
    .end(body);
});

module.exports = router;

