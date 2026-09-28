// 真实模式隔离核（domain/realstate）：视角切片 / 内心剥离 / 壳 / 初始记忆绑定 / 记录与撤回。
// 这组用例是「物理隔离」的回归守卫：任何让一个角色看到别人私有内容的改动，都必须在这里变红。
// 产品模型（2026-09-28）：记忆 = 视角过滤后的真实上下文（不是概括）；不在场 → 整条不出现；
// 同场不可感 → 只给壳；<内心> 只属于写出它的那个角色。
import { describe, it, expect } from 'vitest';
import '../src/infra/storage';
import {
  RealState, RECORD_LIMIT, stripInner, shellText, visibleIn, sliceChars, initialMemoryFor,
} from '../src/domain/realstate';
import type { RealRecord } from '../src/domain/realstate';
import { WorldBookManager as WBM, selectInjectableEntries } from '../src/domain/worldbook';

function rec(p: Partial<RealRecord>): RealRecord {
  return Object.assign({ id: 'r1', at: 1, kind: 'npc' as const, speaker: '', raw: '', present: [] as string[] }, p) as RealRecord;
}

// ---------- 内心块：只属于写出它的那个角色 ----------
describe('stripInner：内心不外泄', () => {
  it('去掉闭合块、保留其余原文', () => {
    expect(stripInner('千纱：<内心>她昨天也是这样。</内心>你怎么了？')).toBe('千纱：你怎么了？');
  });
  it('多个块一起去掉', () => {
    expect(stripInner('<内心>a</内心>正文<内心>b</内心>')).toBe('正文');
  });
  it('标签里带空格 / 大小写都能认', () => {
    expect(stripInner('< 内心 >秘密</ 内心 >正文')).toBe('正文');
  });
  it('未闭合的开标记 → 从它起全丢（宁可少显示，不可漏内心）', () => {
    expect(stripInner('正文<内心>秘密没关')).toBe('正文');
  });
  it('只含内心块 → 空串', () => {
    expect(stripInner('<内心>只有内心</内心>')).toBe('');
  });
  it('没有内心块 → 原样（只 trim）', () => {
    expect(stripInner(' 普通正文 ')).toBe('普通正文');
  });
});

describe('shellText：壳的两段合成', () => {
  it('两段都有 → 换行拼接', () => {
    expect(shellText({ see: '看到他们交谈', hear: '听到低语' })).toBe('看到他们交谈\n听到低语');
  });
  it('只有一段 → 就那一段', () => {
    expect(shellText({ hear: '低声说了些什么' })).toBe('低声说了些什么');
  });
  it('空壳 / 缺省 → 空串', () => {
    expect(shellText({})).toBe('');
    expect(shellText(undefined)).toBe('');
  });
});

// ---------- 视角切片：不在场不知、不可感只给壳 ----------
describe('visibleIn：每个角色只知道自己的那份', () => {
  const secret = '<内心>我其实在骗他</内心>';
  const log: RealRecord[] = [
    rec({ id: 'a', speaker: '千纱', raw: '悠真：早上好。' + secret, present: ['千纱', '悠真', '美月'] }),
    rec({
      id: 'b', speaker: '悠真', raw: '（把千纱拉到一边）我跟你说，雨宫同学昨天有些奇怪。',
      present: ['千纱', '悠真', '美月'], heard: ['悠真', '千纱'],
      shell: { hear: '（他把千纱拉到一边，低声说了些什么）' },
    }),
    rec({ id: 'c', speaker: '', raw: '教室窗外下起了雨。', present: ['千纱', '悠真'] }),
  ];

  it('不在场者：整条不出现（连壳都没有）', () => {
    expect(visibleIn(log, '美月').map(i => i.id)).toEqual(['a', 'b']);
  });
  it('可感者拿到原文', () => {
    const v = visibleIn(log, '千纱');
    expect(v.map(i => i.id)).toEqual(['a', 'b', 'c']);
    expect(v[1].text).toContain('雨宫同学');
    expect(v[1].degraded).toBe(false);
  });
  it('同场但不在可感集合 → 只给壳，并标 degraded', () => {
    const b = visibleIn(log, '美月').find(i => i.id === 'b')!;
    expect(b.degraded).toBe(true);
    expect(b.text).toContain('低声');
    expect(b.text).not.toContain('雨宫同学');
  });
  it('别人的内心剥掉；说话人自己保留', () => {
    expect(visibleIn(log, '悠真')[0].text).not.toContain('我其实在骗他');
    expect(visibleIn(log, '千纱')[0].text).toContain('我其实在骗他');
  });
  it('不可感又没有壳 → 整条不出现（宁可少给，不可泄漏）', () => {
    const l = [rec({ id: 'x', speaker: 'A', raw: '悄悄话原文', present: ['A', 'B'], heard: ['A'] })];
    expect(visibleIn(l, 'B').length).toBe(0);
    expect(visibleIn(l, 'A').length).toBe(1);
  });
  it('只含内心的记录，对别人等于没发生', () => {
    const l = [rec({ id: 'y', speaker: 'A', raw: '<内心>想了想</内心>', present: ['A', 'B'] })];
    expect(visibleIn(l, 'B').length).toBe(0);
    expect(visibleIn(l, 'A').length).toBe(1);
  });
  it('sliceChars 数字数（注入预算用）', () => {
    expect(sliceChars(visibleIn(log, '千纱'))).toBeGreaterThan(0);
    expect(sliceChars([])).toBe(0);
  });
});

// ---------- 隔离守卫：两个角色的私密材料互不可见 ----------
describe('隔离守卫（物理隔离的回归基线）', () => {
  const log: RealRecord[] = [
    rec({
      id: 'p1', speaker: '悠真', raw: '（把千纱拉到一边）其实我昨天看见雨宫了。',
      present: ['悠真', '千纱', '美月'], heard: ['悠真', '千纱'], shell: { hear: '（悠真把千纱拉到一边低声说话）' },
    }),
    rec({ id: 'p2', speaker: '千纱', raw: '（脸色变了一下）<内心>他怎么会知道？</内心>没什么。', present: ['悠真', '千纱'] }),
    rec({ id: 'p3', speaker: '美月', raw: '你们在说什么？', present: ['美月'] }),
  ];
  it('A 的视角不含 B 的内心；B 的视角含自己的内心', () => {
    const you = visibleIn(log, '悠真').map(i => i.text).join('\n');
    expect(you).not.toContain('他怎么会知道');
    expect(visibleIn(log, '千纱').map(i => i.text).join('\n')).toContain('他怎么会知道');
  });
  it('不在场者拿不到悄悄话原文，只拿壳；也不含他人内心', () => {
    const ids = visibleIn(log, '美月').map(i => i.id);
    const mei = visibleIn(log, '美月').map(i => i.text).join('\n');
    expect(ids).toEqual(['p1', 'p3']);           // p2（她不在场）整条不出现；p3 是她自己那句
    expect(mei).not.toContain('其实我昨天看见雨宫了');
    expect(mei).not.toContain('他怎么会知道');
    expect(mei).toContain('低声说话');
  });
  it('缺席的片段在当事人视角里整个不存在', () => {
    expect(visibleIn(log, '悠真').map(i => i.id)).not.toContain('p3');
  });
});

// ---------- 初始记忆：绑定角色、开局即生效 ----------
describe('initialMemoryFor：1 对 1 绑定与兜底', () => {
  const role = { id: 'role1', type: '角色', name: '千纱', content: '角色卡' };
  const mem = { id: 'mem1', type: '初始记忆', name: '千纱的开局', bindId: 'role1', bindName: '千纱', content: '我认识悠真，但不想让他知道那件事。' };

  it('按 bindId 命中', () => {
    expect(initialMemoryFor('千纱', [role, mem])!.text).toContain('那件事');
  });
  it('角色条目被删重建（id 变了）→ 按 bindName 仍认得出', () => {
    const rebuilt = [{ id: 'role9', type: '角色', name: '千纱', content: 'x' }, mem];
    expect(initialMemoryFor('千纱', rebuilt)!.entryId).toBe('mem1');
  });
  it('注入开关关掉 → 不生效', () => {
    expect(initialMemoryFor('千纱', [role, Object.assign({}, mem, { inject: false })])).toBeNull();
  });
  it('没有绑定 / 空名字 → null', () => {
    expect(initialMemoryFor('悠真', [role, mem])).toBeNull();
    expect(initialMemoryFor('', [role, mem])).toBeNull();
  });
  it('数据异常（重复绑定）取第一条，不抛错', () => {
    const dup = [role, mem, { id: 'mem2', type: '初始记忆', bindId: 'role1', content: '第二条' }];
    expect(initialMemoryFor('千纱', dup)!.entryId).toBe('mem1');
  });
  it('RealState.initialMemory 从当前书条目里取', () => {
    const b = WBM.createBook('绑定书');
    WBM.setActiveId(b.id);
    const all = WBM.getAll();
    const bk = all.find(w => w.id === b.id)!;
    bk.entries = [role, mem];
    WBM.saveAll(all);
    expect(RealState.initialMemory('千纱')!.text).toContain('那件事');
    expect(RealState.initialMemory('悠真')).toBeNull();
  });

  it('addEntry 保留额外字段（bindId/bindName）——只挑已知字段会把绑定静默丢掉', () => {
    const b = WBM.createBook('字段书');
    const e = WBM.addEntry(b.id, {
      type: '初始记忆', name: '千纱的开局', content: '秘密', bindId: 'role1', bindName: '千纱',
    } as any)!;
    expect((e as any).bindId).toBe('role1');
    expect((e as any).bindName).toBe('千纱');
    // 存下来之后也还在（页面验收 2026-09-28：新建的初始记忆丢绑定 → 1 对 1 校验跟着失效）
    const back = WBM.getAll().find(w => w.id === b.id)!.entries.find((x: any) => x.id === e.id)!;
    expect((back as any).bindId).toBe('role1');
  });
});

// ---------- 记录、撤回、按书隔离 ----------
describe('记录与撤回（按书存储，角色不写回）', () => {
  it('append 取写时刻的在场快照；撤回把记录与场景一起回滚', () => {
    const b = WBM.createBook('真实模式书');
    WBM.setActiveId(b.id);
    RealState.reset(b.id);
    RealState.setScene({ time: '次日清晨', place: '教室', present: ['千纱', '悠真'] });
    const snap = RealState.snapshot();
    const id = RealState.append({ kind: 'player', speaker: '千纱', raw: '早上好。' });
    RealState.setScene({ present: ['千纱'] });          // 悠真离场
    expect(id).toBeTruthy();
    expect(RealState.log().length).toBe(1);
    expect(RealState.log()[0].present).toEqual(['千纱', '悠真']);   // 写时刻的快照，不随场景变
    RealState.restore(snap);
    expect(RealState.log().length).toBe(0);
    expect(RealState.scene().present).toEqual(['千纱', '悠真']);
    expect(RealState.scene().place).toBe('教室');
  });

  it('popLast 删最后一条并返回它', () => {
    const b = WBM.createBook('撤回书');
    WBM.setActiveId(b.id);
    RealState.reset(b.id);
    RealState.append({ kind: 'npc', speaker: 'A', raw: '第一句' });
    RealState.append({ kind: 'npc', speaker: 'A', raw: '第二句' });
    expect(RealState.popLast()!.raw).toBe('第二句');
    expect(RealState.log().length).toBe(1);
  });

  it('记录上限常量沿用对话模式量级', () => {
    expect(RECORD_LIMIT).toBe(1200);
  });

  it('每本书各存一份（换书不串）', () => {
    const a = WBM.createBook('书A');
    WBM.setActiveId(a.id); RealState.reset(a.id);
    RealState.append({ kind: 'npc', speaker: 'A', raw: 'A 的事' });
    const b2 = WBM.createBook('书B');
    WBM.setActiveId(b2.id); RealState.reset(b2.id);
    expect(RealState.log().length).toBe(0);
    WBM.setActiveId(a.id);
    expect(RealState.log().length).toBe(1);
  });

  it('压缩判定：不足窗口不压；窗口为 0 永不压；upToId 找不到 → 从头算（宁可多压一次）', () => {
    const b = WBM.createBook('压缩书');
    WBM.setActiveId(b.id);
    RealState.reset(b.id);
    RealState.setScene({ present: ['A'] });
    RealState.append({ kind: 'npc', speaker: 'A', raw: '一句话。' });
    expect(RealState.shouldCompress('A', 100000)).toBe(false);
    expect(RealState.shouldCompress('A', 0)).toBe(false);
    expect(RealState.shouldCompress('', 1)).toBe(false);
    RealState.setMemory('A', '很久以前的事', 'rr_已经被截掉了');
    expect(RealState.shouldCompress('A', 1)).toBe(true);
  });

  it('reset 只清当前书', () => {
    const a = WBM.createBook('重置书A');
    WBM.setActiveId(a.id); RealState.reset(a.id);
    RealState.append({ kind: 'npc', speaker: 'A', raw: 'x' });
    RealState.reset(a.id);
    expect(RealState.log().length).toBe(0);
  });
});

// ---------- 防泄漏：私有条目绝不进常规世界书注入 ----------
describe('「初始记忆」不进常规注入', () => {
  it('selectInjectableEntries 跳过初始记忆（和变量/初始同档）', () => {
    const entries = [
      { id: 'r', type: '角色', name: '千纱', content: '角色卡', inject: true },
      { id: 'm', type: '初始记忆', name: '千纱的开局', bindId: 'r', content: '我的秘密', inject: true },
    ];
    expect(selectInjectableEntries(entries, 0).kept.map((e: any) => e.type)).toEqual(['角色']);
  });
  it('filterRelevantEntries 跳过初始记忆', () => {
    const b = WBM.createBook('注入书');
    WBM.setActiveId(b.id);
    const all = WBM.getAll();
    const bk = all.find(w => w.id === b.id)!;
    bk.entries = [
      { id: 'r', type: '角色', name: '千纱', content: 'x', inject: true },
      { id: 'm', type: '初始记忆', name: '千纱的开局', content: '秘密', inject: true },
    ];
    WBM.saveAll(all);
    expect(WBM.filterRelevantEntries().map((e: any) => e.type)).toEqual(['角色']);
  });
});
