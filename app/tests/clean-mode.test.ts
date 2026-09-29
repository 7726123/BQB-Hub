// 干净版（离线版）行为契约：开着这个开关时，**一个请求都不许发**，
// 手册里也不许再出现"找卡 / 待审核 / 网页包热更新"这类联机说法。
//
// 做法：isClean() 是运行期可翻的开关（lib/buildflags），这里直接翻它，
// 不必为干净版单独跑一遍构建；翻回来即恢复完整版语义（其余 1364 条用例不受影响）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { __setCleanForTest, isClean } from '../src/lib/buildflags';

import { UpdateManager } from '../src/domain/update';
import { HotBundle } from '../src/domain/hotbundle';
import { ClientLog } from '../src/domain/clientlog';
import { UsagePing } from '../src/domain/stats';
import { Feedback } from '../src/domain/feedback';
import { AdminMode } from '../src/domain/adminmode';
import '../src/domain/community';   // 副作用挂载：CommunityChat 只在 globalThis 上（模块内不 export）
import { UsageAssistant, USAGE_MANUAL, assistantSystem, manualForClean } from '../src/domain/assistant';
import { applyCleanUI, CLEAN_HIDDEN_SELECTORS } from '../src/domain/cleanui';

const CC = () => (globalThis as unknown as Record<string, any>).CommunityChat;

let calls: string[] = [];

/** CommunityChat 只在 globalThis 上（模块内不 export）。 */
function CommunityChat_init(): void {
  const c = CC();
  c.init();
}

function stubFetch(): void {
  calls = [];
  (globalThis as unknown as Record<string, unknown>).fetch = (u: unknown) => {
    calls.push(String(u));
    return Promise.reject(new Error('干净版不允许发请求'));
  };
}

beforeEach(() => {
  stubFetch();
  __setCleanForTest(true);
});

afterEach(() => {
  __setCleanForTest(false);
  vi.restoreAllMocks();
});

describe('干净版：任何启动链路都不发请求', () => {
  it('update / 热更新 / 统计 / 日志 / 社区 / 助手上报 全部早退', async () => {
    UpdateManager.init();
    HotBundle.init();
    HotBundle.prefetch('测试');
    HotBundle.check(false);
    UsagePing.init('1.5.99');
    ClientLog.flush('测试');
    AdminMode.syncBadge();
    AdminMode.sendTrace({ a: 1 });
    CommunityChat_init();
    UsageAssistant._uploadMissed();
    expect(calls).toEqual([]);
  });

  it('热更新其余入口也不下载、不换包', async () => {
    expect(await HotBundle.applyPending()).toBe(false);
    expect(HotBundle.applyPendingNow()).toBe(false);
    expect(HotBundle.commitPending('测试')).toBe(false);
    expect(calls).toEqual([]);
  });

  it('社区：检索与状态同步都停用', async () => {
    const c = CC();
    c.server = '';
    c.init();
    expect(c.server).toBe('');   // 干净版 init 不解析服务器地址
    await expect(c.searchCards('剑与魔法')).rejects.toThrow();
    c.onEnter();
    c.openAdminPanel();
    c.syncAdminEntry();
    expect(calls).toEqual([]);
  });

  it('反馈：提交直接拒绝，且不发请求', async () => {
    const r = await Feedback.submit();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('本版本');
    expect(calls).toEqual([]);
  });

  it('管理员模式：存档里有开关也不生效，连点也进不去', () => {
    const g = globalThis as unknown as Record<string, unknown>;
    g.StorageManager = { get: (k: string, d?: unknown) => (k === 'adminMode' ? true : d), set: () => undefined };
    expect(AdminMode.isOn()).toBe(false);
    let act: unknown = null;
    for (let i = 0; i < 12; i++) act = AdminMode.tap(1000 + i * 10);
    expect(act).toBe(null);
    g.StorageManager = { get: (_k: string, d?: unknown) => d, set: () => undefined };
  });
});

describe('干净版：助手手册与工具', () => {
  it('system 里不再有找卡能力，工具表为空', () => {
    const sys = assistantSystem();
    expect(sys).toContain('BQB Hub 使用助手');
    expect(sys).toContain('【手册未覆盖】');
    expect(sys).not.toContain('找卡');
    expect(sys).not.toContain('search_cards');
    expect(UsageAssistant._tools()).toEqual([]);
  });

  it('手册换掉联机小节，其余部分与完整版逐字相同', () => {
    const clean = manualForClean();
    // 联机小节换成离线版说明
    expect(clean).toContain('十二、联机功能（本版本没有）');
    expect(clean).toContain('十三、更新');
    expect(clean).toContain('应用商店');
    expect(clean).toContain('十五、意见反馈（本版本没有在线通道）');
    // 联机说法不再出现
    expect(clean).not.toContain('待审核');
    expect(clean).not.toContain('网页包热更新');
    expect(clean).not.toContain('登录社区');
    // 零散句子已改写
    expect(clean).toContain('世界书可导出 / 导入 JSON 备份');
    expect(clean).not.toContain('也可从社区下载他人分享的世界书');
    expect(clean).toContain('（正文、写卡、比奇统一生效）');
    // 非联机小节逐字沿用完整版（手册是两版共用的活文档，不能抄成两份）
    const full = USAGE_MANUAL.split('\n');
    const cl = clean.split('\n');
    expect(cl[0]).toBe(full[0]);
    expect(clean).toContain('二、章节与开局');
    expect(clean).toContain('十七、真实模式（多角色各自独立记忆的演出）');
    const u17 = full.find((l) => l.startsWith('1. 位置：侧栏「写作」下面的「真实模式」'));
    expect(u17).toBeTruthy();
    expect(clean).toContain(String(u17));
    // 完整版手册本身没有被改动
    expect(USAGE_MANUAL).toContain('也可从社区下载他人分享的世界书');
    expect(USAGE_MANUAL).toContain('网页包热更新');
  });

  it('完整版下 system 仍是老样子（含找卡能力与完整手册）', () => {
    __setCleanForTest(false);
    const sys = assistantSystem();
    expect(sys).toContain('【找卡能力】');
    expect(sys).toContain('待审核');
    expect(isClean()).toBe(false);
  });
});

describe('干净版：界面收尾', () => {
  it('摘掉社区/反馈/管理入口与找卡弹层', () => {
    const asked: string[] = [];
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = {
      querySelectorAll: (sel: string) => { asked.push(sel); return []; },
      querySelector: () => null,
      getElementById: () => null,
    };
    applyCleanUI();
    for (const sel of CLEAN_HIDDEN_SELECTORS) expect(asked).toContain(sel);
    expect(asked.some((s) => s.includes('data-view="community"'))).toBe(true);
    expect(asked.some((s) => s.includes('#tab-community'))).toBe(true);
  });

  it('完整版下什么都不动', () => {
    __setCleanForTest(false);
    let touched = false;
    const g = globalThis as unknown as Record<string, unknown>;
    g.document = {
      querySelectorAll: () => { touched = true; return []; },
      querySelector: () => { touched = true; return null; },
      getElementById: () => { touched = true; return null; },
    };
    applyCleanUI();
    expect(touched).toBe(false);
  });
});
