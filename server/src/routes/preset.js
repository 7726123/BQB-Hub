// 预设路由：列表 / 上传 / 详情 / 删除 / 下载（与世界书同构）
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { requireAuth, isAdminReq } = require('../auth');
const visibility = require('../visibility');
const card = require('./card');
const config = require('../config');
const limits = require('../limits');
const media = require('../media');

const router = express.Router();

function validCategory(c) { return typeof c === 'string' && /^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,12}$/.test(c); }
function validTitle(t) { return typeof t === 'string' && t.trim().length >= 1 && t.trim().length <= 60; }

// 列表：sort 口径与世界书一致（new 最新 / hot 点赞×1+评论人数×3 / active 最近 24 小时）
router.get('/list', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const category = String(req.query.category || '').trim();
  const q = String(req.query.q || '').trim().slice(0, 60);
  const sort = String(req.query.sort || 'new');
  let page = parseInt(req.query.page || '1', 10) || 1;
  if (page < 1) page = 1;
  let pageSize = parseInt(req.query.pageSize || '20', 10) || 20;
  if (pageSize < 1) pageSize = 20; if (pageSize > 50) pageSize = 50;
  const offset = (page - 1) * pageSize;
  const conds = [], args = [];
  conds.push(visibility.approvedSql()); // 未过审的稿子不进公开列表（作者在「我的投稿」里看自己的）
  if (category) { conds.push('category = ?'); args.push(category); }
  if (q) { conds.push('(title LIKE ? OR description LIKE ?)'); args.push('%' + q + '%', '%' + q + '%'); }
  const whereSql = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
  const COLS = 'id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, likes, comments, commenters';

  if (sort === 'active') {
    const act = card.activeScores('preset', Date.now() - card.ACTIVE_WINDOW_MS);
    if (!act.size) return res.json({ items: [], total: 0, page, pageSize, sort });
    const ids = [...act.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const ph = ids.map(() => '?').join(',');
    const extra = conds.concat(['id IN (' + ph + ')']);
    const rows = db.prepare('SELECT ' + COLS + ' FROM presets WHERE ' + extra.join(' AND ')).all(...args, ...ids);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    const pageRows = ordered.slice(offset, offset + pageSize);
    return res.json({ items: card.withLiked('preset', pageRows, req.user.id), total: ordered.length, page, pageSize, sort });
  }

  const total = db.prepare('SELECT COUNT(*) c FROM presets' + whereSql).get(...args).c;
  const order = sort === 'hot' ? '(likes + ' + card.SCORE_COMMENT_WEIGHT + ' * commenters) DESC, created_at DESC' : 'created_at DESC';
  const rows = db.prepare('SELECT ' + COLS + ' FROM presets' + whereSql + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?').all(...args, pageSize, offset);
  return res.json({ items: card.withLiked('preset', rows, req.user.id), total, page, pageSize, sort });
});

router.post('/upload', requireAuth, (req, res) => {
  if (limits.uploadLimited(req)) return res.status(429).json({ error: '上传过于频繁，请稍后再试' });
  const title = String(req.body.title || '').trim();
  const description = String(req.body.description || '').trim().slice(0, 500);
  const category = String(req.body.category || '综合').trim();
  const content = String(req.body.content || '');
  let cover = String(req.body.cover || '');
  if (!validTitle(title)) return res.status(400).json({ error: '标题需 1-60 字符' });
  if (!validCategory(category)) return res.status(400).json({ error: '分类格式不正确' });
  if (!content || content.length > 2 * 1024 * 1024) return res.status(400).json({ error: '预设内容不能为空且需小于 2MB' });
  try { JSON.parse(content); } catch { return res.status(400).json({ error: '文件内容不是有效的 JSON' }); }
  if (cover) {
    if (cover.length > media.COVER_MAX) return res.status(400).json({ error: '封面图片过大（需小于 320KB）' });
    // 整串校验：只接受纯 base64 的图片 data URI（多一个引号就能在老客户端的 <img src> 里逃逸出属性）
    if (!media.validCover(cover)) return res.status(400).json({ error: '封面格式不正确' });
  } else {
    cover = '';
  }
  const now = Date.now();
  // 审核门：管理员自己上传直接公开，其余人一律待审
  const status = isAdminReq(req) ? 'approved' : 'pending';
  const info = db.prepare('INSERT INTO presets (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .run(title, description, category, '', req.user.id, req.user.username, '', Buffer.byteLength(content), now, cover, status);
  const id = Number(info.lastInsertRowid);
  const filename = 'ps_' + id + '.json';
  const dir = path.join(config.UPLOAD_DIR, 'preset');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), content, 'utf8');
  db.prepare('UPDATE presets SET filename = ? WHERE id = ?').run(filename, id);
  return res.json({ ok: true, id, status });
});

router.get('/detail', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, status, likes, comments, commenters FROM presets WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '未找到该预设' });
  if (!visibility.canSee(req, row)) return res.status(404).json({ error: '未找到该预设' }); // 未过审：仅作者与管理员可见
  return res.json({ item: card.withLiked('preset', [row], req.user.id)[0] });
});

router.delete('/delete', requireAuth, (req, res) => {
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, author_id, filename FROM presets WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '未找到该预设' });
  if (row.author_id !== req.user.id) return res.status(403).json({ error: '只能删除自己上传的预设' });
  db.prepare('DELETE FROM presets WHERE id = ?').run(id);
  card.purgeCard('preset', id); // 级联清掉它的点赞与评论
  if (row.filename) {
    const abs = path.normalize(path.join(config.UPLOAD_DIR, 'preset', row.filename));
    if (abs.startsWith(path.normalize(config.UPLOAD_DIR))) { try { fs.unlinkSync(abs); } catch (e) {} }
  }
  return res.json({ ok: true });
});

router.get('/download', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const id = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, title, filename, author_id, status FROM presets WHERE id = ?').get(id);
  if (!row || !row.filename) return res.status(404).json({ error: '未找到该预设' });
  if (!visibility.canSee(req, row)) return res.status(404).json({ error: '未找到该预设' }); // 未过审：仅作者与管理员可见
  const abs = path.normalize(path.join(config.UPLOAD_DIR, 'preset', row.filename));
  if (!abs.startsWith(path.normalize(config.UPLOAD_DIR))) return res.status(400).json({ error: '非法路径' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '文件已丢失' });
  db.prepare('UPDATE presets SET downloads = downloads + 1 WHERE id = ?').run(id);
  const body = fs.readFileSync(abs);
  res.status(200)
    .set('Content-Type', 'application/json; charset=utf-8')
    .set('Content-Length', body.length)
    .set('Content-Disposition', 'attachment; filename="preset_' + id + '.json"')
    .end(body);
});

module.exports = router;