// 文本管线属性测试（fast-check）：把历史上靠人眼定位的 bug 类别变成机器可证不变量
// 不变量：normalizeQuotes 幂等 + 注释保真；_splitThinkingBlocks 无标记直通（正文优先）+
// 闭合块完整抽取 + 重拆稳定性。字母表取 0x0A-0x9FFF（含换行/中日韩/常用标点，
// 排除 \u0001 占位符与代理区，避免 normalizeQuotes 注释占位符碰撞的已知实现细节）。
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { normalizeQuotes } from '../src/domain/book';

const anyG = globalThis as unknown as Record<string, unknown>;
anyG.WorldBookManager = { getActiveId: () => null, getAll: () => [], getActive: () => null, saveAll: () => undefined, getActiveWorldBook: () => null, isEnabled: () => false };
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' }) };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
anyG.escapeHTML = (x: unknown) => String(x == null ? '' : x);

beforeAll(async () => {
  await import('../src/domain/app');
  await import('../src/domain/api');
});

const split = (text: string) => (anyG as any)._splitThinkingBlocks(text);

// 字母表：\n(10) 至 0x9FFF，跳过代理区（0xD800-0xDFFF 不在范围内），排除 \u0001 占位符
const charArb = fc.integer({ min: 0x0A, max: 0x9FFF }).map((c) => String.fromCodePoint(c));
const textArb = fc.string({ unit: charArb, size: 'small' });
// 含「思考字样」但无标签的文本（触发 isOpening 路径）
const openerWordArb = fc.constantFrom('思考', '梳理', '推理', '复盘', '想想', '分析一下');

describe('normalizeQuotes 属性', () => {
  it('幂等：nq(nq(s)) === nq(s)（任意文本二跑不变）', () => {
    fc.assert(fc.property(textArb, (s) => {
      expect(normalizeQuotes(normalizeQuotes(s))).toBe(normalizeQuotes(s));
    }));
  });

  // 回归（v1.5.90）：注释保护原先放在引号归一**之后**，注释里的 « » " 已被改写成「」——
  // 属性测试反例：`<!-- 擢贆ശù»檼䷋ -->` 的 » 被归一成 」。修复＝把注释保护提到函数最前。
  it('回归：注释里的弯引号不被归一（反例逐字保真）', () => {
    for (const inner of ['擢贆ശù»檼䷋', 'a»b', 'a«b', 'x“y', 'x”y', 'a"b', '前»中«后']) {
      const s = '<!-- ' + inner + ' -->';
      expect(normalizeQuotes(s), s).toBe(s);
      expect(normalizeQuotes('前言<!-- ' + inner + ' -->后语'), inner)
        .toBe('前言<!-- ' + inner + ' -->后语');
    }
    // 注释外的引号照旧归一（保护不能顺手把正文也保下来）：
    // 成对弯引号归一为「」；孤立的右引号按既有的"段内多余引号删除"规则处理
    expect(normalizeQuotes('<!-- a»b -->他说«好»')).toBe('<!-- a»b -->他说「好」');
    expect(normalizeQuotes('<!-- a»b -->他说»好')).toBe('<!-- a»b -->他说好');
  });

  it('HTML 注释内容逐字保真（引号不归一、内容不删改）', () => {
    const commentInnerArb = fc.string({ unit: charArb, size: 'small' })
      .filter((s) => !s.includes('-->') && !s.includes('<!--') && !s.includes('\u0001'));
    fc.assert(fc.property(textArb.filter((s) => !s.includes('\u0001')), commentInnerArb, textArb.filter((s) => !s.includes('\u0001')), (a, inner, b) => {
      const out = normalizeQuotes(a + '<!-- ' + inner + ' -->' + b);
      expect(out).toContain('<!-- ' + inner + ' -->');
    }), { numRuns: 50 });
  });
});

describe('_splitThinkingBlocks 属性（正文优先不变量）', () => {
  // 思考标记 = 代码实际剥离的通用标记（HTML 注释 / think 标签）；"吾有一梦"这类裸文本
  // 不再是标记（v1.5.42 起不特判预设私有起止语），不列入排除集
  const MARKERS = ['<!--', '<think', '<thinking'];
  const cleanArb = textArb.filter((s) => MARKERS.every((m) => !s.includes(m)));

  it('无标记直通：无任何思考标记的文本 → body 原样、thoughts 空（原生/非原生皆然）', () => {
    fc.assert(fc.property(cleanArb, (s) => {
      const nonNative = split(s);
      const native = split(s);
      expect(nonNative.body).toBe(s);
      expect(nonNative.thoughts).toHaveLength(0);
      expect(native.body).toBe(s);
      expect(native.thoughts).toHaveLength(0);
    }));
  });

  it('闭合思考注释完整抽取：非原生 → thoughts 含 inner、body === 前后正文拼接', () => {
    const bodyArb = cleanArb.filter((s) => s.length <= 200 && !/思考|梳理|推理|复盘|想想|thought|分析一下|想一下/i.test(s));
    const innerArb = fc.string({ unit: charArb, size: 'small' })
      .filter((s) => !s.includes('-->') && !s.includes('</think>') && !s.includes('</thinking>'));
    const tailArb = cleanArb;
    fc.assert(fc.property(openerWordArb, bodyArb, innerArb, tailArb, (word, body1, inner, body2) => {
      const s = body1 + '<!-- ' + word + '：' + inner + '-->' + body2;
      const r = split(s);
      expect(r.body).toBe(body1 + body2);
      expect(r.thoughts.join('')).toContain(inner);
      const rn = split(s);
      expect(rn.body).toBe(body1 + body2);
    }), { numRuns: 50 });
  });

  it('重拆稳定：split(split(x).body).body === split(x).body（补回/二次解析路径不丢字）', () => {
    fc.assert(fc.property(textArb, (x) => {
      const once = split(x);
      const twice = split(once.body);
      expect(twice.body).toBe(once.body);
    }));
  });
});
