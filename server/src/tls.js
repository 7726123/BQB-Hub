// HTTPS 终端：自签证书直接由 Node 提供 TLS（不引入 nginx，保持单进程/单服务单元）。
// 客户端（Android App）内置同一张自签 CA（app/src/main/res/raw/bqb_ca.crt）作为信任锚，
// 因此不需要公共 CA / 域名。证书缺失时返回 null → 只跑 HTTP（本地开发、测试环境无证书也能启动）。
// 证书生成与续签见部署侧本地文档（不入库）。
const fs = require('node:fs');
const https = require('node:https');

function createTlsServer(app, config) {
  let key, cert;
  try {
    key = fs.readFileSync(config.TLS_KEY_FILE);
    cert = fs.readFileSync(config.TLS_CERT_FILE);
  } catch (e) {
    console.warn('[HTTPS] 未启用（证书不可读）:', e.message);
    return null;
  }
  // minVersion TLSv1.2：Android 5.1+ 全部支持，同时挡掉 SSLv3/TLS1.0/TLS1.1 等老旧协议
  const server = https.createServer({
    key,
    cert,
    minVersion: 'TLSv1.2',
    honorCipherOrder: true,
  }, app);
  server.on('tlsClientError', (err, socket) => {
    // 证书不受信任 / 协议不匹配等握手失败：只记一行，不打印堆栈（扫描器噪音大）
    console.warn('[HTTPS] 握手失败:', err.message);
    try { socket.destroy(); } catch (e) { /* ignore */ }
  });
  return server;
}

module.exports = { createTlsServer };
