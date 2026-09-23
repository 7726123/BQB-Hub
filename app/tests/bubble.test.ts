// 对话模式解析器（lib/bubble.ts）+ 真实模型输出 fixture 回归。
// 这个文件同时是"格式稳定性"的第一道闸门：fixture 是 2026-09-23 用 deepseek-v4.1-flash
// 对真实格式块跑出来的两类输出（冒号版 / 空格漂移版），改解析器或格式块后必须让它们仍然全绿。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseBubbles, analyzeParse, stripSpeakerPrefixes, NARRATOR } from '../src/lib/bubble';
import { chatFormatBlock, chatRoster } from '../src/domain/chatprompt';

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
    expect(b[0].blocks).toEqual([
      { type: 'say', text: '你怎么才来。' },
      { type: 'act', text: '她把伞收起来。' },
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
    expect(b).toHaveLength(1);
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
      { type: 'say', text: '你拿着。' },
    ]);
  });

  it('台词跨行（未闭合的「）也算语言，且不丢后半段', () => {
    const b = parseBubbles('林薇：「我要是想说，\n刚才在走廊上就说了。」', AI);
    expect(b).toHaveLength(1);
    expect(b[0].blocks[0].type).toBe('say');
    expect(b[0].blocks[0].text).toContain('刚才在走廊上就说了。');
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
      { type: 'act', text: '站起来。完全听不明白他在说什么！' },
    ]);
  });
  it('整行被一对括号包住时剥掉最外层（用户习惯写法）', () => {
    const b = parseBubbles('（哈？你在说什么啊！（站起来。））', USER);
    expect(b[0].blocks[0]).toEqual({ type: 'say', text: '哈？你在说什么啊！' });
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
});
