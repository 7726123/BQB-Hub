// 网页包热更新前端门面：启动确认 / 回退提示 / 安装调用 / 失败静默与诊断上报 / 版本展示串
//
// 说明：验签与解包在原生侧（已由 tools/hotbundle-selftest 用真密钥实测），
// 这里只测前端职责：状态读取、确认时机、手动与静默两种反馈路径、以及绝不阻塞/绝不抛出。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { HotBundle, manualResultText } from '../src/domain/hotbundle';
import { offerHotApply } from '../src/domain/update';
import { ClientLog } from '../src/domain/clientlog';
import { formatVersion, getWebVersion, setWebVersion } from '../src/lib/webver';

interface Calls { getState: number; confirm: string[]; install: { serverBase: string; payload: string; sig: string }[]; clearBlocked: number }
let calls: Calls;
let stateReply: Record<string, unknown>;
let installReply: unknown;
let installReject: Error | null;
const notes: string[] = [];
const toasts: string[] = [];

function stubPlugin(): void {
  calls = { getState: 0, confirm: [], install: [], clearBlocked: 0 };
  (globalThis as unknown as Record<string, unknown>).window = globalThis;
  (globalThis as unknown as Record<string, unknown>).Capacitor = {
    getPlatform: () => 'android',
    Plugins: {
      HotBundle: {
        getState: () => { calls.getState++; return Promise.resolve(stateReply); },
        confirm: (o: { version: string }) => { calls.confirm.push(o.version); return Promise.resolve({ ok: true }); },
        install: (o: { serverBase: string; payload: string; sig: string }) => {
          calls.install.push(o);
          return installReject ? Promise.reject(installReject) : Promise.resolve(installReply);
        },
        clearBlocked: () => { calls.clearBlocked++; return Promise.resolve({ ok: true }); },
      },
    },
  };
  (globalThis as unknown as Record<string, unknown>).App = { toast: (m: string) => { toasts.push(m); } };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  setWebVersion('');
  notes.length = 0; toasts.length = 0;
  HotBundle._state = null;      // 模块级状态：不清会串到下一个用例（导致跳过安装）
  HotBundle._lastResult = null;
  stateReply = { active: '', pending: '', code: 0, blocked: '', nativeCode: 157 };
  installReply = { ok: true, version: '1.5.97w1', code: 157001, seeded: 2, useState: 'nextLaunch' };
  installReject = null;
  stubPlugin();
  vi.spyOn(ClientLog, 'note').mockImplementation((t: string, m: string) => { notes.push(t + '|' + m); });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as unknown as Record<string, unknown>).Capacitor;
  delete (globalThis as unknown as Record<string, unknown>).App;
  // 还原默认断网桩，避免影响其它用例
  (globalThis as unknown as Record<string, unknown>).fetch = () => Promise.reject(new Error('network disabled in tests'));
});

describe('启动：状态读取与确认', () => {
  test('跑内置资源时不确认、版本为空', async () => {
    HotBundle.init();
    await flush();
    expect(calls.getState).toBe(1);
    expect(calls.confirm).toEqual([]);
    expect(getWebVersion()).toBe('');
  });

  test('已确认的热包：记录版本、不再重复确认', async () => {
    stateReply = { active: '1.5.97w1', pending: '', code: 157001, blocked: '', nativeCode: 157 };
    HotBundle.init();
    await flush();
    expect(calls.confirm).toEqual([]);
    expect(getWebVersion()).toBe('1.5.97w1');
  });

  test('待确认的新包：立刻 confirm（能跑到这里就说明新包 JS 起来了）', async () => {
    stateReply = { active: '1.5.97w1', pending: '1.5.97w2', code: 157002, blocked: '', nativeCode: 157 };
    HotBundle.init();
    await flush();
    expect(calls.confirm).toEqual(['1.5.97w2']);
    expect(getWebVersion()).toBe('1.5.97w2');
  });

  test('原生核对实际加载目录后拒绝确认（Capacitor 没采纳 serverBasePath）→ 不谎报版本号', async () => {
    // 场景：pending 已装但页面其实来自内置资源。原生会返回 ok:false，此时绝不能把 pending 记成本机版本。
    stateReply = { active: '1.5.97w1', pending: '1.5.97w2', code: 157002, blocked: '', nativeCode: 157, serving: 'public', isAsset: true };
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        HotBundle: {
          getState: () => { calls.getState++; return Promise.resolve(stateReply); },
          confirm: (o: { version: string }) => { calls.confirm.push(o.version); return Promise.resolve({ ok: false }); },
          install: () => Promise.resolve({}),
        },
      },
    };
    HotBundle.init();
    await flush();
    expect(calls.confirm).toEqual(['1.5.97w2']);   // 仍然调用（原生要留日志、看门狗照常生效）
    expect(getWebVersion()).toBe('1.5.97w1');      // 但版本号只认正在跑的那个
  });

  test('被回退过：版本归零、上报诊断并提示用户', async () => {
    stateReply = { active: '', pending: '', code: 0, blocked: '1.5.97w3', nativeCode: 157, rolledBack: '1.5.97w3' };
    HotBundle.init();
    await flush();
    expect(getWebVersion()).toBe('');
    expect(notes.join('\n')).toContain('1.5.97w3');
    expect(toasts.join('\n')).toContain('已自动回退');
  });

  test('原生状态读取抛错时静默（绝不阻塞启动）', async () => {
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: { HotBundle: { getState: () => Promise.reject(new Error('boom')), install: () => Promise.resolve({}) } },
    };
    expect(() => HotBundle.init()).not.toThrow();
    await flush();
    expect(getWebVersion()).toBe('');
  });

  test('非 Android / 无插件时完全不动（桌面与测试环境）', async () => {
    delete (globalThis as unknown as Record<string, unknown>).Capacitor;
    HotBundle.init();
    HotBundle.check(true);
    await flush();
    expect(calls.getState).toBe(0);
    expect(getWebVersion()).toBe('');
  });
});

describe('检查与安装', () => {
  const manifest = { payload: 'cGF5bG9hZA==', sig: 'c2ln', v: '1.5.97w1' };

  function stubFetch(body: unknown, ok = true) {
    (globalThis as unknown as Record<string, unknown>).fetch = () =>
      Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
  }

  test('拿到 manifest 后原样交给原生，成功提示「下次启动生效」', async () => {
    stubFetch(manifest);
    const seen: unknown[] = [];
    HotBundle.check(true, (r) => seen.push(r));
    await flush();
    expect(calls.install.length).toBe(1);
    expect(calls.install[0].payload).toBe(manifest.payload);
    expect(calls.install[0].sig).toBe(manifest.sig);
    expect(calls.install[0].serverBase).toContain('43.155.128.242');
    expect(toasts.join('\n')).toContain('下次启动自动生效');
    expect(notes.join('\n')).toContain('已就绪');
    expect(seen).toEqual([{ installed: true, version: '1.5.97w1' }]);
  });

  test('安装被原生拒绝（验签失败/需更新 APK）时给出手动提示并留诊断', async () => {
    installReject = new Error('包校验失败：签名校验不通过');
    stubFetch(manifest);
    HotBundle.check(true);
    await flush();
    expect(toasts.join('\n')).toContain('更新失败');
    expect(notes.join('\n')).toContain('签名校验不通过');
  });

  test('服务器未发布热包（空对象）：静默，交由调用方提示「已是最新」', async () => {
    stubFetch({});
    const seen: { installed?: boolean; reason?: string }[] = [];
    HotBundle.check(true, (r) => seen.push(r));
    await flush();
    expect(calls.install.length).toBe(0);
    expect(toasts).toEqual([]);                 // 本模块不提示，避免与调用方重复弹两条
    expect(seen).toEqual([{ installed: false }]); // 无 installed / 无 reason = 没有更新的包
    expect(notes).toEqual([]);
  });

  test('静默模式（启动时的检查）不发 toast，只在失败时留诊断', async () => {
    stubFetch(null, false);
    HotBundle.check();
    await flush();
    expect(toasts).toEqual([]);
    expect(notes.join('\n')).toContain('检查失败');
  });

  test('静默模式的失败不带用户文案（reason 为空）', async () => {
    stubFetch(null, false);
    const seen: { installed?: boolean; reason?: string }[] = [];
    HotBundle.check(false, (r) => seen.push(r));
    await flush();
    expect(seen).toEqual([{ installed: false, reason: '' }]);
  });

  test('网络异常时不抛出（fetch 直接 reject 的路径）', async () => {
    (globalThis as unknown as Record<string, unknown>).fetch = () => Promise.reject(new Error('offline'));
    const seen: { installed?: boolean; reason?: string }[] = [];
    expect(() => HotBundle.check(true, (r) => seen.push(r))).not.toThrow();
    await flush();
    expect(seen.length).toBe(1);
    expect(seen[0].reason).toContain('网络错误');
  });

  test('无原生插件时也回调一次（老 APK 上调用方仍能提示「已是最新」）', async () => {
    delete (globalThis as unknown as Record<string, unknown>).Capacitor;
    const seen: unknown[] = [];
    HotBundle.check(true, (r) => seen.push(r));
    await flush();
    expect(seen).toEqual([{ installed: false }]);
    expect(calls.install.length).toBe(0);
  });

  test('回调恰好一次（成功/未发布/失败三条路径都已覆盖）', async () => {
    stubFetch(manifest);
    let n = 0;
    HotBundle.check(true, () => { n++; });
    await flush();
    installReject = new Error('boom');
    HotBundle.check(true, () => { n++; });
    await flush();
    stubFetch({});
    HotBundle.check(true, () => { n++; });
    await flush();
    expect(n).toBe(3);
  });

  test('clearBlocked 透传到原生', async () => {
    HotBundle.clearBlocked();
    await flush();
    expect(calls.clearBlocked).toBe(1);
  });
});

// 背景（2026-09-22 线上）：连点 10 下进管理员模式时每一下都会触发检查，而 w2 已装好后
// 再检查会撞上原生「不比当前版本新」的降级防护，被当成"安装失败"弹给用户。
// 现在改成先比本地版本状态，装好待重启/正在跑都不再走安装。
describe('已装未生效 / 已在运行：不再触发安装（避免"安装失败"误报）', () => {
  const manifest = { payload: 'cGF5bG9hZA==', sig: 'c2ln', v: '1.5.97w2' };
  function stubFetch(body: unknown) {
    (globalThis as unknown as Record<string, unknown>).fetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }

  test('待生效的那一版 = 服务端给的这一版 → 不调安装，提示重启后生效', async () => {
    stateReply = { active: '1.5.97w1', pending: '1.5.97w2', code: 157001, blocked: '', nativeCode: 157 };
    HotBundle.init();
    await flush();
    stubFetch(manifest);
    const seen: unknown[] = [];
    HotBundle.check(true, (r) => seen.push(r));
    await flush();
    expect(calls.install.length).toBe(0);
    expect(seen).toEqual([{ installed: false, ready: true, version: '1.5.97w2' }]);
    expect(toasts.join('\n')).toContain('重启 App 后生效');
    expect(notes.join('\n')).not.toContain('安装');
  });

  test('正在跑的就是最新 → 不调安装、不报错（交给调用方提示"已是最新"）', async () => {
    stateReply = { active: '1.5.97w2', pending: '', code: 157002, blocked: '', nativeCode: 157 };
    HotBundle.init();
    await flush();
    stubFetch(manifest);
    const seen: { installed?: boolean; ready?: boolean; reason?: string }[] = [];
    HotBundle.check(true, (r) => seen.push(r));
    await flush();
    expect(calls.install.length).toBe(0);
    expect(seen).toEqual([{ installed: false }]);
    expect(toasts).toEqual([]);
  });

  test('服务端有新包（版本号不同）时照常安装', async () => {
    stateReply = { active: '1.5.97w1', pending: '1.5.97w2', code: 157001, blocked: '', nativeCode: 157 };
    HotBundle.init();
    await flush();
    stubFetch({ payload: 'cGF5bG9hZA==', sig: 'c2ln', v: '1.5.97w3' });
    installReply = { ok: true, version: '1.5.97w3', code: 157003 };
    HotBundle.check(true);
    await flush();
    expect(calls.install.length).toBe(1);
    expect(calls.install[0].payload).toBe('cGF5bG9hZA==');
  });
});

describe('就地生效（applyPendingNow）', () => {
  test('当前跑热包：推出待生效目录并调内置 WebView 插件换目录', async () => {
    const sets: { path: string }[] = [];
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        HotBundle: {
          getState: () => Promise.resolve(stateReply),
          install: () => Promise.resolve({}),
        },
        WebView: {
          setServerBasePath: (o: { path: string }) => { sets.push(o); return Promise.resolve(); },
        },
      },
    };
    stateReply = {
      active: '1.5.97w1', pending: '1.5.97w2', code: 157001, blocked: '', nativeCode: 157,
      serving: '/data/user/0/com.novelwriter.app/files/hot/1.5.97w1',
    };
    HotBundle.init();
    await flush();
    expect(HotBundle.applyPendingNow()).toBe(true);
    await flush();
    expect(sets[0].path).toBe('/data/user/0/com.novelwriter.app/files/hot/1.5.97w2');
  });

  test('当前跑内置资源（拿不到热包目录）：不动手，提示下次启动生效', async () => {
    stateReply = {
      active: '', pending: '1.5.97w2', code: 0, blocked: '', nativeCode: 157, serving: 'public', isAsset: true,
    };
    HotBundle.init();
    await flush();
    expect(HotBundle.applyPendingNow()).toBe(false);
    expect(toasts.join('\n')).toContain('下次打开 App');
  });

  test('没有待生效的包时什么都不做', async () => {
    stateReply = { active: '1.5.97w1', pending: '', code: 157001, blocked: '', nativeCode: 157, serving: '/x/hot/1.5.97w1' };
    HotBundle.init();
    await flush();
    expect(HotBundle.applyPendingNow()).toBe(false);
  });

  // 原生方法（APK 158 起）优先：目录由原生算（内置资源也能切）、切完 arm 看门狗
  test('原生有 applyPending 时优先用它，不再走 WebView 插件', async () => {
    let native = 0;
    const sets: unknown[] = [];
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        HotBundle: {
          getState: () => Promise.resolve(stateReply),
          install: () => Promise.resolve({}),
          applyPending: () => { native++; return Promise.resolve({ ok: true, version: '1.5.97w2' }); },
        },
        WebView: { setServerBasePath: (o: unknown) => { sets.push(o); return Promise.resolve(); } },
      },
    };
    stateReply = { active: '1.5.97w1', pending: '1.5.97w2', code: 157001, blocked: '', nativeCode: 158, serving: 'public', isAsset: true };
    HotBundle.init();
    await flush();
    expect(HotBundle.applyPendingNow()).toBe(true);
    await flush();
    expect(native).toBe(1);
    expect(sets).toEqual([]);                                  // 原生成功 → 不动 WebView 那条路
    expect(notes.join('\n')).toContain('原生就地生效');
  });

  test('原生 applyPending 失败时退回 WebView 插件（跑内置资源时它切不了，给"下次打开"提示）', async () => {
    const sets: unknown[] = [];
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        HotBundle: {
          getState: () => Promise.resolve(stateReply),
          install: () => Promise.resolve({}),
          applyPending: () => Promise.reject(new Error('没有待生效的网页包')),
        },
        WebView: { setServerBasePath: (o: unknown) => { sets.push(o); return Promise.resolve(); } },
      },
    };
    stateReply = { active: '', pending: '1.5.97w2', code: 0, blocked: '', nativeCode: 158, serving: 'public', isAsset: true };
    HotBundle.init();
    await flush();
    expect(HotBundle.applyPendingNow()).toBe(true);            // 发出了切换（先走原生）
    await flush();
    expect(notes.join('\n')).toContain('原生就地生效失败');
    expect(sets).toEqual([]);                                  // 内置资源 → WebView 路径也切不了
    expect(toasts.join('\n')).toContain('下次打开 App');
  });
});

// 启动画面还盖着时的自动检查：安装 → 就地切换 → 页面重载（不回调），以及 8 秒预算
describe('启动画面期间的更新（boot splash）', () => {
  const manifest = { payload: 'cGF5bG9hZA==', sig: 'c2ln', v: '1.5.97w2' };
  const splash = { hide: 0, text: [] as string[], busy: [] as boolean[], skip: 0 };

  function stubSplash(): void {
    splash.hide = 0; splash.text = []; splash.busy = []; splash.skip = 0;
    (globalThis as unknown as Record<string, unknown>).__bootSplash = {
      hide: () => { splash.hide++; },
      text: (s: string) => { splash.text.push(s); },
      busy: (on: boolean) => { splash.busy.push(on); },
      skip: () => { splash.skip++; },
      live: () => {},
    };
  }
  function stubFetch(body: unknown) {
    (globalThis as unknown as Record<string, unknown>).fetch = () =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  }

  beforeEach(() => { stubSplash(); });
  afterEach(() => { delete (globalThis as unknown as Record<string, unknown>).__bootSplash; });

  test('启动期间装上就地生效：显示同步状态、回调不触发（页面即将重载）', async () => {
    let native = 0;
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        HotBundle: {
          getState: () => Promise.resolve(stateReply),
          install: () => Promise.resolve({ ok: true, version: '1.5.97w2' }),
          applyPending: () => { native++; return Promise.resolve({ ok: true }); },
        },
      },
    };
    stateReply = { active: '1.5.97w1', pending: '', code: 157001, blocked: '', nativeCode: 158, serving: '/x/hot/1.5.97w1' };
    HotBundle.init();
    await flush();
    stubFetch(manifest);
    const seen: unknown[] = [];
    HotBundle.check(false, (r) => seen.push(r));
    await flush();
    await flush();
    expect(splash.text).toContain('正在同步最新版本…');
    expect(splash.text).toContain('正在准备新版本…');
    expect(splash.busy).toEqual([true]);
    expect(native).toBe(1);
    expect(seen).toEqual([]);          // 页面要重载了：不回调，调用方也就不会去收启动画面
    expect(splash.hide).toBe(0);       // （新包自己的启动画面接上，中间不闪旧界面）
  });

  test('安装超过预算就不再等：回调一次、画面由调用方收起（原生那边继续装）', async () => {
    (globalThis as unknown as Record<string, unknown>).Capacitor = {
      getPlatform: () => 'android',
      Plugins: {
        HotBundle: {
          getState: () => Promise.resolve(stateReply),
          install: () => new Promise(() => { /* 永不完成，模拟慢网 */ }),
          applyPending: () => Promise.resolve({ ok: true }),
        },
      },
    };
    stateReply = { active: '1.5.97w1', pending: '', code: 157001, blocked: '', nativeCode: 158, serving: '/x/hot/1.5.97w1' };
    HotBundle.init();
    await flush();
    stubFetch(manifest);
    HotBundle._bootBudgetMs = 20;
    try {
      const seen: { installed?: boolean }[] = [];
      HotBundle.check(false, (r) => seen.push(r));
      await new Promise((r) => setTimeout(r, 60));
      expect(seen.length).toBe(1);
      expect(seen[0].installed).toBe(false);
      expect(notes.join('\n')).toContain('不再等');
    } finally { HotBundle._bootBudgetMs = 8000; }
  });

  test('没有更新的包：不显示进度、回调一次（调用方据此收起画面）', async () => {
    stubFetch({ v: '1.5.97w1', payload: 'x', sig: 'y' });
    stateReply = { active: '1.5.97w1', pending: '', code: 157001, blocked: '', nativeCode: 158, serving: '/x/hot/1.5.97w1' };
    HotBundle.init();
    await flush();
    const seen: unknown[] = [];
    HotBundle.check(false, (r) => seen.push(r));
    await flush();
    expect(seen).toEqual([{ installed: false }]);
    expect(splash.busy).toEqual([]);
    expect(splash.text).toEqual([]);
  });
});

describe('版本展示', () => {
  test('内置资源：只显示 APK 版本', () => {
    setWebVersion('');
    expect(formatVersion('v1.5.96')).toBe('v1.5.96');
  });

  // 用户要求：界面上只显示正常版本号（热更新不改版本号，不再出现「网页包 x」第二版本名）
  test('热包生效时界面仍只显示正常版本号', () => {
    setWebVersion('1.5.97.1');
    expect(formatVersion('v1.5.96')).toBe('v1.5.96');
  });

  test('手动检查文案', () => {
    expect(manualResultText({ installed: true, version: '1.5.97.1' })).toContain('1.5.97.1');
    expect(manualResultText({ installed: false })).toBe('已是最新版本');
    expect(manualResultText({ installed: false, reason: '网络错误' })).toBe('网络错误');
  });
});

// 手动检查装好之后：问一句"要不要立即生效"（就地重载），而不是让用户自己去退出重开 App。
describe('立即生效的询问（offerHotApply）', () => {
  test('弹确认框，文案说明会丢未保存输入与取消后的行为', () => {
    const msgs: string[] = [];
    let applied = 0;
    offerHotApply('1.5.97w2', (m, cb) => { msgs.push(m); cb(); }, () => { applied++; });
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('1.5.97w2');
    expect(msgs[0]).toContain('未保存');
    expect(msgs[0]).toContain('下次打开 App');
    expect(applied).toBe(1);          // 用户点确定 → 执行生效
  });

  test('用户取消（不回调）时不会执行生效', () => {
    let applied = 0;
    offerHotApply('1.5.97w2', () => { /* 用户点了取消：不调用回调 */ }, () => { applied++; });
    expect(applied).toBe(0);
  });

  test('没有确认框可用时不抛错、不打扰', () => {
    expect(() => offerHotApply('1.5.97w2', undefined, undefined)).not.toThrow();
  });
});
