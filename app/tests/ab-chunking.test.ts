// A/B：整块索引（旧版生产行为：top4 块 × 块首截 1500 字）vs 子块索引+相邻合并+预算填充（新版）。
// 语料：版权文本不进 git，默认读本机 Downloads 的 GBK 扫描版，BQB_GOLD_TXT 可覆盖；
// 文件不存在时真语料组跳过（合成冒烟组始终运行，只验证机制）。
import fs from 'node:fs';
import { describe, it, expect } from 'vitest';
import { ArchiveIndex, MemoryQueryBuilder, BM25, BM25Stopwords } from '../src/lib/bm25';

const TXT = process.env.BQB_GOLD_TXT
  ?? 'C:/Users/a7726/Downloads/不起眼女主角培育法(路人女主的养成方法) 第一卷 gbk.txt';
const corpusAvailable = fs.existsSync(TXT);

const store = { blocks: [] as { id: string; text: string }[], dict: [] as string[], dictVer: 1 };
(globalThis as unknown as Record<string, unknown>).ArchiveStore = { get: () => store };

// 生产版切块（archive.ts Waterline._splitBlocks 复刻：8000 字 + 段落边界）
function splitBlocksProd(canonical: string): { id: string; text: string }[] {
  const out: string[] = [];
  let rest = canonical;
  while (rest.length > 8000) {
    let cut = 8000;
    const nl = rest.indexOf('\n\n', cut);
    if (nl > cut && nl < cut + 600) cut = nl + 2;
    else { const nl2 = rest.lastIndexOf('\n', cut + 600); if (nl2 > 400) cut = nl2; }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length) out.push(rest);
  return out.map((t, i) => ({ id: 'B' + i, text: t }));
}

function loadCanonical(): string {
  const raw = new TextDecoder('gbk').decode(fs.readFileSync(TXT));
  return raw
    .replace(/轻小说文库[^\n]*/g, '')
    .replace(/WenKu8[^\n]*/g, '')
    .replace(/(台版|图源|录入|初校|修图)[^\n]*/g, '')
    .replace(/^\s*★.*$/gm, '');
}

interface Query { q: string; goldBlockId: string; goldStart: number; goldEnd: number }

function snapshotChildren(): { id: string; blockId: string; start: number; end: number; text: string }[] {
  return (ArchiveIndex as unknown as { _children: { id: string; blockId: string; start: number; end: number; text: string }[] })
    ._children.map(function (c) { return { id: c.id, blockId: c.blockId, start: c.start, end: c.end, text: c.text }; });
}

// 查询构造：子块里挑 df∈[2,cap] 的判别 bigram，查询 = ±30 字窗口——
// 模拟「最近正文提及旧情节」：查询与旧文共享判别词，gold = 该子块本身
function buildQueries(getDf: (t: string) => number, dfCap: number, maxQ = 60): Query[] {
  const children = snapshotChildren();
  const qs: Query[] = [];
  const seen = new Set<string>();
  for (let i = 8; i < children.length && qs.length < maxQ; i += 2) {
    const c = children[i];
    const toks = BM25.tokenize(c.text).filter(function (t) { return t.length === 2 && !BM25Stopwords.has(t); });
    const rare = toks.filter(function (t) { const d = getDf(t); return d >= 2 && d <= dfCap; });
    if (rare.length === 0) continue;
    const bg = rare[0];
    const at = c.text.indexOf(bg);
    if (at < 0) continue;
    const s = Math.max(0, at - 30), e = Math.min(c.text.length, at + bg.length + 30);
    const q = c.text.slice(s, e);
    if (q.trim().length < 10 || seen.has(q)) continue;
    seen.add(q);
    qs.push({ q: q, goldBlockId: c.blockId, goldStart: c.start, goldEnd: c.end });
  }
  return qs;
}

// 交叉引用查询：窗口取自子块 X，gold = 另一个含同一判别词的子块 Y（≠X，优先更早的）——
// 模拟真实场景「现在的正文提到某事 → 应召回过去那段旧文」，考验的是发现能力而非自检索
function buildXrefQueries(getDf: (t: string) => number, dfCap: number, maxQ = 60): Query[] {
  const children = snapshotChildren();
  const byTok: Record<string, number[]> = {};
  children.forEach(function (c, ci) {
    BM25.tokenize(c.text).forEach(function (t) {
      if (t.length !== 2 || BM25Stopwords.has(t)) return;
      (byTok[t] = byTok[t] || []).push(ci);
    });
  });
  const qs: Query[] = [];
  const seen = new Set<string>();
  for (let i = 10; i < children.length && qs.length < maxQ; i += 2) {
    const c = children[i];
    const toks = BM25.tokenize(c.text).filter(function (t) { return t.length === 2 && !BM25Stopwords.has(t); });
    const rare = toks.filter(function (t) { const d = getDf(t); return d >= 2 && d <= dfCap; });
    for (const bg of rare) {
      const others = (byTok[bg] || []).filter(function (ci) { return ci !== i; });
      if (others.length === 0) continue;
      const g = children[others[0]];
      const at = c.text.indexOf(bg);
      const s = Math.max(0, at - 30), e = Math.min(c.text.length, at + bg.length + 30);
      const q = c.text.slice(s, e);
      if (q.trim().length < 10 || seen.has(q)) continue;
      seen.add(q);
      qs.push({ q: q, goldBlockId: g.blockId, goldStart: g.start, goldEnd: g.end });
      break;
    }
  }
  return qs;
}

// 强相关门槛（复刻生产逻辑：查询罕见词 <2 个时不设门槛）
function gate(cands: { id: string; text: string; score: number }[], q: string, dfCap: number) {
  const gTerms = MemoryQueryBuilder.rareBigrams(q, ArchiveIndex.getDf.bind(ArchiveIndex), 12, dfCap);
  if (gTerms.length < 2) return cands;
  return cands.filter(function (c) { return MemoryQueryBuilder.countTermHits(c.text, gTerms) >= 2; });
}

// 旧管线：整块索引（childSize=∞）→ search(6) → gate(dfCap=12) → top4 → 块首截 1500
function runOld(queries: Query[]) {
  ArchiveIndex.configure({ childSize: 1e9 });
  ArchiveIndex.invalidate();
  ArchiveIndex.ensureFresh();
  return queries.map(function (q) {
    let cands = ArchiveIndex.search(q.q, 6) as unknown as { id: string; text: string; score: number }[];
    cands = gate(cands, q.q, 12);
    cands.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    let chars = 0, hit = false;
    cands.slice(0, 4).forEach(function (p) {
      chars += Math.min(1500, p.text.length);
      // 块首截断：注入 [0,1500)，gold 段在块内 [goldStart, goldEnd) —— 起点越界即丢失
      if (p.id.split('#')[0] === q.goldBlockId && q.goldStart < 1500) hit = true;
    });
    return { hit: hit, chars: chars };
  });
}

// 新管线：子块索引（800）→ search(24) → gate(dfCap=suggest) → mergeSpans → 预算填充
function runNew(queries: Query[], budget: number) {
  ArchiveIndex.configure({ childSize: 800 });
  ArchiveIndex.invalidate();
  ArchiveIndex.ensureFresh();
  const dfCap = ArchiveIndex.suggestDfCap();
  return queries.map(function (q) {
    let cands = ArchiveIndex.search(q.q, 24) as unknown as { id: string; text: string; score: number }[];
    cands = gate(cands, q.q, dfCap);
    const spans = ArchiveIndex.mergeSpans(cands);
    spans.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    let chars = 0, hit = false, first = true;
    spans.forEach(function (sp) {
      if (first || chars + sp.chars <= budget) {
        first = false;
        chars += sp.chars;
        if (sp.blockId === q.goldBlockId && sp.start < q.goldEnd && sp.end > q.goldStart) hit = true;
      }
    });
    return { hit: hit, chars: chars };
  });
}

function summarize(rows: { hit: boolean; chars: number }[]): { rate: number; avgChars: number } {
  const hits = rows.filter(function (r) { return r.hit; }).length;
  return { rate: rows.length ? hits / rows.length : 0, avgChars: rows.length ? rows.reduce(function (s, r) { return s + r.chars; }, 0) / rows.length : 0 };
}

describe('A/B：整块 vs 子块 归档回读检索（真语料）', () => {
  const maybe = corpusAvailable ? it : it.skip;
  maybe('hit@预算 + 注入量对比', () => {
    store.blocks = splitBlocksProd(loadCanonical());
    store.dict = [];
    store.dictVer++;
    ArchiveIndex.configure({ childSize: 800 });
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    const queries = buildQueries(ArchiveIndex.getDf.bind(ArchiveIndex), ArchiveIndex.suggestDfCap());
    expect(queries.length).toBeGreaterThan(20);
    const xrefQueries = buildXrefQueries(ArchiveIndex.getDf.bind(ArchiveIndex), ArchiveIndex.suggestDfCap());
    expect(xrefQueries.length).toBeGreaterThan(20);

    const rows: Record<string, string | number>[] = [];
    const oldSum = summarize(runOld(queries));
    rows.push({
      场景: '自检索', 模式: '旧·整块 top4×块首1500', 预算: '≤6000',
      命中率: (oldSum.rate * 100).toFixed(1) + '%', 平均注入: Math.round(oldSum.avgChars) + '字'
    });
    [2000, 6000, 32000].forEach(function (b) {
      const r = summarize(runNew(queries, b));
      rows.push({
        场景: '自检索', 模式: '新·子块+合并', 预算: b,
        命中率: (r.rate * 100).toFixed(1) + '%', 平均注入: Math.round(r.avgChars) + '字'
      });
    });
    const oldX = summarize(runOld(xrefQueries));
    rows.push({
      场景: '交叉引用', 模式: '旧·整块 top4×块首1500', 预算: '≤6000',
      命中率: (oldX.rate * 100).toFixed(1) + '%', 平均注入: Math.round(oldX.avgChars) + '字'
    });
    [2000, 6000, 32000].forEach(function (b) {
      const r = summarize(runNew(xrefQueries, b));
      rows.push({
        场景: '交叉引用', 模式: '新·子块+合并', 预算: b,
        命中率: (r.rate * 100).toFixed(1) + '%', 平均注入: Math.round(r.avgChars) + '字'
      });
    });
    console.log('\n===== A/B 归档回读检索对比 =====');
    console.log('生产块数:', store.blocks.length, '｜自检索查询:', queries.length, '｜交叉引用查询:', xrefQueries.length, '｜语料:', TXT);
    console.table(rows);
  }, 300000);
});

describe('A/B 合成语料冒烟（机制验证）', () => {
  it('两管线均可运行，新管线预算被尊重', () => {
    // 合成：2400 段 × ~30 字（~70k 字 → ~9 生产块），600 个话题词控制 df 分布
    const names = ['雪乃', '拓海', '英梨', '纱雾'];
    const T = function (i: number): string {
      return String.fromCharCode(0x4e00 + (i % 200)) + String.fromCharCode(0x4e80 + ((i * 13) % 200));
    };
    const paras: string[] = [];
    for (let p = 0; p < 2400; p++) {
      const who = names[p % names.length];
      paras.push(who + '提起' + T((p * 5) % 600) + '与' + T((p * 3 + 11) % 600) + '，' + who + '想了想没有说话。');
    }
    store.blocks = splitBlocksProd(paras.join('\n'));
    store.dict = names;
    store.dictVer++;
    ArchiveIndex.configure({ childSize: 800 });
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    expect(ArchiveIndex.childCount()).toBeGreaterThan(30);
    const queries = buildQueries(ArchiveIndex.getDf.bind(ArchiveIndex), ArchiveIndex.suggestDfCap(), 30);
    expect(queries.length).toBeGreaterThan(5);
    const oldRows = runOld(queries);
    const newRows = runNew(queries, 2000);
    expect(oldRows.length).toBe(queries.length);
    // 预算约束：注入 ≤ 预算 + 首片段上限（首片段允许超，最多 ~2-3 个子块合并）
    newRows.forEach(function (r) { expect(r.chars).toBeLessThanOrEqual(2000 + 2400); });
  });
});
