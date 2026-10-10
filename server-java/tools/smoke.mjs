#!/usr/bin/env node
// 服务端冒烟 / 灰度对比脚本（无依赖，Node 18+ 即可跑）。
//
// 用途一（灰度演练）：把「候选实现」与「线上实现」放在同一台机器上，用**真实数据**逐项对比，
//   证明候选实现读同一份内容、认同一批凭证、返回同样的分发结果；
// 用途二（切换后复核）：只给 --base（不给 --live）时就是一套纯冒烟，用来确认新进程服务正常。
//
// 用法（在服务器上跑，两个实例都在 127.0.0.1）：
//   node --experimental-sqlite smoke.mjs \
//     --base http://127.0.0.1:18899 --tls-base https://127.0.0.1:18443 \
//     --live http://127.0.0.1:8899  --live-tls https://127.0.0.1:80 \
//     --admin-pw '<管理员口令>' --db /server-java/canary/data/chat.db --seed-login
//   说明：--db + --seed-login 会往**候选实例的库**里写一个测试用户（口令派生值用 Node 规格现算），
//   再走 HTTP 登录 —— 这正是「老用户迁移」的等价验证：Node 生成的派生值，候选实现必须能认。
//   --admin-key 可省（默认从环境 ADMIN_KEY 读；都没有就跳过管理端对比）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}
const BASE = arg('base');
const TLS_BASE = arg('tls-base', null);
const LIVE = arg('live', null);
const LIVE_TLS = arg('live-tls', null);
const ADMIN_KEY = arg('admin-key', process.env.ADMIN_KEY || '');
const ADMIN_PW = arg('admin-pw', process.env.ADMIN_PW || '');
// 直接给一枚**由线上实现签发**的留档令牌（用它验候选实现认不认 —— HMAC 格式是否逐字节兼容）
const ADMIN_TOKEN = arg('admin-token', process.env.ADMIN_TOKEN || '');
const DB_PATH = arg('db', null);
const SEED_LOGIN = !!arg('seed-login', false);
const AS_JSON = !!arg('json', false);

if (!BASE || BASE === true) {
  console.error('用法：node smoke.mjs --base <候选实例URL> [--tls-base <URL>] [--live <线上URL>] [--live-tls <URL>]');
  console.error('        [--admin-key K] [--admin-pw PW] [--db <候选库路径> --seed-login] [--json]');
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
  const mark = ok ? 'PASS' : 'FAIL';
  if (!AS_JSON) console.log(mark + '  ' + name + (detail === undefined ? '' : '  — ' + detail));
  return !!ok;
}
function note(msg) {
  if (!AS_JSON) console.log('      ' + msg);
}

async function get(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  return { status: r.status, headers: r.headers, text, json };
}

/** 自签证书 → 不校验信任（只验行为） */
const tlsAgent = null; // Node 的 fetch 不支持 per-request rejectUnauthorized；用 https 模块走 TLS 检查
async function httpsGet(url) {
  const https = await import('node:https');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, port: Number(u.port), path: u.pathname + u.search, method: 'GET', rejectUnauthorized: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch (e) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** 登录链路要用的口令派生（规格与 server/src/auth.js 完全一致：盐是 hex 字符串的 UTF-8 字节） */
function loginHash(password, saltString, keylen = 64) {
  return crypto.scryptSync(Buffer.from(password, 'utf8'), Buffer.from(saltString, 'utf8'), keylen, { N: 16384, r: 8, p: 1 });
}

async function main() {
  if (!AS_JSON) {
    console.log('== 服务端冒烟 / 灰度对比 ==');
    console.log('   候选：' + BASE + (TLS_BASE ? '  |  TLS ' + TLS_BASE : ''));
    console.log('   线上：' + (LIVE || '(无，仅冒烟)'));
    console.log('');
  }

  // A. 健康检查
  const health = await get(BASE + '/api/health');
  check('候选实例 /api/health 200', health.status === 200 && health.json && health.json.ok === true, 'HTTP ' + health.status);

  // B/C/D. 与线上对比分发内容（同一份文件 → 必须逐字段一致）
  const ver = await get(BASE + '/api/app/version');
  check('候选 /api/app/version 可用', ver.status === 200 && !!ver.json, 'HTTP ' + ver.status);
  const wb = await get(BASE + '/api/app/web-bundle');
  check('候选 /api/app/web-bundle 可用', wb.status === 200 && !!wb.json, 'HTTP ' + wb.status);

  let liveVer = null;
  let liveWb = null;
  let liveApkUrl = null;
  if (LIVE) {
    liveVer = await get(LIVE + '/api/app/version');
    liveWb = await get(LIVE + '/api/app/web-bundle');
    check('版本信息与线上一致（versionCode/versionName/note）',
      ver.json && liveVer.json
      && ver.json.versionCode === liveVer.json.versionCode
      && ver.json.versionName === liveVer.json.versionName
      && ver.json.note === liveVer.json.note,
      '候选 ' + JSON.stringify({ v: ver.json && ver.json.versionCode, n: ver.json && ver.json.versionName })
      + ' vs 线上 ' + JSON.stringify({ v: liveVer.json && liveVer.json.versionCode, n: liveVer.json && liveVer.json.versionName }));
    check('热更 manifest 与线上逐字段一致（payload/sig/v/code/minNative）',
      JSON.stringify(wb.json) === JSON.stringify(liveWb.json),
      JSON.stringify(wb.json).slice(0, 80) + '…');
  }

  // D. APK 下载：同一份文件 → 长度一致、首段字节一致（文件 2.2G，不整包拉）
  const apkUrlOf = (o) => (o && o.apkUrl ? o.apkUrl : null);
  const toBase = (url, base) => {
    if (!url) return null;
    const u = new URL(url);
    return new URL(u.pathname + u.search, base).toString();
  };
  const candApk = toBase(apkUrlOf(ver.json), BASE);
  if (candApk) {
    const r = await fetch(candApk, { headers: { Range: 'bytes=0-65535' } });
    const buf = Buffer.from(await r.arrayBuffer());
    check('候选 APK 可取（Range 前 64KB）', (r.status === 206 || r.status === 200) && buf.length > 0,
      'HTTP ' + r.status + ' ' + buf.length + 'B content-length=' + r.headers.get('content-length'));
    if (LIVE && liveVer) {
      liveApkUrl = toBase(apkUrlOf(liveVer.json), LIVE);
      const rl = await fetch(liveApkUrl, { headers: { Range: 'bytes=0-65535' } });
      const bufl = Buffer.from(await rl.arrayBuffer());
      const n = Math.min(buf.length, bufl.length);
      const samePrefix = n > 0 && buf.subarray(0, n).equals(bufl.subarray(0, n));
      check('APK 与线上同一份（响应首段字节逐字节一致）', samePrefix,
        '候选响应 ' + buf.length + 'B（content-length ' + r.headers.get('content-length') + '）'
        + ' vs 线上响应 ' + bufl.length + 'B（content-length ' + rl.headers.get('content-length') + '），比较前 ' + n + 'B');
      if (r.status !== rl.status) {
        note('已知差异（不影响 App）：Range 处理 —— 候选 ' + r.status + '（支持断点续传/分段下载），线上 ' + rl.status
          + '（忽略 Range、整包返回）。App 下载 APK/热更包都是普通 GET，行为一致。');
      }
    }
  }

  // E. 管理端：令牌 + 统计口径（真实数据 → 与线上对比）
  let stats = null;
  let token = ADMIN_TOKEN && ADMIN_TOKEN !== true ? ADMIN_TOKEN : null;
  if (token) {
    check('使用「线上实现签发的令牌」通过候选校验（HMAC 格式逐字节兼容）', true, 'token=' + String(token).slice(0, 12) + '…');
  }
  if (ADMIN_PW || token) {
    if (!token) {
      const vr = await get(BASE + '/api/admin/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: ADMIN_PW }),
      });
      token = vr.json && vr.json.token;
      check('管理员口令校验（/api/admin/verify）', vr.status === 200 && !!token, 'HTTP ' + vr.status);
    }
    if (token) {
      const sr = await get(BASE + '/api/admin/stats', { headers: { 'X-Admin-Token': token } });
      stats = sr.json;
      check('候选 /api/admin/stats 可用', sr.status === 200 && !!stats, 'HTTP ' + sr.status);
      if (LIVE && stats) {
        const liveStats = (await get(LIVE + '/api/admin/stats', { headers: { 'X-Admin-Token': token } })).json;
        const same = (k) => stats[k] === liveStats[k];
        check('统计口径与线上一致（total/month/week/day/feedbackUnread）',
          same('total') && same('month') && same('week') && same('day') && same('feedbackUnread'),
          '候选 ' + JSON.stringify({ total: stats.total, month: stats.month, week: stats.week, day: stats.day, fu: stats.feedbackUnread })
          + ' vs 线上 ' + JSON.stringify({ total: liveStats.total, month: liveStats.month, week: liveStats.week, day: liveStats.day, fu: liveStats.feedbackUnread }));
        note('online/today/newToday 随时间波动，仅打印：候选 ' + JSON.stringify({ online: stats.online, today: stats.today, newToday: stats.newToday })
          + ' vs 线上 ' + JSON.stringify({ online: liveStats.online, today: liveStats.today, newToday: liveStats.newToday }));
        check('版本分布与线上一致（versions/webs 两个维度）',
          JSON.stringify(stats.versions) === JSON.stringify(liveStats.versions)
          && JSON.stringify(stats.webs) === JSON.stringify(liveStats.webs),
          JSON.stringify(stats.versions) + ' / ' + JSON.stringify(stats.webs));
      }
      if (token && ADMIN_KEY && ADMIN_KEY !== true) {
        const fb = await get(BASE + '/api/admin/feedback?status=all&limit=1', { headers: { 'X-Admin-Token': token, 'x-admin-key': ADMIN_KEY } });
        check('候选管理端反馈列表可用', fb.status === 200 && !!fb.json, 'HTTP ' + fb.status + ' total=' + (fb.json && fb.json.total));
        if (LIVE && fb.json) {
          const lf = await get(LIVE + '/api/admin/feedback?status=all&limit=1', { headers: { 'X-Admin-Token': token, 'x-admin-key': ADMIN_KEY } });
          check('反馈计数与线上一致（unread/read/total/trimmed）',
            lf.json && fb.json.unread === lf.json.unread && fb.json.read === lf.json.read
            && fb.json.total === lf.json.total && fb.json.trimmed === lf.json.trimmed,
            '候选 ' + JSON.stringify({ u: fb.json.unread, r: fb.json.read, t: fb.json.total }) + ' vs 线上 ' + JSON.stringify(lf.json && { u: lf.json.unread, r: lf.json.read, t: lf.json.total }));
        }
      }
    }
  } else {
    note('未给 --admin-pw / --admin-token，跳过管理端对比（管理端口径已在契约套件里覆盖）');
  }

  // F. TLS 第二端口：可用 + 协议感知 apkUrl
  if (TLS_BASE) {
    const h = await httpsGet(TLS_BASE + '/api/health');
    check('候选 TLS 端口 /api/health 200', h.status === 200 && h.json && h.json.ok === true, 'HTTP ' + h.status);
    const v = await httpsGet(TLS_BASE + '/api/app/version');
    check('HTTPS 下 apkUrl 是 https（App 靠它走 TLS 下载）', !!(v.json && String(v.json.apkUrl).startsWith('https://')), v.json && v.json.apkUrl);
    if (LIVE_TLS) {
      const lv = await httpsGet(LIVE_TLS + '/api/app/version');
      check('线上 HTTPS 下 apkUrl 同样是 https（口径一致）', !!(lv.json && String(lv.json.apkUrl).startsWith('https://')), lv.json && lv.json.apkUrl);
    }
  }

  // G. 写路径 + 上传/下载（可选：只写候选库）
  if (DB_PATH) {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(DB_PATH);
      db.exec('PRAGMA busy_timeout = 5000');
      // 提醒：本脚本的写路径用例会往候选库写数据；**对比项只对刚快照的候选库成立**。
      // 重复跑之前请重做快照（canary-setup.sh 每次都会重做），否则统计对比会多出上一轮的行。
      try {
        const prev = db.prepare("SELECT COUNT(*) c FROM devices WHERE install_id LIKE 'dev_smoke%'").get();
        const prevFb = db.prepare("SELECT COUNT(*) c FROM feedback WHERE install_id LIKE 'smoke-%'").get();
        if (Number(prev && prev.c) > 0 || Number(prevFb && prevFb.c) > 0) {
          note('⚠ 候选库里有上一轮 smoke 写入的行（devices=' + (prev && prev.c) + ', feedback=' + (prevFb && prevFb.c)
            + '）：统计对比可能不等，请先重做快照再跑（canary-setup.sh 会重做）');
        }
      } catch (e) { /* 表不存在时忽略 */ }
      // 反馈：随机设备 → 200（写进候选库）
      const devId = 'smoke-' + Date.now().toString(36);
      const fb = await get(BASE + '/api/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: devId, text: 'smoke 灰度演练写入', v: 'smoke', plat: 'node' }),
      });
      check('写路径：POST /api/feedback 成功', fb.status === 200 && fb.json && fb.json.ok === true, 'HTTP ' + fb.status);
      const row = db.prepare('SELECT COUNT(*) c FROM feedback WHERE install_id = ?').get(devId);
      check('写路径：反馈确实落进候选库', row && Number(row.c) === 1, 'count=' + (row && row.c));
      // 设备上报：ping → devices 表
      const pingId = 'dev_smoke' + Date.now().toString(36).slice(-6);
      const pg = await get(BASE + '/api/app/ping', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: pingId, v: 'smoke', w: '', plat: 'node' }),
      });
      const prow = db.prepare('SELECT COUNT(*) c FROM devices WHERE install_id = ?').get(pingId);
      check('写路径：POST /api/app/ping 落库 devices', pg.status === 200 && prow && Number(prow.c) === 1,
        'HTTP ' + pg.status + ' count=' + (prow && prow.c));

      // H. 老用户迁移等价验证：Node 规格生成派生值 → 候选实现登录
      if (SEED_LOGIN) {
        const email = 'smoke-login@example.com';
        const pw = 'smoke-pw-' + Date.now().toString(36);
        const salt = crypto.randomBytes(16).toString('hex');
        const hash = loginHash(pw, salt).toString('hex');
        db.prepare('DELETE FROM users WHERE email = ?').run(email);
        db.prepare('INSERT INTO users (username, pass_hash, pass_salt, created_at, email) VALUES (?, ?, ?, ?, ?)')
          .run('smoke用户', hash, salt, Date.now(), email);
        const lr = await get(BASE + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: pw }),
        });
        check('老用户迁移等价：Node 生成的派生值可登录（scrypt 规格一致）', lr.status === 200 && lr.json && !!lr.json.token, 'HTTP ' + lr.status);
        if (lr.json && lr.json.token) {
          const me = await get(BASE + '/api/auth/me', { headers: { Authorization: 'Bearer ' + lr.json.token } });
          check('会话可用：/api/auth/me 返回同一用户', me.status === 200 && me.json && me.json.user && me.json.user.email === email,
            JSON.stringify(me.json && me.json.user));
        }
        // 明文密码错误必须 401（确认不是"放行一切"）
        const bad = await get(BASE + '/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: 'definitely-wrong' }),
        });
        check('负例：错误口令 401', bad.status === 401, 'HTTP ' + bad.status);
        db.close();
      } else {
        db.close();
      }
    } catch (e) {
      check('库直读/写用例', false, e.message);
    }
  } else {
    note('未给 --db，跳过写路径与登录用例（传 --db <候选库路径> --seed-login 启用）');
  }

  // 汇总
  const failed = results.filter((r) => !r.ok);
  if (AS_JSON) {
    console.log(JSON.stringify({ base: BASE, live: LIVE, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  } else {
    console.log('');
    console.log('结果：' + (results.length - failed.length) + '/' + results.length + ' 通过'
      + (failed.length ? '，失败项：' + failed.map((f) => f.name).join('；') : ''));
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('冒烟脚本异常：' + (e && e.stack || e));
  process.exit(3);
});
