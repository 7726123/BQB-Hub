// 端到端生成 A/B：把「归档回读注入」直接作用到续写文本上，量化它到底有没有用。
// 场景 = 无输入续写（用户只点"继续写"，没有指令）——召回完全靠最近上下文，正是当前短板。
//
// 三组对照（同一点、同参、独立采样）：
//   无注入   —— 只给最近窗口（地板）
//   随机注入 —— 同样注入 N 字归档原文，但随机取块（区分"多给旧文本就有用" vs "选得对才有用"）
//   生产注入 —— 生产管线（直收+门槛+合并+预算填充）选出的回读片段
//
// 指标：
//   ① 金标回调率：生成文本是否提到「真实后文会提到的旧专名」（extractGold，客观、与检索无关）
//   ② 回读利用率：注入文本里「窗口中没有的稀有词」有多少出现在生成文本里（三组用同一份基准词表）
//   ③ LLM 盲评：给窗口+真实后文，二选一判断哪版更好（位置随机，报告治疗组胜率）
//
// 用法（密钥只走环境变量）：
//   DBAPI_KEY=... DBAPI_URL=https://api.commandcode.ai/provider/v1 DBAPI_MODEL=deepseek/deepseek-v4.1-flash \
//   GQ_N=6 GQ_JUDGE=6 npx vitest run --config tools/retrieval-eval/vitest.config.ts genquality
// 环境变量：EVAL_TXT 语料 / GQ_N 点数 / GQ_JUDGE 盲评对数 / GQ_OUT 生成长度 / GQ_NOAPI=1 只跑检索不调 API
import '../../src/infra/storage';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { ArchiveStore } from '../../src/domain/archive';
import { ArchiveIndex } from '../../src/lib/bm25';
import { loadCanonical, splitBlocksProd, buildLabelIndex, buildPmiStats, extractGold, mulberry32, norm, type Gold, type Piece } from './lib/core';
import * as S from './lib/systems';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const URL_ = (process.env.DBAPI_URL || 'https://api.commandcode.ai/provider/v1').replace(/\/$/, '');
const KEY = process.env.DBAPI_KEY || '';
const MODEL = process.env.DBAPI_MODEL || 'deepseek/deepseek-v4.1-flash';
const N = Number(process.env.GQ_N || 10);
const JUDGE_N = Number(process.env.GQ_JUDGE || 6);
const MAXOUT = Number(process.env.GQ_OUT || 1600);
const NOAPI = process.env.GQ_NOAPI === '1';
const BUDGET = 30000, WINDOW = 12000, FUTURE = 3000, ROLL_WINDOW = 12000, WARMUP = 60000, STEP = 4000;

const WRITER_SP = '你是一位中文轻小说作家。请在给定前文的基础上自然续写，保持人物性格、称呼、设定与文风一致；不要复述前文，不要总结，直接写正文。';

interface Stats { calls: number; pt: number; ct: number; ms: number }
const stats: Stats = { calls: 0, pt: 0, ct: 0, ms: 0 };

async function chat(messages: { role: string; content: string }[], maxTokens: number, temperature: number, effort?: string): Promise<string> {
  const req: Record<string, unknown> = { model: MODEL, messages, max_tokens: maxTokens, temperature, stream: false };
  if (effort) req.reasoning_effort = effort;
  const t0 = Date.now();
  const r = await fetch(URL_ + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(req),
  });
  const txt = await r.text();
  stats.calls++; stats.ms += Date.now() - t0;
  if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + txt.slice(0, 200));
  const j = JSON.parse(txt);
  const u = j.usage || {};
  stats.pt += Number(u.prompt_tokens || 0); stats.ct += Number(u.completion_tokens || 0);
  const ch = (j.choices && j.choices[0]) || {};
  const content = String((ch.message && ch.message.content) || '');
  if (!content) console.log('[gq] 空正文：finish=%s usage=%s', ch.finish_reason, JSON.stringify(u).slice(0, 160));
  return content.trim();
}

/** 「回读独有稀有词」基准：出现在注入文本、但不在窗口里的 2~4 字词（≥2 次），上限 60 */
function recallOnlyTerms(recall: string, windowText: string, dict: string[]): string[] {
  const out: string[] = [];
  for (const w of dict) {
    if (w.length < 2 || w.length > 4) continue;
    if (recall.indexOf(w) < 0 || windowText.indexOf(w) >= 0) continue;
    out.push(w);
    if (out.length >= 60) return out;
  }
  return out;
}

function hitCount(text: string, terms: string[]): number {
  let n = 0;
  for (const t of terms) if (text.indexOf(t) >= 0) n++;
  return n;
}

describe('端到端生成 A/B（无输入续写）', () => {
  it('三组对照：无注入 / 随机注入 / 生产注入', async () => {
    if (!KEY && !NOAPI) { console.log('[gq] 未提供 DBAPI_KEY，跳过'); return; }
    const canonical = loadCanonical(TXT);
    const blocks = splitBlocksProd(canonical);
    const labelIndex = buildLabelIndex(canonical, blocks);
    const pmi = buildPmiStats(canonical);
    const learn = (ArchiveStore as unknown as { _learnDictionary: (s: { dict: string[] }, t: string) => boolean })._learnDictionary;
    const learnDict = (upto: number): string[] => { const fake = { dict: [] as string[] }; for (let i = 0; i < upto; i++) learn.call(ArchiveStore, fake, blocks[i].text); return fake.dict.slice(); };
    const bookDict = learnDict(blocks.length);
    const wbTerms = learnDict(blocks.filter(b => b.end <= WARMUP).length);
    console.log('\n[gq] 语料', path.basename(TXT), canonical.length, '字 | 块', blocks.length, '| 词表', bookDict.length, '| 世界书(合成)', wbTerms.length);

    // 题点：同 A 场景（金标 = 后文将提到的旧专名），均匀取样
    const ts: number[] = [];
    for (let t = WARMUP; t + FUTURE + STEP <= canonical.length; t += STEP) ts.push(t);
    const minArch = Math.min(150000, Math.round(canonical.length * 0.4));
    const cand: { t: number; gold: Gold; coveredEnd: number }[] = [];
    for (const t of ts) {
      const covered = blocks.filter(b => b.end <= Math.max(0, t - ROLL_WINDOW)).length;
      const coveredEnd = covered > 0 ? blocks[covered - 1].end : 0;
      if (coveredEnd < minArch) continue;
      const gold = extractGold(labelIndex, t, { future: FUTURE, coveredEnd, pmi, entityWords: bookDict });
      if (!gold.terms.length) continue;
      cand.push({ t, gold, coveredEnd });
    }
    const picked: typeof cand = [];
    for (let i = 0; i < Math.min(N, cand.length); i++) picked.push(cand[Math.round(i * (cand.length - 1) / Math.max(1, Math.min(N, cand.length) - 1))]);
    console.log('[gq] 候选点', cand.length, '| 本次', picked.length, '个点 × 3 组');

    ArchiveStore.clear();
    ArchiveIndex.invalidate();
    let next = 0;
    type Row = {
      t: number; gold: string[]; recallChars: number;
      arms: Record<string, { text: string; goldHit: number; recallTerms: number; usedChars: number; copied: number }>;
      goldInRecall: number;
    };
    const rows: Row[] = [];
    for (const q of picked) {
      while (next < blocks.length && blocks[next].end <= Math.max(0, q.t - ROLL_WINDOW)) { ArchiveStore.addBlocks([blocks[next].text], 900); next++; }
      const band0 = canonical.slice(Math.max(0, q.t - 2000), q.t);
      const bands = [band0];
      for (let i = 1; i < 6; i++) { const e = q.t - 2000 * i; if (e <= 0) break; bands.push(canonical.slice(Math.max(0, e - 2000), e)); }
      const recentText = canonical.slice(Math.max(0, q.t - WINDOW), q.t);
      const dictUnion = wbTerms.concat(ArchiveStore.dictWords()).filter((w, i, a) => a.indexOf(w) === i);
      const ctx: S.Ctx = { t: q.t, band0, bands, recentText, dictUnion, wbTerms, instruction: '', budget: BUDGET, coveredEnd: q.coveredEnd };
      // 生产注入（无指令：点名通道不触发）
      const prod = S.runMine(ctx);
      const prodText = prod.pieces.map((p: Piece) => '【旧正文】' + p.text).join('\n\n');
      // 随机注入：同长度预算内随机取归档子块
      const rng = mulberry32(q.t || 1);
      const kids = (ArchiveIndex as unknown as { _children: { text: string; blockId: string }[] })._children.slice();
      for (let i = kids.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = kids[i]; kids[i] = kids[j]; kids[j] = tmp; }
      const rPieces: string[] = []; let used = 0;
      for (const k of kids) { if (used + k.text.length > BUDGET && rPieces.length) continue; rPieces.push(k.text); used += k.text.length; if (used >= BUDGET) break; }
      const randText = rPieces.map(t => '【旧正文】' + t).join('\n\n');
      const terms = recallOnlyTerms(prodText, recentText, dictUnion);
      console.log('[gq] t=%d 归档 %d 块 | 生产注入 %d 字 / 随机注入 %d 字 | 回读独有稀有词 %d | 金标 %s',
        q.t, next, prodText.length, randText.length, terms.length, q.gold.terms.join('/'));

      const arms: Row['arms'] = {};
      const win = '## 已完成的正文（历史部分，保证剧情、人物、细节连贯的事实依据）\n' + recentText;
      const ask = '\n\n请接着上面的正文继续写下去，约 600 字。';
      const mkMessages = (recall: string, hint?: string) => (
        recall
          ? [{ role: 'system', content: WRITER_SP }, { role: 'system', content: win },
             { role: 'user', content: (hint ? hint + '\n\n' : '') + '## 归档原文回读（与当前剧情相关的旧正文片段，原样引用）\n' + recall + ask }]
          : [{ role: 'system', content: WRITER_SP }, { role: 'system', content: win }, { role: 'user', content: '请接着上面的正文继续写下去，约 600 字。' }]
      );
      // 抄写检测：生成文本与注入文本的 10 字滑窗重合数（判断模型是否照抄回读）
      const shingles = (t: string) => { const s2 = norm(t); const out = new Set<string>(); for (let i = 0; i + 10 <= s2.length; i++) out.add(s2.slice(i, i + 10)); return out; };
      // 检索侧归因：金标所在子块是否已被注入（把端到端结果与离线检索指标对上）
      const goldInRecall = prodText.replace(/\s+/g, '').indexOf(norm(q.gold.spans[0] || '')) >= 0 ? 1 : 0;
      const STRONG_HINT = '以下是本书此前的正文片段（回读资料，不是当前场景的延续）。如果其中的人物、称呼、旧事与当前场景相关，请在续写中自然呼应；无关则忽略，不要照抄。';
      const armsDef: { name: string; recall: string; hint?: string }[] = [
        { name: '无注入', recall: '' },
        ...(process.env.GQ_RANDOM === '1' ? [{ name: '随机注入', recall: randText }] : []),
        { name: '生产注入', recall: prodText },
        { name: '强提示注入', recall: prodText, hint: STRONG_HINT },
      ];
      for (const a of armsDef) {
        let text = '';
        if (!NOAPI) {
          try { text = await chat(mkMessages(a.recall, a.hint), MAXOUT, 0.85, 'low'); }
          catch (e) { console.log('[gq] %s 生成失败：%s', a.name, String((e as Error).message).slice(0, 140)); }
        }
        const sh = shingles(text);
        let copied = 0; const rsh = shingles(a.recall);
        sh.forEach(x => { if (rsh.has(x)) copied++; });
        arms[a.name] = { text, goldHit: hitCount(text, q.gold.terms), recallTerms: hitCount(text, terms), usedChars: a.recall.length, copied };
      }
      rows.push({ t: q.t, gold: q.gold.terms, recallChars: prodText.length, arms, goldInRecall });
    }

    // ===== LLM 盲评：生产注入 vs 无注入 =====
    const judges: { t: number; winner: string; prodFirst: boolean }[] = [];
    if (!NOAPI && JUDGE_N > 0) {
      for (const r of rows.slice(0, JUDGE_N)) {
        const prodFirst = (Math.floor(r.t / 1000) % 2) === 0;
        const A = prodFirst ? r.arms['生产注入'].text : r.arms['无注入'].text;
        const B = prodFirst ? r.arms['无注入'].text : r.arms['生产注入'].text;
        if (!A || !B) continue;
        const future = canonical.slice(r.t, r.t + 1500);
        const jm = [
          { role: 'system', content: '你是中文轻小说编辑，只回答一个字母：A 或 B。' },
          {
            role: 'user', content: '【前文（节选）】\n' + canonical.slice(Math.max(0, r.t - 4000), r.t)
              + '\n\n【作者真实写下的后文（用于判断哪版更贴合作品走向）】\n' + future
              + '\n\n【A 版续写】\n' + A.slice(0, 1200) + '\n\n【B 版续写】\n' + B.slice(0, 1200)
              + '\n\n哪一版更好地承接前文、呼应旧人物与设定、且不与真实后文冲突？只输出 A 或 B。',
          },
        ];
        try {
          const ans = await chat(jm, 2500, 0, 'low');
          const m = ans.match(/[AB]/);
          const winner = m ? (m[0] === 'A' ? (prodFirst ? '生产注入' : '无注入') : (prodFirst ? '无注入' : '生产注入')) : '无法判定';
          judges.push({ t: r.t, winner, prodFirst });
          console.log('[gq] 盲评 t=%d → %s（%s）', r.t, winner, ans.slice(0, 20).replace(/\n/g, ' '));
        } catch (e) { console.log('[gq] 盲评失败 t=%d：%s', r.t, String((e as Error).message).slice(0, 120)); }
      }
    }

    // ===== 汇总 =====
    const pct = (x: number) => isNaN(x) ? '-' : (x * 100).toFixed(1) + '%';
    const armNames = ['无注入', '随机注入', '生产注入', '强提示注入'].filter(n => rows.some(r => r.arms[n]));
    const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
    const binom = (k: number, n: number): number => {
      if (!n) return 1;
      const pmf = (i: number) => { let c = 1; for (let j = 0; j < i; j++) c = c * (n - j) / (j + 1); return c * Math.pow(0.5, n); };
      const obs = pmf(Math.min(k, n - k)); let p = 0;
      for (let i = 0; i <= n; i++) if (pmf(i) <= obs + 1e-12) p += pmf(i);
      return Math.min(1, p);
    };
    console.log('\n===== 端到端生成结果（' + path.basename(TXT) + '，' + rows.length + ' 点）=====');
    console.table(armNames.map(name => {
      const goldHits = rows.map(r => r.arms[name]?.goldHit || 0);
      const goldTot = rows.reduce((a, r) => a + r.gold.length, 0);
      const termHits = rows.map(r => r.arms[name]?.recallTerms || 0);
      const chars = rows.map(r => (r.arms[name]?.text || '').length);
      return {
        组: name,
        金标命中: pct(goldHits.reduce((a, b) => a + b, 0) / Math.max(1, goldTot)),
        金标命中_均值: mean(goldHits).toFixed(2),
        回读词命中_均值: mean(termHits).toFixed(2),
        抄写10字_均值: mean(rows.map(r => r.arms[name]?.copied || 0)).toFixed(1),
        生成字数_均值: Math.round(mean(chars)),
      };
    }));
    // 配对：生产 vs 无注入 / 生产 vs 随机
    console.log('[gq] 金标块被注入的比例（检索侧）: %d/%d', rows.reduce((a, r) => a + r.goldInRecall, 0), rows.length);
    const paired = [['生产注入', '无注入'], ['强提示注入', '无注入'], ['生产注入', '随机注入'], ['随机注入', '无注入']].filter(([x, y]) => rows.some(r => r.arms[x]) && rows.some(r => r.arms[y])).map(([x, y]) => {
      let win = 0, lose = 0;
      rows.forEach(r => { const a = r.arms[x].recallTerms, b = r.arms[y].recallTerms; if (a > b) win++; else if (a < b) lose++; });
      return { 对比: x + ' vs ' + y, '回读词 赢/输': win + '/' + lose, p: binom(win, win + lose).toFixed(3) };
    });
    console.table(paired);
    if (judges.length) {
      const w = judges.filter(j => j.winner === '生产注入').length;
      const l = judges.filter(j => j.winner === '无注入').length;
      console.log('[gq] 盲评：生产注入胜 %d / 无注入胜 %d / 无法判定 %d（p=%s）', w, l, judges.length - w - l, binom(w, w + l).toFixed(3));
    }
    console.log('[gq] API 调用 %d 次 | prompt %d tok | completion %d tok | 总耗时 %ds', stats.calls, stats.pt, stats.ct, Math.round(stats.ms / 1000));

    fs.mkdirSync(path.join(HERE, 'out'), { recursive: true });
    const name = path.basename(TXT).replace(/[^\w\u4e00-\u9fff.-]/g, '_');
    fs.writeFileSync(path.join(HERE, 'out', 'genquality_' + name + '.json'), JSON.stringify({
      corpus: TXT, model: MODEL, points: rows.length, judge: judges, stats,
      detail: rows.map(r => ({ t: r.t, gold: r.gold, goldInRecall: r.goldInRecall, arms: Object.fromEntries(Object.entries(r.arms).map(([k, v]) => [k, { goldHit: v.goldHit, recallTerms: v.recallTerms, chars: v.text.length, head: v.text.slice(0, 200) }])) })),
    }, null, 1));
    console.log('[gq] 报告写入 out/genquality_' + name + '.json');
  }, 3_300_000);
});
