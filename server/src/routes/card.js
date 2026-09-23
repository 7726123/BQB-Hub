// 社区卡片社交：点赞（一人一赞，主键幂等）+ 评论（发布/列表/删除）+ 排行榜打分。
// 一套路由同时服务世界书与预设（target_type 区分）；以后插件市场加入只是多一个取值。
//
// 打分口径（用户定的）：热门 = 点赞数 ×1 + 评论人数 ×3，同一用户多条评论只算一个人。
// 计数缓存列（likes / comments / commenters）在卡片行上，避免列表每行两次 COUNT 子查询，
// 也让「热门」排序能用上索引外的单次排序；「活跃」= 最近 24 小时窗口内同一口径的得分，
// 按 created_at 索引只扫最近的增量行，与全表规模无关。
const express = require('express');
const db = require('../db');
const { requireAuth, isAdminReq } = require('../auth');
const visibility = require('../visibility');
const { createLimiter } = require('../ratelimit');

const router = express.Router();

// 卡片类型 → 表名（白名单，防注入）
const TABLES = { worldbook: 'world_books', preset: 'presets' };
function tableFor(t) { return TABLES[String(t || '')] || null; }

const COMMENT_MAX = 500;
const ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SCORE_COMMENT_WEIGHT = 3;

// 写操作限流（内存滑动窗，单实例够用；与 ratelimit.js 其余使用方式一致）
const likeLimiter = createLimiter({ windowMs: 60 * 1000, max: 60 });
const commentLimiter = createLimiter({ windowMs: 60 * 1000, max: 5 });
function limited(limiter, req) {
  const key = 'u' + ((req.user && req.user.id) || 0);
  return !limiter.allow(key);
}

/** 卡片是否存在（顺带取作者 id，用于「卡作者可删评论」）；传 req 时按审核可见性过滤 */
function cardRow(type, id, req) {
  const t = tableFor(type);
  if (!t) return null;
  const row = db.prepare('SELECT id, author_id, status FROM ' + t + ' WHERE id = ?').get(id) || null;
  if (row && req && !visibility.canSee(req, row)) return null; // 未过审的卡：点赞/评论一律按不存在处理
  return row;
}

/** 批量补 liked（列表/详情共用；likes 计数已是缓存列，不用再查） */
function withLiked(type, items, userId) {
  const list = items || [];
  if (!list.length) return list;
  const liked = new Set();
  try {
    const ids = list.map((it) => it.id).filter((n) => n != null);
    if (ids.length && userId) {
      const ph = ids.map(() => '?').join(',');
      const rows = db.prepare('SELECT target_id FROM card_likes WHERE target_type = ? AND user_id = ? AND target_id IN (' + ph + ')')
        .all(type, userId, ...ids);
      rows.forEach((r) => liked.add(r.target_id));
    }
  } catch (e) { /* liked 是增强信息，查询失败不致命 */ }
  return list.map((it) => Object.assign({}, it, { liked: liked.has(it.id) }));
}

/** 24 小时活跃分：窗口内点赞数 + 3×评论人数 */
function activeScores(type, since) {
  const map = new Map();
  try {
    const likes = db.prepare('SELECT target_id AS id, COUNT(*) AS n FROM card_likes WHERE target_type = ? AND created_at >= ? GROUP BY target_id').all(type, since);
    likes.forEach((r) => map.set(r.id, (map.get(r.id) || 0) + r.n));
    const cms = db.prepare('SELECT target_id AS id, COUNT(DISTINCT user_id) AS n FROM card_comments WHERE target_type = ? AND deleted = 0 AND created_at >= ? GROUP BY target_id').all(type, since);
    cms.forEach((r) => map.set(r.id, (map.get(r.id) || 0) + SCORE_COMMENT_WEIGHT * r.n));
  } catch (e) { console.warn('[card] 活跃分计算失败:', e.message); }
  return map;
}

// 点赞/取消（切换）：主键幂等，同一个人重复点赞不会累加
router.post('/like', requireAuth, (req, res) => {
  const type = String(req.body.type || '');
  const id = parseInt(req.body.id || '0', 10) || 0;
  const t = tableFor(type);
  if (!t) return res.status(400).json({ error: '未知的卡片类型' });
  if (!cardRow(type, id, req)) return res.status(404).json({ error: '未找到该卡片' });
  if (limited(likeLimiter, req)) return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
  const uid = req.user.id;
  const now = Date.now();
  const has = db.prepare('SELECT 1 FROM card_likes WHERE target_type = ? AND target_id = ? AND user_id = ?').get(type, id, uid);
  let liked;
  if (has) {
    db.prepare('DELETE FROM card_likes WHERE target_type = ? AND target_id = ? AND user_id = ?').run(type, id, uid);
    db.prepare('UPDATE ' + t + ' SET likes = MAX(0, likes - 1) WHERE id = ?').run(id);
    liked = false;
  } else {
    db.prepare('INSERT INTO card_likes (target_type, target_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(type, id, uid, now);
    db.prepare('UPDATE ' + t + ' SET likes = likes + 1 WHERE id = ?').run(id);
    liked = true;
  }
  const likes = (db.prepare('SELECT likes FROM ' + t + ' WHERE id = ?').get(id) || {}).likes || 0;
  return res.json({ ok: true, liked, likes });
});

// 评论列表（倒序分页；before_id 用于「加载更多」）
router.get('/comments', requireAuth, (req, res) => {
  const type = String(req.query.type || '');
  const id = parseInt(req.query.id || '0', 10) || 0;
  if (!tableFor(type)) return res.status(400).json({ error: '未知的卡片类型' });
  let limit = parseInt(req.query.limit || '20', 10) || 20;
  if (limit < 1) limit = 20; if (limit > 50) limit = 50;
  const beforeId = parseInt(req.query.before_id || '0', 10) || 0;
  const rows = beforeId > 0
    ? db.prepare('SELECT id, user_id, username, content, created_at FROM card_comments WHERE target_type = ? AND target_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?').all(type, id, beforeId, limit)
    : db.prepare('SELECT id, user_id, username, content, created_at FROM card_comments WHERE target_type = ? AND target_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?').all(type, id, limit);
  const total = (db.prepare('SELECT comments FROM ' + tableFor(type) + ' WHERE id = ?').get(id) || {}).comments || 0;
  return res.json({ ok: true, comments: rows, total, mine: req.user.id });
});

// 发评论：内容长度上限 + 频率限制；首次评论该卡的人会让 commenters+1（热门分按人算）
router.post('/comment', requireAuth, (req, res) => {
  const type = String(req.body.type || '');
  const id = parseInt(req.body.id || '0', 10) || 0;
  const content = String(req.body.content || '').trim();
  const t = tableFor(type);
  if (!t) return res.status(400).json({ error: '未知的卡片类型' });
  if (!content) return res.status(400).json({ error: '评论内容不能为空' });
  if (content.length > COMMENT_MAX) return res.status(400).json({ error: '评论不能超过 ' + COMMENT_MAX + ' 字' });
  if (!cardRow(type, id, req)) return res.status(404).json({ error: '未找到该卡片' });
  if (limited(commentLimiter, req)) return res.status(429).json({ error: '评论太频繁了，请稍后再试' });
  const uid = req.user.id;
  const first = !db.prepare('SELECT 1 FROM card_comments WHERE target_type = ? AND target_id = ? AND user_id = ? AND deleted = 0 LIMIT 1').get(type, id, uid);
  const info = db.prepare('INSERT INTO card_comments (target_type, target_id, user_id, username, content, created_at, deleted, deleted_by) VALUES (?, ?, ?, ?, ?, ?, 0, 0)')
    .run(type, id, uid, req.user.username, content, Date.now());
  db.prepare('UPDATE ' + t + ' SET comments = comments + 1' + (first ? ', commenters = commenters + 1' : '') + ' WHERE id = ?').run(id);
  const row = db.prepare('SELECT id, user_id, username, content, created_at FROM card_comments WHERE id = ?').get(Number(info.lastInsertRowid));
  return res.json({ ok: true, comment: row });
});

// 删除评论（软删除，保留审计）：评论作者 / 卡片作者 / 管理员
router.delete('/comment', requireAuth, (req, res) => {
  const cid = parseInt(req.query.id || '0', 10) || 0;
  const row = db.prepare('SELECT id, target_type, target_id, user_id FROM card_comments WHERE id = ? AND deleted = 0').get(cid);
  if (!row) return res.status(404).json({ error: '未找到该评论' });
  const t = tableFor(row.target_type);
  const card = cardRow(row.target_type, row.target_id);
  const isCommentAuthor = row.user_id === req.user.id;
  const isCardAuthor = !!(card && card.author_id === req.user.id);
  const isAdmin = isAdminReq(req);
  if (!isCommentAuthor && !isCardAuthor && !isAdmin) return res.status(403).json({ error: '只能删除自己的评论' });
  db.prepare('UPDATE card_comments SET deleted = 1, deleted_by = ? WHERE id = ?').run(req.user.id, cid);
  // 计数回退：总评论数 -1；该用户在这张卡下已无有效评论时，评论人数 -1（热门分同步）
  const left = db.prepare('SELECT COUNT(*) AS c FROM card_comments WHERE target_type = ? AND target_id = ? AND user_id = ? AND deleted = 0').get(row.target_type, row.target_id, row.user_id).c;
  if (t) {
    db.prepare('UPDATE ' + t + ' SET comments = MAX(0, comments - 1)' + (left === 0 ? ', commenters = MAX(0, commenters - 1)' : '') + ' WHERE id = ?').run(row.target_id);
  }
  return res.json({ ok: true });
});

/** 卡片被删除时级联清掉它的社交数据（世界书/预设删除路由调用） */
function purgeCard(type, id) {
  try {
    db.prepare('DELETE FROM card_likes WHERE target_type = ? AND target_id = ?').run(type, id);
    db.prepare('DELETE FROM card_comments WHERE target_type = ? AND target_id = ?').run(type, id);
  } catch (e) { console.warn('[card] 级联清理失败:', type, id, e.message); }
}

module.exports = router;
module.exports.route = router;
module.exports.withLiked = withLiked;
module.exports.activeScores = activeScores;
module.exports.purgeCard = purgeCard;
module.exports.tableFor = tableFor;
module.exports.TABLES = TABLES;
module.exports.SCORE_COMMENT_WEIGHT = SCORE_COMMENT_WEIGHT;
module.exports.ACTIVE_WINDOW_MS = ACTIVE_WINDOW_MS;
module.exports._limiters = { likeLimiter, commentLimiter };
