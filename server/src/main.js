// 启动入口（工程化版本）：node src/main.js
// 双端口并存：HTTP（旧客户端 / 局域网调试）+ HTTPS（Android 7+ 客户端，自签证书内置信任）。
const http = require('node:http');
const os = require('node:os');
const app = require('./app');
const config = require('./config');
const { createTlsServer } = require('./tls');
const { startSweeper } = require('./ratelimit');

// 限流器空桶回收（10 分钟一次；unref 不阻塞进程退出）
startSweeper([
  require('./app')._graceLimiters.authIpLimiter,
  require('./routes/auth')._limiters.loginLimiter,
  require('./routes/auth')._limiters.codeGuessLimiter,
  require('./routes/auth')._limiters.sendCodeLimiter,
  require('./routes/auth')._limiters.registerLimiter,
  require('./routes/system')._limiters.clLimiter,
  require('./routes/system')._limiters.missLimiter,
  require('./routes/card')._limiters.likeLimiter,
  require('./routes/card')._limiters.commentLimiter,
  require('./routes/proxy')._limiters.proxyLimiter,
  require('./limits').readLimiter,
  require('./limits').uploadLimiter,
  require('./limits').metaLimiter,
  require('./limits').reviewLimiter,
], 10 * 60 * 1000);

// ---- HTTP（保持监听：升级到 HTTPS 之前的旧版 App 仍连这里，不能停） ----
const httpServer = http.createServer(app);

httpServer.listen(config.PORT, '0.0.0.0', () => {
  console.log('=== BQB Hub 社区服务已启动（工程化版本 src/main.js）===');
  console.log('HTTP  端口:', config.PORT, '(旧客户端兼容；局域网手机可访问)');
  console.log('本机访问: http://127.0.0.1:' + config.PORT);
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log('手机访问(同一WiFi): http://' + net.address + ':' + config.PORT);
      }
    }
  }
});

// ---- HTTPS（自签证书 + App 内置信任；证书缺失时静默跳过） ----
const httpsServer = createTlsServer(app, config);
if (httpsServer) {
  httpsServer.listen(config.TLS_PORT, '0.0.0.0', () => {
    console.log('HTTPS 端口:', config.TLS_PORT, '(自签证书；App v1.5.65+ 走这里)');
  });
  httpsServer.on('error', (e) => {
    console.error('[HTTPS] 监听失败:', e.message);
  });
}
