import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import '../src/infra/storage';
import { shouldUpdate } from '../src/domain/update';
import { stripMissMarker, buildMissConversation, recentContext, UsageAssistant, ASSISTANT_SYSTEM } from '../src/domain/assistant';
import { tabForView } from '../src/domain/mobile';

describe('UpdateManager 纯逻辑', () => {
  it('shouldUpdate：远端严格大于本地才提示', () => {
    expect(shouldUpdate(43, 42)).toBe(true);
    expect(shouldUpdate(42, 42)).toBe(false);
    expect(shouldUpdate(41, 42)).toBe(false);
    expect(shouldUpdate(0, 42)).toBe(false);
  });
});

describe('UsageAssistant 纯逻辑', () => {
  const marker = '【手册未覆盖】';

  it('stripMissMarker：剥离标记并去前导空白；无标记原样', () => {
    expect(stripMissMarker(marker + ' 这个功能可能没覆盖到，猜测是……', marker))
      .toBe('这个功能可能没覆盖到，猜测是……');
    expect(stripMissMarker('正常回答', marker)).toBe('正常回答');
    expect(stripMissMarker(marker + '直接回答', marker)).toBe('直接回答');
  });

  it('buildMissConversation：最近 N 条 + 截断 + 角色归一化', () => {
    const msgs = [
      { role: 'user' as const, content: '你好' },
      { role: 'assistant' as const, content: 'x'.repeat(600) },
      { role: 'assistant' as const, content: '长回答'.repeat(400) }
    ];
    const conv = buildMissConversation(msgs, 2, 500);
    expect(conv).toHaveLength(2);
    expect(conv[0].role).toBe('assistant');
    expect(conv[0].content.length).toBe(500); // 截断
    expect(conv[1].role).toBe('assistant');
  });

  it('recentContext：注入最近 20 轮（40 条）+ system，排除末尾占位', () => {
    const msgs: { role: 'user' | 'assistant'; content: string }[] = [];
    for (let i = 0; i < 50; i++) msgs.push({ role: 'user', content: 'm' + i });
    msgs.push({ role: 'assistant', content: '…' }); // 发送中的占位
    const ctx = recentContext(msgs);
    expect(ctx).toHaveLength(40);
    expect(ctx[0].content).toBe('m10');  // 最近 40 条起点
    expect(ctx[ctx.length - 1].content).toBe('m49');
    expect(ctx.some((m) => m.content === '…')).toBe(false); // 占位排除
  });

  it('recentContext：消息不足 41 条时全量（减去占位）', () => {
    const msgs = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b' },
      { role: 'assistant' as const, content: '…' }
    ];
    expect(recentContext(msgs)).toHaveLength(2);
  });

  it('_uploadMissed：无社区地址时静默跳过（不 fetch）', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.CommunityChat;
    UsageAssistant.messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    UsageAssistant._uploadCount = 0;
    UsageAssistant._uploadMissed();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('_uploadMissed：每会话上限 2 次，地址与内容正确', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    (globalThis as unknown as Record<string, unknown>).CommunityChat = { server: 'http://x:8899/' };
    UsageAssistant.messages = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
    UsageAssistant._uploadCount = 0;
    UsageAssistant._uploadMissed();
    UsageAssistant._uploadMissed();
    UsageAssistant._uploadMissed(); // 第 3 次被上限拦截
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(String(fetchSpy.mock.calls[0][0])).toBe('http://x:8899/api/usage-assistant/miss');
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    expect(body.conversation).toHaveLength(2);
    expect(body.conversation[0]).toEqual({ role: 'user', content: 'q' });
    fetchSpy.mockRestore();
  });

  it('ASSISTANT_SYSTEM 注入人设 + 手册 + 未覆盖标记规则', () => {
    expect(ASSISTANT_SYSTEM).toContain('BQB Hub 使用助手');
    expect(ASSISTANT_SYSTEM).toContain('使用手册');
    expect(ASSISTANT_SYSTEM).toContain('【手册未覆盖】');
    expect(ASSISTANT_SYSTEM).toContain('只解答本软件的使用问题');
  });

  it('使用手册覆盖全部侧栏页面与审核门（功能上线后手册不能漏）', () => {
    // 侧栏：写作 / 对话模式 / 插件 / 记忆 / 世界书 / 主角 / 使用助手 / 写卡 / 用量统计 / 社区 / 反馈 / 高级设置
    for (const s of ['一、开始写作', '二、章节与开局', '三、世界书', '四、主角', '五、记忆',
      '六、数据库', '七、写卡', '八、插件', '九、使用助手', '十、用量统计',
      '十一、高级设置', '十二、社区', '十三、更新', '十四、对话模式', '十五、意见反馈']) {
      expect(ASSISTANT_SYSTEM, s).toContain(s);
    }
    // 社区上传审核门（v1.5.86）：待审 / 我的 / 已驳回 都要讲清楚，否则用户会以为上传丢了
    expect(ASSISTANT_SYSTEM).toContain('待审核');
    expect(ASSISTANT_SYSTEM).toContain('已驳回');
    // 「Agent 设定同步」已下线（只留比奇）：手册里不能再提它，但要讲清比奇的临时世界书
    expect(ASSISTANT_SYSTEM).not.toContain('Agent 设定同步');
    expect(ASSISTANT_SYSTEM).toContain('临时世界书');
    // 酒馆卡玩法（导入 → 写卡改造）是用户最常问的一条，手册必须覆盖
    expect(ASSISTANT_SYSTEM).toContain('导入角色卡');
    expect(ASSISTANT_SYSTEM).toContain('改造成适配卡');
  });

  // 用户要求：高级设置底部那块「想让长文生成更稳」撤掉，改由助手回答。
  // 这里守住两件事：① 设置页不再有那块；② 手册里必须有对应的答案（省电策略 + 生成中断怎么办）。
  it('长文生成更稳那块的答案在手册里（设置页已撤掉，助手负责回答）', () => {
    expect(ASSISTANT_SYSTEM).toContain('省电策略');
    expect(ASSISTANT_SYSTEM).toContain('允许后台运行');
    expect(ASSISTANT_SYSTEM).toContain('续写已经生成的部分会留在正文里');
    const html = readFileSync(resolve(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
    expect(html.indexOf('想让长文生成更稳')).toBe(-1);
  });

  // 用户要求：助手要能回答现在的新功能（对话模式 / 热更新与启动画面 / 思考强度 / 缓存命中）
  it('手册覆盖新功能：对话模式、热更新与启动画面、思考强度、缓存命中', () => {
    for (const s of ['对话模式（演出视图）', '同一本书的两个视图', '回到最下面',
      '网页包热更新', '启动画面', '打开就是新版', '稍后',
      '思考与正文共用同一份输出额度', '额度被思考吃满',
      '缓存命中', '各存各的']) {
      expect(ASSISTANT_SYSTEM, s).toContain(s);
    }
  });
});

describe('MobileUI 纯逻辑', () => {
  it('tabForView 视图 → 面板 tab 映射', () => {
    expect(tabForView('memory')).toBe('memory');
    expect(tabForView('world')).toBe('world');
    expect(tabForView('cardwriter')).toBe('cardwriter');
    expect(tabForView('usageassist')).toBe('usageassist');
    expect(tabForView('usage')).toBe('usage');
    expect(tabForView('settings')).toBe('advanced');
    expect(tabForView('unknown')).toBe('unknown'); // 未知视图原样
  });
});