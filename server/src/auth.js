// 认证域：密码哈希（scrypt+随机盐）、会话 Token、输入校验、鉴权中间件
const crypto = require('node:crypto');
const db = require('./db');

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天，满足"本机免登录"
const USERNAME_MIN = 2, USERNAME_MAX = 20, PASSWORD_MIN = 4;
const CODE_TTL_MS = 10 * 60 * 1000;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expected) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()); // 顺带清理过期会话
  return { token, expiresAt };
}
function getUserByToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT s.token, u.id, u.username, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token = ?').run(token); return null; }
  return { id: row.id, username: row.username, email: row.email || '' };
}
function revokeToken(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// ---------- 校验 ----------
function validUsername(u) { return typeof u === 'string' && /^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(u) && u.length >= USERNAME_MIN && u.length <= USERNAME_MAX; }
function validPassword(p) { return typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= 64; }
function validEmail(e) { return typeof e === 'string' && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(e) && e.length <= 64; }
function validCode(c) { return typeof c === 'string' && /^\d{6}$/.test(c); }

function findCode(email, code, type) {
  return db.prepare('SELECT * FROM verify_codes WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at > ? ORDER BY id DESC LIMIT 1').get(email, code, type, Date.now());
}
function markCodeUsed(id) { db.prepare('UPDATE verify_codes SET used = 1 WHERE id = ?').run(id); }

// 鉴权中间件：从 Authorization: Bearer 取 token，失败 401
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const me = getUserByToken(bearer);
  if (!me) return res.status(401).json({ error: '未登录或登录已过期' });
  req.user = me;
  next();
}

// 管理员请求判定（App 管理员模式）：X-Admin-Token = /api/admin/verify 签发的无状态 HMAC 令牌。
// 用途：admin_only 世界书（测试数据集）只对开了管理员模式的客户端可见 / 可检索。
function isAdminReq(req) {
  try {
    const config = require('./config');
    const { verifyToken } = require('./adminpass');
    if (!config.adminPasswordHash) return false;
    const tk = String(req.headers['x-admin-token'] || '').trim();
    if (!tk) return false;
    return verifyToken(config.adminPasswordHash, tk);
  } catch (e) { return false; }
}

module.exports = {
  TOKEN_TTL_MS, USERNAME_MIN, USERNAME_MAX, PASSWORD_MIN, CODE_TTL_MS,
  hashPassword, verifyPassword, createSession, getUserByToken, revokeToken,
  validUsername, validPassword, validEmail, validCode, findCode, markCodeUsed,
  requireAuth, isAdminReq
};