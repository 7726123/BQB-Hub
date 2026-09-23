// 自然指令生成器：用 chat 模型把"最近正文 + 需要自然提及的旧对象"写成第一人称的续写输入
// （允许动作/心理/环境描写与对白），产出隐式/显式两版，落盘缓存供评测复用。
//
// 运行：cd app && CC_KEY=... npx vitest run --config tools/retrieval-eval/vitest.config.ts geninstr
// 环境变量：EVAL_TXT / RI_N 题数 / EVAL_BUDGET / EVAL_MIN_ARCHIVE / CC_MODEL
import '../../src/infra/storage';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { loadCanonical, splitBlocksProd, buildLabelIndex } from './lib/core';
import { buildRealQuestions, bookDictOf } from './lib/questions';
import { chatJSON, CC_MODEL, llmStats } from './lib/llm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const BUDGET = Number(process.env.EVAL_BUDGET || 30000);
const RI_N = Number(process.env.RI_N || 40);
const GAP = Number(process.env.EVAL_GAP || 22000);
const MIN_ARCHIVE = Number(process.env.EVAL_MIN_ARCHIVE || 40000);
const CTX_CHARS = Number(process.env.CC_CTX || 1400);

const SYSTEM = [
  '你是一个中文轻小说的"写作输入模拟器"。',
  '给定一部小说的最近正文片段，以及一个需要被自然提及的旧人/旧物/旧事，你要写出"作者接下来会在 AI 写作框里敲进去的那几行字"。',
  '硬性要求：',
  '1. 第一人称、限知视角（"我"就是书中主角），语气与正文一致，轻小说腔；',
  '2. 可以包含动作描写、心理描写、环境描写、对白，怎么自然怎么来；',
  '3. 必须自然地提到指定的旧对象（可以比较、挂念、吐槽、联想、回忆，任选其一）；',
  '4. 与给定的最近正文保持同一场景、同一批在场人物，衔接自然；',
  '5. 严禁出现这些元词汇：请回想、记忆、设定、世界书、检索、剧情、上下文、AI；',
  '6. 长度 30~90 字，1~3 句；不要复述正文里的原句。',
  '输出严格 JSON（不要任何解释）：{"implicit":"<完全不含 想起/记得/回忆/往事/怀念 这类回忆词汇的版本（只是顺口比较或联想）>","explicit":"<带回忆语气的版本>"}',
].join('\n');

describe('自然指令生成（LLM）', () => {
  it('按题集生成并落盘', async () => {
    const canonical = loadCanonical(TXT);
    const blocks = splitBlocksProd(canonical);
    const labelIndex = buildLabelIndex(canonical, blocks);
    const bookDict = bookDictOf(blocks);
    const qs = buildRealQuestions(canonical, labelIndex, bookDict, { budget: BUDGET, gap: GAP, minArchive: MIN_ARCHIVE, n: RI_N });
    console.log('[gen] 语料', path.basename(TXT), '| 题数', qs.length, '| 模型', CC_MODEL);

    const out: Record<string, { entity: string; t: number; anchor: string; implicit: string; explicit: string }> = {};
    for (let i = 0; i < qs.length; i++) {
      const q = qs[i];
      const ctx = canonical.slice(Math.max(0, q.t - CTX_CHARS), q.t);
      const user = '【最近正文】\n' + ctx + '\n\n【要自然提及的旧对象】' + q.entity
        + (q.anchor ? '\n【当前话题（可选参考，不必照抄）】' + q.anchor : '');
      const r = await chatJSON(SYSTEM, user);
      if (r && r.implicit && r.explicit) {
        out[q.t + '|' + q.entity] = { entity: q.entity, t: q.t, anchor: q.anchor, implicit: String(r.implicit).trim(), explicit: String(r.explicit).trim() };
        if (i < 6) console.log('[gen] 样例\n   隐式: ' + out[q.t + '|' + q.entity].implicit + '\n   显式: ' + out[q.t + '|' + q.entity].explicit);
      } else {
        console.log('[gen] 第', i + 1, '题生成失败（实体', q.entity + '）');
      }
      if ((i + 1) % 10 === 0) console.log('[gen] 进度', i + 1, '/', qs.length, '| 调用', llmStats.calls, '缓存', llmStats.cacheHits);
    }
    const outDir = path.join(HERE, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const name = path.basename(TXT).replace(/[^\w\u4e00-\u9fff.-]/g, '_');
    const f = path.join(outDir, 'instructions_' + name + '.json');
    fs.writeFileSync(f, JSON.stringify({ corpus: TXT, model: CC_MODEL, budget: BUDGET, gap: GAP, count: Object.keys(out).length, items: out }, null, 1));
    console.log('[gen] 写入', f, '| 条数', Object.keys(out).length, '| API 调用', llmStats.calls, '缓存命中', llmStats.cacheHits, '解析失败', llmStats.empty);
  }, 3_600_000);
});
