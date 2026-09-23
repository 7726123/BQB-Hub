// 内存滑动窗限流（单实例部署足够；多实例部署需换成共享存储如 Redis）。
// 用途：登录/注册防爆破、验证码校验防猜码、WS 防刷屏、client-logs 桶回收。
// 记录按 key 分桶存时间戳数组，窗口外自动丢弃；sweep() 清理空桶防 Map 无限增长。

function createLimiter(opts) {
  const windowMs = Number(opts && opts.windowMs) || 60000;
  const max = Number(opts && opts.max) || 10;
  const map = new Map(); // key -> number[] 升序时间戳

  function allow(key) {
    const now = Date.now();
    const arr = map.get(key) || [];
    let i = 0;
    while (i < arr.length && now - arr[i] >= windowMs) i++;
    const fresh = i > 0 ? arr.slice(i) : arr;
    if (fresh.length >= max) { map.set(key, fresh); return false; }
    fresh.push(now);
    map.set(key, fresh);
    return true;
  }

  function reset(key) { map.delete(key); }

  function clear() { map.clear(); }

  function sweep() {
    const now = Date.now();
    for (const [k, arr] of map) {
      if (!arr.length || now - arr[arr.length - 1] >= windowMs) map.delete(k);
    }
    return map.size;
  }

  return { allow, reset, clear, sweep, size: () => map.size, windowMs, max };
}

// Express 中间件：超限 → 429（keyFn 缺省按来源 IP）
function middleware(limiter, keyFn) {
  return function (req, res, next) {
    const key = keyFn ? keyFn(req) : ((req.socket && req.socket.remoteAddress) || 'unknown');
    if (!limiter.allow(key)) return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    next();
  };
}

// 后台定期回收空桶（unref 不阻塞进程退出，测试环境也不会挂住）
function startSweeper(limiters, intervalMs) {
  const timer = setInterval(() => {
    for (const l of limiters) { try { l.sweep(); } catch (e) { /* ignore */ } }
  }, Number(intervalMs) || 10 * 60 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { createLimiter, middleware, startSweeper };
