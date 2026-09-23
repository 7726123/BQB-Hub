// CORS 代理：把浏览器/WebView 无法直连的无 CORS 端点（如 opencode.ai）改为经本服务器转发。
// 用法：App 的 API endpoint 填 /api/proxy/opencode/v1，其余（key/model/body）原样透传。
// 安全：
//   1. 只允许白名单 target，防止被当作任意流量代理（SSRF）；
//   2. 按 IP 限流（默认 60 次/分钟）——本接口转发时不校验登录态（请求头里的 Authorization
//      是调用方自己的模型 key，不是本站会话令牌），所以必须靠限流挡住「拿服务器当免费出口」；
//   3. 上游超时（5 分钟，覆盖长文本流式生成），超时返回 504 而不是挂住连接。
const express = require('express');
const { createLimiter } = require('../ratelimit');

const router = express.Router();

const TARGETS = {
  opencode: 'https://opencode.ai/zen/go',
};

const PROXY_TIMEOUT_MS = 5 * 60 * 1000;
// 每 IP 每分钟 60 次：正常用户一轮生成 1 次请求，留足重试余量
const proxyLimiter = createLimiter({ windowMs: 60 * 1000, max: 60 });

// 透传 POST（含流式 SSE）：请求体原样转发，响应体流回客户端，附加 CORS 头
router.post('/:name/*', async (req, res) => {
  const name = String(req.params.name || '');
  const target = TARGETS[name];
  if (!target) return res.status(404).json({ error: '未知代理目标' });
  const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
  if (!proxyLimiter.allow(ip)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  // 记录请求失败信息时隐藏 key
  const hideKey = (s) => String(s || '').replace(/Bearer\s+\S+/gi, 'Bearer ***');
  try {
    const url = target + '/' + req.params[0];
    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': req.headers['content-type'] || 'application/json',
        'Authorization': req.headers['authorization'] || '',
        'Accept': req.headers['accept'] || 'text/event-stream',
      },
      body: JSON.stringify(req.body || {}),
      signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
    });
    // CORS 头（WebView/浏览器可用）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    if (!upstream.ok) {
      const body = await upstream.text();
      return res.status(upstream.status).json({ error: hideKey(body) });
    }
    // 流式透传（SSE）
    if (upstream.body) {
      const reader = upstream.body.getReader();
      res.flushHeaders && res.flushHeaders();
      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) { try { res.end(); } catch (e) {} return; }
          try { res.write(value); } catch (e) { reader.cancel().catch(() => {}); return; }
          pump();
        }).catch((e) => { try { res.end(); } catch (e2) {} });
      };
      pump();
    } else {
      res.end();
    }
  } catch (e) {
    const aborted = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    if (aborted) return res.status(504).json({ error: '代理上游超时' });
    res.status(502).json({ error: '代理上游失败: ' + hideKey(e && e.message) });
  }
});

// 预检（浏览器跨域必发）
router.options('/:name/*', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res.status(204).end();
});

router._limiters = { proxyLimiter };

module.exports = router;
