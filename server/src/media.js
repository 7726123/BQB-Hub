// 内容载荷工具：封面 data URI 的整串校验 + 上传文件在磁盘上的清理。
//
// 封面为什么要整串校验：cover 会被客户端拼进 <img src="..."> 属性。老版本 APK 没做转义
// 且改不动，只校验前缀时，载荷里带一个 " 就能闭合属性并注入 onerror → 存储型 XSS
// （在老客户端上可读取同源存储里的会话令牌与模型 key）。因此这里只接受「纯 base64 的
// 图片 data URI」，多一个字符都不放过。
const fs = require('node:fs');
const path = require('node:path');
const config = require('./config');

const COVER_MAX = 320 * 1024;   // 与路由的错误文案保持一致（超出提示「封面图片过大」）
const COVER_RE = /^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

/** 封面 data URI 是否合法：整串匹配（含 base64 字符集与填充），不允许任何多余字符 */
function validCover(s) {
  return typeof s === 'string' && s.length <= COVER_MAX && COVER_RE.test(s);
}

/** 某条内容的磁盘载荷路径（世界书/预设的 JSON、插件的清单与 zip）；拿不到合法路径时为空数组 */
function payloadPaths(type, row) {
  const root = path.normalize(config.UPLOAD_DIR);
  const list = [];
  const rel = (p) => {
    if (!p) return;
    const abs = path.normalize(path.join(root, p));
    if (abs.startsWith(root) && abs !== root) list.push(abs);
  };
  if (type === 'worldbook') rel(path.join('worldbook', String(row.filename || '')));
  else if (type === 'preset') rel(path.join('preset', String(row.filename || '')));
  else if (type === 'plugin') {
    rel(path.join('plugin', String(row.filename || '')));
    rel(path.join('plugin', 'files', String(row.plugin_id || '') + '.zip'));
  }
  return list;
}

/** 删除某条内容的磁盘载荷。best-effort：文件不存在/已删除都算成功（元数据与留痕不受影响） */
function removePayload(type, row) {
  let n = 0;
  for (const abs of payloadPaths(type, row)) {
    try { fs.unlinkSync(abs); n++; } catch (e) { /* 不存在或已删 */ }
  }
  return n;
}

module.exports = { validCover, removePayload, COVER_MAX };
