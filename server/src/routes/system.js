// 系统路由：健康检查 / App 版本 / APK 下载 / 使用助手反馈 / 客户端错误上报
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const db = require('../db');
const { createLimiter } = require('../ratelimit');
const { verifyPassword, issueToken, verifyToken } = require('../adminpass');
const { isAdminReq, isSystemReq } = require('../auth');

const router = express.Router();

// 常量时间字符串比较（长度不同直接判否；避免 adminKey 被逐字符时序探测）
function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// 管理员模式口令校验（App 管理员模式入口）。
// 限流 8 次/分钟/IP；未配置口令一律 403；口令错 401。不返回任何口令相关信息。
const adminLimiter = createLimiter({ windowMs: 60 * 1000, max: 8 });
router.post('/api/admin/verify', (req, res) => {
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!adminLimiter.allow(ip)) return res.status(429).json({ ok: false, error: '尝试过于频繁，请稍后再试' });
  if (!config.adminPasswordHash) return res.status(403).json({ ok: false, error: '管理员校验未配置' });
  const pw = (req.body && req.body.password) || '';
  if (typeof pw !== 'string' || pw.length === 0 || pw.length > 128) return res.status(401).json({ ok: false, error: '口令错误' });
  if (!verifyPassword(pw, config.adminPasswordHash)) return res.status(401).json({ ok: false, error: '口令错误' });
  // 同时签发「留档上报」令牌（12h，无状态 HMAC；App 端只存令牌不存口令）
  const tk = issueToken(config.adminPasswordHash) || {};
  return res.json({ ok: true, token: tk.token || '', exp: tk.exp || 0 });
});

// 健康检查（无需登录）
router.get(['/', '/api/health'], (req, res) => {
  return res.json({ ok: true, name: 'novel-writer-community', port: config.PORT });
});

// App 版本信息（整包更新检查，无需登录）
router.get('/api/app/version', (req, res) => {
  let info = null;
  try {
    const v = JSON.parse(fs.readFileSync(config.APP_VERSION_FILE, 'utf8'));
    if (v && v.versionCode) info = v;
  } catch (e) { /* 没有配置则返回空版本，App 端不提示 */ }
  if (!info) return res.json({ versionCode: 0, versionName: '', note: '', apkUrl: '' });
  // 协议感知：HTTPS 请求（App v1.5.65+ 走 TLS 端口）返回 https 下载地址，
  // 旧客户端走 HTTP 时保持 http——否则会把 TLS 端口写成明文地址导致下载失败。
  const proto = req.protocol === 'https' ? 'https' : 'http';
  const defaultUrl = proto + '://' + (req.headers.host || 'localhost:' + config.PORT) + '/apk/' + encodeURIComponent(String(info.apk || 'app.apk'));
  return res.json({
    versionCode: info.versionCode,
    versionName: info.versionName || '',
    note: info.note || '',
    apkUrl: info.apkUrl || defaultUrl
  });
});

// 网页包热更新（无需登录）：下发签名后的 manifest（payload + sig）。
// 渠道（channel=beta，系统版内测渠道）：只对系统版开放——带对 X-System-Key（叠加 X-Install-Id 白名单）
//   才读 manifest-beta.json；其余一律读正式 manifest.json。beta 缺失/损坏时同样回落正式，
//   所以「还没发过 beta」不会让系统版收不到包。
// 客户端只用 payload/sig 两个字段，其余字段仅供人工排查；未发布热包时返回空对象，客户端忽略。
// manifest 由 scripts/hot-bundle.mjs 离线签名生成，服务器无从伪造——即便服务器被拿下，
// 攻击者拿不到私钥也签不出能被客户端接受的包（见交接文档「热更新」章节）。
function readManifest(name) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(config.WEB_BUNDLE_DIR, name), 'utf8'));
    return (m && typeof m.payload === 'string' && typeof m.sig === 'string') ? m : null;
  } catch (e) { return null; }
}
router.get('/api/app/web-bundle', (req, res) => {
  const wantBeta = String(req.query.channel || '').trim() === 'beta' && isSystemReq(req);
  const man = (wantBeta ? readManifest('manifest-beta.json') : null) || readManifest('manifest.json');
  res.set('Cache-Control', 'no-store');
  return res.json(man || {});
});

// 网页包 zip 下载（/web-bundle/web-1.5.96w1.zip），无需登录
router.get('/web-bundle/:file', (req, res) => {
  const name = req.params.file || '';
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || !/^[\w.\-]+$/.test(name)) {
    return res.status(400).json({ error: 'invalid file name' });
  }
  const file = path.join(config.WEB_BUNDLE_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'bundle not found' });
    res.status(200)
      .set('Content-Type', 'application/zip')
      .set('Content-Length', st.size)
      .set('Cache-Control', 'no-store');
    fs.createReadStream(file).pipe(res);
  });
});

// APK 文件下载（/apk/novel-writer-41.apk），无需登录
router.get('/apk/:file', (req, res) => {
  const name = req.params.file || '';
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return res.status(400).json({ error: 'invalid file name' });
  }
  const file = path.join(config.APK_DIR, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.status(404).json({ error: 'apk not found' });
    res.status(200)
      .set('Content-Type', 'application/vnd.android.package-archive')
      .set('Content-Length', st.size)
      .set('Content-Disposition', 'attachment; filename="' + name + '"');
    fs.createReadStream(file).pipe(res);
  });
});

// ===== 匿名使用统计（App 每次启动 + 前台心跳上报）=====
// 只接收：随机安装标识 + 版本号 + 平台。不含任何内容/IP/设备信息；原始 IP 仅在内存限流里用，不入库。
// 客户端侧见 app/src/domain/stats.ts；管理端查看接口见下方 /api/admin/stats。
const pingLimiter = createLimiter({ windowMs: 3600 * 1000, max: 240 });
const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** 在线判定窗口：最后一次心跳在这个时间内算「正在使用」（客户端前台每 3 分钟一跳） */
const ONLINE_MS = 5 * 60 * 1000;

/** 按中国时区划天：服务器可能是 UTC，用上海时区保证「今天」与用户感知一致（sv-SE 输出 YYYY-MM-DD） */
function dayKey(ts) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date(ts));
}
function daysAgoKey(n) { return dayKey(Date.now() - n * 86400000); }

router.post('/api/app/ping', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').trim();
  if (!INSTALL_ID_RE.test(id)) return res.status(400).json({ error: 'bad install id' });
  if (!pingLimiter.allow(req.socket.remoteAddress || '')) return res.status(429).json({ error: 'rate limited' });
  const now = Date.now();
  const day = dayKey(now);
  try {
    // 版本字段每次都覆盖（空值 = 跑内置网页包，也要如实记下来，否则回退后数据会一直是旧热包版本）
    db.prepare(
      'INSERT INTO devices (install_id, first_ts, last_ts, first_day, last_day, app_version, web_version, platform) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?) '
      + 'ON CONFLICT(install_id) DO UPDATE SET last_ts = excluded.last_ts, last_day = excluded.last_day, '
      + 'app_version = excluded.app_version, web_version = excluded.web_version, platform = excluded.platform'
    ).run(id, now, now, day, day,
      String(b.v || '').slice(0, 40), String(b.w || '').slice(0, 40), String(b.plat || '').slice(0, 20));
    db.prepare('INSERT OR IGNORE INTO device_days (install_id, day) VALUES (?, ?)').run(id, day);
  } catch (e) {
    return res.status(500).json({ error: 'store fail' });
  }
  return res.json({ ok: true });
});

// 使用统计（管理员）：在线 / 今日 / 近 7 天 / 近 30 天 + 累计与版本分布。
// 口径说明：只统计「联网打开过 App 的设备」——纯离线使用无法被统计（客户端不上报即不知情），
// 所以这些数字是下界；同一设备多次启动只算一台（按安装标识去重，天维度用 device_days 主键）。
router.get('/api/admin/stats', (req, res) => {
  if (!isAdminReq(req)) return res.status(401).json({ error: '需要管理员令牌' });
  // 反馈未读数顺带带上：管理页/徽标进页时拉一次即可，不要另开轮询（服务器承压主要来自轮询）
  const feedbackUnread = (() => { try { return db.prepare('SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL').get().c; } catch (e) { return 0; } })();
  const now = Date.now();
  const today = dayKey(now);
  const one = (sql, ...args) => db.prepare(sql).get(...args).c;
  return res.json({
    feedbackUnread: feedbackUnread,
    online: one('SELECT COUNT(*) c FROM devices WHERE last_ts >= ?', now - ONLINE_MS),
    today: one('SELECT COUNT(*) c FROM device_days WHERE day = ?', today),
    week: one('SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?', daysAgoKey(6)),
    month: one('SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?', daysAgoKey(29)),
    total: one('SELECT COUNT(*) c FROM devices'),
    newToday: one('SELECT COUNT(*) c FROM devices WHERE first_day = ?', today),
    versions: db.prepare('SELECT app_version v, COUNT(*) c FROM devices GROUP BY app_version ORDER BY c DESC LIMIT 8').all(),
    webs: db.prepare('SELECT web_version w, COUNT(*) c FROM devices GROUP BY web_version ORDER BY c DESC LIMIT 8').all(),
    day: today,
    onlineWindowMs: ONLINE_MS,
  });
});

// 使用助手漏答反馈（客户端静默 POST 最近对话，供改进使用手册）
// 见 app/src/domain/assistant.ts 的标记协议：回答以【手册未覆盖】开头时触发
router.post('/api/usage-assistant/miss', (req, res) => {
  const body = req.body || {};
  if (!missLimiter.allow(req.socket.remoteAddress || '')) return res.status(429).json({ error: 'rate limited' });
  const conv = Array.isArray(body.conversation) ? body.conversation.slice(0, 8).map(function (m) {
    return { role: (m.role === 'user' ? 'user' : 'assistant'), content: String(m.content || '').slice(0, 500) };
  }) : [];
  if (conv.length === 0) return res.status(400).json({ error: 'empty' });
  // 只存 IP 的短哈希（去重/排查够用，不落可回溯的个人信息）
  const ipHash = crypto.createHash('sha256').update(String(req.socket.remoteAddress || '')).digest('hex').slice(0, 12);
  const line = JSON.stringify({ ts: new Date().toISOString(), ipHash: ipHash, conversation: conv });
  try {
    fs.appendFileSync(path.join(config.DATA_DIR, 'assistant-misses.jsonl'), line + '\n');
  } catch (e) {
    return res.status(500).json({ error: 'store fail' });
  }
  return res.json({ ok: true });
});

// 客户端错误上报（两级降级的第 2 级；第 1 级为客户端本地 __errLog 留档）。
// 客户端 fire-and-forget：本接口慢/不可达时客户端静默放弃，无重试语义，失败即丢。
// 限流走统一 limiter（带 sweep，桶不会无限增长）
const clLimiter = createLimiter({ windowMs: 3600 * 1000, max: 20 });
// 使用助手反馈：同一 IP 30 次 / 小时（防刷）
const missLimiter = createLimiter({ windowMs: 3600 * 1000, max: 30 });
// client_logs 裁剪：每 200 次写入清一次 90 天前的行（表不会无限增长）
const CL_KEEP_MS = 90 * 24 * 3600 * 1000;
let clInsertCount = 0;

router.post('/api/client-logs', (req, res) => {
  const body = req.body || {};
  const arr = Array.isArray(body.logs) ? body.logs : [];
  const items = arr.slice(0, 8).map((l) => ({
    ts: Number(l && l.t) || Date.now(),
    v: String((l && l.v) || '').slice(0, 40),
    plat: String((l && l.plat) || '').slice(0, 20),
    kind: String((l && l.k) || '').slice(0, 60),
    msg: String((l && l.m) || '').slice(0, 400),
    w: String((l && l.w) || '').slice(0, 40)
  })).filter((x) => x.kind && x.msg);
  if (items.length === 0) return res.status(400).json({ error: 'empty' });
  const ip = req.socket.remoteAddress || '';
  if (!clLimiter.allow(ip)) return res.status(429).json({ error: 'rate limited' });
  const ins = db.prepare('INSERT INTO client_logs (ts, app_version, platform, kind, msg, ua, web) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const ua = String(req.headers['user-agent'] || '').slice(0, 200);
  items.forEach((it) => ins.run(it.ts, it.v, it.plat, it.kind, it.msg, ua, it.w));
  if (++clInsertCount % 200 === 0) {
    try { db.prepare('DELETE FROM client_logs WHERE ts < ?').run(Date.now() - CL_KEEP_MS); } catch (e) { /* 裁剪失败不影响写入 */ }
  }
  return res.json({ ok: true, stored: items.length });
});

// 查看上报（运维用）：需 adminKey（config.json 的 adminKey 或环境变量 ADMIN_KEY），未配置一律 403
router.get('/api/client-logs', (req, res) => {
  if (!config.adminKey || !safeEqual(req.headers['x-admin-key'] || '', config.adminKey)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const rows = db.prepare('SELECT ts, app_version, platform, kind, msg, ua, web FROM client_logs ORDER BY ts DESC LIMIT ?').all(limit);
  return res.json({ logs: rows });
});

// ===== 管理员模式留档（指令 / 续写 / 记忆召回内容）=====
// 写入需要「留档令牌」（/api/admin/verify 签发）；读取/清空需要 adminKey（与 client-logs 同款）。
const traceLimiter = createLimiter({ windowMs: 60 * 1000, max: 60 });
const TRACE_KEEP = 1000;   // 只保留最近 1000 条，超出自动裁剪

router.post('/api/admin/trace', (req, res) => {
  const bySystemKey = isSystemReq(req);   // 系统版：机器凭据（无令牌、无口令框）
  if (!bySystemKey && !config.adminPasswordHash) return res.status(403).json({ ok: false, error: '管理员校验未配置' });
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : String(req.headers['x-admin-token'] || '');
  if (!bySystemKey && !verifyToken(config.adminPasswordHash, token)) return res.status(401).json({ ok: false, error: '令牌无效或已过期' });
  const ip = req.socket.remoteAddress || '';
  if (!traceLimiter.allow(ip)) return res.status(429).json({ ok: false, error: '请求过于频繁' });
  const b = req.body || {};
  const cut = (v, n) => String(v == null ? '' : v).slice(0, n);
  const row = {
    ts: Number(b.ts) || Date.now(),
    book: cut(b.book, 120),
    round: Number(b.round) || 0,
    model: cut(b.model, 80),
    window_chars: Number(b.windowChars) || 0,
    budget: Number(b.budget) || 0,
    instruction: cut(b.instruction, 2000),
    continuation: cut(b.continuation, 20000),
    recall_json: cut(typeof b.recall === 'string' ? b.recall : JSON.stringify(b.recall || []), 200000),
  };
  const ins = db.prepare('INSERT INTO admin_traces (ts, book, round, model, window_chars, budget, instruction, continuation, recall_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const info = ins.run(row.ts, row.book, row.round, row.model, row.window_chars, row.budget, row.instruction, row.continuation, row.recall_json);
  try {
    db.prepare('DELETE FROM admin_traces WHERE id <= (SELECT MAX(id) - ? FROM admin_traces)').run(TRACE_KEEP);
  } catch (e) { /* 裁剪失败不影响写入 */ }
  return res.json({ ok: true, id: info.lastInsertRowid });
});

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

router.get('/api/admin/traces', (req, res) => {
  if (!config.adminKey || !safeEqual(req.headers['x-admin-key'] || '', config.adminKey)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const book = String(req.query.book || '');
  const rows = book
    ? db.prepare('SELECT * FROM admin_traces WHERE book = ? ORDER BY ts DESC LIMIT ? OFFSET ?').all(book, limit, offset)
    : db.prepare('SELECT * FROM admin_traces ORDER BY ts DESC LIMIT ? OFFSET ?').all(limit, offset);
  if (String(req.query.format || '') === 'html') {
    const body = rows.map((r) => {
      let recall = [];
      try { recall = JSON.parse(r.recall_json || '[]'); } catch (e) { recall = []; }
      const pieces = (recall.pieces || []).map((p, i) => '<li><b>[' + (i + 1) + ']</b> ' + escapeHtml(String(p.head || '').slice(0, 120))
        + ' … <span style="color:#888">(' + (p.chars || 0) + ' 字' + (p.src ? '｜' + escapeHtml(p.src) : '') + ')</span></li>').join('');
      return '<section style="border:1px solid #ddd;border-radius:8px;padding:10px 14px;margin:12px 0">'
        + '<div style="color:#666;font-size:13px">#' + r.id + ' · ' + new Date(r.ts).toLocaleString('zh-CN')
        + ' · 书：' + escapeHtml(r.book) + ' · 第 ' + r.round + ' 轮 · 模型 ' + escapeHtml(r.model)
        + ' · 窗口 ' + r.window_chars + ' 字 · 回读预算 ' + r.budget + ' 字</div>'
        + '<div style="margin:6px 0"><b>指令：</b>' + (escapeHtml(r.instruction) || '<i>（无）</i>') + '</div>'
        + '<div style="margin:6px 0"><b>记忆召回（' + (recall.pieces || []).length + ' 段 / '
        + (recall.chars || 0) + ' 字' + (recall.candidates != null ? '，候选 ' + recall.candidates : '')
        + '）：</b><ul style="margin:4px 0 4px 18px;padding:0">' + (pieces || '<li><i>无</i></li>') + '</ul></div>'
        + '<details><summary style="cursor:pointer"><b>续写正文</b></summary><pre style="white-space:pre-wrap;font-family:inherit">'
        + escapeHtml(r.continuation) + '</pre></details></section>';
    }).join('');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><meta charset="utf-8"><title>管理员模式留档</title>'
      + '<body style="font-family:-apple-system,Microsoft YaHei,sans-serif;max-width:920px;margin:20px auto;padding:0 14px">'
      + '<h2>管理员模式留档（最近 ' + rows.length + ' 条）</h2>'
      + '<p style="color:#666;font-size:13px">读取/清空需 adminKey；写入由 App 在管理员模式下自动完成。'
      + '加 <code>&amp;format=json</code> 可取原始 JSON。</p>' + (body || '<p><i>暂无数据</i></p>') + '</body>');
  }
  return res.json({ traces: rows });
});

router.delete('/api/admin/traces', (req, res) => {
  if (!config.adminKey || !safeEqual(req.headers['x-admin-key'] || '', config.adminKey)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const info = db.prepare('DELETE FROM admin_traces').run();
  return res.json({ ok: true, deleted: info.changes });
});

// 测试钩子：导出本路由的内存限流器（adminLimiter 供测试清桶，见 tests/helpers.js）
router._limiters = { clLimiter, missLimiter, traceLimiter, adminLimiter };

module.exports = router;