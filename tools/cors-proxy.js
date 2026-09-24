/* ========================================================================
   本地 CORS 代理 - BQB Hub 浏览器调试辅助
   ------------------------------------------------------------------------
   作用：浏览器直接 fetch https://API 会被 CORS 拦截（手机版 Cordova 容器
   无此限制）。此代理监听本地端口，把 /chat/completions 请求转发到
   x-upstream-host 头指定的上游 HTTPS 端点，并在响应中附加 CORS 头，
   使浏览器调试环境也能直连 OpenAI 兼容 API（DeepSeek / 火山方舟等）。

   配合：app/src/domain/api.ts（打包进 web/modules/main.js）检测到 window.__PROXY_PORT__ 时自动走此代理；
        web/index.html 在 127.0.0.1/localhost 调试环境下自动注入该端口。

   用法：node cors-proxy.js [端口，默认 8898]
   ======================================================================== */
const http = require('http');
const https = require('https');

const PORT = parseInt(process.argv[2] || '8898', 10);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-upstream-host',
  'Access-Control-Expose-Headers': '*'
};

// 透传这些响应头（流式 SSE 依赖 content-type 与缓存头）
const PASSTHROUGH_HEADERS = ['content-type', 'content-encoding', 'transfer-encoding', 'cache-control', 'x-request-id'];

const server = http.createServer((req, res) => {
  // 浏览器 preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, CORS_HEADERS);
    res.end('only POST allowed');
    return;
  }
  // 上游 host 解析（两种来源）：
  // 1. x-upstream-host 请求头（api.js 新版显式携带）
  // 2. 路径前缀（协议格式：http://127.0.0.1:PORT/<host>/<path>，ZCode 宿主代理同款）
  let host = req.headers['x-upstream-host'] || null;
  let realPath = req.url;
  const pathHostMatch = req.url.match(/^\/([a-zA-Z0-9.-]+(?::\d+)?)\/(.*)$/);
  // 只有「没带 x-upstream-host 头」时才把首段当上游 host 剥掉：
  // 带了头还照剥的话，/api/coding/v3/chat/completions 会被吃成 /coding/v3/... → 上游 404（2026-09-25 实测踩到）。
  if (pathHostMatch && !host) {
    host = pathHostMatch[1];
    realPath = '/' + pathHostMatch[2];
  }
  if (!host || !/^[a-zA-Z0-9.-]+(:\d+)?$/.test(host)) {
    res.writeHead(400, CORS_HEADERS);
    res.end('missing or invalid upstream host');
    return;
  }
  const upstream = https.request({
    host: host,
    path: realPath,
    method: 'POST',
    headers: Object.assign({}, req.headers, { host: host })
  }, (upRes) => {
    const headers = Object.assign({}, CORS_HEADERS);
    PASSTHROUGH_HEADERS.forEach(function(k) {
      const v = upRes.headers[k];
      if (v) headers[k] = v;
    });
    res.writeHead(upRes.statusCode || 502, headers);
    upRes.pipe(res);
  });
  upstream.on('error', function(e) {
    // 上游报错既可能发生在写响应头之前（DNS/连接失败），也可能在之后（浏览器中途 reload、上游断流）。
    // 之后那种情况再 writeHead 会抛 ERR_HTTP_HEADERS_SENT 把整个代理进程带崩（2026-09-25 实测踩到：
    // 页面刷新把请求掐掉 → 代理直接退出，后续浏览器调试全部连不上）。
    if (res.headersSent) { res.destroy(); return; }
    try { res.writeHead(502, CORS_HEADERS); res.end('proxy error: ' + e.message); }
    catch (e2) { try { res.destroy(); } catch (e3) { /* ignore */ } }
  });
  req.on('error', function() { try { upstream.destroy(); } catch (e) { /* ignore */ } });
  req.pipe(upstream);
});

server.listen(PORT, '127.0.0.1', function() {
  console.log('[cors-proxy] listening on http://127.0.0.1:' + PORT);
});
