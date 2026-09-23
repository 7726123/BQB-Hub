// 审核队列（管理员）+ 我的投稿（作者）。
// 管理员侧沿用 App 的「管理员模式」凭证（X-Admin-Token，见 auth.isAdminReq），不引入新的口令体系；
// 队列默认只列待审，并附带三类内容的待审计数供角标显示。
// 作者侧给一个自己的投稿列表：未过审的内容不进公开列表，作者要能在别处看到自己的稿子与状态。
const express = require('express');
const db = require('../db');
const { requireAuth, isAdminReq } = require('../auth');
const limits = require('../limits');
const reviewlog = require('../reviewlog');
const media = require('../media');

const router = express.Router();

// 类型 → 表（白名单，防注入）
const TABLES = { worldbook: 'world_books', preset: 'presets', plugin: 'plugins' };
// 类型 → 删除磁盘载荷所需的最小列集（插件 zip 用 plugin_id 拼文件名）
const PAYLOAD_COLS = { worldbook: 'id, filename', preset: 'id, filename', plugin: 'id, filename, plugin_id' };
const TYPES = Object.keys(TABLES);
const STATUS_OK = ['pending', 'approved', 'rejected'];
const MAX_LIMIT = 200;
const MAX_SCAN = 500;

/** 列表查询：按状态 / 作者过滤；三类内容列名不同，插件用 plugin_type 顶 category */
function selectRows(type, opts, cap) {
  const where = [], args = [];
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.authorId) { where.push('author_id = ?'); args.push(opts.authorId); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const cols = type === 'plugin'
    ? "id, title, description, plugin_type AS category, plugin_version, author_id, author_name, size, downloads, created_at, status, reviewed_at, '' AS cover"
    : 'id, title, description, category, author_id, author_name, size, downloads, created_at, status, reviewed_at, cover';
  return db.prepare('SELECT ' + cols + ' FROM ' + TABLES[type] + whereSql + ' ORDER BY created_at DESC LIMIT ?')
    .all(...args, cap).map((r) => Object.assign({ type }, r));
}

function countRows(type, opts) {
  const where = [], args = [];
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  if (opts.authorId) { where.push('author_id = ?'); args.push(opts.authorId); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
  return db.prepare('SELECT COUNT(*) c FROM ' + TABLES[type] + whereSql).get(...args).c;
}

function pageArgs(query) {
  let limit = parseInt(query.limit || '50', 10) || 50;
  if (limit < 1) limit = 50; if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  let offset = parseInt(query.offset || '0', 10) || 0;
  if (offset < 0) offset = 0;
  return { limit, offset };
}

// 内容列表（管理员）：type 可选（默认三类合并）、status 默认待审
router.get('/api/admin/review', (req, res) => {
  if (limits.reviewLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  if (!isAdminReq(req)) return res.status(401).json({ error: '需要管理员令牌' });
  const type = String(req.query.type || '').trim();
  if (type && !TABLES[type]) return res.status(400).json({ error: '未知的内容类型' });
  const status = String(req.query.status || 'pending').trim();
  if (STATUS_OK.indexOf(status) < 0) return res.status(400).json({ error: '未知的审核状态' });
  const { limit, offset } = pageArgs(req.query);

  const types = type ? [type] : TYPES;
  const cap = Math.min(offset + limit, MAX_SCAN);
  let items = [];
  for (const t of types) items = items.concat(selectRows(t, { status }, cap));
  items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  let total = 0;
  for (const t of types) total += countRows(t, { status });
  const counts = {};
  for (const t of TYPES) counts[t] = countRows(t, { status: 'pending' });
  return res.json({ items: items.slice(offset, offset + limit), total, counts });
});

// 通过 / 驳回（驳回保留记录：作者能看到状态并自行删除；但内容文件当场删掉——
// 不合格内容不该继续留在服务器磁盘上，这也是「审核不只看状态、还要真正下架」的落点）
router.post('/api/admin/review/action', (req, res) => {
  if (limits.reviewLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  if (!isAdminReq(req)) return res.status(401).json({ error: '需要管理员令牌' });
  const type = String(req.body.type || '');
  if (!TABLES[type]) return res.status(400).json({ error: '未知的内容类型' });
  const id = parseInt(req.body.id || '0', 10) || 0;
  const action = String(req.body.action || '');
  if (action !== 'approve' && action !== 'reject') return res.status(400).json({ error: '未知的审核动作' });
  const row = db.prepare('SELECT ' + PAYLOAD_COLS[type] + ' FROM ' + TABLES[type] + ' WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: '未找到该内容' });
  const status = action === 'approve' ? 'approved' : 'rejected';
  db.prepare('UPDATE ' + TABLES[type] + ' SET status = ?, reviewed_at = ? WHERE id = ?').run(status, Date.now(), id);
  if (action === 'reject') media.removePayload(type, row);
  reviewlog.logAction(type, id, action, String(req.body.note || ''), 'admin');
  return res.json({ ok: true, type, id, status });
});

// 我的投稿（作者视角）：三类内容全状态 + 待审/已驳回计数
router.get('/api/my/submissions', requireAuth, (req, res) => {
  if (limits.readLimited(req)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  const { limit, offset } = pageArgs(req.query);
  const mine = { authorId: req.user.id };
  const cap = Math.min(offset + limit, MAX_SCAN);
  let items = [];
  for (const t of TYPES) items = items.concat(selectRows(t, mine, cap));
  items.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  let total = 0;
  for (const t of TYPES) total += countRows(t, mine);
  const counts = {
    pending: TYPES.reduce((n, t) => n + countRows(t, { status: 'pending', authorId: req.user.id }), 0),
    rejected: TYPES.reduce((n, t) => n + countRows(t, { status: 'rejected', authorId: req.user.id }), 0),
  };
  return res.json({ items: items.slice(offset, offset + limit), total, counts });
});

module.exports = router;
