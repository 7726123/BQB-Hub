// 应用组装：Express + 中间件管线（CORS / 请求日志 / 地区拦截 / 错误处理）
const express = require('express');
const crypto = require('node:crypto');
const config = require('./config');
const { isBlockedIp } = require('./region');
const { createLimiter } = require('./ratelimit');

const app = express();
app.disable('x-powered-by');

// ---------- 安全响应头（纯 API 服务：不需要被 iframe 嵌入，也不该被嗅探内容类型） ----------
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ---------- CORS（手机 http://局域网IP 访问本服务必需） ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  // 允许头清单要覆盖 App 实际会发的所有自定义头：漏一个 → 浏览器预检失败 → App 里报「网络错误」
  // （curl 不走预检，所以手工验证全绿也发现不了；见 tests/hardening.test.js 的 CORS 用例）
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Admin-Token, X-System-Key, X-Install-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
  next();
});
app.options('*', (req, res) => res.sendStatus(204));

// ---------- 请求日志（方法 / 路径 / 状态 / 耗时，带请求 ID） ----------
app.use((req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.id} ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// ---------- 地区拦截（布尔开关 config.regionBlock；大陆 IP → 403） ----------
app.use((req, res, next) => {
  if (config.regionBlock && isBlockedIp(req.socket.remoteAddress)) {
    return res.status(403).json({ error: '当前地区暂不可用' });
  }
  next();
});

// 3mb：路由内部按 2MB 校验内容（worldbook/preset），略高于它的 body 上限
// 让超限请求先由业务校验给出可读错误，而不是被 body 解析器统一吞成 400。
app.use(express.json({ limit: '3mb' }));

// 认证接口整体按 IP 限流（较宽松，兜住 /me 轮询与其余认证端点；更严的按账号限流在路由内）
const authIpLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });
app.use('/api/auth', (req, res, next) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!authIpLimiter.allow(ip)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  next();
});

// ---------- 路由 ----------
app.use('/api/auth', require('./routes/auth'));
app.use('/api/worldbook', require('./routes/worldbook'));
app.use('/api/preset', require('./routes/preset'));
app.use('/api/plugin', require('./routes/plugin')); // 社区插件市场（列表/上传/下载/删除）
app.use('/api/proxy', require('./routes/proxy'));   // 白名单 CORS 代理（opencode 等）
app.use('/api/card', require('./routes/card'));     // 卡片社交（点赞/评论）
app.use(require('./routes/review')); // /api/admin/review（审核队列）、/api/my/submissions（我的投稿）
app.use(require('./routes/feedback')); // 意见反馈：POST /api/feedback（公开，限流）+ /api/admin/feedback*（管理员）
app.use(require('./routes/system')); // /、/api/health、/api/app/version、/apk/*、/api/usage-assistant/miss

// ---------- 404 ----------
app.use((req, res) => {
  res.status(404).json({ error: '未找到 ' + req.path });
});

// ---------- 统一错误处理 ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // body 解析失败/过大：与客户端约定为 400
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: '无效的请求体' });
  }
  console.error(`[${req.id || '-'}]`, err);
  return res.status(500).json({ error: '服务器内部错误' });
});

app._graceLimiters = { authIpLimiter };

module.exports = app;