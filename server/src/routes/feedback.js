// 意见反馈：用户单向提交（匿名） + 管理员查看 / 标记已读 / 删除。
//
// 隐私：只存内容 + 随机安装标识 + 版本/平台；**原始 IP 只在内存限流里用，不入库**（与 /api/app/ping 同口径）。
//
// 限流（全部服务端强制，客户端限制只是体验）：
//   · 用户可见规则只有一条：**每分钟最多 2 条**（超了回 429 并给出文案，客户端不弹感谢）；
//   · 兜底三条，防"2 条/分钟 × 24 小时 = 2880 条/天"把队列刷爆：
//       同一设备最近 24 小时 20 条（install_id 维度，落库计数，重启不丢）
//       同一 IP 每小时 20 条（内存窗口）
//       全站最近 1 小时 200 条（落库计数，重启不丢）
//   正常用户碰不到兜底（一天提 20 条意见已经是重度用户），恶意刷才会撞上。
const express = require('express');
const db = require('../db');
const { createLimiter } = require('../ratelimit');
const { isAdminReq } = require('../auth');
const limits = require('../limits');
const { ipOf } = limits;   // ipOf 在 limits.js（取 socket.remoteAddress）

const router = express.Router();

const MAX_LEN = 300;              // 单条上限，按**码点**计（emoji 不会被算成两个字符）
const MAX_ITEMS = 1000;           // 保留条数上限
const DEDUPE_MS = 10 * 60 * 1000; // 同一设备 10 分钟内提交完全相同的内容 → 不重复入库（用户侧照常感谢）
const DEVICE_DAILY_MAX = 20;      // 兜底：同一设备最近 24 小时最多 20 条
const GLOBAL_HOURLY_MAX = 200;    // 兜底：全站最近 1 小时最多 200 条
const LIST_MAX = 200;             // 管理端一次最多返回多少条
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const deviceLimiter = createLimiter({ windowMs: 60 * 1000, max: 2 });        // 用户可见：2 条/分钟/设备
const ipLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 20 });      // 兜底：20 条/小时/IP
const adminLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });       // 管理端：120 次/分钟/IP（与审核队列同口径）

/** 按码点计长度：中文/emoji 一个都算 1（String.length 会把 emoji 算成 2，和界面提示对不上）。 */
function cpLen(s) { return Array.from(String(s || '')).length; }

function countSince(sql, ...args) { return db.prepare(sql).get(...args).c; }

// 插入 + 裁剪放同一事务，避免并发下把 1000 这个数算歪。
// 注意：运行时是 Node 内置 node:sqlite（不是 better-sqlite3），**没有 db.transaction()**，
// 只能自己 BEGIN/COMMIT/ROLLBACK。
function insertAndTrim(row) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT INTO feedback (text, install_id, version, platform, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(row.text, row.installId, row.version, row.platform, row.now);
    let over = countSince('SELECT COUNT(*) c FROM feedback') - MAX_ITEMS;
    let trimmed = 0;
    if (over > 0) {
      // 先删最旧的「已查看」
      trimmed += db.prepare(
        'DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE read_at IS NOT NULL ORDER BY created_at ASC LIMIT ?)'
      ).run(over).changes;
      over = countSince('SELECT COUNT(*) c FROM feedback') - MAX_ITEMS;
      if (over > 0) {
        trimmed += db.prepare(
          'DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE read_at IS NULL ORDER BY created_at ASC LIMIT ?)'
        ).run(over).changes;
      }
      if (trimmed > 0) {
        db.prepare("INSERT INTO feedback_meta (k, v) VALUES ('trimmed', ?) ON CONFLICT(k) DO UPDATE SET v = v + ?")
          .run(trimmed, trimmed);
      }
    }
    db.exec('COMMIT');
    return trimmed;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 回滚失败也不掩盖原始错误 */ }
    throw e;
  }
}

// ===== 提交（公开，无鉴权，按设备/IP/全站限流）=====
router.post('/api/feedback', (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return res.status(400).json({ error: '内容不能为空' });
  if (cpLen(text) > MAX_LEN) return res.status(400).json({ error: '内容超过 ' + MAX_LEN + ' 字' });
  const id = String(b.id || '').trim();
  if (!INSTALL_ID_RE.test(id)) return res.status(400).json({ error: 'bad install id' });
  const now = Date.now();
  try {
    // 用户可见的那条规则：每分钟 2 条（放在最前面，保证它是用户真正会撞到的限制）
    if (!deviceLimiter.allow('d' + id)) return res.status(429).json({ error: '提得太频繁了，请过一分钟再试' });
    // 兜底
    if (!ipLimiter.allow('ip' + ipOf(req))) return res.status(429).json({ error: '提交过于频繁，请稍后再试' });
    if (countSince('SELECT COUNT(*) c FROM feedback WHERE install_id = ? AND created_at > ?', id, now - 86400000) >= DEVICE_DAILY_MAX) {
      return res.status(429).json({ error: '今天提交得有点多，明天再来吧' });
    }
    if (countSince('SELECT COUNT(*) c FROM feedback WHERE created_at > ?', now - 3600000) >= GLOBAL_HOURLY_MAX) {
      return res.status(429).json({ error: '服务器正忙，请稍后再试' });
    }
    // 同设备 10 分钟内重复内容：不重复入库，但仍然答"收到"（用户看到的是一次正常提交）
    const dup = db.prepare('SELECT id FROM feedback WHERE install_id = ? AND text = ? AND created_at > ? LIMIT 1')
      .get(id, text, now - DEDUPE_MS);
    if (dup) return res.json({ ok: true, deduped: true });
    insertAndTrim({
      text,
      installId: id,
      version: String(b.v || '').slice(0, 40),
      platform: String(b.plat || '').slice(0, 20),
      now,
    });
  } catch (e) {
    console.warn('[feedback] 写入失败:', e.message);
    return res.status(500).json({ error: 'store fail' });
  }
  return res.json({ ok: true });
});

// ===== 管理端：列表（未查看 / 已查看 / 全部）=====
router.get('/api/admin/feedback', (req, res) => {
  if (limits.reviewLimited(req) || !adminLimiter.allow('ip' + ipOf(req))) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  if (!isAdminReq(req)) return res.status(401).json({ error: '需要管理员令牌' });
  const status = String(req.query.status || 'unread').trim();
  if (['unread', 'read', 'all'].indexOf(status) < 0) return res.status(400).json({ error: '未知的状态' });
  let limit = parseInt(req.query.limit, 10);
  if (!limit || limit < 1) limit = 50;
  if (limit > LIST_MAX) limit = LIST_MAX;
  const where = status === 'unread' ? ' WHERE read_at IS NULL' : (status === 'read' ? ' WHERE read_at IS NOT NULL' : '');
  try {
    const items = db.prepare(
      'SELECT id, text, version, platform, created_at, read_at FROM feedback' + where + ' ORDER BY created_at DESC LIMIT ?'
    ).all(limit);
    const trimmedRow = db.prepare("SELECT v FROM feedback_meta WHERE k = 'trimmed'").get();
    return res.json({
      items,
      unread: countSince('SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL'),
      read: countSince('SELECT COUNT(*) c FROM feedback WHERE read_at IS NOT NULL'),
      total: countSince('SELECT COUNT(*) c FROM feedback'),
      trimmed: trimmedRow ? trimmedRow.v : 0,
    });
  } catch (e) {
    console.warn('[feedback] 读取失败:', e.message);
    return res.status(500).json({ error: 'read fail' });
  }
});

// ===== 管理端：标记已读（逐条或全部）=====
router.post('/api/admin/feedback/read', (req, res) => {
  if (limits.reviewLimited(req) || !adminLimiter.allow('ip' + ipOf(req))) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  if (!isAdminReq(req)) return res.status(401).json({ error: '需要管理员令牌' });
  const b = req.body || {};
  const now = Date.now();
  try {
    if (b.all === true) {
      const n = db.prepare('UPDATE feedback SET read_at = ? WHERE read_at IS NULL').run(now).changes;
      return res.json({ ok: true, changed: n });
    }
    const ids = (Array.isArray(b.ids) ? b.ids : []).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, LIST_MAX);
    if (!ids.length) return res.status(400).json({ error: '没有要标记的条目' });
    const stmt = db.prepare('UPDATE feedback SET read_at = ? WHERE id = ? AND read_at IS NULL');
    let changed = 0;
    for (const id of ids) changed += stmt.run(now, id).changes;
    return res.json({ ok: true, changed });
  } catch (e) {
    return res.status(500).json({ error: 'mark fail' });
  }
});

// ===== 管理端：删除（垃圾/误发）=====
router.post('/api/admin/feedback/delete', (req, res) => {
  if (limits.reviewLimited(req) || !adminLimiter.allow('ip' + ipOf(req))) {
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  if (!isAdminReq(req)) return res.status(401).json({ error: '需要管理员令牌' });
  const b = req.body || {};
  const ids = (Array.isArray(b.ids) ? b.ids : [b.id]).map((x) => parseInt(x, 10)).filter((x) => Number.isInteger(x) && x > 0).slice(0, LIST_MAX);
  if (!ids.length) return res.status(400).json({ error: '没有要删除的条目' });
  try {
    const stmt = db.prepare('DELETE FROM feedback WHERE id = ?');
    let changed = 0;
    for (const id of ids) changed += stmt.run(id).changes;
    return res.json({ ok: true, changed });
  } catch (e) {
    return res.status(500).json({ error: 'delete fail' });
  }
});

module.exports = router;
module.exports.MAX_LEN = MAX_LEN;
module.exports.MAX_ITEMS = MAX_ITEMS;
// 测试钩子：内存窗口限流器（测试里连续发请求需要 clear() 清桶；生产不使用）
module.exports.__limiters = { deviceLimiter, ipLimiter, adminLimiter };
