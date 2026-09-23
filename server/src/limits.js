// 社区读写限流（世界书 / 预设 / 插件共用一份配额；单实例内存滑动窗，见 ratelimit.js）。
// 背景：列表接口会带上卡片封面（base64，最大 320KB/张），一次 pageSize=50 的响应可达十几 MB，
// 上传则是 2MB 正文 + 封面，且没有天然上限；此前这些路由完全没有限流。
const { createLimiter } = require('./ratelimit');

// 读（列表 / 检索 / 详情 / 预览 / 下载）：每账号每分钟 120 次。
// 按账号而不是按 IP：这些接口都要求登录，且移动网络大量用户共用运营商 NAT 出口，
// 按 IP 键控会互相误伤；按账号则一个账号满速也只能刷 120 次/分钟。
const readLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });
// 写（上传）：每账号每小时 30 次（一个账号满速也只能写入约 60MB/小时）
const uploadLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 30 });
// 检索元数据回填（秒上传后的后台补写）：每账号每小时 120 次
const metaLimiter = createLimiter({ windowMs: 60 * 60 * 1000, max: 120 });

// 审核队列（管理员，X-Admin-Token）：管理员接口没有账号维度，按 IP 键控，每分钟 120 次
const reviewLimiter = createLimiter({ windowMs: 60 * 1000, max: 120 });

function ipOf(req) { return (req.socket && req.socket.remoteAddress) || 'unknown'; }

/** 读接口：按账号限流（requireAuth 之后调用；异常情况下退回 IP 键控） */
function readLimited(req) {
  const key = req.user && req.user.id ? 'u' + req.user.id : 'ip' + ipOf(req);
  return !readLimiter.allow(key);
}
/** 写接口：按账号限流（必须在 requireAuth 之后调用，否则所有人共用一个桶） */
function uploadLimited(req) { return !uploadLimiter.allow('u' + ((req.user && req.user.id) || 0)); }
function metaLimited(req) { return !metaLimiter.allow('u' + ((req.user && req.user.id) || 0)); }
function reviewLimited(req) { return !reviewLimiter.allow('ip' + ipOf(req)); }

module.exports = { readLimiter, uploadLimiter, metaLimiter, reviewLimiter, readLimited, uploadLimited, metaLimited, reviewLimited, ipOf };
