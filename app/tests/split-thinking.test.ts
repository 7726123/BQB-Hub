// 回归：续写完成时正文与思维链的归属（协议边界，长度不参与判定）
// 协议：<thinking>…</thinking>，`</thinking>` 独占一行；正文以 `【正文】` 开头。
// 未闭合时固定保留在思考框（keep）；只有思考框不渲染（思考强度关/模型自愈停用）才归入正文。
import { describe, it, expect, beforeAll } from 'vitest';

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
// 覆盖 StorageManager.get 以模拟设置项（keep 默认 / to_body）
const withStorage = (pairs: Record<string, unknown>, fn: () => void) => {
  const sm = anyG.StorageManager as { get: (k: string, d?: unknown) => unknown };
  const orig = sm.get;
  sm.get = (k: string, d?: unknown) => (k in pairs ? pairs[k] : orig(k, d));
  try { fn(); } finally { sm.get = orig; }
};

describe('思维链/正文归属（协议边界优先，长度不判定）', () => {
  it('未闭合思考（无正文标记）默认保留在思考框：正文不残留思考，unclosed 标记供提示', () => {
    const s = split('<!-- 梳理：\n推理到一半\n\n正文第二段。她转身离开。');
    expect(s.body).not.toContain('推理到一半');
    expect(s.body).not.toContain('她转身离开');
    expect(s.thoughts.join('\n')).toContain('推理到一半');
    expect(s.unclosed).toBeTruthy();
  });

  it('未闭合思考 + `【正文】` 标记：标记前是思考、标记后是正文（上万字思考也不截断）', () => {
    const cot = '推理'.repeat(5000); // 一万字
    const s = split('<thinking>\n' + cot + '\n【正文】\n正文第二段。她转身离开。');
    expect(s.thoughts.join('')).toContain('推理推理');
    expect(s.thoughts.join('').length).toBeGreaterThanOrEqual(10000);
    expect(s.body).toContain('正文第二段');
    expect(s.body).not.toContain('【正文】');
    expect(s.unclosed).toBe(''); // 有显式边界 → 不算违约
  });

  it('思考框不渲染（思维链关闭）时未闭合思考归入正文，内容不丢', () => {
    withStorage({ deepseekThinking: 'off' }, () => {
      const s = split('<think>\n推理到一半被截断');
      expect(s.body).toContain('推理到一半被截断');
      expect(s.body).not.toContain('<think>');
      expect(s.unclosed).toBeTruthy();
    });
  });

  it('deepseek 系 <think>...</think> 标签 → 内容进思维链、正文保留', () => {
    const s = split('<think>\n剧情推理内容\n</think>\n正文第一段。她转身离开。');
    expect(s.thoughts.join('\n')).toContain('剧情推理内容');
    expect(s.body).toContain('正文第一段');
    expect(s.body).not.toContain('<think>');
    expect(s.unclosed).toBe('');
  });

  it('带空格的标签变体（<thinking > / </think >）完成态同样识别（与流式层一致）', () => {
    const s = split('<thinking >\n梳理内容\n</think >\n正文第一段。');
    expect(s.thoughts.join('')).toContain('梳理内容');
    expect(s.body).toContain('正文第一段');
    expect(s.body).not.toContain('<thinking >');
  });

  it('思考注释内复述未闭合标签 + 正文 → 正文完整、注释内容仍归思考（悬浮球下线后不变）', () => {
    const raw = '<!-- 梳理：\n推理：下一步走向\n<option>示例选项\n-->\n正文第一段。她转身离开。';
    const s = split(raw);
    expect(s.body).toContain('正文第一段。她转身离开。');
    expect(s.body).not.toContain('示例选项');          // 注释里的标签留在思考侧，不进正文
    expect(s.thoughts.join('\n')).not.toContain('她转身离开');
    expect(s.thoughts.join('\n')).toContain('下一步走向');
  });

  it('正常闭合注释：思考与正文分离不变', () => {
    const s = split('<!-- 梳理：\n剧情推理\n-->\n正文第一段。');
    expect(s.thoughts.join()).toContain('剧情推理');
    expect(s.body).toContain('正文第一段');
  });

  it('_buildThinkingHtml 必须闭合 </details>（正文被吞根因）且不带 open（结束默认折叠）', () => {
    const html = (anyG as any)._buildThinkingHtml(['推理内容'], (x: string) => String(x));
    expect(html).toContain('<details class="cot-thinking"');
    expect(html).toContain('</details>');
    expect((html.match(/<details/g) || []).length).toBe((html.match(/<\/details>/g) || []).length);
    expect(html).not.toContain(' open'); // 续写结束思维链默认折叠，点击展开
    // 无思考时返回空串
    expect((anyG as any)._buildThinkingHtml([], (x: string) => String(x))).toBe('');
  });

  it('完全无注释的普通输出：全文即正文', () => {
    const s = split('她转身离开，雨还在下。');
    expect(s.body).toContain('她转身离开');
    expect(s.thoughts).toHaveLength(0);
  });


  // ---- 裸文本思考段（无 <thinking> 标签，如预设自定义起止语）----
  // v1.5.42 起不再做"吾有一梦/前尘已定"这类预设私有起止语的代码剥离——思考段统一由
  // generate 的"思考放 <thinking> 标签"指令收敛到通用标签，裸文本一律视为正文（正文优先）。

  it('裸思考段（无标签，原生模式）：一律当正文，不剥离不吞正文', () => {
    const s = split('吾有一梦，今方始筑：\n推演剧情脉络。\n前尘已定，梦境将演。\n\n她转身离开。');
    expect(s.body).toContain('吾有一梦，今方始筑：');
    expect(s.body).toContain('前尘已定，梦境将演。');
    expect(s.body).toContain('她转身离开。');
    expect(s.thoughts).toHaveLength(0);
  });

  it('裸思考段（非原生模式）：同样当正文，正文优先不误删', () => {
    const s = split('吾有一梦，今方始筑：\n推演。\n前尘已定，梦境将演。\n\n正文第一句。');
    expect(s.body).toContain('正文第一句。');
    expect(s.body).toContain('吾有一梦，今方始筑：');
    expect(s.thoughts).toHaveLength(0);
  });

  it('思考段被 <thinking> 标签包裹（通用标签）：正常剥离进 thoughts、正文纯净', () => {
    const s = split('<thinking>\n吾有一梦，今方始筑：\n推演剧情脉络。\n前尘已定，梦境将演。\n</thinking>\n她转身离开。');
    // body 可能带标签后前导换行（调用方 generate 会 normalize 掉），断言正文内容存在且无标签残留
    expect(s.body).toContain('她转身离开。');
    expect(s.body).not.toContain('<thinking>');
    expect(s.body).not.toContain('</thinking>');
    expect(s.thoughts.join('')).toContain('吾有一梦，今方始筑：');
    expect(s.thoughts.join('')).toContain('前尘已定，梦境将演。');
  });

  it('无标签散句（前尘已定字样在正文）：保留为正文，不误删', () => {
    const s = split('她说到前尘已定，梦境将演。这句话是正文。');
    expect(s.body).toContain('这句话是正文');
    expect(s.thoughts).toHaveLength(0);
  });
});
describe('正文标记剥离（真机 mock 回归）', () => {
  it('思考块正常闭合 + `【正文】` → 标记不进正文、思考完整', () => {
    const cot = '推演：'.repeat(2000);
    const s = split('<thinking>\n' + cot + '\n</thinking>\n【正文】\n雨点敲在伞面上。');
    expect(s.body).not.toContain('【正文】');
    expect(s.body).toContain('雨点敲在伞面上。');
    expect(s.thoughts.join('')).toContain('推演：');
    expect(s.unclosed).toBe('');
  });
  it('正文开头之外偶然出现的 `【正文】` 不动（只剥正文起点）', () => {
    const s = split('她写下「【正文】」三个字。');
    expect(s.body).toContain('【正文】');
  });
});
