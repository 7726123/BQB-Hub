// 归档回读的「epoch 钉住」：一个归档周期内回读块字节不变，新命中的片段只进尾部「本轮补充」区。
//
// 为什么这样做（2026-09-25 实测，复现脚本 tools/cache-probe.mjs）：
// 前缀缓存的命中长度 = 与上一轮请求的**最长公共前缀**，所以「同一个块内容变了」= 这个块及其后
// 所有内容本轮全部按 miss 计费。旧实现每轮按 BM25 分数倒序重排 + 集合漂移，回读块的**第一个字节**
// 就在变 → 整块永远不可能命中（实测命中率卡在 40~47%，恰好只剩 system 前缀）。
// 实测「只改排序」几乎没用（集合一漂移首条就变），真正的解法是**只追加**：上一轮的列表原序保留、
// 新命中追加到尾部，整个块就变成上一轮的前缀 → 命中率 47%→72%。
//
// 重置对齐「归档轮」：Waterline 滚动时窗口最旧的块被丢弃，那一轮本来就整轮 miss（实测该轮 cached=0），
// 把重选放在那一轮 = 免费；而且归档周期（窗口 5 万字 / 触发 7.5 万字 / 每次约 2000 字 ≈ 12~15 次续写）
// 天然给钉住块封了顶，不需要额外的淘汰规则。
//
// 两级：
//   items（epoch 块）——上次归档轮定下的背景回读，epoch 内字节不变（可命中）；
//   staged（本轮补充）——本 epoch 内新检出的片段，逐轮追加、供本轮使用，到归档轮并进 items。
import { SM } from '../infra/gate';

export interface PinItem { key: string; text: string; blockId?: string }
export interface PinState { epochX: number; items: PinItem[]; staged: PinItem[] }

export interface PinStepOpts {
  /** 当前窗口左边界（Waterline.x）。变了 = 发生了滚动或重建 → 新 epoch */
  x: number;
  /** 本轮是否真的滚动了归档（用于日志/返回，不影响判定） */
  rolled?: boolean;
  /** 本轮检出的候选（已按门槛过滤、按重要性排序；调用方不必去重） */
  cands: PinItem[];
  /** epoch 块上限（字），默认 20000 */
  epochCap?: number;
  /** 本轮补充区上限（字），默认 10000 */
  freshCap?: number;
}

export interface PinStepResult {
  epoch: PinItem[];
  fresh: PinItem[];
  /** 本轮是否发生了重选（归档轮/换书/首轮）：true 时本轮的 epoch 块相对上轮是新的 */
  rotated: boolean;
}

const DEFAULT_EPOCH_CAP = 20000;
const DEFAULT_FRESH_CAP = 10000;

function sizeOf(list: PinItem[]): number {
  return (list || []).reduce(function (n, it) { return n + String(it && it.text || '').length; }, 0);
}

export const RecallPin = {
  EPOCH_CAP: DEFAULT_EPOCH_CAP,
  FRESH_CAP: DEFAULT_FRESH_CAP,

  _key(bookId: string): string { return 'recallPin_' + (bookId || 'none'); },

  get(bookId: string): PinState {
    const raw = SM().get<PinState>(this._key(bookId), null);
    if (!raw || typeof raw !== 'object') return { epochX: -1, items: [], staged: [] };
    return {
      epochX: typeof raw.epochX === 'number' ? raw.epochX : -1,
      items: Array.isArray(raw.items) ? raw.items.filter(function (i) { return i && i.key && i.text; }) : [],
      staged: Array.isArray(raw.staged) ? raw.staged.filter(function (i) { return i && i.key && i.text; }) : [],
    };
  },

  _save(bookId: string, s: PinState): void { SM().set(this._key(bookId), s); },

  reset(bookId: string): void { this._save(bookId, { epochX: -1, items: [], staged: [] }); },

  /**
   * 按上限裁剪。方向很重要：
   * - epoch 块 keep='front'：保住块首（缓存前缀靠它），超限时丢最新的尾巴；
   * - 本轮补充区 keep='back'：保住刚检出的（相关性靠它），超限时丢最旧的头部——这块本来就在易变区，断前缀不心疼。
   */
  _cap(list: PinItem[], cap: number, keep: 'front' | 'back'): PinItem[] {
    const out: PinItem[] = [];
    let used = 0;
    if (keep === 'front') {
      for (let i = 0; i < list.length; i++) {
        const len = String(list[i].text || '').length;
        if (used + len > cap && out.length > 0) break;
        out.push(list[i]); used += len;
      }
      return out;
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const len = String(list[i].text || '').length;
      if (used + len > cap && out.length > 0) break;
      out.unshift(list[i]); used += len;
    }
    return out;
  },

  // 每轮调用：把本轮候选并进「本轮补充」区（只追加），归档轮/换书/重建时把补充区并入 epoch 块
  step(bookId: string, opts: PinStepOpts): PinStepResult {
    const epochCap = opts.epochCap || this.EPOCH_CAP;
    const freshCap = opts.freshCap || this.FRESH_CAP;
    const st = this.get(bookId);
    const x = Number(opts.x) || 0;
    const rotated = st.epochX !== x;

    // 新 epoch：上一轮攒下的补充区转入 epoch 块（commit），然后清空补充区
    let items = rotated ? st.staged.concat(st.items) : st.items;
    let staged = rotated ? [] : st.staged;

    if (rotated && items.length > 0) {
      // 去重（同一片段可能在多个 epoch 里被反复检出）
      const seen: Record<string, boolean> = {};
      items = items.filter(function (it) { if (seen[it.key]) return false; seen[it.key] = true; return true; });
    }

    // 本轮新命中 → 追加进补充区（epoch 块里已有的不重复收）
    const inEpoch: Record<string, boolean> = {};
    items.forEach(function (it) { inEpoch[it.key] = true; });
    const inStaged: Record<string, boolean> = {};
    staged.forEach(function (it) { inStaged[it.key] = true; });
    const added: PinItem[] = [];
    (opts.cands || []).forEach(function (c) {
      if (!c || !c.key || !c.text) return;
      if (inEpoch[c.key] || inStaged[c.key]) return;
      inStaged[c.key] = true;
      added.push({ key: c.key, text: String(c.text), blockId: c.blockId });
    });
    staged = staged.concat(added);

    items = this._cap(items, epochCap, 'front');
    staged = this._cap(staged, freshCap, 'back');
    this._save(bookId, { epochX: x, items: items, staged: staged });
    return { epoch: items, fresh: staged, rotated: rotated };
  },

  /** 诊断：当前状态体积（字数） */
  stats(bookId: string): { epochItems: number; epochChars: number; freshItems: number; freshChars: number } {
    const s = this.get(bookId);
    return { epochItems: s.items.length, epochChars: sizeOf(s.items), freshItems: s.staged.length, freshChars: sizeOf(s.staged) };
  },
};

export default RecallPin;
