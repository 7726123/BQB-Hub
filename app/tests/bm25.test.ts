import { describe, it, expect, beforeEach } from 'vitest';
import { BM25, ArchiveIndex } from '../src/lib/bm25';

// ArchiveStore 桩（ensureFresh 的数据源）
const store = { blocks: [] as { id: string; text: string; head?: string }[], dict: [] as string[], dictVer: 1 };
(globalThis as unknown as Record<string, unknown>).ArchiveStore = { get: () => store };

describe('BM25 tokenize', () => {
  it('中文 bigram + 单字 + 英文单词', () => {
    const t = BM25.tokenize('Sakura 樱花飞舞');
    expect(t).toContain('sakura');
    expect(t).toContain('樱花');
    expect(t).toContain('花飞');
    expect(t).toContain('樱');
    // 全部小写
    expect(t.every((x) => x === x.toLowerCase())).toBe(true);
  });
  it('空输入', () => {
    expect(BM25.tokenize('')).toEqual([]);
  });
});

describe('ArchiveIndex', () => {
  beforeEach(() => {
    ArchiveIndex.configure({ childSize: 800 });
    store.blocks = [
      { id: 'b1', text: '她把青铜钥匙挂在腰间，走进藏书塔。' },
      { id: 'b2', text: '藏书塔的守卫认出了她，点头放行。' },
      { id: 'b3', text: '雨夜的巷子里，伞下二人无言。' }
    ];
    store.dict = [];
    store.dictVer++;
    ArchiveIndex.invalidate();
  });

  it('打分分词（v34）：不吞词内 bigram；实体识别仍认整词', () => {
    store.dict = ['青铜钥匙', '藏书塔'];
    ArchiveIndex.ensureFresh();
    const toks = ArchiveIndex.tokenize('她把青铜钥匙带进藏书塔');
    // 打分走纯 bigram：词典整词不成为 token（整词吞掉词内 bigram 会稀释召回），
    // 词内 bigram 照常产出——「青铜钥匙」= 青铜/铜钥/钥匙
    expect(toks).not.toContain('青铜钥匙');
    expect(toks).toContain('青铜');
    expect(toks).toContain('钥匙');
    // 实体识别（事实卡激活 / 直收）仍用 trie 整词匹配
    expect(ArchiveIndex.matchEntities('她把青铜钥匙带进藏书塔')).toEqual(expect.arrayContaining(['青铜钥匙', '藏书塔']));
  });

  it('停用词被过滤', () => {
    const toks = ArchiveIndex.tokenize('她走进藏书塔');
    expect(toks).not.toContain('她');
  });

  it('search 按相关性返回子块', () => {
    store.dict = ['藏书塔'];
    ArchiveIndex.ensureFresh();
    const hits = ArchiveIndex.search('藏书塔', 2);
    expect(hits.length).toBe(2);
    // 两个块都含词典词；更短的 b2 因 BM25 长度归一化得分更高（单行块各为单子块）
    expect(hits[0].id).toBe('b2#0');
    expect(hits[1].id).toBe('b1#0');
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it('子块切分：长块按段落边界切分，子块文本为块内精确切片', () => {
    const paras = Array.from({ length: 16 }, (_, i) => '段落' + i + '：' + '甲'.repeat(90));
    const text = paras.join('\n');
    store.blocks = [{ id: 'L1', text }];
    store.dict = ['甲'];
    store.dictVer++;
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    expect(ArchiveIndex.childCount()).toBe(2);
    const c0 = (ArchiveIndex as unknown as { _children: { start: number; end: number; text: string }[] })._children[0];
    expect(text.slice(c0.start, c0.end)).toBe(c0.text);
    const hits = ArchiveIndex.search('甲', 10);
    expect(hits.length).toBe(2);
    // 相邻子块合并 → 单一连续片段，且为原文精确切片
    const span = ArchiveIndex.mergeSpans(hits as unknown as { id: string; score: number }[])[0];
    expect(text.includes(span.text)).toBe(true);
    expect(span.text.length).toBeGreaterThan(hits[0].text.length);
  });

  it('mergeSpans：不相邻的子块不合并', () => {
    const paras = Array.from({ length: 16 }, (_, i) =>
      '段' + i + '：' + (i < 4 || (i >= 8 && i < 12) ? '甲' : '乙').repeat(90));
    const text = paras.join('\n');
    store.blocks = [{ id: 'M1', text }];
    store.dict = ['甲', '乙'];
    store.dictVer++;
    ArchiveIndex.configure({ childSize: 400 });
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    expect(ArchiveIndex.childCount()).toBe(4);
    const hits = ArchiveIndex.search('甲', 10);
    expect(hits.length).toBe(2);
    const spans = ArchiveIndex.mergeSpans(hits as unknown as { id: string; score: number }[]);
    expect(spans.length).toBe(2);
    spans.forEach((s) => expect(text.includes(s.text)).toBe(true));
  });

  it('块头并入索引文本：按头中实体可召回，注入仍是纯原文', () => {
    store.blocks = [{ id: 'H1', text: '雨夜的巷子里只有脚步声。', head: '天台｜雪乃、拓海｜雪乃拒绝拓海的请求' }];
    store.dict = ['雪乃'];
    store.dictVer++;
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    const hits = ArchiveIndex.search('雪乃', 5);
    expect(hits.length).toBeGreaterThan(0); // 「雪乃」只出现在头部 → 仍可召回
    expect(hits[0].text.includes('雪乃')).toBe(false); // 注入文本取自块原文，头部不进正文
  });

  it('suggestDfCap 随子块数量放大且有上下限', () => {
    expect(ArchiveIndex.suggestDfCap()).toBeGreaterThanOrEqual(12);
    expect(ArchiveIndex.suggestDfCap()).toBeLessThanOrEqual(200);
  });

  it('别名桥接：数据库主键别名（藏书塔|书塔）双向可达', () => {
    // 真实路径：别名来自 _extraDict 的数据库主键别名
    (globalThis as unknown as Record<string, unknown>).DatabaseManager = {
      getTables: () => [{ id: 't1' }],
      _primaryColumn: () => 'name',
      getRecords: () => [{ values: { name: '藏书塔|书塔' } }]
    };
    try {
      store.dict = [];
      ArchiveIndex.invalidate();
      const hits = ArchiveIndex.search('书塔', 3); // 查询别名 → 应桥接到正名命中
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.id === 'b1#0')).toBe(true); // b1/b2 均含正名，顺序由长度归一化决定
    } finally {
      delete (globalThis as unknown as Record<string, unknown>).DatabaseManager;
      ArchiveIndex.invalidate();
    }
  });

  it('学习词清洗：包含领域词或停用词子串的学习词被丢弃（清空后不回退）', () => {
    store.dict = ['青铜钥匙在腰', '我们走', '青铜钥匙'];
    ArchiveIndex.ensureFresh();
    const ents = ArchiveIndex.matchEntities('青铜钥匙在腰，我们走');
    // 「青铜钥匙在腰」含停用词子串「在」→ 丢；「我们走」含停用词「我们」→ 丢；
    // 只剩干净的学习词。旧实现在清洗为空时会回退未清洗词表（碎片复活），已修。
    expect(ents).toContain('青铜钥匙');
    expect(ents).not.toContain('青铜钥匙在腰');
    expect(ents).not.toContain('我们走');
  });

  it('matchEntities 返回正文命中的词典词', () => {
    store.dict = ['青铜钥匙'];
    const ents = ArchiveIndex.matchEntities('她握紧青铜钥匙，望向藏书塔');
    expect(ents).toContain('青铜钥匙');
  });

  it('无 ArchiveStore 时 ensureFresh 不炸', () => {
    const g = globalThis as unknown as { ArchiveStore?: unknown };
    const saved = g.ArchiveStore;
    delete g.ArchiveStore;
    expect(() => ArchiveIndex.ensureFresh()).not.toThrow();
    g.ArchiveStore = saved;
  });

  it('namedAnchors：指令中 df>8 的高频词按 termCount 降序保底入选', () => {
    const df: Record<string, number> = { '胡桃': 20, '妹妹': 15, '青梅': 3 };
    const tc: Record<string, number> = { '胡桃': 30, '妹妹': 25, '青梅': 5 };
    const getDf = (t: string) => df[t] || 0;
    const anchors = MemoryQueryBuilder.namedAnchors('青梅竹马什么的，但如果有胡桃妹妹就好了', getDf, 2, (t: string) => tc[t] || 0);
    expect(anchors).toEqual(['胡桃', '妹妹']);
  });

  it('build 实体通道：band0 取 df-asc 前 6 + df 最高者保底，指令点名优先', () => {
    const words = Array.from({ length: 15 }, (_, i) => '实体词' + i);
    const text = words.join('在正文里出现。');
    const q1 = MemoryQueryBuilder.build(text, { dict: words, getDf: () => 0 });
    // band0 前 6 + 保底 1（df 并列时末位=最短者）= 7 个实体，无指令/窗口词。
    // band0 是「当前场景主角」来源，不滤 df≥0.9N 的高频实体（主角名全书高频
    // df≈N 也是当前场景主角）；近似虚词过滤只作用于更早窗口带（band1+）。
    // 实体通道领衔的 6 个 + 保底 1 个进查询一次；稳定实体通道（同一批实体，
    // 跨带稳定=隐式意图）再补 ×2 一次 → 14 个 token。
    expect(q1.split(' ').length).toBe(14);
    expect(q1.split(' ')).toContain('实体词0');
    expect(q1.split(' ')).toContain('实体词14'); // df 最高的保底位（并列时取末位）
    const q2 = MemoryQueryBuilder.build('正文里出现实体词3。', {
      dict: words, getDf: () => 0, instruction: '实体词7怎么样',
    });
    expect(q2.split(' ')[0]).toBe('实体词7'); // 指令点名的实体占第一顺位
  });

  it('build 实体通道：df ≥ 0.9N 的近似虚词从窗口来源（band1+）跳过', () => {
    const words = ['小鞠', '可以'];
    const n = 100;
    // 窗口最近带（recentText）不滤高频——主角名八奈见全书高频 df≈N 也是当前场景
    // 主角；近似虚词过滤只作用于更早窗口带（band1+，recentParts[0]）。
    const q = MemoryQueryBuilder.build('窗口正文里出现小鞠和可以。', {
      dict: words, getDf: (t: string) => (t === '可以' ? 95 : 40), n,
    });
    expect(q.split(' ')).toContain('小鞠');
    const qBand1 = MemoryQueryBuilder.build('更早的窗口带。', {
      dict: words, getDf: (t: string) => (t === '可以' ? 95 : 40), n,
      recentParts: ['窗口正文里出现小鞠和可以。'],
    });
    expect(qBand1.split(' ')).toContain('小鞠');
    expect(qBand1.split(' ')).not.toContain('可以'); // 近似虚词在 band1 来源被跳过
    const q2 = MemoryQueryBuilder.build('窗口正文里出现小鞠和可以。', {
      dict: words, getDf: (t: string) => (t === '可以' ? 95 : 40), n, instruction: '可以啊',
    });
    expect(q2.split(' ')).toContain('可以'); // 指令点名则保留
  });

  it('指令点名实体在查询中出现两次（打分权重 ×2）', () => {
    const df: Record<string, number> = { '英梨梨': 20, '加藤': 3 };
    const q = MemoryQueryBuilder.build('', {
      dict: ['英梨梨'], getDf: (t: string) => df[t] || 0,
      instruction: '英梨梨呢', recentParts: [],
    });
    const hits = q.split(' ').filter(t => t === '英梨梨').length;
    expect(hits).toBe(2); // 实体通道一次 + anchor 保底重复一次
  });

  it('稳定实体：覆盖 ≥2 带的词典实体进入查询并 ×2', () => {
    const dict = ['八奈见', '柠檬', '可以'];
    const recentText = '八奈见和柠檬坐在桌边。八奈见在说话。';
    const recentParts = ['八奈见站起来，柠檬看着她。', '八奈见离开了。'];
    // 八奈见 df 40/176≈0.23、柠檬 20≈0.11：都在 0.2N 带内（>35.2）以上 → 保留；
    // 可以 df 160≈0.91 ≥ 0.9N → 排除
    const df: Record<string, number> = { '八奈见': 40, '柠檬': 20, '可以': 160 };
    const q = MemoryQueryBuilder.build(recentText, {
      dict, getDf: (t: string) => df[t] || 0, recentParts, n: 176,
    });
    const toks = q.split(' ');
    // 八奈见：3 带全覆盖、tf 高 → 进查询且重复一次（×2）
    expect(toks.filter(t => t === '八奈见').length).toBe(2);
    // 柠檬：band0+band1 覆盖 → 进查询（×2）
    expect(toks.filter(t => t === '柠檬').length).toBe(2);
    // 可以：df 0.91N ≥ 0.9N → 被排除
    expect(toks).not.toContain('可以');
  });

  it('单字兜底计分：所在子块有 ≥2 字词命中时单字不计分', () => {
    store.blocks = [
      { id: 'S1', text: '甲乙丙丁甲乙丙丁，甲乙相连出现。' },
      { id: 'S2', text: '甲戊甲戊甲戊，只有单字甲。' },
    ];
    store.dict = [];
    store.dictVer++;
    ArchiveIndex.configure({ childSize: 800 });
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    const hits = ArchiveIndex.searchDebug('甲乙', 5);
    const byId: Record<string, { token: string }[]> = {};
    hits.forEach(h => { byId[h.blockId] = h.terms; });
    // S1 有 bigram「甲乙」命中 → 单字甲/乙不进贡献
    expect(byId['S1'].some(t => t.token === '甲乙')).toBe(true);
    expect(byId['S1'].every(t => t.token.length >= 2)).toBe(true);
    // S2 无 bigram 命中 → 单字甲兜底计分
    expect(byId['S2'].some(t => t.token === '甲')).toBe(true);
  });

  it('L2 单字兜底：块有词典整词命中时单字仍计分（不再被整词覆盖压制）', () => {
    store.blocks = [
      // C1：既含词典整词 霞之丘，也含独立单字 霞（晚霞）——旧门控正是在这种块里压掉单字
      { id: 'C1', text: '霞之丘诗羽站在坡道上，晚霞染红了霞之丘的侧脸。' },
      // C2：只有单字 霞（晚霞），没有词典整词
      { id: 'C2', text: '晚霞染红天际，加藤站在坡道上。' },
    ];
    store.dict = ['霞之丘'];
    store.dictVer++;
    ArchiveIndex.configure({ childSize: 800 });
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    // ① 单字查询：块内有词典整词（霞之丘）不再压掉单字 霞 的兜底计分——
    //    单字简称（霞/雪）是有用信号，旧门控（_hasFullCover）已移除
    //    （去掉后无指令场景段命中 21.2%→25.0%）
    let byId: Record<string, { token: string }[]> = {};
    ArchiveIndex.searchDebug('霞', 5).forEach(h => { byId[h.blockId] = h.terms; });
    expect(byId['C1'].some(t => t.token === '霞')).toBe(true);
    expect(byId['C2'].some(t => t.token === '霞')).toBe(true);
    // ② 多字查询：块已被 ≥2 字查询词命中时，单字仍不重复计分（onlyEmpty 规则保留）。
    //    分词是纯 bigram，「霞之丘」以 霞之/之丘 命中（不再有整词 token）
    byId = {};
    ArchiveIndex.searchDebug('霞之丘 霞', 5).forEach(h => { byId[h.blockId] = h.terms; });
    expect(byId['C1'].some(t => t.token === '霞之')).toBe(true);
    expect(byId['C1'].some(t => t.token === '霞')).toBe(false);
  });

  it('rareSingles：非虚字单字 df≥1 保底进查询（霞），虚字/停用字不进', () => {
    const df: Record<string, number> = { '霞': 30, '雪': 5, '的': 170 };
    const q = MemoryQueryBuilder.build('', {
      getDf: (t: string) => df[t] || 0,
      instruction: '霞在雪中', recentParts: [],
    });
    const toks = q.split(' ');
    expect(toks).toContain('霞');
    expect(toks).toContain('雪');
    expect(toks).not.toContain('的');
  });

  it('L3 expandSingles：指令单字 expand 成首字实体全名并 ×2', () => {
    const dict = ['霞之丘诗羽', '霞之丘', '晚霞', '可以', '之丘'];
    const q = MemoryQueryBuilder.build('', {
      dict,
      getDf: (t: string) => (t === '霞' ? 30 : 1),
      instruction: '霞', recentParts: [],
    });
    const toks = q.split(' ');
    // 霞之丘诗羽：首字匹配、边界非虚字 → 桥接进查询且 ×2
    expect(toks.filter(t => t === '霞之丘诗羽').length).toBe(2);
    // 晚霞：首字匹配但末字「霞」是虚字 → 丢弃
    expect(toks).not.toContain('晚霞');
    // 可以/之丘：首字是虚字（可/之）→ 丢弃
    expect(toks).not.toContain('可以');
    expect(toks).not.toContain('之丘');
    // 霞之丘：首字匹配、边界非虚字 → 也桥接（全名优先排序，2 字在内）
    expect(toks).toContain('霞之丘');
  });

  it('mergeSpans 合并长度上限：连排命中超过 ~2.5 子块即断开', () => {
    const paras = Array.from({ length: 16 }, (_, i) => '段' + i + '：' + '甲'.repeat(90));
    const text = paras.join('\n');
    store.blocks = [{ id: 'SP1', text }];
    store.dict = ['甲'];
    store.dictVer++;
    ArchiveIndex.configure({ childSize: 400 });
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
    expect(ArchiveIndex.childCount()).toBeGreaterThan(2);
    const hits = ArchiveIndex.search('甲', 10);
    const spans = ArchiveIndex.mergeSpans(hits as unknown as { id: string; score: number }[]);
    expect(spans.length).toBeGreaterThan(1); // 旧实现会拼成单一长片段
    spans.forEach(s => expect(s.chars).toBeLessThanOrEqual(400 * 2.5 + 1));
  });
});