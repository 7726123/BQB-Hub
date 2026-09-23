// 字典因子实验：回答「词典机制到底贡献了什么」。
// 把词典拆成两半分别开关——
//   索引侧（trie 最长匹配分词 + ≥3 字词 1.5× 权重 + 单字门控 _hasFullCover + 直收 _isDictWord）
//   查询侧（extractEntities/stableEntities/桥接/世界书 ×2，即 build 的 dict 参数）
// 并对生产管线各阶段做逐一消融（点名必达 / 主角名直收 / 强相关门槛 / 相邻合并 / 原始查询）。
//
// 格子（全部跑在同一批金标题、同一预算、同一索引状态下）：
//   full             索引侧=世界书+自学词典，查询侧同 —— 生产现状
//   index_only       索引侧同上，查询侧不给词典（实体通道关闭）
//   wb_only          只保留世界书词典（自学词表关闭），两侧同
//   no_dict          词典完全关闭（索引无 trie、查询无实体）
//   no_namedpass     去掉「点名必达」前置通道
//   no_direct        去掉「主角名直收」
//   no_gate          去掉「强相关门槛」
//   no_merge         去掉「相邻子块合并」
//   raw_query        原始窗口+指令当查询（词典仍在索引侧）
//
// 两个场景：A 无指令（主动回忆，gold=后文将提到的旧专名）/ B 点名（指令点名旧专名）
// 运行：cd app && npx vitest run --config tools/retrieval-eval/vitest.config.ts dictablation
// 环境变量：EVAL_TXT 单语料 / DA_LIMIT 每场景题数（默认 18）/ DA_BUDGET / DA_CORPORA 逗号分隔
import '../../src/infra/storage';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { ArchiveStore } from '../../src/domain/archive';
import { ArchiveIndex, MemoryQueryBuilder } from '../../src/lib/bm25';
import {
  loadCanonical, splitBlocksProd, buildLabelIndex, buildPmiStats, pmiOf, extractGold, scorePieces, norm, mulberry32,
  BM25StopwordsX, BM25_FN_CHARSX, type Child, type Gold, type Piece,
} from './lib/core';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const D = 'C:/Users/a7726/Desktop/';
const DL = 'C:/Users/a7726/Downloads/';
const CORPORA = process.env.EVAL_TXT
  ? [process.env.EVAL_TXT]
  : (process.env.DA_CORPORA ? process.env.DA_CORPORA.split(',').map(s => s.trim()) : [
      D + '案例.txt',
      D + '案例2.txt',
      DL + '败北女角太多了！(败犬女主太多了！) 第一卷 gbk.txt',
      DL + '败北女角太多了！(败犬女主太多了！) 第二卷 gbk.txt',
      DL + '败北女角太多了！(败犬女主太多了！) 第三卷 gbk.txt',
      DL + '义妹生活 第一卷 gbk.txt',
      DL + '不时轻声地以俄语遮羞的邻座艾莉同学(邻座的艾琳同学偶尔会用俄语悄悄撒娇) 第一卷 gbk.txt',
      DL + '不起眼女主角培育法(路人女主的养成方法) 第一卷 gbk (1).txt',
      DL + '不起眼女主角培育法(路人女主的养成方法) 第二卷 gbk.txt',
      DL + '不起眼女主角培育法(路人女主的养成方法) 第三卷 gbk.txt',
    ]);
const BUDGET = Number(process.env.DA_BUDGET || 30000);
const LIMIT = Number(process.env.DA_LIMIT || 40);
const STEP = 4000, WARMUP = 60000, FUTURE = 3000, ROLL_WINDOW = 12000, GAP = 22000, MAX_PER_CHILD = 2;
// 归档规模下限：归档 ≈ 预算时题无意义（几乎全覆盖）。场景 A 的题点必须落在归档 ≥ 此值处。
const MIN_ARCHIVE = Number(process.env.DA_MIN_ARCHIVE || 150000);
/** 在候选里均匀取 n 个（避免只取到最早=归档最小的那批题） */
function pickEvenly<T>(xs: T[], n: number): T[] {
  if (xs.length <= n) return xs;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(xs[Math.round(i * (xs.length - 1) / (n - 1))]);
  return Array.from(new Set(out));
}

interface Ctx { t: number; band0: string; bands: string[]; recentText: string; dictUnion: string[]; wbTerms: string[]; instruction: string; budget: number; coveredEnd: number }
interface Sw { query: 'qb' | 'raw'; queryD: boolean; namedPass: boolean; direct: boolean; gate: boolean; merge: boolean; random?: boolean; bgDirect?: boolean }

const FULL: Sw = { query: 'qb', queryD: true, namedPass: true, direct: true, gate: true, merge: true };
/** 消融格子：词典四格（靠开关索引/查询侧实现）+ 管线五格 */
const CELLS: { key: string; sw: Sw; group: '词典' | '管线' }[] = [
  { key: 'full', sw: FULL, group: '词典' },
  { key: 'index_only', sw: { ...FULL, queryD: false }, group: '词典' },
  { key: 'wb_only', sw: FULL, group: '词典' },       // 自学词表关闭（索引/查询两侧都只剩世界书）
  { key: 'no_dict', sw: FULL, group: '词典' },       // 全关（无 trie、无实体）——地板
  { key: 'no_namedpass', sw: { ...FULL, namedPass: false }, group: '管线' },
  { key: 'no_direct', sw: { ...FULL, direct: false }, group: '管线' },
  { key: 'no_gate', sw: { ...FULL, gate: false }, group: '管线' },
  { key: 'no_merge', sw: { ...FULL, merge: false }, group: '管线' },
  { key: 'raw_query', sw: { ...FULL, query: 'raw' }, group: '管线' },
  { key: 'random', sw: { ...FULL, random: true }, group: '地板' },   // 随机取归档子块（地板：无检索时的期望）
  // 提案 A 的探针实现：打分分词不用 trie（纯 bigram，= p3 的索引状态），词典只用于
  // 「实体识别 + 直收」——直收的 tf 由子块文本现场统计（无需倒排表）。跑在 p3 里。
  { key: 'bigram+直收', sw: { ...FULL, bgDirect: true }, group: '提案' },
  { key: '提案A(全词典)', sw: { ...FULL, bgDirect: true }, group: '提案' },
];
// 每个「索引状态」跑哪些格子：p1 = 自学词典开；p2 = 自学关（世界书进索引）；p3 = 全部关
const PASS_CELLS: Record<'p1' | 'p2' | 'p3' | 'p4', string[]> = {
  p1: ['full', 'index_only', 'no_namedpass', 'no_direct', 'no_gate', 'no_merge', 'raw_query', 'random'],
  p2: ['wb_only'],
  p3: ['no_dict', 'bigram+直收'],
  // p4 = 提案 A 完整形态：自学词典开（实体源 = 世界书 + 自学），但打分分词完全不用 trie
  p4: ['提案A(全词典)'],
};

/** 生产管线复刻（app.ts 归档回读段），开关化 */
function runCell(ctx: Ctx, sw: Sw): Piece[] {
  ArchiveIndex.ensureFresh();
  if ((sw as { random?: boolean }).random) {
    // 地板对照：归档内随机取子块填满预算（同注入量），衡量「没有任何检索」时的期望命中
    const kids = (ArchiveIndex as unknown as { _children: { text: string; blockId: string }[] })._children.slice();
    const rng = mulberry32(ctx.t || 1);
    for (let i = kids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = kids[i]; kids[i] = kids[j]; kids[j] = tmp; }
    const out: Piece[] = []; let used = 0;
    for (const k of kids) { if (used + k.text.length > ctx.budget && out.length) continue; out.push({ blockId: k.blockId, text: k.text }); used += k.text.length; if (used >= ctx.budget) break; }
    return out;
  }
  const getDf = ArchiveIndex.getDf.bind(ArchiveIndex);
  const getCount = ArchiveIndex.termCount.bind(ArchiveIndex);
  const dictU = sw.queryD ? ctx.dictUnion : [];
  const q = sw.query === 'raw'
    ? (ctx.instruction ? ctx.instruction + '\n' : '') + ctx.band0
    : MemoryQueryBuilder.build(ctx.band0, {
        getDf, dfCap: ArchiveIndex.suggestDfCap(),
        dict: (sw.queryD && ctx.dictUnion.length) ? ctx.dictUnion : undefined,
        instruction: ctx.instruction, getCount,
        recentParts: ctx.bands.slice(1), n: ArchiveIndex.childCount(),
      });
  const pieces: Piece[] = [];
  const seen = new Set<string>();
  let used = 0;
  const push = (blockId: string, text: string, score?: number) => {
    const key = norm(text).slice(0, 40);
    if (!key || seen.has(key)) return;
    if (pieces.length > 0 && used + text.length > ctx.budget) return;
    seen.add(key);
    pieces.push({ blockId, text, score });
    used += text.length;
  };
  // ① 点名必达（最高优先，前置注入 6 条）
  if (sw.namedPass && ctx.instruction) {
    try {
      const named = MemoryQueryBuilder.namedTerms(ctx.instruction, getDf, getCount, ArchiveIndex.childCount());
      if (named.length) {
        for (const h of ArchiveIndex.search(named.join(' '), 6) as { blockId: string; text: string; score: number }[]) push(h.blockId, h.text, h.score);
      }
    } catch (e) { /* 忽略 */ }
  }
  // ② 主角名直收
  if (sw.direct) {
    try { for (const d of ArchiveIndex.searchDirect(q, 2)) push(d.blockId, d.text, d.score); } catch (e) { /* 忽略 */ }
  // 提案 A：bigram 打分（p3 索引状态）+ 词典只做实体识别；直收 tf 由子块文本现场统计
  if (sw.bgDirect && ctx.dictUnion.length) {
    const kids = (ArchiveIndex as unknown as { _children: { id: string; blockId: string; text: string }[] })._children;
    const ents = ctx.dictUnion.filter(w => w.length >= 2 && q.indexOf(w) >= 0);
    const best: Record<string, { tf: number; blockId: string; text: string }> = {};
    for (const w of ents) {
      for (const k of kids) {
        const n = k.text.split(w).length - 1;
        if (n >= 2 && (!best[k.id] || best[k.id].tf < n)) best[k.id] = { tf: n, blockId: k.blockId, text: k.text };
      }
    }
    Object.keys(best).sort((x, y) => best[y].tf - best[x].tf).slice(0, 2)
      .forEach(id => push(best[id].blockId, best[id].text, best[id].tf));
  }
  }
  let cands = ArchiveIndex.search(q, 48) as { id: string; blockId: string; text: string; score: number }[];
  // ③ 强相关门槛
  if (sw.gate) {
    const dfCap = ArchiveIndex.suggestDfCap();
    const gTerms = MemoryQueryBuilder.rareTermsMulti([ctx.instruction].concat(ctx.bands), getDf, Math.max(3, Math.min(dfCap, 6)), 12, getCount);
    if (ctx.instruction) {
      try { MemoryQueryBuilder.namedAnchors(ctx.instruction, getDf, 2, getCount).forEach(w => { if (gTerms.indexOf(w) < 0) gTerms.push(w); }); } catch (e) { /* 忽略 */ }
    }
    for (const w of ctx.wbTerms) {
      if (w.length >= 2 && ctx.recentText.indexOf(w) >= 0 && gTerms.indexOf(w) < 0) gTerms.push(w);
    }
    if (gTerms.length >= 2) {
      const entKeys = gTerms.filter(w => w.length >= 2 && (dictU.indexOf(w) >= 0 || ctx.instruction.indexOf(w) >= 0));
      const thr = entKeys.length ? 1 : 2;
      cands = cands.filter(c => MemoryQueryBuilder.countTermHits(String(c.text || ''), gTerms) >= thr);
    }
  }
  // ④ 相邻合并 → 按分数填满预算
  const spans = (sw.merge ? ArchiveIndex.mergeSpans(cands) : cands)
    .map(s => ({ blockId: s.blockId, text: String(s.text || ''), score: Number(s.score) || 0 }))
    .sort((a, b) => b.score - a.score);
  for (const sp of spans) {
    if (used >= ctx.budget) break;
    push(sp.blockId, sp.text, sp.score);
  }
  return pieces;
}

describe('字典因子实验', () => {
  for (const TXT of CORPORA) {
    it('因子消融：' + path.basename(TXT), async () => {
      const canonical = loadCanonical(TXT);
      const blocks = splitBlocksProd(canonical);
      const labelIndex = buildLabelIndex(canonical, blocks);
      const pmi = buildPmiStats(canonical);
      const learn = (ArchiveStore as unknown as { _learnDictionary: (s: { dict: string[] }, t: string) => boolean })._learnDictionary;
      const learnDict = (upto: number): string[] => { const fake = { dict: [] as string[] }; for (let i = 0; i < upto; i++) learn.call(ArchiveStore, fake, blocks[i].text); return fake.dict.slice(); };
      const bookDict = learnDict(blocks.length);
      // 合成世界书：写到 6 万字时已建档的名字（与题点无关，可复现）
      const wbTerms = learnDict(blocks.filter(b => b.end <= WARMUP).length);
      console.log('\n[ab] 语料', path.basename(TXT), canonical.length, '字 | 块', blocks.length, '| 子块', labelIndex.children.length, '| 全书词表', bookDict.length, '| 合成世界书', wbTerms.length);

      // ===== 场景 A：无指令（主动回忆）——查询点回放，gold=后文提到的旧专名 =====
      const ts: number[] = [];
      for (let t = WARMUP; t + FUTURE + STEP <= canonical.length; t += STEP) ts.push(t);
      const QsA: { t: number; ctx: Ctx; gold: Gold }[] = [];
      const candA: { t: number; gold: Gold }[] = [];
      // 短篇语料按比例放宽归档下限（否则长书之外的语料取不到题）
      const minArch = Math.min(MIN_ARCHIVE, Math.round(canonical.length * 0.4));
      for (const t of ts) {
        const covered = blocks.filter(b => b.end <= Math.max(0, t - ROLL_WINDOW)).length;
        const coveredEnd = covered > 0 ? blocks[covered - 1].end : 0;
        if (coveredEnd < minArch) continue;
        const gold = extractGold(labelIndex, t, { future: FUTURE, coveredEnd, pmi, entityWords: bookDict });
        if (!gold.terms.length) continue;
        candA.push({ t, gold });
      }
      for (const q of pickEvenly(candA, LIMIT)) {
        QsA.push({ t: q.t, gold: q.gold, ctx: { t: q.t, band0: '', bands: [], recentText: '', dictUnion: [], wbTerms: [], instruction: '', budget: BUDGET, coveredEnd: 0 } });
      }
      // ===== 场景 B：点名（唯一专名题，同 memtest 口径） =====
      const childDf = new Map<string, number>();
      labelIndex.tokenSets.forEach(set => set.forEach(t => childDf.set(t, (childDf.get(t) || 0) + 1)));
      const cands = new Set<string>();
      for (const w of bookDict) if (w && w.length >= 2 && childDf.get(w) === 1) cands.add(w);
      for (const t of Array.from(childDf.keys())) {
        if (t.length !== 2 || childDf.get(t) !== 1 || BM25StopwordsX.has(t)) continue;
        if (BM25StopwordsX.has(t[0]) || BM25StopwordsX.has(t[1])) continue;
        if (BM25_FN_CHARSX.indexOf(t[0]) >= 0 || BM25_FN_CHARSX.indexOf(t[1]) >= 0) continue;
        if ((pmi.count.get(t) || 0) < 2 || pmiOf(pmi, t) < 10) continue;
        cands.add(t);
      }
      const childOf = (pos: number) => labelIndex.children.findIndex(c => (c.absStart ?? 0) <= pos && pos < (c.absEnd ?? 0));
      const perChild = new Map<number, number>();
      const QsB: { t: number; ctx: Ctx; gold: Gold }[] = [];
      for (const w of cands) {
        const ci = childOf(canonical.indexOf(w));
        if (ci < 0) continue;
        const t = labelIndex.children[ci].absEnd! + GAP;
        if (t + 6000 > canonical.length || t - ROLL_WINDOW < 60000) continue;
        const n = perChild.get(ci) || 0;
        if (n >= MAX_PER_CHILD) continue;
        perChild.set(ci, n + 1);
        QsB.push({ t, gold: { terms: [w], spans: [labelIndex.children[ci].text] }, ctx: { t, band0: '', bands: [], recentText: '', dictUnion: [], wbTerms: [], instruction: '继续写下去，让角色自然回想起关于' + w + '的往事。', budget: BUDGET, coveredEnd: 0 } });
      }
      QsB.sort((a, b) => a.t - b.t);
      const QsB2 = pickEvenly(QsB, LIMIT);

      // ===== 场景 C/D：高频实体点名（词典的主场）=====
      // C：指令直呼高频实体名（全书 ≥8 次 → df 超过 rareBigrams 门槛，只有 namedAnchors/词典整词能抓到）
      // D：指令用单字简称点名（只有 expandSingles 的「单字→全名」桥接能把它变成全名）
      // 金标 = 该实体出现最密的子块（"最值得回忆的那一幕"）
      const childTfOf = (w: string): Map<number, number> => {
        const m = new Map<number, number>();
        labelIndex.children.forEach((c, i) => { const n = c.text.split(w).length - 1; if (n > 0) m.set(i, n); });
        return m;
      };
      const prefixCount = new Map<string, number>();
      for (const w of wbTerms) { const c0 = w[0]; prefixCount.set(c0, (prefixCount.get(c0) || 0) + 1); }
      const mkNamed = (mode: 'C' | 'C2' | 'D'): { t: number; ctx: Ctx; gold: Gold }[] => {
        const out: { t: number; ctx: Ctx; gold: Gold }[] = [];
        const used = new Set<string>();
        for (const w of wbTerms) {
          if (out.length >= LIMIT) break;
          if (!w || w.length < 2 || w.length > 6) continue;
          let ask = w;
          if (mode === 'D') {
            if (w.length < 3) continue;
            const c0 = w[0];
            if ((prefixCount.get(c0) || 0) > 3) continue;   // 单字需基本唯一指向该实体
            if (wbTerms.indexOf(c0) >= 0) continue;         // 单字自身不能是词条
            ask = c0;
          }
          if (used.has(ask)) continue;
          if (canonical.split(w).length - 1 < 5) continue;   // 至少中等频（低频专名已由场景 B 覆盖）
          const tf = childTfOf(w);
          if (tf.size < 3) continue;                          // 至少散布在 3 个以上子块（BM25 里算"高频"）
          let best = -1, bestN = 0;
          tf.forEach((n, i) => { if (n > bestN) { bestN = n; best = i; } });
          if (best < 0 || bestN < 2) continue;
          const ch = labelIndex.children[best];
          const t = (ch.absEnd ?? 0) + GAP;                   // 金标子块必然已滚出窗口（GAP > 滚窗）
          if (t + 6000 > canonical.length || t - ROLL_WINDOW < 60000) continue;
          const win = canonical.slice(Math.max(0, t - ROLL_WINDOW), t);
          if (mode === 'C2' && win.indexOf(w) < 0) continue;  // C2：该实体当前就在窗口里（隐式在场）
          const n = perChild.get(best) || 0;
          if (n >= MAX_PER_CHILD) continue;
          perChild.set(best, n + 1);
          used.add(ask);
          out.push({
            t, gold: { terms: [w], spans: [ch.text] },
            ctx: { t, band0: '', bands: [], recentText: '', dictUnion: [], wbTerms: [], instruction: mode === 'C2' ? '' : '继续写下去，让角色自然回想起关于' + ask + '的往事。', budget: BUDGET, coveredEnd: 0 },
          });
        }
        return out;
      };
      // ===== 场景 E：植入线索（无指令）=====
      // 在最近正文里插一句提到旧专名的话（模拟用户自己写了一句"她想起胡桃妹妹说过的话"），
      // 无指令续写，金标 = 该专名首次出现的子块（很早、已滚入归档）。考"能不能顺着线索召回"。
      // 三个变体：cueEnd（句末直呼其名）/ cueMid（放在窗口中部，距今 ~4k 字）/ cueVague（只用简称）。
      const mkCue = (mode: 'cueEnd' | 'cueMid' | 'cueVague' | 'cueNone') => {
        const out: { t: number; ctx: Ctx; gold: Gold; cue: string }[] = [];
        const used = new Set<string>();
        const perChildE = new Map<number, number>();   // 每个模式独立去重（四个模式互为对照，题目集应尽量对齐）
        for (const w of wbTerms) {
          if (out.length >= LIMIT) break;
          if (!w || w.length < 2 || w.length > 6) continue;
          if (used.has(w)) continue;
          const first = canonical.indexOf(w);
          if (first < 0 || first > canonical.length * 0.45) continue;   // 首次出现必须在很前面
          const ci = childOf(first);
          if (ci < 0) continue;
          const goldCh = labelIndex.children[ci];
          const t = canonical.length - 8000 - 3000;                     // 提问点固定在书尾附近，保证金标早已归档
          if (t - ROLL_WINDOW < 60000) continue;
          if ((perChildE.get(ci) || 0) >= MAX_PER_CHILD) continue;
          // 窗口里（不含线索句）不能已经出现该名，否则不是"召回"
          const winStart = Math.max(0, t - 12000);
          if (canonical.slice(winStart, t).indexOf(w) >= 0) continue;
          // 变体：直呼其名 vs 简称（取末 2 字，须在语料里出现过 ≥2 次——近似世界书别名的成立条件）
          let cue = '';
          if (mode === 'cueVague') {
            const short = w.slice(-2);
            if (short.length < 2 || canonical.split(short).length - 1 < 2) continue;
            cue = '她忽然想起那个' + short + '。';
          } else if (mode !== 'cueNone') {
            cue = '她忽然想起' + w + '说过的话。';
          }
          perChildE.set(ci, (perChildE.get(ci) || 0) + 1);
          used.add(w);
          out.push({ t, gold: { terms: [w], spans: [goldCh.text] }, ctx: { t, band0: '', bands: [], recentText: '', dictUnion: [], wbTerms: [], instruction: '', budget: BUDGET, coveredEnd: 0 }, cue });
        }
        return out;
      };
      const QsE: { t: number; ctx: Ctx; gold: Gold; cue: string; mode: string }[] = [];
      (['cueNone', 'cueEnd', 'cueMid', 'cueVague'] as const).forEach(mode => {
        mkCue(mode).forEach(q => QsE.push({ ...q, mode }));
      });
      console.log('[ab] 场景E（植入线索）题：', ['cueNone', 'cueEnd', 'cueMid', 'cueVague'].map(m => m + '=' + QsE.filter(q => q.mode === m).length).join(' / '));

      const QsC = mkNamed('C');
      const QsC2 = mkNamed('C2');
      const QsD = mkNamed('D');
      console.log('[ab] 场景A题', QsA.length, '| B题', QsB2.length, '（候选', cands.size, '）| C题(点名高频)', QsC.length, '| C2题(在场不点名)', QsC2.length, '| D题(单字简称)', QsD.length);

      // 每题的 band0/bands/recentText/coveredEnd（回放时重算，保证与滚窗一致）
      const prep = (q: { t: number; ctx: Ctx; cue?: string }) => {
        const covered = blocks.filter(b => b.end <= Math.max(0, q.t - ROLL_WINDOW)).length;
        q.ctx.coveredEnd = covered > 0 ? blocks[covered - 1].end : 0;
        q.ctx.band0 = canonical.slice(Math.max(0, q.t - 2000), q.t);
        q.ctx.bands = [q.ctx.band0];
        for (let i = 1; i < 6; i++) { const e = q.t - 2000 * i; if (e <= 0) break; q.ctx.bands.push(canonical.slice(Math.max(0, e - 2000), e)); }
        q.ctx.recentText = canonical.slice(Math.max(0, q.t - 12000), q.t);
        // 场景 E：把线索句植入最近正文（cueMid 放窗口中段，其余放句末）
        const cue = (q as { cue?: string }).cue;
        const mode = (q as { mode?: string }).mode;
        if (cue) {
          const NL = String.fromCharCode(10);
          if (mode === 'cueMid') {
            const at = Math.max(0, q.ctx.recentText.length - 4000);
            q.ctx.recentText = q.ctx.recentText.slice(0, at) + NL + cue + NL + q.ctx.recentText.slice(at);
            q.ctx.band0 = q.ctx.band0 + NL + cue;   // band0 是最后 2000 字，线索落在窗口中段时只进 recentText
          } else {
            q.ctx.band0 = q.ctx.band0 + NL + cue;
            q.ctx.recentText = q.ctx.recentText + NL + cue;
          }
        }
      };
      const all = QsA.concat(QsB2, QsC, QsC2, QsD, QsE);
      all.forEach(prep);
      console.log('[ab] 世界书词示例：', wbTerms.slice(0, 12).join('/'));

      type Row = Record<string, { term: number; span: number; all: number; chars: number; prec: number; termMask: number[]; spanMask: number[] }>;
      const resA: Row[] = QsA.map(() => ({}));
      const resB: Row[] = QsB2.map(() => ({}));
      const resC: Row[] = QsC.map(() => ({}));
      const resC2: Row[] = QsC2.map(() => ({}));
      const resD: Row[] = QsD.map(() => ({}));
      const resE: Row[] = QsE.map(() => ({}));
      const origLearn = ArchiveStore._learnDictionary as unknown;
      const origExtra = ArchiveIndex._extraDict as unknown;
      const setEnv = (learnOn: boolean, extra: string[]) => {
        (ArchiveStore as unknown as { _learnDictionary: unknown })._learnDictionary = learnOn ? origLearn : function () { return false; };
        (ArchiveIndex as unknown as { _extraDict: unknown })._extraDict = function () { return { words: extra.slice(), alias: {} }; };
      };
      const score = (pieces: Piece[], gold: Gold) => {
        const s = scorePieces(pieces, gold);
        return { term: s.termRecall, span: s.spanRecall, all: s.allHit, chars: s.chars, prec: s.precision, termMask: s.termMask, spanMask: s.spanMask };
      };
      // 打分分词替换为纯 bigram（词典 trie 保留给实体识别/直收）——提案 A 的探针实现
      const origTokenize = (ArchiveIndex as unknown as { tokenize: (t: string) => string[] }).tokenize;
      const bigramOnly = function (text: string): string[] {
        if (!text) return [];
        const toks: string[] = [];
        const en = text.toLowerCase().match(/[a-z0-9]+/g);
        if (en) toks.push(...en);
        const cn = text.match(/[一-鿿]/g);
        if (cn) {
          for (let i = 0; i + 1 < cn.length; i++) { const bg = cn[i] + cn[i + 1]; if (!BM25StopwordsX.has(bg)) toks.push(bg); }
          cn.forEach(c => { if (!BM25StopwordsX.has(c)) toks.push(c); });
        }
        return toks;
      };
      const runPass = (pass: 'p1' | 'p2' | 'p3' | 'p4', extra: string[], learnOn: boolean) => {
        setEnv(learnOn, extra);
        (ArchiveIndex as unknown as { tokenize: unknown }).tokenize = pass === 'p4' ? bigramOnly : origTokenize;
        ArchiveStore.clear();
        ArchiveIndex.invalidate();
        let next = 0;
        const cells = PASS_CELLS[pass].map(k => CELLS.find(c => c.key === k)!);
        const runOne = (q: { t: number; ctx: Ctx; gold: Gold }, sink?: Record<string, ReturnType<typeof score>>) => {
          while (next < blocks.length && blocks[next].end <= Math.max(0, q.t - ROLL_WINDOW)) { ArchiveStore.addBlocks([blocks[next].text], 900); next++; }
          q.ctx.dictUnion = wbTerms.concat(ArchiveStore.dictWords()).filter((w, i, a) => a.indexOf(w) === i);
          q.ctx.wbTerms = wbTerms;
          const o = sink || {};
          for (const c of cells) o[c.key] = score(runCell(q.ctx, c.sw), q.gold);
          return o;
        };
        QsA.forEach((q, i) => { const o = runOne(q, resA[i] as never); void o; });
        QsB2.forEach((q, i) => { const o = runOne(q, resB[i] as never); void o; });
        QsC.forEach((q, i) => { const o = runOne(q, resC[i] as never); void o; });
        QsC2.forEach((q, i) => { const o = runOne(q, resC2[i] as never); void o; });
        QsD.forEach((q, i) => { const o = runOne(q, resD[i] as never); void o; });
        QsE.forEach((q, i) => { const o = runOne(q, resE[i] as never); void o; });
      };
      runPass('p1', wbTerms, true);   // 自学词典开（索引+查询两侧）
      runPass('p2', wbTerms, false);  // 自学关，世界书进索引
      runPass('p3', [], false);       // 词典全关
      runPass('p4', wbTerms, true);   // 提案 A：词典只做实体识别 + 纯 bigram 打分
      (ArchiveIndex as unknown as { tokenize: unknown }).tokenize = origTokenize;
      (ArchiveStore as unknown as { _learnDictionary: unknown })._learnDictionary = origLearn;
      (ArchiveIndex as unknown as { _extraDict: unknown })._extraDict = origExtra;

      const pct = (x: number) => isNaN(x) ? '-' : (x * 100).toFixed(1) + '%';
      const binom = (k: number, n: number): number => {
        const pmf = (i: number) => { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); return c * Math.pow(0.5, n); };
        const obs = pmf(Math.min(k, n - k));
        let p = 0;
        for (let i = 0; i <= n; i++) if (pmf(i) <= obs + 1e-12) p += pmf(i);
        return Math.min(1, p);
      };
      const table = (rows: Row[], qs: { gold: Gold }[], title: string) => {
        const keys = CELLS.map(c => c.key).filter(k => rows.some(r => r[k]));
        const tbl = keys.map(k => {
          const vals = rows.map(r => r[k]).filter(Boolean);
          const termMask = vals.flatMap(v => v.termMask);
          const spanMask = vals.flatMap(v => v.spanMask);
          const fullV = rows.map(r => ({ k: r[k], base: r.full })).filter(x => x.k && x.base);
          const allMask = fullV.map(x => (x.k.all === 1 ? 1 : 0));
          const baseMask = fullV.map(x => (x.base.all === 1 ? 1 : 0));
          let b = 0, c2 = 0;
          allMask.forEach((a, i) => { if (a === 1 && baseMask[i] === 0) b++; if (a === 0 && baseMask[i] === 1) c2++; });
          const p = (k === 'full') ? NaN : binom(b, b + c2);
          return {
            格子: k,
            词命中: pct(termMask.reduce((a, v) => a + v, 0) / Math.max(1, termMask.length)),
            段命中: pct(spanMask.reduce((a, v) => a + v, 0) / Math.max(1, spanMask.length)),
            全中: pct(vals.reduce((a, v) => a + v.all, 0) / Math.max(1, vals.length)),
            注入精度: pct(vals.reduce((a, v) => a + v.prec, 0) / Math.max(1, vals.length)),
            平均注入字数: Math.round(vals.reduce((a, v) => a + v.chars, 0) / Math.max(1, vals.length)),
            'vs full 赢/输': k === 'full' ? '-' : b + '/' + c2,
            p值: isNaN(p) ? '-' : p.toFixed(4),
          };
        });
        console.log('\n===== ' + title + '（' + path.basename(TXT) + '，' + rows.length + ' 题，预算 ' + BUDGET + '）=====');
        console.table(tbl);
        return tbl;
      };
      const tA = table(resA, QsA, '场景A 无指令（主动回忆）');
      const tB = table(resB, QsB2, '场景B 点名（唯一低频专名）');
      const tC = table(resC, QsC, '场景C 点名高频实体（词典主场）');
      const tC2 = table(resC2, QsC2, '场景C2 实体在场但不点名（stableEntities 专属）');
      const tD = table(resD, QsD, '场景D 单字简称点名（桥接）');
      const tE: Record<string, unknown>[] = [];
      (['cueNone', 'cueEnd', 'cueMid', 'cueVague'] as const).forEach(mode => {
        const idx = QsE.map((q, i) => (q.mode === mode ? i : -1)).filter(i => i >= 0);
        if (idx.length) tE.push(...table(idx.map(i => resE[i]), idx.map(i => QsE[i]), '场景E 植入线索·' + mode).map(r => Object.assign({ 模式: mode }, r)));
      });

      fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
      const name = path.basename(TXT).replace(/[^\w\u4e00-\u9fff.-]/g, '_');
      fs.writeFileSync(path.join(HERE, 'out', 'dictablation_' + name + '.json'), JSON.stringify({
        corpus: TXT, chars: canonical.length, budget: BUDGET, limit: LIMIT, wbTerms: wbTerms.length,
        A: { questions: QsA.length, table: tA, detail: QsA.map((q, i) => ({ t: q.t, coveredEnd: q.ctx.coveredEnd, coverage: Math.min(1, BUDGET / Math.max(1, q.ctx.coveredEnd)), gold: q.gold.terms, ...resA[i] })) },
        B: { questions: QsB2.length, table: tB, detail: QsB2.map((q, i) => ({ t: q.t, coveredEnd: q.ctx.coveredEnd, coverage: Math.min(1, BUDGET / Math.max(1, q.ctx.coveredEnd)), entity: q.gold.terms[0], ...resB[i] })) },
        C: { questions: QsC.length, table: tC, detail: QsC.map((q, i) => ({ t: q.t, asked: q.gold.terms[0], ...resC[i] })) },
        C2: { questions: QsC2.length, table: tC2, detail: QsC2.map((q, i) => ({ t: q.t, entity: q.gold.terms[0], ...resC2[i] })) },
        E: { modes: tE, detail: QsE.map((q, i) => ({ t: q.t, mode: q.mode, entity: q.gold.terms[0], cue: q.cue, ...resE[i] })) },
        D: { questions: QsD.length, table: tD, detail: QsD.map((q, i) => ({ t: q.t, asked: q.ctx.instruction.slice(-5, -4), full: q.gold.terms[0], ...resD[i] })) },
      }, null, 1));
      console.log('[ab] 报告写入 out/dictablation_' + name + '.json');
    });
  }
});
