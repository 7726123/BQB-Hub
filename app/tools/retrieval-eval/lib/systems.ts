// 被评测的检索系统：
//  mine          —— 自研生产管线复刻（自学习词典 + 查询构造 + 强相关门槛 + 主角名直收 + 相邻合并 + 分位门槛 + 预算填充）
//  bm25_qb       —— 同查询构造，但去掉门槛/直收/合并（消融：管线加工程度）
//  bm25_raw      —— 纯 bigram BM25，原始窗口当查询，无词典自学（消融：查询构造+词典）
//  random        —— 随机取块（地板基线）
//  dense         —— 酒馆式向量召回（同一 800 字子块，余弦 + 阈值 0.25，预算填充）
//  dense_native  —— 酒馆原生分块（2500 字块、无重叠）向量召回
//  hybrid_rrf    —— BM25(raw) ⊕ dense，RRF k=60 融合
//  rr_rerank     —— 上者 top20 再经 bge-reranker-v2-m3 重排
import { ArchiveIndex, MemoryQueryBuilder } from '../../../src/lib/bm25';
import { cosine, rerankScores } from './api';
import { Child, Piece, norm, mulberry32 } from './core';

export interface Ctx {
  t: number;
  band0: string;
  bands: string[];
  recentText: string;
  dictUnion: string[];
  /** 世界书实体（生产环境一定有：条目名+关键词；评测里用"首点之前的正文"学出的词表合成） */
  wbTerms: string[];
  /** 用户指令（生产里是用户输入；评测场景 B 用"点名回忆"合成） */
  instruction: string;
  budget: number;
  /** 归档区覆盖到的正文字符偏移（子块 absEnd ≤ coveredEnd 即在归档内） */
  coveredEnd: number;
}

export interface SysResult { pieces: Piece[]; ms: number; query?: string; meta?: Record<string, number | string> }

/** 指令点名词条（引号词条 ∪ 词典实体 ∪ 高频点名锚）——生产 app.ts 的 namedTerms 调用等价物 */
export function namedTermsOf(ctx: Ctx): string[] {
  try {
    if (!ctx.instruction) return [];
    return MemoryQueryBuilder.namedTerms(
      ctx.instruction,
      ArchiveIndex.getDf.bind(ArchiveIndex),
      ArchiveIndex.termCount.bind(ArchiveIndex),
      ArchiveIndex.childCount(),
    );
  } catch (e) { return []; }
}

/** 点名锚专用检索：点名词条单独检索 topK（生产"点名必达"通道的等价物） */
export function namedPassPieces(ctx: Ctx, topK = 6): Piece[] {
  const named = namedTermsOf(ctx);
  if (!named.length) return [];
  ArchiveIndex.ensureFresh();
  const hits = ArchiveIndex.search(named.join(' '), topK) as { blockId: string; text: string; score: number }[];
  const out: Piece[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    const text = String(h.text || '');
    const key = norm(text).slice(0, 40);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ blockId: h.blockId, text, score: h.score });
  }
  return out;
}

/** 按排名填充到字符预算（首条允许超预算；同文本前缀去重） */
export function fillByRank(ranked: { blockId: string; text: string; score?: number }[], budget: number): Piece[] {
  const out: Piece[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const r of ranked) {
    const text = String(r.text || '');
    const key = norm(text).slice(0, 40);
    if (!key || seen.has(key)) continue;
    if (out.length > 0 && used + text.length > budget) continue;
    seen.add(key);
    out.push({ blockId: r.blockId, text, score: r.score });
    used += text.length;
    if (used >= budget) break;
  }
  return out;
}

/** 自研生产管线复刻（app.ts 归档回读段；事件行/事实卡通道不含——它们需要 LLM 生成）。
 *  默认 = 新生产：候选深度 48、直收 2 条、按分数填满预算；
 *  opts.legacy = 旧生产对照：候选深度 24、直收 4 条、15 百分位 + top2 保底裁剪。 */
export function runMine(ctx: Ctx, opts?: { legacy?: boolean }): SysResult {
  const t0 = Date.now();
  ArchiveIndex.ensureFresh();
  const getDf = ArchiveIndex.getDf.bind(ArchiveIndex);
  const getCount = ArchiveIndex.termCount.bind(ArchiveIndex);
  const dfCap = ArchiveIndex.suggestDfCap();
  const q = MemoryQueryBuilder.build(ctx.band0, {
    getDf, dfCap,
    dict: ctx.dictUnion.length ? ctx.dictUnion : undefined,
    instruction: ctx.instruction,
    getCount,
    recentParts: ctx.bands.slice(1),
    n: ArchiveIndex.childCount(),
  });
  let cands: { id: string; blockId: string; text: string; score: number }[] = ArchiveIndex.search(q, opts?.legacy ? 24 : 48) as never;
  // 强相关门槛（宁缺毋滥）
  const gDfCap = Math.max(3, Math.min(dfCap, 6));
  const gTerms = MemoryQueryBuilder.rareTermsMulti([ctx.instruction].concat(ctx.bands), getDf, gDfCap, 12, getCount);
  // 指令点名锚（app.ts:1350-1357 复刻）
  if (ctx.instruction) {
    try {
      MemoryQueryBuilder.namedAnchors(ctx.instruction, getDf, 2, getCount)
        .forEach(w => { if (gTerms.indexOf(w) < 0) gTerms.push(w); });
    } catch (e) { /* 忽略 */ }
  }
  // 世界书实体若在当前正文出现，直接进门控词表（app.ts:1358-1365 复刻）——
  // 有了它 entKeys 非空、阈值降到 1，门槛才不会把候选全滤掉
  for (const w of ctx.wbTerms) {
    if (w && w.length >= 2 && ctx.recentText.indexOf(w) >= 0 && gTerms.indexOf(w) < 0) gTerms.push(w);
  }
  if (gTerms.length >= 2) {
    const entKeys = gTerms.filter(w => w.length >= 2 && (ctx.dictUnion.indexOf(w) >= 0 || ctx.instruction.indexOf(w) >= 0));
    const thr = entKeys.length ? 1 : 2;
    cands = cands.filter(c => MemoryQueryBuilder.countTermHits(String(c.text || ''), gTerms) >= thr);
  }
  // 主角名直收
  const direct = ArchiveIndex.searchDirect(q, opts?.legacy ? 4 : 2);
  const spans = ArchiveIndex.mergeSpans(cands)
    .map(s => ({ blockId: s.blockId, text: String(s.text || ''), score: Number(s.score) || 0 }))
    .sort((a, b) => b.score - a.score);
  let minScore = 1;
  let topGuard = 0;
  if (opts?.legacy) {
    if (spans.length >= 3) {
      const ranked = spans.map(s => s.score).sort((a, b) => b - a);
      minScore = Math.max(1, ranked[Math.min(ranked.length - 1, Math.floor(ranked.length * 0.15))]);
    }
    topGuard = (spans.length ? spans[0].score : 0) * 0.05;
  }
  const pieces: Piece[] = [];
  const seen = new Set<string>();
  let used = 0;
  // ① 点名锚（最高优先，仅新生产）：指令点名词条单独检索并前置（限量 6 条）
  if (!opts?.legacy) {
    namedPassPieces(ctx, 6).forEach(p => {
      const key = norm(p.text).slice(0, 40);
      if (!key || seen.has(key)) return;
      seen.add(key);
      pieces.push(p);
      used += p.text.length;
    });
  }
  // ② 主角名直收
  direct.forEach(d => {
    const text = String(d.text || '');
    if (!text) return;
    const key = norm(text).slice(0, 40);
    if (key && !seen.has(key)) seen.add(key);
    pieces.push({ blockId: d.blockId, text, score: d.score });
    used += text.length;
  });
  for (let si = 0; si < spans.length; si++) {
    const sp = spans[si];
    if (opts?.legacy && !(si < 2 && sp.score >= topGuard) && sp.score < minScore) continue;
    const key = norm(sp.text).slice(0, 40);
    if (!key || seen.has(key)) continue;
    if (pieces.length > 0 && used + sp.text.length > ctx.budget) continue;
    seen.add(key);
    pieces.push(sp);
    used += sp.text.length;
    if (used >= ctx.budget) break;
  }
  return { pieces, ms: Date.now() - t0, query: q, meta: { cands: cands.length, direct: direct.length, spans: spans.length, gTerms: gTerms.length, queryLen: q.length } };
}

/** 消融：同查询构造（含自学习词典），去掉门槛/直收/合并 */
export function runBm25Qb(ctx: Ctx, opts?: { namedFirst?: boolean }): SysResult {
  const t0 = Date.now();
  ArchiveIndex.ensureFresh();
  const dfCap = ArchiveIndex.suggestDfCap();
  const q = MemoryQueryBuilder.build(ctx.band0, {
    getDf: ArchiveIndex.getDf.bind(ArchiveIndex), dfCap,
    dict: ctx.dictUnion.length ? ctx.dictUnion : undefined,
    instruction: ctx.instruction,
    getCount: ArchiveIndex.termCount.bind(ArchiveIndex),
    recentParts: ctx.bands.slice(1),
    n: ArchiveIndex.childCount(),
  });
  const ranked = ArchiveIndex.search(q, 60) as { blockId: string; text: string; score: number }[];
  let pieces = fillByRank(ranked, ctx.budget);
  if (opts?.namedFirst) {
    const named = namedPassPieces(ctx, 6);
    let used = 0;
    const merged: Piece[] = [];
    const seen = new Set<string>();
    for (const p of named.concat(pieces)) {
      const key = norm(p.text).slice(0, 40);
      if (!key || seen.has(key)) continue;
      if (merged.length > 0 && used + p.text.length > ctx.budget) continue;
      seen.add(key);
      merged.push(p);
      used += p.text.length;
      if (used >= ctx.budget) break;
    }
    pieces = merged;
  }
  return { pieces, ms: Date.now() - t0, query: q };
}

/** 消融：纯 bigram BM25（调用方保证此时词典为空），原始窗口（+指令）当查询 */
export function runBm25Raw(ctx: Ctx): SysResult {
  const t0 = Date.now();
  ArchiveIndex.ensureFresh();
  const rawQ = (ctx.instruction ? ctx.instruction + '\n' : '') + ctx.band0;
  const ranked = ArchiveIndex.search(rawQ, 60) as { blockId: string; text: string; score: number }[];
  return { pieces: fillByRank(ranked, ctx.budget), ms: Date.now() - t0, query: rawQ };
}

/** 诊断：查询构造只用指令（不拼窗口）——隔离"窗口稀释"这一因素 */
export function runQbInstOnly(ctx: Ctx, topK = 60): SysResult {
  const t0 = Date.now();
  ArchiveIndex.ensureFresh();
  const q = MemoryQueryBuilder.build('', {
    getDf: ArchiveIndex.getDf.bind(ArchiveIndex), dfCap: ArchiveIndex.suggestDfCap(),
    dict: ctx.dictUnion.length ? ctx.dictUnion : undefined, instruction: ctx.instruction,
    getCount: ArchiveIndex.termCount.bind(ArchiveIndex), recentParts: [], n: ArchiveIndex.childCount(),
  });
  const ranked = ArchiveIndex.search(q, topK) as { blockId: string; text: string; score: number }[];
  return { pieces: fillByRank(ranked, ctx.budget), ms: Date.now() - t0, query: q };
}

/** 参考上界：只用指令文本检索（不拼窗口）——测"点名一个唯一旧专名，索引能不能直接命中" */
export function runBm25InstOnly(ctx: Ctx, topK = 60): SysResult {
  const t0 = Date.now();
  ArchiveIndex.ensureFresh();
  const ranked = ArchiveIndex.search(ctx.instruction, topK) as { blockId: string; text: string; score: number }[];
  return { pieces: fillByRank(ranked, ctx.budget), ms: Date.now() - t0 };
}

export function bm25Ranking(ctx: Ctx, topK = 100): { id: string; blockId: string; text: string; score: number }[] {
  ArchiveIndex.ensureFresh();
  const rawQ = (ctx.instruction ? ctx.instruction + '\n' : '') + ctx.band0;
  return ArchiveIndex.search(rawQ, topK) as never;
}

export function runRandom(ctx: Ctx, children: Child[]): SysResult {
  const t0 = Date.now();
  const rng = mulberry32(ctx.t);
  const pool = children.filter(c => (c.absEnd ?? 0) <= ctx.coveredEnd).map(c => ({ blockId: c.blockId, text: c.text }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  return { pieces: fillByRank(pool, ctx.budget), ms: Date.now() - t0 };
}

/** 酒馆式向量召回：同一批 800 字子块，余弦相似度，默认阈值 0.25（酒馆 score_threshold 默认值） */
export function denseRank(ctx: Ctx, units: { id: string; blockId: string; text: string; absEnd?: number }[], vecs: Map<string, number[]>, qvec: number[], threshold = 0.25): { id: string; blockId: string; text: string; score: number }[] {
  const out: { id: string; blockId: string; text: string; score: number }[] = [];
  for (const u of units) {
    if ((u.absEnd ?? 0) > ctx.coveredEnd) continue;
    const v = vecs.get(u.id);
    if (!v) continue;
    const s = cosine(qvec, v);
    if (s < threshold) continue;
    out.push({ id: u.id, blockId: u.blockId, text: u.text, score: s });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** RRF 融合（k=60，各通道取前 100） */
export function rrfFuse(lists: { id: string; blockId: string; text: string }[][], k = 60): { id: string; blockId: string; text: string; score: number }[] {
  const acc = new Map<string, { blockId: string; text: string; score: number }>();
  lists.forEach(list => {
    list.slice(0, 100).forEach((it, rank) => {
      const cur = acc.get(it.id) || { blockId: it.blockId, text: it.text, score: 0 };
      cur.score += 1 / (k + rank);
      acc.set(it.id, cur);
    });
  });
  return Array.from(acc.entries()).map(([id, v]) => ({ id, blockId: v.blockId, text: v.text, score: v.score }))
    .sort((a, b) => b.score - a.score);
}

/** 酒馆原生分块：2500 字块、无重叠、段落对齐（对应 vector storage 的文件/资料库默认 chunk_size_db=2500） */
export function nativeChunks(block: { id: string; text: string }, size = 2500): { id: string; blockId: string; text: string }[] {
  const out: { id: string; blockId: string; text: string }[] = [];
  let rest = block.text;
  let i = 0;
  while (rest.length > size) {
    let cut = size;
    const nl = rest.indexOf('\n\n', cut);
    if (nl > cut && nl < cut + 600) cut = nl + 2;
    else { const nl2 = rest.lastIndexOf('\n', cut + 600); if (nl2 > 400) cut = nl2; }
    out.push({ id: block.id + '~' + i, blockId: block.id, text: rest.slice(0, cut) });
    rest = rest.slice(cut);
    i++;
  }
  if (rest.length) out.push({ id: block.id + '~' + i, blockId: block.id, text: rest });
  return out;
}

/** 混合 + 重排：对 RRF 前 20 做 rerank（文档截 600 字控制单次调用体积） */
export async function rerankTop(ctx: Ctx, fused: { id: string; blockId: string; text: string; score: number }[], topN = 20): Promise<SysResult> {
  const t0 = Date.now();
  const head = fused.slice(0, topN);
  if (head.length === 0) return { pieces: [], ms: Date.now() - t0 };
  const docs = head.map(h => h.text.slice(0, 600));
  const scores = await rerankScores(ctx.band0.slice(0, 2000), docs);
  const ranked = head.map((h, i) => ({ blockId: h.blockId, text: h.text, score: isNaN(scores[i]) ? -1 : scores[i] }))
    .sort((a, b) => b.score - a.score);
  return { pieces: fillByRank(ranked, ctx.budget), ms: Date.now() - t0 };
}
