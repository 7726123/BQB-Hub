// 干净版（离线版）界面收尾：把"联机功能"的入口从静态 DOM 里摘掉。
//
// index.html 两个版本共用一份（2289 行 HTML 若做成两份必然漂移），
// 所以这里在启动时按开关摘除 —— 完整版调用本函数时直接返回，什么都不做。
import { isClean } from '../lib/buildflags';

/** 整体摘掉的入口：导航项、面板 Tab、面板本体、找卡弹层。 */
export const CLEAN_HIDDEN_SELECTORS: string[] = [
  '#sidebar .nav-item[data-view="community"]',
  '#sidebar .nav-item[data-view="feedback"]',
  '#sidebar #navAdminBtn',
  '#panel-tabs button[data-tab="community"]',
  '#panel-tabs button[data-tab="admin"]',
  '#tab-community',
  '#tab-feedback',
  '#asCardModal',
];

function _setText(sel: string, text: string): void {
  const el = document.querySelector(sel);
  if (el) el.textContent = text;
}

function _setPlaceholder(sel: string, text: string): void {
  const el = document.querySelector(sel);
  if (el) (el as HTMLTextAreaElement).placeholder = text;
}

/** 干净版启动时调用一次：摘入口 + 改掉"找卡/社区"字样的文案。 */
export function applyCleanUI(): void {
  if (!isClean()) return;
  try {
    for (const sel of CLEAN_HIDDEN_SELECTORS) {
      document.querySelectorAll(sel).forEach((n) => {
        try { n.remove(); } catch (e) { /* 摘不掉也不影响其它功能 */ }
      });
    }
    // 助手页：本版本不帮找卡
    _setText('#assistantHint', '只解答本软件的使用问题');
    _setPlaceholder('#assistantInput', '问用法（如「世界书怎么用」「记忆窗口是什么」）');
    // 高级设置 → 外观：字号作用范围不再提社区消息
    _setText('#fontScopeSub', '正文、写卡、比奇统一');
    // 高级设置 → 关于：「检查更新」改成应用商店的提示，不留任何在线检查入口
    const btn = document.getElementById('aboutUpdateBtn');
    if (btn) {
      btn.removeAttribute('onclick');
      btn.onclick = function () {
        try {
          const g = globalThis as unknown as { App?: { toast?: (m: string) => void } };
          g.App?.toast?.('本版本通过应用商店更新：应用商店 → 我的 → 应用更新');
        } catch (e) { /* ignore */ }
      };
    }
  } catch (e) { /* 界面收尾失败不影响其它功能 */ }
}
