// 检索回归（合成语料，零 API）：实体点名 / 场景回忆（词法召回）/ 碎片守卫。
// 说明：版权小说语料不入 git；真实语料的更大回归仍在仓库外本地跑（memory-regression.mjs）。
// 本测试用生成式合成语料固定三类用例，任何对 ArchiveIndex / MemoryQueryBuilder 的改动
// 若让"点名实体召不回"或"查询混入虚字碎片"都会在这里被拦下。
import { describe, it, expect, beforeEach } from 'vitest';
import { ArchiveIndex, MemoryQueryBuilder, BM25, BM25_FN_CHARS } from '../src/lib/bm25';

// 世界书实体词典（模拟世界书条目名 + 数据库主键）
const dict = ['白鲸号', '藏书塔', '青铜钥匙', '灰港'];
const store = { blocks: [] as { id: string; text: string; head?: string }[], dict, dictVer: 1 };
(globalThis as unknown as Record<string, unknown>).ArchiveStore = { get: () => store };

function filler(i: number): string {
  return '清晨的风从窗缝里钻进来，桌上的茶已经凉了。她把书合上，站起身走到门口，又回头看了一眼。'
    + '走廊里传来脚步声，几个学生说笑着经过。她低下头，把围巾往上拉了拉，继续往前走。'
    + '第' + i + '天的天气不算好，云层压得很低。';
}

// 33 块：30 块日常填充 + 3 块植入事件（分散在早/中/晚）
function buildCorpus(): { id: string; text: string }[] {
  const blocks: { id: string; text: string }[] = [];
  for (let i = 0; i < 33; i++) blocks.push({ id: 'f' + i, text: filler(i).repeat(2) });
  blocks[2] = { id: 'ev-ship', text: '那一年冬天，白鲸号在灰港外失踪了。船员们说海面上起了雾，桅杆上的灯一闪就没了。' + filler(2).repeat(2) };
  blocks[15] = { id: 'ev-eave', text: '她记得那场雨。石阶湿滑，两个人挤在狭窄的屋檐下，谁都没有开口。' + filler(15).repeat(2) };
  blocks[25] = { id: 'ev-key', text: '青铜钥匙被她收进抽屉最深处。藏书塔的门在那之后再没开过。' + filler(25).repeat(2) };
  return blocks;
}

describe('检索回归（合成语料，零 API）', () => {
  beforeEach(() => {
    ArchiveIndex.configure({ childSize: 800 });
    store.dict = dict.slice();
    store.dictVer++;
    store.blocks = buildCorpus();
    ArchiveIndex.invalidate();
    ArchiveIndex.ensureFresh();
  });

  const buildQuery = (instruction: string, windowText: string): string =>
    MemoryQueryBuilder.build(windowText, {
      getDf: ArchiveIndex.getDf.bind(ArchiveIndex),
      dfCap: ArchiveIndex.suggestDfCap(),
      dict,
      instruction,
      getCount: ArchiveIndex.termCount.bind(ArchiveIndex),
      recentParts: [windowText],
      n: ArchiveIndex.childCount(),
    });

  const hitsOf = (query: string, k = 8): string[] => ArchiveIndex.search(query, k).map((h) => h.id.split('#')[0]);
  const windowText = filler(0) + filler(1);

  it('实体点名：指令含词典实体（白鲸号）→ 对应旧块被召回', () => {
    const q = buildQuery('不知道白鲸号后来怎么样了，海上的雾散了没有。', windowText);
    expect(q).toContain('白鲸号');
    expect(hitsOf(q)).toContain('ev-ship');
  });

  it('实体点名：主角团高频实体（藏书塔）也不掉队', () => {
    const q = buildQuery('藏书塔那边的门，到底还开不开？', windowText);
    expect(hitsOf(q)).toContain('ev-key');
  });

  it('场景回忆：指令给场景词（屋檐，df=1 的罕见 bigram）→ 走词法召回命中', () => {
    const q = buildQuery('她突然想起屋檐下的那场雨，心里一紧。', windowText);
    expect(q).toContain('屋檐');
    expect(hitsOf(q)).toContain('ev-eave');
  });

  it('碎片守卫：查询不得混入虚字单字/虚字组合碎片（己先/际出/了个 一类）', () => {
    const noisy = '我己先走了，他际出门口的时候，了个什么也没说。比刚还要快。';
    const q = buildQuery(noisy, windowText + noisy);
    const toks = BM25.tokenize(q);
    for (const t of toks) {
      if (t.length === 1) expect(BM25_FN_CHARS.includes(t), '单字虚字碎片: ' + t).toBe(false);
      if (t.length === 2) {
        const bothFn = BM25_FN_CHARS.includes(t[0]) && BM25_FN_CHARS.includes(t[1]);
        expect(bothFn, '双虚字碎片: ' + t).toBe(false);
      }
    }
    // 具体历史碎片形态必须不出现
    for (const frag of ['己先', '际出', '比刚', '了个']) expect(q.includes(frag), '查询残留碎片: ' + frag).toBe(false);
  });

  // 引号点名回归（唯一金标题集实测：带引号的点名曾因 rareBigrams 系列剥离「」而丢名，
  // 命中率 72%→9%；修复后回到 95%+）。这两条守住"用户点名的词必须进查询"。
  it('引号点名：指令里「白鲸号」必须进查询（不被当对白套语剥掉）', () => {
    const q = buildQuery('继续写下去，让角色自然回想起关于「白鲸号」的往事。', windowText);
    expect(q).toContain('白鲸号');
  });

  it('点名符号无关：各种包裹符号里的点名都进点名通道（「」『』（）【】〔〕[]｛｝《》""）', () => {
    const df = (t: string) => (t === '白鲸号' ? 1 : 3);
    for (const wrap of ['「」', '『』', '（）', '【】', '〔〕', '[]', '｛｝', '《》', '“”']) {
      const instr = '继续写下去，' + wrap[0] + '白鲸号' + wrap[1] + '那件事。';
      const named = MemoryQueryBuilder.namedTerms(instr, df, () => 5, 40);
      expect(named, '符号 ' + wrap).toContain('白鲸号');
    }
  });

  it('长跨度旁白不按点名处理（避免旁白词挤占查询）', () => {
    const qt = MemoryQueryBuilder.bracketedTerms('（她坐在逃生梯上，边吃面包边看着书）');
    expect(qt).not.toContain('她坐在逃生梯上，边吃面包边看着书');
    expect(qt.filter(t => t.length > 2).length).toBe(0);
  });

  it('点名通道：namedTerms 取到引号词条与指令罕见词', () => {
    const named = MemoryQueryBuilder.namedTerms(
      '继续写下去，让角色自然回想起关于「白鲸号」和屋檐的往事。',
      ArchiveIndex.getDf.bind(ArchiveIndex), ArchiveIndex.termCount.bind(ArchiveIndex), ArchiveIndex.childCount(),
    );
    expect(named).toContain('白鲸号');
    expect(named).toContain('屋檐');
    // 引号词条：原词条 + 其 bigram（索引 token 粒度）都要在，保证任何分词形态都能命中
    const qt = MemoryQueryBuilder.quotedTerms('关于「白鲸号」与『灰港』');
    expect(qt).toContain('白鲸号');
    expect(qt).toContain('灰港');
  });
});
