// 生图公共部件：主机探测（60 秒缓存）、一次完整出图（提交 → 轮询 → 取图 → 存句柄 → 回调挂进消息）、
// 底图引用解析（"图3"/"img3"/"last"/角色名）、缩略图 HTML。
// 写卡 Agent（cardwriter.ts）与比奇（biqi.ts）两条线共用；「要不要先问用户」这类
// 交互策略各不一样，由各自的规则文案决定，不进这里。
// 协议与质量档位见 domain/imagehost.ts（单一事实来源）。
import { ImageHost, QUALITY_TIERS } from './imagehost';
import { WorldBookManager } from './worldbook';
import { SettingSyncManager } from './settingsync';
import { resizeDataUrlLongSide, bytesToDataUrl } from '../lib/imagedata';

/** 主机状态缓存（60 秒）。放在各 Agent 自己身上，字段由 probeHost 原地写回。
 *  caps 可缺省：老缓存/测试桩里没有这个字段时按"主机不支持"处理（空数组）。 */
export interface HostStatusCache { at: number; ok: boolean; model: string; hint: string; caps?: string[] }

export function emptyHostStatus(): HostStatusCache { return { at: 0, ok: false, model: '', hint: '', caps: [] }; }

/** 消息里那行「图3」编号（与 id 一一对应：img3 → 图3）。没有编号的（空串/异常值）返回 ''。 */
export function imageLabel(id: any): string {
  const m = /(\d+)\s*$/.exec(String(id || ''));
  return m ? ('图' + m[1]) : '';
}

/** 这一轮能不能生图：未配置直接 false（不发请求）；否则探测一次并缓存 60 秒。 */
export async function probeHost(cache: HostStatusCache, timeoutMs = 1500): Promise<boolean> {
  try {
    if (!ImageHost.ready()) { cache.ok = false; return false; }
    const now = Date.now();
    if (now - (cache.at || 0) < 60000) return !!cache.ok;
    const st = await ImageHost.status(timeoutMs);
    cache.at = now; cache.ok = !!st.ok; cache.model = st.model || ''; cache.hint = st.hint || '';
    cache.caps = Array.isArray(st.caps) ? st.caps.slice() : [];
    return !!st.ok;
  } catch (e) { cache.ok = false; return false; }
}

export interface TierInfo { key: string; size: number; steps?: number; hires?: boolean; label: string }

/** 质量档位解析：认不出的档回落到标准档；旧参数 draft:true 仍然兼容。 */
export function resolveTier(quality?: unknown, legacyDraft?: boolean): TierInfo {
  const raw = String(quality || (legacyDraft ? 'draft' : 'normal')).toLowerCase();
  const key = QUALITY_TIERS[raw] ? raw : 'normal';
  const t = QUALITY_TIERS[key];
  return { key: key, size: t.size, steps: t.steps, hires: !!t.hires, label: t.label };
}

/** 改图幅度（工具参数 strength → denoise）：越小越保构图。
 *  分档按"改什么"选（2026-10-06 用户校准）：
 *    slight 0.35 —— **只修小毛病**（手指/眼睛/局部瑕疵），姿势构图衣服背景都不动
 *    medium 0.55 —— 换表情、换衣服颜色、加减小物件、换光线；姿势与构图基本不动
 *    strong 0.75 —— 换姿势/动作、换整套衣服、换背景场景、换机位；**只保住人物（脸）** */
export const STRENGTH_DENOISE: Record<string, number> = { slight: 0.35, medium: 0.55, strong: 0.75 };
export function strengthDenoise(strength?: unknown): number {
  const k = String(strength || '').toLowerCase();
  return STRENGTH_DENOISE[k] != null ? STRENGTH_DENOISE[k] : STRENGTH_DENOISE.medium;
}

export interface BaseImageResult {
  ok: boolean;
  dataUrl?: string; label?: string; error?: string;
  /** soft=true：引用的是"角色的头像"，但这个角色还没有头像——调用方可以**不带头像照常画**（不用当失败） */
  soft?: boolean;
}

function _avatarOf(name: string): string {
  // 角色当前头像：原书条目 → 临时层（两种模式都找）。返回 dataURL 或 ''。
  try {
    const wb = WorldBookManager.getActive();
    const e = (wb && wb.entries) ? wb.entries.find((x: any) => x.type === '角色' && String(x.name || '').trim() === name) : null;
    if (e && e.avatar) return String(e.avatar);
  } catch (err) { /* ignore */ }
  try {
    const SS: any = SettingSyncManager;
    if (SS && typeof SS.getOverlay === 'function' && typeof SS.withMode === 'function') {
      const modes = ['novel', 'chat'];
      for (let i = 0; i < modes.length; i++) {
        const hit: any = SS.withMode(modes[i], () => {
          const o = SS.getOverlay() || {};
          const added: any[] = Array.isArray(o.added) ? o.added : [];
          const same = added.filter((x: any) => String(x.name || '').trim() === name);
          return same.find((x: any) => String(x.type || '') === '角色') || same[0] || null;
        });
        if (hit && hit.avatar) return String(hit.avatar);
      }
    }
  } catch (err) { /* ignore */ }
  return '';
}

/**
 * 解析「底图引用」→ dataURL。引用写法（模型从工具说明里学，用户从界面编号上认）：
 *   'img3' / '图3' / '3'  → 本会话生成过的那张（句柄还在才行）
 *   'last' / '上一张'     → 最近生成的一张
 *   其它（角色名）        → 该角色当前头像（原书条目或临时层）
 */
export async function resolveBaseImage(ref: unknown, store: Map<string, any>): Promise<BaseImageResult> {
  const raw = String(ref || '').trim();
  if (!raw) return { ok: false, error: '底图引用为空' };
  const low = raw.toLowerCase();
  let id = '';
  if (low === 'last' || raw === '上一张' || raw === '最近一张') {
    const keys = Array.from(store.keys());
    id = keys.length ? keys[keys.length - 1] : '';
    if (!id) return { ok: false, error: '本会话还没有生成过图片，没有"上一张"可用' };
  } else {
    const m = /^(?:img\s*|图\s*)?(\d+)$/i.exec(low);
    if (m) {
      id = 'img' + m[1];
      if (!store.has(id)) {
        return { ok: false, error: '找不到' + raw + '（生成的图片只在本会话内存里；重开 App 后旧图只剩"已过期"占位，请重新生成一张，或换一张还在的图）' };
      }
    }
  }
  if (id) {
    const g: any = store.get(id);
    const url = String((g && (g.full || g.thumb)) || '');
    if (!url) return { ok: false, error: '那张图的数据已经没了，请重新生成' };
    return { ok: true, dataUrl: url, label: imageLabel(id) || raw };
  }
  // 不是编号 → 当角色名，用它的头像
  const av = _avatarOf(raw);
  if (!av) return { ok: false, soft: true, error: '「' + raw + '」还没有头像（可以照常按描述画，只是脸不会固定；想要 TA 的脸一致就先给这个角色设一张头像）' };
  if (/^data:/i.test(av)) return { ok: true, dataUrl: av, label: raw + '的头像' };
  // 头像可能是外链（导入的卡）：抓成 dataURL 再交给主机（CORS 拦不住就当失败）
  try {
    const r = await fetch(av);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = await r.arrayBuffer();
    const mime = String(r.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const du = bytesToDataUrl(new Uint8Array(buf), mime);
    if (!du) throw new Error('转 dataURL 失败');
    return { ok: true, dataUrl: du, label: raw + '的头像' };
  } catch (e) {
    return { ok: false, error: '「' + raw + '」的头像不是本地图片、也抓不下来（' + ((e && (e as Error).message) || e) + '），换用图片编号或先重新设一张头像' };
  }
}

export interface DrawOutcome {
  ok: boolean;
  /** 失败文案（给模型看：已带「失败：/工具调用参数无效：」前缀，写卡侧靠它判定工具失败） */
  error?: string;
  /** 本次探测结果（调用方写回自己的 60 秒缓存；未配置主机时为 undefined） */
  host?: { ok: boolean; model: string; hint: string; caps: string[] };
  id?: string; tier?: TierInfo; seed?: unknown; size?: string; seconds?: number; prompt?: string;
  // 以图改图时的底图说明（如「图3」「林晚的头像」），没改图则为空
  base?: string;
  /** 想要头像当底图但那个角色还没有头像时的说明（这次是按描述画的） */
  baseNote?: string;
  /** 实际是不是走了两步放大重修（老主机没这能力时为 false） */
  hires?: boolean;
}

/**
 * 出一次图。成功时把句柄（full/thumb/seed/size/seconds/prompt）存进 opts.store（默认上限 12 张，
 * 超出丢最旧），再调 opts.onImage(id) 让调用方把 id 挂到消息上。
 * 所有失败都走返回值，不抛（网络/超时/用户取消）。
 */
export async function drawImageToStore(opts: {
  prompt: string;
  quality?: unknown;
  legacyDraft?: boolean;
  seed?: unknown;
  /** 底图引用：'图3' / 'img3' / 'last' / 角色名（用它的头像）。给了就是"以图改图" */
  baseImage?: unknown;
  /** 改图幅度：slight(0.35) / medium(0.55，默认) / strong(0.75) */
  strength?: unknown;
  store: Map<string, any>;
  /** 下一个图片 id（调用方自增自己的计数器，如 () => 'img' + (++this._imgSeq)） */
  nextId: () => string;
  signal?: AbortSignal;
  /** 轮询期间约每秒一次（调用方刷新"正在出图…"状态） */
  onTick?: () => void;
  /** 用户已停止本轮 → 中断（不可用时略过） */
  shouldCancel?: () => boolean;
  onImage?: (id: string) => void;
  cap?: number;
}): Promise<DrawOutcome> {
  if (!ImageHost.ready()) {
    return { ok: false, error: '失败：画图主机未配置或未启用。请告诉用户去「设置 → AI 与生成 → 画图主机」填地址和 token；本轮改用文字说明。' };
  }
  const prompt = String(opts.prompt || '').trim();
  if (!prompt) return { ok: false, error: '工具调用参数无效：prompt 不能为空' };

  const st = await ImageHost.status(2000);
  const host = { ok: !!st.ok, model: st.model || '', hint: st.hint || '', caps: Array.isArray(st.caps) ? st.caps.slice() : [] };
  if (!st.ok) {
    return { ok: false, host: host, error: '失败：画图主机离线（' + (st.error || '') + '）。请告诉用户检查电脑上的 ComfyUI 和画图主机是否在运行，不要重试。' };
  }
  const caps: string[] = host.caps || [];
  // 底图：解析引用 → dataURL。**角色没头像不算失败**（照常画，只提示一句）——比奇默认拿角色头像当底图，
  // 新角色还没头像时不该整张画不出来；但用户点名的那张图（图号/last）没了就是真失败。
  let initImage = '';
  let baseLabel = '';
  let baseNote = '';
  const baseRef = String(opts.baseImage || '').trim();
  if (baseRef) {
    if (caps.indexOf('img2img') < 0) {
      return { ok: false, host: host, error: '失败：画图主机不支持以图改图（电脑上的画图主机是旧版，请更新后再试）；这次可以不带 base_image 重新出图。' };
    }
    const b = await resolveBaseImage(baseRef, opts.store);
    if (!b.ok && !b.soft) return { ok: false, host: host, error: '失败：' + (b.error || '底图不可用') };
    if (b.ok) {
      initImage = String(b.dataUrl || '');
      baseLabel = String(b.label || baseRef);
    } else {
      baseNote = String(b.error || '');   // 软失败：不带头像照常画，把原因带回给模型
    }
  }
  const tier = resolveTier(opts.quality, opts.legacyDraft);
  const size = tier.size;
  const seed = (opts.seed !== undefined && opts.seed !== null && String(opts.seed) !== '') ? Math.floor(Number(opts.seed)) : undefined;
  // 两步放大重修：只有主机支持才带（老主机静默退回单次直出，图片照样有）
  const hires = !!tier.hires && caps.indexOf('hires') >= 0;
  const t0 = Date.now();

  const d = await ImageHost.draw({
    prompt: prompt, width: size, height: size, seed: seed, steps: tier.steps,
    initImage: initImage || undefined,
    denoise: initImage ? strengthDenoise(opts.strength) : undefined,
    hires: hires || undefined
  }, opts.signal);
  if (!d.ok) {
    return { ok: false, host: host, error: '失败：' + (d.error || '提交失败') + '（检查画图主机上的 ComfyUI 是否在运行）' };
  }
  let lastPaint = 0;
  const w = await ImageHost.waitJob(d.jobId, {
    signal: opts.signal,
    timeoutMs: 240000,   // 两步重修 + 底图上传可能到 1~2 分钟，给足（主机侧 300 秒兜底）
    onTick: () => {
      // 节流：主机 1.5 秒一轮，界面没必要跟着每秒重画
      const now = Date.now();
      if (now - lastPaint > 1000) {
        lastPaint = now;
        try { if (opts.onTick) opts.onTick(); } catch (e) { /* ignore */ }
      }
    }
  });
  if ((opts.shouldCancel && opts.shouldCancel()) || (opts.signal && opts.signal.aborted)) {
    return { ok: false, host: host, error: '失败：用户已停止本轮，出图已中断' };
  }
  if (!w.ok) return { ok: false, host: host, error: '失败：' + (w.error || '出图失败') };

  const full = await ImageHost.imageDataUrl(d.jobId, opts.signal);
  if (!full) return { ok: false, host: host, error: '失败：取图失败（画图主机没有返回图片字节）' };
  const thumb = (await resizeDataUrlLongSide(full, 420, 0.85)) || full;
  const id = opts.nextId();
  const seconds = Math.round((Date.now() - t0) / 100) / 10;
  const meta = w.meta || {};
  const sizeText = meta.size || (size + 'x' + size);
  opts.store.set(id, {
    full: full, thumb: thumb, seed: meta.seed, size: sizeText, seconds: seconds, prompt: prompt,
    base: baseLabel, hires: hires
  });
  const cap = opts.cap || 12;
  while (opts.store.size > cap) {
    const k = opts.store.keys().next().value as string;
    opts.store.delete(k);
  }
  try { if (opts.onImage) opts.onImage(id); } catch (e) { /* ignore */ }
  return { ok: true, host: host, id: id, tier: tier, seed: meta.seed, size: sizeText, seconds: seconds, prompt: prompt, base: baseLabel, baseNote: baseNote, hires: hires };
}

/** 消息里的图片缩略图（消息只存 imageIds；图片数据只在本会话内存里，重载后显示占位）。
 *  · 缩略图左下角带「图3」编号（与模型看到的编号一致：用户可以指名"把图3改成…"）；
 *  · 点缩略图 → viewCall（调用方的 viewImage(id)，拿**原图**给全屏查看器；不传则退回直接用缩略图 src）。
 *  注：气泡里显示的始终是 420px 缩略图，所以点开必须换成原图——否则 1024 档和 512 档看起来一模一样
 *  （用户 2026-10-06 反馈的正是这个）。 */
export function genImagesHtml(store: Map<string, any>, m: any, viewCall?: string): string {
  const ids = (m && m.imageIds) ? m.imageIds : null;
  if (!ids || !ids.length) return '';
  const cells: string[] = [];
  const metas: string[] = [];
  for (const gid of ids) {
    const g = store.get(gid);
    const src = g ? String(g.thumb || g.full || '').replace(/"/g, '&quot;') : '';
    if (!src) { cells.push('<div class="cw-img-expired">图片已过期<br>（需要时重新生成）</div>'); continue; }
    const safeId = String(gid).replace(/[^A-Za-z0-9_]/g, '');
    const onclick = viewCall ? (viewCall + "('" + safeId + "')") : 'UIManager.viewAvatar(this.src)';
    const no = imageLabel(gid);   // '图N'——只由数字拼成，直接内联安全
    cells.push('<span class="cw-img-cell"><img src="' + src + '" title="点击看大图" onclick="' + onclick + '">'
      + (no ? '<b class="cw-img-no">' + no + '</b>' : '') + '</span>');
    const extra = (g.base ? (' · 改自' + String(g.base)) : '') + (g.hires ? ' · 两步重修' : '');
    metas.push((no ? no + ' · ' : '') + String(g.size || '') + ' · seed ' + ((g.seed == null) ? '?' : g.seed) + ' · ' + g.seconds + 's' + extra);
  }
  if (!cells.length) return '';
  return '<div class="cw-imgs">' + cells.join('') + '</div>' +
    (metas.length ? '<div class="cw-img-meta">' + metas.join('　') + '</div>' : '');
}
