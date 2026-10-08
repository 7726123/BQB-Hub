import { SM } from '../infra/gate';
import { WorldBookManager } from './worldbook';
import { visibleEntriesFor } from './ui';   // 普通用户看不到真实模式专用条目（同界面口径）
import { AdminMode } from './adminmode'; // 管理员令牌（世界书接口按需附带）
import { defaultServerBase } from '../lib/server-url';
import { buildWbMetaPrompt, parseWbMeta } from '../lib/wbmeta';
import { isClean } from '../lib/buildflags';
export interface CommunityChatShape {
  [k: string]: any;
  DEFAULT_SERVER?: any;
  server?: any;
  _wbBooks?: any;
  predItems?: any;
  _predBooks?: any;
  method?: any;
  headers?: any;
  wbLoaded?: any;
  id?: any;
  entries?: any;
  promptModules?: any;
  regexScripts?: any;
  isDefault?: any;
}

// 管线化迁移（源码与 www/modules/community.js 逐行一致）：
// 该模块属 UI/胶水层超大文件：全库 strict 类型检查下（无 @ts-nocheck 指令），
// 接口化标注 + 拆分进行中（见 docs/single-bundle-refactor.md）。
// 尾部由 build-legacy.mjs 自动追加全局挂载（IIFE 产物内顶层声明不可见）。
// ==================== 社区（世界书 + 预设） ====================
// 服务端 server/src/ 完全内置，用户无需配置任何地址。
// 结构：二级 Tab（世界书/预设）。
const CommunityChat: CommunityChatShape = {
  // ===== 社区服务地址：默认按系统版本选 http/https（lib/server-url.ts 为唯一入口）=====
  // 必须惰性求值：Capacitor 全局在 bundle 顶层执行时可能尚未注入，那时读不到平台/UA，
  // 会在新系统上误判为不支持自签信任而回落明文。init()（DOMContentLoaded 之后）访问时才算。
  get DEFAULT_SERVER() { return defaultServerBase(); },

  server: '', token: '', user: null,
  currentWbCat: '全部', currentWbDetail: null, currentPredDetail: null,
  _wbBooks: [], _wbCover: '', _cropFor: 'wb', _cropSrc: '', _cropScale: 1, _cropOffX: 0, _cropOffY: 0, _cropStageW: 280, _cropStageH: 420, _cropX: 0, _cropY: 0, _cropW: 0, _cropH: 0,
  predItems: [], predTotal: 0, predPage: 1, predPageSize: 20, predLoaded: false,
  predQuery: '',
  _predBooks: [], _predCover: '',

  // ---------- 生命周期（async: 等 StorageManager 就绪） ----------
  init() {
    // 干净版：没有社区（入口与面板已由 cleanui 摘除）——不解析地址、不渲染登录态
    if (isClean()) return;
    this.server = String(SM().get<any>('communityServer', '') || this.DEFAULT_SERVER).trim().replace(/\/+$/, '');
    this.loadState();
    this.renderStatus();
  },

  loadState() {
    this.token = String(SM().get<any>('communityToken', '') || '');
    this.user = SM().get<any>('communityUser', null);
  },
  saveAuth(token: any, user: any) {
    this.token = token; this.user = user;
    SM().set('communityToken', token);
    SM().set('communityUser', user);
  },

  // 请求头：登录态 + 管理员令牌。管理员模式下才带上 X-Admin-Token，
  // 服务端据此放行 admin_only 数据集（测试世界书：仅管理员可见 / 可检索）。
  // withAdmin=true 时附带管理员令牌（只有世界书接口需要；其余接口不带，减少暴露面）
  /** 管理接口专用头：只要管理员令牌（/api/admin/review 与 /api/admin/stats 都只认它，不需要社区登录） */
  adminHeaders(): any {
    var h: any = {};
    try {
      var tk = (typeof AdminMode !== 'undefined' && AdminMode.traceToken) ? AdminMode.traceToken() : '';
      if (tk) h['X-Admin-Token'] = tk;
    } catch (e) { /* 忽略 */ }
    return h;
  },
  authHeaders(withAdmin?: any): any {
    var h: any = { 'Authorization': 'Bearer ' + this.token };
    try {
      if (withAdmin && typeof AdminMode !== 'undefined' && AdminMode.isOn && AdminMode.isOn()) {
        var tk = AdminMode.traceToken ? AdminMode.traceToken() : '';
        if (tk) h['X-Admin-Token'] = tk;
      }
    } catch (e) { /* 忽略 */ }
    return h;
  },
  // 带 JSON body 的写请求头：authHeaders 只带鉴权头，POST 还必须声明 Content-Type，
  // 否则 express.json() 不解析 body（服务端收到空对象 →「未知的卡片类型」）。
  jsonHeaders(withAdmin?: any): any {
    return Object.assign({ 'Content-Type': 'application/json' }, this.authHeaders(withAdmin));
  },

  // ---------- 找卡检索（助手用）：整句口语查询 → 候选列表 ----------
  // 返回 { items:[{id,title,description,tags,meta:{genre,audience,relation,franchise,nsfw,chars,entryCount,words},downloads}], total, modes }
  searchCards(q: any, opts?: any): Promise<any> {
    if (isClean()) return Promise.reject(new Error('本版本不含社区检索'));   // 干净版：不发检索请求
    var o = opts || {};
    var url = this.server + '/api/worldbook/search?q=' + encodeURIComponent(String(q || '')) + '&pageSize=' + (o.limit || 8);
    if (o.sort) url += '&sort=' + encodeURIComponent(o.sort);
    if (o.strict) url += '&strict=1';
    if (o.nsfw != null && o.nsfw !== '') url += '&nsfw=' + encodeURIComponent(o.nsfw);
    return fetch(url, { headers: this.authHeaders(true) }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    });
  },

  // 预览条目（不计下载数）：助手详情弹层用
  previewCard(id: any): Promise<any> {
    return fetch(this.server + '/api/worldbook/preview?id=' + encodeURIComponent(String(id)), { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  },

  // 按 id 下载并导入本地世界书库（助手「下载」按钮 / import_card 工具共用）
  importCardById(id: any): Promise<any> {
    var self = this;
    return fetch(this.server + '/api/worldbook/download?id=' + encodeURIComponent(String(id)), { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (text) {
        var data = JSON.parse(text);
        var name = String(data.title || data.name || '导入世界书').trim();
        var entries = visibleEntriesFor(Array.isArray(data.entries) ? data.entries : []);
        var wb = {
          id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: name, title: name,
          entries: entries,
          description: String(data.description || '').slice(0, 500),
          cover: '', createdAt: Date.now(), importedAt: Date.now()
        };
        if (typeof WorldBookManager === 'undefined' || !WorldBookManager.getAll) throw new Error('世界书模块不可用');
        var all = WorldBookManager.getAll();
        all.push(wb);
        WorldBookManager.saveAll(all);
        if (WorldBookManager.setActiveId) WorldBookManager.setActiveId(wb.id);
        try { UIManager.renderWorldBooks && UIManager.renderWorldBooks(); UIManager.renderWBEntries && UIManager.renderWBEntries(); } catch (e) { /* 忽略 */ }
        try { self.loadWorldbookList(); } catch (e) { /* 非社区页打开时忽略 */ }
        return { name: name, entries: (wb.entries || []).length };
      });
  },

  // ---------- 进入社区（由 mobile.js switchView 调用） ----------
  onEnter() {
    if (isClean()) return;   // 干净版：没有社区页
    this.loadState(); // 每次进入都重新读取存储，确保登录状态一致
    this.renderStatus();
    // 「管理」入口与社区登录无关（它只依赖管理员模式）→ 放在登录判断之前同步，
    // 否则未登录时进社区页会直接弹登录框、入口永远等不到同步。
    this.syncAdminEntry();
    // 未注册/未登录 → 直接弹登录框（可跳注册）
    if (!this.token || !this.user) { this.openLogin(); return; }
    // 已登录 → 加载世界书列表（默认落在世界书 Tab）
    this.loadWorldbookList();
    // 老会话本地没存邮箱 → 补拉一次（个人中心要显示真实登录邮箱）
    if (!String(this.user.email || '').trim()) this.refreshProfile();
  },

  // ---------- 顶栏用户图标状态 ----------
  renderStatus() {
    var btn = document.getElementById('commUserBtn');
    if (btn) {
      var letter = this.user ? String(this.user.username || '').trim().charAt(0) : '';
      btn.textContent = letter || '👤';
      btn.classList.toggle('logged-in', !!this.user);
      btn.title = this.user ? this.user.username : '未登录';
    }
  },

  // ---------- 用户独立界面（个人中心弹窗） ----------
  toggleUserPanel() {
    // 未登录：直接弹登录框
    if (!this.token || !this.user) { this.openLogin(); return; }
    this.openUserPanel();
  },
  // 顶栏共用搜索栏已移除（改为「社区」标题，各 Tab 用自己的搜索框）——不再往顶栏回写
  // 世界书内部搜索框输入：存状态后触发加载（不回头读 DOM——页面上另有同名的编辑器过滤框，
  // 靠 getElementById 取值会取到它，社区搜索框会静默失效）
  onWbSearchSync(val: any) {
    this.wbQuery = String(val == null ? '' : val);
    this._scheduleWbSearch();
  },
  // 搜索防抖：停止输入 250ms 后重新加载（自动回到第 1 页）
  _scheduleWbSearch() {
    var self = this;
    if (this._wbSearchTimer) clearTimeout(this._wbSearchTimer);
    this._wbSearchTimer = setTimeout(function () {
      self._wbSearchTimer = null;
      if (!self.token) return;
      self.wbPage = 1;
      self.loadWorldbookList();
    }, 250);
  },
  // 预设内部搜索框输入：存状态后触发加载（同世界书，不读 DOM）
  onPredSearchSync(val: any) {
    this.predQuery = String(val == null ? '' : val);
    this._schedulePredSearch();
  },
  // 预设搜索防抖：停止输入 250ms 后重新加载（自动回到第 1 页）
  _schedulePredSearch() {
    var self = this;
    if (this._predSearchTimer) clearTimeout(this._predSearchTimer);
    this._predSearchTimer = setTimeout(function () {
      self._predSearchTimer = null;
      if (!self.token) return;
      self.predPage = 1;
      self.loadPresetList();
    }, 250);
  },
  openUserPanel() {
    var nick = document.getElementById('cpNickname');
    if (nick) nick.textContent = this.user.username;
    // 邮箱栏 = 让用户知道自己是用哪个邮箱登录的 → 显示真实邮箱（不再脱敏）；
    // 老会话本地存的 user 可能没有 email（登录接口早期不返回），这里补拉一次 /api/auth/me
    var email = document.getElementById('cpEmail');
    if (email) email.textContent = String(this.user.email || '').trim() || '未绑定邮箱';
    if (!String(this.user.email || '').trim()) this.refreshProfile();
    UIManager!.showModal('modalCommunityProfile');
    this.cpSwitchTab('wb');
  },
  // 补齐/刷新本地用户信息（email 等）——只更新本地缓存，失败静默
  refreshProfile() {
    var self = this;
    if (!this.token) return;
    fetch(this.server + '/api/auth/me', { headers: this.authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.user) return;
        self.user = {
          id: j.user.id, username: j.user.username || self.user.username,
          email: String(j.user.email || '').trim(),
        };
        SM().set('communityUser', self.user);
        var el = document.getElementById('cpEmail');
        if (el) el.textContent = self.user.email || '未绑定邮箱';
        self.renderStatus();
      })
      .catch(function () { /* 静默：离线时沿用本地缓存 */ });
  },
  closeUserPanel() { UIManager!.closeModal('modalCommunityProfile'); },
  // 个人中心分类切换：我的世界书 / 我的预设
  cpSwitchTab(which: any) {
    var wbTab = document.getElementById('cpTabWb');
    var presetTab = document.getElementById('cpTabPreset');
    var wbPane = document.getElementById('cpWbPane');
    var presetPane = document.getElementById('cpPresetPane');
    if (!wbPane || !presetPane) return;
    if (which === 'preset') {
      if (wbTab) wbTab.style.color = 'var(--text-muted)'; if (wbTab) wbTab.style.fontWeight = '400'; if (wbTab) wbTab.style.borderBottomColor = 'transparent';
      if (presetTab) presetTab.style.color = 'var(--primary)'; if (presetTab) presetTab.style.fontWeight = '600'; if (presetTab) presetTab.style.borderBottomColor = 'var(--primary)';
      wbPane.style.display = 'none';
      presetPane.style.display = 'flex';
      this.loadMySubmissions();
    } else {
      if (wbTab) wbTab.style.color = 'var(--primary)'; if (wbTab) wbTab.style.fontWeight = '600'; if (wbTab) wbTab.style.borderBottomColor = 'var(--primary)';
      if (presetTab) presetTab.style.color = 'var(--text-muted)'; if (presetTab) presetTab.style.fontWeight = '400'; if (presetTab) presetTab.style.borderBottomColor = 'transparent';
      wbPane.style.display = 'flex';
      presetPane.style.display = 'none';
      this.loadMySubmissions();
    }
  },
  // ---------- 我的投稿（个人中心）：三类内容的全状态列表 + 审核状态徽标 ----------
  // 上传后要过管理员审核才公开，未过审的稿子不在公开列表里 —— 作者只能在这里看到自己的稿子与状态。
  _subs: [],
  loadMySubmissions() {
    var self = this;
    var wbPane = document.getElementById('cpWbPane');
    var prPane = document.getElementById('cpPresetPane');
    if (!this.token) return;
    if (wbPane) wbPane.innerHTML = '<div class="cup-empty">加载中...</div>';
    if (prPane) prPane.innerHTML = '<div class="cup-empty">加载中...</div>';
    fetch(this.server + '/api/my/submissions?limit=100', { headers: this.authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self._subs = j.items || [];
        self.renderMySubmissions();
      })
      .catch(function () {
        if (wbPane) wbPane.innerHTML = '<div class="cup-empty">加载失败</div>';
        if (prPane) prPane.innerHTML = '<div class="cup-empty">加载失败</div>';
      });
  },
  // 审核状态徽标（已通过是默认状态，不显示，免得列表全是标签）
  _subBadge(st: any) {
    if (st === 'pending') return '<span class="cup-badge pending">待审核</span>';
    if (st === 'rejected') return '<span class="cup-badge rejected">已驳回</span>';
    return '';
  },
  renderMySubmissions() {
    var self = this;
    var all = this._subs || [];
    var build = function (list: any[], emptyText: any, icon: any, kind: any) {
      if (!list.length) return '<div class="cup-empty">' + emptyText + '</div>';
      var s = '';
      list.forEach(function (it: any) {
        var thumb = it.cover
          ? '<img src="' + self._escAttr(it.cover) + '" alt="">'
          : (icon || (Array.from(String(it.title || '?'))[0] || '?'));
        var tip = it.status === 'pending' ? '审核通过后别人才能看到 · '
          : (it.status === 'rejected' ? '未通过审核 · ' : '');
        s += '<div class="cup-wb-item" onclick="CommunityChat.openMySubDetail(\'' + kind + '\',' + it.id + ')">' +
          '<div class="cup-wb-thumb">' + thumb + '</div>' +
          '<div class="cup-wb-info"><div class="cup-wb-title">' + self._esc(it.title) + self._subBadge(it.status) + '</div>' +
          '<div class="cup-wb-meta">' + tip + '⬇ ' + (it.downloads || 0) + ' 次下载</div></div>' +
          (it.status === 'approved' ? ''
            : '<button class="small" onclick="CommunityChat.deleteMySub(\'' + kind + '\',' + it.id + ',event)">删除</button>') +
          '</div>';
      });
      return s;
    };
    var wbPane = document.getElementById('cpWbPane');
    var prPane = document.getElementById('cpPresetPane');
    if (wbPane) {
      wbPane.innerHTML = build(all.filter(function (x: any) { return x.type === 'worldbook'; }), '还没有上传过世界书', '', 'worldbook');
    }
    if (prPane) {
      prPane.innerHTML = build(all.filter(function (x: any) { return x.type === 'preset'; }), '还没有上传过预设', '🎛', 'preset');
    }
  },
  // 点自己的投稿：能开到详情弹层看内容（插件没有客户端界面，不处理）
  openMySubDetail(kind: any, id: any) {
    if (kind === 'preset') this.openPredDetail(id);
    else if (kind === 'worldbook') this.openWbDetail(id);
  },
  // 删除自己的投稿（待审/已驳回的稿子）
  deleteMySub(kind: any, id: any, ev: any) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var self = this;
    var path = kind === 'preset' ? '/api/preset/delete?id=' : '/api/worldbook/delete?id=';
    var doDel = function () {
      fetch(self.server + path + id, { method: 'DELETE', headers: self.authHeaders() })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) { App.toast(res.j.error || '删除失败'); return; }
          App.toast('已删除');
          self.loadMySubmissions();
        })
        .catch(function (e) { App.toast('网络错误: ' + e.message); });
    };
    if (typeof UIManager.showConfirm === 'function') UIManager.showConfirm('确定删除这份投稿吗？', doDel);
    else if (window.confirm('确定删除这份投稿吗？')) doDel();
  },

  // ============================ 审核队列（管理员模式） ============================
  // 入口只在管理员模式下注入到社区顶栏（连点 10 下「检查更新」进管理员模式）。
  // 请求带 X-Admin-Token（authHeaders(true)），服务端 isAdminReq 校验；令牌 12 小时过期，
  // 过期后重新进一次管理员模式即可（提示文案里写明了）。
  _rvwType: '', _rvwStatus: 'pending', _rvwItems: [], _rvwPending: 0,
  _admStats: null as any,
  // 意见反馈（管理端）：当前筛选 + 列表缓存
  _fbStatus: 'unread' as 'unread' | 'read' | 'all',
  _fbItems: [] as any[],
  _fbMeta: null as any,

  syncAdminEntry() {
    if (isClean()) return;   // 干净版：没有管理端入口
    var self = this;
    try {
      var on = !(typeof AdminMode === 'undefined' || !AdminMode.isOn || !AdminMode.isOn());
      // 管理是「社区/用量统计」同级的页面 tab：入口在 index.html 里（默认隐藏），这里只控制显隐。
      var nav = document.getElementById('navAdminBtn');
      var tabBtn = document.getElementById('tabBtnAdmin');
      var panel = document.getElementById('tab-admin');
      if (nav) nav.style.display = on ? '' : 'none';
      if (tabBtn) tabBtn.style.display = on ? '' : 'none';
      if (!on) {
        // 退出管理员模式时如果正停在管理页，退回社区页，别留一个打不开的空页
        if (panel && panel.classList.contains('active')) {
          try { MobileUI.switchView('community'); } catch (e) { panel.classList.remove('active'); }
        }
        return;
      }
      this.refreshReviewBadge();
    } catch (e) { /* 纯显隐控制：失败不影响社区其他功能 */ }
  },
  /** 入口文案：平时就一个「管理」，有待审时把数量带出来（原来「待审 N」的提示作用不丢） */
  _adminBtnText(): string {
    return this._rvwPending ? '管理 · 待审 ' + this._rvwPending : '管理';
  },
  _applyAdminBadge(): void {
    var label = document.getElementById('navAdminLabel');
    if (label) label.textContent = this._adminBtnText();
    var tabBtn = document.getElementById('tabBtnAdmin');
    if (tabBtn) tabBtn.textContent = this._adminBtnText();
  },
  refreshReviewBadge() {
    var self = this;
    if (typeof AdminMode === 'undefined' || !AdminMode.isOn || !AdminMode.isOn()) return;
    fetch(this.server + '/api/admin/review?status=pending&limit=1', { headers: this.adminHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        var c = j.counts || {};
        self._rvwPending = (c.worldbook || 0) + (c.preset || 0) + (c.plugin || 0);
        self._applyAdminBadge();
      })
      .catch(function () { /* 静默：令牌过期时保持原样，打开页面会提示 */ });
  },
  /** 进入管理页：切到该 tab 并拉取统计与待审队列（侧边栏入口与面板 tab 都调它） */
  openAdminPanel() {
    if (isClean()) return;   // 干净版：没有管理端
    this._rvwType = '';
    this._rvwStatus = 'pending';
    try { MobileUI.switchView('admin'); } catch (e) { /* 视图切换失败也照样拉数据 */ }
    this._renderReviewTabs();
    this.loadReviewQueue();
    this.loadAdminStats();
    this.loadAdminFeedback();
  },

  // ---------- 意见反馈（管理端）----------
  // 只在进管理页时拉一次（不轮询：服务器承压主要来自轮询，未读数另外由 /api/admin/stats 顺带返回）
  setFeedbackStatus(st: any) {
    var v = String(st || 'unread');
    if (v !== 'unread' && v !== 'read' && v !== 'all') v = 'unread';
    this._fbStatus = v;
    this._renderFeedbackTabs();
    this.loadAdminFeedback();
  },

  _renderFeedbackTabs() {
    var pairs: Array<[string, string]> = [['fbTabUnread', 'unread'], ['fbTabRead', 'read'], ['fbTabAll', 'all']];
    for (var i = 0; i < pairs.length; i++) {
      var el = document.getElementById(pairs[i][0]);
      if (el) el.classList.toggle('primary', pairs[i][1] === this._fbStatus);
    }
  },

  loadAdminFeedback() {
    var self = this;
    var box = document.getElementById('fbList');
    var empty = document.getElementById('fbEmpty');
    if (box) box.innerHTML = '<div class="cup-empty">加载中...</div>';
    if (empty) empty.style.display = 'none';
    fetch(this.server + '/api/admin/feedback?status=' + encodeURIComponent(this._fbStatus) + '&limit=50', { headers: this.adminHeaders() })
      .then(function (r) {
        if (r.status === 404) throw new Error('服务器还没更新到这个版本（需要部署服务端）');
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (j) {
        self._fbItems = (j && j.items) || [];
        self._fbMeta = j || {};
        self._renderFeedbackTabs();
        self.renderAdminFeedback();
      })
      .catch(function (e) {
        if (box) box.innerHTML = '<div class="cup-empty">加载失败（' + self._esc(String(e && e.message || e)) + '）</div>';
      });
  },

  renderAdminFeedback() {
    var box = document.getElementById('fbList');
    var empty = document.getElementById('fbEmpty');
    var meta = document.getElementById('fbAdminMeta');
    var m = this._fbMeta || {};
    if (meta) {
      meta.textContent = '未查看 ' + (m.unread || 0) + ' / 已查看 ' + (m.read || 0) + ' / 共 ' + (m.total || 0)
        + (m.trimmed ? '（超出 1000 条上限已清理 ' + m.trimmed + ' 条最旧的已查看）' : '');
    }
    this._renderFeedbackTabs();
    if (!box) return;
    if (!this._fbItems.length) {
      box.innerHTML = '';
      if (empty) { empty.style.display = ''; empty.textContent = this._fbStatus === 'unread' ? '没有未查看的反馈' : '暂无内容'; }
      return;
    }
    if (empty) empty.style.display = 'none';
    var self = this;
    box.innerHTML = this._fbItems.map(function (it: any) {
      var unread = !it.read_at;
      var when = new Date(Number(it.created_at) || 0).toLocaleString();
      var metaLine = [when, it.version ? 'v' + self._esc(String(it.version)) : '', self._esc(String(it.platform || ''))]
        .filter(Boolean).join(' · ');
      return '<div class="card" style="padding:8px 10px;' + (unread ? 'border-left:3px solid var(--primary);' : '') + '">'
        + '<div style="font-size:11px;color:var(--text-muted);">' + metaLine + (unread ? ' · <b>未查看</b>' : '') + '</div>'
        + '<div style="font-size:13px;white-space:pre-wrap;word-break:break-word;margin-top:4px;">' + self._esc(String(it.text || '')) + '</div>'
        + '<div style="display:flex;gap:6px;margin-top:6px;">'
        + (unread ? '<button class="small" onclick="CommunityChat.markFeedbackRead(' + Number(it.id) + ')">标记已读</button>' : '')
        + '<button class="small danger" onclick="CommunityChat.deleteFeedback(' + Number(it.id) + ')">删除</button>'
        + '</div></div>';
    }).join('');
  },

  _fbPost(path: string, body: any) {
    var self = this;
    return fetch(this.server + '/api/admin/feedback' + path, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, this.adminHeaders()),
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return r.json();
    }).then(function (j) { return j; })
      .catch(function (e) {
        try { App.toast('操作失败（' + String(e && e.message || e) + '）'); } catch (e2) { /* ignore */ }
        return null;
      });
  },

  markFeedbackRead(id: any) {
    var self = this;
    this._fbPost('/read', { ids: [Number(id)] }).then(function (r: any) {
      if (r) { self.loadAdminFeedback(); self.loadAdminStats(); }
    });
  },

  markAllFeedbackRead() {
    var self = this;
    this._fbPost('/read', { all: true }).then(function (r: any) {
      if (r) { try { App.toast('已全部标为已读' + (r.changed ? '（' + r.changed + ' 条）' : '')); } catch (e) { /* ignore */ } self.loadAdminFeedback(); self.loadAdminStats(); }
    });
  },

  deleteFeedback(id: any) {
    var self = this;
    // 确认框在 UIManager 上（社区模块没有自己的 showConfirm）；拿不到就退回原生 confirm
    var go = function () {
      self._fbPost('/delete', { id: Number(id) }).then(function (r: any) {
        if (r) self.loadAdminFeedback();
      });
    };
    try {
      if (typeof UIManager !== 'undefined' && UIManager.showConfirm) { UIManager.showConfirm('删除这条反馈？删了就找不回来了。', go); return; }
    } catch (e) { /* 落到原生确认 */ }
    if (window.confirm('删除这条反馈？删了就找不回来了。')) go();
  },

  // ---------- 使用统计（管理面板顶部） ----------
  // 口径见 server/src/routes/system.js 的 /api/admin/stats：在线=最后心跳 5 分钟内；
  // 今日/近 7 天/近 30 天按安装标识去重（滚动窗口，不是自然周月——自然周在周一早上会归零，看不出趋势）。
  loadAdminStats() {
    var self = this;
    var ids = ['admStatOnline', 'admStatToday', 'admStatWeek', 'admStatMonth'];
    for (var i = 0; i < ids.length; i++) {
      var el = document.getElementById(ids[i]);
      if (el) el.textContent = '–';
    }
    var updated = document.getElementById('admStatsUpdated');
    if (updated) updated.textContent = '加载中…';
    fetch(this.server + '/api/admin/stats', { headers: this.adminHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self._admStats = j || {};
        self.renderAdminStats();
      })
      .catch(function (e) {
        var meta = document.getElementById('admStatMeta');
        if (meta) {
          meta.textContent = '统计加载失败（' + self._esc(String((e && e.message) || e)) + '）'
            + '：管理员令牌 12 小时过期，重新连点 10 下「检查更新」进一次管理员模式即可。';
        }
        var u = document.getElementById('admStatsUpdated');
        if (u) u.textContent = '';
      });
  },
  renderAdminStats() {
    var j = this._admStats || {};
    var put = function (id: string, v: any) {
      var el = document.getElementById(id);
      if (el) el.textContent = (v === null || v === undefined || v === '') ? '0' : String(v);
    };
    put('admStatOnline', j.online);
    put('admStatToday', j.today);
    put('admStatWeek', j.week);
    put('admStatMonth', j.month);
    var updated = document.getElementById('admStatsUpdated');
    if (updated) {
      var win = Math.round((Number(j.onlineWindowMs) || 0) / 60000);
      updated.textContent = '（' + String(j.day || '') + ' · 在线 = ' + win + ' 分钟内有心跳）';
    }
    var meta = document.getElementById('admStatMeta');
    if (meta) meta.textContent = '累计设备 ' + (j.total || 0) + ' 台 · 今日新增 ' + (j.newToday || 0) + ' 台' + (j.feedbackUnread ? ' · 未查看反馈 ' + j.feedbackUnread + ' 条' : '');
    var vers = document.getElementById('admStatVersions');
    if (vers) {
      var fmt = function (list: any[], key: string, emptyLabel: string) {
        if (!list || !list.length) return '—';
        return list.map(function (x) {
          var label = String(x[key] || '') || emptyLabel;
          return label + ' × ' + (x.c || 0);
        }).join('、');
      };
      vers.textContent = '版本：' + fmt(j.versions, 'v', '未知')
        + '　｜　代码版本：' + fmt(j.webs, 'w', '内置');
    }
  },
  setReviewType(t: any) { this._rvwType = String(t || ''); this._renderReviewTabs(); this.loadReviewQueue(); },
  setReviewStatus(s: any) { this._rvwStatus = String(s || 'pending'); this._renderReviewTabs(); this.loadReviewQueue(); },
  _renderReviewTabs() {
    var pairs = [['rvwTabAll', ''], ['rvwTabWorldbook', 'worldbook'], ['rvwTabPreset', 'preset'], ['rvwTabPlugin', 'plugin']];
    for (var i = 0; i < pairs.length; i++) {
      var el = document.getElementById(pairs[i][0]);
      if (el) el.classList.toggle('primary', pairs[i][1] === this._rvwType);
    }
    var st = [['rvwStPending', 'pending'], ['rvwStApproved', 'approved'], ['rvwStRejected', 'rejected']];
    for (var k = 0; k < st.length; k++) {
      var el2 = document.getElementById(st[k][0]);
      if (el2) el2.classList.toggle('primary', st[k][1] === this._rvwStatus);
    }
  },
  loadReviewQueue() {
    var self = this;
    var box = document.getElementById('rvwList');
    if (box) box.innerHTML = '<div class="cup-empty">加载中...</div>';
    var url = this.server + '/api/admin/review?status=' + encodeURIComponent(this._rvwStatus) + '&limit=50'
      + (this._rvwType ? '&type=' + encodeURIComponent(this._rvwType) : '');
    fetch(url, { headers: this.adminHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self._rvwItems = j.items || [];
        var c = j.counts || {};
        self._rvwPending = (c.worldbook || 0) + (c.preset || 0) + (c.plugin || 0);
        self._applyAdminBadge();
        self.renderReviewQueue();
      })
      .catch(function (e) {
        if (box) {
          box.innerHTML = '<div class="cup-empty">加载失败（' + self._esc(String(e && e.message || e)) + '）<br>'
            + '管理员令牌 12 小时过期：重新连点 10 下「检查更新」进一次管理员模式即可。</div>';
        }
      });
  },
  renderReviewQueue() {
    var box = document.getElementById('rvwList');
    if (!box) return;
    var self = this;
    var items = this._rvwItems || [];
    var labels: any = { worldbook: '世界书', preset: '预设', plugin: '插件' };
    var empty = document.getElementById('rvwEmpty');
    if (!items.length) {
      box.innerHTML = '';
      if (empty) { empty.style.display = ''; empty.textContent = this._rvwStatus === 'pending' ? '没有待审核的内容' : '没有内容'; }
      return;
    }
    if (empty) empty.style.display = 'none';
    var s = '';
    items.forEach(function (it: any) {
      var kind = String(it.type || '');
      var canOpen = kind === 'worldbook' || kind === 'preset';
      var title = canOpen
        ? '<span style="cursor:pointer;text-decoration:underline;" onclick="CommunityChat.openMySubDetail(\'' + kind + '\',' + it.id + ')">' + self._esc(it.title) + '</span>'
        : self._esc(it.title);
      var meta = (labels[kind] || self._esc(kind)) + ' · ' + self._esc(it.author_name || '—') + ' · ' + self._relTime(it.created_at);
      var btns = it.status === 'pending'
        ? '<button class="small primary" onclick="CommunityChat.reviewAction(\'' + kind + '\',' + it.id + ',\'approve\',event)">通过</button>' +
          '<button class="small danger" onclick="CommunityChat.reviewAction(\'' + kind + '\',' + it.id + ',\'reject\',event)">驳回</button>'
        : '<span class="cup-wb-meta">' + (it.status === 'approved' ? '已通过' : '已驳回') + '</span>';
      s += '<div class="cup-wb-item" style="cursor:default;">' +
        '<div class="cup-wb-info"><div class="cup-wb-title">' + title + self._subBadge(it.status) + '</div>' +
        '<div class="cup-wb-meta">' + meta + '</div></div>' + btns + '</div>';
    });
    box.innerHTML = s;
  },
  reviewAction(type: any, id: any, action: any, ev: any) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var self = this;
    var doIt = function () {
      fetch(self.server + '/api/admin/review/action', {
        method: 'POST',
        headers: self.jsonHeaders(true),
        body: JSON.stringify({ type: type, id: id, action: action })
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) { App.toast(res.j.error || '操作失败'); return; }
          App.toast(action === 'approve' ? '已通过：现在对所有人可见' : '已驳回：只有作者本人能看到');
          if (action === 'approve') { // 通过后公开列表应立刻能看到
            self.wbLoaded = false; self.loadWorldbookList();
            self.predLoaded = false; self.loadPresetList();
          }
          self.loadReviewQueue();
        })
        .catch(function (e) { App.toast('网络错误: ' + e.message); });
    };
    if (action === 'reject' && typeof UIManager.showConfirm === 'function') {
      UIManager.showConfirm('驳回这份投稿？作者仍能看到它，但不会公开。', doIt);
    } else { doIt(); }
  },

  // ============================ 卡片社交（点赞 / 评论） ============================
  // 一套代码服务世界书与预设：type ∈ worldbook | preset（服务端同构）。
  // 打分口径（服务端算）：热门 = 点赞×1 + 评论人数×3（同一人多条评论只算一个）；活跃 = 最近 24 小时同一口径。
  wbSort: 'new', predSort: 'new',

  // 排序切换（最新 / 热门 / 活跃）
  setSort(kind: any, sort: any) {
    if (kind === 'preset') { if (this.predSort === sort) return; this.predSort = sort; this.predPage = 1; this.loadPresetList(); }
    else { if (this.wbSort === sort) return; this.wbSort = sort; this.wbPage = 1; this.loadWorldbookList(); }
    var seg = document.getElementById(kind === 'preset' ? 'predSortSeg' : 'wbSortSeg');
    if (seg) {
      Array.prototype.forEach.call(seg.querySelectorAll('button'), function (b: any) {
        b.classList.toggle('active', b.getAttribute('data-sort') === sort);
      });
    }
  },

  _heartSvg() { return '<svg class="ic-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20.5S3.5 15 3.5 8.9A4.4 4.4 0 0 1 12 6.6a4.4 4.4 0 0 1 8.5 2.3C20.5 15 12 20.5 12 20.5Z"/></svg>'; },

  // 点赞/取消：未登录先登录；乐观更新（点下去立刻变），失败回滚
  toggleLike(type: any, id: any, ev: any) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    if (!this.token || !this.user) { App.toast('登录后才能点赞'); this.openLogin(); return; }
    var self = this;
    var list = type === 'preset' ? this.predItems : this.wbItems;
    var it: any = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { it = list[i]; break; }
    var before = it ? { liked: !!it.liked, likes: it.likes || 0 } : null;
    var want = !(it && it.liked);
    if (it) { it.liked = want; it.likes = Math.max(0, (it.likes || 0) + (want ? 1 : -1)); this._refreshCardSocial(type, id); }
    if (self.currentWbDetail && type === 'worldbook' && self.currentWbDetail.id === id) {
      self.currentWbDetail.liked = want; self.currentWbDetail.likes = it ? it.likes : self.currentWbDetail.likes;
      self._renderDetailSocial('worldbook');
    }
    if (self.currentPredDetail && type === 'preset' && self.currentPredDetail.id === id) {
      self.currentPredDetail.liked = want; self.currentPredDetail.likes = it ? it.likes : self.currentPredDetail.likes;
      self._renderDetailSocial('preset');
    }
    return fetch(this.server + '/api/card/like', {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ type: type, id: id })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j.error || '点赞失败');
        if (it) { it.liked = !!res.j.liked; it.likes = res.j.likes; self._refreshCardSocial(type, id); }
        if (type === 'worldbook' && self.currentWbDetail && self.currentWbDetail.id === id) { self.currentWbDetail.liked = !!res.j.liked; self.currentWbDetail.likes = res.j.likes; self._renderDetailSocial('worldbook'); }
        if (type === 'preset' && self.currentPredDetail && self.currentPredDetail.id === id) { self.currentPredDetail.liked = !!res.j.liked; self.currentPredDetail.likes = res.j.likes; self._renderDetailSocial('preset'); }
      })
      .catch(function (e) {
        if (it && before) { it.liked = before.liked; it.likes = before.likes; self._refreshCardSocial(type, id); }
        App.toast(e && e.message ? e.message : '点赞失败');
      });
  },

  // 列表卡片上的 ♥/💬/⬇ 就地刷新（不重排整个列表，避免滚动位置丢失）
  _refreshCardSocial(type: any, id: any) {
    var list = type === 'preset' ? this.predItems : this.wbItems;
    var it = null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) { it = list[i]; break; }
    if (!it) return;
    var el = document.querySelector('[data-social="' + type + '-' + id + '"]');
    if (!el) return;
    var lk = el.querySelector('.lk');
    if (lk) lk.classList.toggle('on', !!it.liked);
    var n = el.querySelector('.lk-n');
    if (n) n.textContent = String(it.likes || 0);
    var c = el.querySelector('.cm-n');
    if (c) c.textContent = String(it.comments || 0);
  },

  // 详情弹层的社交统计行（点赞按钮 + 评论数 + 下载数）
  _renderDetailSocial(type: any) {
    var it = type === 'preset' ? this.currentPredDetail : this.currentWbDetail;
    var box = document.getElementById(type === 'preset' ? 'predDetailSocial' : 'wbDetailSocial');
    if (!box || !it) return;
    box.innerHTML =
      '<span class="lk' + (it.liked ? ' on' : '') + '" onclick="CommunityChat.toggleLike(\'' + type + '\',' + it.id + ',event)">' +
      this._heartSvg() + ' <b>' + (it.likes || 0) + '</b> 赞</span>' +
      '<span>💬 ' + (it.comments || 0) + ' 条评论</span>' +
      '<span>⬇ ' + (it.downloads || 0) + ' 次下载</span>';
  },

  // 评论区：首屏 + 加载更多
  _cmt: { type: '', id: 0, items: [], total: 0, mine: 0, hasMore: false, loading: false },
  _cardAuthorId() {
    var it = this._cmt.type === 'preset' ? this.currentPredDetail : this.currentWbDetail;
    return it ? it.author_id : 0;
  },
  openComments(type: any, id: any) {
    this._cmt = { type: type, id: id, items: [], total: 0, mine: 0, hasMore: false, loading: false };
    this.loadComments(true);
  },
  loadComments(reset: any) {
    var self = this;
    var st = this._cmt;
    if (st.loading || !st.id) return;
    st.loading = true;
    var url = this.server + '/api/card/comments?type=' + st.type + '&id=' + st.id + '&limit=20';
    if (!reset && st.items.length) url += '&before_id=' + st.items[st.items.length - 1].id;
    fetch(url, { headers: this.authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        st.mine = j.mine || 0;
        st.total = j.total || 0;
        st.items = reset ? (j.comments || []) : st.items.concat(j.comments || []);
        st.hasMore = (j.comments || []).length >= 20;
        st.loading = false;
        self.renderComments();
      })
      .catch(function () { st.loading = false; var l = document.getElementById('cmtList'); if (l) l.innerHTML = '<div class="cmt-empty">评论加载失败</div>'; });
  },
  renderComments() {
    var self = this;
    var st = this._cmt;
    var box = document.getElementById('cmtBox');
    if (!box) return;
    var cardAuthor = self._cardAuthorId();
    var isAdmin = false;
    try { isAdmin = !!(typeof AdminMode !== 'undefined' && AdminMode.isOn && AdminMode.isOn()); } catch (e) { isAdmin = false; }
    var itemsHtml = st.items.length ? st.items.map(function (c: any) {
      // 可删：评论作者本人 / 卡片作者 / 管理员（服务端同样校验，这里只是提前把按钮藏起来）
      var canDel = (c.user_id === st.mine) || (st.mine && cardAuthor === st.mine) || isAdmin;
      return '<div class="cmt"><div class="cmt-ava">' + self._esc(String(c.username || '?').slice(0, 1)) + '</div>' +
        '<div class="cmt-main"><div class="cmt-meta"><b>' + self._esc(c.username) + '</b><span>' + self._relTime(c.created_at) + '</span>' +
        (canDel ? '<span class="cmt-del" onclick="CommunityChat.deleteComment(' + c.id + ')">删除</span>' : '') + '</div>' +
        '<div class="cmt-text">' + self._esc(c.content) + '</div></div></div>';
    }).join('') : '<div class="cmt-empty">还没有评论，来说第一句吧。</div>';
    box.innerHTML = '<div class="cmt-head">评论 · ' + st.total + '</div>' +
      '<div class="cmt-list" id="cmtList">' + itemsHtml + '</div>' +
      (st.hasMore ? '<div class="cmt-more" onclick="CommunityChat.loadComments(false)">加载更多</div>' : '') +
      '<div class="cmt-input">' +
      '<textarea id="cmtInput" rows="1" maxlength="500" placeholder="说点什么…（500 字以内）"></textarea>' +
      '<button class="primary small" onclick="CommunityChat.postComment()">发送</button></div>';
  },
  _relTime(ts: any) {
    var d = Date.now() - (Number(ts) || 0);
    if (!d || d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    if (d < 7 * 86400000) return Math.floor(d / 86400000) + ' 天前';
    var dt = new Date(Number(ts));
    return (dt.getMonth() + 1) + ' 月 ' + dt.getDate() + ' 日';
  },
  postComment() {
    var self = this;
    var st = this._cmt;
    if (!this.token || !this.user) { App.toast('登录后才能评论'); this.openLogin(); return Promise.resolve(); }
    var el = document.getElementById('cmtInput') as HTMLTextAreaElement | null;
    var content = el ? String(el.value || '').trim() : '';
    if (!content) return Promise.resolve();
    if (content.length > 500) { App.toast('评论不能超过 500 字'); return Promise.resolve(); }
    return fetch(this.server + '/api/card/comment', {
      method: 'POST',
      headers: this.jsonHeaders(),
      body: JSON.stringify({ type: st.type, id: st.id, content: content })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '发送失败'); return; }
        if (el) el.value = '';
        st.items.unshift(res.j.comment);
        st.total += 1;
        self._bumpCommentCount(st.type, st.id, 1);
        self.renderComments();
        App.toast('评论已发布');
      })
      .catch(function (e) { App.toast('网络错误: ' + (e && e.message ? e.message : '')); });
  },
  deleteComment(cid: any) {
    var self = this;
    var st = this._cmt;
    if (typeof UIManager.showConfirm === 'function') {
      UIManager.showConfirm('删除这条评论？', function () { self._doDeleteComment(cid); });
    } else { self._doDeleteComment(cid); }
  },
  _doDeleteComment(cid: any) {
    var self = this;
    var st = this._cmt;
    fetch(this.server + '/api/card/comment?id=' + cid, { method: 'DELETE', headers: this.authHeaders() })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '删除失败'); return; }
        st.items = st.items.filter(function (c: any) { return c.id !== cid; });
        st.total = Math.max(0, st.total - 1);
        self._bumpCommentCount(st.type, st.id, -1);
        self.renderComments();
        App.toast('已删除');
      })
      .catch(function () { App.toast('删除失败'); });
  },
  // 列表卡片上的评论数就地更新（+1/-1）；详情弹层开着的话同步刷新统计行
  _bumpCommentCount(type: any, id: any, delta: any) {
    var list = type === 'preset' ? this.predItems : this.wbItems;
    var it = null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { list[i].comments = Math.max(0, (list[i].comments || 0) + delta); it = list[i]; break; }
    }
    var el = document.querySelector('[data-social="' + type + '-' + id + '"] .cm-n');
    if (el && it) el.textContent = String(it.comments || 0);
    var detail = type === 'preset' ? this.currentPredDetail : this.currentWbDetail;
    if (detail && detail.id === id) {
      detail.comments = Math.max(0, (detail.comments || 0) + delta);
      this._renderDetailSocial(type);
    }
  },

  // ---------- 二级 Tab 切换 ----------
  switchCommTab(which: any) {
    var tabs = document.querySelectorAll('.comm-tab');
    var views: Record<string, string> = { worldbook: 'commViewWorldbook', preset: 'commViewPreset' };
    tabs.forEach(function (t) {
      t.classList.toggle('active', t.getAttribute('data-commtab') === which);
    });
    Object.keys(views).forEach(function (k) {
      var v = document.getElementById(views[k]);
      if (v) v.classList.toggle('active', k === which);
    });
    if (which === 'worldbook') {
      if (this.token && this.user && !this.wbLoaded) this.loadWorldbookList();
    } else if (which === 'preset') {
      if (this.token && this.user && !this.predLoaded) this.loadPresetList();
    }
  },

  // ---------- 登录 / 注册 / 找回密码 / 改昵称 ----------
  openLogin() { UIManager!.showModal('modalCommunityLogin'); setTimeout(function () { var e = document.getElementById('communityLoginEmail'); if (e) e.focus(); }, 120); },
  openRegister() { UIManager!.showModal('modalCommunityRegister'); setTimeout(function () { var e = document.getElementById('communityRegisterUsername'); if (e) e.focus(); }, 120); },
  openForgot() { UIManager!.showModal('modalCommunityForgot'); setTimeout(function () { var e = document.getElementById('communityForgotEmail'); if (e) e.focus(); }, 120); },
  openRename() {
    UIManager!.showModal('modalCommunityRename');
    setTimeout(function () {
      var inp = document.getElementById('communityRenameNickname');
      if (inp) { inp.value = CommunityChat.user ? CommunityChat.user.username : ''; inp.focus(); }
    }, 120);
  },
  closeLogin() { UIManager!.closeModal('modalCommunityLogin'); },
  closeRegister() { UIManager!.closeModal('modalCommunityRegister'); },
  closeForgot() { UIManager!.closeModal('modalCommunityForgot'); },
  closeRename() { UIManager!.closeModal('modalCommunityRename'); },
  switchToRegister() { this.closeLogin(); this.openRegister(); },
  switchToLogin() { this.closeRegister(); this.closeForgot(); this.openLogin(); },
  switchToForgot() { this.closeLogin(); this.openForgot(); },

  // 发送验证码（60s 倒计时防重复点击）
  sendCode(type: any) {
    var self = this;
    var emailId = type === 'register' ? 'communityRegisterEmail' : 'communityForgotEmail';
    var btnId = type === 'register' ? 'registerSendCodeBtn' : 'forgotSendCodeBtn';
    var email = String((document.getElementById(emailId) || ({} as any)).value || '').trim();
    if (!email) { App.toast('请先填写邮箱'); return; }
    var btn = document.getElementById(btnId);
    if (btn) { btn.disabled = true; btn.textContent = '发送中...'; }
    fetch(this.server + '/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, type: type })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) {
          if (btn) { btn.disabled = false; btn.textContent = '发送验证码'; }
          App.toast(res.j.error || '发送失败');
          return;
        }
        App.toast('验证码已发送，请查收邮件');
        self._countdown(btnId, 60);
      })
      .catch(function (e) {
        if (btn) { btn.disabled = false; btn.textContent = '发送验证码'; }
        App.toast('网络错误: ' + e.message);
      });
  },
  _countdown(btnId: any, seconds: any) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    var left = seconds;
    btn.disabled = true;
    btn.textContent = left + 's 后重发';
    var timer = setInterval(function () {
      left--;
      if (left <= 0) { clearInterval(timer); btn!.disabled = false; btn!.textContent = '发送验证码'; }
      else btn!.textContent = left + 's 后重发';
    }, 1000);
  },

  doLogin() {
    var e = String((document.getElementById('communityLoginEmail') || ({} as any)).value || '').trim();
    var p = document.getElementById('communityLoginPassword')!.value;
    if (!e || !p) { App.toast('请填写邮箱和密码'); return; }
    this._auth('/api/auth/login', { email: e, password: p });
  },
  doRegister() {
    var email = String((document.getElementById('communityRegisterEmail') || ({} as any)).value || '').trim();
    var code = String((document.getElementById('communityRegisterCode') || ({} as any)).value || '').trim();
    var u = document.getElementById('communityRegisterUsername')!.value.trim();
    var p = document.getElementById('communityRegisterPassword')!.value;
    var p2 = document.getElementById('communityRegisterPassword2')!.value;
    if (!u || !p) { App.toast('请填写昵称和密码'); return; }
    if (p !== p2) { App.toast('两次输入的密码不一致'); return; }
    if (!email) { App.toast('请填写邮箱'); return; }
    if (!/^\d{6}$/.test(code)) { App.toast('请填写 6 位数字验证码'); return; }
    this._auth('/api/auth/register', { username: u, password: p, email: email, code: code });
  },
  doRename() {
    var self = this;
    var nn = String((document.getElementById('communityRenameNickname') || ({} as any)).value || '').trim();
    if (!nn) { App.toast('请填写新昵称'); return; }
    fetch(this.server + '/api/auth/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
      body: JSON.stringify({ nickname: nn })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '修改失败'); return; }
        self.user.username = res.j.user.username;
        SM().set('communityUser', self.user);
        self.closeRename();
        self.renderStatus();
        App.toast('昵称已更新：' + res.j.user.username);
      })
      .catch(function (e) { App.toast('网络错误: ' + e.message); });
  },
  doResetPassword() {
    var self = this;
    var email = String((document.getElementById('communityForgotEmail') || ({} as any)).value || '').trim();
    var code = String((document.getElementById('communityForgotCode') || ({} as any)).value || '').trim();
    var np = String((document.getElementById('communityForgotNewPassword') || ({} as any)).value || '');
    if (!email) { App.toast('请填写注册邮箱'); return; }
    if (!/^\d{6}$/.test(code)) { App.toast('请填写 6 位数字验证码'); return; }
    if (!np) { App.toast('请填写新密码'); return; }
    fetch(this.server + '/api/auth/reset-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, code: code, newPassword: np })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '重置失败'); return; }
        App.toast('密码已重置，请用新密码登录');
        self.switchToLogin();
      })
      .catch(function (e) { App.toast('网络错误: ' + e.message); });
  },
  _auth(path: any, bodyObj: any) {
    var self = this;
    fetch(this.server + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast('失败: ' + (res.j.error || '未知错误')); return; }
        self.saveAuth(res.j.token, res.j.user);
        self.closeLogin(); self.closeRegister(); self.closeForgot();
        self.renderStatus();
        self.wbLoaded = false; self.predLoaded = false; // 换账号后列表按新身份重拉
        self.loadWorldbookList();
        App.toast('欢迎，' + res.j.user.username);
      })
      .catch(function (e) { App.toast('网络错误: ' + e.message); });
  },

  logout() {
    try { if (this.token) fetch(this.server + '/api/auth/logout', { method: 'POST', headers: { 'Authorization': 'Bearer ' + this.token } }).catch(function () {}); } catch (e) {}
    this.token = ''; this.user = null;
    this.wbLoaded = false; this.predLoaded = false;
    this.wbItems = []; this.predItems = [];
    SM().remove('communityToken');
    SM().remove('communityUser');
    this.renderStatus();
    this.renderWorldbookList();
    this.closeUserPanel();
    this.openLogin();
    App.toast('已退出登录');
  },

  // ============================ 世界书区 ============================
  wbLoaded: false, wbItems: [], wbTotal: 0, wbPage: 1, wbPageSize: 20, wbCatsLoaded: [],
  wbQuery: '',
  loadWorldbookList() {
    var self = this;
    if (!this.token) return;
    var cat = this.currentWbCat === '全部' ? '' : this.currentWbCat;
    var q = encodeURIComponent(String(this.wbQuery || '').trim());
    fetch(this.server + '/api/worldbook/list?page=' + this.wbPage + '&pageSize=' + this.wbPageSize + '&sort=' + encodeURIComponent(this.wbSort || 'new') + (cat ? '&category=' + encodeURIComponent(cat) : '') + (q ? '&q=' + q : ''), { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self.wbLoaded = true;
        self.wbItems = j.items || [];
        self.wbTotal = j.total || 0;
        self.wbPage = Math.max(1, j.page || 1);
        self.renderWbCats();
        self.renderWorldbookList();
      })
      .catch(function () { App.toast('世界书加载失败'); });
  },
  renderWbCats() {
    var box = document.getElementById('wbCats');
    if (!box) return;
    var cats: any[] = [];
    var self = this;
    this.wbItems.forEach(function (it: any) { if (it.category && cats.indexOf(it.category) < 0) cats.push(it.category); });
    var html = '<span class="wb-cat' + (this.currentWbCat === '全部' ? ' active' : '') + '" onclick="CommunityChat.setWbCat(\'全部\')">全部</span>';
    cats.forEach(function (c) {
      html += '<span class="wb-cat' + (self.currentWbCat === c ? ' active' : '') + '" onclick="CommunityChat.setWbCat(\'' + self._escAttr(c) + '\')">' + self._esc(c) + '</span>';
    });
    box.innerHTML = html;
  },
  setWbCat(cat: any) {
    this.currentWbCat = cat;
    this.wbPage = 1;
    this.renderWbCats();
    this.renderWorldbookList();
    this.loadWorldbookList();
  },
  gotoWbPage(p: any) {
    var max = Math.max(1, Math.ceil(this.wbTotal / this.wbPageSize));
    p = parseInt(p, 10);
    if (!(p > 0)) return;
    if (p > max) p = max;
    if (p === this.wbPage) return;
    this.wbPage = p;
    this.loadWorldbookList();
  },
  renderWorldbookList() {
    var box = document.getElementById('wbList');
    if (!box) return;
    var self = this;
    var items = this.wbItems;
    if (!items.length) {
      var searching = String(this.wbQuery || '').trim() !== '';
      box.innerHTML = '<div class="chat-empty" style="grid-column:1/-1;">' + (searching
        ? '没有找到匹配的世界书（换个词试试）'
        : '暂无世界书' + (this.wbTotal ? '（当前页无结果）' : '，点右上角上传第一个吧')) + '</div>';
      this.renderWbPager();
      return;
    }
    var html = '';
    items.forEach(function (it: any, idx: any) {
      var palette = 'wb-cover-palette' + (idx % 7);
      var dispTitle = it.title || '未命名';
      var first = Array.from(dispTitle)[0] || '?';
      var coverHtml = it.cover
        ? '<img src="' + self._escAttr(it.cover) + '" alt="">'
        : self._esc(first);
      html += '<div class="shelf-card" onclick="CommunityChat.openWbDetail(' + it.id + ')">' +
        '<div class="shelf-cover ' + (it.cover ? '' : palette) + '">' + coverHtml + '</div>' +
        '<div class="shelf-body">' +
          '<div class="shelf-name">' + self._esc(dispTitle) + '</div>' +
          '<div class="shelf-row"><span>作者</span><b>' + self._esc(it.author_name || '—') + '</b></div>' +
          '<div class="shelf-social" data-social="worldbook-' + it.id + '">' +
            '<span class="lk' + (it.liked ? ' on' : '') + '" onclick="CommunityChat.toggleLike(\'worldbook\',' + it.id + ',event)" title="点赞">' + self._heartSvg() + '<span class="lk-n">' + (it.likes || 0) + '</span></span>' +
            '<span title="评论">💬 <span class="cm-n">' + (it.comments || 0) + '</span></span>' +
            '<span title="下载">⬇ ' + (it.downloads || 0) + '</span>' +
          '</div>' +
        '</div></div>';
    });
    box.innerHTML = html;
    this.renderWbPager();
  },

  // 分页条（顶部/底部各一套：首页 | 上一页 | 页码(可输入) | 下一页 | 末页）
  renderWbPager() {
    var max = Math.max(1, Math.ceil(this.wbTotal / this.wbPageSize));
    var page = Math.min(this.wbPage, max);
    var html =
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoWbPage(1)" ' + (page <= 1 ? 'disabled' : '') + ' title="首页">«</button>' +
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoWbPage(' + (page - 1) + ')" ' + (page <= 1 ? 'disabled' : '') + ' title="上一页">‹</button>' +
      '<span class="wb-pg-info">第</span>' +
      '<input class="wb-pg-num" type="number" min="1" max="' + max + '" value="' + page + '" onchange="CommunityChat.gotoWbPage(this.value)" onkeydown="if(event.key===\'Enter\'){CommunityChat.gotoWbPage(this.value)}">' +
      '<span class="wb-pg-info">/ ' + max + ' 页</span>' +
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoWbPage(' + (page + 1) + ')" ' + (page >= max ? 'disabled' : '') + ' title="下一页">›</button>' +
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoWbPage(' + max + ')" ' + (page >= max ? 'disabled' : '') + ' title="末页">»</button>';
    // 只保留底部分页（顶部分页已按需求移除）
    var bottom = document.getElementById('wbPagerBottom');
    if (bottom) bottom.innerHTML = html;
  },

  // ---------- 世界书上传（从软件内世界书选择 + 封面图） ----------
  openUploadModal() {
    var self = this;
    var sel = document.getElementById('wbUploadSelect');
    var empty = document.getElementById('wbUploadEmpty');
    document.getElementById('wbUploadDesc')!.value = '';
    this._wbCover = '';
    var preview = document.getElementById('wbCoverPreview');
    var ph = document.getElementById('wbCoverPlaceholder');
    if (preview) { preview.style.display = 'none'; preview.src = ''; }
    if (ph) ph.style.display = '';
    var books = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getAll) ? WorldBookManager.getAll() : [];
    if (!sel) return;
    sel.innerHTML = '';
    this._wbBooks = books;
    if (!books.length) {
      if (empty) empty.style.display = '';
      sel.innerHTML = '<option value="">（无）</option>';
      sel.disabled = true;
    } else {
      if (empty) empty.style.display = 'none';
      sel.disabled = false;
      var html = '';
      books.forEach(function (b, i: any) {
        var name = b.title || b.name || ('世界书 ' + (i + 1));
        html += '<option value="' + i + '">' + self._esc(name) + '</option>';
      });
      sel.innerHTML = html;
    }
    // 书本已有封面 → 直接预填（无需再单独上传图片；仍可点封面框重裁）
    sel.onchange = function () { self._syncUploadCover(); };
    this._syncUploadCover();
    UIManager!.showModal('modalCommunityWbUpload');
  },
  // 把当前选中书本的本地封面同步到上传预览（书本封面即上传封面）
  _syncUploadCover() {
    var sel = document.getElementById('wbUploadSelect');
    var idx = sel ? parseInt(sel.value, 10) : -1;
    var book = (this._wbBooks && idx >= 0) ? this._wbBooks[idx] : null;
    var cover = book && book.cover ? book.cover : '';
    this._wbCover = cover;
    var preview = document.getElementById('wbCoverPreview');
    var ph = document.getElementById('wbCoverPlaceholder');
    if (cover) {
      if (preview) { preview.src = cover; preview.style.display = ''; }
      if (ph) ph.style.display = 'none';
    } else {
      if (preview) { preview.style.display = 'none'; preview.src = ''; }
      if (ph) ph.style.display = '';
    }
  },
  // 封面图选择：打开裁剪弹窗，拖动矩形框框选区域
  handleWbCoverPicked(event: any) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { App.toast('请选择图片文件'); return; }
    var self = this;
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || '');
      // 用独立 Image 对象探测真实尺寸（不依赖 DOM 显示状态）
      var probe = new Image();
      probe.onload = function () {
        self._cropImg = probe;
        self._cropSrc = dataUrl;
        self._cropFor = 'wb'; // 裁剪结果归属：世界书
        // 先显示弹窗，再在下一帧初始化（否则弹窗 display:none 时量不到尺寸）
        UIManager!.showModal('modalCommunityWbCrop');
        setTimeout(function () { self._initCrop(); }, 30);
      };
      probe.onerror = function () { App.toast('图片读取失败'); };
      probe.src = dataUrl;
    };
    reader.onerror = function () { App.toast('文件读取失败'); };
    reader.readAsDataURL(file);
  },
  // 预设封面图选择：与世界书封面共用裁剪弹窗，裁剪结果归属「预设」
  handlePredCoverPicked(event: any) {
    var file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\//.test(file.type)) { App.toast('请选择图片文件'); return; }
    var self = this;
    var reader = new FileReader();
    reader.onload = function () {
      var dataUrl = String(reader.result || '');
      var probe = new Image();
      probe.onload = function () {
        self._cropImg = probe;
        self._cropSrc = dataUrl;
        self._cropFor = 'pred'; // 裁剪结果归属：预设
        UIManager!.showModal('modalCommunityWbCrop');
        setTimeout(function () { self._initCrop(); }, 30);
      };
      probe.onerror = function () { App.toast('图片读取失败'); };
      probe.src = dataUrl;
    };
    reader.onerror = function () { App.toast('文件读取失败'); };
    reader.readAsDataURL(file);
  },
  // 本地书本封面裁剪入口（书架「编辑封面」/ 新建导入后触发）
  // 与上传封面共用裁剪弹窗，_cropFor = 'book:<id>'，确认后直接写回书本 cover 字段
  startBookCoverCrop(dataUrl: any, bookId: any) {
    var self = this;
    var probe = new Image();
    probe.onload = function () {
      self._cropImg = probe;
      self._cropSrc = dataUrl;
      self._cropFor = 'book:' + bookId;
      // 先显示弹窗，再在下一帧初始化（否则弹窗 display:none 时量不到尺寸）
      UIManager!.showModal('modalCommunityWbCrop');
      setTimeout(function () { self._initCrop(); }, 30);
    };
    probe.onerror = function () { App.toast('图片读取失败'); };
    probe.src = dataUrl;
  },
  // 初始化裁剪：几何以舞台实际尺寸为准（避免固定 280 与实际渲染不一致），框选比例 1:1.5
  _initCrop() {
    var self = this;
    var stage = document.getElementById('cropStage');
    var box = document.getElementById('cropBox');
    var preview = document.getElementById('cropPreview');
    if (!stage || !box || !preview || !this._cropImg) return;
    // 读取舞台实际渲染尺寸（CSS 已设 width:min(280px,100%) aspect-ratio:2/3）
    var SW = stage.clientWidth, SH = stage.clientHeight;
    if (!SW || !SH) { App.toast('无法确定舞台尺寸'); return; }
    var w0 = this._cropImg.naturalWidth, h0 = this._cropImg.naturalHeight;
    if (!w0 || !h0) { App.toast('无法读取图片尺寸'); return; }
    // cover 几何（与 CSS background-size:cover 一致）
    var k = Math.max(SW / w0, SH / h0);
    var dw = w0 * k, dh = h0 * k;
    self._cropScale = k;
    self._cropOffX = (SW - dw) / 2;
    self._cropOffY = (SH - dh) / 2;
    self._cropStageW = SW; self._cropStageH = SH;
    preview.style.backgroundImage = "url('" + this._cropSrc + "')";
    // 初始框：宽占舞台 60%，高=宽*1.5（不超舞台高）
    var w = Math.round(SW * 0.6);
    if (w * 1.5 > SH) w = Math.round(SH / 1.5);
    self._cropW = w;
    self._cropH = Math.round(w * 1.5);
    self._cropX = Math.round((SW - w) / 2);
    self._cropY = Math.round((SH - self._cropH) / 2);
    self._applyCropBox();
    // 拖动绑定（一次性）
    if (!stage._cropBound) {
      stage._cropBound = true;
      var mode: any = null, startX: any = 0, startY: any = 0, oX: any = 0, oY: any = 0, oW: any = 0, oH: any = 0;
      stage.addEventListener('pointerdown', function (e) {
        var rect = stage!.getBoundingClientRect();
        var px = e.clientX - rect.left, py = e.clientY - rect.top;
        var bx = self._cropX || 0, by = self._cropY || 0, bw = self._cropW || 0, bh = self._cropH || 0;
        var near = 20, bx2 = bx + bw, by2 = by + bh;
        var atL = px <= bx + near, atR = px >= bx2 - near;
        var atT = py <= by + near, atB = py >= by2 - near;
        if (atR && atB) mode = 'resize-se';
        else if (atL && atT) mode = 'resize-nw';
        else if (atR && atT) mode = 'resize-ne';
        else if (atL && atB) mode = 'resize-sw';
        else if (px >= bx && px <= bx2 && py >= by && py <= by2) mode = 'move';
        else return;
        startX = px; startY = py;
        oX = bx; oY = by; oW = bw; oH = bh;
        try { stage!.setPointerCapture(e.pointerId); } catch (err) {}
        e.preventDefault();
      });
      stage.addEventListener('pointermove', function (e) {
        if (!mode) return;
        var rect = stage!.getBoundingClientRect();
        var px = e.clientX - rect.left, py = e.clientY - rect.top;
        var dx = px - startX, dy = py - startY;
        var SW = self._cropStageW || 280, SH = self._cropStageH || 420;
        if (mode === 'move') {
          var bw = self._cropW || 0, bh = self._cropH || 0;
          self._cropX = Math.max(0, Math.min(SW - bw, oX + dx));
          self._cropY = Math.max(0, Math.min(SH - bh, oY + dy));
        } else {
          // 保持 1:1.5（高=宽*1.5），从锚点角缩放；grow 为宽度增量
var grow: any;
          if (mode === 'resize-nw') grow = Math.max(-dx, -dy / 1.5);
          else if (mode === 'resize-ne') grow = Math.max(dx, -dy / 1.5);
          else if (mode === 'resize-sw') grow = Math.max(-dx, dy / 1.5);
          else grow = Math.max(dx, dy / 1.5); // resize-se
          var nw = Math.max(70, oW + grow);
          // 各角最大宽度：保证锚点角不动时四条边都留在舞台内
          var maxW = SW;
          if (mode === 'resize-nw') maxW = Math.min(oX + oW, (oY + oH) / 1.5);
          else if (mode === 'resize-ne') maxW = Math.min(SW - oX, (oY + oH) / 1.5);
          else if (mode === 'resize-sw') maxW = Math.min(oX + oW, (SH - oY) / 1.5);
          else maxW = Math.min(SW - oX, (SH - oY) / 1.5); // resize-se
          if (nw > maxW) nw = Math.floor(maxW);
          if (nw < 70) nw = 70;
          var nh = Math.round(nw * 1.5);
          var nx = oX, ny = oY;
          if (mode === 'resize-nw') { nx = (oX + oW) - nw; ny = (oY + oH) - nh; }
          else if (mode === 'resize-ne') { ny = (oY + oH) - nh; }
          else if (mode === 'resize-sw') { nx = (oX + oW) - nw; }
          self._cropX = nx; self._cropY = ny;
          self._cropW = nw; self._cropH = nh;
        }
        self._applyCropBox();
        e.preventDefault();
      });
      stage.addEventListener('pointerup', function () { mode = null; });
      stage.addEventListener('pointercancel', function () { mode = null; });
    }
  },
  _applyCropBox() {
    var box = document.getElementById('cropBox');
    if (!box) return;
    var x = this._cropX || 0, y = this._cropY || 0, w = this._cropW || 0, h = this._cropH || 0;
    box.style.left = x + 'px';
    box.style.top = y + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
  },
  closeCrop() { UIManager!.closeModal('modalCommunityWbCrop'); },
  // 确认裁剪：按矩形框区域从原图截取 → 生成 400x600（1:1.5）封面 base64
  confirmCrop() {
    var self = this;
    var img = this._cropImg; // 独立探测对象，naturalWidth 可靠
    if (!this._cropSrc || !img || !img.naturalWidth || !img.naturalHeight) { App.toast('请先选择图片'); return; }
    var x = this._cropX || 0, y = this._cropY || 0;
    var w = this._cropW || 0, h = this._cropH || 0;
    if (w < 10 || h < 10) { App.toast('选取区域过小'); return; }
    // 舞台 → 原图：减去居中偏移后除以缩放比
    var k = this._cropScale || 1;
    var offX = this._cropOffX || 0, offY = this._cropOffY || 0;
    var sx = (x - offX) / k;
    var sy = (y - offY) / k;
    var sw = w / k, sh = h / k;
    // 边界保护
    sx = Math.max(0, Math.min(img.naturalWidth, sx));
    sy = Math.max(0, Math.min(img.naturalHeight, sy));
    sw = Math.min(sw, img.naturalWidth - sx);
    sh = Math.min(sh, img.naturalHeight - sy);
    if (sw < 10 || sh < 10) { App.toast('选取区域过小'); return; }
    try {
      var canvas = document.createElement('canvas');
      canvas.width = 400; canvas.height = 600;
      var ctx = canvas.getContext('2d');
      ctx!.drawImage(img, sx, sy, sw, sh, 0, 0, 400, 600);
      var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      if (dataUrl.length > 320 * 1024) { App.toast('裁剪结果过大，请缩小选框'); return; }
      // 按裁剪归属写入对应封面临时存储与预览
      if (self._cropFor === 'pred') {
        self._predCover = dataUrl;
        var pPreview = document.getElementById('predCoverPreview');
        var pPh = document.getElementById('predCoverPlaceholder');
        if (pPreview) { pPreview.src = dataUrl; pPreview.style.display = ''; }
        if (pPh) pPh.style.display = 'none';
      } else if (String(self._cropFor || '').indexOf('book:') === 0) {
        // 本地书本封面：直接写回世界书并刷新书架
        var _bookId = String(self._cropFor).slice(5);
        if (typeof WorldBookManager !== 'undefined' && WorldBookManager.setCover) {
          WorldBookManager.setCover(_bookId, dataUrl);
          if (UIManager.renderWbShelf) UIManager.renderWbShelf();
        }
      } else {
        self._wbCover = dataUrl;
        var preview = document.getElementById('wbCoverPreview');
        var ph = document.getElementById('wbCoverPlaceholder');
        if (preview) { preview.src = dataUrl; preview.style.display = ''; }
        if (ph) ph.style.display = 'none';
      }
      self.closeCrop();
      App.toast('封面已添加');
    } catch (e) { App.toast('裁剪失败'); }
  },
  // 上传时生成"检索用"元数据（一次轻量 LLM 调用，用上传者自己的 key）
  // 失败/超时一律返回 null：上传照常进行，服务器还有机械抽取兜底（角色名/条目名/字数）
  _genUploadMeta(wb: any, title: any, desc: any): Promise<any> {
    var cfg = (typeof PresetManager !== 'undefined' && PresetManager.getActiveAPIConfig) ? PresetManager.getActiveAPIConfig() : null;
    if (!cfg || !cfg.apiKey) return Promise.resolve(null);
    var prompt = buildWbMetaPrompt(title, desc, wb);
    return new Promise(function (resolve) {
      var settled = false;
      var done = function (v: any) { if (!settled) { settled = true; resolve(v); } };
      var timer = setTimeout(function () { done(null); }, 20000); // 生成标签不能拖住上传
      try {
        APIHandler.fetchCompletions(
          [{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }] as any,
          function () { /* 忽略流式 */ },
          function (full: string | null) { clearTimeout(timer); done(parseWbMeta(String(full || ''))); },
          function () { clearTimeout(timer); done(null); },
          { temperature: 0.3, callLabel: 'wbUploadMeta', timeout: 20000 } as any
        );
      } catch (e) { clearTimeout(timer); done(null); }
    });
  },

  doWbUpload() {
    var self = this;
    var sel = document.getElementById('wbUploadSelect');
    var idx = sel ? parseInt(sel.value, 10) : -1;
    var desc = String((document.getElementById('wbUploadDesc') || ({} as any)).value || '').trim();
    var cat = String((document.getElementById('wbUploadCategory') || ({} as any)).value || '综合');
    if (!this._wbBooks || idx < 0 || !this._wbBooks[idx]) { App.toast('请选择要上传的世界书'); return; }
    var wb = this._wbBooks[idx];
    var title = String(wb.title || wb.name || '').trim();
    if (!title) { App.toast('世界书没有标题'); return; }
    // 只序列化可分享的世界书内容（去掉本地小说正文 chapters/currentChapterId）；
    // 条目按"用户看得见的"来（普通用户看不到真实模式专用条目）——不会把看不见的内容悄悄分享出去
    var share = {
      name: title,
      title: title,
      entries: visibleEntriesFor(wb.entries || []),
      description: wb.description || ''
    };
    var content = JSON.stringify(share);
    if (content.length > 2 * 1024 * 1024) { App.toast('世界书内容超过 2MB，无法上传'); return; }
    var btn = document.getElementById('wbUploadBtn') as HTMLButtonElement | null;
    var restoreBtn = function () { if (btn) { btn.disabled = false; btn.textContent = '上传'; } };
    var doPost = function () {
      var payload: any = { title: title, description: desc, category: cat, content: content };
      if (self._wbCover) payload.cover = self._wbCover;
      else if ((wb as any).cover) payload.cover = (wb as any).cover; // 书本已有封面 → 免单独上传
      fetch(self.server + '/api/worldbook/upload', {
        method: 'POST',
        headers: self.jsonHeaders(),
        body: JSON.stringify(payload)
      }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          restoreBtn();
          if (!res.ok) { App.toast(res.j.error || '上传失败'); return; }
          UIManager!.closeModal('modalCommunityWbUpload');
          // 审核门：普通账号上传进待审，管理员账号（自己就是审核者）直接公开
          if (String(res.j.status || 'approved') === 'pending') {
            App.toast('已提交，管理员审核通过后公开（个人中心 → 我的世界书 里看状态）');
          } else {
            App.toast('已分享到世界书区，正在后台生成检索标签…');
          }
          self.wbLoaded = false;
          self.loadWorldbookList();
          self._pushWbMeta(res.j.id, wb, title, desc);
        })
        .catch(function (e) { restoreBtn(); App.toast('网络错误: ' + e.message); });
    };
    if (btn) { btn.disabled = true; btn.textContent = '上传中…'; }
    doPost();
  },

  // 后台上传 AI 检索元数据（不阻塞上传）：生成成功才回填，失败静默——卡片已有机械抽取的
  // 标签/角色名兜底，检索不会瞎。用户此时已看到「上传成功」，这里只是把标签补齐。
  _pushWbMeta(id: any, wb: any, title: any, desc: any) {
    var self = this;
    if (!id) return;
    try {
      this._genUploadMeta(wb, title, desc).then(function (meta: any) {
        if (!meta) return; // 失败/超时：保持机械抽取的元数据
        var payload = {
          id: id,
          tags: (meta.tags || []).join(','),
          meta: {
            summary: meta.summary, genre: meta.genre, audience: meta.audience,
            relation: meta.relation, franchise: meta.franchise, nsfw: meta.nsfw,
            summaryBy: 'ai',
          }
        };
        fetch(self.server + '/api/worldbook/meta', {
          method: 'POST',
          headers: self.jsonHeaders(),
          body: JSON.stringify(payload)
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j || !j.ok) return;
            App.toast('检索标签已生成'); // 卡片本身不展示标签（列表上只有 ♥/💬/⬇），无需刷新列表
          })
          .catch(function () { /* 静默：标签是增强信息 */ });
      });
    } catch (e) { /* 静默 */ }
  },

  // ---------- 世界书详情/导入/删除 ----------
  // 纯取详情（不弹社区弹层）：助手详情弹层用
  detailWb(id: any): Promise<any> {
    return fetch(this.server + '/api/worldbook/detail?id=' + encodeURIComponent(String(id)), { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); });
  },

  openWbDetail(id: any) {
    var self = this;
    fetch(this.server + '/api/worldbook/detail?id=' + id, { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self.currentWbDetail = j.item;
        var it = j.item;
        var body = document.getElementById('wbDetailBody');
        var coverHtml = it.cover
          ? '<img class="detail-cover" src="' + self._escAttr(it.cover) + '" alt="">'
          : '';
        body!.innerHTML = coverHtml +
          '<div style="font-size:16px;font-weight:700;margin-bottom:6px;">' + self._esc(it.title) + self._subBadge(it.status) + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);">作者 ' + self._esc(it.author_name) + ' · 分类 ' + self._esc(it.category) + '</div>' +
          '<div class="detail-social" id="wbDetailSocial"></div>' +
          '<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;">' + self._esc(it.description || '暂无简介') + '</div>' +
          (it.status === 'rejected' ? '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">该稿未通过审核，内容已从服务器移除（记录保留，可删除这条投稿）。</div>' : '') +
          '<div id="wbDetailContent"></div>' +
          '<div id="cmtBox"></div>';
        // 只有自己上传的才显示删除按钮（在弹窗底部一行）
        var delBtn = document.getElementById('wbDeleteBtn');
        var isMine = self.user && it.author_id === self.user.id;
        if (delBtn) delBtn.style.display = isMine ? '' : 'none';
        UIManager!.showModal('modalCommunityWbDetail');
        self._renderDetailSocial('worldbook');
        self.openComments('worldbook', it.id);
        self._loadWbPreview(it.id); // 不导入也能看内容（preview 不计下载数）
      })
      .catch(function () { App.toast('详情加载失败'); });
  },
  // 详情弹层里的内容预览：/api/worldbook/preview 不计下载数，条目点击展开/收起
  _loadWbPreview(id: any) {
    var self = this;
    this._wbPreviewFor = id;
    var box0 = document.getElementById('wbDetailContent');
    if (box0) box0.innerHTML = '<div class="wbd-list-head">世界书内容</div><div class="wbd-hint">正在读取…</div>';
    fetch(this.server + '/api/worldbook/preview?id=' + id, { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        if (self._wbPreviewFor !== id) return; // 已经切到别的卡了，丢弃旧响应
        var box = document.getElementById('wbDetailContent');
        if (box) box.innerHTML = self._renderWbEntries(j.entries || []);
      })
      .catch(function () {
        if (self._wbPreviewFor !== id) return;
        var box = document.getElementById('wbDetailContent');
        if (box) box.innerHTML = '<div class="wbd-list-head">世界书内容</div><div class="wbd-hint">内容读取失败，可先「导入」到本机再查看。</div>';
      });
  },
  _renderWbEntries(entries: any[]) {
    var self = this;
    // 普通用户看不到真实模式专用条目（与软件内世界书页同口径）：预览/导入都按可见集合走
    entries = visibleEntriesFor(Array.isArray(entries) ? entries : []);
    var head = '<div class="wbd-list-head">世界书内容 · 共 ' + entries.length + ' 条<span class="wbd-hint" style="margin-left:auto;">点条目展开/收起</span></div>';
    if (!entries.length) return head + '<div class="wbd-hint">这份世界书没有条目。</div>';
    var html = head;
    entries.slice(0, 500).forEach(function (e: any, i: number) {
      var content = String((e && e.content) || '');
      var type = String((e && e.type) || '其他');
      var name = String((e && e.name) || ('条目 ' + (i + 1)));
      html += '<div class="wbd-entry" onclick="CommunityChat.toggleWbEntry(this)">' +
        '<div class="wbd-entry-head"><span class="wbd-type">' + self._esc(type) + '</span>' +
        '<span class="wbd-entry-name">' + self._esc(name) + '</span>' +
        '<span class="wbd-entry-len">' + content.length + ' 字</span></div>' +
        '<div class="wbd-entry-body">' + self._esc(content) + '</div>' +
        '</div>';
    });
    return html;
  },
  // 条目点击展开/收起（长条目默认只露 4 行，避免详情弹层被一本书撑爆）
  toggleWbEntry(el: any) { if (el && el.classList) el.classList.toggle('open'); },
  // 导入到软件内世界书库（不再保存本地文件）
  downloadWb() {
    if (!this.currentWbDetail) return;
    var self = this;
    var id = this.currentWbDetail.id;
    fetch(this.server + '/api/worldbook/download?id=' + id, { headers: this.authHeaders(true) })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (text) {
        try {
          var data = JSON.parse(text);
          var name = String(data.title || data.name || self.currentWbDetail.title || '导入世界书').trim();
          // 构造成软件世界书对象（兼容 WorldBookManager 结构）
          var wb = {
            id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            name: name, title: name,
            entries: visibleEntriesFor(Array.isArray(data.entries) ? data.entries : []),
            description: String(data.description || '').slice(0, 500),
            cover: (self.currentWbDetail && self.currentWbDetail.cover) || '',
            createdAt: Date.now(),
            importedAt: Date.now()
          };
          if (typeof WorldBookManager !== 'undefined' && WorldBookManager.getAll && WorldBookManager.saveAll) {
            var all = WorldBookManager.getAll();
            all.push(wb);
            WorldBookManager.saveAll(all);
            if (WorldBookManager.setActiveId) WorldBookManager.setActiveId(wb.id);
            UIManager!.closeModal('modalCommunityWbDetail');
            App.toast('已导入到你的世界书：' + name);
            self.loadWorldbookList(); // 刷新（下载计数已在服务端+1）
          } else {
            App.toast('导入失败：世界书模块不可用');
          }
        } catch (e) { App.toast('导入失败：文件格式不正确'); }
      })
      .catch(function () { App.toast('导入失败'); });
  },
  // 删除自己上传的世界书（带确认）
  deleteWb() {
    if (!this.currentWbDetail) return;
    var self = this;
    var id = this.currentWbDetail.id;
    if (typeof UIManager.showConfirm === 'function') {
      UIManager.showConfirm('确定删除这份世界书吗？删除后其他人将无法下载。', function () { self._doDeleteWb(id); });
    } else {
      if (window.confirm('确定删除这份世界书吗？')) self._doDeleteWb(id);
    }
  },
  _doDeleteWb(id: any) {
    var self = this;
    fetch(this.server + '/api/worldbook/delete?id=' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + this.token }
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '删除失败'); return; }
        UIManager!.closeModal('modalCommunityWbDetail');
        App.toast('已删除');
        self.currentWbDetail = null;
        self.loadWorldbookList();
      })
      .catch(function (e) { App.toast('网络错误: ' + e.message); });
  },

  _esc(s: any) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); },
  _escAttr(s: any) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); },

  // ---------- 预设区：列表 / 分页 ----------
  loadPresetList() {
    var self = this;
    if (!this.token) return;
    var q = encodeURIComponent(String(this.predQuery || '').trim());
    fetch(this.server + '/api/preset/list?page=' + this.predPage + '&pageSize=' + this.predPageSize + '&sort=' + encodeURIComponent(this.predSort || 'new') + (q ? '&q=' + q : ''), { headers: this.authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self.predLoaded = true;
        self.predItems = j.items || [];
        self.predTotal = j.total || 0;
        self.predPage = Math.max(1, j.page || 1);
        self.renderPresetList();
      })
      .catch(function () { App.toast('预设加载失败'); });
  },
  gotoPredPage(p: any) {
    p = parseInt(p, 10);
    if (!(p > 0)) return;
    var max = Math.max(1, Math.ceil(this.predTotal / this.predPageSize));
    if (p > max) p = max;
    if (p === this.predPage) return;
    this.predPage = p;
    this.loadPresetList();
  },
  renderPresetList() {
    var box = document.getElementById('predList');
    if (!box) return;
    var self = this;
    var items = this.predItems;
    if (!items.length) {
      box.innerHTML = '<div class="chat-empty" style="grid-column:1/-1;">暂无预设' + (this.predTotal ? '（当前页无结果）' : '，点右上角上传第一个吧') + '</div>';
      this.renderPredPager();
      return;
    }
    var html = '';
    items.forEach(function (it: any, idx: any) {
      var palette = 'wb-cover-palette' + (idx % 7);
      var dispTitle = it.title || '未命名';
      var first = Array.from(dispTitle)[0] || '?';
      var coverHtml = it.cover
        ? '<img src="' + self._escAttr(it.cover) + '" alt="" style="width:100%;height:100%;object-fit:cover;">'
        : self._esc(first);
      html += '<div class="wb-card" onclick="CommunityChat.openPredDetail(' + it.id + ')">' +
        '<div class="wb-cover ' + (it.cover ? '' : palette) + '" style="' + (it.cover ? 'background:#fff;' : '') + '">' + coverHtml + '</div>' +
        '<div class="wb-body">' +
        '<div class="wb-title">' + self._esc(dispTitle) + '</div>' +
        '<div class="wb-meta"><span>' + self._esc(it.author_name || '') + '</span>' +
          '<span class="shelf-social" data-social="preset-' + it.id + '" style="gap:8px;margin:0;">' +
            '<span class="lk' + (it.liked ? ' on' : '') + '" onclick="CommunityChat.toggleLike(\'preset\',' + it.id + ',event)" title="点赞">' + self._heartSvg() + '<span class="lk-n">' + (it.likes || 0) + '</span></span>' +
            '<span title="评论">💬 <span class="cm-n">' + (it.comments || 0) + '</span></span>' +
            '<span title="下载">⬇ ' + (it.downloads || 0) + '</span>' +
          '</span></div>' +
        '</div></div>';
    });
    box.innerHTML = html;
    this.renderPredPager();
  },
  // 分页条（顶部/底部各一套）
  renderPredPager() {
    var max = Math.max(1, Math.ceil(this.predTotal / this.predPageSize));
    var page = Math.min(this.predPage, max);
    var html =
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoPredPage(1)" ' + (page <= 1 ? 'disabled' : '') + ' title="首页">«</button>' +
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoPredPage(' + (page - 1) + ')" ' + (page <= 1 ? 'disabled' : '') + ' title="上一页">‹</button>' +
      '<span class="wb-pg-info">第</span>' +
      '<input class="wb-pg-num" type="number" min="1" max="' + max + '" value="' + page + '" onchange="CommunityChat.gotoPredPage(this.value)" onkeydown="if(event.key===\'Enter\'){CommunityChat.gotoPredPage(this.value)}">' +
      '<span class="wb-pg-info">/ ' + max + ' 页</span>' +
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoPredPage(' + (page + 1) + ')" ' + (page >= max ? 'disabled' : '') + ' title="下一页">›</button>' +
      '<button class="wb-pg-btn" onclick="CommunityChat.gotoPredPage(' + max + ')" ' + (page >= max ? 'disabled' : '') + ' title="末页">»</button>';
    // 只保留底部分页（顶部分页已按需求移除）
    var bottom = document.getElementById('predPagerBottom');
    if (bottom) bottom.innerHTML = html;
  },

  // ---------- 预设上传（从软件内预设选择 + 封面图） ----------
  openPredUploadModal() {
    var self = this;
    var sel = document.getElementById('predUploadSelect');
    var empty = document.getElementById('predUploadEmpty');
    var desc = document.getElementById('predUploadDesc');
    if (desc) desc.value = '';
    this._predCover = '';
    var preview = document.getElementById('predCoverPreview');
    var ph = document.getElementById('predCoverPlaceholder');
    if (preview) { preview.style.display = 'none'; preview.src = ''; }
    if (ph) ph.style.display = '';
    var presets = (typeof PresetManager !== 'undefined' && PresetManager.getPresets) ? PresetManager.getPresets() : [];
    if (!sel) return;
    sel.innerHTML = '';
    this._predBooks = presets;
    if (!presets.length) {
      if (empty) empty.style.display = '';
      sel.innerHTML = '<option value="">（无）</option>';
      sel.disabled = true;
    } else {
      if (empty) empty.style.display = 'none';
      sel.disabled = false;
      var html = '';
      presets.forEach(function (p, i: any) {
        var name = p.name || p.title || ('预设 ' + (i + 1));
        html += '<option value="' + i + '">' + self._esc(name) + '</option>';
      });
      sel.innerHTML = html;
    }
    UIManager!.showModal('modalCommunityPresetUpload');
  },
  doPredUpload() {
    var self = this;
    var sel = document.getElementById('predUploadSelect');
    var idx = sel ? parseInt(sel.value, 10) : -1;
    var desc = String((document.getElementById('predUploadDesc') || ({} as any)).value || '').trim();
    var cat = String((document.getElementById('predUploadCategory') || ({} as any)).value || '综合');
    if (!this._predBooks || idx < 0 || !this._predBooks[idx]) { App.toast('请选择要上传的预设'); return; }
    var p = this._predBooks[idx];
    var title = String(p.name || p.title || '').trim();
    if (!title) { App.toast('预设没有名称'); return; }
    // 只序列化可分享的内容：提示词模块 + 正则（不含系统提示绑定、不含对话）
    var share = {
      name: title,
      promptModules: Array.isArray(p.promptModules) ? p.promptModules : [],
      regexScripts: Array.isArray(p.regexScripts) ? p.regexScripts : [],
      description: String(p.description || '').slice(0, 500)
    };
    var content = JSON.stringify(share);
    if (content.length > 2 * 1024 * 1024) { App.toast('预设内容超过 2MB，无法上传'); return; }
    var payload = { title: title, description: desc, category: cat, content: content };
    if (this._predCover) (payload as any).cover = this._predCover;
    fetch(this.server + '/api/preset/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.token },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '上传失败'); return; }
        UIManager!.closeModal('modalCommunityPresetUpload');
        // 审核门：普通账号上传进待审，管理员账号直接公开
        App.toast(String(res.j.status || 'approved') === 'pending'
          ? '已提交，管理员审核通过后公开（个人中心 → 我的预设 里看状态）'
          : '上传成功，已分享到预设区');
        self.predLoaded = false;
        self.loadPresetList();
      })
      .catch(function (e) { App.toast('网络错误: ' + e.message); });
  },

  // ---------- 预设详情 / 导入 / 删除 ----------
  openPredDetail(id: any) {
    var self = this;
    fetch(this.server + '/api/preset/detail?id=' + id, { headers: this.authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json(); })
      .then(function (j) {
        self.currentPredDetail = j.item;
        var it = j.item;
        var body = document.getElementById('predDetailBody');
        var coverHtml = it.cover
          ? '<img class="detail-cover" src="' + self._escAttr(it.cover) + '" alt="">'
          : '';
        body!.innerHTML = coverHtml +
          '<div style="font-size:16px;font-weight:700;margin-bottom:6px;">' + self._esc(it.title) + self._subBadge(it.status) + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted);">作者 ' + self._esc(it.author_name) + ' · 分类 ' + self._esc(it.category) + '</div>' +
          '<div class="detail-social" id="predDetailSocial"></div>' +
          '<div style="font-size:13px;line-height:1.7;color:var(--text-secondary);white-space:pre-wrap;">' + self._esc(it.description || '暂无简介') + '</div>' +
          (it.status === 'rejected' ? '<div style="font-size:12px;color:var(--text-muted);margin-top:6px;">该稿未通过审核，内容已从服务器移除（记录保留，可删除这条投稿）。</div>' : '') +
          '<div id="cmtBox"></div>';
        var delBtn = document.getElementById('predDeleteBtn');
        var isMine = self.user && it.author_id === self.user.id;
        if (delBtn) delBtn.style.display = isMine ? '' : 'none';
        UIManager!.showModal('modalCommunityPresetDetail');
        self._renderDetailSocial('preset');
        self.openComments('preset', it.id);
      })
      .catch(function () { App.toast('详情加载失败'); });
  },
  // 导入到软件内预设库（构造成 PresetManager 结构并应用）
  downloadPred() {
    if (!this.currentPredDetail) return;
    var self = this;
    var id = this.currentPredDetail.id;
    fetch(this.server + '/api/preset/download?id=' + id, { headers: this.authHeaders() })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.text(); })
      .then(function (text) {
        try {
          var data = JSON.parse(text);
          var name = String(data.name || data.title || self.currentPredDetail.title || '导入预设').trim();
          var preset = {
            id: 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            name: name,
            promptModules: Array.isArray(data.promptModules) ? data.promptModules : [],
            regexScripts: Array.isArray(data.regexScripts) ? data.regexScripts : [],
            isDefault: false,
            createdAt: Date.now()
          };
          if (typeof PresetManager !== 'undefined' && PresetManager.getPresets && PresetManager.savePresets) {
            var all = PresetManager.getPresets();
            all.push(preset);
            PresetManager.savePresets(all);
            PresetManager.setCurrentPresetId(preset.id);
            if (UIManager.renderPresets) UIManager.renderPresets();
            UIManager!.closeModal('modalCommunityPresetDetail');
            App.toast('已导入并应用预设：' + name);
            self.loadPresetList(); // 刷新（下载计数已在服务端+1）
          } else {
            App.toast('导入失败：预设模块不可用');
          }
        } catch (e) { App.toast('导入失败：文件格式不正确'); }
      })
      .catch(function () { App.toast('导入失败'); });
  },
  // 删除自己上传的预设（带确认）
  deletePred() {
    if (!this.currentPredDetail) return;
    var self = this;
    var id = this.currentPredDetail.id;
    if (typeof UIManager.showConfirm === 'function') {
      UIManager.showConfirm('确定删除这份预设吗？删除后其他人将无法下载。', function () { self._doDeletePred(id); });
    } else {
      if (window.confirm('确定删除这份预设吗？')) self._doDeletePred(id);
    }
  },
  _doDeletePred(id: any) {
    var self = this;
    fetch(this.server + '/api/preset/delete?id=' + id, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + this.token }
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) { App.toast(res.j.error || '删除失败'); return; }
        UIManager!.closeModal('modalCommunityPresetDetail');
        App.toast('已删除');
        self.currentPredDetail = null;
        self.loadPresetList();
      })
      .catch(function (e) { App.toast('网络错误: ' + e.message); });
  },
};

// 自托管初始化：先等 StorageManager（IndexedDB）就绪，避免丢失已保存的登录态。
void (async function () {
  try { if (typeof _storageInit !== 'undefined' && _storageInit !== null && typeof _storageInit.then === 'function') await _storageInit; } catch (e) {}
  try { CommunityChat.init(); } catch (e) { console.warn('[Community] init 异常:', e); }
})();


// ---- build-legacy 构建管线生成的全局挂载 ----
const __pl = globalThis as any;
__pl.CommunityChat = CommunityChat;
