// 工作流适配层：读「API 格式」工作流 + 自动找出可替换的节点 + 套参数。
//
// 设计目标（换工作流只换 JSON 文件，不用记节点 id）：
//   1. 找 KSampler / KSamplerAdvanced；
//   2. 顺它的 positive / negative / latent_image 输入找到「提示词节点」「空 Latent 节点」；
//   3. 提示词节点被 ConditioningCombine 之类的中间节点包着也能穿透找到带 text 的那个；
//   4. 采样器的 seed / steps / cfg、latent 的 width / height 有才改，没有就跳过；
//   5. config.json 里的 comfy.nodes 可显式指定，优先级高于自动识别（一般留空即可）。
import fs from 'node:fs';

export function loadWorkflow(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');   // 有些导出带 BOM
  const wf = JSON.parse(text);
  for (const k of Object.keys(wf)) if (k.startsWith('_')) delete wf[k];  // 注释键不是节点
  return wf;
}

// 读取工作流里的"_"注释/声明字段（都不进 ComfyUI 图，只给主机和 App 看）：
//   _hint  = 给模型的画风说明（随工作流走，不进 app 预设）
//   _steps = 偷懒写法：所有档位统一用这个步数
//   _tiers = 每档声明：数字=步数；或 { size, steps }（steps:null = 用工作流自己的步数）
//            例：{ "fast": 8, "draft": { "size": 512, "steps": 10 }, "high": { "size": 1024, "steps": 10 } }
// 原则「谁配模型/LoRA 谁定步数」：主机 status 把声明透给 App，App 声明优先、没声明才回退内置兜底。
const TIER_KEYS = ['fast', 'draft', 'normal', 'high'];
function _posInt(v) { return (typeof v === 'number' && isFinite(v) && v > 0) ? Math.round(v) : 0; }
function parseTiers(j) {
  const out = {};
  const scalar = _posInt(j && j._steps);
  if (scalar) for (const k of TIER_KEYS) out[k] = { steps: scalar };
  const src = (j && j._tiers && typeof j._tiers === 'object') ? j._tiers : {};
  for (const k of TIER_KEYS) {
    const v = src[k];
    if (v == null) continue;
    const t = {};
    if (typeof v === 'object') {
      const sz = _posInt(v.size); if (sz) t.size = sz;
      if (v.steps === null) t.steps = null;
      else { const st = _posInt(v.steps); if (st) t.steps = st; }
    } else {
      const st = _posInt(v); if (st) t.steps = st;
    }
    if (Object.keys(t).length) out[k] = Object.assign({}, out[k] || {}, t);
  }
  return out;
}
export function readMeta(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { hint: typeof j._hint === 'string' ? j._hint : '', tiers: parseTiers(j) };
  } catch (e) { return { hint: '', tiers: {} }; }
}

function findTextNode(wf, id, seen) {
  const n = wf[id];
  if (!n || !n.inputs) return null;
  if (typeof n.inputs.text === 'string') return { id: id, node: n };
  for (const v of Object.values(n.inputs)) {
    if (Array.isArray(v) && typeof v[0] === 'string' && wf[v[0]] && !seen.has(v[0])) {
      seen.add(v[0]);
      const r = findTextNode(wf, v[0], seen);
      if (r) return r;
    }
  }
  return null;
}

// 顺着 model 输入往上找加载器，取出模型文件名（给界面显示用）
function findModel(wf, id, seen) {
  const n = wf[id];
  if (!n || !n.inputs || seen.has(id)) return '';
  seen.add(id);
  const ins = n.inputs;
  for (const k of ['unet_name', 'model_name', 'ckpt_name', 'gguf_name']) {
    if (typeof ins[k] === 'string') return ins[k];
  }
  for (const v of Object.values(ins)) {
    if (Array.isArray(v) && typeof v[0] === 'string' && wf[v[0]]) {
      const r = findModel(wf, v[0], seen);
      if (r) return r;
    }
  }
  return '';
}

export function mapWorkflow(wf, override) {
  const o = override || {};
  let samplerId = o.sampler;
  if (!samplerId) samplerId = Object.keys(wf).find((k) => /^KSampler(Advanced)?$/.test((wf[k] && wf[k].class_type) || ''));
  if (!samplerId || !wf[samplerId]) throw new Error('工作流里找不到 KSampler / KSamplerAdvanced 节点');
  const sampler = wf[samplerId];
  const inputs = sampler.inputs || {};

  const refId = (name, given) => {
    if (given && wf[given]) return given;
    const v = inputs[name];
    return Array.isArray(v) ? v[0] : '';
  };
  const posId = refId('positive', o.positive);
  const negId = refId('negative', o.negative);
  const latentRaw = refId('latent_image', o.latent);
  const latent = latentRaw && wf[latentRaw];
  const patchableLatent = latent && latent.inputs && typeof latent.inputs.width === 'number' ? latentRaw : '';
  const pos = posId ? findTextNode(wf, posId, new Set([posId])) : null;
  const neg = negId ? findTextNode(wf, negId, new Set([negId])) : null;

  return {
    samplerId: samplerId,
    sampler: sampler,
    posId: pos ? pos.id : '',
    negId: neg ? neg.id : '',
    latentId: patchableLatent,
    model: findModel(wf, samplerId, new Set()),
    steps: typeof inputs.steps === 'number' ? inputs.steps : null,
    cfg: typeof inputs.cfg === 'number' ? inputs.cfg : null,
    size: patchableLatent ? (latent.inputs.width + 'x' + latent.inputs.height) : ''
  };
}

export function patchWorkflow(wf, map, opts) {
  if (map.posId && opts.prompt != null) wf[map.posId].inputs.text = String(opts.prompt);
  if (map.negId && opts.negative != null) wf[map.negId].inputs.text = String(opts.negative);
  if (map.latentId) {
    if (opts.width != null) wf[map.latentId].inputs.width = opts.width;
    if (opts.height != null) wf[map.latentId].inputs.height = opts.height;
  }
  const ins = map.sampler && map.sampler.inputs;
  if (ins) {
    if (opts.steps != null && typeof ins.steps === 'number') ins.steps = opts.steps;
    if (opts.seed != null && typeof ins.seed === 'number') ins.seed = opts.seed;
    if (opts.cfg != null && typeof ins.cfg === 'number') ins.cfg = opts.cfg;
  }
  return wf;
}

// ── 以图改图 / 两步放大重修（2026-10-06）─────────────────────────────────
// 两者都是"往工作流里插节点 + 改连线"，不改工作流 JSON 本身（换工作流只换文件）。
// 节点 id 用不可能撞车的数字，撞了就往后顺延（工作流自己的 id 一般是 "1"、"2"…）。

function freeId(wf, base) {
  let k = String(base);
  let i = 0;
  while (wf[k]) { i++; k = String(Number(base) + i) + '_' + i; }
  return k;
}

// 找 VAE：优先 VAEDecode 用的那个（一定存在且是最终解码用的）
function findVaeId(wf) {
  for (const k of Object.keys(wf)) {
    const n = wf[k];
    if (!n || n.class_type !== 'VAEDecode' || !n.inputs) continue;
    const v = n.inputs.vae;
    if (Array.isArray(v) && wf[v[0]]) return String(v[0]);
  }
  return Object.keys(wf).find((k) => wf[k] && wf[k].class_type === 'VAELoader') || '';
}

/**
 * 以图改图：LoadImage →（尺寸不符就先 ImageScale 到目标尺寸）→ VAEEncode → 采样器的 latent_image。
 * denoise 决定改动幅度（0.3 只小改 / 0.55 中等 / 0.75 大改）。
 * 注意：latent 换成 VAEEncode 之后，空 Latent 的 width/height 就不起作用了——尺寸由这里的 ImageScale 决定。
 */
export function applyInitImage(wf, map, opts) {
  const vaeId = findVaeId(wf);
  if (!vaeId) throw new Error('工作流里找不到 VAE（没法把底图编码成 latent）');
  const loadId = freeId(wf, 900);
  const scaleId = freeId(wf, 910);
  const encId = freeId(wf, 920);
  wf[loadId] = { class_type: 'LoadImage', inputs: { image: String(opts.imageName), upload: 'image' } };
  const w = Number(opts.width) || 0, h = Number(opts.height) || 0;
  let pixels = [loadId, 0];
  if (w > 0 && h > 0) {
    wf[scaleId] = { class_type: 'ImageScale', inputs: { image: [loadId, 0], upscale_method: 'lanczos', width: w, height: h, crop: 'center' } };
    pixels = [scaleId, 0];
  }
  wf[encId] = { class_type: 'VAEEncode', inputs: { pixels: pixels, vae: [vaeId, 0] } };
  wf[map.samplerId].inputs.latent_image = [encId, 0];
  const ins = wf[map.samplerId].inputs;
  if (opts.denoise != null && 'denoise' in ins) ins.denoise = Math.max(0.05, Math.min(1, Number(opts.denoise)));
  return { loadId, scaleId, encId, vaeId };
}

/**
 * 两步放大重修（hires fix）：第一遍按当前尺寸出底稿 → LatentUpscale 放大到目标尺寸 → 第二遍低强度重画。
 * 单次直出 1024 在这套模型上发虚（2026-10-05 实测），两步才真的多出细节；耗时与单次直出接近。
 * steps2 是第二遍的步数（一般取总步数的 0.6 左右）。
 */
export function applyHires(wf, map, opts) {
  const vaeId = findVaeId(wf);
  if (!vaeId) throw new Error('工作流里找不到 VAE（两步重修没法接）');
  const upId = freeId(wf, 930);
  const s2 = freeId(wf, 940);
  const src = map.samplerId;
  wf[upId] = {
    class_type: 'LatentUpscale',
    inputs: { upscale_method: 'nearest-exact', width: Number(opts.width) || 1024, height: Number(opts.height) || 1024, crop: 'disabled', samples: [src, 0] }
  };
  const ins = Object.assign({}, wf[src].inputs);
  ins.latent_image = [upId, 0];
  if ('denoise' in ins) ins.denoise = Math.max(0.05, Math.min(1, Number(opts.denoise != null ? opts.denoise : 0.45)));
  if (opts.steps2 != null && typeof ins.steps === 'number') ins.steps = Math.max(4, Math.round(Number(opts.steps2)));
  wf[s2] = { class_type: wf[src].class_type, inputs: ins };
  // 让最终的 VAEDecode 改吃第二遍的结果（SaveImage 挂在 VAEDecode 后面，不用动）
  let rewired = 0;
  for (const k of Object.keys(wf)) {
    const n = wf[k];
    if (n && n.class_type === 'VAEDecode' && n.inputs && Array.isArray(n.inputs.samples) && String(n.inputs.samples[0]) === String(src)) {
      n.inputs.samples = [s2, 0];
      rewired++;
    }
  }
  if (!rewired) throw new Error('没找到吃采样器输出的 VAEDecode（两步重修接不上）');
  return { upId, sampler2: s2, rewired };
}
