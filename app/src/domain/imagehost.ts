// 画图主机客户端：调用户局域网里的「画图主机」（本机 ComfyUI 的包装服务）。
// 协议（与 imgtest/serve.mjs 完全一致，将来换成正式 host agent 也不用改这里）：
//   GET  /api/comfy/status               → { ok, version, device, caps?, workflow:{ model, hint, steps, size } }
//   POST /api/comfy/draw                 → { jobId }   body: { prompt, width?, height?, steps?, seed?,
//                                                                  initImage?, denoise?, hires? }
//   GET  /api/comfy/jobs/{id}            → { status: running|done|failed, elapsed, seed, size, error? }
//   GET  /api/comfy/jobs/{id}/image      → PNG 字节
//
// caps（主机能力，2026-10-06 加）：'img2img' = 支持以图改图（initImage+denoise）；'hires' = 支持两步放大重修。
//   老主机不带 caps → 不给「以图改图」参数（会明确报错），hires 也只是退回单次直出。
//
// 约定（2026-10-05 定，实测于 RTX 4060 Laptop 8G + miaomiaoRealskin_anima13）：
//   · 头像固定 768×768（1:1）；cfg/步数/精度由主机侧工作流决定（当前 36 步 / cfg 1.0 / fp8）；
//   · 入库头像压 512（长边）；原图只在本会话内存里留句柄，不进存储；
//   · 主机可能离线（用户没开 ComfyUI / 没开电脑）——所有函数返回结构化结果，绝不抛。
import { SM } from '../infra/gate';
import { WorldBookManager } from './worldbook';
import { SettingSyncManager } from './settingsync';
import { bytesToDataUrl } from '../lib/imagedata';

export interface ImageHostConfig { enabled: boolean; base: string; token: string }

export const IMAGE_HOST_KEY = 'imageHostConfig';
export const AVATAR_SIZE = 768;   // 头像生成边长（1:1）
export const DRAFT_SIZE = 512;    // 草稿试画边长（快，用于挑构图）
export const DRAFT_STEPS = 20;    // 草稿步数（2026-10-05 实测：8 步在 512² 上必然发糊；20 步手/细节才可辨，16 步手会粘连）
export const FAST_SIZE = 512;     // 更快档：512 / 12 步
export const FAST_STEPS = 12;
export const HIGH_SIZE = 1024;    // 更精细档：1024 / 36 步
export const HIGH_STEPS = 36;

// 质量档位：工具参数 quality → 尺寸/步数（单一事实来源；steps 缺省表示交给工作流自己的步数）
//   fast   512/12            用户说"快一点"          约 5~8 秒
//   draft  512/20            一次出 2~3 张挑构图     约 8~10 秒
//   normal 768/工作流 28 步（默认头像）              约 14 秒
//   high   1024/36           用户说"更精细/更大"     约 30 秒
// 注：hires（768 起稿 → 放大 → 低强度重画）2026-10-06 实测在这套模型/显卡上是 88 秒 vs 直出 30 秒、
// 观感也没有更好（还偏软），所以**档位不用它**；主机能力（caps:hires）与协议字段都保留，方便以后换参数再试。
export const QUALITY_TIERS: Record<string, { size: number; steps?: number; hires?: boolean; label: string }> = {
  fast: { size: FAST_SIZE, steps: FAST_STEPS, label: '快' },
  draft: { size: DRAFT_SIZE, steps: DRAFT_STEPS, label: '草稿' },
  normal: { size: AVATAR_SIZE, steps: undefined, label: '标准' },
  high: { size: HIGH_SIZE, steps: HIGH_STEPS, label: '精细' }
};
export const AVATAR_STORE_SIZE = 512; // 入库头像长边（与手动选头像的 _compressImage(file,512) 一致）

function _normBase(s: any): string {
  let v = String(s || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
  return v;
}
function _sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

interface FetchJsonResult { ok: boolean; status: number; data: any; error: string }

function _fetchJson(url: string, opt: any, timeoutMs: number, signal?: AbortSignal): Promise<FetchJsonResult> {
  // 手搓超时（AbortSignal.timeout 在老 WebView 上不一定有），外部 signal 也能取消
  return new Promise<FetchJsonResult>((resolve) => {
    let done = false;
    let timer: any = null;
    const finish = (r: FetchJsonResult) => { if (!done) { done = true; if (timer) clearTimeout(timer); resolve(r); } };
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const abort = () => { try { ac && ac.abort(); } catch (e) { /* ignore */ } };
    timer = setTimeout(() => { abort(); finish({ ok: false, status: 0, data: null, error: '超时' }); }, timeoutMs);
    if (signal) {
      try {
        if (signal.aborted) { abort(); finish({ ok: false, status: 0, data: null, error: '已取消' }); return; }
        signal.addEventListener('abort', () => { abort(); finish({ ok: false, status: 0, data: null, error: '已取消' }); });
      } catch (e) { /* ignore */ }
    }
    fetch(url, Object.assign({}, opt, { signal: ac ? ac.signal : undefined }))
      .then(async (r) => {
        let data: any = null;
        try { data = await r.json(); } catch (e) { data = null; }
        finish({ ok: r.ok, status: r.status, data: data, error: r.ok ? '' : (r.status === 401 ? '配对 token 不对（401）' : ((data && (data.error || data.message)) || ('HTTP ' + r.status))) });
      })
      .catch((e) => finish({ ok: false, status: 0, data: null, error: String((e && e.message) || e) }));
  });
}

function _headers(c: ImageHostConfig, json?: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) h['Content-Type'] = 'application/json';
  if (c.token) h['Authorization'] = 'Bearer ' + c.token;
  return h;
}

// 头像写进世界书/临时角色之后，把所有可能显示它的地方重画一遍。
// （手动选头像的老路径只刷了其中一部分，这里补齐；元素不存在时各 render 自己会早退。）
function _refreshAvatarsEverywhere(): void {
  try { (globalThis as any).UIManager?.renderWBEntries?.(); } catch (e) { /* ignore */ }
  try { (globalThis as any).UIManager?.renderAgentPage?.(); } catch (e) { /* ignore */ }
  try { (globalThis as any).UIManager?.renderDBRecords?.(); } catch (e) { /* ignore */ }
  try { (globalThis as any).ChatMode?.refreshAvatars?.(); } catch (e) { /* ignore */ }
  try { (globalThis as any).RealMode?.render?.(); } catch (e) { /* ignore */ }
}

export const ImageHost = {
  config(): ImageHostConfig {
    try {
      const c = (SM().get<any>(IMAGE_HOST_KEY, {}) || {}) as any;
      return { enabled: !!c.enabled, base: _normBase(c.base), token: String(c.token || '') };
    } catch (e) { return { enabled: false, base: '', token: '' }; }
  },

  save(patch: Partial<ImageHostConfig>): ImageHostConfig {
    const cur = this.config();
    const next: ImageHostConfig = {
      enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
      base: patch.base === undefined ? cur.base : _normBase(patch.base),
      token: patch.token === undefined ? cur.token : String(patch.token || '').trim()
    };
    try { SM().set(IMAGE_HOST_KEY, next); } catch (e) { /* ignore */ }
    return next;
  },

  /** 配好了才去连（enabled + 有地址）；没配就完全不发请求 */
  ready(): boolean { const c = this.config(); return !!c.enabled && !!c.base; },

  async status(timeoutMs = 1500): Promise<any> {
    const c = this.config();
    if (!c.base) return { ok: false, error: '未配置画图主机地址' };
    const r = await _fetchJson(c.base + '/api/comfy/status', { headers: _headers(c) }, timeoutMs);
    if (!r.ok) return { ok: false, error: r.error || '连不上画图主机' };
    const d = r.data || {};
    const wf = d.workflow || {};
    return {
      ok: !!d.ok, version: d.version || '', device: d.device || '',
      // 主机能力（老主机不带 → 空数组：不给"以图改图"参数、hires 退回单次直出）
      caps: Array.isArray(d.caps) ? d.caps.map((x: any) => String(x)) : [],
      model: wf.model || '', hint: wf.hint || '', steps: wf.steps, size: wf.size,
      error: d.ok ? '' : (d.error || '画图主机返回异常')
    };
  },

  /** 提交一次出图。initImage(底图 dataURL)+denoise=以图改图；hires=两步放大重修。 */
  async draw(opts: { prompt: string; width?: number; height?: number; steps?: number; seed?: number; initImage?: string; denoise?: number; hires?: boolean }, signal?: AbortSignal): Promise<any> {
    const c = this.config();
    if (!c.base) return { ok: false, error: '未配置画图主机地址' };
    const prompt = String(opts.prompt || '').trim();
    if (!prompt) return { ok: false, error: '提示词为空' };
    const body: any = { prompt: prompt };
    if (opts.width) body.width = opts.width;
    if (opts.height) body.height = opts.height;
    if (opts.steps) body.steps = opts.steps;
    if (opts.seed !== undefined && opts.seed !== null && String(opts.seed) !== '') body.seed = opts.seed;
    if (opts.initImage) {
      body.initImage = String(opts.initImage);
      if (opts.denoise != null) body.denoise = Number(opts.denoise);
    }
    if (opts.hires) body.hires = true;
    const r = await _fetchJson(c.base + '/api/comfy/draw', { method: 'POST', headers: _headers(c, true), body: JSON.stringify(body) }, 60000, signal);
    if (!r.ok) return { ok: false, error: r.error || '提交失败' };
    const jobId = String((r.data && r.data.jobId) || '');
    return jobId ? { ok: true, jobId: jobId } : { ok: false, error: '画图主机没有返回任务号' };
  },

  async job(jobId: string, signal?: AbortSignal): Promise<any> {
    const c = this.config();
    if (!c.base || !jobId) return { ok: false, error: '参数不完整' };
    const r = await _fetchJson(c.base + '/api/comfy/jobs/' + encodeURIComponent(jobId), { headers: _headers(c) }, 8000, signal);
    if (!r.ok) return { ok: false, error: r.error || '查询失败' };
    const d = r.data || {};
    return { ok: true, status: String(d.status || ''), elapsed: Number(d.elapsed || 0), seed: d.seed, size: d.size || '', error: d.error || '' };
  },

  /** 轮询到出图/失败/超时/取消。onTick 每轮给一次状态（用于 UI 进度）。 */
  async waitJob(jobId: string, opts?: { onTick?: (j: any) => void; signal?: AbortSignal; timeoutMs?: number; intervalMs?: number }): Promise<any> {
    const o = opts || {};
    const t0 = Date.now();
    const limit = o.timeoutMs || 180000;
    const iv = o.intervalMs || 1500;
    for (;;) {
      await _sleep(iv);
      if (o.signal && o.signal.aborted) return { ok: false, error: '已取消' };
      const j = await this.job(jobId, o.signal);
      if (j.ok) {
        try { if (o.onTick) o.onTick(j); } catch (e) { /* ignore */ }
        if (j.status === 'done') return { ok: true, meta: j };
        if (j.status === 'failed') return { ok: false, error: j.error || '出图失败', meta: j };
      }
      if (Date.now() - t0 > limit) return { ok: false, error: '出图超时（' + Math.round(limit / 1000) + ' 秒）' };
    }
  },

  /** 取图 → dataURL（PNG 原图）。失败返回空串。 */
  async imageDataUrl(jobId: string, signal?: AbortSignal): Promise<string> {
    const c = this.config();
    if (!c.base || !jobId) return '';
    try {
      const url = c.base + '/api/comfy/jobs/' + encodeURIComponent(jobId) + '/image' + (c.token ? ('?token=' + encodeURIComponent(c.token)) : '');
      const r = await fetch(url, { headers: _headers(c), signal: signal });
      if (!r.ok) return '';
      const buf = await r.arrayBuffer();
      return bytesToDataUrl(new Uint8Array(buf), 'image/png');
    } catch (e) { return ''; }
  },

  /** 把一张（已压到 512 的）dataURL 写进角色头像。**只认已存在的角色条目**：
   *    ① 原书「角色」条目 → entry.avatar + saveAll；
   *    ② 临时世界书里已有的同名「角色」（比奇 / 对话模式登记过）→ 写它自己那一层（原书不动）。
   *  不认识的 角色名 一律失败——**绝不现造条目**：以前这里会 ensureTempCharacter 造一个临时角色、
   *  还固定写进**对话模式**那一层（键带 _chat），于是工具回报"成功"、写卡和世界书里却什么都看不到
   *  （用户 2026-10-06 反馈的正是这个）。草稿里、还没写进世界书的角色，由调用方先落地再设。 */
  applyAvatarToCharacter(name: string, dataUrl512: string): { ok: boolean; message: string } {
    const nm = String(name || '').trim();
    if (!nm) return { ok: false, message: '工具调用参数无效：缺少角色名' };
    if (!dataUrl512) return { ok: false, message: '失败：图片数据为空（生成结果已过期？）' };
    try {
      const all = WorldBookManager.getAll();
      const wb = WorldBookManager.getActive();
      const entry = (wb && wb.entries) ? wb.entries.find((e: any) => e.type === '角色' && e.name === nm) : null;
      if (entry) {
        entry.avatar = dataUrl512;
        WorldBookManager.saveAll(all);
        _refreshAvatarsEverywhere();
        return { ok: true, message: '已把「' + nm + '」的头像设为这张图（已写入世界书）' };
      }
      // 临时层里的同名条目：两种模式各找一遍，谁有就写谁那一层（不能写错层，写错层等于没写）。
      // 按**名字**找：比奇建的临时角色偶尔类型会被写成「其他」，那种也认（头像照样挂得上），只是提示一句类型。
      const SS: any = SettingSyncManager;
      if (SS && typeof SS.getOverlay === 'function' && typeof SS.withMode === 'function' && typeof SS.setTempAvatar === 'function') {
        const modes: Array<'novel' | 'chat'> = ['novel', 'chat'];
        for (let i = 0; i < modes.length; i++) {
          const mode = modes[i];
          const hit = SS.withMode(mode, () => {
            const o = SS.getOverlay() || {};
            const added: any[] = Array.isArray(o.added) ? o.added : [];
            const same = added.filter((e: any) => String(e.name || '').trim() === nm);
            return same.find((e: any) => String(e.type || '') === '角色') || same[0] || null;
          });
          if (hit && hit.id) {
            const ok = SS.withMode(mode, () => SS.setTempAvatar(String(hit.id), dataUrl512));
            if (ok) {
              const isChar = String(hit.type || '') === '角色';
              _refreshAvatarsEverywhere();
              return {
                ok: true,
                message: '已把「' + nm + '」的头像设为这张图（它是临时新增条目：头像挂在临时世界书，原书不动、重置临时设定后会消失）'
                  + (isChar ? '' : '。注意：它在临时世界书里的类型是「' + String(hit.type || '其他') + '」，要进对话模式的角色名单需要把类型改成「角色」')
              };
            }
          }
        }
      }
      return { ok: false, message: '未找到角色条目：' + nm + '（只能给世界书里已有的角色设头像：名字要与条目名完全一致；还只存在草稿里的新角色要等它写进世界书之后再设）' };
    } catch (e) {
      return { ok: false, message: '失败：写入头像时出错（' + ((e && (e as Error).message) || e) + '）' };
    }
  }
};

export default ImageHost;
