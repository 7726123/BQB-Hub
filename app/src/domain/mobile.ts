// MobileUI：侧边栏导航 / 移动端抽屉 / 下拉开合 / 输入框行为（从 www/modules/mobile.js 深度类型化）。
// 可测纯逻辑：导航视图名 → 面板 tab 名映射。

// 视图名 → 面板 tab 名（写作视图不进面板）
export function tabForView(viewName: string): string {
  const tabMap: Record<string, string> = {
    plugins: 'plugins', memory: 'memory', world: 'world',
    protagonist: 'protagonist',
    feedback: 'feedback',
    cardwriter: 'cardwriter', usageassist: 'usageassist',
    usage: 'usage', settings: 'advanced'
  };
  return tabMap[viewName] || viewName;
}

export const MobileUI: {
  readonly isMobile: boolean;
  init(): void;
  switchView(viewName: string): void;
  toggleDrawer(): void;
  closeDrawer(): void;
} = {
  get isMobile(): boolean {
    return Math.min(screen.width, screen.height) <= 1000 || !!(window.navigator as unknown as { standalone?: boolean }).standalone || screen.height < screen.width;
  },

  init(): void {
    if (typeof window.matchMedia !== 'function') return;

    // 侧边栏导航项：切换内容区（桌面 + 移动共用）
    document.querySelectorAll('#sidebar .nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        this.switchView((btn as HTMLElement).dataset.view || '');
        this.closeDrawer();
      });
    });

    // 侧边栏折叠（桌面）
    const collapseBtn = document.getElementById('sidebarCollapseBtn');
    const sidebar = document.getElementById('sidebar');
    if (collapseBtn && sidebar) {
      collapseBtn.addEventListener('click', () => {
        sidebar.classList.toggle('sidebar-collapsed');
        collapseBtn.textContent = sidebar.classList.contains('sidebar-collapsed') ? '›' : '‹';
        collapseBtn.title = sidebar.classList.contains('sidebar-collapsed') ? '展开侧边栏' : '收起侧边栏';
      });
    }

    // 汉堡按钮：打开/关闭移动端抽屉
    const hamburger = document.getElementById('hamburger-btn');
    if (hamburger) hamburger.addEventListener('click', () => this.toggleDrawer());

    // 遮罩点击关闭抽屉
    const mask = document.getElementById('mobileMask');
    if (mask) mask.addEventListener('click', () => this.closeDrawer());

    // 章节下拉：点击按钮开合，点外部关闭
    attachDropdownToggle('chDropdownBtn', 'ch-dropdown');

    // 顶部世界书切换：点书名开合下拉，点外部关闭
    const wbTitleBtn = document.getElementById('wbTitleBtn');
    const wbDropdown = document.getElementById('wbSwitchDropdown');
    if (wbTitleBtn && wbDropdown) {
      wbTitleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        UIManager.toggleWBSwitch?.();
      });
      document.addEventListener('click', (e) => {
        if (wbDropdown.classList.contains('open') && !wbDropdown.contains(e.target as Node) && !wbTitleBtn.contains(e.target as Node)) {
          UIManager.closeWBSwitch?.();
        }
      });
    }

    // 写作输入框：Enter 发送（Shift+Enter 换行）、自动增高
    const input = document.getElementById('writingInput') as HTMLTextAreaElement | null;
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          App.sendFromWritingInput?.();
        }
      });
      input.addEventListener('input', () => {
        // 自动增高（上限 maxHeight）；超高时滚动策略见下
        input.style.height = 'auto';
        const max = parseInt(getComputedStyle(input).maxHeight) || 120;
        input.style.height = Math.min(input.scrollHeight, max) + 'px';
        // 只在「光标原本就在末尾」（用户在最后一行追加输入）时才保持滚到最后一行；
        // 光标在中间（用户上移修改/插入前面内容）时不干预——浏览器默认让光标所在行
        // 保持可见，强制 scrollTop=scrollHeight 会把光标处顶出视口（滚到最后一排）。
        const isCursorAtEnd = input.selectionStart != null && input.selectionStart >= (input.value || '').length;
        if (isCursorAtEnd && input.scrollHeight > input.clientHeight + 1) input.scrollTop = input.scrollHeight;
      });
    }
    // 发送按钮的点击绑定只有 index.html 里的 onclick 一处。
    // 这里曾再 addEventListener 一次 → 一次点击触发两次 sendFromWritingInput()：
    // 第二次走「空输入」分支，把刚写入的场景草稿清掉，并因 isGenerating 已置位而静默 return。

    this.switchView('writing');
  },

  // 视图切换：写作=编辑器；其他=面板对应 tab
  switchView(viewName: string): void {
    document.querySelectorAll('#sidebar .nav-item').forEach(b => {
      b.classList.toggle('active', (b as HTMLElement).dataset.view === viewName);
    });

    const editorArea = document.getElementById('editor-area');
    const panel = document.getElementById('panel');

    if (viewName === 'writing') {
      if (editorArea) editorArea.style.display = 'flex';
      if (panel) panel.style.display = 'none';
    } else {
      if (editorArea) editorArea.style.display = 'none';
      if (panel) panel.style.display = 'flex';
    }

    // 激活对应 panel tab
    if (viewName !== 'writing') {
      const tab = tabForView(viewName);
      document.querySelectorAll('#panel-tabs button').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
      const btn = document.querySelector('#panel-tabs button[data-tab="' + tab + '"]');
      const content = document.getElementById('tab-' + tab);
      if (btn) btn.classList.add('active');
      if (content) content.classList.add('active');
      // 社区：进入时若未登录则弹登录框（可跳注册），已登录则加载列表
      if (viewName === 'community' && typeof CommunityChat !== 'undefined') CommunityChat.onEnter?.();
      // 记忆：刷新「正文窗口 + 世界书 + 回读」的估算上限（数字随当前世界书变化）
      // 反馈：进入时刷新字数计数与本机留档
      if (viewName === 'feedback' && typeof Feedback !== 'undefined' && Feedback.render) Feedback.render();
      if (viewName === 'memory' && typeof UIManager !== 'undefined' && UIManager.renderCtxBudgetHint) UIManager.renderCtxBudgetHint();
      // 设置：每次进入都回到「我的」主页并刷新动态状态
      if (viewName === 'settings' && typeof UIManager !== 'undefined' && UIManager.switchSubTab) {
        UIManager.switchSubTab?.('me');
        if (typeof UIManager.renderMePage === 'function') setTimeout(() => { try { UIManager.renderMePage?.(); } catch (e) { /* 忽略 */ } }, 50);
      }
    }
  },

  // ---- 移动端抽屉 ----
  toggleDrawer(): void {
    const sidebar = document.getElementById('sidebar');
    const mask = document.getElementById('mobileMask');
    if (!sidebar) return;
    const open = sidebar.classList.toggle('mobile-open');
    if (mask) mask.style.display = open ? 'block' : 'none';
  },
  closeDrawer(): void {
    const sidebar = document.getElementById('sidebar');
    const mask = document.getElementById('mobileMask');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (mask) mask.style.display = 'none';
  },

};

// 下拉开合 + 点外部关闭（按钮 id / 下拉容器 id）
function attachDropdownToggle(btnId: string, dropId: string): void {
  const btn = document.getElementById(btnId);
  const drop = document.getElementById(dropId);
  if (btn && drop) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      drop.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (drop.classList.contains('open') && !drop.contains(e.target as Node) && !btn.contains(e.target as Node)) {
        drop.classList.remove('open');
      }
    });
  }
}

(globalThis as unknown as { MobileUI: typeof MobileUI }).MobileUI = MobileUI;
export default MobileUI;