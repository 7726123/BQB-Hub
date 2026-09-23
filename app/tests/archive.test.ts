import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/archive';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
import { WorldBookManager as WBM } from '../src/domain/worldbook';
const AS = (globalThis as unknown as { ArchiveStore: typeof import('../src/domain/archive').ArchiveStore }).ArchiveStore;
const WL = (globalThis as unknown as { Waterline: typeof import('../src/domain/archive').Waterline }).Waterline;

describe('ArchiveStore', () => {
  beforeEach(() => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    sm().remove('archive_wb1'); sm().remove('wline_wb1');
    WBM.createBook('书1'); // wb1 场景：固定书 id 由 createBook 生成，测试用 _key 隔离
  });

  it('addBlocks 归档并保留上限', () => {
    AS.addBlocks(['a', 'b', 'c'], 2);
    expect(AS.count()).toBe(2);
    expect(AS.allBlocks().map((b) => b.text)).toEqual(['b', 'c']); // 最旧的被裁
  });

  it('n-gram 词典学习：出现 ≥8 次的 3-6 字词进词表', () => {
    const text = '魔王城的宝库'.repeat(12); // 72 个中文字，"魔王城"出现 12 次
    const s = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    const learned = AS._learnDictionary(s, text);
    expect(learned).toBe(true);
    expect(s.dict).toContain('魔王城');
    expect(s.dictVer === 0).toBe(true); // 由 addBlocks 负责 ++，_learnDictionary 本身不动 dictVer
  });

  it('词典学习实体性过滤：句法碎片不进词典，真名小语料也能过线（门槛下限 4）', () => {
    const s = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    AS._learnDictionary(s, '他不知道为什么要走。'.repeat(10) + '她的表情很复杂。'.repeat(5));
    expect(s.dict).not.toContain('为什么');
    expect(s.dict).not.toContain('的表情');
    const s2 = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    AS._learnDictionary(s2, '文艺社在旧校舍三楼，社团活动很热闹。'.repeat(3) + '放学后大家都往文艺社跑。'.repeat(3));
    expect(s2.dict).toContain('文艺社'); // 出现 6 次 ≥ 门槛 4（旧固定 ≥8 会漏掉）
  });

  it('2 字专名学习：对白高频+叙述验证进词典，纯对白套语不进', () => {
    const s = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    // 小鞠：叙述 5 次（互异句子，避免重复句式的跨词 n-gram 吞掉名字）+ 对白 15 次
    // → 全文 20 ≥ 门槛 16 且叙述 ≥5 → 学
    const fill = '春夏秋冬东南西北山水花鸟风月云雨'.repeat(8);
    const nar = '小鞠坐在窗边看书。' + '小鞠在院子里晒太阳。' + '小鞠抱着猫发呆。' + '小鞠低头写着作业。' + '小鞠抬头看了看我。' + fill;
    const dial = '「小鞠，一起去吗？」「好啊。」'.repeat(15);
    AS._learnDictionary(s, nar + dial);
    expect(s.dict).toContain('小鞠');
    expect(s.dict).not.toContain('拜托');
    // 拜托：只活在对白（叙述 0 次）→ 不学
    const s2 = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    AS._learnDictionary(s2, fill + '「拜托拜托，帮帮我嘛。」'.repeat(20));
    expect(s2.dict).not.toContain('拜托');
    // 谢谢：对白高频但叙述 <5 → 不学（叙述验证下限 5）
    const s3 = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    AS._learnDictionary(s3, fill + '「谢谢，那我就收下了。」'.repeat(20) + '谢谢你呀。'.repeat(3));
    expect(s3.dict).not.toContain('谢谢');
  });

  it('存量词典清洗：句法碎片被过滤并 bump dictVer', () => {
    const s: { blocks: unknown[]; dict: string[]; dictVer: number } = { blocks: [], dict: ['加藤惠', '的表情', '为什么', '长坂坡'], dictVer: 3 };
    const changed = (AS as unknown as { _cleanDict(st: unknown): boolean })._cleanDict(s);
    expect(changed).toBe(true);
    expect(s.dict).toEqual(['加藤惠', '长坂坡']);
    expect(s.dictVer).toBe(4);
  });

  it('wbQueryTerms：条目名+关键词直接进查询词典通道，别名经验证补充', () => {
    AS.clear();
    AS.setHeadProvider(null);
    AS.addBlocks(['彩乃在坡道上被搭话，彩乃转身离开。', '后来大家提起彩乃都说个不停。']);
    const savedGetActiveId = WBM.getActiveId.bind(WBM);
    const savedGetActive = WBM.getActive.bind(WBM);
    (WBM as unknown as { getActiveId(): string | null }).getActiveId = () => savedGetActiveId() || 'wb1';
    (WBM as unknown as { getActive(): unknown }).getActive = () => ({ entries: [{ name: '雨宫彩乃（高中）', keywords: '文艺社', content: '' }] });
    try {
      const terms = AS.wbQueryTerms();
      expect(terms).toContain('雨宫彩乃'); // 条目名剥括号
      expect(terms).toContain('文艺社'); // 关键词字段
      expect(terms).toContain('彩乃'); // 语料验证过的简称（≥2 次）
    } finally {
      (WBM as unknown as { getActiveId(): string | null }).getActiveId = savedGetActiveId;
      (WBM as unknown as { getActive(): unknown }).getActive = savedGetActive;
    }
  });

  it('稀有实体键控：键频门控抑制高频实体，quote 定位原文', () => {
    AS.clear();
    AS.setHeadProvider(null);
    AS.addBlocks(['加藤站在长坂坡的坡道上被搭话，然后转身离开。' + '旁'.repeat(80) + '\n多年以后仍有人提起长坂坡的那次相遇。']);
    const bid = AS.allBlocks()[0].id;
    AS.addEvents([
      { keys: ['加藤', '长坂坡'], quote: '坡道上被搭话', text: '加藤在长坂坡被搭话，拒绝了入社邀请', blockId: bid },
      { keys: ['加藤'], quote: '', text: '加藤的日常小事', blockId: bid },
    ]);
    // 手工注入键频状态（模拟富集完成）：加藤=500 高频，长坂坡=2 稀有
    const s = AS.get() as { keyFreq?: Record<string, number>; totalChars?: number };
    s.keyFreq = { '加藤': 500, '长坂坡': 2 };
    s.totalChars = 120000;
    (AS as unknown as { _save(s: unknown): void })._save(s);
    // 高频键（加藤）单独出现 → 不触发；稀有键（长坂坡）→ 触发并按 quote 定位原文
    expect(AS.recallEvents('加藤今天在家')).toHaveLength(0);
    const rows = AS.recallEvents('加藤重新走过长坂坡，想起那句话', { limit: 4 });
    expect(rows).toHaveLength(1);
    expect(rows[0].keys).toContain('长坂坡');
    expect(rows[0].span).toContain('坡道上被搭话');
  });

  it('实体别名：条目名简称经验证进入键控触发（彩乃 ↔ 雨宫彩乃（高中））', () => {
    AS.clear();
    AS.setHeadProvider(null);
    AS.addBlocks(['彩乃在坡道上被搭话，彩乃转身离开。', '后来大家提起彩乃都说个不停。']);
    const savedGetActiveId = WBM.getActiveId.bind(WBM);
    const savedGetActive = WBM.getActive.bind(WBM);
    (WBM as unknown as { getActiveId(): string | null }).getActiveId = () => savedGetActiveId() || 'wb1';
    (WBM as unknown as { getActive(): unknown }).getActive = () => ({ entries: [{ name: '雨宫彩乃（高中）', content: '' }] });
    try {
      const map = AS.aliasMap();
      expect(map['雨宫彩乃']).toContain('彩乃'); // 简称经语料验证（出现 ≥2 次）成为别名
      AS.addEvents([{ keys: ['雨宫彩乃'], quote: '', text: '雨宫彩乃在坡道被搭话', blockId: AS.allBlocks()[0].id }]);
      const st = AS.get() as { keyFreq?: Record<string, number> };
      st.keyFreq = { '雨宫彩乃': 3, '彩乃': 3 };
      // 窗口只有简称「彩乃」→ 键控经别名命中
      const rows = AS.recallEvents('后来大家提到彩乃', { limit: 4 });
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].keys).toContain('彩乃');
    } finally {
      (WBM as unknown as { getActiveId(): string | null }).getActiveId = savedGetActiveId;
      (WBM as unknown as { getActive(): unknown }).getActive = savedGetActive;
    }
  });

  it('中文少于 60 字不学习', () => {
    const s = { blocks: [] as any[], dict: [] as any[], dictVer: 0 };
    expect(AS._learnDictionary(s, '太短')).toBe(false);
    expect(s.dict).toHaveLength(0);
  });

  it('头部增强：provider 生成的 head 持久化；开关关闭时不生成', async () => {
    AS.clear();
    AS.setHeadProvider(async (blocks) => ({ heads: { [blocks[0].id]: '天台｜雪乃、拓海｜拒绝请求' }, events: [{ i: 0, keys: ['雪乃', '拓海'], quote: '拒绝了拓海的请求', text: '雪乃在天台拒绝了拓海的请求' }] }));
    AS.addBlocks(['测试块内容：' + '甲'.repeat(100)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(AS.allBlocks()[0].head).toBe('天台｜雪乃、拓海｜拒绝请求');
    // 关闭开关：新块不再补头
    sm().set('archiveHeadEnabled', false);
    AS.clear();
    AS.addBlocks(['第二块内容：' + '乙'.repeat(100)]);
    await new Promise((r) => setTimeout(r, 30));
    expect(AS.allBlocks()[0].head).toBeUndefined();
    sm().remove('archiveHeadEnabled');
    AS.setHeadProvider(null);
  });
});

describe('Waterline 水位线生命周期', () => {
  beforeEach(() => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    sm().remove('archive_wb1'); sm().remove('wline_wb1');
    WBM.createBook('书1');
    WL.clear(); AS.clear();
  });

  it('初始：窗口为空 → 追加到 正文末尾-ROLLING', () => {
    const canonical = 'x'.repeat(20000);
    const r = WL.update(canonical, 10000, 15000);
    expect(r.rolled).toBe(0);
    expect(r.x).toBe(0);
    expect(r.head).toBe(canonical.length - WL.ROLLING);
    expect(r.blockCount).toBeGreaterThan(0);
    // frozen 是块的拼接（窗口内容 = canonical[0..head]）
    expect(r.frozen.replace(/\n\n/g, '').length).toBe(r.head);
  });

  it('追加为增量：新正文只在尾部追加新块（不超触发线时 x 不动）', () => {
    const c1 = 'a'.repeat(10000);
    const r1 = WL.update(c1, 20000, 30000); // 高水位：不滚动
    expect(r1.x).toBe(0);
    expect(r1.head).toBe(c1.length - WL.ROLLING);
    const c2 = c1 + 'b'.repeat(2000);
    const r2 = WL.update(c2, 20000, 30000);
    expect(r2.x).toBe(0);
    expect(r2.head).toBe(c2.length - WL.ROLLING);
    expect(r2.head).toBe(r1.head + 2000);
  });

  it('超触发线滚动：最旧块进归档，x 右移，窗口回到水位线（块粒度）', () => {
    // 单次 update 即完成「追加 + 滚动」全流程：30000 字、水位 12000、触发 18000
    const canonical = 'y'.repeat(30000);
    const r = WL.update(canonical, 12000, 18000);
    expect(r.rolled).toBeGreaterThan(0);
    expect(r.x).toBeGreaterThan(0);
    expect(AS.count()).toBe(r.rolled);
    // 滚到水位线附近（块粒度，可能留一块超额）
    expect(r.head).toBeLessThanOrEqual(12000 + WL.BLOCK_SIZE);
    // 窗口与 x 对齐：joined == canonical[x .. x+head]
    const w = WL.get();
    const joined = w.blocks.map((b) => b.text).join('');
    expect(canonical.slice(w.x, w.x + joined.length)).toBe(joined);
  });

  it('正文被撤回（变短）→ 窗口重建', () => {
    const c1 = 'm'.repeat(15000);
    WL.update(c1, 9000, 13000);
    expect(WL.get().blocks.length).toBeGreaterThan(0);
    // 撤回到 8000 字：窗口内容不再匹配 → 重建
    const r = WL.update('n'.repeat(8000), 9000, 13000);
    expect(r.blockCount).toBeGreaterThanOrEqual(0);
    expect(r.head).toBeLessThanOrEqual(8000);
    // 重建后 x 对齐（x = len - ROLLING - water，不为负）
    expect(WL.get().x).toBeGreaterThanOrEqual(0);
  });

  it('MIN_APPEND 以下的小增量不追加（减少中间态）', () => {
    const c1 = 'p'.repeat(12000);
    const r1 = WL.update(c1, 8000, 12000);
    const r2 = WL.update(c1 + 'q'.repeat(100), 8000, 12000); // 100 < MIN_APPEND
    expect(r2.head).toBe(r1.head);
    expect(r2.blockCount).toBe(r1.blockCount);
  });
});