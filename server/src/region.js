// 地区限制：geoip-lite 判断请求来源国家。
// 注意：不能信任 X-Forwarded-For（可伪造），一律取 socket 直连地址。
// 开关：config.regionBlock（true/false），设计为简单布尔。
let geoip = null;
try { geoip = require('geoip-lite'); } catch (e) { /* 无 geoip 数据时永不拦截 */ }

function isBlockedIp(ip) {
  if (!geoip) return false;
  const clean = String(ip || '').replace(/^::ffff:/, '');
  if (!clean || clean === '127.0.0.1' || clean === '::1') return false;
  const r = geoip.lookup(clean);
  return !!r && r.country === 'CN';
}

module.exports = { isBlockedIp };