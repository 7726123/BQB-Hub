// 写卡 Agent 断线可续跑（A）：切到别的应用把连接掐断后，回到前台自动接着跑，
// 气泡下方也有「继续」——不用把整场讨论重说一遍。
// 为什么重发同一轮是安全的：工具调用只在整轮流完之后才执行（api.ts 的 onTools 在流末尾触发），
// 所以断在流中间的那一轮没有产生任何写入，重发不会重复改世界书。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/preset';
import '../src/domain/worldbook';
import '../src/domain/cardwriter';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const CW = () => g.CardWriterChat as Any;
const origDoc = g.document;

let fetchCalls: Any[] = [];
let visHandlers: Array<() => void> = [];

function installEnv(state = 'visible') {
  fetchCalls = [];
  visHandlers = [];
  g.App = {
    toast: vi.fn(), saveCurrentChapter: vi.fn(), resetChatInput: vi.fn(),
    thinkingLevel: () => 'off', isGenerating: false,
  };
  g.document = {
    visibilityState: state,
    getElementById: (id: string) => (id === 'cardwriterInput' ? { value: '把这张酒馆卡改造成适配卡' } : null),
    addEventListener: (ev: string, fn: () => void) => { if (ev === 'visibilitychange') visHandlers.push(fn); },
    removeEventListener: (ev: string, fn: () => void) => { if (ev === 'visibilitychange') visHandlers = visHandlers.filter((f) => f !== fn); },
    querySelector: () => null, querySelectorAll: () => [],
  };
  g.PresetManager.getActiveAPIConfig = () => ({ apiKey: 'k', endpoint: 'https://ep.example/v1', model: 'm1' });
  g.APIHandler = {
    probeToolsSupport: () => Promise.resolve(true),
    fetchCompletions: vi.fn((...args: Any[]) => { fetchCalls.push(args); return Promise.resolve(); }),
  };
  CW()._isSending = false;
  CW()._pausedResume = null;
  CW()._resumeWatcher = null;
  CW().messages = [];
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function fireVisibility(state: string) {
  g.document.visibilityState = state;
  visHandlers.slice().forEach((f) => f());
}

beforeEach(() => { installEnv(); });
afterEach(() => {
  vi.restoreAllMocks();
  g.document = origDoc;
  delete g.APIHandler;
  CW()._pausedResume = null;
});

describe('写卡断线可续跑', () => {
  it('请求失败 → 保留可续跑的轮次（气泡提示 + 绑好回到前台自动继续）', async () => {
    CW().sendMessage();
    await flush();
    expect(fetchCalls).toHaveLength(1);
    const onError = fetchCalls[0][3] as (e: string) => void;

    onError('网络错误: Failed to fetch');

    expect(typeof CW()._pausedResume).toBe('function');
    expect(visHandlers.length).toBe(1);           // 回到前台自动续跑
    const last = CW().messages[CW().messages.length - 1];
    expect(String(last.content)).toContain('连接中断');
    expect(CW()._isSending).toBe(false);          // 发送锁释放，用户能继续操作
  });

  it('回到前台自动续跑：重发同一份 messages（第 2 次请求）', async () => {
    CW().sendMessage();
    await flush();
    const msgs = fetchCalls[0][0];
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误: 连接被重置');

    fireVisibility('visible');
    await flush();

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1][0]).toBe(msgs);          // 同一轮：不是从头重来
    expect(CW()._pausedResume).toBeNull();        // 已续跑，按钮消失
    expect(visHandlers.length).toBe(0);           // 监听摘掉，不会反复触发
  });

  it('用户点「继续」：同样重发那一轮（手动路径）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('生成失败');
    expect(visHandlers.length).toBe(1);

    CW().resumePaused();

    await flush();
    expect(fetchCalls).toHaveLength(2);
    expect(CW()._isSending).toBe(true);
    expect(visHandlers.length).toBe(0);
  });

  it('发新消息 = 放弃待续（不会回前台又把旧请求跑起来）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    expect(CW()._pausedResume).toBeTruthy();

    CW().sendMessage();
    await flush();

    expect(CW()._pausedResume).toBeNull();
    expect(visHandlers.length).toBe(0);
    expect(fetchCalls).toHaveLength(2);           // 第 2 次是新消息，不是续跑
    expect(fetchCalls[1][0]).not.toBe(fetchCalls[0][0]);
  });

  it('续跑又失败 → 仍然可续（重新挂回待继续，锁也释放）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    CW().resumePaused();
    await flush();
    expect(fetchCalls).toHaveLength(2);
    // 第 2 次也断：走同一出口 → 再次变成"待继续"，用户还能接着点
    (fetchCalls[1][3] as unknown as (e: string) => void)('网络错误');
    expect(CW()._isSending).toBe(false);
    expect(typeof CW()._pausedResume).toBe('function');
    expect(visHandlers.length).toBe(1);
  });

  it('fetchCompletions 直接 reject（模块内异常）也走同一出口，不会卡死', async () => {
    CW().sendMessage();
    await flush();
    g.APIHandler.fetchCompletions = vi.fn(() => Promise.reject(new Error('boom')));
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');   // 第 1 次：断线待续
    CW().resumePaused();
    await flush();
    expect(CW()._isSending).toBe(false);         // 锁已释放（不会"点了继续没反应"）
    expect(typeof CW()._pausedResume).toBe('function');
  });

  it('正在发送时点「继续」不生效（不会并发两条请求）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    CW().resumePaused();          // 第 2 次请求在飞
    await flush();
    const before = fetchCalls.length;
    CW().resumePaused();          // _isSending = true → 忽略
    await flush();
    expect(fetchCalls).toHaveLength(before);
  });
});

// 上面是"进程内断线"的正路；下面这组是用户实际踩到的坑：
// 只切页面/切后台（进程还在）时会话也会被打断，而待继续状态只在内存里 ——
// 退出 App / WebView 重载后闭包丢失 → 按钮消失、或旧 DOM 上的按钮点了静默无效（无提示无报错）。
describe('写卡断线可续跑：退出/重载后仍能给「继续」+ 不再静默失败', () => {
  const toasts = () => String(g.App.toast.mock.calls.map((c: Any[]) => c[0]).join('|'));

  it('中断时把「待继续」标记持久化到消息上（重载后按钮靠它出现）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    const last = CW().messages[CW().messages.length - 1];
    expect(last.paused).toBeTruthy();
    expect(String(last.paused.text)).toContain('酒馆卡');
  });

  it('闭包已丢（模拟退出 App / WebView 重载）→ 点「继续」按上次要求重发，并明确告知', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    const markText = String(CW().messages[CW().messages.length - 1].paused.text);
    // 稳定输入框对象：默认桩每次返回新对象，重发路径赋值后读不到
    const input = { value: '' };
    g.document.getElementById = (id: string) => (id === 'cardwriterInput' ? input : null);
    CW()._pausedResume = null;      // 进程内闭包丢失（重载后就是这样）
    CW()._unbindResumeWatch();

    CW().resumePaused();
    await flush();

    expect(fetchCalls).toHaveLength(2);                        // 真的重跑了
    // 重发留下一条可见的用户消息（对话历史与世界书都是当前的，用户在气泡里看得到这次重发）
    const users = CW().messages.filter((m: Any) => m.role === 'user');
    expect(users).toHaveLength(2);                             // 原消息 + 这次重发
    expect(String(users[users.length - 1].content)).toBe(markText);
    expect(toasts()).toContain('重新跑一遍');
  });

  it('没有任何可续的东西 → 明确说明（不再"点了没反应"）', async () => {
    CW().messages = [{ role: 'assistant', content: '（未收到有效回复，请重试）' }];
    CW()._pausedResume = null;
    CW().resumePaused();
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(toasts()).toContain('把要求再发一次');
  });

  it('发送锁卡住时点「继续」→ 提示去点发送键上的「暂停」（不再静默返回）', async () => {
    CW()._isSending = true;
    CW().resumePaused();
    await flush();
    expect(fetchCalls).toHaveLength(0);
    expect(toasts()).toContain('暂停');   // 发送键在生成中的第二态（原先是横条里的「停止」按钮）
  });

  it('「暂停」释放发送锁并清掉待继续（锁卡死时的自救入口）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    expect(CW().messages[CW().messages.length - 1].paused).toBeTruthy();

    CW()._isSending = true;         // 模拟"请求卡住"：锁一直挂着
    CW().stopTurn();

    expect(CW()._isSending).toBe(false);
    expect(CW()._pausedResume).toBeNull();
    expect(CW().messages[CW().messages.length - 1].paused).toBeUndefined();
    expect(toasts()).toContain('已停止本轮');
  });

  it('正常收尾会清掉「待继续」标记（按钮随之消失）', async () => {
    CW().sendMessage();
    await flush();
    (fetchCalls[0][3] as unknown as (e: string) => void)('网络错误');
    expect(CW().messages[CW().messages.length - 1].paused).toBeTruthy();

    CW().resumePaused();            // 再跑一次
    await flush();
    const onDone = fetchCalls[1][2] as (t: string) => void;
    onDone('好了');
    await flush();

    expect(CW().messages[CW().messages.length - 1].paused).toBeUndefined();
  });
});

// 发送键双态（v1.5.97.9）：生成中把发送键变成「暂停」，输出完/掐断后变回「发送」。
// 背景：原来是在上下文横条里另塞一个「停止」按钮，把那条横条挤坏了（书选择/上下文信息/
// 两个开关/查看菜单本来就在同一行）——改成一个键承担两种状态，既省地方又符合直觉。
describe('发送键：发送 ↔ 暂停 双态', () => {
  function installSendBtn(): Any {
    const cls = new Set<string>(['primary', 'small']);
    const btn: Any = {
      textContent: '发送', title: '发送',
      classList: {
        toggle: (c: string, on?: boolean) => { if (on) cls.add(c); else cls.delete(c); },
        contains: (c: string) => cls.has(c),
      },
    };
    const inner = g.document.getElementById;
    g.document.getElementById = (id: string) => (id === 'cwSendBtn' ? btn : inner(id));
    return btn;
  }

  it('空闲：显示「发送」，点它就走发送', async () => {
    const btn = installSendBtn();
    CW()._isSending = false;
    CW()._syncSendState();
    expect(btn.textContent).toBe('发送');
    expect(btn.classList.contains('danger')).toBe(false);
    expect(btn.classList.contains('primary')).toBe(true);

    CW().onSendOrPause();
    await flush();
    expect(fetchCalls).toHaveLength(1);       // 真的发出去了
  });

  it('生成中：显示「暂停」，点它掐断本轮而不是再发一条', async () => {
    const btn = installSendBtn();
    CW().sendMessage();
    await flush();
    expect(CW()._isSending).toBe(true);

    CW()._syncSendState();
    expect(btn.textContent).toBe('暂停');
    expect(btn.title).toContain('掐断');
    expect(btn.classList.contains('danger')).toBe(true);
    expect(btn.classList.contains('primary')).toBe(false);

    CW().onSendOrPause();
    await flush();
    expect(CW()._isSending).toBe(false);       // 发送锁释放
    expect(fetchCalls).toHaveLength(1);        // 关键：没有因为点「暂停」又发一条
    expect(String(g.App.toast.mock.calls.map((c: Any[]) => c[0]).join('|'))).toContain('已停止本轮');
  });

  it('本轮结束后自动变回「发送」（不需要手动干预）', async () => {
    const btn = installSendBtn();
    CW().sendMessage();
    await flush();
    CW()._syncSendState();
    expect(btn.textContent).toBe('暂停');

    const onDone = fetchCalls[0][2] as (t: string) => void;
    onDone('好的');
    await flush();
    CW()._syncSendState();                     // renderMessages 里会调；这里直接验证状态映射
    expect(btn.textContent).toBe('发送');
    expect(btn.classList.contains('primary')).toBe(true);
  });

  it('没有发送键元素时不抛错（旧页面/测试环境降级）', () => {
    g.document.getElementById = () => null;
    CW()._isSending = true;
    expect(() => CW()._syncSendState()).not.toThrow();
  });
});
