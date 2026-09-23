// 评测核心：语料加载、生产式分块（Waterline 复刻）、子块、标签（gold）、指标。
import fs from 'node:fs';
import { ArchiveIndex, BM25, BM25Stopwords, BM25_FN_CHARS } from '../../../src/lib/bm25';
import { Waterline } from '../../../src/domain/archive';

export interface Block { id: string; text: string; start: number; end: number }
export interface Child { id: string; blockId: string; cIdx: number; start: number; end: number; text: string; absStart?: number; absEnd?: number }

export function loadCanonical(p: string): string {
  const buf = fs.readFileSync(p);
  let raw: string;
  try {
    // 先按严格 UTF-8 解；失败即判为 GBK（台版轻小说 txt 常见）
    raw = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    raw = new TextDecoder('gbk').decode(buf);
  }
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/\u3000/g, ' ')
    // 轻小说站点样板行（与 ab-chunking 同款剥离，避免污染词典/题集）
    .replace(/轻小说文库[^\n]*/g, '')
    .replace(/WenKu8[^\n]*/g, '')
    .replace(/(台版|图源|录入|初校|修图)[^\n]*/g, '')
    .replace(/^\s*★.*$/gm, '');
}

/** 生产分块：直接调 Waterline._splitBlocks（8000 字 + 段落对齐），转成带绝对偏移的块 */
export function splitBlocksProd(canonical: string): Block[] {
  const texts = (Waterline as unknown as { _splitBlocks(c: string, f: number, t: number): string[] })
    ._splitBlocks.call(Waterline, canonical, 0, canonical.length);
  const out: Block[] = [];
  let off = 0;
  for (const t of texts) { out.push({ id: 'B' + out.length, text: t, start: off, end: off + t.length }); off += t.length; }
  return out;
}

/** 块 → 子块：调 ArchiveIndex._splitChildren（~800 字，段落边界，尾碎块并入前块） */
export function childrenOfBlock(b: Block): Child[] {
  const idx = ArchiveIndex as unknown as { _splitChildren(b: { id: string; text: string }): Child[] };
  return idx._splitChildren.call(ArchiveIndex, { id: b.id, text: b.text });
}

export interface LabelIndex {
  children: Child[];
  tokenSets: Set<string>[];
  df: Map<string, number>;
  canonical: string;
  n: number;
}

export function buildLabelIndex(canonical: string, blocks: Block[]): LabelIndex {
  const children: Child[] = [];
  blocks.forEach(b => childrenOfBlock(b).forEach(c => children.push({ ...c, absStart: b.start + c.start, absEnd: b.start + c.end })));
  const tokenSets = children.map(c => new Set(BM25.tokenize(c.text)));
  const df = new Map<string, number>();
  tokenSets.forEach(set => set.forEach(t => df.set(t, (df.get(t) || 0) + 1)));
  return { children, tokenSets, df, canonical, n: children.length };
}

export interface Gold { terms: string[]; spans: string[] }

// PMI（成词凝聚度）统计：全库 bigram / 单字频次。用于把「于新/伙忘」这类跨词碎片挡在 gold 之外——
// 实测真词 PMI ≈ 10.6~16.4，碎片远低于此。纯本地统计，不依赖被测系统的词典。
export interface PmiStats { count: Map<string, number>; charCount: Map<string, number>; total: number; cjkTotal: number }

export function buildPmiStats(canonical: string): PmiStats {
  const cn = canonical.replace(/[^\u4e00-\u9fff]/g, '');
  const count = new Map<string, number>();
  const charCount = new Map<string, number>();
  for (let i = 0; i + 1 < cn.length; i++) { const b = cn.slice(i, i + 2); count.set(b, (count.get(b) || 0) + 1); }
  for (let i = 0; i < cn.length; i++) { const c = cn[i]; charCount.set(c, (charCount.get(c) || 0) + 1); }
  return { count, charCount, total: Math.max(1, cn.length - 1), cjkTotal: Math.max(1, cn.length) };
}

export function pmiOf(s: PmiStats, term: string): number {
  const pab = (s.count.get(term) || 0) / s.total;
  if (!pab) return -Infinity;
  const pa = (s.charCount.get(term[0]) || 0) / s.cjkTotal;
  const pb = (s.charCount.get(term[1]) || 0) / s.cjkTotal;
  if (!pa || !pb) return -Infinity;
  return Math.log2(pab / (pa * pb));
}

/** 自动 gold：从 t 之后的真实续写里抽「早已掉出窗口的旧专名」——
 *  候选 = entityWords（全书学出的专名词表：人名/社团/道具）中出现在后文里的词；
 *  条件：a) 后文出现；b) t 前 windowBack 字内未出现（不是还挂在上下文里的词）；
 *  c) 首次出现早于 t-minAge；d) 归档区内稀有（df ≤ maxDf）；
 *  e) 2 字词额外要求 PMI ≥ pmiMin 成词（挡掉「于新」类碎片）。
 *  标注侧不跑被测系统的检索管线，只用词表 + 裸统计。 */
export function extractGold(idx: LabelIndex, t: number, opts: { pmi: PmiStats; entityWords: string[]; pmiMin?: number; future?: number; minAge?: number; windowBack?: number; coveredEnd: number; maxTerms?: number; maxDf?: number }): Gold {
  const future = opts.future ?? 3000;
  const minAge = opts.minAge ?? 15000;
  const windowBack = opts.windowBack ?? 12000;
  const maxTerms = opts.maxTerms ?? 6;
  const maxDf = opts.maxDf ?? 6;
  const pmiMin = opts.pmiMin ?? 10;
  const coveredEnd = opts.coveredEnd;
  const F = idx.canonical.slice(t, t + future);
  const recent = idx.canonical.slice(Math.max(0, t - windowBack), t);
  const archiveN = idx.children.filter(c => (c.absEnd ?? 0) <= coveredEnd).length;
  if (archiveN === 0) return { terms: [], spans: [] };
  const cand: string[] = [];
  for (const w of opts.entityWords) {
    if (!w || w.length < 2 || F.indexOf(w) < 0) continue;
    if (recent.indexOf(w) >= 0) continue;
    const first = idx.canonical.indexOf(w);
    if (first < 0 || first >= t - minAge) continue;
    if (w.length === 2 && pmiOf(opts.pmi, w) < pmiMin) continue;
    cand.push(w);
  }
  const scored = cand.map(term => {
    let df = 0;
    for (let i = 0; i < idx.children.length; i++) {
      const ch = idx.children[i];
      if ((ch.absEnd ?? 0) > coveredEnd) continue;
      if (ch.text.indexOf(term) >= 0) df++;
    }
    return { term, df };
  }).filter(c => c.df >= 1 && c.df <= maxDf);
  scored.sort((a, b) => a.df - b.df || b.term.length - a.term.length);
  const terms = scored.slice(0, maxTerms).map(c => c.term);
  // 原文段 gold = 首次出现所在子块的整段文本（子块对齐：注入侧按子块/合并片段取文，逐字可比对）
  const spans = terms.map(term => {
    const pos = idx.canonical.indexOf(term);
    const ch = idx.children.find(c => (c.absStart ?? 0) <= pos && pos < (c.absEnd ?? 0));
    return ch ? ch.text : idx.canonical.slice(Math.max(0, pos - 150), pos + term.length + 150);
  });
  return { terms, spans };
}

export interface Piece { blockId: string; text: string; score?: number }

export interface Score {
  termRecall: number; spanRecall: number; precision: number; chars: number; allHit: number;
  /** 逐词命中掩码（0/1，与 gold.terms 同序）：供配对显著性检验用 */
  termMask: number[]; spanMask: number[];
}

export const BM25StopwordsX = BM25Stopwords;
export const BM25_FN_CHARSX = BM25_FN_CHARS;

export const norm = (s: string) => s.replace(/\s+/g, '');

export function scorePieces(pieces: Piece[], gold: Gold): Score {
  const inj = pieces.map(p => String(p.text || '')).join('\n');
  const injN = norm(inj);
  const chars = inj.length;
  const termHits = gold.terms.filter(t => inj.includes(t)).length;
  const spanHits = gold.spans.filter(s => injN.includes(norm(s))).length;
  const relChars = pieces.reduce((n, p) => n + (gold.terms.some(t => String(p.text || '').includes(t)) ? String(p.text || '').length : 0), 0);
  return {
    termRecall: gold.terms.length ? termHits / gold.terms.length : NaN,
    spanRecall: gold.spans.length ? spanHits / gold.spans.length : NaN,
    precision: chars ? relChars / chars : NaN,
    chars,
    allHit: gold.terms.length && termHits === gold.terms.length ? 1 : 0,
    termMask: gold.terms.map(t => (inj.includes(t) ? 1 : 0)),
    spanMask: gold.spans.map(s2 => (injN.includes(norm(s2)) ? 1 : 0)),
  };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function mean(xs: number[]): number {
  const v = xs.filter(x => !isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN;
}
