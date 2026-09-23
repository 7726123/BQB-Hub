// 回放式检索评测：真实小说语料，时间轴回放，自动 gold，多系统对比。
// 运行：cd app && SILICONFLOW_KEY=... npx vitest run --config tools/retrieval-eval/vitest.config.ts
// 环境变量：EVAL_TXT 语料路径 / EVAL_LIMIT 只跑前 N 个查询点 / EVAL_SKIP_API=1 跳过 API 系统
//          EVAL_BUDGET 注入字符预算（默认 30000）/ EVAL_WARMUP 首个回放点（默认 60000）
//
// 两个场景：
//  A 无指令：只用最近窗口（≈ 用户直接点"续写"，没有额外说明）——考"主动回忆"
//  B 点名回忆：指令里点名了后文会提到的旧专名（≈ 用户说"让她想起关于 X 的往事"）——考"按名检索"
import '../../src/infra/storage'; // 装真实 StorageManager（无 IDB → localStorage 降级）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { ArchiveStore } from '../../src/domain/archive';
import { ArchiveIndex } from '../../src/lib/bm25';
import { loadCanonical, splitBlocksProd, buildLabelIndex, buildPmiStats, extractGold, scorePieces, mean, type Gold, type Piece, type Child } from './lib/core';
import * as S from './lib/systems';
import { embedTexts, flushApiStats } from './lib/api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const BUDGET = Number(process.env.EVAL_BUDGET || 30000);
const LIMIT = Number(process.env.EVAL_LIMIT || 0);
const SKIP_API = process.env.EVAL_SKIP_API === '1';
const WARMUP = Number(process.env.EVAL_WARMUP || 60000);
const STEP = Number(process.env.EVAL_STEP || 4000);
const FUTURE = Number(process.env.EVAL_FUTURE || 3000);
const ROLL_WINDOW = Number(process.env.EVAL_ROLLW || 12000);

interface Res { pieces: Piece[]; ms: number; meta?: Record<string, number | string> }
interface Point {
  t: number;
  band0: string;
  bands: string[];
  recentText: string;
  coveredEnd: number;
  gold: Gold;
  instruction: string;
  res: Record<string, Res>;
  resInst: Record<string, Res>;
  bm25Rank: { id: string; blockId: string; text: string }[];
  bm25RankInst: { id: string; blockId: string; text: string }[];
  denseRank: { id: string; blockId: string; text: string }[];
  denseRankInst: { id: string; blockId: string; text: string }[];
}

function buildPoints(canonical: string): number[] {
  const ts: number[] = [];
  for (let t = WARMUP; t + FUTURE + STEP <= canonical.length; t += STEP) ts.push(t);
  return LIMIT > 0 ? ts.slice(0, LIMIT) : ts;
}

interface Row { 系统: string; 覆盖: number; 词命中: number; 原文段命中: number; 注入精度: number; 段命中提升: number; 精度提升: number; 平均注入字数: number; 平均耗时ms: number }

function agg(points: Point[], key: 'res' | 'resInst'): Row[] {
  const systems = Array.from(new Set(points.flatMap(p => Object.keys(p[key]))));
  return systems.map(s => {
    const term: number[] = [], span: number[] = [], prec: number[] = [], chars: number[] = [], ms: number[] = [], cov: number[] = [];
    for (const p of points) {
      const r = p[key][s];
      if (!r || p.gold.terms.length === 0) continue;
      const sc = scorePieces(r.pieces, p.gold);
      term.push(sc.termRecall); span.push(sc.spanRecall); prec.push(sc.precision);
      chars.push(sc.chars); ms.push(r.ms);
      if (p.coveredEnd > 0) cov.push(sc.chars / p.coveredEnd);
    }
    const c = mean(cov), sp = mean(span), pr = mean(prec);
    return {
      系统: s, 覆盖: c, 词命中: mean(term), 原文段命中: sp, 注入精度: pr,
      段命中提升: c > 0 ? sp / c : NaN, 精度提升: c > 0 ? pr / c : NaN,
      平均注入字数: mean(chars), 平均耗时ms: mean(ms),
    };
  }).sort((a, b) => b.原文段命中 - a.原文段命中);
}

function fmt(rows: Row[]): Record<string, string>[] {
  const pct = (x: number) => (isNaN(x) ? '-' : (x * 100).toFixed(1) + '%');
  return rows.map(r => ({
    系统: r.系统,
    '注入覆盖率': pct(r.覆盖),
    '词命中': pct(r.词命中),
    '原文段命中': pct(r.原文段命中),
    '段命中/覆盖率': isNaN(r.段命中提升) ? '-' : r.段命中提升.toFixed(2) + 'x',
    '注入精度': pct(r.注入精度),
    '精度/覆盖率': isNaN(r.精度提升) ? '-' : r.精度提升.toFixed(2) + 'x',
    '平均注入字数': String(Math.round(r.平均注入字数)),
  }));
}

describe('检索评测：回放', () => {
  it('两个场景 × 多系统对比', async () => {
    console.log('[eval] 语料:', TXT);
    const canonical = loadCanonical(TXT);
    const blocks = splitBlocksProd(canonical);
    const labelIndex = buildLabelIndex(canonical, blocks);
    const ts = buildPoints(canonical);
    const pmi = buildPmiStats(canonical);
    console.log('[eval] 字数', canonical.length, '| 生产块', blocks.length, '| 子块', labelIndex.children.length, '| 查询点', ts.length, '| 预算', BUDGET);

    // 合成"世界书"：用首个查询点之前的正文跑一遍词典学习——模拟作者写到那时已建档的角色/设定名
    const firstCovered = blocks.filter(b => b.end <= Math.max(0, ts[0] - ROLL_WINDOW)).length;
    const learn = (ArchiveStore as unknown as { _learnDictionary: (s: { dict: string[] }, t: string) => boolean })._learnDictionary;
    const learnDict = (upto: number): string[] => {
      const fake = { dict: [] as string[] };
      for (let i = 0; i < upto; i++) learn.call(ArchiveStore, fake, blocks[i].text);
      return fake.dict.slice();
    };
    const wbTerms: string[] = learnDict(firstCovered);
    const bookDict: string[] = learnDict(blocks.length); // 全书词表：仅用于 gold 的专名候选
    console.log('[eval] 合成世界书', wbTerms.length, '条（取前', firstCovered, '块 ≈', firstCovered * 8000, '字）:', wbTerms.slice(0, 16).join('/'));
    console.log('[eval] 全书词表', bookDict.length, '条（gold 专名候选）：', bookDict.slice(0, 16).join('/'));

    const points: Point[] = [];

    // ============ Pass 1：自学习词典开启（mine / bm25_qb / random，A+B 场景） ============
    ArchiveStore.clear();
    ArchiveIndex.invalidate();
    let next = 0;
    for (const t of ts) {
      while (next < blocks.length && blocks[next].end <= Math.max(0, t - ROLL_WINDOW)) {
        ArchiveStore.addBlocks([blocks[next].text], 900);
        next++;
      }
      const coveredEnd = next > 0 ? blocks[next - 1].end : 0;
      const band0 = canonical.slice(Math.max(0, t - 2000), t);
      const bands: string[] = [band0];
      for (let i = 1; i < 6; i++) {
        const end = t - 2000 * i;
        if (end <= 0) break;
        bands.push(canonical.slice(Math.max(0, end - 2000), end));
      }
      const recentText = canonical.slice(Math.max(0, t - 12000), t);
      const gold = extractGold(labelIndex, t, { future: FUTURE, coveredEnd, pmi, entityWords: bookDict });
      const instruction = gold.terms.length
        ? '继续写下去，让角色自然回想起和「' + gold.terms.slice(0, 3).join('」「') + '」有关的往事。'
        : '';
      const dictUnion = wbTerms.concat(ArchiveStore.dictWords()).filter((w, i, a) => a.indexOf(w) === i);
      const ctxA: S.Ctx = { t, band0, bands, recentText, dictUnion, wbTerms, instruction: '', budget: BUDGET, coveredEnd };
      const ctxB: S.Ctx = { t, band0, bands, recentText, dictUnion, wbTerms, instruction, budget: BUDGET, coveredEnd };
      const mine = S.runMine(ctxA);
      const mineOld = S.runMine(ctxA, { legacy: true });
      const qb = S.runBm25Qb(ctxA);
      const rnd = S.runRandom(ctxA, labelIndex.children as Child[]);
      const mineI = instruction ? S.runMine(ctxB) : null;
      const mineIOld = instruction ? S.runMine(ctxB, { legacy: true }) : null;
      const qbI = instruction ? S.runBm25Qb(ctxB) : null;
      points.push({
        t, band0, bands, recentText, coveredEnd, gold, instruction,
        res: { mine: { pieces: mine.pieces, ms: mine.ms, meta: mine.meta }, mine_old: { pieces: mineOld.pieces, ms: mineOld.ms }, bm25_qb: { pieces: qb.pieces, ms: qb.ms }, random: { pieces: rnd.pieces, ms: rnd.ms } },
        resInst: mineI && qbI && mineIOld ? { mine: { pieces: mineI.pieces, ms: mineI.ms, meta: mineI.meta }, mine_old: { pieces: mineIOld.pieces, ms: mineIOld.ms }, bm25_qb: { pieces: qbI.pieces, ms: qbI.ms } } : {},
        bm25Rank: [], bm25RankInst: [], denseRank: [], denseRankInst: [],
      });
      if (points.length % 10 === 0) console.log('[eval] pass1', points.length, '/', ts.length, '| 归档块', next, '| 词典', ArchiveStore.dictWords().length);
    }

    // ============ Pass 2：词典自学关闭（bm25_raw + 混合用的 BM25 排名，A+B） ============
    const origLearn = (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary;
    (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = function () { return false; };
    ArchiveStore.clear();
    ArchiveIndex.invalidate();
    next = 0;
    const idMap = new Map<string, number>();
    const toUnitId = (id: string): string => {
      const parts = id.split('#');
      const bi = idMap.get(parts[0]);
      return bi === undefined ? id : 'B' + bi + '#' + parts[1];
    };
    for (let pi = 0; pi < points.length; pi++) {
      const p = points[pi];
      while (next < blocks.length && blocks[next].end <= Math.max(0, p.t - ROLL_WINDOW)) {
        ArchiveStore.addBlocks([blocks[next].text], 900);
        const st = ArchiveStore.get();
        idMap.set(st.blocks[st.blocks.length - 1].id, next);
        next++;
      }
      const base: Omit<S.Ctx, 'instruction'> = { t: p.t, band0: p.band0, bands: p.bands, recentText: p.recentText, dictUnion: [], wbTerms: [], budget: BUDGET, coveredEnd: p.coveredEnd };
      const raw = S.runBm25Raw({ ...base, instruction: '' });
      p.res.bm25_raw = { pieces: raw.pieces, ms: raw.ms };
      p.bm25Rank = S.bm25Ranking({ ...base, instruction: '' }, 100).map(r => ({ id: toUnitId(r.id), blockId: r.blockId, text: r.text }));
      if (p.instruction) {
        const rawI = S.runBm25Raw({ ...base, instruction: p.instruction });
        p.resInst.bm25_raw = { pieces: rawI.pieces, ms: rawI.ms };
        p.bm25RankInst = S.bm25Ranking({ ...base, instruction: p.instruction }, 100).map(r => ({ id: toUnitId(r.id), blockId: r.blockId, text: r.text }));
      }
      if ((pi + 1) % 20 === 0) console.log('[eval] pass2', pi + 1, '/', points.length);
    }
    (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = origLearn;
    ArchiveIndex.invalidate();

    // ============ Pass 3/4：向量系统（API） ============
    if (!SKIP_API) {
      const units = labelIndex.children.map(c => ({ id: c.id, blockId: c.blockId, text: c.text, absEnd: c.absEnd }));
      const nativeUnits: { id: string; blockId: string; text: string; absEnd: number }[] = [];
      blocks.forEach(b => {
        let off = b.start;
        S.nativeChunks(b).forEach(c => { nativeUnits.push({ id: c.id, blockId: c.blockId, text: c.text, absEnd: off + c.text.length }); off += c.text.length; });
      });
      console.log('[eval] 向量单元：子块', units.length, '| 酒馆原生块', nativeUnits.length);
      const unitVecs = await embedTexts(units.map(u => u.text));
      const nativeVecs = await embedTexts(nativeUnits.map(u => u.text));
      const qVecs = await embedTexts(points.map(p => p.band0));
      const qVecsInst = await embedTexts(points.map(p => p.instruction ? p.instruction + '\n' + p.band0 : p.band0));
      const uvMap = new Map<string, number[]>();
      units.forEach((u, i) => uvMap.set(u.id, unitVecs[i]));
      const nvMap = new Map<string, number[]>();
      nativeUnits.forEach((u, i) => nvMap.set(u.id, nativeVecs[i]));
      const mkCtx = (p: Point, instruction: string): S.Ctx => ({ t: p.t, band0: p.band0, bands: p.bands, recentText: p.recentText, dictUnion: [], wbTerms: [], instruction, budget: BUDGET, coveredEnd: p.coveredEnd });
      for (let pi = 0; pi < points.length; pi++) {
        const p = points[pi];
        const ctxA = mkCtx(p, '');
        const dRank = S.denseRank(ctxA, units, uvMap, qVecs[pi]);
        p.denseRank = dRank.map(r => ({ id: r.id, blockId: r.blockId, text: r.text }));
        p.res.dense = { pieces: S.fillByRank(dRank, BUDGET), ms: 0 };
        p.res.dense_native = { pieces: S.fillByRank(S.denseRank(ctxA, nativeUnits, nvMap, qVecs[pi]), BUDGET), ms: 0 };
        const fused = S.rrfFuse([p.bm25Rank, dRank]);
        p.res.hybrid_rrf = { pieces: S.fillByRank(fused, BUDGET), ms: 0 };
        p.res.rr_rerank = { pieces: (await S.rerankTop(ctxA, fused, 40)).pieces, ms: 0 };
        if (p.instruction) {
          const ctxB = mkCtx(p, p.instruction);
          const dRankI = S.denseRank(ctxB, units, uvMap, qVecsInst[pi]);
          p.denseRankInst = dRankI.map(r => ({ id: r.id, blockId: r.blockId, text: r.text }));
          p.resInst.dense = { pieces: S.fillByRank(dRankI, BUDGET), ms: 0 };
          const fusedI = S.rrfFuse([p.bm25RankInst, dRankI]);
          p.resInst.hybrid_rrf = { pieces: S.fillByRank(fusedI, BUDGET), ms: 0 };
          p.resInst.rr_rerank = { pieces: (await S.rerankTop(ctxB, fusedI, 40)).pieces, ms: 0 };
        }
        if ((pi + 1) % 10 === 0) console.log('[eval] pass3', pi + 1, '/', points.length);
      }
      flushApiStats('eval');
    } else {
      console.log('[eval] EVAL_SKIP_API=1：跳过向量/混合/重排系统');
    }

    // ============ 汇总 ============
    const rowsA = agg(points, 'res');
    const rowsB = agg(points, 'resInst');
    const tableA = fmt(rowsA);
    const tableB = fmt(rowsB);
    console.log('\n===== 场景 A：无指令（主动回忆） | ' + path.basename(TXT) + '，' + points.length + ' 点，预算 ' + BUDGET + ' 字 =====');
    console.table(tableA);
    console.log('\n===== 场景 B：点名回忆（指令点名旧专名） =====');
    console.table(tableB);

    const outDir = path.join(HERE, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const withGold = points.filter(p => p.gold.terms.length > 0).length;
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({
      corpus: TXT, chars: canonical.length, blocks: blocks.length, children: labelIndex.children.length,
      points: points.length, pointsWithGold: withGold, budget: BUDGET, warmup: WARMUP, step: STEP, future: FUTURE, rollWindow: ROLL_WINDOW,
      worldbookTerms: wbTerms,
      tableA, tableB, rawA: rowsA, rawB: rowsB,
      perPoint: points.map(p => ({
        t: p.t, coveredEnd: p.coveredEnd, goldTerms: p.gold.terms, instruction: p.instruction,
        A: Object.fromEntries(Object.entries(p.res).map(([k, v]) => { const sc = scorePieces(v.pieces, p.gold); return [k, { ...sc, sm: sc.spanMask.join(''), tm: sc.termMask.join(''), chars: v.pieces.reduce((n, x) => n + x.text.length, 0), ms: v.ms, meta: v.meta, heads: v.pieces.slice(0, 2).map(x => x.text.slice(0, 40)) }]; })),
        B: Object.fromEntries(Object.entries(p.resInst).map(([k, v]) => { const sc = scorePieces(v.pieces, p.gold); return [k, { ...sc, sm: sc.spanMask.join(''), tm: sc.termMask.join(''), chars: v.pieces.reduce((n, x) => n + x.text.length, 0), ms: v.ms, meta: v.meta, heads: v.pieces.slice(0, 2).map(x => x.text.slice(0, 40)) }]; })),
      })),
    }, null, 1));
    console.log('[eval] 报告写入', path.join(outDir, 'report.json'), '| 有点位 gold 的查询点', withGold, '/', points.length);
  });
});
