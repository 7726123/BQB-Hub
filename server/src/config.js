// 配置中心：路径 / 端口 / SMTP / 地区限制，支持环境变量覆盖（测试隔离用）
const fs = require('node:fs');
const path = require('node:path');

const SERVER_ROOT = path.join(__dirname, '..');
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(SERVER_ROOT, 'config.json');

const defaults = {
  PORT: Number(process.env.PORT) || 8899,
  DATA_DIR: process.env.DATA_DIR || path.join(SERVER_ROOT, 'data'),
  UPLOAD_DIR: process.env.UPLOAD_DIR || path.join(SERVER_ROOT, 'uploads'),
  APK_DIR: process.env.APK_DIR || path.join(SERVER_ROOT, 'apk'),
  APP_VERSION_FILE: process.env.APP_VERSION_FILE || path.join(SERVER_ROOT, 'app-version.json'),
  // 网页包热更新：zip 与 manifest.json 放这里（由 scripts/hot-bundle.mjs 打包签名后上传）
  WEB_BUNDLE_DIR: process.env.WEB_BUNDLE_DIR || path.join(SERVER_ROOT, 'web-bundles'),
  // 地区限制：true 时封锁中国大陆 IP（HTTP 403 + WS 拒绝）。设计为简单布尔开关。
  regionBlock: false,
  // 客户端错误上报查看口令（GET /api/client-logs 需 x-admin-key 头）。
  // 空值 = 查看接口关闭（403）。支持环境变量 ADMIN_KEY 覆盖。
  adminKey: process.env.ADMIN_KEY || '',
  // App「管理员模式」口令的 scrypt 派生值（明文不落任何文件）。空值 = 该入口关闭（403）。
  // 只从服务器本地 config.json（不入库）或环境变量 ADMIN_PW_HASH 读取。
  adminPasswordHash: process.env.ADMIN_PW_HASH || '',
  // HTTPS：自签证书终端 TLS（App 内置同一张 CA 作为信任锚，签发与续期见部署侧本地文档）。
  // 证书文件不存在时自动跳过 HTTPS 监听（本地开发/测试无证书照常跑 HTTP），不影响旧客户端。
  // 端口由 TLS_PORT 控制（默认 80）：具体放行哪些端口由部署方安全组决定，改端口时
  // App 端 app/src/lib/server-url.ts 的 HTTPS_PORT 需同步并重新发版。
  TLS_PORT: Number(process.env.TLS_PORT) || 80,
  TLS_CERT_FILE: process.env.TLS_CERT_FILE || path.join(SERVER_ROOT, 'certs', 'server.crt'),
  TLS_KEY_FILE: process.env.TLS_KEY_FILE || path.join(SERVER_ROOT, 'certs', 'server.key'),
  smtp: { host: '', port: 465, secure: true, user: '', pass: '', from: '' }
};

try {
  const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (c && typeof c.regionBlock === 'boolean') defaults.regionBlock = c.regionBlock;
  if (c && typeof c.adminKey === 'string') defaults.adminKey = c.adminKey.trim();
  if (c && typeof c.adminPasswordHash === 'string') defaults.adminPasswordHash = c.adminPasswordHash.trim();
  if (c && c.smtp) defaults.smtp = Object.assign(defaults.smtp, c.smtp);
} catch (e) { /* 无配置文件时使用默认值 */ }

module.exports = defaults;