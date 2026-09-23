// 显式记忆题集：从书里挑「全书只出现一次」的专名，在它出现 GAP 字之后再问
// 「继续写，让角色回想起关于 X 的往事」——金标 = 该专名唯一所在的子块（唯一、可精确判定）。
// 随机基线期望命中率 ≈ 覆盖率（≈20%），能命中的系统应接近 100%：这是区分"能不能做"的测试，
// 而不是"排序好坏"的测试。
//
// 运行：cd app && SILICONFLOW_KEY=... npx vitest run --config tools/retrieval-eval/vitest.config.ts memtest
// 环境变量：EVAL_TXT 语料 / EVAL_LIMIT 题数上限 / EVAL_SKIP_API=1 跳过向量系统
import '../../src/infra/storage';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { ArchiveStore } from '../../src/domain/archive';
import { ArchiveIndex, MemoryQueryBuilder } from '../../src/lib/bm25';
import { loadCanonical, splitBlocksProd, buildLabelIndex, buildPmiStats, pmiOf, BM25StopwordsX, BM25_FN_CHARSX, norm, type Child, type Piece } from './lib/core';
import * as S from './lib/systems';
import { embedTexts, flushApiStats } from './lib/api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const BUDGET = Number(process.env.EVAL_BUDGET || 30000);
const LIMIT = Number(process.env.EVAL_LIMIT || 0);
const SKIP_API = process.env.EVAL_SKIP_API === '1';
// GAP 必须 > 滚窗(12000)+块上限(~8800)，否则子块所在块还没滚入归档、金标取不到
const GAP = Number(process.env.EVAL_GAP || 22000);
const ROLL_WINDOW = 12000;
const MAX_PER_CHILD = 2;

const frame = (e: string) => '继续写下去，让角色自然回想起关于' + e + '的往事。';
// 带引号变体：诊断用——查询构造会剥掉「」内的文本（防对话套语），点名会被丢掉
const frameQ = (e: string) => '继续写下去，让角色自然回想起关于「' + e + '」的往事。';
const MIN_ARCHIVE = Number(process.env.EVAL_MIN_ARCHIVE || 60000); // 归档规模下限（否则预算>=归档，题就没意义）

interface Q { t: number; entity: string; childIdx: number; goldText: string; instruction: string; instructionQ: string }

function evaluate(pieces: Piece[], q: Q): { strict: number; loose: number; chars: number } {
  const inj = pieces.map(p => String(p.text || '')).join('\n');
  const injN = norm(inj);
  return {
    strict: injN.includes(norm(q.goldText)) ? 1 : 0,
    loose: inj.includes(q.entity) ? 1 : 0,
    chars: inj.length,
  };
}

describe('记忆题集：点名旧专物 → 找回原段落', () => {
  it('唯一金标 + 随机对照 + 各系统命中率', async () => {
    const canonical = loadCanonical(TXT);
    const blocks = splitBlocksProd(canonical);
    const labelIndex = buildLabelIndex(canonical, blocks);
    console.log('[mem] 语料', path.basename(TXT), canonical.length, '字 | 块', blocks.length, '| 子块', labelIndex.children.length);

    // 全书词表（与回放评测同口径的专名候选源）
    const learn = (ArchiveStore as unknown as { _learnDictionary: (s: { dict: string[] }, t: string) => boolean })._learnDictionary;
    const fake = { dict: [] as string[] };
    for (const b of blocks) learn.call(ArchiveStore, fake, b.text);
    const bookDict = fake.dict.slice();
    console.log('[mem] 全书词表', bookDict.length, '条');

    // 题集：候选 = 词表专名 ∪ 高 PMI 稀有词，条件是"全书只落在一个子块"（唯一金标）。
    // 词表词至少出现 4 次，但可能全挤在同一段（一个道具的密集描写）→ 该子块即唯一答案。
    const nChild = labelIndex.children.length;
    const childDf = new Map<string, number>();
    labelIndex.tokenSets.forEach(set => set.forEach(t => childDf.set(t, (childDf.get(t) || 0) + 1)));
    const pmi = buildPmiStats(canonical);
    const cands = new Set<string>();
    for (const w of bookDict) if (w && w.length >= 2 && childDf.get(w) === 1) cands.add(w);
    const dictCount = cands.size;
    for (let i = 0; i + 1 < canonical.length; i++) {
      if (cands.size > 3000) break;
    }
    // 稀有词通道：tokenSets 里 childDf==1 的 2 字词，PMI≥10 且全库出现 ≥2 次
    for (const t of Array.from(childDf.keys())) {
      if (t.length !== 2 || childDf.get(t) !== 1) continue;
      if (BM25StopwordsX.has(t)) continue;
      if (BM25StopwordsX.has(t[0]) || BM25StopwordsX.has(t[1])) continue;
      if (BM25_FN_CHARSX.indexOf(t[0]) >= 0 || BM25_FN_CHARSX.indexOf(t[1]) >= 0) continue;
      if ((pmi.count.get(t) || 0) < 2) continue;
      if (pmiOf(pmi, t) < 10) continue;
      cands.add(t);
    }
    console.log('[mem] 唯一子块候选：词典词', dictCount, '条 / 合计', cands.size, '条');
    const childOf = (pos: number) => labelIndex.children.findIndex(c => (c.absStart ?? 0) <= pos && pos < (c.absEnd ?? 0));
    const perChild = new Map<number, number>();
    const qs: Q[] = [];
    for (const w of cands) {
      const ci = childOf(canonical.indexOf(w));
      if (ci < 0) continue;
      // 提问点：该子块结束之后再隔 GAP 字（保证已滚出近期窗口、且是"旧事"）
      const t = labelIndex.children[ci].absEnd! + GAP;
      if (t + 6000 > canonical.length) continue;
      if (t - ROLL_WINDOW < MIN_ARCHIVE) continue;   // 归档太小的题不做（预算会覆盖整个归档）
      const n = perChild.get(ci) || 0;
      if (n >= MAX_PER_CHILD) continue;
      perChild.set(ci, n + 1);
      qs.push({ t, entity: w, childIdx: ci, goldText: labelIndex.children[ci].text, instruction: frame(w), instructionQ: frameQ(w) });
    }
    qs.sort((a, b) => a.t - b.t);
    const limited = LIMIT > 0 ? qs.slice(0, LIMIT) : qs;
    console.log('[mem] 唯一专名题', qs.length, '道（去重后每子块 ≤' + MAX_PER_CHILD + '），本次运行', limited.length, '道');
    console.log('[mem] 示例:', limited.slice(0, 8).map(q => q.entity + '@' + q.t).join(' / '));
    if (limited.length === 0) throw new Error('没有可用题，检查词表/语料');

    type Res = Record<string, { strict: number; loose: number; chars: number }>;
    const res: Res[] = limited.map(() => ({}));
    const coverages: number[] = [];

    // ===== Pass 1：词典学习开启 —— 自研核心（bm25_qb）+ 原生产管线（mine_old） =====
    ArchiveStore.clear();
    ArchiveIndex.invalidate();
    let next = 0;
    for (let qi = 0; qi < limited.length; qi++) {
      const q = limited[qi];
      while (next < blocks.length && blocks[next].end <= Math.max(0, q.t - ROLL_WINDOW)) { ArchiveStore.addBlocks([blocks[next].text], 900); next++; }
      const coveredEnd = next > 0 ? blocks[next - 1].end : 0;
      coverages.push(coveredEnd > 0 ? Math.min(1, BUDGET / coveredEnd) : NaN);
      const band0 = canonical.slice(Math.max(0, q.t - 2000), q.t);
      const bands: string[] = [band0];
      for (let i = 1; i < 6; i++) { const e = q.t - 2000 * i; if (e <= 0) break; bands.push(canonical.slice(Math.max(0, e - 2000), e)); }
      const recentText = canonical.slice(Math.max(0, q.t - 12000), q.t);
      const dictUnion = ArchiveStore.dictWords().slice();
      const ctx: S.Ctx = { t: q.t, band0, bands, recentText, dictUnion, wbTerms: [], instruction: q.instruction, budget: BUDGET, coveredEnd };
      // 诊断：点名实体是否进了查询？金标子块排第几？
      if (process.env.EVAL_DEBUG === '1' && qi < 8) {
        const inDict = dictUnion.indexOf(q.entity) >= 0;
        const qq = MemoryQueryBuilder.build(band0, {
          getDf: ArchiveIndex.getDf.bind(ArchiveIndex), dfCap: ArchiveIndex.suggestDfCap(),
          dict: dictUnion.length ? dictUnion : undefined, instruction: q.instruction,
          getCount: ArchiveIndex.termCount.bind(ArchiveIndex), recentParts: bands.slice(1), n: ArchiveIndex.childCount(),
        });
        const hits = ArchiveIndex.search(qq, 60) as { id: string; blockId: string; text: string; score: number }[];
        const goldId = labelIndex.children[q.childIdx].id;
        const rank = hits.findIndex(h => h.id === goldId);
        console.log('[dbg] 实体=%s | 在词典=%s | 词长=%d | 查询含实体=%s | 查询前80=%s | 金标排名=%s/60',
          q.entity, inDict, q.entity.length, qq.indexOf(q.entity) >= 0, qq.slice(0, 80), rank < 0 ? '未进' : String(rank + 1));
      }
      const qbOut = S.runBm25Qb(ctx);
      res[qi].bm25_qb = evaluate(qbOut.pieces, q);
      if (process.env.EVAL_DEBUG === '2' && res[qi].bm25_qb.strict === 0) {
        const qq = qbOut.query || '';
        console.log('[fail] 实体=%s | 查询含实体=%s | 查询=%s', q.entity, qq.indexOf(q.entity) >= 0, qq.slice(0, 120));
      }
      res[qi].bm25_qb_quote = evaluate(S.runBm25Qb({ ...ctx, instruction: q.instructionQ }).pieces, q);
      res[qi].qb_instonly = evaluate(S.runQbInstOnly(ctx).pieces, q);
      // 失败题：金标子块在构建查询里的排名（量化"稀释"程度）
      if (process.env.EVAL_DEBUG === '2' && res[qi].bm25_qb.strict === 0) {
        const built = MemoryQueryBuilder.build(band0, {
          getDf: ArchiveIndex.getDf.bind(ArchiveIndex), dfCap: ArchiveIndex.suggestDfCap(),
          dict: dictUnion.length ? dictUnion : undefined, instruction: q.instruction,
          getCount: ArchiveIndex.termCount.bind(ArchiveIndex), recentParts: bands.slice(1), n: ArchiveIndex.childCount(),
        });
        const hits = ArchiveIndex.search(built, 60) as { id: string }[];
        const r = hits.findIndex(h => h.id === labelIndex.children[q.childIdx].id);
        console.log('[rank] 实体=%s 金标排名=%s/60 查询词数~%d', q.entity, r < 0 ? '未进前60' : String(r + 1), built.split(' ').length);
      }
      if (process.env.EVAL_DEBUG === '3' && qi < 6) {
        const nt = S.namedTermsOf(ctx);
        const d = nt.map(w => w + '(' + ArchiveIndex.getDf(w) + ')');
        console.log('[named] 实体=%s df=%d | namedTerms=%s', q.entity, ArchiveIndex.getDf(q.entity), d.join(' '));
      }
      res[qi].qb_named = evaluate(S.runBm25Qb(ctx, { namedFirst: true }).pieces, q);
      res[qi].mine_new = evaluate(S.runMine(ctx).pieces, q);
      res[qi].mine_new_quote = evaluate(S.runMine({ ...ctx, instruction: q.instructionQ }).pieces, q);
      res[qi].mine_old = evaluate(S.runMine(ctx, { legacy: true }).pieces, q);
      const rndPieces = S.runRandom(ctx, labelIndex.children as Child[]).pieces;
      res[qi].random = evaluate(rndPieces, q);
      // 参考上界：只按指令检索（不拼窗口、无词典）
      res[qi].bm25_inst = evaluate(S.runBm25InstOnly({ ...ctx, dictUnion: [] }).pieces, q);
      if ((qi + 1) % 20 === 0) console.log('[mem] pass1', qi + 1, '/', limited.length);
    }

    // ===== Pass 2：词典关闭 —— 裸 BM25（指令+窗口） =====
    const origLearn = (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary;
    (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = function () { return false; };
    ArchiveStore.clear();
    ArchiveIndex.invalidate();
    next = 0;
    for (let qi = 0; qi < limited.length; qi++) {
      const q = limited[qi];
      while (next < blocks.length && blocks[next].end <= Math.max(0, q.t - ROLL_WINDOW)) { ArchiveStore.addBlocks([blocks[next].text], 900); next++; }
      const coveredEnd = next > 0 ? blocks[next - 1].end : 0;
      const band0 = canonical.slice(Math.max(0, q.t - 2000), q.t);
      const bands: string[] = [band0];
      for (let i = 1; i < 6; i++) { const e = q.t - 2000 * i; if (e <= 0) break; bands.push(canonical.slice(Math.max(0, e - 2000), e)); }
      const ctx: S.Ctx = { t: q.t, band0, bands, recentText: canonical.slice(Math.max(0, q.t - 12000), q.t), dictUnion: [], wbTerms: [], instruction: q.instruction, budget: BUDGET, coveredEnd };
      res[qi].bm25_raw = evaluate(S.runBm25Raw(ctx).pieces, q);
    }
    (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = origLearn;

    // ===== Pass 3：向量 / 混合（API，子块向量已缓存） =====
    if (!SKIP_API) {
      ArchiveIndex.invalidate();
      const units = labelIndex.children.map(c => ({ id: c.id, blockId: c.blockId, text: c.text, absEnd: c.absEnd }));
      const unitVecs = await embedTexts(units.map(u => u.text));
      const qVecs = await embedTexts(limited.map(q => q.instruction + '\n' + canonical.slice(Math.max(0, q.t - 2000), q.t)));
      const uv = new Map<string, number[]>();
      units.forEach((u, i) => uv.set(u.id, unitVecs[i]));
      // 混合用的 BM25 排名：另跑一遍（词典关闭，排名与 pass2 同构）
      (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = function () { return false; };
      ArchiveStore.clear();
      ArchiveIndex.invalidate();
      next = 0;
      for (let qi = 0; qi < limited.length; qi++) {
        const q = limited[qi];
        while (next < blocks.length && blocks[next].end <= Math.max(0, q.t - ROLL_WINDOW)) { ArchiveStore.addBlocks([blocks[next].text], 900); next++; }
        const coveredEnd = next > 0 ? blocks[next - 1].end : 0;
        const band0 = canonical.slice(Math.max(0, q.t - 2000), q.t);
        const bands: string[] = [band0];
        for (let i = 1; i < 6; i++) { const e = q.t - 2000 * i; if (e <= 0) break; bands.push(canonical.slice(Math.max(0, e - 2000), e)); }
        const ctx: S.Ctx = { t: q.t, band0, bands, recentText: canonical.slice(Math.max(0, q.t - 12000), q.t), dictUnion: [], wbTerms: [], instruction: q.instruction, budget: BUDGET, coveredEnd };
        const dRank = S.denseRank(ctx, units, uv, qVecs[qi]);
        res[qi].dense = evaluate(S.fillByRank(dRank, BUDGET), q);
        const bm = S.bm25Ranking(ctx, 100).map(r => ({ id: r.id, blockId: r.blockId, text: r.text }));
        const fused = S.rrfFuse([bm, dRank]);
        res[qi].hybrid = evaluate(S.fillByRank(fused, BUDGET), q);
      }
      (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = origLearn;
      flushApiStats('mem');
    }

    // ===== 汇总 =====
    const systems = Array.from(new Set(res.flatMap(r => Object.keys(r))));
    const rows = systems.map(sys => {
      const st = res.map(r => r[sys]?.strict).filter(v => v !== undefined) as number[];
      const lo = res.map(r => r[sys]?.loose).filter(v => v !== undefined) as number[];
      return {
        系统: sys,
        严格命中: st.reduce((a, b) => a + b, 0) / st.length,
        宽松命中: lo.reduce((a, b) => a + b, 0) / lo.length,
        平均注入字数: Math.round(res.map(r => r[sys]?.chars || 0).reduce((a, b) => a + b, 0) / st.length),
      };
    }).sort((a, b) => b.严格命中 - a.严格命中);
    const covMean = coverages.filter(c => !isNaN(c)).reduce((a, b) => a + b, 0) / coverages.filter(c => !isNaN(c)).length;
    const pct = (x: number) => (x * 100).toFixed(1) + '%';
    const out = rows.map(r => ({ 系统: r.系统, 严格命中: pct(r.严格命中), 宽松命中: pct(r.宽松命中), 平均注入字数: r.平均注入字数 }));
    console.log('\n===== 记忆题集结果（' + path.basename(TXT) + '，' + limited.length + ' 道唯一专名题，预算 ' + BUDGET + ' 字）=====');
    console.log('随机基线理论期望（= 平均覆盖率）: ' + pct(covMean));
    console.table(out);

    // 配对 McNemar（除 random 外每个系统 vs random）
    const binom = (k: number, n: number): number => {
      const pmf = (i: number) => { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); return c * Math.pow(0.5, n); };
      const obs = pmf(Math.min(k, n - k));
      let p = 0;
      for (let i = 0; i <= n; i++) if (pmf(i) <= obs + 1e-12) p += pmf(i);
      return Math.min(1, p);
    };
    const cmp: Record<string, string>[] = [];
    for (const sys of systems) {
      if (sys === 'random') continue;
      let b = 0, c = 0;
      res.forEach((r, i) => {
        const a1 = r[sys]?.strict, a2 = r.random?.strict;
        if (a1 === undefined || a2 === undefined) return;
        if (a1 === 1 && a2 === 0) b++;
        if (a1 === 0 && a2 === 1) c++;
      });
      const p = binom(b, b + c);
      cmp.push({ 系统: sys, 'win/loss': b + '/' + c, p值: p.toFixed(4), 判定: p < 0.05 ? '**显著优于随机**' : (p < 0.1 ? '边缘' : '不显著') });
    }
    console.table(cmp);

    const outDir = path.join(HERE, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const name = path.basename(TXT).replace(/[^\w\u4e00-\u9fff.-]/g, '_');
    fs.writeFileSync(path.join(outDir, 'memtest_' + name + '.json'), JSON.stringify({
      corpus: TXT, chars: canonical.length, questions: limited.length, budget: BUDGET, gap: GAP,
      randomExpectation: covMean, table: out, pairedVsRandom: cmp,
      detail: limited.map((q, i) => ({ t: q.t, entity: q.entity, ...res[i] })),
    }, null, 1));
    console.log('[mem] 报告写入 out/memtest_' + name + '.json');
  });
});
