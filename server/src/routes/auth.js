// 认证路由：验证码 / 注册 / 登录 / 会话
const express = require('express');
const crypto = require('node:crypto');
const db = require('../db');
const { sendMail } = require('../mailer');
const auth = require('../auth');
const config = require('../config');
const { createLimiter } = require('../ratelimit');

const router = express.Router();

const CODE_RESEND_MS = 60 * 1000;
const CODE_DAILY_MAX = 5;

const ipOf = (req) => (req.socket && req.socket.remoteAddress) || 'unknown';
// 防爆破：同一 IP+账号 10 次 / 10 分钟（登录成功即清零）
const loginLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
// 猜码保护：同一邮箱 10 次 / 10 分钟（验证通过即清零）——原先只有发信侧限流，校验侧可无限试
const codeGuessLimiter = createLimiter({ windowMs: 10 * 60 * 1000, max: 10 });
// 发信防轰炸：同一 IP 10 次 / 小时（按邮箱的 1 分钟 + 每日 5 次限制仍在 DB 侧）
const sendCodeLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 10 });
// 注册防刷：同一 IP 5 次 / 小时
const registerLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 5 });

// 发送验证码（注册 / 找回 / 登录）
router.post('/send-code', async (req, res, next) => {
  try {
    if (!sendCodeLimiter.allow(ipOf(req))) return res.status(429).json({ error: '发送太频繁，请稍后再试' });
    const email = String(req.body.email || '').trim().toLowerCase();
    const type = (req.body.type === 'reset' || req.body.type === 'login') ? req.body.type : 'register';
    if (!auth.validEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
    const now = Date.now();
    if (db.prepare('SELECT COUNT(*) c FROM verify_codes WHERE email = ? AND created_at > ?').get(email, now - CODE_RESEND_MS).c >= 1)
      return res.status(429).json({ error: '发送太频繁，请 1 分钟后再试' });
    if (db.prepare('SELECT COUNT(*) c FROM verify_codes WHERE email = ? AND created_at > ?').get(email, now - 86400000).c >= CODE_DAILY_MAX)
      return res.status(429).json({ error: '该邮箱今日发送次数已达上限' });
    const registered = !!db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (type === 'register' && registered) return res.status(409).json({ error: '该邮箱已注册，请直接登录或找回密码' });
    if (type !== 'register' && !registered) return res.status(404).json({ error: '该邮箱尚未注册' });
    const code = String(crypto.randomInt(100000, 999999));
    db.prepare('INSERT INTO verify_codes (email, code, type, expires_at, created_at, used) VALUES (?, ?, ?, ?, ?, 0)').run(email, code, type, now + auth.CODE_TTL_MS, now);
    db.prepare('DELETE FROM verify_codes WHERE expires_at < ?').run(now - 86400000); // 顺带清理过期记录
    try {
      const purpose = type === 'register' ? '注册账号' : (type === 'login' ? '验证码登录' : '找回密码');
      await sendMail(email, `【轻小说社区】${purpose}验证码：${code}`,
        `您正在${purpose}，验证码：${code}\n\n${auth.CODE_TTL_MS / 60000} 分钟内有效。若非本人操作，请忽略本邮件。`);
    } catch (e) {
      if (e.message === 'SMTP_NOT_CONFIGURED') return res.status(500).json({ error: '服务器未配置邮箱（管理员需填写 server/config.json）' });
      console.error('邮件发送失败:', e.message);
      return res.status(500).json({ error: '邮件发送失败，请稍后再试' });
    }
    return res.json({ ok: true });
  } catch (e) { next(e); }
});

// 重置密码（凭邮箱验证码）
router.post('/reset-password', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  const newPassword = String(req.body.newPassword || '');
  if (!auth.validEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!auth.validCode(code)) return res.status(400).json({ error: '验证码应为 6 位数字' });
  if (!auth.validPassword(newPassword)) return res.status(400).json({ error: '新密码至少 4 位' });
  const _ck = 'reset:' + email;
  if (!codeGuessLimiter.allow(_ck)) return res.status(429).json({ error: '尝试过于频繁，请 10 分钟后再试' });
  const vc = auth.findCode(email, code, 'reset');
  if (!vc) return res.status(400).json({ error: '验证码错误或已过期' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: '该邮箱尚未注册' });
  codeGuessLimiter.reset(_ck);
  const { salt, hash } = auth.hashPassword(newPassword);
  db.prepare('UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(hash, salt, user.id);
  auth.markCodeUsed(vc.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id); // 重置密码后强制所有设备重新登录
  return res.json({ ok: true });
});

// 注册（需邮箱验证码）
router.post('/register', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  if (!auth.validUsername(username)) return res.status(400).json({ error: '用户名需 2-20 位且只能由中英文/数字/_ 组成' });
  if (!auth.validPassword(password)) return res.status(400).json({ error: '密码至少 4 位' });
  if (!auth.validEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!auth.validCode(code)) return res.status(400).json({ error: '验证码应为 6 位数字' });
  if (!registerLimiter.allow(ipOf(req))) return res.status(429).json({ error: '注册过于频繁，请稍后再试' });
  const _ck = 'register:' + email;
  if (!codeGuessLimiter.allow(_ck)) return res.status(429).json({ error: '尝试过于频繁，请 10 分钟后再试' });
  const vc = auth.findCode(email, code, 'register');
  if (!vc) return res.status(400).json({ error: '验证码错误或已过期' });
  codeGuessLimiter.reset(_ck);
  try {
    const { salt, hash } = auth.hashPassword(password);
    const info = db.prepare('INSERT INTO users (username, pass_hash, pass_salt, created_at, email) VALUES (?, ?, ?, ?, ?)').run(username, hash, salt, Date.now(), email);
    const userId = Number(info.lastInsertRowid);
    auth.markCodeUsed(vc.id);
    const sess = auth.createSession(userId);
    return res.json({ token: sess.token, user: { id: userId, username, email } });
  } catch (e) {
    if (String(e.message).includes('idx_users_email')) return res.status(409).json({ error: '该邮箱已注册' });
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '用户名已被占用' });
    throw e;
  }
});

// 登录（邮箱 + 密码；用户名为昵称，不用于登录）
router.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!auth.validEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  const _lk = ipOf(req) + '|' + email;
  if (!loginLimiter.allow(_lk)) return res.status(429).json({ error: '尝试过于频繁，请 10 分钟后再试' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !auth.verifyPassword(password, user.pass_salt, user.pass_hash)) {
    return res.status(401).json({ error: '邮箱或密码错误' });
  }
  loginLimiter.reset(_lk);
  const sess = auth.createSession(user.id);
  return res.json({ token: sess.token, user: { id: user.id, username: user.username, email: user.email || '' } });
});

// 验证码登录（免密）
router.post('/login-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();
  if (!auth.validEmail(email)) return res.status(400).json({ error: '邮箱格式不正确' });
  if (!auth.validCode(code)) return res.status(400).json({ error: '验证码应为 6 位数字' });
  const _ck = 'login:' + email;
  if (!codeGuessLimiter.allow(_ck)) return res.status(429).json({ error: '尝试过于频繁，请 10 分钟后再试' });
  const vc = auth.findCode(email, code, 'login');
  if (!vc) return res.status(400).json({ error: '验证码错误或已过期' });
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) return res.status(404).json({ error: '该邮箱尚未注册' });
  codeGuessLimiter.reset(_ck);
  auth.markCodeUsed(vc.id);
  const sess = auth.createSession(user.id);
  return res.json({ token: sess.token, user: { id: user.id, username: user.username, email: user.email || '' } });
});

// 我是谁
router.get('/me', auth.requireAuth, (req, res) => {
  return res.json({ user: req.user });
});

// 退出登录
router.post('/logout', (req, res) => {
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  auth.revokeToken(bearer);
  return res.json({ ok: true });
});

// 修改昵称
router.post('/rename', auth.requireAuth, (req, res) => {
  const nickname = String(req.body.nickname || '').trim();
  if (!auth.validUsername(nickname)) return res.status(400).json({ error: '昵称需 2-20 位且只能由中英文/数字/_ 组成' });
  if (nickname === req.user.username) return res.json({ ok: true, user: { id: req.user.id, username: nickname } });
  try {
    db.prepare('UPDATE users SET username = ? WHERE id = ?').run(nickname, req.user.id);
    return res.json({ ok: true, user: { id: req.user.id, username: nickname } });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: '该昵称已被占用' });
    throw e;
  }
});

// 限流器随路由导出：测试可重置计数；启动侧统一 sweep
router._limiters = { loginLimiter, codeGuessLimiter, sendCodeLimiter, registerLimiter };

module.exports = router;