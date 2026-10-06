// 生图测试台后端：静态文件 + LLM 转发（顺带解决跨域、密钥不落进页面），零依赖。
// 用法：node serve.mjs        → 自动打开 http://127.0.0.1:8123
//       node serve.mjs --no-open
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { loadWorkflow, mapWorkflow, patchWorkflow, readMeta, applyInitImage, applyHires } from './comfy-workflow.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'web');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const PORT = cfg.port || 8123;

// ---- 画图主机（ComfyUI）：只在这一层做「参数映射」，不碰工作流里的其他节点 ----
const COMFY = (cfg.comfy && cfg.comfy.base) || 'http://127.0.0.1:8188';
const WF_PATH = path.join(ROOT, (cfg.comfy && cfg.comfy.workflow) || 'comfy/workflow.base.json');
const NODES = (cfg.comfy && cfg.comfy.nodes) || {};   // 可选：显式节点映射；留空 = 自动识别
const JOBS = new Map();   // jobId -> { at, status, promptId, seed, size, image, elapsed, error }
const JOB_TTL_MS = 10 * 60 * 1000;

// ---- 局域网模式（--lan）：绑 0.0.0.0，并给所有 /api/* 加配对 token ----
// 本机（127.0.0.1）访问不受 token 限制：测试台自己的页面要能直接用。
const LAN = process.argv.includes('--lan');
const HOST_CFG = path.join(ROOT, 'host.json');
let TOKEN = '';
try { TOKEN = String((JSON.parse(fs.readFileSync(HOST_CFG, 'utf8')) || {}).token || ''); } catch (e) { /* 首次运行 */ }
if (!TOKEN) {
  TOKEN = randomBytes(18).toString('hex');
  try { fs.writeFileSync(HOST_CFG, JSON.stringify({ token: TOKEN }, null, 2)); } catch (e) { console.log('写 host.json 失败（token 仅本次有效）：' + e.message); }
}
const isLoopback = (req) => {
  const ip = String((req.socket && req.socket.remoteAddress) || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
};
const authed = (req, u) => {
  if (!LAN || isLoopback(req)) return true;
  const fromHeader = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const fromQuery = u.searchParams.get('token') || '';
  return !!TOKEN && (fromHeader === TOKEN || fromQuery === TOKEN);
};
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'authorization,content-type',
  'Access-Control-Max-Age': '86400'
};
function lanUrls() {
  const out = [];
  try {
    const ifs = networkInterfaces();
    for (const name of Object.keys(ifs)) {
      for (const a of (ifs[name] || [])) {
        if (a && a.family === 'IPv4' && !a.internal) out.push({ name, ip: a.address });
      }
    }
  } catch (e) { /* ignore */ }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((ok, no) => { let s = ''; req.on('data', (c) => { s += c; }); req.on('end', () => ok(s)); req.on('error', no); });
}
const trimSlash = (s) => String(s || '').replace(/\/+$/, '');

function staticFile(p, res) {
  if (p === '/') p = '/index.html';
  const file = path.join(WEB, path.normalize(decodeURIComponent(p)).replace(/^[/\\]+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 ' + p); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

async function llmModels(u, res) {
  const base = trimSlash(u.searchParams.get('base') || cfg.llm.base);
  const key = String(u.searchParams.get('key') || cfg.llm.key || '');
  const up = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key } });
  res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  if (up.body) Readable.fromWeb(up.body).pipe(res); else res.end();
}

async function llmProxy(req, res) {
  const raw = await readBody(req);
  let body; try { body = JSON.parse(raw || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
  const base = trimSlash(body.base || cfg.llm.base);
  const key = String(body.key || cfg.llm.key || '');
  const payload = Object.assign({}, body, { model: String(body.model || cfg.llm.model) });
  delete payload.base; delete payload.key;
  const t0 = Date.now();
  const up = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key,
      Accept: payload.stream ? 'text/event-stream' : 'application/json'
    },
    body: JSON.stringify(payload)
  });
  console.log('[llm] ' + payload.model + ' → ' + up.status + ' (' + (Date.now() - t0) + 'ms, stream=' + !!payload.stream + ')');
  res.writeHead(up.status, {
    'Content-Type': up.headers.get('content-type') || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  if (up.body) Readable.fromWeb(up.body).pipe(res); else res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://local');
    const p = u.pathname;
    if (p.startsWith('/api/')) {
      for (const k of Object.keys(CORS)) res.setHeader(k, CORS[k]);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      if (!authed(req, u)) return json(res, 401, { error: '未授权：需要配对 token（Authorization: Bearer <token>）' });
    }
    // 只绑 127.0.0.1（或 --lan 下的本机访问），所以这里把密钥一并给页面（方便「直连」模式一键可用）
    if (p === '/api/config') return json(res, 200, { base: cfg.llm.base, model: cfg.llm.model, key: cfg.llm.key, port: PORT });
    if (p === '/api/comfy/status') return await comfyStatus(res);
    if (p === '/api/comfy/draw') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      return await comfyDraw(req, res);
    }
    if (p.startsWith('/api/comfy/jobs/')) return await comfyJob(u, res);
    if (p === '/api/llm/models') return await llmModels(u, res);
    if (p === '/api/llm/chat/completions') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
      return await llmProxy(req, res);
    }
    return staticFile(p, res);
  } catch (e) {
    try { json(res, 500, { error: String((e && e.message) || e) }); } catch (_) { /* ignore */ }
  }
});

/* ---------------- 画图主机（ComfyUI）---------------- */
// 三个端点：status（在不在线）/ draw（提交，返回 jobId）/ jobs/{id}[+/image]（查进度、取图）。
// 工作流从 comfy/workflow.base.json 读；节点映射在 config.json 的 comfy.nodes，换工作流只换 json。
async function comfyFetch(p, opt, timeoutMs = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try { return await fetch(COMFY + p, Object.assign({ signal: ac.signal }, opt || {})); }
  finally { clearTimeout(t); }
}

async function comfyStatus(res) {
  try {
    const s = await (await comfyFetch('/system_stats')).json();
    const d = (s.devices && s.devices[0]) || {};
    let wf = null;
    try {
      const w = loadWorkflow(WF_PATH);
      const m = mapWorkflow(w, NODES);
      const meta = readMeta(WF_PATH);
      // tiers：工作流声明的每档尺寸/步数（App 优先用它，没声明才回退内置兜底）——换模型/LoRA 只改工作流
      wf = { file: path.basename(WF_PATH), model: m.model || '', steps: m.steps, cfg: m.cfg, size: m.size, sampler: m.samplerId, hint: meta.hint, tiers: meta.tiers };
    } catch (e) { wf = { file: path.basename(WF_PATH), error: e.message }; }
    json(res, 200, {
      ok: true, version: s.system && s.system.comfyui_version,
      device: d.name, vram: Math.round((d.vram_total || 0) / 1073741824), workflow: wf,
      // 主机能力（App 侧据此决定给不给"以图改图"参数、要不要走两步重修）：2026-10-06 起
      caps: ['img2img', 'hires']
    });
  } catch (e) {
    json(res, 200, { ok: false, error: '连不上 ComfyUI（' + COMFY + '）：' + (e && e.name === 'AbortError' ? '超时' : (e && e.message)) });
  }
}

function clampInt(v, dflt, min, max, step) {
  let n = Math.round(Number(v));
  if (!Number.isFinite(n)) n = dflt;
  n = Math.max(min, Math.min(max, n));
  if (step > 1) n = Math.round(n / step) * step;
  return n;
}

function cleanupJobs() {
  const now = Date.now();
  for (const [id, j] of JOBS) if (now - j.at > JOB_TTL_MS) JOBS.delete(id);
}

// 把底图（dataURL 或裸 base64）交给 ComfyUI 的 input 目录，返回它认的文件名（含 subfolder）。
// 走 ComfyUI 官方的 /upload/image（multipart），比手搓更省事：Node 18+ 自带 FormData/Blob。
async function uploadImageToComfy(dataUrlOrBase64, nameHint) {
  const s = String(dataUrlOrBase64 || '');
  const m = /^data:([^;]+);base64,([\s\S]*)$/.exec(s);
  const mime = (m && m[1]) || 'image/png';
  const b64 = (m ? m[2] : s).replace(/\s/g, '');
  if (!b64) throw new Error('底图为空');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw new Error('底图 base64 解不出字节');
  const ext = mime.indexOf('jpeg') >= 0 || mime.indexOf('jpg') >= 0 ? '.jpg' : '.png';
  const fd = new FormData();
  fd.append('image', new Blob([buf], { type: mime }), String(nameHint || ('base_' + Date.now() + ext)));
  fd.append('type', 'input');
  fd.append('overwrite', 'true');
  const r = await comfyFetch('/upload/image', { method: 'POST', body: fd }, 20000);
  if (!r.ok) throw new Error('上传底图失败 HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const j = await r.json();
  if (!j || !j.name) throw new Error('ComfyUI 没返回底图文件名');
  return (j.subfolder ? (j.subfolder + '/') : '') + j.name;
}

async function comfyDraw(req, res) {
  let body; try { body = JSON.parse((await readBody(req)) || '{}'); } catch (e) { return json(res, 400, { error: 'bad json' }); }
  const prompt = String(body.prompt || '').trim();
  if (!prompt) return json(res, 400, { error: 'prompt 不能为空' });

  let wf, map;
  try { wf = loadWorkflow(WF_PATH); }
  catch (e) { return json(res, 500, { error: '读不到工作流 ' + WF_PATH + '：' + e.message }); }
  try { map = mapWorkflow(wf, NODES); }
  catch (e) { return json(res, 500, { error: '工作流识别失败：' + e.message }); }
  if (!map.posId) return json(res, 500, { error: '识别不出正向提示词节点（KSampler 的 positive 没连到带 text 的节点）' });

  const seedGiven = Number(body.seed);
  const seed = Number.isFinite(seedGiven) && body.seed !== null && body.seed !== '' ?
    Math.floor(seedGiven) : Math.floor(Math.random() * 1e9);
  const defW = map.size ? Number(map.size.split('x')[0]) : 1024;
  const defH = map.size ? Number(map.size.split('x')[1]) : 1024;
  const targetW = clampInt(body.width, defW, 512, 1536, 16);   // 没给尺寸就沿用工作流自己的
  const targetH = clampInt(body.height, defH, 512, 1536, 16);
  const steps = clampInt(body.steps, map.steps || 8, 4, 60, 1);
  const hires = !!body.hires;                                  // 两步放大重修（1K 档用）
  const initImage = body.initImage ? String(body.initImage) : '';
  const denoise = body.denoise != null ? Math.max(0.05, Math.min(1, Number(body.denoise))) : 0.55;
  // hires：第一遍按 3/4 尺寸出底稿（1024 → 768，实测比直出 1024 更实），第二遍放大重修
  const baseW = hires ? clampInt(Math.round(targetW * 0.75), 512, 1536, 16) : targetW;
  const baseH = hires ? clampInt(Math.round(targetH * 0.75), 512, 1536, 16) : targetH;

  patchWorkflow(wf, map, {
    prompt: prompt,
    negative: body.negative_prompt !== undefined ? String(body.negative_prompt || '') : null,
    width: baseW,
    height: baseH,
    steps: steps,
    seed: seed
  });
  let initName = '';
  try {
    if (initImage) {
      initName = await uploadImageToComfy(initImage, 'bqb_base_' + Date.now() + '.png');
      applyInitImage(wf, map, { imageName: initName, denoise: denoise, width: baseW, height: baseH });
    }
    if (hires) {
      applyHires(wf, map, { width: targetW, height: targetH, denoise: 0.45, steps2: Math.max(6, Math.round(steps * 0.6)) });
    }
  } catch (e) {
    return json(res, 502, { error: '准备底图/重修节点失败：' + (e && e.message) });
  }
  // 精度覆盖（机器相关，放 config 里；4060 这类 Ada 卡上 fp8 更快）
  const WD = cfg.comfy && cfg.comfy.weight_dtype;
  if (WD) for (const n of Object.values(wf)) if (n && n.inputs && 'weight_dtype' in n.inputs) n.inputs.weight_dtype = WD;

  let up;
  try {
    up = await comfyFetch('/prompt', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: wf, client_id: 'imgtest-web' })
    }, 8000);
  } catch (e) {
    return json(res, 502, { error: '提交给 ComfyUI 失败（它在运行吗？）：' + (e && e.name === 'AbortError' ? '超时' : (e && e.message)) });
  }
  if (!up.ok) return json(res, 502, { error: 'ComfyUI 拒绝：HTTP ' + up.status + ' ' + (await up.text()).slice(0, 300) });
  const { prompt_id } = await up.json();

  const size = targetW + 'x' + targetH;
  const jobId = randomUUID();
  JOBS.set(jobId, { at: Date.now(), status: 'running', promptId: prompt_id, seed: seed, size: size });
  cleanupJobs();
  console.log('[comfy] 提交 ' + prompt_id + ' ' + size + (hires ? '(hires)' : '') + (initName ? ' 底图=' + initName : '') +
    ' seed=' + seed + ' 模型=' + (map.model || '?') + ' 「' + prompt.slice(0, 50) + '」');
  json(res, 200, { jobId });
}

async function comfyJob(u, res) {
  const parts = u.pathname.split('/');            // ['', 'api', 'comfy', 'jobs', id, 可能 'image']
  const job = JOBS.get(parts[4]);
  if (!job) return json(res, 404, { error: 'job 不存在或已过期' });

  if (job.status === 'running') {
    const elapsed = Date.now() - job.at;
    if (elapsed > 300000) { job.status = 'failed'; job.error = '超时（300s）'; }
    else {
      try {
        const h = await (await comfyFetch('/history/' + job.promptId)).json();
        const rec = h[job.promptId];
        if (rec) {
          const imgs = [];
          for (const o of Object.values(rec.outputs || {})) for (const im of (o.images || [])) imgs.push(im);
          if (imgs.length) {
            const im = imgs[0];
            const url = '/view?filename=' + encodeURIComponent(im.filename) +
              '&subfolder=' + encodeURIComponent(im.subfolder || '') + '&type=' + (im.type || 'output');
            const buf = Buffer.from(await (await comfyFetch(url, {}, 20000)).arrayBuffer());
            job.image = buf; job.status = 'done'; job.elapsed = elapsed;
            console.log('[comfy] 完成 ' + (elapsed / 1000).toFixed(1) + 's ' + (buf.length / 1024 | 0) + 'KB');
          } else if (rec.status && rec.status.completed) {
            job.status = 'failed'; job.error = '任务结束但没有输出图';
          }
        }
      } catch (e) { /* 查不到就下一轮再查 */ }
    }
  }

  if (/\/image$/.test(u.pathname)) {
    if (job.status !== 'done') { res.writeHead(409, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('not ready'); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return res.end(job.image);
  }
  json(res, 200, { status: job.status, elapsed: job.elapsed || (Date.now() - job.at), seed: job.seed, size: job.size, error: job.error });
}

server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') {
    console.log('端口 ' + PORT + ' 已被占用——多半已经在运行了，直接打开 http://127.0.0.1:' + PORT + '/');
    process.exit(0);
  }
  throw e;
});

server.listen(PORT, LAN ? '0.0.0.0' : '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + PORT + '/';
  if (LAN) {
    console.log('生图测试台（局域网模式）已启动');
    console.log('  本机页面：' + url);
    for (const n of lanUrls()) console.log('  手机/其他设备：http://' + n.ip + ':' + PORT + '/   （网卡：' + n.name + '）');
    console.log('  配对 token：' + TOKEN);
    console.log('  填进 App 设置：地址 = http://<上面那个 IP>:' + PORT + ' ，token = 上面那串');
    console.log('  提示：Windows 防火墙首次会弹窗，必须允许「专用网络」，否则别的设备连不上。');
    if (process.argv.includes('--no-open') === false) { /* 局域网模式下不自动开浏览器 */ }
  } else {
    console.log('生图测试台已启动：' + url + '   （Ctrl+C 退出；想让别的设备也能连，用 node serve.mjs --lan）');
    if (!process.argv.includes('--no-open') && process.platform === 'win32') exec('start "" "' + url + '"');
  }
});
