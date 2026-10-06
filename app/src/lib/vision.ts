// 视觉（看图）能力：**试一次、按模型记住**。
//
// 设计要点（用户 2026-10-06 明确要求"看不了图的模型就不要让模型看了，要做好兜底"）：
//  · 图片只进两类**独立的一次性小请求**：① 刚出图后"软件替你核对一眼"；② 模型主动调 look_at_image。
//    绝不把图片塞进写卡/比奇的主对话请求——这样"模型看不了图"最坏只影响这一次小请求，
//    绝不会把主对话搞挂（主请求里连图片字段都不会出现）。
//  · 能力按**模型名**缓存在设置里（visionCaps）：'yes' = 能看；'no' = 看不了（不再试探、也不给它看图工具）；
//    'unknown' = 还没试过（允许试一次）。
//  · 判 'no' 很保守：只有报错里同时出现 **4xx** 且提到 image/vision/图片/模态 这类词才算"能力问题"；
//    超时、网络错误、5xx 一律保持 unknown（下次再试），绝不因为一次偶发失败就把看图关掉。
export type VisionState = 'yes' | 'no' | 'unknown';

export const VISION_CAPS_KEY = 'visionCaps';

/** 看图子调用的人设：只要具体结论，不要客套。 */
export const VISION_SYSTEM = '你是一个图片核对助手。用户会发来一张小说/角色卡的插图并问一个问题，'
  + '你只回答他问的那件事：描述要具体（人物在做什么、画面里有什么），并指出**明显**的问题（手指畸形、文字乱码、结构错误、明显糊）。'
  + '不要客套、不要复述问题、不要展开无关内容，两三句话以内。';

function _sm(): any {
  try { return (globalThis as unknown as { StorageManager?: any }).StorageManager || null; } catch (e) { return null; }
}

// 会话内兜底：存储不可用（或测试环境把 StorageManager 桩成 no-op）时，能力状态至少在同一次运行里有效。
let _mem: Record<string, VisionState> = {};
function _readAll(): Record<string, VisionState> {
  try {
    const sm = _sm();
    const all = (sm && sm.get(VISION_CAPS_KEY, null)) || null;
    if (all && typeof all === 'object') {
      for (const k of Object.keys(all)) if (all[k] === 'yes' || all[k] === 'no') _mem[k] = all[k];
    }
  } catch (e) { /* ignore */ }
  return _mem;
}

/** 当前生效的模型名（拿不到就给个占位键，至少同一次运行内共享缓存）。 */
export function activeModelId(): string {
  try {
    const P: any = (globalThis as unknown as { PresetManager?: any }).PresetManager;
    const c = (P && typeof P.getActiveAPIConfig === 'function') ? P.getActiveAPIConfig() : null;
    return String((c && c.model) || '') || '(默认)';
  } catch (e) { return '(默认)'; }
}

export function visionState(model?: string): VisionState {
  const m = String(model || activeModelId());
  try {
    const v = _readAll()[m];
    return (v === 'yes' || v === 'no') ? v : 'unknown';
  } catch (e) { return 'unknown'; }
}

export function markVision(state: 'yes' | 'no', model?: string): void {
  const m = String(model || activeModelId());
  _mem[m] = state;                                   // 会话内立刻生效（存储坏了也不影响本会话）
  try {
    const sm = _sm();
    if (!sm) return;
    const all = sm.get(VISION_CAPS_KEY, {}) || {};
    all[m] = state;
    sm.set(VISION_CAPS_KEY, all);
  } catch (e) { /* 存不下就算了：下次重新试 */ }
}

/** 这个报错像不像"模型/网关不接受图片"？（保守：要 4xx + 图片/视觉相关词） */
export function looksLikeVisionError(errText: any): boolean {
  const t = String(errText == null ? '' : errText).toLowerCase();
  if (!t) return false;
  if (!/4\d\d/.test(t)) return false;                       // 2xx/5xx/超时都不算
  return /(image_url|image|vision|multimodal|图片|视觉|模态)/.test(t);
}

/** 一次"看图"子调用：把图（缩略图 dataURL）+ 问题发给当前模型，返回它的文字回答。**不抛**。 */
export async function lookAtImage(opts: { images: string[]; question: string; callLabel?: string }): Promise<{ ok: boolean; answer?: string; error?: string }> {
  const imgs = (opts && opts.images ? opts.images : []).filter(Boolean).slice(0, 2);
  const q = String((opts && opts.question) || '').trim();
  if (!imgs.length) return { ok: false, error: '没有可看的图' };
  if (!q) return { ok: false, error: '没有要问的问题' };
  const API: any = (globalThis as unknown as { APIHandler?: any }).APIHandler;
  if (!API || typeof API.fetchCompletions !== 'function') return { ok: false, error: '接口层不可用' };
  const content: any[] = [{ type: 'text', text: q }];
  for (const u of imgs) content.push({ type: 'image_url', image_url: { url: String(u) } });
  const msgs = [{ role: 'system', content: VISION_SYSTEM }, { role: 'user', content: content }];
  return new Promise(function (resolve) {
    let done = false;
    const finish = (r: { ok: boolean; answer?: string; error?: string }) => { if (!done) { done = true; resolve(r); } };
    try {
      API.fetchCompletions(
        msgs,
        function () { /* 不看流式：只需要最终文本 */ },
        function (full: any) { finish({ ok: true, answer: String(full == null ? '' : full).trim() }); },
        function (err: any) { finish({ ok: false, error: String(err == null ? '' : err) }); },
        { temperature: 0.2, callLabel: (opts && opts.callLabel) || 'vision', timeout: 90000, idleTimeout: 60000 }
      );
    } catch (e: any) { finish({ ok: false, error: String((e && e.message) || e) }); }
  });
}

/** 跑一次看图子调用，并按结果维护能力缓存（成功→yes；像能力问题→no；其它→保持 unknown）。 */
export async function lookAtImageTracked(opts: { images: string[]; question: string; callLabel?: string }): Promise<{ ok: boolean; answer?: string; error?: string; state: VisionState }> {
  const r = await lookAtImage(opts);
  if (r.ok) { markVision('yes'); return { ok: true, answer: r.answer, state: 'yes' }; }
  if (looksLikeVisionError(r.error)) { markVision('no'); return { ok: false, error: r.error, state: 'no' }; }
  return { ok: false, error: r.error, state: 'unknown' };
}

/** 测试用：清掉能力缓存（存储 + 会话内兜底） */
export function __resetVisionForTest(): void {
  _mem = {};
  try { const sm = _sm(); if (sm) sm.remove(VISION_CAPS_KEY); } catch (e) { /* ignore */ }
}
