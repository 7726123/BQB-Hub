// 管理员口令校验（App 管理员模式用）。
// 只存 scrypt 派生值，明文口令不落任何文件：
//   存储格式 scrypt$N$r$p$<salt base64>$<hash base64>
//   生成：node -e "const a=require('./src/adminpass');console.log(a.hashPassword(process.env.PW))"（PW 走环境变量）
// 校验走 timingSafeEqual，避免逐字符时序探测；调用方负责限流。
const crypto = require('node:crypto');

const N = 16384;      // CPU/内存成本（2^14）
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_LEN = 16;

function hashPassword(password, saltBuf) {
  const salt = saltBuf || crypto.randomBytes(SALT_LEN);
  const hash = crypto.scryptSync(Buffer.from(String(password || ''), 'utf8'), salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

/** 校验口令。stored 为空/格式不对一律 false（未配置即禁用）。 */
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const n = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
    const salt = Buffer.from(parts[4], 'base64');
    const want = Buffer.from(parts[5], 'base64');
    if (!salt.length || !want.length) return false;
    const got = crypto.scryptSync(Buffer.from(String(password || ''), 'utf8'), salt, want.length, { N: n, r, p });
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  } catch (e) {
    return false;
  }
}

// ==== 留档令牌（管理员模式上报用）====
// 无状态 HMAC 令牌：payload = 过期时间戳，密钥 = 服务器上的口令派生值。
// 优点：不引入会话表、重启不失效、不下发任何口令信息；有效期默认 12 小时。
const TOKEN_TTL_MS = 12 * 3600 * 1000;
function _mac(storedHash, exp) {
  return crypto.createHmac('sha256', String(storedHash)).update('admin-trace:' + exp).digest('base64url');
}
function issueToken(storedHash, ttlMs) {
  if (!storedHash) return null;
  const exp = Date.now() + (Number(ttlMs) > 0 ? Number(ttlMs) : TOKEN_TTL_MS);
  return { token: exp + '.' + _mac(storedHash, exp), exp };
}
function verifyToken(storedHash, token) {
  try {
    if (!storedHash) return false;
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return false;
    const exp = Number(parts[0]);
    if (!Number.isFinite(exp) || Date.now() > exp) return false;
    const want = _mac(storedHash, exp);
    const got = parts[1];
    return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  } catch (e) { return false; }
}

module.exports = { hashPassword, verifyPassword, issueToken, verifyToken, TOKEN_TTL_MS, PARAMS: { N, R, P, KEYLEN, SALT_LEN } };
