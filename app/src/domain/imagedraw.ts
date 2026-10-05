// 生图公共部件：主机探测（60 秒缓存）、一次完整出图（提交 → 轮询 → 取图 → 存句柄 → 回调挂进消息）、
// 缩略图 HTML。写卡 Agent（cardwriter.ts）与比奇（biqi.ts）两条线共用；「要不要先问用户」这类
// 交互策略各不一样，由各自的规则文案决定，不进这里。
// 协议与质量档位见 domain/imagehost.ts（单一事实来源）。
import { ImageHost, QUALITY_TIERS } from './imagehost';
import { resizeDataUrlLongSide } from '../lib/imagedata';

/** 主机状态缓存（60 秒）。放在各 Agent 自己身上，字段由 probeHost 原地写回。 */
export interface HostStatusCache { at: number; ok: boolean; model: string; hint: string }

export function emptyHostStatus(): HostStatusCache { return { at: 0, ok: false, model: '', hint: '' }; }

/** 这一轮能不能生图：未配置直接 false（不发请求）；否则探测一次并缓存 60 秒。 */
export async function probeHost(cache: HostStatusCache, timeoutMs = 1500): Promise<boolean> {
  try {
    if (!ImageHost.ready()) { cache.ok = false; return false; }
    const now = Date.now();
    if (now - (cache.at || 0) < 60000) return !!cache.ok;
    const st = await ImageHost.status(timeoutMs);
    cache.at = now; cache.ok = !!st.ok; cache.model = st.model || ''; cache.hint = st.hint || '';
    return !!st.ok;
  } catch (e) { cache.ok = false; return false; }
}

export interface TierInfo { key: string; size: number; steps?: number; label: string }

/** 质量档位解析：认不出的档回落到标准档；旧参数 draft:true 仍然兼容。 */
export function resolveTier(quality?: unknown, legacyDraft?: boolean): TierInfo {
  const raw = String(quality || (legacyDraft ? 'draft' : 'normal')).toLowerCase();
  const key = QUALITY_TIERS[raw] ? raw : 'normal';
  const t = QUALITY_TIERS[key];
  return { key: key, size: t.size, steps: t.steps, label: t.label };
}

export interface DrawOutcome {
  ok: boolean;
  /** 失败文案（给模型看：已带「失败：/工具调用参数无效：」前缀，写卡侧靠它判定工具失败） */
  error?: string;
  /** 本次探测结果（调用方写回自己的 60 秒缓存；未配置主机时为 undefined） */
  host?: { ok: boolean; model: string; hint: string };
  id?: string; tier?: TierInfo; seed?: unknown; size?: string; seconds?: number; prompt?: string;
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
  const host = { ok: !!st.ok, model: st.model || '', hint: st.hint || '' };
  if (!st.ok) {
    return { ok: false, host: host, error: '失败：画图主机离线（' + (st.error || '') + '）。请告诉用户检查电脑上的 ComfyUI 和画图主机是否在运行，不要重试。' };
  }
  const tier = resolveTier(opts.quality, opts.legacyDraft);
  const size = tier.size;
  const seed = (opts.seed !== undefined && opts.seed !== null && String(opts.seed) !== '') ? Math.floor(Number(opts.seed)) : undefined;
  const t0 = Date.now();

  const d = await ImageHost.draw({ prompt: prompt, width: size, height: size, seed: seed, steps: tier.steps }, opts.signal);
  if (!d.ok) {
    return { ok: false, host: host, error: '失败：' + (d.error || '提交失败') + '（检查画图主机上的 ComfyUI 是否在运行）' };
  }
  let lastPaint = 0;
  const w = await ImageHost.waitJob(d.jobId, {
    signal: opts.signal,
    timeoutMs: 180000,
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
  opts.store.set(id, { full: full, thumb: thumb, seed: meta.seed, size: sizeText, seconds: seconds, prompt: prompt });
  const cap = opts.cap || 12;
  while (opts.store.size > cap) {
    const k = opts.store.keys().next().value as string;
    opts.store.delete(k);
  }
  try { if (opts.onImage) opts.onImage(id); } catch (e) { /* ignore */ }
  return { ok: true, host: host, id: id, tier: tier, seed: meta.seed, size: sizeText, seconds: seconds, prompt: prompt };
}

/** 消息里的图片缩略图（消息只存 imageIds；图片数据只在本会话内存里，重载后显示占位）。
 *  点缩略图 → UIManager.viewAvatar 全屏看原图（dataURL 直接当 src 用）。 */
export function genImagesHtml(store: Map<string, any>, m: any): string {
  const ids = (m && m.imageIds) ? m.imageIds : null;
  if (!ids || !ids.length) return '';
  const cells: string[] = [];
  const metas: string[] = [];
  for (const gid of ids) {
    const g = store.get(gid);
    const src = g ? String(g.thumb || g.full || '').replace(/"/g, '&quot;') : '';
    if (!src) { cells.push('<div class="cw-img-expired">图片已过期<br>（需要时重新生成）</div>'); continue; }
    cells.push('<img src="' + src + '" title="点击看大图" onclick="UIManager.viewAvatar(this.src)">');
    metas.push(String(g.size || '') + ' · seed ' + ((g.seed == null) ? '?' : g.seed) + ' · ' + g.seconds + 's');
  }
  if (!cells.length) return '';
  return '<div class="cw-imgs">' + cells.join('') + '</div>' +
    (metas.length ? '<div class="cw-img-meta">' + metas.join('　') + '</div>' : '');
}
