// 真实写法题集的"题目构造"（提取自 realinstr.test.ts，供生成器与评测共用，保证两侧选题完全一致）。
import { ArchiveStore } from '../../../src/domain/archive';
import { BM25 } from '../../../src/lib/bm25';
import { buildPmiStats, pmiOf, type LabelIndex } from './core';

export interface RealQ {
  t: number; entity: string; anchor: string; df: number; tmpl: string; implicit: boolean;
  instruction: string; goldChildIdx: number; goldChildId: string; goldIds: string[]; goldChildText: string;
}

/** 全书词表（专名候选源）：把语料按块喂给生产同款词典学习器 */
export function bookDictOf(blocks: { text: string }[]): string[] {
  const learn = (ArchiveStore as unknown as { _learnDictionary: (s: { dict: string[] }, t: string) => boolean })._learnDictionary;
  const fake = { dict: [] as string[] };
  for (const b of blocks) learn.call(ArchiveStore, fake, b.text);
  return fake.dict.slice();
}

export interface QOpts { budget: number; gap: number; minArchive: number; n: number; maxPerChild?: number; rollWindow?: number }

/** 构造题集：候选 = 词典专名 ∪ PMI 成词的稀有 2 字词；要求已掉出最近窗口、首次出现够早、归档 ≥3× 预算；
 *  沿时间轴均匀取样 n 道；金标 = 首现子块（严格）+ 所有提及子块（提及口径）。 */
export function buildRealQuestions(canonical: string, labelIndex: LabelIndex, bookDict: string[], opts: QOpts): RealQ[] {
  const rollWindow = opts.rollWindow ?? 12000;
  const maxPerChild = opts.maxPerChild ?? 2;
  const childDf = new Map<string, number>();
  labelIndex.tokenSets.forEach(set => set.forEach(t => childDf.set(t, (childDf.get(t) || 0) + 1)));
  const childOf = (pos: number) => labelIndex.children.findIndex(c => (c.absStart ?? 0) <= pos && pos < (c.absEnd ?? 0));
  const pmi = buildPmiStats(canonical);

  const pool = new Set<string>();
  for (const w of bookDict) if (w && w.length >= 2) pool.add(w);
  for (const t of Array.from(childDf.keys())) {
    if (t.length !== 2) continue;
    const df = childDf.get(t) || 0;
    if (df < 1 || df > 8) continue;
    if ((pmi.count.get(t) || 0) < 3) continue;
    if (pmiOf(pmi, t) < 10) continue;
    pool.add(t);
  }

  const perChild = new Map<number, number>();
  const qs: RealQ[] = [];
  for (const w of pool) {
    const df = childDf.get(w) || 0;
    if (df < 1 || df > 8) continue;
    const pos0 = canonical.indexOf(w);
    if (pos0 < 0) continue;
    const ci = childOf(pos0);
    if (ci < 0) continue;
    const t = (labelIndex.children[ci].absEnd ?? 0) + opts.gap;
    if (t + 5000 > canonical.length) continue;
    if (t - rollWindow < Math.max(opts.minArchive, 3 * opts.budget)) continue;  // 归档至少是预算 3 倍
    const recent = canonical.slice(Math.max(0, t - 2000), t);
    if (recent.indexOf(w) >= 0) continue;              // 必须已掉出当前上下文
    let anchor = '';
    const seen = new Set<string>();
    const cands: { w: string; df: number }[] = [];
    BM25.tokenize(recent.replace(/「[^」]*」/g, ' ')).forEach(tok => {
      if (tok.length !== 2 || seen.has(tok) || tok === w) return;
      seen.add(tok);
      const d = childDf.get(tok) || 0;
      if (d < 1 || d > 8) return;
      if ((pmi.count.get(tok) || 0) < 3 || pmiOf(pmi, tok) < 10) return;
      cands.push({ w: tok, df: d });
    });
    cands.sort((a, b) => a.df - b.df);
    if (cands.length) anchor = cands[0].w;
    else { for (const tk of BM25.tokenize(recent)) { if (tk.length >= 2 && tk !== w) { anchor = tk; break; } } }
    if (!anchor) continue;
    const n = perChild.get(ci) || 0;
    if (n >= maxPerChild) continue;
    perChild.set(ci, n + 1);
    qs.push({
      t, entity: w, anchor, df, tmpl: '', implicit: false, instruction: '',
      goldChildIdx: ci, goldChildId: labelIndex.children[ci].id,
      goldIds: labelIndex.children.filter(c => c.text.indexOf(w) >= 0).map(c => c.id),
      goldChildText: labelIndex.children[ci].text,
    });
  }
  qs.sort((a, b) => a.t - b.t);
  const step = Math.max(1, Math.floor(qs.length / opts.n));
  const out: RealQ[] = [];
  for (let i = 0; i < qs.length && out.length < opts.n; i += step) out.push(qs[i]);
  return out;
}
