// TLS 第二端口契约（对应 server/src/tls.js 与 server-java 的 TlsConfig）：
//   · 证书可用时 HTTP 与 HTTPS **双端口并存**，两个端口跑同一个应用；
//   · HTTPS 请求下 /api/app/version 的 apkUrl 必须是 https（App 走 TLS 端口下载 APK），HTTP 下仍是 http；
//   · 协商到 TLSv1.2 或 TLSv1.3（对应 Node 的 minVersion: 'TLSv1.2'）；
//   · 证书不可读时只跑 HTTP、**启动不失败**——这一条由其余所有文件隐式覆盖
//     （helpers 在正常运行里故意不给证书，目标仍必须起得来）。
//
// 只在契约模式跑（嵌入模式的进程内服务没有独立 TLS 监听）。证书**不入库**：契约模式启动时
// 由 helpers 用 openssl 现签一张自签证书放进临时目录（仓库里放 PEM 私钥会被 GitHub/Gitee 的
// 密钥扫描 + push protection 拦下，而推送是非交互脚本）；本机没有 openssl 时这几个用例运行时跳过。
// PKCS#1 私钥（BEGIN RSA PRIVATE KEY，老 openssl 的默认格式）另用 `openssl genrsa -traditional`
// 现生成一对，通过 TLS_KEY_FILE 覆盖验证过解析路径（见交接文档 §13.162 补记）。
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const tls = require('node:tls');
const { start, stop, req, contractOnly, tlsOrigin, tlsAvailable } = require('./helpers');

before(async () => { await start(); });
after(async () => { await stop(); });

/** 走 HTTPS 请求（自签证书 → 不校验信任，只验行为） */
function httpsGet(pathname) {
  return new Promise((resolve, reject) => {
    const u = new URL(tlsOrigin + pathname);
    const r = https.request({
      host: u.hostname, port: Number(u.port), path: u.pathname + u.search,
      method: 'GET', rejectUnauthorized: false,
    }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    r.on('error', reject);
    r.end();
  });
}

/** 没有证书（本机缺 openssl）就跳过，并在跳过信息里说明原因 */
function skipIfNoTls(t) {
  if (tlsAvailable()) return false;
  t.skip('本机没有 openssl，无法生成测试证书（TLS 用例跳过）');
  return true;
}

contractOnly('TLS 端口可用：GET /api/health 走 HTTPS 返回 200', async (t) => {
  if (skipIfNoTls(t)) return;
  const r = await httpsGet('/api/health');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  assert.equal(j.ok, true);
});

contractOnly('双端口并存：同一个应用在 HTTP 与 HTTPS 上同时可用', async (t) => {
  if (skipIfNoTls(t)) return;
  const h = await req('GET', '/api/health');
  assert.equal(h.status, 200);
  const s = await httpsGet('/api/health');
  assert.equal(s.status, 200);
});

contractOnly('协议感知 apkUrl：HTTPS 下 https、HTTP 下 http（App 靠这个走 TLS 端口下载）', async (t) => {
  if (skipIfNoTls(t)) return;
  const viaHttps = JSON.parse((await httpsGet('/api/app/version')).text);
  assert.ok(String(viaHttps.apkUrl).startsWith('https://'), 'HTTPS 请求的 apkUrl=' + viaHttps.apkUrl);
  const viaHttp = (await req('GET', '/api/app/version')).json;
  assert.ok(String(viaHttp.apkUrl).startsWith('http://'), 'HTTP 请求的 apkUrl=' + viaHttp.apkUrl);
});

contractOnly('协商协议：默认握手落到 TLSv1.2 或 TLSv1.3', async (t) => {
  if (skipIfNoTls(t)) return;
  const protocol = await new Promise((resolve, reject) => {
    const u = new URL(tlsOrigin);
    const socket = tls.connect({ host: u.hostname, port: Number(u.port), rejectUnauthorized: false }, () => {
      const p = socket.getProtocol();
      socket.end();
      resolve(p);
    });
    socket.on('error', reject);
    setTimeout(() => { try { socket.destroy(); } catch (e) { /* ignore */ } reject(new Error('TLS 握手超时')); }, 5000).unref();
  });
  assert.ok(protocol === 'TLSv1.2' || protocol === 'TLSv1.3', '协商到的协议=' + protocol);
});
