// 真实写法指令集：第一人称限知视角、轻小说腔的角色台词（不是"请回想起X"这种指令腔）。
// 生成方式（全离线、确定性）：从最近 2000 字取一个"当前话题词"（anchor），再挑一个已掉出窗口的
// 旧专名（entity），用四种 POV 句式把两者串起来——含"只做对比、不提想起"的隐式指涉（最接近真实：
// 用户只是顺口比较，系统得自己意识到该回忆谁）。
// 金标：entity 首次出现的子块（strict）+ 归档里所有提到它的子块（loose，产品口径）。
//
// 运行：cd app && SILICONFLOW_KEY=... npx vitest run --config tools/retrieval-eval/vitest.config.ts realinstr
// 环境变量：EVAL_TXT / RI_N 题数上限 / EVAL_SKIP_API=1 跳过向量系统 / EVAL_MIN_ARCHIVE
import '../../src/infra/storage';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { ArchiveStore } from '../../src/domain/archive';
import { ArchiveIndex, BM25, MemoryQueryBuilder } from '../../src/lib/bm25';
import { loadCanonical, splitBlocksProd, buildLabelIndex, buildPmiStats, pmiOf, norm, type Child, type Piece } from './lib/core';
import * as S from './lib/systems';
import { buildRealQuestions, bookDictOf } from './lib/questions';
import { embedTexts, flushApiStats } from './lib/api';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const BUDGET = Number(process.env.EVAL_BUDGET || 30000);
const RI_N = Number(process.env.RI_N || 40);
const SKIP_API = process.env.EVAL_SKIP_API === '1';
// GAP 必须 > 滚窗(12000)+块上限(~8800)，否则子块所在块还没滚入归档、金标取不到
const GAP = Number(process.env.EVAL_GAP || 22000);
const MIN_ARCHIVE = Number(process.env.EVAL_MIN_ARCHIVE || 40000);
const ROLL_WINDOW = 12000;

// 四种 POV 句式：implicit = 只做对比/感叹，不出现"想起"字样（考系统是否自己意识到要回忆）
const TEMPLATES: { name: string; implicit: boolean; make: (a: string, e: string) => string }[] = [
  // 无引号（与真实写法一致；引号包裹会让查询构造按"对白套语"处理，且长引号段不会被引号通道捕获）
  { name: '对比式', implicit: true, make: (a, e) => '啊，原来' + a + '是这样的啊……和' + e + '完全不一样呢。' },
  { name: '感叹式', implicit: true, make: (a, e) => a + '……吗。总觉得和' + e + '那时候不太一样。' },
  { name: '回忆式', implicit: false, make: (a, e) => '说到' + a + '，就不由得想起' + e + '了啊。' },
  { name: '挂念式', implicit: false, make: (a, e) => a + '……唔，这让我想起' + e + '了。不知道' + e + '现在怎么样了。' },
];

interface Q {
  t: number; entity: string; anchor: string; df: number; tmpl: string; implicit: boolean;
  instruction: string; goldChildIdx: number; goldChildId: string; goldIds: string[]; goldChildText: string;
}

function evaluate(pieces: Piece[], q: Q): { strict: number; loose: number; chars: number } {
  const inj = pieces.map(p => String(p.text || '')).join('\n');
  const injN = norm(inj);
  return {
    // 严格：首现子块被逐字注入；提及：注入内容里出现了该专名（产品口径）
    strict: injN.includes(norm(q.goldChildText)) ? 1 : 0,
    loose: inj.includes(q.entity) ? 1 : 0,
    chars: inj.length,
  };
}

describe('真实写法指令集：POV 台词里的旧事回指', () => {
  it('生成题集 + 多系统命中率', async () => {
    const canonical = loadCanonical(TXT);
    const blocks = splitBlocksProd(canonical);
    const labelIndex = buildLabelIndex(canonical, blocks);
    console.log('[ri] 语料', path.basename(TXT), canonical.length, '字 | 子块', labelIndex.children.length);

    const bookDict = bookDictOf(blocks);
    const qs = buildRealQuestions(canonical, labelIndex, bookDict, { budget: BUDGET, gap: GAP, minArchive: MIN_ARCHIVE, n: RI_N });
    let limited: Q[] = qs.map(q => ({ ...q }));
    // 若提供 LLM 生成的指令文件（geninstr 产出），按 t|entity 匹配并展开成隐式/显式两题
    const instrFile = process.env.RI_INSTR_FILE || '';
    if (instrFile) {
      const raw = JSON.parse(fs.readFileSync(instrFile, 'utf8'));
      const items = raw.items || {};
      const expanded: Q[] = [];
      let missing = 0;
      for (const q of limited) {
        const it = items[q.t + '|' + q.entity];
        if (!it) { missing++; continue; }
        for (const pair of [['implicit', true], ['explicit', false]] as [string, boolean][]) {
          const text = String((it as Record<string, string>)[pair[0]] || '').trim();
          if (!text) continue;
          expanded.push({ ...q, instruction: text, tmpl: 'LLM-' + pair[0], implicit: pair[1] });
        }
      }
      limited = expanded;
      console.log('[ri] LLM 指令文件', path.basename(instrFile), '→ 展开', limited.length, '题（缺', missing, '题）');
    } else {
      // 无 LLM 文件时用内置模板（离线对照）
      let ti = 0;
      limited = limited.map(q => { const tm = TEMPLATES[ti++ % TEMPLATES.length]; return { ...q, tmpl: tm.name, implicit: tm.implicit, instruction: tm.make(q.anchor, q.entity) }; });
    }
    console.log('[ri] 候选池', qs.length, '→ 运行', limited.length, '题（隐式', limited.filter(q => q.implicit).length, '显式', limited.filter(q => !q.implicit).length, '）');
    limited.slice(0, 6).forEach(q => console.log('   [', q.tmpl, ']', q.instruction, '| 实体=', q.entity, 'df=' + q.df));
    if (limited.length === 0) throw new Error('没有可用题');

    type Res = Record<string, { strict: number; loose: number; chars: number }>;
    const res: Res[] = limited.map(() => ({}));
    const coverages: number[] = [];

    // ===== Pass 1：词典学习开启 =====
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
      const ctx: S.Ctx = { t: q.t, band0, bands, recentText: canonical.slice(Math.max(0, q.t - 12000), q.t), dictUnion: ArchiveStore.dictWords().slice(), wbTerms: [], instruction: q.instruction, budget: BUDGET, coveredEnd };
      res[qi].mine_new = evaluate(S.runMine(ctx).pieces, q);
      res[qi].mine_old = evaluate(S.runMine(ctx, { legacy: true }).pieces, q);
      res[qi].bm25_qb = evaluate(S.runBm25Qb(ctx).pieces, q);
      res[qi].qb_named = evaluate(S.runBm25Qb(ctx, { namedFirst: true }).pieces, q);
      res[qi].random = evaluate(S.runRandom(ctx, labelIndex.children as Child[]).pieces, q);
      res[qi].bm25_inst = evaluate(S.runBm25InstOnly({ ...ctx, dictUnion: [] }).pieces, q);
      if (process.env.RI_DEBUG === '1' && qi < 3) {
        const rnd = S.runRandom(ctx, labelIndex.children as Child[]).pieces;
        const rndText = rnd.map(p => String(p.text || '')).join('\n');
        const pool = labelIndex.children.filter(c => (c.absEnd ?? 0) <= coveredEnd);
        console.log('[dbg] t=%d 归档子块=%d coveredEnd=%d | 随机注入%d条/%d字 | 实体在随机里=%s | 金标子块在归档=%s',
          q.t, pool.length, coveredEnd, rnd.length, rndText.length, rndText.indexOf(q.entity) >= 0,
          pool.some(c => c.id === q.goldChildId));
      }
    }

    // ===== Pass 2：词典关闭（裸 BM25） =====
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

    // ===== Pass 3：向量 / 混合 =====
    if (!SKIP_API) {
      const units = labelIndex.children.map(c => ({ id: c.id, blockId: c.blockId, text: c.text, absEnd: c.absEnd }));
      const unitVecs = await embedTexts(units.map(u => u.text));
      const qVecs = await embedTexts(limited.map(q => q.instruction));
      const uv = new Map<string, number[]>();
      units.forEach((u, i) => uv.set(u.id, unitVecs[i]));
      ArchiveStore.clear();
      ArchiveIndex.invalidate();
      next = 0;
      // 混合用 BM25 排名（词典关闭）
      (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = function () { return false; };
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
        res[qi].hybrid = evaluate(S.fillByRank(S.rrfFuse([bm, dRank]), BUDGET), q);
      }
      (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = origLearn;
      flushApiStats('ri');
    } else {
      (ArchiveStore as unknown as { _learnDictionary: (...a: unknown[]) => boolean })._learnDictionary = origLearn;
    }

    // ===== 汇总 =====
    const systems = Array.from(new Set(res.flatMap(r => Object.keys(r))));
    const rows = systems.map(sys => {
      const sub = ['', 'implicit', 'explicit'].map(kind => {
        const idxs = limited.map((q, i) => ({ q, i })).filter(({ q }) => kind === '' || (kind === 'implicit' ? q.implicit : !q.implicit));
        const st = idxs.map(({ i }) => res[i][sys]?.strict).filter(v => v !== undefined) as number[];
        const lo = idxs.map(({ i }) => res[i][sys]?.loose).filter(v => v !== undefined) as number[];
        return {
          strict: st.length ? st.reduce((a, b) => a + b, 0) / st.length : NaN,
          loose: lo.length ? lo.reduce((a, b) => a + b, 0) / lo.length : NaN,
          n: st.length,
        };
      });
      return {
        系统: sys,
        严格命中: sub[0].strict, 提及命中: sub[0].loose,
        隐式严格: sub[1].strict, 隐式提及: sub[1].loose,
        显式严格: sub[2].strict, 显式提及: sub[2].loose,
      };
    }).sort((a, b) => b.提及命中 - a.提及命中);
    const covMean = coverages.filter(c => !isNaN(c)).reduce((a, b) => a + b, 0) / coverages.filter(c => !isNaN(c)).length;
    const pct = (x: number) => (isNaN(x) ? '-' : (x * 100).toFixed(1) + '%');
    const out = rows.map(r => ({
      系统: r.系统, '严格命中(首现段)': pct(r.严格命中), '提及命中(任一段)': pct(r.提及命中),
      '隐式·严格': pct(r.隐式严格), '隐式·提及': pct(r.隐式提及), '显式·严格': pct(r.显式严格), '显式·提及': pct(r.显式提及),
    }));
    console.log('\n===== 真实写法指令集（' + path.basename(TXT) + '，' + limited.length + ' 道，预算 ' + BUDGET + '）=====');
    console.log('随机基线理论期望：严格 ≈ 覆盖率 ' + pct(covMean) + '（实体多提及时更高）');
    console.table(out);

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
      res.forEach(r => {
        const a1 = r[sys]?.loose, a2 = r.random?.loose;
        if (a1 === undefined || a2 === undefined) return;
        if (a1 === 1 && a2 === 0) b++;
        if (a1 === 0 && a2 === 1) c++;
      });
      const p = binom(b, b + c);
      cmp.push({ 系统: sys, '提及口径 win/loss': b + '/' + c, p值: p.toFixed(4), 判定: p < 0.05 ? '**显著优于随机**' : (p < 0.1 ? '边缘' : '不显著') });
    }
    console.table(cmp);

    const outDir = path.join(HERE, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const name = path.basename(TXT).replace(/[^\w\u4e00-\u9fff.-]/g, '_');
    fs.writeFileSync(path.join(outDir, 'realinstr_' + name + '.json'), JSON.stringify({
      corpus: TXT, chars: canonical.length, questions: limited.length, budget: BUDGET,
      randomExpectation: covMean, table: out, pairedVsRandom: cmp,
      detail: limited.map((q, i) => ({ t: q.t, entity: q.entity, df: q.df, anchor: q.anchor, template: q.tmpl, implicit: q.implicit, instruction: q.instruction, ...res[i] })),
    }, null, 1));
    console.log('[ri] 报告写入 out/realinstr_' + name + '.json（含全部指令原文，可直接人工审阅）');
  });
});
