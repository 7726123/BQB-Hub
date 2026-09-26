// 对话模式解析器（lib/bubble.ts）+ 真实模型输出 fixture 回归。
// 这个文件同时是"格式稳定性"的第一道闸门：fixture 是 2026-09-23 用 deepseek-v4.1-flash
// 对真实格式块跑出来的两类输出（冒号版 / 空格漂移版），改解析器或格式块后必须让它们仍然全绿。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseBubbles, analyzeParse, stripSpeakerPrefixes, NARRATOR } from '../src/lib/bubble';
import { chatFormatBlock, chatRoster, CHAT_BLOCK_VERSION } from '../src/domain/chatprompt';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => readFileSync(resolve(here, 'fixtures', name), 'utf8');

const ROSTER = ['林薇', '陈亦', '苏老师', '林叶'];
const AI = { roster: ROSTER, aliases: { '我': '林叶' } };

// 非标记、非空白字符的多重集（丢字校验用）
const MARK = /[「」『』“”"（）()*：:\s]/g;
function bag(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const ch of String(s).replace(MARK, '')) m.set(ch, (m.get(ch) || 0) + 1);
  return m;
}
const fmt = (m: Map<string, number>) => [...m.entries()].map(([c, n]) => c + n).join(',');

describe('气泡解析：说话人前缀的三种写法', () => {
  it('冒号：已知名字 + 「」台词 + 动作', () => {
    const b = parseBubbles('林薇：「你怎么才来。」\n她把伞收起来。', AI);
    expect(b).toHaveLength(1);
    expect(b[0].speaker).toBe('林薇');
    expect(b[0].known).toBe(true);
    // nlBefore 记录"这块在原文里另起一行"：渲染层只按它换行（块之间不再无条件插 <br>）
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '你怎么才来。' },
      { type: 'act', text: '她把伞收起来。', nlBefore: true },
    ]);
  });

  it('空格：只有名单里的名字才认（实测漂移写法）', () => {
    const b = parseBubbles('白 十月，傍晚五点五十。\n林薇 我替人送的。\n她 站在门口。', AI);
    expect(b.map(x => x.speaker)).toEqual([NARRATOR, '林薇']);
    // 「她 站在门口。」不是名单里的名字 → 归到上一个气泡里，不另开
    expect(b[1].blocks.map(x => x.text).join('')).toContain('她 站在门口。');
  });

  it('方括号：【名字】内容 与 【白】', () => {
    const b = parseBubbles('【林薇】「你还没走。」\n【白】教室只剩四个人。', AI);
    expect(b.map(x => x.speaker)).toEqual(['林薇', NARRATOR]);
  });

  it('名单外的名字仍开气泡（known=false），「注意：」这类词不开', () => {
    const b = parseBubbles('路人甲：「谁啊。」\n注意：这里不该开气泡。', AI);
    expect(b[0].speaker).toBe('路人甲');
    expect(b[0].known).toBe(false);
    // 「注意：」不算说话人 → 这行没有前缀 → 另起一条旁白（不再粘进路人甲的气泡尾部）
    expect(b).toHaveLength(2);
    expect(b[1].speaker).toBe(null);
    expect(b[1].blocks.map(x => x.text).join('')).toContain('这里不该开气泡');
  });

  // 叙述里的「XX：」不是说话人（用户报的"非常奇怪的分段"里就有它：叙述被当成新角色开了气泡+头像）
  it('叙述句不是说话人：带结构助词/副词的候选一律归旁白（她的声音很轻：…）', () => {
    const b = parseBubbles('她的声音很轻：「记得。」\n他沉默了一会儿：终于开口。', AI);
    expect(b).toHaveLength(1);
    expect(b[0].speaker).toBe(null);                       // 旁白，不是「她的声音很轻」这个"角色"
    expect(b[0].blocks.map(x => x.text).join('|')).toBe('她的声音很轻：|记得。|他沉默了一会儿：终于开口。');
    expect(b[0].blocks.map(x => x.type)).toEqual(['act', 'say', 'act']);
  });

  it('名单里的名字不受"叙述"规则影响（即使含这些字也照样认）', () => {
    const b = parseBubbles('和在：「我是名单里的人。」', { roster: ['和在'] });
    expect(b[0].speaker).toBe('和在');
    expect(b[0].known).toBe(true);
  });

  // 用户 2026-09-25：允许路人/同学A 这类"名单外的龙套"说话——名字形状对得上就照常开气泡
  it('龙套（路人甲 / 同学A / 店员）照样开气泡，只是 known=false（首字色块头像）', () => {
    const b = parseBubbles('路人甲：「同学，借过一下。」\n同学A：「他谁啊。」\n店员：「欢迎光临。」', AI);
    expect(b.map(x => x.speaker)).toEqual(['路人甲', '同学A', '店员']);
    expect(b.map(x => x.known)).toEqual([false, false, false]);
    expect(b[0].blocks.map(x => x.type)).toEqual(['say']);
    // 名字里有「的」的说法（隔壁桌的男生）不算说话人——那和叙述句没法区分，别开假气泡
    const c = parseBubbles('隔壁桌的男生：「借过。」', AI);
    expect(c[0].speaker).toBe(null);
  });

  it('名字带称呼后缀也能对上（薇薇姐 → 林薇）', () => {
    const b = parseBubbles('林薇小姐：「请。」', { roster: ROSTER });
    expect(b[0].speaker).toBe('林薇');
    expect(b[0].known).toBe(true);
  });
});

describe('气泡解析：行内样式与容错', () => {
  it('（）与 *…* 都算非语言，星号/括号本身不显示（相邻同类型块合并）', () => {
    const b = parseBubbles('林薇：（她笑了一下）*把信推过来*「你拿着。」', AI);
    expect(b[0].blocks).toEqual([
      { type: 'act', text: '她笑了一下把信推过来' },
      { type: 'say', text: '你拿着。', para: true },      // 说话/非说话 → 分段
    ]);
  });

  it('台词跨行（未闭合的「）也算语言，且不丢后半段', () => {
    const b = parseBubbles('林薇：「我要是想说，\n刚才在走廊上就说了。」', AI);
    expect(b).toHaveLength(1);
    expect(b[0].blocks[0].type).toBe('say');
    expect(b[0].blocks[0].text).toContain('刚才在走廊上就说了。');
  });

  // 混写的引号（“ 开、" 收）以前不认收尾 → 后面的（动作）和叙述一起被吞进深色台词块
  // （用户报的"不是语言的部分却用了深色字体"）
  it('混写引号也认收尾：“您好。"（她鞠了一躬。）', () => {
    const b = parseBubbles('林薇：“您好。"（她鞠了一躬。）', AI);
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '您好。' },
      { type: 'act', text: '她鞠了一躬。', para: true },
    ]);
  });

  it('严格配对优先：嵌套引号仍按原样保留（不因兜底规则被提前截断）', () => {
    const b = parseBubbles('林薇：「她说『好』。」', AI);
    expect(b[0].blocks).toEqual([{ type: 'say', text: '她说『好』。' }]);
  });

  it('无前缀行归上一个气泡；开头就没有前缀则整段归旁白（speaker=null → 渲染成「白」）', () => {
    const b = parseBubbles('她把信放下。\n没有走。\n林薇：「看吧。」', AI);
    expect(b[0].speaker).toBe(null);   // null 才表示"模型没写前缀"，与显式写「白：」区分开（兜底率统计依赖它）
    expect(b[0].blocks.map(x => x.text).join('')).toContain('没有走。');
    expect(b[1].speaker).toBe('林薇');
  });

  it('别名：第一人称的「我」归到主角名下', () => {
    const b = parseBubbles('我：「谁的。」', AI);
    expect(b[0].speaker).toBe('林叶');
    expect(b[0].known).toBe(true);
  });

  it('空输入 / 纯空白 → 空数组，不抛错', () => {
    expect(parseBubbles('')).toEqual([]);
    expect(parseBubbles('   \n\n ')).toEqual([]);
  });
});

describe('作者输入解析（bareIsSay + （）=淡色 + 默认说话人）', () => {
  const USER = { roster: ROSTER, bareIsSay: true, defaultSpeaker: '林叶' };
  it('裸文本算台词，（）内算动作，引号内算台词', () => {
    const b = parseBubbles('哈？你在说什么啊！（站起来。完全听不明白他在说什么！）', USER);
    expect(b).toHaveLength(1);
    expect(b[0].speaker).toBe('林叶');
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '哈？你在说什么啊！' },
      { type: 'act', text: '站起来。完全听不明白他在说什么！', para: true },   // 说话/非说话 → 分段
    ]);
  });
  it('整行被一对括号包住时剥掉最外层（用户习惯写法）', () => {
    const b = parseBubbles('（哈？你在说什么啊！（站起来。））', USER);
    expect(b[0].blocks[0]).toEqual({ type: 'say', text: '哈？你在说什么啊！' });
  });
});

// 2026-09-24 用户报的三条里，两条在解析层：
//   ① "对话内容却是淡色"——模型整篇不写引号时，台词被按"非引号=淡色"渲染了；
//   ② "旁白被放到上一个角色说的话的尾部"——忘写前缀的旁白行被粘进上一个角色气泡。
describe('漂移兜底：台词分色与旁白另起（真机反馈）', () => {
  it('整段没引号的角色气泡：台词按深色，第三人称叙述仍按淡色', () => {
    const b = parseBubbles('林薇 我替人送的。\n林薇 她把手插回口袋，站着没坐。', AI);
    expect(b[0].blocks).toEqual([{ type: 'say', text: '我替人送的。' }]);
    expect(b[1].blocks).toEqual([{ type: 'act', text: '她把手插回口袋，站着没坐。' }]);
  });

  it('同一气泡里台词与叙述混排（真机 fixture 的典型形态）→ 逐句分色', () => {
    const b = parseBubbles('林薇 你先别问。她把手插回口袋，站着没坐。我今天连包都没拿。', AI);
    expect(b[0].blocks.map(x => x.type)).toEqual(['say', 'act', 'say']);
    expect(b[0].blocks[1].text).toBe('她把手插回口袋，站着没坐。');
  });

  it('短句默认当台词（「别拆。」这类没有口语标记的也是台词）', () => {
    const b = parseBubbles('林薇 别拆。', AI);
    expect(b[0].blocks).toEqual([{ type: 'say', text: '别拆。' }]);
  });

  it('正常格式（有引号）里的行内叙述仍按淡色，只是与台词分段', () => {
    const b = parseBubbles('林薇：「林叶。」她没回头。', AI);
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '林叶。' },
      { type: 'act', text: '她没回头。', para: true },
    ]);
  });

  it('白气泡永远整段淡色（不会被兜底染成台词）', () => {
    const b = parseBubbles('白 我把信封放下，压在卷子一角。', AI);
    expect(b[0].blocks).toEqual([{ type: 'act', text: '我把信封放下，压在卷子一角。' }]);
  });

  it('（）/* 里的动作不会被兜底染色（只染裸文本那一段）', () => {
    const b = parseBubbles('林薇 我替人送的。（她笑了一下）', AI);
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '我替人送的。' },
      { type: 'act', text: '她笑了一下', para: true },
    ]);
  });

  it('忘写前缀的旁白：另起一条旁白行，不再粘进上一个角色的气泡尾部', () => {
    const b = parseBubbles('林薇：「你来了。」\n走廊的灯只亮一半。\n她朝窗外看了一眼。', AI);
    expect(b.map(x => x.speaker)).toEqual(['林薇', null]);
    expect(b[0].blocks.map(x => x.text)).toEqual(['你来了。']);
    expect(b[1].blocks.map(x => x.type)).toEqual(['act']);
    expect(b[1].blocks.map(x => x.text).join('').replace(/\n/g, '')).toBe('走廊的灯只亮一半。她朝窗外看了一眼。');
  });

  it('角色自己的续行仍留在同一气泡：多行台词 / 紧接的「她…」动作 / （动作）', () => {
    expect(parseBubbles('林薇：「我要是想说，\n刚才在走廊上就说了。」', AI)).toHaveLength(1);   // 引号没闭合
    expect(parseBubbles('林薇：「你怎么才来。」\n她把伞收起来。', AI)).toHaveLength(1);          // 她…= 自己的动作
    expect(parseBubbles('林薇：「你来了。」\n（她把门带上。）', AI)).toHaveLength(1);             // （动作）
  });

  it('旁白气泡之后的无前缀行继续并进旁白（不再来回开新行）', () => {
    const b = parseBubbles('白：走廊里没人。\n灯还在响。', AI);
    expect(b.map(x => x.speaker)).toEqual([NARRATOR]);
    expect(b[0].blocks[0].text.replace(/\n/g, '')).toBe('走廊里没人。灯还在响。');
  });

  // 用户 2026-09-25 第二天反馈：「那一眼没什么表情。」是叙述却被判成台词（深色）。
  // 三类"短句但明确是叙述"的形态补进 drift 判定：指示代词主语 + 状态、程度补语、看类动作。
  it('短叙述句不再被当成台词：那一眼没什么表情。/ 答得太快。/ 我往门口看了一眼。', () => {
    expect(parseBubbles('林叶 她这才抬了下眼睛，隔着镜片看了我一下。那一眼没什么表情。买什么。', AI)[0].blocks.map(x => x.type))
      .toEqual(['act', 'say']);                                     // 叙述淡色；「买什么。」仍是台词
    expect(parseBubbles('林叶 答得太快。', AI)[0].blocks.map(x => x.type)).toEqual(['act']);
    expect(parseBubbles('林叶 我往门口看了一眼。', AI)[0].blocks.map(x => x.type)).toEqual(['act']);
    // 有第二人称/疑问时仍按台词（宁可漏判）
    expect(parseBubbles('林叶 那一眼没什么表情？', AI)[0].blocks.map(x => x.type)).toEqual(['say']);
    expect(parseBubbles('林叶 那我先走了。', AI)[0].blocks.map(x => x.type)).toEqual(['say']);
  });

  // 用户 2026-09-25 第二天反馈的原始形态：模型把 `我点头。她「哦」了一声。` 折成几行写
  // （`我点头。她` / `哦` / `了一声。`），碎片被逐行当成了短台词 → 深色 + 分段。
  it('折行的碎片接回一句：我点头。她 / 哦 / 了一声。（不分段、不深色）', () => {
    expect(parseBubbles('林叶：我点头。她\n哦\n了一声。', AI)[0].blocks)
      .toEqual([{ type: 'act', text: '我点头。她哦了一声。' }]);
    // 带引号的折行形态也归旁白（引号后面紧跟「了一声」= 被引述的一声）
    const b = parseBubbles('林叶：我点头。她\n「哦」\n了一声。', AI);
    expect(b.map(x => x.blocks.map(y => y.type))).toEqual([['act']]);
    // 模型自己写的换行保留（那是它的分段），但不丢字、也不再是深色
    expect(b[0].blocks.map(x => x.text).join('').replace(/\n/g, '')).toBe('我点头。她哦了一声。');
  });

  // 用户 2026-09-26 反馈：主角气泡里 `我在廊下站着，她就这么扫过去…` 整句被染成深色
  //（同段只有 `她没赶我，也没理我。` 是对的）。主角=第一人称叙述者，它气泡里的"我…"长动作句
  // 只要没有第二人称/疑问/语气词、也没有说话·心理类动词，就当叙述。
  it('主角气泡里的第一人称长动作句是叙述（我在廊下站着…）；短回复与带说话动词的仍是台词', () => {
    const N = { ...AI, narrator: '林叶' };
    const b = parseBubbles('林叶：我在廊下站着，她就这么扫过去，扫到殿角那边，又扫回来，绕着我站的地方兜了半圈。\n她没赶我，也没理我。你叫什么来着。', N);
    expect(b[0].blocks.map(x => x.type)).toEqual(['act', 'say']);
    expect(b[0].blocks[0].text).toContain('我在廊下站着');
    expect(b[0].blocks[1].text).toBe('你叫什么来着。');
    // 边界：短回复 / 带说话·心理动词 / 带第二人称或疑问 → 仍是台词
    for (const t of ['林叶：我知道。', '林叶：我还没拆。', '林叶：我其实早就知道这件事了。', '林叶：我这周末去找你，行不行。', '林叶：我说过这话吗。']) {
      expect(parseBubbles(t, N)[0].blocks.map(x => x.type), t).toEqual(['say']);
    }
    // 没有 narrator 提示时不做这件事（只有对话模式知道谁是叙述者）：
    // 同一条没有"站着"这类动作词的句子，不传 narrator 就是台词、传了才是叙述
    expect(parseBubbles('林叶：我在门口等了半个钟头，她才慢慢腾腾地挪过来。', AI)[0].blocks.map(x => x.type)).toEqual(['say']);
    expect(parseBubbles('林叶：我在门口等了半个钟头，她才慢慢腾腾地挪过来。', N)[0].blocks.map(x => x.type)).toEqual(['act']);
    // 非主角气泡里第一人称照旧是台词（真机 fixture 的形态：林薇在说自己的事）
    expect(parseBubbles('林薇 我去办公室拿名单，路过窗户。', N)[0].blocks.map(x => x.type)).toEqual(['say']);
  });

  // 用 commandcode 端点跑真实生成（4 轮 × 约 1900 字）后按"逐句三态 + 就近/整轮信号"重做的分色。
  // 真机新输出里的形态：**对白都带引号**，只有旁白忘了写「白：」→ 没引号的句子按叙述。
  it('这一轮的对白带引号时：没引号的句子按叙述（门被带上了一半。→ 淡色）', () => {
    const b = parseBubbles('林叶：「我知道了。」\n门被带上了一半。\n信封露出练习册底下一个白角。', AI);
    expect(b.map(x => x.blocks.map(y => y.type))).toEqual([['say', 'act']]);   // 台词深、旁白淡（同一条气泡里）
    expect(b[0].blocks[1].text.replace(/\n/g, '')).toBe('门被带上了一半。信封露出练习册底下一个白角。');
    // 明确是第三人称叙述的整行才另起旁白行
    const c = parseBubbles('林叶：「我知道了。」\n她把伞收起来。', AI);
    expect(c.map(x => x.blocks.map(y => y.type))).toEqual([['say', 'act']]);
  });

  it('整轮一个引号都没有（真漂移）时：拿不准的句子仍按台词——宁可保台词色（1.5.98.1 的教训）', () => {
    expect(parseBubbles('林薇 我还没拆。门被带上了一半。', AI)[0].blocks.map(x => x.type)).toEqual(['say']);
  });

  // 2026-09-25 用户要求「说话内容用「」、其他正常，然后按引号解析」：只要整轮有引号，就一律按引号分色
  //（引号=台词、没引号=叙述），不再按内容猜。代价：模型漏引号的短回应会变淡色 —— 由提示词（v5 硬要求
  // 含单字/短回应）压住；残检见 chat-qa 的遵循度测算。
  it('整轮带引号时按引号分色：没引号的短回应/祈使句一律算叙述（不再按内容猜）', () => {
    const raw = '林叶：「我包呢。」\n林薇：器材室门口。\n林叶：「他去哪儿了。」\n林薇：操场那边；跑着。';
    const bs = parseBubbles(raw, AI);
    expect(bs[1].blocks.map(x => x.type)).toEqual(['act']);        // 器材室门口。（漏引号 → 叙述色）
    expect(bs[3].blocks.map(x => x.type)).toEqual(['act']);
  });

  it('漏引号的短回应在"整轮都没引号"时仍会被兜底成台词（漂移轮不变）', () => {
    const raw = '林叶 我包呢\n林薇 器材室门口。\n林叶 他去哪儿了\n林薇 操场那边；跑着。';
    const bs = parseBubbles(raw, AI);
    expect(bs[1].blocks.map(x => x.type)).toEqual(['say']);        // 没有引号可依据 → 短回答仍按台词
    expect(bs[3].blocks.map(x => x.type)).toEqual(['say']);
  });

  it('「别」的祈使判定：整轮没引号时灯别全关算说话；别的名字/告别不算', () => {
    // 整轮无引号（真漂移）→ 兜底按内容判：祈使句算台词
    expect(parseBubbles('林叶 嗯\n苏老师 灯别全关，值日的留下。', AI)[1].blocks.map(x => x.type)).toEqual(['say']);
    // 整轮有引号 → 一律按引号：没引号的都是叙述
    expect(parseBubbles('林叶：「嗯。」\n苏老师：灯别全关，值日的留下。', AI)[1].blocks.map(x => x.type)).toEqual(['act']);
    const b = parseBubbles('林叶：「嗯。」\n信封上写着别的名字。', AI);
    expect(b[0].blocks.map(x => x.type)).toEqual(['say', 'act']);
  });

  // 真机实测（commandcode 生成，2026-09-25）：模型常把「说话人：」单独写一行、后面每句台词一行且不带前缀。
  // 以前这种行会被当成"忘写前缀的旁白"另起一条旁白行 → 一半台词进了旁白行（没名字、没头像）。
  it('说话人单独一行 + 后续无前缀的引号行：都留在该说话人的气泡里', () => {
    const raw = '陈亦：\n他从后门那边过来，琴盒拎在手上。\n「我爸在楼下等着。」\n他往我柜子那边看了一眼。\n「鞋底是白的。」';
    const bs = parseBubbles(raw, AI);
    expect(bs).toHaveLength(1);
    expect(bs[0].speaker).toBe('陈亦');
    expect(bs[0].blocks.map(x => x.type)).toEqual(['act', 'say', 'act', 'say']);
    expect(bs[0].blocks[3].text).toBe('鞋底是白的。');
  });

  it('第一人称的身体动作/操作是叙述（我把信封翻过来。/ 我抬头。）', () => {
    expect(parseBubbles('林叶 我把信封翻过来。背面空的，封口用胶水粘的，边上有点毛。', AI)[0].blocks.map(x => x.type)).toEqual(['act']);
    expect(parseBubbles('林叶 我抬头。', AI)[0].blocks.map(x => x.type)).toEqual(['act']);
    // 有第二人称 / 祈使词时不降级——那是说话（把台词判成淡色是更严重的错）
    expect(parseBubbles('林薇 你把信给我。', AI)[0].blocks.map(x => x.type)).toEqual(['say']);
    expect(parseBubbles('林薇 别把这事说出去。', AI)[0].blocks.map(x => x.type)).toEqual(['say']);
  });
});

// 用户 2026-09-25：「现在有部分非对话内容也用了深色……很多时候引号内部并不一定是对话内容」。
// 书名/歌名/标语/被强调的词/黑板上写的字都会用「」，它们属于旁白，不该染台词色。
describe('引号里的非对话内容归旁白（真机反馈）', () => {
  const types = (raw: string) => parseBubbles(raw, AI)[0].blocks.map(x => x.type);

  it('被强调的词（她把「就一次」说得很重）→ 淡色，且不与旁白分段', () => {
    const b = parseBubbles('白：她把「就一次」说得很重，重得像在给我划界限。', AI);
    expect(b[0].blocks).toEqual([{ type: 'act', text: '她把就一次说得很重，重得像在给我划界限。' }]);
  });

  it('歌名 / 招牌上写的字 / 叫法 都不算台词', () => {
    expect(types('林薇：她哼起了「四季」的调子。')).toEqual(['act']);
    expect(types('白：牌子上写着「禁止入内」。')).toEqual(['act']);
    expect(types('白：班里管这个叫做「安静角」。')).toEqual(['act']);
  });

  it('英文引号里的单个字（最后一个"叶"的捺）也不算台词', () => {
    expect(parseBubbles('白：最后一个"叶"的捺拖得很长。', AI)[0].blocks)
      .toEqual([{ type: 'act', text: '最后一个叶的捺拖得很长。' }]);
  });

  it('有"说"类动词或冒号引导、带句末标点、有第一/二人称时仍然是台词', () => {
    expect(types('林薇：她说「等一下」就跑了。')).toEqual(['act', 'say', 'act']);
    expect(types('林薇：「值日表」？')).toEqual(['say']);       // 疑问语气 → 是说话
    expect(types('林薇：「好。」')).toEqual(['say']);
    expect(types('林薇：「我知道了。」')).toEqual(['say']);      // 第一人称 → 是说话
  });

  it('引号漏收尾时，尾部明确的叙述拆成旁白（不再整段吞进深色台词块）', () => {
    const b = parseBubbles('林薇：「你先别问。\n她把手插回口袋。', AI);
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '你先别问。' },
      { type: 'act', text: '她把手插回口袋。', nlBefore: true },
    ]);
  });

  // 用户 2026-09-25 第二天反馈：「我点头。她「哦」了一声。」里的「哦」是**别人说的话被叙述引述**，
  // 不是当前角色在说话，却被判成台词 → 深色 + 被拆成三段。判定改为：嵌在叙述句子中间（同一行前后
  // 都接着叙述）的引号一律算引述（淡色、不拆行），不再看人称与语气词。
  it('叙述里引述的一句话（她「哦」了一声）是旁白：不分段也不深色', () => {
    expect(parseBubbles('林叶：我点头。她「哦」了一声。', AI)[0].blocks)
      .toEqual([{ type: 'act', text: '我点头。她哦了一声。' }]);
    // 同一句不写引号（drift）时结果一致
    expect(parseBubbles('林叶：我点头。她哦了一声。', AI)[0].blocks)
      .toEqual([{ type: 'act', text: '我点头。她哦了一声。' }]);
  });

  it('引述里带第一人称/语气词也算引述（她说了句「我先走了」就转身了）', () => {
    expect(parseBubbles('林叶：我把信塞回去，她说了句「我先走了」就转身了。', AI)[0].blocks.map(x => x.type)).toEqual(['act']);
  });

  it('但真对白不降级：引号以句中标点收尾（「我先走了，」她挥了挥手）', () => {
    const b = parseBubbles('林叶：她把伞收好，「我先走了，」她挥了挥手。', AI);
    expect(b[0].blocks.map(x => x.type)).toEqual(['act', 'say', 'act']);
    expect(b[0].blocks[1].text).toBe('我先走了，');
    // 冒号/说类动词引导的照旧是台词
    expect(parseBubbles('白：她压低声音：「别出声。」', AI)[0].blocks.map(x => x.type)).toEqual(['act', 'say']);
    expect(parseBubbles('林薇：她说「等一下」就跑了。', AI)[0].blocks.map(x => x.type)).toEqual(['act', 'say', 'act']);
  });

  it('旁白（白）气泡里不出现台词块——真机两份 fixture 全量核对', () => {
    for (const name of ['chat-output-colon.txt', 'chat-output-space.txt']) {
      const narr = parseBubbles(fixture(name), AI).filter(b => b.speaker === NARRATOR);
      expect(narr.length, name).toBeGreaterThan(0);
      const bad = narr.filter(b => b.blocks.some(x => x.type === 'say')).map(b => b.blocks.map(x => x.text).join(''));
      expect(bad, name).toEqual([]);
    }
  });
});

// 用户 2026-09-25：「说话的内容和非说话的内容要分段，不要直接连着」（此前两人连排，同一行里
// 颜色从深变淡，看着像染色出错）。换行前把下一块开头的标点收进上一块——新行不以标点开头。
describe('说话与非说话分段（真机反馈）', () => {
  it('台词 + 行内叙述：叙述另起一行（para），标点收进台词块', () => {
    const b = parseBubbles('林薇：「风大」，她把手插进口袋里。', AI);
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '风大，' },
      { type: 'act', text: '她把手插进口袋里。', para: true },
    ]);
  });

  it('原文里本来就换行的不再加 para（换行仍由 nlBefore 表达）', () => {
    const b = parseBubbles('林薇：「风大。」\n她把手插进口袋里。', AI);
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '风大。' },
      { type: 'act', text: '她把手插进口袋里。', nlBefore: true },
    ]);
  });

  it('被叙述隔开的台词分成三段（真机 fixture 的典型形态）', () => {
    const b = parseBubbles('林薇：「林叶。」她没回头。「明天他可能不来。你别问我是谁说的。」', AI);
    expect(b[0].blocks.map(x => x.type)).toEqual(['say', 'act', 'say']);
    expect(b[0].blocks.map(x => !!(x.nlBefore || x.para))).toEqual([false, true, true]);
  });

  it('只剩标点的块并进上一块，不留空行（「好」。）', () => {
    const b = parseBubbles('林薇：「好」。', AI);
    expect(b[0].blocks).toEqual([{ type: 'say', text: '好。' }]);
  });
});

describe('丢字不变量：解析只剥标记，内容一个字不少', () => {
  for (const name of ['chat-output-colon.txt', 'chat-output-space.txt']) {
    it(name + ' 的字符多重集完全一致', () => {
      const raw = fixture(name);
      const parsed = parseBubbles(raw, AI).map(b => b.blocks.map(x => x.text).join('')).join('');
      expect(fmt(bag(parsed))).toBe(fmt(bag(stripSpeakerPrefixes(raw, AI))));
    });
  }
});

// 2026-09-26 真机实测定位的症状：「旁白气泡把角色的台词一起吞了」。
// 触发链：模型用「说话人：单独一行 + 台词不带前缀」的写法 → 角色的叙述行被兜底②另起成旁白 →
// 紧接着那条无前缀台词行因为"当前气泡是旁白"被并进旁白（读者看到"旁白里说的是角色的话"）。
// 修正：旁白气泡收到的**无前缀引号行**另起，说话人沿用最近一个有名字的说话人（纯叙述行不受影响）。
const REAL_ROSTER = ['苏黎', '陈默', '老周'];
const REAL_AI = { roster: REAL_ROSTER, aliases: { '我': '苏黎' }, narrator: '苏黎' };
// 出问题那一轮的原样片段（tmp/split-raw-1790394543083-2.txt）
const REAL_SAMPLE = [
  '苏黎：',
  '我把灯搁在钟房的木台上，灯罩还烫手。',
  '城南那段铁轨有擦痕，新的，锈被刮开一道，不像轮子压出来的。',
  '「老周，铁轨上会留印子吗？」',
  '',
  '老周：',
  '「印子？」老周把眼镜往鼻梁上推。「那玩意儿留了七年喽，狗踩的、风刮的，啥印子没得。」',
].join('\n');

describe('旁白气泡不再吞掉无前缀台词行（真机症状回归）', () => {
  it('真机片段：台词归回上一个说话人，旁白气泡里只剩叙述', () => {
    const b = parseBubbles(REAL_SAMPLE, REAL_AI);
    const sayBubbles = b.filter(x => x.blocks.some(k => k.type === 'say'));
    // 没有任何一句台词落在旁白气泡里（修正前：苏黎那句被吞进旁白）
    expect(sayBubbles.every(x => x.speaker !== null)).toBe(true);
    const line = b.find(x => x.blocks.some(k => k.type === 'say' && k.text === '老周，铁轨上会留印子吗？'));
    expect(line && line.speaker).toBe('苏黎');
    // 纯叙述行仍按兜底② 另起旁白（2026-09-25「旁白别算到角色头上」的修复保持有效）
    const narr = b.find(x => x.blocks.some(k => k.text.indexOf('城南那段铁轨有擦痕') === 0));
    expect(narr && narr.speaker).toBe(null);
  });

  it('跨行台词跟着归到同一个说话人（引号没闭合的续行不另开气泡）', () => {
    const src = [
      '苏黎：「先别动。」',
      '屋子里静得能听见钟摆的声音，灰尘在光柱里慢慢地飘。',
      '「你听见了没有，',
      '那口钟又响了。」',
    ].join('\n');
    const b = parseBubbles(src, REAL_AI);
    const tail = b[b.length - 1];
    expect(tail.speaker).toBe('苏黎');
    expect(tail.blocks.map(x => x.text).join('')).toBe('你听见了没有，\n那口钟又响了。');
  });

  it('修正只认"无前缀"的引号行：模型明确写在「白：」行里的引号仍然归旁白（并按既有规则降级成叙述）', () => {
    const src = '苏黎：「谁在那儿？」\n白：远处有人喊了一声「救命」，接着就没了动静。';
    const b = parseBubbles(src, REAL_AI);
    expect(b).toHaveLength(2);
    expect(b[1].speaker).toBe(NARRATOR);                        // 没被算到苏黎头上（修正不碰显式白行）
    expect(b[1].blocks.every(x => x.type === 'act')).toBe(true); // 旁白行里的引号是叙述（引号里的非对话内容归旁白）
    expect(b[1].blocks.map(x => x.text).join('')).toContain('救命');
  });

  it('还没有过"有名字的说话人"时保持原样（首条无前缀台词行仍留旁白）', () => {
    const b = parseBubbles('「我没有名字可归。」\n她走了。', REAL_AI);
    expect(b).toHaveLength(1);
    expect(b[0].speaker).toBe(null);
  });

  it('纯叙述行另起旁白的老行为不变（旁白不会被算到角色头上）', () => {
    const b = parseBubbles('林薇：「你来了。」\n雨下得很大，屋檐上挂着水线，远处的路灯在雨里糊成一团。', AI);
    expect(b).toHaveLength(2);
    expect(b[0].speaker).toBe('林薇');
    expect(b[1].speaker).toBe(null);
  });

  it('修正后仍然一个字不丢（真机片段的字符多重集一致）', () => {
    const parsed = parseBubbles(REAL_SAMPLE, REAL_AI).map(b => b.blocks.map(x => x.text).join('')).join('');
    expect(fmt(bag(parsed))).toBe(fmt(bag(stripSpeakerPrefixes(REAL_SAMPLE, REAL_AI))));
  });
});

describe('真实输出 fixture 回归（格式稳定性）', () => {
  it('冒号版：全部有说话人、零兜底、无格式问题', () => {
    const rep = analyzeParse(fixture('chat-output-colon.txt'), AI);
    expect(rep.bubbles).toBeGreaterThan(30);
    expect(rep.fallbackChars).toBe(0);
    expect(rep.unknownSpeakers).toEqual([]);
    expect(rep.notes).toEqual([]);
    expect(rep.speakers).toContain('林薇');
    expect(rep.sayChars).toBeGreaterThan(200);   // 台词正常加引号
  });

  it('空格漂移版：容错后仍然是零兜底，但会报"台词未加引号"', () => {
    const rep = analyzeParse(fixture('chat-output-space.txt'), AI);
    expect(rep.bubbles).toBeGreaterThan(30);
    expect(rep.fallbackChars).toBe(0);
    expect(rep.notes.join()).toContain('台词未加引号');
  });

  it('格式漂移检测：整段散文（没有任何前缀）会被判为漂移', () => {
    const prose = '她把信放在桌上。'.repeat(20) + '\n' + '他没有回答。';
    const rep = analyzeParse(prose, AI);
    expect(rep.bubbles).toBe(1);
    expect(rep.notes.join()).toContain('格式漂移');
  });
});

// 用户报告：对话模式里"多出一个角色"——主角被当成名单里的第三方角色另开气泡
// （模型会把主角名的姓/名拆开写，甚至并成「温水与和彦」）。这组用例守住解析层的兜底。
describe('主角名的简写与并列写法（不再多出一个角色）', () => {
  const P = {
    roster: ['八奈见杏菜', '温水和彦'],
    aliases: { '我': '温水和彦', '温水': '温水和彦', '和彦': '温水和彦' },
  };

  it('姓/名简写与尊称都归到主角（别名），不是名单外的说话人', () => {
    for (const label of ['温水', '和彦', '温水君']) {
      const b = parseBubbles(label + '：我把门推开。', P);
      expect(b[0].speaker, label).toBe('温水和彦');
      expect(b[0].known, label).toBe(true);
    }
  });

  it('并列写法（温水与和彦）：去掉连接词后能对上名单里的名字 → 同一个人', () => {
    const b = parseBubbles('温水与和彦：「你也在啊。」', { roster: ['八奈见杏菜', '温水和彦'] });
    expect(b[0].speaker).toBe('温水和彦');
    expect(b[0].known).toBe(true);
    // 名单里没有这个名字时不乱认：仍按名单外说话人渲染（宽容优先，绝不丢字）
    const c = parseBubbles('小野与千鹤：「一。」', { roster: ['八奈见杏菜'] });
    expect(c[0].speaker).toBe('小野与千鹤');
    expect(c[0].known).toBe(false);
  });

  it('名单里真有同名角色时以名单为准（别名只是兜底，不抢名单）', () => {
    expect(parseBubbles('温水：我在。', { roster: ['温水', '温水和彦'] })[0].speaker).toBe('温水');
  });

  // 2026-09-25 用户：卡片常用 user 当主角占位符，主角名完全自定义（不在世界书里）。
  // 模型照抄条目里的 user 写「user：」，或者把拉丁名写成大写、大小写混写——都要落到同一个人。
  it('纯拉丁名字大小写不敏感：User/ALICE 也落到名单里的 user/Alice', () => {
    const a = parseBubbles('User：「我在食堂等你。」', { roster: ['user', '林薇'] });
    expect(a[0].speaker).toBe('user');
    expect(a[0].known).toBe(true);
    const b = parseBubbles('ALICE：我在。', { roster: ['Alice'] });
    expect(b[0].speaker).toBe('Alice');
    expect(b[0].known).toBe(true);
    // 中文名没有大小写这回事：行为不变（名单外仍是名单外）
    const c = parseBubbles('林薇：嗯。', { roster: ['苏老师'] });
    expect(c[0].speaker).toBe('林薇');
    expect(c[0].known).toBe(false);
  });

  it('别名键也大小写不敏感：别名表里的 user 命中 User 写法', () => {
    const b = parseBubbles('User：「我在食堂等你。」', { roster: ['林薇'], aliases: { user: '陆离' } });
    expect(b[0].speaker).toBe('陆离');
    expect(b[0].known).toBe(true);
  });
});

describe('格式块：名单/主角/字数渲染', () => {
  it('名单来自世界书角色条目 + 主角，去重保序', () => {
    const roster = chatRoster([{ type: '角色', name: '林薇' }, { type: '世界观', name: '学校' }, { type: '角色', name: '林薇' }, { type: '角色', name: '陈亦' }], '林叶');
    expect(roster).toEqual(['林薇', '陈亦', '林叶']);
  });
  it('格式块含名单、字数与气泡密度锚点', () => {
    const blk = chatFormatBlock({ roster: ROSTER, protagonist: '林叶', lengthWords: 2500 });
    expect(blk).toContain('林薇、陈亦、苏老师、林叶');
    expect(blk).toContain('本次输出约 2500 字');
    expect(blk).toContain('个气泡');
    expect(blk).toContain('林叶');
  });
  it('格式块：引号是硬要求、旁白必须单独一行、作者输入要"演出来"', () => {
    const blk = chatFormatBlock({ roster: ROSTER, protagonist: '林叶', lengthWords: 2500 });
    expect(blk).toContain('台词一律用「」包住');
    expect(blk).toContain('不要跟在某个角色的台词后面');   // 白行独立（用户报的"旁白挂在角色话尾"）
    expect(blk).toContain('作者的输入不会显示给读者');
    expect(blk).not.toContain('不要复述同一句话');          // 旧规则（作者输入已经显示过）已作废
  });

  // 2026-09-25 用户：「让说话内容用「」、其他正常，然后按引号解析」——契约要写死，含单字回应与心声两条边界。
  it('格式块：引号契约写死（全轮零例外/单字回应/心声不加引号/输出前自检）', () => {
    const blk = chatFormatBlock({ roster: ROSTER, protagonist: '林叶', lengthWords: 2500 });
    expect(blk).toContain('硬要求：全轮零例外');
    expect(blk).toContain('「嗯。」「哦。」「知道了。」');       // 单字/短回应最容易漏引号
    expect(blk).toContain('心里想的、没出声的');
    expect(blk).toContain('输出前自检一遍');
    expect(CHAT_BLOCK_VERSION).toBeGreaterThanOrEqual(5);
  });

  // 用户 2026-09-25：「希望让一些不存在世界书的角色说话，比如路人，或者"同学a"这样的」
  it('格式块：允许临时龙套说话，给通用称呼 + 克制要求；名单角色仍必须用名单名', () => {
    const blk = chatFormatBlock({ roster: ROSTER, protagonist: '林叶', lengthWords: 2500 });
    expect(blk).toContain('【临时龙套');
    expect(blk).toContain('路人甲');
    expect(blk).toContain('同学A');
    expect(blk).toContain('不要起有姓有名的正式人名');       // 通用称呼才认得出（也不误导读者）
    expect(blk).toContain('最多 2 个龙套');
    expect(blk).toContain('不写龙套的心理活动');
    expect(blk).toContain('必须用名单上的名字');             // 名单里的角色不许改名/起绰号
    expect(blk).toContain('名单之外只允许【临时龙套】');
  });

  it('主角在名单里带「作者本人·主角」标记，且写明主角=作者、不许分身', () => {    const blk = chatFormatBlock({ roster: ROSTER, protagonist: '林叶', lengthWords: 2500 });
    expect(blk).toContain('林叶（作者本人·主角）');
    expect(blk).toContain('主角就是作者本人');
    expect(blk).toContain('主角只有一个人，不许分身');
    // 没设主角：同一条规则换措辞，且不出现半截标记
    const blk2 = chatFormatBlock({ roster: ROSTER });
    expect(blk2).toContain('主角就是作者本人');
    expect(blk2).not.toContain('作者本人·主角）');
    expect(blk2).toContain('不要给主角另起名字');
  });
});
