// 探针：给定语料 + 一句真实输入 + 提问点，打印生产管线**实际召回了什么**（含召回片段在书中的位置）。
// 用法：
//   PROBE_QUERY='（坐在逃生梯…)' PROBE_T=11000,30000,60000 PROBE_GOLD='惨烈败相|被甩了的少女' \
//   npx vitest run --config tools/retrieval-eval/vitest.config.ts probe
import '../../src/infra/storage';
import path from 'node:path';
import { describe, it } from 'vitest';
import { ArchiveStore } from '../../src/domain/archive';
import { ArchiveIndex } from '../../src/lib/bm25';
import { loadCanonical, splitBlocksProd, buildLabelIndex } from './lib/core';
import * as S from './lib/systems';

const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const INSTRUCTION = process.env.PROBE_QUERY || '';
const TS = (process.env.PROBE_T || '11000,30000,60000').split(',').map(Number);
const MARKERS = (process.env.PROBE_GOLD || '').split('|').map(s => s.trim()).filter(Boolean);
const BUDGET = Number(process.env.EVAL_BUDGET || 30000);
const ROLL_WINDOW = 12000;

describe('探针：真实输入 → 实际召回内容', () => {
  it('打印各提问点的召回明细', () => {
    const canonical = loadCanonical(TXT);
    const blocks = splitBlocksProd(canonical);
    const labelIndex = buildLabelIndex(canonical, blocks);
    console.log('[probe] 语料', path.basename(TXT), canonical.length, '字 | 预算', BUDGET);
    console.log('[probe] 输入：' + INSTRUCTION);
    MARKERS.forEach(m => console.log('[probe] 期望片段标记「%s」首次出现 @%d', m, canonical.indexOf(m)));

    ArchiveStore.clear();
    ArchiveIndex.invalidate();
    let next = 0;
    for (const t of TS) {
      while (next < blocks.length && blocks[next].end <= Math.max(0, t - ROLL_WINDOW)) { ArchiveStore.addBlocks([blocks[next].text], 900); next++; }
      const coveredEnd = next > 0 ? blocks[next - 1].end : 0;
      const band0 = canonical.slice(Math.max(0, t - 2000), t);
      const bands: string[] = [band0];
      for (let i = 1; i < 6; i++) { const e = t - 2000 * i; if (e <= 0) break; bands.push(canonical.slice(Math.max(0, e - 2000), e)); }
      const recentText = canonical.slice(Math.max(0, t - 12000), t);
      const ctx: S.Ctx = { t, band0, bands, recentText, dictUnion: ArchiveStore.dictWords().slice(), wbTerms: [], instruction: INSTRUCTION, budget: BUDGET, coveredEnd };

      console.log('\n════ t=%d ═══ 归档覆盖到 %d 字（最近窗口 %d~%d 字）', t, coveredEnd, Math.max(0, t - 12000), t);
      console.log('  窗口结尾: ' + canonical.slice(Math.max(0, t - 60), t).replace(/\s+/g, ' '));
      const nt = S.namedTermsOf(ctx);
      console.log('  点名锚词条: ' + (nt.length ? nt.map(w => w + '(df=' + ArchiveIndex.getDf(w) + ')').join('  ') : '（无）'));
      const namedPieces = S.namedPassPieces(ctx, 6);
      console.log('  点名通道取回: ' + (namedPieces.length
        ? namedPieces.map(p => '@' + canonical.indexOf(p.text) + ' ' + p.text.slice(0, 34).replace(/\s+/g, ' ')).join('\n                ')
        : '（空）'));

      const systems: [string, { pieces: { blockId: string; text: string }[] }][] = [
        ['新生产 mine', S.runMine(ctx)],
        ['旧生产 mine_old', S.runMine(ctx, { legacy: true })],
        ['仅查询构造 bm25_qb', S.runBm25Qb(ctx)],
      ];
      for (const [name, r] of systems) {
        const text = r.pieces.map(p => String(p.text || '')).join('\n');
        const hit = MARKERS.filter(m => text.indexOf(m) >= 0);
        console.log('  [%s] 注入 %d 条 / %d 字 | 期望片段：%s', name, r.pieces.length, text.length, hit.length ? '✅ 命中（' + hit.join('、') + '）' : '❌ 未召回');
        r.pieces.slice(0, 5).forEach(p => console.log('        @%-7d %s', canonical.indexOf(String(p.text)), String(p.text).slice(0, 46).replace(/\s+/g, ' ')));
      }
    }
  });
});
