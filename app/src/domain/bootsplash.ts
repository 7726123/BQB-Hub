// BootSplash：启动画面门面。
//
// 画面本身在 web/index.html 的内联样式 + 内联脚本里（必须早于 main.js 画出来，所以不能放在 bundle 里），
// 那里挂了 `window.__bootSplash = { hide, text, busy, skip, live }`。本模块只决定"写什么、什么时候收"。
//
// 约束（改动前先读）：
//   ① 没有启动画面时（老 index.html、浏览器调试、单测）**全部空操作**——缺画面绝不能影响启动；
//   ② 只做展示，不承担任何业务判断；更新流程的编排在 hotbundle/update 里；
//   ③ hide() 幂等：启动画面可能被多处收（检查结束、超时、bundle 加载失败、兜底定时器）。

export interface BootSplashApi {
  hide?: () => void;
  text?: (s: string) => void;
  busy?: (on: boolean) => void;
  skip?: (fn: (() => void) | null) => void;
  live?: () => void;
}

function _api(): BootSplashApi | null {
  try {
    const a = (globalThis as unknown as { __bootSplash?: BootSplashApi }).__bootSplash;
    return a && typeof a === 'object' ? a : null;
  } catch (e) { return null; }
}

export const BootSplash = {
  /** 当前是否真的有启动画面（老 index.html 里没有 → false，调用方据此走老路径） */
  available(): boolean { return !!_api(); },

  /** 状态行文字（如「正在检查更新…」） */
  text(s: string): void {
    const a = _api();
    if (a && a.text) { try { a.text(s); } catch (e) { /* 展示失败不影响流程 */ } }
  },

  /** 进度条：true = 显示（不确定长度的滑动动画）。下载/切换期间才显示，避免"假装在加载" */
  busy(on: boolean): void {
    const a = _api();
    if (a && a.busy) { try { a.busy(on); } catch (e) { /* ignore */ } }
  },

  /** 「稍后」按钮：显示进度条时一并露出；fn = null 表示这次不需要 */
  onSkip(fn: (() => void) | null): void {
    const a = _api();
    if (a && a.skip) { try { a.skip(fn); } catch (e) { /* ignore */ } }
  },

  /** 收起启动画面（幂等；淡出动画由内联样式负责） */
  hide(): void {
    const a = _api();
    if (a && a.hide) { try { a.hide(); } catch (e) { /* ignore */ } }
  },
};

export default BootSplash;
