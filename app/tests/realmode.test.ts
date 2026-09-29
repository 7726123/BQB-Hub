// 真实模式的链路与隔离守卫：公共调用（场记）→ 角色调用（唯一说话人）。
// 这里最重要的一组断言是「物理隔离」：任何一次请求里，私有材料只能来自一个角色。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { RealMode } from '../src/domain/realmode';
import { RealState, parseKnowers } from '../src/domain/realstate';
import {
  parsePublicReply, parseRoleReply, formatPublicRecent, readField, splitNames, extractBlocks,
  buildEchoMessages, cleanEcho,
} from '../src/domain/realprompt';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { UsageStats } from '../src/lib/usage';
import { readFileSync } from 'node:fs';

const readSrc = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');

const G = globalThis as any;

function setupBook(): void {
  const b = WBM.createBook('真实模式测试书');
  WBM.setActiveId(b.id);
  const all = WBM.getAll();
  const bk = all.find(w => w.id === b.id)!;
  bk.entries = [
    { id: 'role1', type: '角色', name: '千纱', content: '内向，怕生，说话很短。', inject: true },
    { id: 'role2', type: '角色', name: '悠真', content: '爱开玩笑，话多。', inject: true },
    { id: 'role3', type: '角色', name: '美月', content: '安静，喜欢观察别人。', inject: true },
    { id: 'mem1', type: '初始记忆', name: '千纱的开局', bindId: 'role1', bindName: '千纱', content: '我认识悠真，但不想让他知道那件事。', inject: true },
  ];
  WBM.saveAll(all);
  RealState.reset(b.id);
  RealState.setScene({ time: '次日清晨', place: '教室', present: ['千纱', '悠真', '美月'] });
  RealState.setPlayer('千纱');
}

function stubAPI(replies: string[]): any[] {
  const calls: any[] = [];
  G.APIHandler = {
    fetchCompletions: (msgs: any, onChunk: any, onDone: any, _onErr: any, opts: any) => {
      calls.push({ msgs, opts });
      const r = replies.shift() || '';
      try { onChunk(r); } catch (e) { /* ignore */ }
      onDone(r, false, undefined);
    },
    abort: () => { /* noop */ },
  };
  return calls;
}

function sceneReply(o: {
  time?: string; place?: string; present?: string; events?: string; narration?: string;
  summary?: string; next?: string; heard?: string; shell?: string; common?: string;
}): string {
  return '<场记>\n' +
    '时间：' + (o.time || '次日清晨') + '\n' +
    '地点：' + (o.place || '教室') + '\n' +
    '在场：' + (o.present || '千纱、悠真、美月') + '\n' +
    '公共事件：' + (o.events || '无') + '\n' +
    (o.narration ? '旁白：' + o.narration + '\n' : '') +
    '纪要：' + (o.summary || '早上，教室里。') + '\n' +
    (o.common !== undefined ? '共知：' + o.common + '\n' : '') +
    '接话：' + (o.next || '旁白') + '\n' +
    (o.heard ? '可感：' + o.heard + '\n' : '') +
    (o.shell ? '壳：' + o.shell + '\n' : '') +
    '</场记>';
}

beforeEach(() => {
  G.APIHandler = undefined;
});

// ---------- 解析 ----------
describe('结构化块解析', () => {
  it('场记：读全字段；「无」不算事件；接话去引号', () => {
    const r = parsePublicReply(sceneReply({
      time: '正午', place: '走廊', present: '千纱,悠真', events: '上课铃响了。',
      narration: '午后的走廊很安静。', summary: '两人在走廊碰面。', next: '「悠真」',
    }))!;
    expect(r.time).toBe('正午');
    expect(r.place).toBe('走廊');
    expect(r.present).toEqual(['千纱', '悠真']);
    expect(r.events).toContain('上课铃');
    expect(r.narration).toContain('午后');
    expect(r.summary).toContain('走廊碰面');
    expect(r.next).toBe('悠真');
    const none = parsePublicReply(sceneReply({ events: '无' }))!;
    expect(none.events).toBeUndefined();
  });
  it('场记块的容错：带属性的 <场记 …>、全角＜＞、【场记】、没容器但字段齐全，都能读出来', () => {
    const body = '时间：正午\n地点：走廊\n在场：千纱、悠真\n公共事件：无\n纪要：两人在走廊碰面。\n接话：悠真';
    expect(parsePublicReply('<场记 说明="账本">\n' + body + '\n</场记>')!.next).toBe('悠真');
    expect(parsePublicReply('＜场记＞\n' + body + '\n＜/场记＞')!.place).toBe('走廊');
    expect(parsePublicReply('【场记】\n' + body + '\n【/场记】')!.present).toEqual(['千纱', '悠真']);
    expect(parsePublicReply(body)!.next).toBe('悠真');                       // 没容器也认（字段 ≥2）
    expect(parsePublicReply('时间：正午\n随便聊两句。')).toBeNull();           // 只认出一个字段 → 不认账
  });

  it('不是 <场记> 块 → null（不许瞎猜）', () => {
    expect(parsePublicReply('好的，我来当这个场记。')).toBeNull();
  });
  it('共知：多行清单读得出来；「无/同上」当没变化（调用方保留旧值）', () => {
    const r = parsePublicReply(sceneReply({ common: '- 下周六开运动会\n- 明天停课' }))!;
    expect(r.common).toContain('运动会');
    expect(r.common).toContain('停课');
    expect(parsePublicReply(sceneReply({ common: '（无）' }))!.common).toBeUndefined();
    expect(parsePublicReply(sceneReply({ common: '同上' }))!.common).toBeUndefined();
  });
  it('角色回复：私下说话自动把自己算进可感；壳剥掉；内心留在正文', () => {
    const rep = parseRoleReply('<私下 只说给="悠真">\n<壳>（她低声对悠真说了句什么）</壳>\n旁白：她凑近了些。\n<内心>不能让他看出来。</内心>「……那个，昨天的事。」', '千纱');
    expect(rep.heard).toEqual(['悠真', '千纱']);
    expect(rep.shell && rep.shell.hear).toContain('低声');
    expect(rep.text).not.toContain('只说给');
    expect(rep.text).not.toContain('壳>');
    expect(rep.text).toContain('内心');
  });
  it('没有私下块 → heard 不设（= 在场全体都听得到）', () => {
    expect(parseRoleReply('旁白：她抬起头。\n「早。」', '千纱').heard).toBeUndefined();
  });
  it('readField / splitNames / extractBlocks 的基础行为', () => {
    expect(readField('公共事件：\n- 一\n- 二\n纪要：x', ['公共事件'])).toBe('一\n二');
    expect(readField('接话：甲', ['接话'])).toBe('甲');
    expect(splitNames('甲、乙，丙 丁')).toEqual(['甲', '乙', '丙', '丁']);
    expect(splitNames('（无）')).toEqual([]);
    expect(extractBlocks('a<内心>x</内心>b', '内心').blocks).toEqual(['x']);
    expect(extractBlocks('a<内心>x</内心>b', '内心').rest).toBe('ab');
  });
  it('formatPublicRecent：私下记录只给壳，绝不给原文', () => {
    const txt = formatPublicRecent([
      { id: 'a', at: 1, kind: 'player', speaker: '千纱', raw: '（把悠真拉到一边）其实我昨天看见雨宫了。', present: ['千纱', '悠真'], heard: ['悠真', '千纱'], shell: { hear: '（她把悠真拉到一边低声说话）' } },
      { id: 'b', at: 2, kind: 'npc', speaker: '悠真', raw: '「早啊。」<内心>她有点怪。</内心>', present: ['千纱', '悠真'] },
    ]);
    expect(txt).not.toContain('雨宫');
    expect(txt).not.toContain('她有点怪');
    expect(txt).toContain('低声说话');
    expect(txt).toContain('早啊');
  });
});

// ---------- 一轮 ----------
describe('空发送：场记选人 → 角色回应', () => {
  it('场景/纪要/记录都落对，两次调用标签正确', async () => {
    setupBook();
    const calls = stubAPI([
      sceneReply({ events: '窗外下起雨。', summary: '教室里，雨开始下。', next: '悠真' }),
      '旁白：雨声很密。\n悠真：早啊，今天怎么这么安静？\n<内心>她今天有点怪。</内心>',
    ]);
    await RealMode._sendText('');
    const log = RealState.log();
    expect(log.map(r => r.kind)).toEqual(['scene', 'npc']);
    expect(log[0].raw).toContain('窗外下起雨');
    expect(log[1].speaker).toBe('悠真');
    expect(RealState.scene().place).toBe('教室');
    expect(RealState.summary()).toContain('雨开始下');
    expect(calls.length).toBe(2);
    expect(calls[0].opts.callLabel).toBe('real-scene');
    expect(calls[1].opts.callLabel).toBe('real-role');
  });

  it('场记没按格式回但写了一大段 → 当旁白收下（不整轮作废）', async () => {
    setupBook();
    stubAPI(['对不起，我来负责记录这一轮的场景与在场情况，但我这次没有按你要求的格式输出，请再试一次试试看。']);
    await RealMode._sendText('');
    const log = RealState.log();
    expect(log.length).toBe(1);
    expect(log[0].kind).toBe('scene');
    expect(log[0].raw).toContain('场景与在场');
  });

  it('场记失败（短推脱）→ 这一轮整轮回滚、作者那句放回输入框（不留在记录里等重复）', async () => {
    setupBook();
    stubAPI(['「你好。」', '我不按格式写。']);       // 第一次是转述（作者那句 → 规范的一轮）
    const ta = { value: '' };
    (globalThis as any).document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    try {
      await RealMode._sendText('你好。');
    } finally {
      delete (globalThis as any).document;
    }
    expect(RealState.log().length).toBe(0);
    expect(RealState.turnSnap()).toBeNull();
    expect(ta.value).toBe('你好。');
  });

  it('接话=旁白 → 只有一次调用，不产生角色记录', async () => {
    setupBook();
    const calls = stubAPI([sceneReply({ next: '旁白', narration: '天色暗了下来。' })]);
    await RealMode._sendText('');
    expect(calls.length).toBe(1);
    expect(RealState.log().map(r => r.kind)).toEqual(['scene']);
    expect(RealState.log()[0].raw).toContain('天色暗了下来');
  });
});

// ---------- 隔离守卫 ----------
describe('物理隔离（回归守卫）', () => {
  async function whisperTurn(): Promise<void> {
    setupBook();
    stubAPI([
      // 转述：作者那句"（把悠真拉到一边）…"被判成悄悄话（可感 + 壳都由它自己给）
      '<私下 只说给="悠真">\n<壳>（她把悠真拉到一边，低声说了些什么）</壳>\n「我跟你说，雨宫同学昨天有些奇怪。」',
      sceneReply({ heard: '悠真', shell: '（她把悠真拉到一边，低声说了些什么）', next: '旁白' }),
    ]);
    await RealMode._sendText('（把悠真拉到一边）我跟你说，雨宫同学昨天有些奇怪。');
  }

  it('场记回的可感与壳落到作者那条记录上（说话人自己一定知道）', async () => {
    await whisperTurn();
    const mine = RealState.log().find(r => r.kind === 'player')!;
    expect(mine.heard).toEqual(['悠真', '千纱']);
    expect(mine.shell!.hear).toContain('低声');
  });

  it('不在可感名单里的角色：只拿壳，拿不到原文', async () => {
    await whisperTurn();
    const mei = RealState.visibleTo('美月').map(i => i.text).join('\n');
    expect(mei).not.toContain('雨宫同学');
    expect(mei).toContain('低声');
    const you = RealState.visibleTo('悠真').map(i => i.text).join('\n');
    expect(you).toContain('雨宫同学');
  });

  it('角色请求：美月（旁观者）拿不到悄悄话原文与别人的内心；悠真/千纱拿得到该拿的', async () => {
    await whisperTurn();
    stubAPI([sceneReply({ next: '悠真' }), '悠真：怎么了？\n<内心>她欲言又止。']);
    await RealMode._sendText('');
    const mei = RealMode._roleMessagesFor('美月').map(m => m.content).join('\n');
    expect(mei).not.toContain('雨宫同学');
    expect(mei).not.toContain('她欲言又止');
    expect(mei).toContain('低声');
    const you = RealMode._roleMessagesFor('悠真').map(m => m.content).join('\n');
    expect(you).toContain('雨宫同学');
    expect(you).toContain('她欲言又止');            // 自己写的内心，自己记得
    const qian = RealMode._roleMessagesFor('千纱').map(m => m.content).join('\n');
    expect(qian).toContain('不想让他知道那件事');    // 自己的初始记忆
    expect(qian).not.toContain('她欲言又止');        // 别人写的内心，拿不到
  });

  it('下一轮场记的"最近发生"里，悄悄话只有壳', async () => {
    await whisperTurn();
    const calls = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    const pubReq = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(pubReq).not.toContain('雨宫同学');
    expect(pubReq).toContain('低声');
  });

  it('上帝模式（输入框上方的下拉）：作者输入落成旁白记录，不挂在扮演者身上', async () => {
    setupBook();
    RealState.setGod(true);
    stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('放学铃响了。');
    const log = RealState.log();
    expect(log.filter(r => r.kind === 'player').length).toBe(0);
    expect(log[0].kind).toBe('scene');
    expect(log[0].speaker).toBe('');
    expect(log[0].raw).toBe('放学铃响了。');
  });

  it('场记的选人候选排除作者正在扮演的角色（软件不能替作者说话）', async () => {
    await whisperTurn();
    const calls = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    const pubReq = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(pubReq).toContain('作者正在扮演「千纱」');
    expect(pubReq).toContain('- 悠真');
    expect(pubReq).not.toContain('- 千纱');
  });

  it('千纱的初始记忆不会出现在别人的请求里', async () => {
    await whisperTurn();
    const mei = RealMode._roleMessagesFor('美月').map(m => m.content).join('\n');
    expect(mei).not.toContain('不想让他知道那件事');
    const you = RealMode._roleMessagesFor('悠真').map(m => m.content).join('\n');
    expect(you).not.toContain('不想让他知道那件事');
  });
});

// ---------- 压缩回忆 ----------
describe('压缩回忆：超窗口先把较早的部分折成"自己的回忆"（只涉及该角色）', () => {
  it('顺序是先选人再压记忆再生成；压缩结果只进该角色的请求', async () => {
    setupBook();
    for (let i = 0; i < 6; i++) {
      RealState.append({
        kind: 'npc', speaker: '悠真',
        raw: '第' + i + '句：' + '很长的一句话。'.repeat(20),
        present: ['千纱', '悠真', '美月'],
      });
    }
    const origWin = (RealMode as any)._windowChars;
    (RealMode as any)._windowChars = () => 200;     // 把窗口压小，逼出压缩
    const calls = stubAPI([
      sceneReply({ next: '悠真' }),
      '她把那本笔记本藏进了柜子，我一直记着，也答应了不说。',
      '悠真：早啊。\n<内心>这事得烂在肚子里。</内心>',
    ]);
    await RealMode._sendText('');
    (RealMode as any)._windowChars = origWin;
    expect(calls.map(c => c.opts.callLabel)).toEqual(['real-scene', 'real-mem', 'real-role']);
    expect(RealState.memoryOf('悠真')!.text).toContain('笔记本藏进了柜子');
    expect(calls[2].msgs.map((m: any) => m.content).join('\n')).toContain('笔记本藏进了柜子');
    // 单角色不变量：压缩只碰悠真那一份
    expect(RealState.memoryOf('美月')).toBeNull();
    expect(RealMode._roleMessagesFor('美月').map(m => m.content).join('\n')).not.toContain('笔记本藏进了柜子');
  });
});

// ---------- 角色清单与下拉（这个模式没有固定扮演者） ----------
describe('角色清单与「上帝模式」下拉', () => {
  it('参演名单用世界书的角色条目种一次；之后加/移除由用户管（移除不会被自动加回来）', async () => {
    setupBook();
    stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.cast()).toEqual(['千纱', '悠真', '美月']);
    RealMode.removeCast('美月');
    expect(RealState.cast()).toEqual(['千纱', '悠真']);
    RealMode.render();
    expect(RealState.cast()).toEqual(['千纱', '悠真']);
  });

  it('开局不用先配场景：在场空着也能发送，场记请求里写明「由你定开场」，角色请求的在场名单回退到名单', async () => {
    setupBook();
    RealState.setScene({ time: '', place: '', present: [] });   // 用户什么都没设
    const calls = stubAPI([sceneReply({ next: '悠真', present: '千纱、悠真' }), '悠真：早。']);
    await RealMode._sendText('');
    const pubReq = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(pubReq).toContain('由你定开场');
    expect(pubReq).toContain('## 角色名单');
    expect(pubReq).toContain('- 悠真');
    // 场记回填了在场 → 记录与后续都用它
    expect(RealState.scene().present).toEqual(['千纱', '悠真']);
    const roleReq = calls[1].msgs.map((m: any) => m.content).join('\n');
    expect(roleReq).toContain('在场：千纱、悠真');
  });

  it('下拉切换：选角色退出上帝模式；选上帝模式清掉扮演者', () => {
    setupBook();
    RealMode.select('美月');
    expect(RealMode.player()).toBe('美月');
    expect(RealState.isGod()).toBe(false);
    RealMode.select('__god__');
    expect(RealState.isGod()).toBe(true);
    expect(RealMode.player()).toBe('');
  });

  it('上帝模式：不排除任何接话候选，且明说这是客观推进', async () => {
    setupBook();
    RealMode.select('__god__');
    const calls = stubAPI([sceneReply({ next: '悠真' }), '悠真：嗯。']);
    await RealMode._sendText('放学铃响了。');
    const pubReq = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(pubReq).toContain('作者以「旁白」推进剧情');
    expect(pubReq).not.toContain('作者正在扮演');
    expect(pubReq).toContain('- 千纱');            // 上帝模式不排除任何人
  });

  it('加进角色会同时进入当前场景（不然 TA 说的话自己看不到）', () => {
    setupBook();
    RealState.setScene({ present: ['千纱'] });
    const el = { value: '美月' };
    (globalThis as any).document = { getElementById: (id: string) => (id === 'realCastSel' ? el : null) };
    try {
      RealMode.addCastFromModal();
    } finally {
      delete (globalThis as any).document;
    }
    expect(RealState.cast()).toContain('美月');
    expect(RealState.scene().present).toContain('美月');
  });
});

// ---------- 「让 TA 接话」：作者点名这一轮由谁接话 ----------
describe('接话点名（输入框上方的「让 TA 接话」下拉）', () => {
  it('点名后：场记请求里写明这一轮由 TA 接话，角色调用就落在 TA（不听场记挑的）', async () => {
    setupBook();
    const calls = stubAPI([
      sceneReply({ next: '美月', events: '上课铃响了。' }),   // 场记挑的是别人
      '「……嗯。」<内心>她怎么突然问我。</内心>',
    ]);
    RealState.setForcedNext('悠真');
    await RealMode._sendText('');
    expect(calls.length).toBe(2);
    expect(calls[0].msgs.map((m: any) => m.content).join('\n')).toContain('作者指定这一轮由「悠真」接话');
    expect(calls[1].msgs.map((m: any) => m.content).join('\n')).toContain('爱开玩笑');   // 悠真的人设：确实是他在说
    expect(RealState.log().map((r: any) => r.speaker)).toEqual(['', '悠真']);
  });

  it('没点名时不写点名行（现状不变）', async () => {
    setupBook();
    const calls = stubAPI([sceneReply({ next: '悠真' }), '「早。」']);
    await RealMode._sendText('');
    expect(calls[0].msgs.map((m: any) => m.content).join('\n')).not.toContain('作者指定这一轮由');
  });

  it('一轮走完自动回到「（自动）」', async () => {
    setupBook();
    stubAPI([sceneReply({ next: '旁白' }), '「早。」']);
    RealState.setForcedNext('悠真');
    await RealMode._sendText('');
    expect(RealState.forcedNext()).toBe('');
  });

  it('撤回上一轮：那次点名一并回来（重来还是 TA 接话）', async () => {
    setupBook();
    stubAPI([sceneReply({ next: '旁白' }), '「早。」']);
    RealState.setForcedNext('美月');
    await RealMode._sendText('');
    expect(RealState.forcedNext()).toBe('');
    RealMode.undoLast();
    expect(RealState.forcedNext()).toBe('美月');
    expect(RealState.log().length).toBe(0);
  });

  it('场记失败整轮回滚：点名留着（再发一次还是 TA）', async () => {
    setupBook();
    const ta = { value: '' };
    (globalThis as any).document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    stubAPI(['「你好。」', '我不按格式写。']);
    try {
      RealState.setForcedNext('悠真');
      await RealMode._sendText('你好。');
    } finally {
      delete (globalThis as any).document;
    }
    expect(RealState.log().length).toBe(0);
    expect(RealState.forcedNext()).toBe('悠真');
  });

  it('候选 = 在场 ∩ 参演名单，排除作者正在扮演的人', () => {
    setupBook();                                    // 在场 千纱/悠真/美月，作者演千纱
    (RealMode as any)._ensureCast();                // 参演名单平时由 _renderHead / 发送时种上
    expect((RealMode as any)._nextCandidates()).toEqual(['悠真', '美月']);
    RealState.setScene({ present: ['千纱', '悠真'] });
    expect((RealMode as any)._nextCandidates()).toEqual(['悠真']);
  });

  it('点名的人不在场：这一轮按「自动」走，点名当场清掉（不留点不动的选项）', async () => {
    setupBook();
    const calls = stubAPI([sceneReply({ next: '美月', events: '上课铃响了。' }), '「早。」']);
    RealState.setForcedNext('悠真');
    RealState.setScene({ present: ['千纱', '美月'] });   // 悠真离场
    await RealMode._sendText('');
    expect(calls[0].msgs.map((m: any) => m.content).join('\n')).not.toContain('作者指定这一轮由');
    expect(RealState.log()[1].speaker).toBe('美月');      // 场记挑的照常走
    expect(RealState.forcedNext()).toBe('');
  });

  it('换扮演者后点到自己：点名失效退回「自动」', () => {
    setupBook();
    RealState.setForcedNext('悠真');
    RealMode.select('悠真');                        // 作者改演悠真——不能再点名自己接话
    expect(RealState.forcedNext()).toBe('');
  });
});

// ---------- 配套：用量统计 / 备份导出 / 重置本书 / 换书 ----------
describe('配套接线（用量统计、备份、重置、换书）', () => {
  it('用量统计把 real-* 三个标签算成「真实」，不再掉进「后台」', () => {
    expect(UsageStats.modeOfRecord({ byLabel: { 'real-scene': {}, 'real-role': {} } } as any)).toBe('real');
    expect(UsageStats.modeOfRecord({ byLabel: { 'real-mem': {} } } as any)).toBe('real');
    expect(UsageStats.modeLabel('real').text).toBe('真实');
    expect(UsageStats.modeOfRecord({ byLabel: { generate: {}, 'real-role': {} } } as any)).toBe('mixed');
    expect(UsageStats.modeOfRecord({ byLabel: {} } as any)).toBe('bg');
  });

  it('备份整份导出/导入（JSON 备份的 realState 字段）', () => {
    setupBook();
    RealState.append({ kind: 'npc', speaker: '悠真', raw: '一句。' });
    const dump = RealState.exportAll();
    expect(Object.keys(dump).length).toBeGreaterThan(0);
    RealState.reset();
    expect(RealState.log().length).toBe(0);
    RealState.importAll(dump);
    expect(RealState.log().length).toBe(1);
  });

  it('导出文本：旁白成段、台词带说话人、内心标成（心声）', () => {
    setupBook();
    RealState.append({ kind: 'player', speaker: '千纱', raw: '「早。」<内心>别看他。</内心>' });
    const t = RealMode.toProseText();
    expect(t).toContain('千纱：「早。」（心声）别看他。');
  });

  it('源码守卫：重置本书清真实模式、备份带上它、换书时重画', () => {
    const app = readSrc('../src/domain/app.ts');
    expect(app).toContain('RealState.reset()');
    expect(app).toContain('realState: RealState.exportAll()');
    expect(app).toContain('RealState.importAll(backup.realState)');
    expect(app).toContain('RealMode.toProseText');
    expect(readSrc('../src/domain/ui.ts')).toContain('RealMode.render()');
  });
});

// ---------- 首次进入 / 清空 / 公共事件标记 ----------
describe('开箱体验（首次进入、清空、公共事件显示）', () => {
  it('什么都没选时自动落到上帝模式（下拉显示的就是它，点继续不会报"没选角色"）', () => {
    setupBook();
    RealState.setPlayer('');
    RealState.setGod(false);
    (RealMode as any)._renderHead();
    expect(RealState.isGod()).toBe(true);
  });

  it('清空：记录/场景/回忆清掉，参演名单与扮演选择保留（与对话模式的「清空」对齐）', async () => {
    setupBook();
    stubAPI([sceneReply({ place: '走廊', narration: '走廊很安静。', next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.log().length).toBe(1);
    const castBefore = RealState.cast().length;
    expect(castBefore).toBeGreaterThan(0);
    const anyG = globalThis as any;
    anyG.UIManager = { showConfirm: (_m: string, cb: () => void) => cb() };
    try { RealMode.clearAll(); } finally { delete anyG.UIManager; }
    expect(RealState.log().length).toBe(0);
    expect(RealState.scene().place).toBe('');
    expect(RealState.cast().length).toBe(castBefore);   // 名单保留
  });

  it('清空同时清掉输入框与当轮状态（用户 2026-09-29：点了清空，框里还留着上一句没发出去的话）', () => {
    setupBook();
    const anyG = globalThis as any;
    const ta: any = { value: '一句还没发出去的话', style: { height: '142px' } };
    anyG.document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    let confirmMsg = '';
    anyG.UIManager = { showConfirm: (m: string, cb: () => void) => { confirmMsg = m; cb(); } };
    try {
      (RealMode as any)._status = '悠真 正在回应…';
      (RealMode as any)._acc = '半截输出';
      (RealMode as any)._next = '悠真';
      (RealMode as any)._playerInput = '上一句';
      RealMode.clearAll();
    } finally {
      delete anyG.document; delete anyG.UIManager;
    }
    expect(ta.value).toBe('');                    // 输入框清空
    expect(ta.style.height).toBe('');             // 高度收回一行
    expect((RealMode as any)._status).toBe('');
    expect((RealMode as any)._acc).toBe('');
    expect((RealMode as any)._next).toBe('');
    expect((RealMode as any)._playerInput).toBe('');
    expect(confirmMsg).toContain('输入栏里的内容也会一起清掉');
  });

  it('生成中清空：这一轮剩下的流程不再写记录、也不把原话填回输入框', async () => {
    setupBook();
    const anyG = globalThis as any;
    const ta: any = { value: '', style: {} };
    anyG.document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    let release: () => void = () => { /* 占位 */ };
    const gate = new Promise<void>((r) => { release = r; });
    let installed: any = null;
    anyG.APIHandler = {
      fetchCompletions: (msgs: any, onChunk: any, onDone: any, _e: any, opts: any) => {
        // 整理那次卡住不返回：等测试按下「清空」再放行
        void (async () => {
          if (opts && opts.callLabel === 'real-echo') await gate;
          const r = opts && opts.callLabel === 'real-scene' ? sceneReply({ next: '悠真' }) : '「早。」';
          if (opts && opts.callLabel === 'real-role') installed = r;
          try { onChunk(r); } catch (e) { /* ignore */ }
          onDone(r, false, undefined);
        })();
      },
      abort: () => { /* noop */ },
    };
    anyG.UIManager = { showConfirm: (_m: string, cb: () => void) => cb() };
    try {
      const p = RealMode._sendText('会被清掉的一句');
      await new Promise((r) => setTimeout(r, 20));
      RealMode.clearAll();                        // 这一轮还在"整理"中就清空
      expect(ta.value).toBe('');
      release();
      await p;
    } finally {
      delete anyG.document; delete anyG.UIManager; delete anyG.APIHandler;
    }
    expect(RealState.log().length).toBe(0);        // 清空后没有任何记录被写回来
    expect(ta.value).toBe('');                     // 也没有把原话填回输入框
    expect(installed).toBe(null);                  // 角色调用根本没发生
  });

  it('模型用小说体写（没有「说话人：」前缀）时，整轮仍是 TA 的气泡，不会判成旁白', () => {
    const raw = '列车碾过接缝，减速驶入月台。\n悠真站在黄线后，抬手挡住灯光。「来得正好。」\n他歪了歪头。';
    const html = (RealMode as any)._recordHtml({ id: 'x', at: 1, kind: 'npc', speaker: '悠真', raw, present: [] });
    expect(html).toContain('chat-row');
    expect(html).toContain('chat-bubble');
    expect(html).toContain('chat-say');
    expect(html).toContain('chat-act');
    expect(html).not.toContain('chat-narr');        // 没有「旁白：」行 → 不该出现旁白块
    expect(html).toContain('来得正好。');
  });

  it('明确写「旁白：」的行才成段显示为旁白', () => {
    const html = (RealMode as any)._recordHtml({ id: 'y', at: 1, kind: 'npc', speaker: '悠真', raw: '旁白：雨停在窗外。\n「早。」', present: [] });
    expect(html).toContain('chat-narr');
    expect(html).toContain('chat-bubble');
    expect(html).toContain('雨停在窗外。');
  });

  it('模型漏写 </内心> 闭标记时：从开标记起算内心，标签不原样显示在气泡里', () => {
    const html = (RealMode as any)._recordHtml({
      id: 'x', at: 1, kind: 'npc', speaker: '悠真', raw: '「早。」<内心>她今天怪。', present: [],
    });
    expect(html).toContain('real-inner');
    expect(html).toContain('她今天怪。');
    expect(html).not.toContain('&lt;内心');
    expect(html).not.toContain('<内心');
  });

  it('场记那次调用不把 <场记> 块画到记录区（流式期间 _silent 为真）', async () => {
    setupBook();
    let silentDuringPub = false;
    const anyG = globalThis as any;
    anyG.APIHandler = {
      fetchCompletions: (msgs: any, onChunk: any, onDone: any, _e: any, opts: any) => {
        if (opts && opts.callLabel === 'real-scene') silentDuringPub = !!RealMode._silent;
        const r = opts && opts.callLabel === 'real-scene' ? sceneReply({ next: '旁白' }) : '';
        try { onChunk(r); } catch (e) { /* ignore */ }
        onDone(r, false, undefined);
      },
      abort: () => { /* noop */ },
    };
    await RealMode._sendText('');
    expect(silentDuringPub).toBe(true);
    expect(RealMode._silent).toBe(false);
  });

  it('上一轮只有旁白时，请求里提示"这一轮请让某个角色开口"（别一直推进不对话）', async () => {
    setupBook();
    const calls = stubAPI([
      sceneReply({ next: '旁白', narration: '风从铁轨间掠过。' }),   // 第一轮：只有旁白
      sceneReply({ next: '悠真' }),                                // 第二轮
      '悠真：嗯。',
    ]);
    await RealMode._sendText('');
    await RealMode._sendText('');
    const first = calls[0].msgs.map((m: any) => m.content).join('\n');
    const second = calls[1].msgs.map((m: any) => m.content).join('\n');   // 第二轮还是场记那次调用
    expect(first).not.toContain('上一轮只有旁白推进');
    expect(second).toContain('上一轮只有旁白推进');
  });

  it('场记的公共事件带【公共事件】标记（渲染时压成一行小字，不再是一大段小说体）', async () => {
    setupBook();
    stubAPI([sceneReply({ events: '窗外下起雨。', narration: '雨点打在窗上。', next: '旁白' })]);
    await RealMode._sendText('');
    const rec = RealState.log()[0];
    expect(rec.raw).toContain('雨点打在窗上。');
    expect(rec.raw).toContain('【公共事件】窗外下起雨。');
  });
});

// ---------- 契约措辞（用户反馈的三条） ----------
describe('契约措辞：动作不加主语 / 公共信息如无必要不输出 / 场记思考纪律', () => {
  it('角色契约：动作不加主语、不写「（我…）」、不写自己的名字（只在提示词层面约束，不硬剥离）', () => {
    setupBook();
    const req = RealMode._roleMessagesFor('悠真').map(m => String(m.content)).join('\n');
    expect(req).toContain('直接写，不加括号也不加主语');
    expect(req).toContain('不要写「（我…）」也不要加「（）」');
    expect(req).toContain('不要写自己的名字');
  });

  it('渲染对齐对话模式：引号和括号只是分隔符，不上屏（内容一字不动）', () => {
    const html = (RealMode as any)._recordHtml({
      id: 'z', at: 1, kind: 'npc', speaker: '悠真',
      raw: '（把书包放下，凑近千纱）「早啊。」\n*托着下巴*', present: [],
    });
    expect(html).toContain('<span class="chat-act">把书包放下，凑近千纱</span>');
    expect(html).toContain('<span class="chat-say">早啊。</span>');
    expect(html).not.toContain('（把书包放下');
    expect(html).not.toContain('「早啊。」');
    expect(html).toContain('托着下巴');
    expect(html).not.toContain('*托着下巴*');
  });

  it('点头像 = 打开角色简介（和对话模式同一个弹窗）', () => {
    const html = (RealMode as any)._avatar('悠真');
    expect(html).toContain('ChatMode.openProfile');
    expect(html).toContain('悠真');
    expect(html).toContain('chat-av');
  });

  it('公共契约：公共事件/旁白如无必要不输出，多数轮次只有对话', async () => {
    setupBook();
    const calls = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    const req = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(req).toContain('多数轮次应该只有对话');
    expect(req).toContain('没有新事实就写「无」');
    expect(req).toContain('**多数轮次留空**');
  });

  it('场记的思考纪律在 system 里（固定文案并进系统提示词，便于缓存）', async () => {
    setupBook();
    const calls = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    const msgs = calls[0].msgs;
    expect(msgs.length).toBe(2);
    expect(String(msgs[0].role)).toBe('system');
    expect(String(msgs[0].content)).toContain('【思考纪律】');
    expect(String(msgs[0].content)).toContain('思考几十个字就够');
  });

  it('缓存前缀：不同角色的请求在"共同经历"结束前逐字节相同（换角色也命中缓存）', () => {
    setupBook();
    RealState.append({ kind: 'scene', speaker: '', raw: '雨停了。', present: ['千纱', '悠真', '美月'] });
    RealState.append({ kind: 'npc', speaker: '千纱', raw: '「早。」<内心>别看他。</内心>', present: ['千纱', '悠真', '美月'] });
    const a = RealMode._roleMessagesFor('悠真').map(m => String(m.content)).join('\n');
    const b = RealMode._roleMessagesFor('美月').map(m => String(m.content)).join('\n');
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const cut = a.indexOf('## 你是谁');
    expect(cut).toBeGreaterThan(300);            // 共同前缀至少包含系统契约 + 共同经历
    expect(i).toBeGreaterThanOrEqual(cut);       // 两个人在这之前逐字节相同
    expect(a.slice(0, cut)).toBe(b.slice(0, cut));
    // 千纱的内心不在共享块里（对谁都不外泄，也不破坏前缀一致性）
    expect(a.slice(0, cut)).not.toContain('别看他');
  });
  it('顺序按缓存前缀排：角色请求里"共同经历"在"你是谁"之前，系统提示词里带固定输出契约', () => {
    setupBook();
    RealState.append({ kind: 'scene', speaker: '', raw: '雨停了。', present: ['千纱', '悠真', '美月'] });
    const msgs = RealMode._roleMessagesFor('悠真');
    expect(String(msgs[0].content)).toContain('输出要求（固定契约');
    const user = String(msgs[1].content);
    expect(user.indexOf('## 共同经历')).toBeGreaterThanOrEqual(0);
    expect(user.indexOf('## 共同经历')).toBeLessThan(user.indexOf('## 你是谁'));
    expect(user.indexOf('## 你是谁')).toBeLessThan(user.indexOf('## 当前场景'));
  });
});

// ---------- 撤回 ----------
describe('撤回：回到这一轮之前', () => {
  it('记录 / 场景 / 纪要一起回滚；输入框内容由调用方恢复', async () => {
    setupBook();
    stubAPI([sceneReply({ place: '走廊', narration: '午后的走廊很安静。', summary: '两人在走廊碰头。', next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.log().length).toBe(1);
    expect(RealState.scene().place).toBe('走廊');
    RealMode.undoLast();
    expect(RealState.log().length).toBe(0);
    expect(RealState.scene().place).toBe('教室');
    expect(RealState.summary()).toBe('');
  });

  it('一轮什么都没产出时，撤回也不会误删上一条（快照在状态里，不挂记录）', async () => {
    setupBook();
    stubAPI([sceneReply({ place: '走廊', next: '旁白' })]);   // 没旁白也没公共事件 → 不产生记录
    await RealMode._sendText('');
    expect(RealState.log().length).toBe(0);
    expect(RealState.scene().place).toBe('走廊');
    RealMode.undoLast();
    expect(RealState.scene().place).toBe('教室');
    expect(RealState.log().length).toBe(0);
  });

  it('作者那一轮也一起回滚（含作者那句话）', async () => {
    setupBook();
    stubAPI(['「我说了一句。」', sceneReply({ next: '旁白' })]);
    await RealMode._sendText('我说了一句。');
    expect(RealState.log().length).toBe(1);   // 场记这轮没产出公共文字 → 只有作者那句
    expect(RealState.log()[0].kind).toBe('player');
    RealMode.undoLast();
    expect(RealState.log().length).toBe(0);
  });
});

// ---------- 大家都知道的事（共知） ----------
describe('共知：公开的通知/传闻，每个角色都知道（不管在不在场）', () => {
  it('场记维护的共知发给不在场的角色；两个人的那一段逐字节相同（缓存）', async () => {
    setupBook();
    stubAPI([sceneReply({ common: '- 下周六开运动会\n- 明天下午停课', next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.common()).toContain('下周六开运动会');
    // 美月不在场（后来的记录里都没有她）
    RealState.setScene({ present: ['千纱', '悠真'] });
    RealState.append({ kind: 'npc', speaker: '悠真', raw: '「早。」', present: ['千纱', '悠真'] });
    const mei = RealMode._roleMessagesFor('美月').map(m => String(m.content)).join('\n');
    const qian = RealMode._roleMessagesFor('千纱').map(m => String(m.content)).join('\n');
    expect(mei).toContain('下周六开运动会');        // 不在场也知道（这就是这条通道的意义）
    expect(mei).toContain('不在场也知道');          // 段落抬头明写这一点，模型别把它当成"我在场才知道的"
    expect(qian).toContain('下周六开运动会');
    const cut = (s: string) => s.slice(s.indexOf('## 大家都知道的事'));
    expect(cut(mei)).toBe(cut(qian));               // 逐字节一致 → 换角色说话也能命中缓存
  });

  it('位置在追加式前缀之后（共知每轮可能变，别把它插在共同经历前面，否则缓存前缀全废）', () => {
    setupBook();
    RealState.append({ kind: 'scene', speaker: '', raw: '雨停了。', present: ['千纱', '悠真', '美月'] });
    RealMode.setCommon('- 下周六开运动会');
    const user = String(RealMode._roleMessagesFor('悠真')[1].content);
    expect(user.indexOf('## 共同经历')).toBeGreaterThanOrEqual(0);
    expect(user.indexOf('## 大家都知道的事')).toBeGreaterThan(user.indexOf('## 你是谁'));
    expect(user.indexOf('## 大家都知道的事')).toBeGreaterThan(user.indexOf('## 共同经历'));
  });

  it('场记没写/写「（无）」→ 保留旧值（不把大家已经知道的事清空）', async () => {
    setupBook();
    RealMode.setCommon('- 下周六开运动会');
    stubAPI([sceneReply({ common: '（无）', next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.common()).toContain('下周六开运动会');
  });

  it('撤回把共知一起回滚（和场景/纪要一个待遇）', async () => {
    setupBook();
    RealMode.setCommon('- 原来是旧值');
    stubAPI([sceneReply({ place: '走廊', common: '- 下周六开运动会', next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.common()).toContain('运动会');
    RealMode.undoLast();
    expect(RealState.common()).toBe('- 原来是旧值');
  });

  it('公共契约的红线：写明只收公开的事、绝不写悄悄话；请求里带上当前清单', async () => {
    setupBook();
    RealMode.setCommon('- 下周六开运动会');
    const calls = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    const req = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(req).toContain('绝对不能写进来');           // 悄悄话不许进共知
    expect(req).toContain('不管他当时在不在场');
    expect(req).toContain('下周六开运动会');           // 上一轮的清单给它照抄
    expect(req).toContain('最新的完整清单');
  });

  it('用户能在场景弹窗里看和改（RealMode.common/setCommon + 弹窗字段）', () => {
    setupBook();
    RealMode.setCommon('  - 一行\n- 两行  ');
    expect(RealMode.common()).toBe('- 一行\n- 两行');
    const modals = readSrc('../src/domain/modals.ts');
    expect(modals).toContain('realSceneCommon');
    const ui = readSrc('../src/domain/ui.ts');
    expect(ui).toContain('RealMode.setCommon');
    expect(ui).toContain('RealMode.common');
  });
  it('发出去就把输入框收回一行（长文发送后不会挂着一大坨）', async () => {
    setupBook();
    stubAPI(['「早。」', sceneReply({ next: '旁白' })]);
    const ta: any = { value: '', style: { height: '142px' } };
    (globalThis as any).document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    try {
      await RealMode._sendText('很长的一句'.repeat(20));
    } finally {
      delete (globalThis as any).document;
    }
    expect(ta.value).toBe('');
    expect(ta.style.height).toBe('');
  });

  it('输入法把刚清掉的内容补回来 → 迟一拍再清一次（只在这一模一样时才动手）', async () => {
    setupBook();
    const ta: any = { value: '', style: { height: '142px' } };
    (globalThis as any).document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    try {
      RealMode._clearInputForSend(ta, '发送的那句');
      expect(ta.value).toBe('');
      ta.value = '发送的那句';                    // 模拟输入法把它补回来
      await new Promise((r) => setTimeout(r, 120));
      expect(ta.value).toBe('');                  // 再清一次
      // 用户在这一瞬间新打的字（内容不同）不能被吃掉
      RealMode._clearInputForSend(ta, '原来那句');
      ta.value = '新打的一句';
      await new Promise((r) => setTimeout(r, 120));
      expect(ta.value).toBe('新打的一句');
    } finally {
      delete (globalThis as any).document;
    }
  });

  it('停止 / 场记失败把原话放回输入框时，都给提示并留一条日志（不然用户以为"没清空"）', () => {
    const src = readSrc('../src/domain/realmode.ts');
    expect(src).toContain('已停止：刚才那句放回输入框了');
    expect(src).toContain('这一轮没走成，刚才那句已放回输入框');
    expect(src).toContain('把作者那句放回输入框');
    expect(src).toContain("noteReal('停止'");
    expect(src).toContain("noteReal('场记失败'");
  });
});

// ---------- 部分人知道（内情） ----------
describe('部分人知道：只有名单里的角色拿得到（作者额外设定的那一层）', () => {
  function addSubset(name: string, content: string, knowers: string[], inject = true): void {
    const all = WBM.getAll();
    const id = WBM.getActiveId();
    const bk = all.find(w => w.id === id)!;
    bk.entries = (bk.entries || []).concat([{ id: 'sub_' + name, type: '部分人知道', name, content, bindNames: knowers, inject }] as any);
    WBM.saveAll(all);
  }

  it('名单里的人拿得到、并写明"谁知道"；名单外的角色一个字都拿不到', () => {
    setupBook();
    addSubset('初中同学', '我和悠真初中就认识，一直瞒着班上的同学。', ['千纱', '悠真']);
    const qian = RealMode._roleMessagesFor('千纱').map(m => String(m.content)).join('\n');
    const you = RealMode._roleMessagesFor('悠真').map(m => String(m.content)).join('\n');
    const mei = RealMode._roleMessagesFor('美月').map(m => String(m.content)).join('\n');
    expect(qian).toContain('初中就认识');
    expect(qian).toContain('知道的人：千纱、悠真');
    expect(you).toContain('初中就认识');
    expect(you).toContain('知道的人：千纱、悠真');
    expect(mei).not.toContain('初中就认识');          // 硬隔离：她连内容都拿不到
    expect(mei).not.toContain('初中同学');
  });

  it('场记（公共调用）拿不到内情——它是私下的，公共侧知道了就可能顺手写进纪要/共知', async () => {
    setupBook();
    addSubset('初中同学', '我和悠真初中就认识。', ['千纱']);
    const calls = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    const pub = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(pub).not.toContain('初中就认识');
    expect(pub).toContain('## 大家都知道的事');
  });

  it('转述请求也拿不到（转述只做规范化，不需要内情）', async () => {
    setupBook();
    addSubset('初中同学', '我和悠真初中就认识。', ['千纱']);
    const calls = stubAPI(['「早。」', sceneReply({ next: '旁白' })]);
    await RealMode._sendText('早');
    const echo = calls[0].msgs.map((m: any) => m.content).join('\n');
    expect(echo).not.toContain('初中就认识');
  });

  it('关掉注入 / 内容为空 / 名单为空 / 名字不在书里 → 都不注入', () => {
    setupBook();
    addSubset('关掉的', '不该出现的内容A', ['千纱'], false);
    addSubset('空的', '   ', ['千纱']);
    addSubset('没名单', '不该出现的内容B', []);
    addSubset('名字打错了', '不该出现的内容C', ['千纱织']);
    const qian = RealMode._roleMessagesFor('千纱').map(m => String(m.content)).join('\n');
    expect(qian).not.toContain('不该出现的内容A');
    expect(qian).not.toContain('不该出现的内容B');
    expect(qian).not.toContain('不该出现的内容C');
    expect(qian).not.toContain('只有你和某些人知道的事');   // 一条都没有时，这一段根本不出现
  });

  it('位置在私有区（共同经历之后）、场景之前——不插在追加式前缀前面', () => {
    setupBook();
    addSubset('初中同学', '我和悠真初中就认识。', ['千纱', '悠真']);
    const user = String(RealMode._roleMessagesFor('千纱')[1].content);
    expect(user.indexOf('## 只有你和某些人知道的事')).toBeGreaterThan(user.indexOf('## 共同经历'));
    expect(user.indexOf('## 只有你和某些人知道的事')).toBeGreaterThan(user.indexOf('## 记得的往事'));
    expect(user.indexOf('## 只有你和某些人知道的事')).toBeLessThan(user.indexOf('## 当前场景'));
  });

  it('bindName 手写兼容：「甲、乙」这种也认', () => {
    setupBook();
    const all = WBM.getAll();
    const bk = all.find(w => w.id === WBM.getActiveId())!;
    bk.entries = (bk.entries || []).concat([{ id: 'sub_x', type: '部分人知道', name: '旧写法', content: '手写绑定的内容D', bindName: '千纱、美月', inject: true }] as any);
    WBM.saveAll(all);
    expect(RealMode._roleMessagesFor('千纱').map(m => String(m.content)).join('\n')).toContain('手写绑定的内容D');
    expect(RealMode._roleMessagesFor('美月').map(m => String(m.content)).join('\n')).toContain('手写绑定的内容D');
    expect(RealMode._roleMessagesFor('悠真').map(m => String(m.content)).join('\n')).not.toContain('手写绑定的内容D');
  });

  it('名单解析 parseKnowers：换行/顿号/逗号/分号都能分，去重去空（编辑器与读取共用）', () => {
    expect(parseKnowers('千纱\n悠真')).toEqual(['千纱', '悠真']);
    expect(parseKnowers('千纱、悠真, 美月；千纱 ')).toEqual(['千纱', '悠真', '美月']);
    expect(parseKnowers('\n\n')).toEqual([]);
    expect(parseKnowers(null)).toEqual([]);
  });

  it('迁移白名单保留「部分人知道」；常规世界书注入里没有它（不进公共注入）', () => {
    setupBook();
    addSubset('初中同学', '我和悠真初中就认识。', ['千纱']);
    expect(WBM.migrateEntryTypes()).toBe(false);
    const t = (WBM.getActive() as any).entries.find((e: any) => e.type === '部分人知道');
    expect(t).toBeTruthy();
    const injected = WBM.filterRelevantEntries().map((e: any) => e.name);
    expect(injected).not.toContain('初中同学');
    const src = readSrc('../src/domain/worldbook.ts');
    expect(src).toContain("'部分人知道'");
  });

  it('编辑器：类型下拉有这个类型、有知情者名单字段、保存走 bindNames 且名字打错会提醒', () => {
    const modals = readSrc('../src/domain/modals.ts');
    expect(modals).toContain('<option>部分人知道</option>');
    expect(modals).toContain('wbEntryBindNames');
    const ui = readSrc('../src/domain/ui.ts');
    expect(ui).toContain("type === '部分人知道'");
    expect(ui).toContain('data.bindNames');
    expect(ui).toContain('不是当前世界书里的「角色」条目');
    expect(ui).toContain('不然这条不会发给任何人');       // 名单为空 → 拒绝保存
    expect(ui).toContain('parseKnowers');
    expect(ui).toContain("'部分人知道': 'chip-teal'");
    expect(readSrc('../../web/index.html')).toContain('.chip-teal');
  });
});

// ---------- 转述（作者那句话 → 规范的一轮） ----------
describe('转述：作者随手写的一句 → 规范的一轮（整理不成就照原话）', () => {
  const ECHO_IN = '我把书合上（其实我心里很在意她昨天去哪了）';
  const ECHO_OUT = '把书合上。\n「昨天你去哪了？」<内心>其实我很在意她昨天去哪了。</内心>';

  it('台词/动作/心里话分开落地：别人只拿到旁人能感知的那部分，原话留给作者自己看', async () => {
    setupBook();
    stubAPI([ECHO_OUT, sceneReply({ next: '旁白' })]);
    await RealMode._sendText(ECHO_IN);
    const rec = RealState.log().find(r => r.kind === 'player')!;
    expect(rec.raw).toContain('「昨天你去哪了？」');
    expect(rec.raw).toContain('<内心>');
    expect(rec.playerRaw).toBe(ECHO_IN);              // 原话留着（气泡里「✎ 已整理 · 看原话」）
    const you = RealState.visibleTo('悠真').map(i => i.text).join('\n');
    expect(you).toContain('昨天你去哪了');
    expect(you).not.toContain('其实我很在意');
    // 原话只给作者看：不进任何注入（别人的视角、自己的角色请求都不该出现它）
    expect(RealMode._roleMessagesFor('悠真').map(m => String(m.content)).join('\n')).not.toContain(ECHO_IN);
    expect(RealMode._roleMessagesFor('千纱').map(m => String(m.content)).join('\n')).not.toContain(ECHO_IN);
  });

  it('场记看的是整理后的一轮（作者的原话不出现在公共请求里），且看不到 <内心>', async () => {
    setupBook();
    const calls = stubAPI([ECHO_OUT, sceneReply({ next: '旁白' })]);
    await RealMode._sendText(ECHO_IN);
    expect(calls.map(c => c.opts.callLabel)).toEqual(['real-echo', 'real-scene']);
    const pub = calls[1].msgs.map((m: any) => m.content).join('\n');
    expect(pub).toContain('昨天你去哪了');
    expect(pub).not.toContain('其实我很在意');
    expect(pub).not.toContain(ECHO_IN);
  });

  it('转述自己判定为悄悄话：可感与壳直接落到记录上（场记没给也能隔离）', async () => {
    setupBook();
    stubAPI([
      '<私下 只说给="悠真">\n<壳>（她凑到悠真耳边说了句什么）</壳>\n「昨天你去哪了？」',
      sceneReply({ next: '旁白' }),
    ]);
    await RealMode._sendText('（凑到悠真耳边）昨天你去哪了？');
    const rec = RealState.log().find(r => r.kind === 'player')!;
    expect(rec.heard).toEqual(['悠真', '千纱']);      // 说话人自己一定知道
    expect(rec.shell!.hear).toContain('耳边');
    expect(RealState.visibleTo('美月').map(i => i.text).join('\n')).not.toContain('昨天你去哪了');
  });

  it('场记只补不覆盖：它没给壳时，转述写好的壳不会被抹掉（也不会把可感抹成"全体都听得到"）', async () => {
    setupBook();
    stubAPI([
      '<私下 只说给="悠真">\n<壳>（她凑到悠真耳边说了句什么）</壳>\n「昨天你去哪了？」',
      sceneReply({ heard: '悠真', next: '旁白' }),     // 有可感、没壳
    ]);
    await RealMode._sendText('（凑到悠真耳边）昨天你去哪了？');
    const rec = RealState.log().find(r => r.kind === 'player')!;
    expect(rec.heard).toEqual(['悠真', '千纱']);
    expect(rec.shell!.hear).toContain('耳边');        // 转述给的壳还在
    expect(RealState.visibleTo('美月').map(i => i.text).join('\n')).toContain('耳边');
  });

  it('整理失败（空回）→ 照原话发出，这一轮照常走；记录里不写 playerRaw', async () => {
    setupBook();
    const calls = stubAPI(['', sceneReply({ next: '旁白' })]);
    await RealMode._sendText('我说了一句。');
    const rec = RealState.log().find(r => r.kind === 'player')!;
    expect(rec.raw).toBe('我说了一句。');
    expect(rec.playerRaw).toBeUndefined();
    expect(calls.map(c => c.opts.callLabel)).toEqual(['real-echo', 'real-scene']);
  });

  it('上帝模式与空发送都不转述（这一轮没有"作者的话"要整理）', async () => {
    setupBook();
    RealState.setGod(true);
    const g = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('放学铃响了。');
    expect(g.map(c => c.opts.callLabel)).toEqual(['real-scene']);
    setupBook();
    const e = stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    expect(e.map(c => c.opts.callLabel)).toEqual(['real-scene']);
  });

  it('作者这一轮只有心里话 → 场记明说"只有心里活动"，不把心里话写进公共事件', async () => {
    setupBook();
    const calls = stubAPI(['<内心>其实我很在意她昨天去哪了。</内心>', sceneReply({ next: '旁白' })]);
    await RealMode._sendText(ECHO_IN);
    const pub = calls[1].msgs.map((m: any) => m.content).join('\n');
    expect(pub).toContain('只有心里活动');
    expect(pub).not.toContain('其实我很在意');
  });

  it('转述请求：只给自己的公开人设 + 在场者的名字（别人的设定不进），作者那句在最后（缓存前缀）', () => {
    setupBook();
    const msgs = buildEchoMessages({
      name: '千纱', persona: '内向，怕生，说话很短。', prev: '【他说】「早。」',
      scene: { time: '清晨', place: '教室', present: ['千纱', '悠真'] }, present: ['千纱', '悠真'], input: '早啊',
    });
    const all = msgs.map(m => m.content).join('\n');
    expect(all).toContain('内向，怕生');
    expect(all).toContain('悠真');
    expect(all).not.toContain('爱开玩笑');            // 别的角色的设定不进转述请求（认得出名字就够）
    expect(String(msgs[0].content)).toContain('原样回，一个字都别改');
    expect(String(msgs[1].content).trim().endsWith('早啊')).toBe(true);
  });

  it('原话在气泡里可展开（默认收起）；cleanEcho 丢掉模型的前言与代码块', () => {
    const html = (RealMode as any)._recordHtml({
      id: 'p', at: 1, kind: 'player', speaker: '千纱', raw: '「早。」', present: [], playerRaw: '早',
    });
    expect(html).toContain('real-echo');
    expect(html).toContain('已整理');
    expect(html).toContain('>早<');
    expect(cleanEcho('```\n好的，整理如下：\n「早。」\n```')).toBe('「早。」');
    expect(cleanEcho('「早。」')).toBe('「早。」');
  });

  it('整理当中按「停止」→ 这一轮整体退回（原话回到输入框，不留半轮）', async () => {
    setupBook();
    const anyG = globalThis as any;
    const ta = { value: '' };
    anyG.document = { getElementById: (id: string) => (id === 'realInput' ? ta : null) };
    const labels: string[] = [];
    anyG.APIHandler = {
      fetchCompletions: (_m: any, onChunk: any, onDone: any, _e: any, opts: any) => {
        labels.push(opts && opts.callLabel);
        if (opts && opts.callLabel === 'real-echo') RealMode.stop();   // 用户在整理时点了停止
        onDone('', false, undefined);
      },
      abort: () => { /* noop */ },
    };
    try {
      await RealMode._sendText('我说了一句。');
    } finally {
      delete anyG.document;
      anyG.APIHandler = undefined;
    }
    expect(labels).toEqual(['real-echo']);            // 没有接着喊场记
    expect(RealState.log().length).toBe(0);
    expect(ta.value).toBe('我说了一句。');
  });
});
