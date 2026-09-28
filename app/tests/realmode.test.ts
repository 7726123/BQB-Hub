// 真实模式的链路与隔离守卫：公共调用（场记）→ 角色调用（唯一说话人）。
// 这里最重要的一组断言是「物理隔离」：任何一次请求里，私有材料只能来自一个角色。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { RealMode } from '../src/domain/realmode';
import { RealState } from '../src/domain/realstate';
import {
  parsePublicReply, parseRoleReply, formatPublicRecent, readField, splitNames, extractBlocks,
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
  summary?: string; next?: string; heard?: string; shell?: string;
}): string {
  return '<场记>\n' +
    '时间：' + (o.time || '次日清晨') + '\n' +
    '地点：' + (o.place || '教室') + '\n' +
    '在场：' + (o.present || '千纱、悠真、美月') + '\n' +
    '公共事件：' + (o.events || '无') + '\n' +
    (o.narration ? '旁白：' + o.narration + '\n' : '') +
    '纪要：' + (o.summary || '早上，教室里。') + '\n' +
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
  it('不是 <场记> 块 → null（不许瞎猜）', () => {
    expect(parsePublicReply('好的，我来当这个场记。')).toBeNull();
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

  it('场记失败 → 这一轮整轮回滚、作者那句放回输入框（不留在记录里等重复）', async () => {
    setupBook();
    stubAPI(['我不按格式写。']);
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
    stubAPI([sceneReply({ heard: '悠真', shell: '（她把悠真拉到一边，低声说了些什么）', next: '旁白' })]);
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
  it('清单空时用在场名单种一次；之后加/移除由用户管（移除不会被自动加回来）', async () => {
    setupBook();
    stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('');
    expect(RealState.cast()).toEqual(['千纱', '悠真', '美月']);
    RealMode.removeCast('美月');
    expect(RealState.cast()).toEqual(['千纱', '悠真']);
    RealMode.render();
    expect(RealState.cast()).toEqual(['千纱', '悠真']);
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
    stubAPI([sceneReply({ next: '旁白' })]);
    await RealMode._sendText('我说了一句。');
    expect(RealState.log().length).toBe(1);   // 场记这轮没产出公共文字 → 只有作者那句
    expect(RealState.log()[0].kind).toBe('player');
    RealMode.undoLast();
    expect(RealState.log().length).toBe(0);
  });
});
