import { SM } from '../infra/gate';
import { AdminMode } from './adminmode';
import { _wbKey } from '../lib/usage';
import { SettingSyncManager } from './settingsync';
import { RegexEngine } from '../lib/regex';
import { PluginManager } from './plugins';
import { WorldBookManager, selectInjectableEntries, WB_INJECT_MAX_CHARS } from './worldbook';
import { normalizeStoryWindow, storyWindowTrigger, estimateTokens, wanChars, windowFromContext } from '../lib/contextbudget';
import { BookManager } from './book';
import { ProtagonistManager } from './protagonist';
import { DatabaseManager } from './database';
import { StatusVars } from './statusvars';
import { formatVersion } from '../lib/webver';
import { avatarUrl } from '../lib/avatarurl';
// 社区聊天：独立 legacy 全局（modules/community.js），运行时成员按 typeof 探测
declare const CommunityChat: { [k: string]: any };
export interface UIManagerShape {
  [k: string]: any;
  confirmCallback?: any;
  _wbPage?: any;
  _wbPageSize?: any;
  _wbViewEntryId?: any;   // 「查看全文」弹窗当前展示的条目 id（供弹窗里的「编辑」跳转）
  _drag?: any;
  timer?: any;
  targetIdx?: any;
  edgeSide?: any;
  lastTargetEl?: any;
  _scrollSpeed?: any;
  itemSelector?: any;
  pageable?: any;
  dragHandleOnly?: any;
  id?: any;
  enabled?: any;
  role?: any;
  edgeZone?: any;
  pageHoldMs?: any;
  holdMs?: any;
  _avatarTarget?: any;
  light?: any;
  dark?: any;
  newspaper?: any;
  dream?: any;
}

// 管线化迁移（源码与 www/modules/ui.js 逐行一致）：
// 该模块属 UI/胶水层超大文件：全库 strict 类型检查下（无 @ts-nocheck 指令），
// 接口化标注 + 拆分进行中（见 docs/single-bundle-refactor.md）。
// 尾部由 build-legacy.mjs 自动追加全局挂载（IIFE 产物内顶层声明不可见）。
// 类型 → 彩色 chip 类（世界书条目共用，颜色集中在 index.html 的 .chip-* 定义）
// 只列当前可创建/迁移后仍存在的类型：其余旧类型在启动时被 migrateEntryTypes 统一改成「其他」
const TYPE_CHIPS: Record<string, string> = { '角色': 'chip-red', '世界观': 'chip-purple', '初始': 'chip-blue', '其他': 'chip-gray', '变量': 'chip-amber' };
function typeChip(t: any) { return 'chip ' + (TYPE_CHIPS[t] || 'chip-gray'); }

// 变量页时间显示：今天只给时分，其它日期带上月日
function fmtVarTime(at: number): string {
  try {
    var d = new Date(Number(at) || 0);
    var hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    var today = new Date();
    return d.toDateString() === today.toDateString() ? hm : ((d.getMonth() + 1) + '月' + d.getDate() + '日 ' + hm);
  } catch (e) { return ''; }
}

const UIManager: UIManagerShape = {
  confirmCallback: null,
  _wbPage: 1,
  _wbPageSize: 20,
  _wbViewEntryId: null,
  // ===== 通用拖拽排序（Pointer Events，统一鼠标+触屏）=====
  // config: { itemSelector, getId(row), getIdx(row), onReorder(fromId, fromIdx, toIdx, after),
  //           pageable, onPage(dir), edgeZone, pageHoldMs }
  _drag: null,

  _bindSortable(container: any, config: any) {
    if (!container || container.__sortableBound) return;
    container.__sortableBound = true;
    container.addEventListener('pointerdown', function (e: any) {
      if (config.dragHandleOnly) {
        // 仅手柄可拖（模块列表等小控件多的行）
        const handle = e.target.closest('.drag-handle');
        if (!handle) return;
        const row = handle.closest(config.itemSelector || '[data-drag-item]');
        if (!row) return;
        // 不 preventDefault：武装阶段允许正常滚动页面/列表
        UIManager._sortableArm(e, row, config);
        return;
      }
      // 整条可拖（世界书条目）：点在交互控件上不触发拖拽
      if (e.target.closest('button, input, select, textarea, a, label, .toggle-btn, [contenteditable="true"]')) return;
      const row = e.target.closest(config.itemSelector || '[data-drag-item]');
      if (!row) return;
      // 不 preventDefault：武装阶段允许正常滚动页面/列表
      UIManager._sortableArm(e, row, config);
    });
  },

  // 长按触发拖拽：按住把手 holdMs（默认0.5秒）后进入拖拽；期间移动超过阈值或松手则取消
  _sortableArm(e: any, row: any, config: any) {
    if (this._drag || this._arm) return;
    const holdMs = (config && config.holdMs) || 500;
    const moveThresh = 12;
    const arm = {
      row: row, config: config,
      startX: e.clientX, startY: e.clientY,
      lastX: e.clientX, lastY: e.clientY,
      timer: null as any, cancelled: false
    };
    this._arm = arm;
    const onMove = function (ev: any) {
      arm.lastX = ev.clientX; arm.lastY = ev.clientY;
      const dx = Math.abs(ev.clientX - arm.startX);
      const dy = Math.abs(ev.clientY - arm.startY);
      if (dx > moveThresh || dy > moveThresh) UIManager._sortableCancelArm();
    };
    const onEnd = function () { UIManager._sortableCancelArm(); };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
    (arm as any)._onMove = onMove; (arm as any)._onEnd = onEnd;
    arm.timer = setTimeout(function () {
      if (arm.cancelled) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      UIManager._arm = null;
      UIManager._sortableStart({ clientX: arm.lastX, clientY: arm.lastY }, arm.row, arm.config);
    }, holdMs);
  },

  _sortableCancelArm() {
    const arm = this._arm;
    if (!arm) return;
    arm.cancelled = true;
    clearTimeout(arm.timer);
    document.removeEventListener('pointermove', arm._onMove);
    document.removeEventListener('pointerup', arm._onEnd);
    document.removeEventListener('pointercancel', arm._onEnd);
    this._arm = null;
  },

  _sortableStart(e: any, row: any, config: any) {
    const rect = row.getBoundingClientRect();
    const clone = row.cloneNode(true);
    clone.classList.add('sortable-drag-layer');
    clone.querySelectorAll('button,input,select').forEach(function (el: any) { el.disabled = true; });
    // 克隆体只保留紧凑的行头，隐藏展开内容
    clone.querySelectorAll('.entry-body, .entry-preview, .entry-actions').forEach(function (el: any) { el.style.display = 'none'; });
    clone.style.left = rect.left + 'px';
    clone.style.top = rect.top + 'px';
    clone.style.width = rect.width + 'px';
    document.body!.appendChild(clone);
    row.classList.add('is-dragging');

    let edgeLeft = null, edgeRight = null;
    if (config.pageable) {
      edgeLeft = document.createElement('div');
      edgeLeft.className = 'edge-pager edge-pager-left';
      edgeLeft.textContent = '◀';
      document.body!.appendChild(edgeLeft);
      edgeRight = document.createElement('div');
      edgeRight.className = 'edge-pager edge-pager-right';
      edgeRight.textContent = '▶';
      document.body!.appendChild(edgeRight);
    }

    this._drag = {
      config: config, row: row, container: row.parentElement, clone: clone, edgeLeft: edgeLeft, edgeRight: edgeRight,
      scrollParent: this._getScrollParent(row.parentElement),
      fromId: config.getId ? config.getId(row) : row.getAttribute('data-drag-id'),
      fromIdx: config.getIdx ? config.getIdx(row) : parseInt(row.getAttribute('data-drag-idx'), 10),
      offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top,
      targetIdx: null, after: false,
      edgeSide: null, edgeTimer: null,
      lastTargetEl: null,
      _lastX: e.clientX, _lastY: e.clientY,
      _scrollSpeed: 0, _scrollTimer: null
    };

    const onMove = (ev: any) => this._sortableMove(ev);
    const onUp = (ev: any) => this._sortableUp(ev);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    // 进入拖拽后锁定页面滚动，避免干扰（拖到边缘时由 _sortableEdgeScroll 自动滚动列表）
    document.body.style.overflow = 'hidden';
    // WebView 触屏：touch-action 在触摸开始那一刻就定了（默认 auto），激活后才改 body 无效；
    // 必须阻止 touchmove 默认滚动（对当前手势生效）+ 给真正滚动容器设 touch-action（对后续手势）
    if (this._drag.scrollParent) this._drag.scrollParent.style.touchAction = 'none';
    this._blockTouchMove = function (ev: any) { if (ev.cancelable) ev.preventDefault(); };
    document.addEventListener('touchmove', this._blockTouchMove, { passive: false });
    // 阻止 Android 长按触发的文本选择/上下文菜单打断拖拽
    this._blockCtxMenu = function (ev: any) { ev.preventDefault(); };
    document.addEventListener('contextmenu', this._blockCtxMenu);
    this._drag._onMove = onMove;
    this._drag._onUp = onUp;
  },

  // 找最近的可滚动祖先（用于拖拽边缘自动滚动）
  _getScrollParent(el: any) {
    var p = el;
    while (p && p !== document.body && p !== document.documentElement) {
      p = p.parentElement;
      if (!p) break;
      var st = getComputedStyle(p);
      if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  },

  _sortableMove(e: any) {
    const d = this._drag;
    if (!d) return;
    d._lastX = e.clientX; d._lastY = e.clientY;
    d.clone.style.left = (d._lastX - d.offsetX) + 'px';
    d.clone.style.top = (d._lastY - d.offsetY) + 'px';
    this._sortableUpdateDrop(d._lastX, d._lastY);
    this._sortableEdgeScroll(d._lastY);

    // 边缘翻页：拖到容器左/右边缘停留 pageHoldMs 触发翻页
    if (d.config.pageable && d.edgeLeft && d.edgeRight) {
      const cr = d.container ? d.container.getBoundingClientRect() : null;
      if (cr) {
        const zone = d.config.edgeZone || 40;
        let side: any = null;
        if (d._lastX < cr.left + zone) side = 'left';
        else if (d._lastX > cr.right - zone) side = 'right';
        if (side !== d.edgeSide) {
          d.edgeSide = side;
          clearTimeout(d.edgeTimer);
          if (side) {
            const thisSide = side;
            d.edgeTimer = setTimeout(function () {
              if (d.edgeSide === thisSide) {
                const dir = thisSide === 'left' ? -1 : 1;
                if (d.config.onPage) d.config.onPage(dir);
                // 翻页后行 DOM 已重建，重置引用
                d.lastTargetEl = null;
                d.edgeSide = null;
                d.edgeTimer = null;
              }
            }, d.config.pageHoldMs || 1000);
          }
        }
        d.edgeLeft.classList.toggle('active', side === 'left');
        d.edgeRight.classList.toggle('active', side === 'right');
      }
    }
  },

  // 计算插入位置：比较指针 Y 与各行中心（用缓存的容器引用，翻页重建 innerHTML 后仍有效）
  _sortableUpdateDrop(x: any, y: any) {
    const d = this._drag;
    if (!d) return;
    const container = d.container;
    if (!container) return;
    const rows = Array.prototype.slice.call(container.querySelectorAll(d.config.itemSelector || '[data-drag-item]'));
    let best: any = null, bestDist: any = Infinity, bestAfter: any = false;
    rows.forEach(function (r) {
      if (r === d.row) return;
      const rRect = r.getBoundingClientRect();
      const dist = y - (rRect.top + rRect.height / 2);
      const adist = Math.abs(dist);
      if (adist < bestDist) { bestDist = adist; best = r; bestAfter = dist > 0; }
    });
    if (best) {
      const idx = d.config.getIdx ? d.config.getIdx(best) : parseInt(best.getAttribute('data-drag-idx'), 10);
      d.targetIdx = idx;
      d.after = bestAfter;
      if (d.lastTargetEl && d.lastTargetEl !== best) d.lastTargetEl.classList.remove('drop-target');
      best.classList.add('drop-target');
      d.lastTargetEl = best;
    }
  },

  // 拖拽到滚动容器上/下边缘时自动滚动（越靠近边缘越快）
  _sortableEdgeScroll(y: any) {
    const d = this._drag;
    if (!d) return;
    const sp = d.scrollParent;
    if (!sp) return;
    const rect = sp.getBoundingClientRect();
    const zone = 60;
    let speed = 0;
    if (y < rect.top + zone) {
      speed = -Math.max(2, Math.round((rect.top + zone - y) / zone * 14));
    } else if (y > rect.bottom - zone) {
      speed = Math.max(2, Math.round((y - (rect.bottom - zone)) / zone * 14));
    }
    d._scrollSpeed = speed;
    if (speed !== 0 && !d._scrollTimer) {
      d._scrollTimer = setInterval(() => {
        const dd = this._drag;
        if (!dd || dd._scrollSpeed === 0) return;
        sp.scrollTop += dd._scrollSpeed;
        if (dd.lastTargetEl) dd.lastTargetEl.classList.remove('drop-target');
        dd.lastTargetEl = null;
        this._sortableUpdateDrop(dd._lastX, dd._lastY);
      }, 16);
    } else if (speed === 0 && d._scrollTimer) {
      clearInterval(d._scrollTimer);
      d._scrollTimer = null;
    }
  },

  _sortableUp() {
    const d = this._drag;
    if (!d) return;
    const config = d.config, fromId = d.fromId, fromIdx = d.fromIdx, targetIdx = d.targetIdx, after = d.after;
    this._sortableCleanup();
    if (config.onReorder && targetIdx != null) {
      config.onReorder(fromId, fromIdx, targetIdx, after);
    }
  },

  _sortableCleanup() {
    const d = this._drag;
    if (!d) return;
    if (d.row) d.row.classList.remove('is-dragging');
    if (d.lastTargetEl) d.lastTargetEl.classList.remove('drop-target');
    if (d.clone) d.clone.remove();
    if (d.edgeLeft) d.edgeLeft.remove();
    if (d.edgeRight) d.edgeRight.remove();
    if (d.edgeTimer) clearTimeout(d.edgeTimer);
    if (d._scrollTimer) clearInterval(d._scrollTimer);
    if (d._onMove) document.removeEventListener('pointermove', d._onMove);
    if (d._onUp) document.removeEventListener('pointerup', d._onUp);
    if (d._onUp) document.removeEventListener('pointercancel', d._onUp);
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    document.body.style.overflow = '';
    document.body.style.touchAction = '';
    if (d.scrollParent) d.scrollParent.style.touchAction = '';
    if (this._blockTouchMove) { document.removeEventListener('touchmove', this._blockTouchMove); this._blockTouchMove = null; }
    if (this._blockCtxMenu) { document.removeEventListener('contextmenu', this._blockCtxMenu); this._blockCtxMenu = null; }
    this._drag = null;
  },

  init() {
    document.querySelectorAll('#panel-tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#panel-tabs button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        document.getElementById('tab-' + btn.dataset.tab)!.classList.add('active');
      });
    });
    document.getElementById('titleInput')!.addEventListener('input', () => {
      const data = App!.getNovelData(); (data as any).title = document.getElementById('titleInput')!.value; App.saveNovelData(data);
    });
    document.querySelectorAll('.modal-overlay').forEach(o => { o.addEventListener('click', (e) => { if (e.target === o) this.closeModal(o.id); }); });
  },

  switchSubTab(name: any) {
    document.querySelectorAll('.subtab').forEach(s => s.style.display = 'none');
    const el = document.getElementById('subtab-' + name);
    if (el) el.style.display = 'block';
    const btns = document.getElementById('subtab-presets')!.parentElement!.querySelectorAll('button[data-subtab]');
    btns.forEach(b => { b.style.background = b.dataset.subtab === name ? 'var(--primary-light)' : ''; b.style.color = b.dataset.subtab === name ? 'var(--primary)' : ''; });
  },

  showModal(id: any) { document.getElementById(id)!.classList.add('show'); },
  closeModal(id: any) { document.getElementById(id)!.classList.remove('show'); },

  // Character
  // Preset
  showPresetModal() {
    document.getElementById('presetName')!.value = '';
    document.getElementById('modalPresetTitle')!.textContent = '新建空预设';
    this.showModal('modalPreset');
  },

  savePreset() {
    const name = document.getElementById('presetName')!.value.trim();
    if (!name) { App.toast('请输入预设名称'); return; }
    const created = PresetManager.createEmptyPreset(name);
    this.closeModal('modalPreset');
    UIManager.renderPresets();
    App.toast('已新建预设: ' + created.name + '（空预设，在「模块管理」里加模块）');
  },

  // Preset Edit
  showPresetEditModal(presetId: any) {
    const presets = PresetManager.getPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset) { App.toast('预设不存在'); return; }
    document.getElementById('editPresetId')!.value = preset.id;
    document.getElementById('editPresetName')!.value = preset.name || '';
    document.getElementById('modalPresetEditTitle')!.textContent = '编辑预设: ' + preset.name;
    this.showModal('modalPresetEdit');
  },

  savePresetEdit() {
    const presetId = document.getElementById('editPresetId')!.value;
    const presets = PresetManager.getPresets();
    const preset = presets.find(p => p.id === presetId);
    if (!preset) { App.toast('预设不存在'); return; }
    const newName = document.getElementById('editPresetName')!.value.trim();
    if (!newName) { App.toast('请输入预设名称'); return; }
    // Check for duplicate names (excluding this preset)
    if (presets.find(p => p.name === newName && p.id !== presetId)) {
      App.toast('预设名称已存在'); return;
    }
    preset.name = newName;
    PresetManager.savePresets(presets);
    this.closeModal('modalPresetEdit');
    // Re-apply if this is the current preset
    if (PresetManager.getCurrentPresetId() === presetId) {
      PresetManager.applyPreset(presetId);
    }
    UIManager.renderPresets();
    App.toast('预设已更新: ' + preset.name);
  },

  // ===== Module Management =====
  toggleModuleManager() {
    const body = document.getElementById('moduleList');
    const arrow = document.querySelector('.module-mgr-arrow');
    if (!body) return;
    const isOpen = body.classList.contains('open');
    body.classList.toggle('open');
    if (arrow) arrow.classList.toggle('open');
    if (!isOpen) this.renderModuleList();
  },

  renderModuleList() {
    const container = document.getElementById('moduleList');
    const countEl = document.getElementById('moduleCount');
    if (!container || !countEl) return;
    const preset = PresetManager.getCurrentPreset();
    if (!preset) { container.innerHTML = ''; countEl.textContent = '0/0'; return; }
    const modules = preset.promptModules || [];
    const enabledCount = modules.filter(function (m: any) { return m.enabled; }).length;
    countEl.textContent = enabledCount + '/' + modules.length;
    if (modules.length === 0) {
      container.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;text-align:center;">暂无模块</div><button class="small primary" onclick="UIManager.showModuleEdit(null)" style="width:100%;margin-top:4px;">+ 添加模块</button>';
      return;
    }
    // Ensure every module has a name
    modules.forEach(function (m: any) {
      if (!m.name) {
        if (m.content) {
          var firstLine = m.content.split('\n')[0].trim().slice(0, 40);
          m.name = firstLine || '未命名';
        } else {
          m.name = '未命名';
        }
      }
    });
    container.innerHTML = modules.map(function (m: any, i: any) {
      // 位置/模式标签（2026-09-26）：尾部模块不进系统提示词、贴在用户消息末尾；
      // 「思考」= 思考要求（思考强度 off 时不下发，且它的存在会抑制软件兜底条款）。
      const _tail = m.role === 'user';
      const _think = m.slot === 'think';
      const _tag = _tail ? (_think ? '思维链' : '末尾·导入') : 'system';
      const _modeTag = m.mode === 'novel' ? '·仅续写' : (m.mode === 'chat' ? '·仅演出' : '');
      return '<div class="module-row" data-drag-item="' + m.id + '" data-drag-id="' + m.id + '" data-drag-idx="' + i + '">' +
        '<span class="drag-handle" title="拖动排序">≡</span>' +
        '<span class="mod-name" title="' + htmlEscape(m.name) + '">' + htmlEscape(m.name) + '</span>' +
        '<input type="checkbox" ' + (m.enabled ? 'checked' : '') + ' onchange="UIManager.toggleModule(\'' + m.id + '\',this.checked)">' +
        '<span class="tag">' + _tag + _modeTag + '</span>' +
        '<span class="mod-actions">' +
          '<button class="icon-btn" onclick="UIManager.showModuleEdit(\'' + m.id + '\')">✎</button>' +
          '<button class="icon-btn danger" onclick="UIManager.deleteModule(\'' + m.id + '\')">✕</button>' +
        '</span>' +
        '</div>';
    }).join('') + '<button class="small primary" onclick="UIManager.showModuleEdit(null)" style="width:100%;margin-top:4px;">+ 添加模块</button>';

    this._bindSortable(container, {
      itemSelector: '.module-row',
      pageable: false,
      dragHandleOnly: true,
      getId: function (r: any) { return r.getAttribute('data-drag-id'); },
      getIdx: function (r: any) { return parseInt(r.getAttribute('data-drag-idx'), 10); },
      onReorder: function (fromId: any, fromIdx: any, toIdx: any, after: any) {
        // 用同一引用：getCurrentPreset() 每次重新反序列化，修改其对象后
        // savePresets(getPresets()) 保存的是另一份，排序会丢失
        const presets = PresetManager.getPresets();
        const preset = presets.find(function (p) { return p.id === PresetManager.getCurrentPresetId(); });
        if (!preset || !preset.promptModules) return;
        const modules = preset.promptModules;
        const cur = modules.findIndex(function (m: any) { return m.id === fromId; });
        if (cur < 0) return;
        const item = modules.splice(cur, 1)[0];
        let ins = toIdx;
        if (cur < ins) ins--;
        if (after) ins++;
        ins = Math.max(0, Math.min(modules.length, ins));
        modules.splice(ins, 0, item);
        // 重编号 order = 数组索引，保证注入顺序（app.js 按 order 排序）跟随拖拽
        modules.forEach(function (m: any, idx: any) { m.order = idx; });
        PresetManager.savePresets(presets);
        UIManager.renderModuleList();
      }
    });
  },

  toggleModule(id: any, enabled: any) {
    const preset = PresetManager.getCurrentPreset();
    if (!preset || !preset.promptModules) return;
    const mod = preset.promptModules.find(function (m: any) { return m.id === id; });
    if (!mod) return;
    mod.enabled = enabled;
    PresetManager.savePresets(PresetManager.getPresets());
        this.renderModuleList();
  },

  showModuleEdit(moduleId: any) {
    document.getElementById('modalModuleTitle')!.textContent = moduleId ? '编辑模块' : '添加模块';
    document.getElementById('moduleEditId')!.value = moduleId || '';
    document.getElementById('moduleEditName')!.value = '';
    document.getElementById('moduleEditContent')!.value = '';
    // 类型下拉：常态只有「非思维链 / 思维链」两项；导入的酒馆 user 条目（role=user 但没有思考标记）
    // 单独给一项，避免编辑一次就把它的位置静默改掉。每次重建 options，不让上一轮的临时项残留。
    const kindSel = document.getElementById('moduleEditKind') as HTMLSelectElement;
    const BASE_KINDS = '<option value="plain">非思维链（默认）</option><option value="think">思维链</option>';
    kindSel.innerHTML = BASE_KINDS;
    (document.getElementById('moduleEditMode') as HTMLSelectElement).value = 'both';
    if (moduleId) {
      const preset = PresetManager.getCurrentPreset();
      const mod = preset && preset.promptModules ? preset.promptModules.find(function (m: any) { return m.id === moduleId; }) : null;
      if (mod) {
        document.getElementById('moduleEditName')!.value = mod.name || '';
        document.getElementById('moduleEditContent')!.value = mod.content || '';
        const isTail = mod.role === 'user';
        const isThink = mod.slot === 'think';
        if (isTail && !isThink) kindSel.innerHTML = BASE_KINDS + '<option value="tail">末尾模块（导入的酒馆用户条目）</option>';
        kindSel.value = isTail ? (isThink ? 'think' : 'tail') : 'plain';
        (document.getElementById('moduleEditMode') as HTMLSelectElement).value =
          (mod.mode === 'novel' || mod.mode === 'chat') ? mod.mode : 'both';
      }
    }
    this.showModal('modalModuleEdit');
  },

  saveModule() {
    const id = document.getElementById('moduleEditId')!.value;
    const name = document.getElementById('moduleEditName')!.value.trim();
    const content = document.getElementById('moduleEditContent')!.value.trim();
    if (!name) { App.toast('请输入模块名称'); return; }
    if (!content) { App.toast('请输入模块内容'); return; }
    const preset = PresetManager.getCurrentPreset();
    if (!preset) { App.toast('请先选择一个预设'); return; }
    if (!preset.promptModules) preset.promptModules = [];
    const kind = (document.getElementById('moduleEditKind') as HTMLSelectElement).value;
    const mode = (document.getElementById('moduleEditMode') as HTMLSelectElement).value;
    const _applyFields = function (m: any) {
      // kind=think → 思维链（放在用户消息末尾，思考关闭时跳过，且替代软件默认思考条款）；
      // kind=tail → 导入的酒馆 user 条目（放末尾，但没有思考语义）；plain → 普通系统模块。
      m.role = (kind === 'think' || kind === 'tail') ? 'user' : 'system';
      if (kind === 'think') m.slot = 'think'; else delete m.slot;
      // mode 只在非 both 时落盘（保持老模块的对象形状不变，别给所有模块凭空加字段）
      if (mode === 'novel' || mode === 'chat') m.mode = mode; else delete m.mode;
    };
    if (id) {
      const mod = preset.promptModules.find(function (m: any) { return m.id === id; });
      if (mod) { mod.name = name; mod.content = content; _applyFields(mod); App.toast('模块已更新'); }
      else { App.toast('模块不存在'); return; }
    } else {
      const _mod: any = {
        id: 'mod_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
        name: name,
        content: content,
        enabled: true,
        role: 'system',
        order: preset.promptModules.length
      };
      _applyFields(_mod);
      preset.promptModules.push(_mod);
      App.toast('模块已添加');
    }
    PresetManager.savePresets(PresetManager.getPresets());
    this.closeModal('modalModuleEdit');
    this.renderModuleList();
  },

  deleteModule(moduleId: any) {
    const preset = PresetManager.getCurrentPreset();
    if (!preset || !preset.promptModules) return;
    this.showConfirm('确定删除此模块？', function () {
      preset.promptModules = preset.promptModules.filter(function (m: any) { return m.id !== moduleId; });
      // 重编号 order，避免空洞导致注入顺序错乱
      preset.promptModules.forEach(function (m: any, idx: any) { m.order = idx; });
      PresetManager.savePresets(PresetManager.getPresets());
      UIManager.renderModuleList();
      App.toast('模块已删除');
    });
  },

  // SysPrompt
  showSysPromptModal(spId: any = null) {
    document.getElementById('spId')!.value = ''; document.getElementById('spName')!.value = ''; document.getElementById('spContent')!.value = '';
    if (spId) { const sp = PresetManager.getSystemPrompts().find((p: any) => p.id === spId); if (sp) { document.getElementById('spId')!.value = sp.id; document.getElementById('spName')!.value = sp.name; document.getElementById('spContent')!.value = sp.content; } }
    this.showModal('modalSysPrompt');
  },

  saveSysPrompt() {
    const id = document.getElementById('spId')!.value;
    const sp = { id: id || 'sp_' + Date.now(), name: document.getElementById('spName')!.value.trim(), content: document.getElementById('spContent')!.value.trim() };
    if (!sp.name) { App.toast('请输入名称'); return; }
    const prompts = PresetManager.getSystemPrompts();
    if (id) { const idx = prompts.findIndex((p: any) => p.id === id); if (idx >= 0) prompts[idx] = sp; }
    else prompts.push(sp);
    PresetManager.saveSystemPrompts(prompts);
    if (!id) PresetManager.setCurrentSystemPromptId(sp.id);
    this.closeModal('modalSysPrompt'); UIManager.populateSystemPromptUI(); UIManager.renderPresets();
    App.toast('系统提示词已保存');
  },

  // Regex
  showRegexModal(ruleId: any = null) {
    document.getElementById('regexId')!.value = ''; document.getElementById('regexName')!.value = ''; document.getElementById('regexFind')!.value = '';
    document.getElementById('regexReplace')!.value = ''; document.getElementById('regexTiming')!.value = 'before'; document.getElementById('regexEnabled')!.checked = true;
    document.getElementById('modalRegexTitle')!.textContent = '添加正则规则';
    if (ruleId) { const r = RegexEngine.getRules().find(x => x.id === ruleId); if (r) { document.getElementById('regexId')!.value = r.id; document.getElementById('regexName')!.value = r.name || ''; document.getElementById('regexFind')!.value = r.findRegex || ''; document.getElementById('regexReplace')!.value = r.replaceString || ''; document.getElementById('regexTiming')!.value = r.timing || 'before'; document.getElementById('regexEnabled')!.checked = r.enabled !== false; document.getElementById('modalRegexTitle')!.textContent = '编辑正则规则'; } }
    this.showModal('modalRegex');
  },

  saveRegexRule() {
    const id = document.getElementById('regexId')!.value;
    const rule = { id: id || 'regex_' + Date.now(), name: document.getElementById('regexName')!.value.trim(), findRegex: document.getElementById('regexFind')!.value, replaceString: document.getElementById('regexReplace')!.value, timing: document.getElementById('regexTiming')!.value, enabled: document.getElementById('regexEnabled')!.checked, order: 0 };
    if (!rule.findRegex) { App.toast('请输入正则表达式'); return; }
    const rules = RegexEngine.getRules();
    if (id) { const idx = rules.findIndex(r => r.id === id); if (idx >= 0) { rule.order = rules[idx].order; rules[idx] = rule; } }
    else { rule.order = rules.length; rules.push(rule); }
    RegexEngine.saveRules(rules); this.closeModal('modalRegex'); UIManager.renderRegexRules(); App.toast('正则规则已保存');
  },

  // World Book
  // Dialogs
  showConfirm(message: any, callback: any) { document.getElementById('confirmMessage')!.textContent = message; this.confirmCallback = callback; this.showModal('modalConfirm'); },

  // 管理员模式口令弹窗（入口：连点 10 下「检查更新」，见 domain/adminmode.ts）
  showAdminAuth() {
    const el = document.getElementById('adminPwInput') as HTMLInputElement | null;
    if (el) el.value = '';
    this.showModal('modalAdminAuth');
  },
  closeAdminAuth() {
    const el = document.getElementById('adminPwInput') as HTMLInputElement | null;
    if (el) el.value = '';
    this.closeModal('modalAdminAuth');
  },
  async submitAdminAuth() {
    const el = document.getElementById('adminPwInput') as HTMLInputElement | null;
    const pw = el ? el.value : '';
    const r = await AdminMode.enableWithPassword(pw);
    if (!r.ok) {
      App.toast(r.error || '口令校验失败');
      if (el) { el.value = ''; el.focus(); }
      return;
    }
    if (el) el.value = '';
  },
  confirmAction() { if (this.confirmCallback) { try { this.confirmCallback(); } catch(e) { console.error('confirmAction error:', e); } } this.closeModal('modalConfirm'); this.confirmCallback = null; },
  toggleApiKeyVisibility() { const el = document.getElementById('apiKey'); el!.type = el!.type === 'password' ? 'text' : 'password'; },
  testRegex() { document.getElementById('regexTestResult')!.textContent = RegexEngine.testRule(document.getElementById('regexFind')!.value, document.getElementById('regexReplace')!.value, document.getElementById('regexTestInput')!.value); },

  // Render functions
  populateAPIFields() {
    // 渠道/模型下拉由 App 渠道逻辑负责（selectChannel 时填充）；这里只填纯参数表单
    const cfg = SM().get<any>('apiConfig', {});
    const setVal = (id: string, v: unknown) => { const el = document.getElementById(id); if (el) (el as HTMLInputElement).value = String(v ?? ''); };
    setVal('apiEndpoint', cfg.endpoint || '');
    setVal('apiKey', cfg.apiKey || '');
    setVal('apiTemperature', cfg.temperature ?? 0.9);
    setVal('apiTopP', cfg.topP ?? 0.95);
    setVal('apiPresencePenalty', cfg.presencePenalty ?? 0.4);
    setVal('apiFrequencyPenalty', cfg.frequencyPenalty ?? 0.3);
    setVal('priceInput', cfg.priceInput ?? 1);
    setVal('priceCached', cfg.priceCached ?? 0.1);
    setVal('priceOutput', cfg.priceOutput ?? 2);
  },

  populateSystemPromptUI() {
    const prompts = PresetManager.getSystemPrompts(); const currentId = PresetManager.getCurrentSystemPromptId();
    const select = document.getElementById('sysPromptSelect'); select!.innerHTML = prompts.map((p: any) => `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${p.name}</option>`).join('');
    const current = prompts.find((p: any) => p.id === currentId) || prompts[0];
    if (current) document.getElementById('sysPromptContent')!.value = current.content || '';
  },

  renderPresets() {
    const presets = PresetManager.getPresets().sort((a, b: any) => (b.createdAt || 0) - (a.createdAt || 0));
    const currentId = PresetManager.getCurrentPresetId();
    const select = document.getElementById('presetSelect');
    select!.innerHTML = presets.map(p => `<option value="${p.id}" ${p.id === currentId ? 'selected' : ''}>${htmlEscape(p.name)}${p.isDefault ? ' (默认)' : ''}</option>`).join('');
    this.renderModuleList();
  },

  renderRegexRules() {
    const rules = RegexEngine.getRules(); const container = document.getElementById('regexRulesList');
    if (rules.length === 0) { container!.innerHTML = '<p style="font-size:13px;color:var(--text-muted);text-align:center;padding:16px;">暂无正则规则</p>'; return; }
    container!.innerHTML = rules.map((r, i: any) => `<div class="card" style="margin-bottom:6px;"><div style="display:flex;justify-content:space-between;align-items:center;"><div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;"><strong style="font-size:13px;">${htmlEscape(r.name||'未命名')}</strong><span class="tag ${r.timing==='before'?'before':'after'}">${r.timing==='before'?'发送前':'接收后'}</span>${r.enabled?'':'<span style="font-size:11px;color:var(--text-muted);">已禁用</span>'}</div><code style="font-size:11px;">${htmlEscape(r.findRegex)}</code><span style="font-size:11px;color:var(--text-muted);">→</span><code style="font-size:11px;">${htmlEscape(r.replaceString||'(空)')}</code></div><div style="display:flex;gap:2px;flex-shrink:0;margin-left:8px;"><button class="small icon-btn" onclick="UIManager.moveRegexRule('${r.id}',-1)" ${i===0?'disabled':''}>↑</button><button class="small icon-btn" onclick="UIManager.moveRegexRule('${r.id}',1)" ${i===rules.length-1?'disabled':''}>↓</button><button class="small icon-btn" onclick="UIManager.showRegexModal('${r.id}')">✎</button><button class="small icon-btn danger" onclick="UIManager.deleteRegexRule('${r.id}')">✕</button></div></div></div>`).join('');
  },

  moveRegexRule(ruleId: any, dir: any) { const rules = RegexEngine.getRules(); const idx = rules.findIndex(r => r.id === ruleId); if (idx < 0) return; const ni = idx + dir; if (ni < 0 || ni >= rules.length) return; [rules[idx], rules[ni]] = [rules[ni], rules[idx]]; RegexEngine.saveRules(rules); this.renderRegexRules(); },
  deleteRegexRule(ruleId: any) { this.showConfirm('确定删除这条正则规则？', () => { RegexEngine.saveRules(RegexEngine.getRules().filter(r => r.id !== ruleId)); this.renderRegexRules(); App.toast('已删除'); }); },





  // Protagonist UI
  renderProtagonists() {
    const list = ProtagonistManager!.getAll();
    const activeId = ProtagonistManager.getActiveId();
    const container = document.getElementById('protagList');
    const prompt = document.getElementById('protagSelectPrompt');
    const countEl = document.getElementById('protagCount');
    if (countEl) countEl.textContent = list.length ? list.length + ' 人' : '';
    if (list.length === 0) {
      container!.innerHTML = '<div class="empty-box"><div class="empty-tt">暂无主角配置</div><div class="empty-sub">点击右上角「添加主角」创建第一个角色</div></div>';
      prompt!.style.display = 'none';
      return;
    }
    prompt!.style.display = activeId ? 'none' : 'block';
    container!.innerHTML = list.map(p => {
      const active = p.id === activeId;
      const chips = [p.gender, p.age ? p.age + '岁' : '', p.occupation].filter(Boolean)
        .map(v => '<span class="chip chip-default">' + htmlEscape(v) + '</span>').join('');
      const initial = ((p.name || '').trim().charAt(0)) || '主';
      return `
      <div class="pg-card${active ? ' active' : ''}">
        <div class="pc-main">
          <div class="set-icon" style="font-size:17px;font-weight:800;">${htmlEscape(initial)}</div>
          <div style="flex:1;min-width:0;">
            <div class="pc-name-row">
              <span class="pc-name">${htmlEscape(p.name || '未命名')}</span>
              ${active ? '<span class="chip chip-primary">✓ 当前主角</span>' : ''}
              ${p.createdAt ? '<span style="font-size:10.5px;color:var(--text-muted);">' + new Date(p.createdAt).toLocaleDateString() + '</span>' : ''}
            </div>
            ${chips ? '<div class="pc-chips">' + chips + '</div>' : ''}
            ${p.personality ? '<div class="pc-preview">' + htmlEscape(p.personality) + '</div>' : ''}
          </div>
        </div>
        <div class="pc-actions">
          ${active
            ? '<button class="ghost-btn" onclick="UIManager.clearProtagonist()" title="保留这位主角的资料，只是不再作为当前主角">取消选择</button>'
            : '<button class="ghost-btn" onclick="UIManager.selectProtagonist(\'' + p.id + '\')">选为当前主角</button>'}
          <button class="ghost-btn" onclick="UIManager.showProtagonistModal('${p.id}')">✎ 编辑</button>
          <button class="ghost-btn danger" onclick="UIManager.deleteProtagonist('${p.id}')">删除</button>
        </div>
      </div>`;
    }).join('');
  },

  showProtagonistModal(editId: any) {
    document.getElementById('protagEditId')!.value = '';
    document.getElementById('modalProtagonistTitle')!.textContent = '添加主角';
    ['protagModalName','protagModalGender','protagModalAge','protagModalOccupation',
     'protagModalPersonality','protagModalAppearance','protagModalBackstory',
     'protagModalAbilities','protagModalCatchphrase'].forEach(id => document.getElementById(id)!.value = '');
    if (editId) {
      const p = ProtagonistManager!.getAll().find(x => x.id === editId);
      if (p) {
        document.getElementById('protagEditId')!.value = p.id;
        document.getElementById('modalProtagonistTitle')!.textContent = '编辑主角: ' + (p.name || '未命名');
        document.getElementById('protagModalName')!.value = p.name || '';
        document.getElementById('protagModalGender')!.value = p.gender || '';
        document.getElementById('protagModalAge')!.value = p.age || '';
        document.getElementById('protagModalOccupation')!.value = p.occupation || '';
        document.getElementById('protagModalPersonality')!.value = p.personality || '';
        document.getElementById('protagModalAppearance')!.value = p.appearance || '';
        document.getElementById('protagModalBackstory')!.value = p.backstory || '';
        document.getElementById('protagModalAbilities')!.value = p.abilities || '';
        document.getElementById('protagModalCatchphrase')!.value = p.catchphrase || '';
      }
    }
    this.showModal('modalProtagonist');
  },

  saveProtagonistFromModal() {
    const data = {
      name: document.getElementById('protagModalName')!.value.trim(),
      gender: document.getElementById('protagModalGender')!.value.trim(),
      age: document.getElementById('protagModalAge')!.value.trim(),
      occupation: document.getElementById('protagModalOccupation')!.value.trim(),
      personality: document.getElementById('protagModalPersonality')!.value.trim(),
      appearance: document.getElementById('protagModalAppearance')!.value.trim(),
      backstory: document.getElementById('protagModalBackstory')!.value.trim(),
      abilities: document.getElementById('protagModalAbilities')!.value.trim(),
      catchphrase: document.getElementById('protagModalCatchphrase')!.value.trim()
    };
    if (!data.name) { App.toast('请输入主角姓名'); return; }
    const editId = document.getElementById('protagEditId')!.value;
    if (editId) { ProtagonistManager.update(editId, data); }
    else { ProtagonistManager.create(data); }
    this.closeModal('modalProtagonist');
    this.renderProtagonists();
    App.toast(editId ? '主角已更新' : '主角已添加');
  },

  selectProtagonist(id: any) {
    ProtagonistManager.setActiveId(id);
    this.renderProtagonists();
    App.toast('已切换当前主角');
  },

  /**
   * 取消选择（保留资料）：只把"当前主角"置空，不删除这条主角。
   * 空主角是合法状态：{{user}} 会保留为「主角」占位，主角资料不再注入；
   * **叙事视角与它无关**（视角只看预设的「视角」条目，见 app.ts 的 autoContinue 说明）。
   */
  clearProtagonist() {
    ProtagonistManager.setActiveId(null);
    this.renderProtagonists();
    App.toast('已取消选择：主角资料保留，续写不再注入主角设定');
  },

  deleteProtagonist(id: any) {
    const p = ProtagonistManager!.getAll().find(x => x.id === id);
    this.showConfirm('确定删除主角"' + (p ? p.name : '') + '"？', () => {
      ProtagonistManager.delete(id);
      this.renderProtagonists();
      App.toast('主角已删除');
    });
  },

  // WorldBook UI
  renderWorldBooks() {
    this.renderWBSwitch();
    this.renderWBEntries();
    this.renderWbShelf();
  },

  // ===== 世界书书架（Level 1）=====
  renderWbShelf() {
    const grid = document.getElementById('wbShelfGrid');
    if (!grid) return;
    const books = WorldBookManager.getAll();
    const activeId = WorldBookManager.getActiveId();
    const countEl = document.getElementById('wbShelfCount');
    if (countEl) countEl.textContent = books.length + ' 本';
    if (books.length === 0) {
      grid.innerHTML = '<div class="empty-box" style="grid-column:1/-1;"><div class="empty-tt">还没有世界书</div><div class="empty-sub">点击右上角「＋」新建或导入</div></div>';
      return;
    }
    grid.innerHTML = books.map((wb, idx: any) => {
      const name = wb.name || wb.title || '未命名';
      const palette = 'wb-cover-palette' + (idx % 7);
      const coverInner = wb.cover
        ? '<img src="' + htmlEscape(wb.cover) + '" alt="">'
        : htmlEscape(name.trim().charAt(0) || '书');
      const cnt = (wb.entries ? wb.entries.length : 0);
      const no = 'No.' + String(idx + 1).padStart(2, '0');
      let mon = '—';
      if (wb.createdAt) { try { mon = (new Date(wb.createdAt).getMonth() + 1) + ' 月'; } catch (e) {} }
      return '<div class="shelf-card' + (wb.id === activeId ? ' is-active' : '') + '" data-wb-id="' + wb.id + '"' +
        ' onclick="UIManager.openWbBook(\'' + wb.id + '\')"' +
        ' onpointerdown="UIManager.shelfPressStart(event,\'' + wb.id + '\')"' +
        ' onpointermove="UIManager.shelfPressMove(event)"' +
        ' onpointerup="UIManager.shelfPressEnd()"' +
        ' onpointercancel="UIManager.shelfPressEnd()">' +
        '<div class="shelf-cover ' + (wb.cover ? '' : palette) + '">' + coverInner +
          (wb.id === activeId ? '<span class="shelf-badge-cur">当前</span>' : '') +
        '</div>' +
        '<div class="shelf-body">' +
          '<div class="shelf-name">' + htmlEscape(name) + '</div>' +
          '<div class="shelf-row"><span>编号</span><b>' + no + '</b></div>' +
          '<div class="shelf-row"><span>条目</span><b>' + cnt + '</b></div>' +
          '<div class="shelf-row"><span>入库</span><b>' + mon + '</b></div>' +
        '</div>' +
      '</div>';
    }).join('');
  },

  showWbShelf() {
    const shelf = document.getElementById('wbShelfView');
    const entries = document.getElementById('wbEntriesView');
    if (shelf) shelf.style.display = '';
    if (entries) entries.style.display = 'none';
    this.renderWbShelf();
  },

  showWbEntries() {
    const shelf = document.getElementById('wbShelfView');
    const entries = document.getElementById('wbEntriesView');
    if (shelf) shelf.style.display = 'none';
    if (entries) entries.style.display = '';
    this.renderWBEntries();
  },

  // 书架卡片点击 → 打开这本书的条目列表
  openWbBook(bookId: any) {
    if (this._shelfLongFired) { this._shelfLongFired = false; return; } // 长按弹菜单后的松手不当作点击
    this.switchWorldBook(bookId);
    this.showWbEntries();
  },

  // 长按书架卡片（550ms，移动>10px 取消）→ 底部操作表
  shelfPressStart(e: any, bookId: any) {
    this._shelfLongFired = false;
    this._shelfSX = e.clientX; this._shelfSY = e.clientY;
    clearTimeout(this._shelfTimer);
    const card = e.currentTarget;
    this._shelfTimer = setTimeout(() => {
      this._shelfLongFired = true;
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (err) {} }
      card.classList.add('pressed');
      this.openWbBookSheet(bookId);
    }, 550);
  },
  shelfPressMove(e: any) {
    if (this._shelfLongFired) return;
    if (Math.abs(e.clientX - this._shelfSX) > 10 || Math.abs(e.clientY - this._shelfSY) > 10) {
      clearTimeout(this._shelfTimer);
    }
  },
  shelfPressEnd() {
    clearTimeout(this._shelfTimer);
    document.querySelectorAll('.shelf-card.pressed').forEach(function (c) { c.classList.remove('pressed'); });
  },

  // ＋ 按钮 → 新建/导入操作表
  openWbAddSheet() {
    this.showModal('modalWbAddSheet');
  },

  // 长按操作表的三个动作
  wbSheetAction(action: any) {
    const bookId = this._wbSheetTargetId;
    this.closeModal('modalWbBookSheet');
    if (!bookId) return;
    const wb = WorldBookManager.getAll().find(function (w) { return w.id === bookId; });
    if (!wb) return;
    if (action === 'cover') {
      this.pickBookCover(bookId);
    } else if (action === 'rename') {
      this.showWBBookModal(bookId);
    } else if (action === 'export') {
      App.exportWorldBook(bookId);
    } else if (action === 'delete') {
      this.showConfirm('确定删除世界书"' + (wb.name || '') + '"及其所有条目？', () => {
        WorldBookManager.deleteBook(bookId);
        this.renderWorldBooks();
        App.toast('世界书已删除');
      });
    }
  },

  openWbBookSheet(bookId: any) {
    const wb = WorldBookManager.getAll().find(function (w) { return w.id === bookId; });
    if (!wb) return;
    this._wbSheetTargetId = bookId;
    const nameEl = document.getElementById('wbSheetBookName');
    if (nameEl) nameEl.textContent = wb.name || wb.title || '未命名';
    this.showModal('modalWbBookSheet');
  },

  // 选图 → 社区同款 2:3 裁剪 → 写回书本 cover 字段
  pickBookCover(bookId: any) {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = 'image/*';
    inp.onchange = function (ev) {
      const f = (ev!.target as any).files && (ev!.target as any).files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = function () {
        if (typeof CommunityChat !== 'undefined' && CommunityChat.startBookCoverCrop) {
          CommunityChat.startBookCoverCrop(String(reader.result), bookId);
        } else {
          App.toast('封面裁剪组件未就绪');
        }
      };
      reader.readAsDataURL(f);
    };
    inp.click();
  },

  // 顶部世界书切换下拉（编辑器工具栏内：点书名弹出世界书列表换书）
  renderWBSwitch() {
    const books = WorldBookManager.getAll();
    const activeId = WorldBookManager.getActiveId();
    const list = document.getElementById('wbSwitchList');
    const titleEl = document.getElementById('wbTitleText');
    if (list) {
      list.innerHTML = books.map(wb => {
        const n = wb.name || wb.title || '未命名';
        const cnt = (wb.entries ? wb.entries.length : 0);
        return '<div class="wb-switch-item ' + (wb.id === activeId ? 'active' : '') + '" onclick="UIManager.switchFromTitle(\'' + wb.id + '\')">' +
          '<span class="wb-switch-name">' + htmlEscape(n) + '</span>' +
          '<span class="wb-switch-count">' + cnt + '条</span></div>';
      }).join('');
    }
    const active = books.find(function (b) { return b.id === activeId; });
    const display = active ? (active.name || active.title || '未命名') : '未命名小说';
    if (titleEl) titleEl.textContent = display;
  },

  toggleWBSwitch() {
    const dd = document.getElementById('wbSwitchDropdown');
    const btn = document.getElementById('wbTitleBtn');
    if (!dd) return;
    const open = dd.classList.toggle('open');
    if (btn) btn.classList.toggle('open', open);
    if (open) this.renderWBSwitch();
  },
  closeWBSwitch() {
    const dd = document.getElementById('wbSwitchDropdown');
    const btn = document.getElementById('wbTitleBtn');
    if (dd) dd.classList.remove('open');
    if (btn) btn.classList.remove('open');
  },
  switchFromTitle(bookId: any) {
    if (!bookId) return;
    this.closeWBSwitch();
    if (bookId === WorldBookManager.getActiveId()) { App!.loadEditorContent(); App!.renderAll(); return; }
    this.switchWorldBook(bookId);
  },

  switchWorldBook(bookId: any) {
    if (bookId) {
      // 世界书=小说：切换世界书即切换小说，需保存旧章节并加载新章节
      App!.saveCurrentChapter();
      BookManager.syncToBook();
      WorldBookManager.setActiveId(bookId);
      BookManager.syncFromBook();
      // 比奇：换书即换会话（每本书的对话各自独立，不串台）
      if (typeof BiqiAgent !== 'undefined' && BiqiAgent.reloadForBook) BiqiAgent.reloadForBook();
      this.renderWBEntries();
      this.renderWbShelf();
      if (typeof App.loadEditorContent === 'function') App.loadEditorContent();
      if (typeof App.renderAll === 'function') App.renderAll();
      // 两种模式共用这一个选书入口：切完书要让对话模式也换到新书（演出记录按书分开存）。
      // 对话模式自己的选书栏已下线（用户要求），这里是唯一的同步点。
      try { if (typeof ChatMode !== 'undefined' && ChatMode.reload) { ChatMode.reload(); } } catch (e) { /* 忽略 */ }
    }
  },

  // 世界书注入占用统计（角色 > 世界观 > 其他 优先级取用；超 10 万字上限的条目整体跳过）
  _wbInjectStat(): string {
    try {
      let entries: any[] = (WorldBookManager.getActive() || {}).entries || [];
      if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled && SettingSyncManager.isEnabled()) {
        entries = SettingSyncManager.getEffectiveEntries();
      }
      const r = selectInjectableEntries(entries, WB_INJECT_MAX_CHARS);
      const total = entries.filter(function (e: any) { return e && e.inject !== false && e.type !== '变量' && e.type !== '前端' && e.type !== '初始'; }).length;
      return '注入 ' + r.kept.length + '/' + total + ' 条 / ' + r.chars + ' 字（上限 ' + WB_INJECT_MAX_CHARS + (r.skipped > 0 ? '，超出 ' + r.skipped + ' 条未注入' : '') + '）· ';
    } catch (e) { return ''; }
  },

  // 本轮注入量估算（记忆页提示行）：显示**这本书当前实际会注入多少**（正文 + 世界书 + 回读），
  // 而不是只报上限——上限（窗口/触发线）是理论值，写之前先看到"实际才多少"才不会误判。
  renderCtxBudgetHint(): void {
    const el = document.getElementById('ctxBudgetHint');
    if (!el) return;
    try {
      const manual = App._storyWindowChars();
      let wbChars = 0;
      try {
        let entries: any[] = (WorldBookManager.getActive() || {}).entries || [];
        if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled && SettingSyncManager.isEnabled()) {
          entries = SettingSyncManager.getEffectiveEntries();
        }
        wbChars = selectInjectableEntries(entries, WB_INJECT_MAX_CHARS).chars;
      } catch (e) { /* 世界书不可读按 0 记 */ }
      // 自动窗口：和生成时同一套算法（含本书世界书字号）
      const ctxTokens = App._effectiveContextTokens();   // 已含"该端点学到的上限"（换小上下文渠道会自动收窄）
      const win = manual > 0 ? manual : windowFromContext({ contextTokens: ctxTokens, worldBookChars: wbChars });
      const trigger = storyWindowTrigger(win);
      // 这本书现在真的要发多少正文（= 全文 − 已归档；从没滚过就是全部）
      let bodyChars = 0, archived = 0;
      try {
        const canonLen = String(EditorManager.getFullNovelText(1000000) || '').length;
        archived = Number((SM().get<any>('wline_' + (WorldBookManager.getActiveId() || 'none'), {}) || {}).x) || 0;
        bodyChars = Math.max(0, canonLen - archived);
      } catch (e) { bodyChars = 0; archived = 0; }
      // 回读只在正文滚过归档后才注入
      const recall = archived > 0 ? (Number(SM().get<any>('archiveRecallBudget', 10000)) || 0) : 0;
      const total = bodyChars + wbChars + recall;
      const totalTokens = estimateTokens(total);
      const over = totalTokens > ctxTokens;
      // 端点实测上限比全局设置更小时说明一句（否则用户会奇怪"我填了 80 万，怎么窗口小了"）
      const _globalCtx = App._modelContextTokens();
      const capNote = ctxTokens < _globalCtx ? '（已按该端点实测上限收窄）' : '';
      el.textContent = '本轮注入 ≈ ' + wanChars(total) + ' 万字（' + wanChars(totalTokens) + ' 万 token / 可用 ' + wanChars(ctxTokens) + ' 万' + capNote + '）：' +
        '正文 ' + wanChars(bodyChars) + ' 万' + (manual > 0 ? '（手动）' : '（自动，最多 ' + wanChars(trigger) + ' 万）') +
        ' + 世界书 ' + wanChars(wbChars) + ' 万' + (recall > 0 ? ' + 回读 ' + wanChars(recall) + ' 万' : '') + '。' +
        (over ? '⚠️ 超出可用上下文，请调小窗口或调大上面的「模型可用上下文」。' : '');
      el.style.color = over ? 'var(--accent)' : '';
    } catch (e) { el.textContent = ''; }
  },

  renderWBEntries() {
    const wb = WorldBookManager.getActive();
    const container = document.getElementById('wbEntryList');
    const titleEl = document.getElementById('wbEntriesTitle');
    const descEl = document.getElementById('wbEntriesDesc');
    if (titleEl) titleEl.textContent = wb ? (wb.name || wb.title || '世界书') : '世界书';
    if (!wb || !wb.entries || wb.entries.length === 0) {
      container!.innerHTML = '<div class="empty-box"><div class="empty-tt">暂无条目</div><div class="empty-sub">点击上方「添加条目」创建第一个世界书条目</div></div>';
      if (descEl) descEl.textContent = '0 条 · ' + this._wbInjectStat();
      this._wbPage = 1;
      return;
    }
    if (descEl) descEl.textContent = wb.entries.length + ' 条 · ' + this._wbInjectStat() + '点右侧「查看」读全文，点整行展开操作';
    const query = (document.getElementById('wbSearch')!.value || '').trim().toLowerCase();
    // Reset to page 1 on new search
    if (query !== this._lastWbQuery) { this._wbPage = 1; this._lastWbQuery = query; }
    // 所见即所得：列表顺序 = 数组顺序 = 注入顺序
    const sorted = wb.entries.slice();
    const filtered = query ? sorted.filter(e => (e.name || '').toLowerCase().includes(query)) : sorted;
    document.getElementById('wbFilteredCount')!.textContent = query ? filtered.length + '/' + sorted.length + ' 条' : '';

    // Pagination
    const totalPages = Math.max(1, Math.ceil(filtered.length / this._wbPageSize));
    this._wbTotalPages = totalPages;
    if (this._wbPage > totalPages) this._wbPage = totalPages;
    const pageStart = (this._wbPage - 1) * this._wbPageSize;
    const pageEnd = pageStart + this._wbPageSize;
    const pageEntries = filtered.slice(pageStart, pageEnd);

    const cardHtml = pageEntries.map(e => {
      let h = '<div class="entry-card" data-drag-item="' + e.id + '" data-drag-id="' + e.id + '" data-drag-idx="' + wb.entries.indexOf(e) + '">';
      h += '<div class="ec-head" onclick="UIManager.toggleWBEntry(this)">';
      h += '<span class="drag-handle" title="拖动排序">≡</span>';
      h += '<span class="' + typeChip(e.type) + '">' + htmlEscape(e.type || '其他') + '</span>';
      h += '<span class="ec-name">' + htmlEscape(e.name || '未命名') + '</span>';
      h += '<label class="toggle mini" onclick="event.stopPropagation()" title="注入：开启则续写时注入此条设定"><input type="checkbox" ' + (e.inject !== false ? 'checked' : '') + ' onchange="WorldBookManager.toggleEntryInject(\x27' + e.id + '\x27,this.checked)"><span class="slider"></span></label>';
      // 右侧「查看」：一点直接看全文（只读、内容区可滑动）。原来这里是展开箭头 ▶，
      // 想读全文得先展开再点「编辑」，两步且进了编辑态（用户反馈：太麻烦）。
      // 展开/收起仍点整行（含箭头位置以外的区域），展开状态由下方出现的操作行体现。
      h += '<button class="ec-view" onclick="event.stopPropagation();UIManager.viewWBEntry(\x27' + e.id + '\x27)" title="查看完整内容">查看</button>';
      h += '</div>';
      h += '<div class="ec-preview">' + htmlEscape(e.content || '').slice(0, 90) + ((e.content || '').length > 90 ? '…' : '') + '</div>';
      h += '<div class="ec-body">';
      if (e.type === '角色') {
        h += '<div class="ec-avatar-row">' +
          (e.avatar
            ? '<img class="wb-avatar" src="' + htmlEscape(avatarUrl(e.avatar) || '') + '" onclick="UIManager.viewAvatar(this.src)" alt="">'
            : '<span class="wb-avatar-empty">👤</span>') +
          '<button class="ghost-btn" onclick="UIManager.pickAvatar(\'wb\',\'' + e.id + '\')">换头像</button></div>';
      }
      h += '<div class="ec-actions">';
      h += '<button class="ghost-btn" onclick="UIManager.moveWBEntry(\x27' + e.id + '\x27,-1)" title="上移">↑</button>';
      h += '<button class="ghost-btn" onclick="UIManager.moveWBEntry(\x27' + e.id + '\x27,1)" title="下移">↓</button>';
      h += '<button class="ghost-btn" onclick="UIManager.showWBEntryModal(\x27' + e.id + '\x27)">✎ 编辑</button>';
      h += '<button class="ghost-btn danger" onclick="UIManager.deleteWBEntry(\x27' + e.id + '\x27)">删除</button>';
      h += '</div></div></div>';
      return h;
    }).join('');

    // Pagination controls
    let pagHtml = '';
    if (totalPages > 1) {
      pagHtml = '<div class="pg-pager">' +
        '<button onclick="UIManager._wbPage=1;UIManager.renderWBEntries()" ' + (this._wbPage <= 1 ? 'disabled' : '') + '>«</button>' +
        '<button onclick="UIManager._wbPage=Math.max(1,UIManager._wbPage-1);UIManager.renderWBEntries()" ' + (this._wbPage <= 1 ? 'disabled' : '') + '>‹</button>' +
        '<span class="pg-info">' + this._wbPage + ' / ' + totalPages + '</span>' +
        '<button onclick="UIManager._wbPage=Math.min(' + totalPages + ',UIManager._wbPage+1);UIManager.renderWBEntries()" ' + (this._wbPage >= totalPages ? 'disabled' : '') + '>›</button>' +
        '<button onclick="UIManager._wbPage=' + totalPages + ';UIManager.renderWBEntries()" ' + (this._wbPage >= totalPages ? 'disabled' : '') + '>»</button>' +
      '</div>';
    }

    container!.innerHTML = cardHtml + pagHtml;
    this._bindSortable(container, {
      itemSelector: '.entry-card',
      pageable: true,
      edgeZone: 40,
      pageHoldMs: 1000,
      holdMs: 250,
      getId: function (r: any) { return r.getAttribute('data-drag-id'); },
      getIdx: function (r: any) { return parseInt(r.getAttribute('data-drag-idx'), 10); },
      onPage: function (dir: any) {
        UIManager._wbPage = Math.max(1, Math.min(UIManager._wbPage + dir, UIManager._wbTotalPages || 1));
        UIManager.renderWBEntries();
      },
      onReorder: function (fromId: any, fromIdx: any, toIdx: any, after: any) {
        // 必须用 getAll() 里的同一对象：getAll()/getActive() 每次都重新反序列化，
        // 若用 getActive()，splice 修改的对象 ≠ saveAll(all) 保存的对象，排序永不生效
        const all = WorldBookManager.getAll();
        const wb = all.find(function (w) { return w.id === WorldBookManager.getActiveId(); });
        if (!wb || !wb.entries) return;
        const entries = wb.entries;
        const cur = entries.findIndex(function (x) { return x.id === fromId; });
        if (cur < 0) return;
        const item = entries.splice(cur, 1)[0];
        let ins = toIdx;
        if (cur < ins) ins--;
        if (after) ins++;
        ins = Math.max(0, Math.min(entries.length, ins));
        entries.splice(ins, 0, item);
        WorldBookManager.saveAll(all);
        UIManager.renderWBEntries();
      }
    });
  },

  // 上/下按钮交换排序（可靠替代拖拽，触屏不依赖手势）
  moveWBEntry(entryId: any, dir: any) {
    const all = WorldBookManager.getAll();
    const wb = all.find(function (w) { return w.id === WorldBookManager.getActiveId(); });
    if (!wb || !wb.entries) return;
    const entries = wb.entries;
    const idx = entries.findIndex(function (e) { return e.id === entryId; });
    if (idx < 0) return;
    const to = idx + dir;
    if (to < 0 || to >= entries.length) { App.toast(dir < 0 ? '已到最前' : '已到最后'); return; }
    const item = entries.splice(idx, 1)[0];
    entries.splice(to, 0, item);
    WorldBookManager.saveAll(all);
    UIManager.renderWBEntries();
  },

  toggleWBEntry(el: any) {
    const card = el.closest('.entry-card');
    if (!card) return;
    card.classList.toggle('open');
  },

  // 条目全文查看（只读）：点卡片右侧「查看」直接打开，长条目在内容区里滑动阅读。
  // 不进编辑态（避免误改），想改再点弹窗里的「编辑」——那条路会带着当前条目打开编辑弹窗。
  viewWBEntry(entryId: any) {
    const wb = WorldBookManager.getActive();
    const id = String(entryId || '');
    const entry = wb && wb.entries ? wb.entries.find(function (x: any) { return x.id === id; }) : null;
    if (!entry) { App.toast('条目不存在'); return; }
    const content = String(entry.content || '');
    const titleEl = document.getElementById('wbViewTitle');
    if (titleEl) titleEl.textContent = entry.name || '未命名';
    const metaEl = document.getElementById('wbViewMeta');
    if (metaEl) {
      metaEl.textContent = (entry.type || '其他') + ' · ' + content.length + ' 字'
        + ' · 注入' + (entry.inject !== false ? '开' : '关');
    }
    const bodyEl = document.getElementById('wbViewContent');
    if (bodyEl) {
      // 空内容也给个明确提示（而不是一片空白）
      if (content.trim()) bodyEl.innerHTML = htmlEscape(content).replace(/\n/g, '<br>');
      else bodyEl.innerHTML = '<span style="color:var(--text-muted)">（此条目还没有内容）</span>';
      bodyEl.scrollTop = 0;   // 每次打开都从头开始，别沿用上一条的滚动位置
    }
    this._wbViewEntryId = id;
    UIManager.showModal!('modalWBEntryView');
  },

  /** 从「查看」弹窗切到编辑：带上当前条目打开编辑弹窗（避免用户手动再去点一次） */
  editFromWBView() {
    const id = String(this._wbViewEntryId || '');
    this.closeModal!('modalWBEntryView');
    if (id) this.showWBEntryModal!(id);
  },

  showWBBookModal(editId: any) {
    document.getElementById('wbBookEditId')!.value = '';
    document.getElementById('wbBookName')!.value = '';
    document.getElementById('modalWBBookTitle')!.textContent = '新建世界书';
    if (editId) {
      const wb = WorldBookManager.getAll().find(w => w.id === editId);
      if (wb) {
        document.getElementById('wbBookEditId')!.value = wb.id;
        document.getElementById('wbBookName')!.value = wb.name;
        document.getElementById('modalWBBookTitle')!.textContent = '重命名世界书';
      }
    }
    this.showModal('modalWBBook');
  },

  saveWBBookFromModal() {
    const name = document.getElementById('wbBookName')!.value.trim();
    if (!name) { App.toast('请输入世界书名称'); return; }
    const editId = document.getElementById('wbBookEditId')!.value;
    let newBook: any = null;
    if (editId) { WorldBookManager.renameBook(editId, name); }
    else { newBook = WorldBookManager.createBook(name); }
    this.closeModal('modalWBBook');
    this.renderWorldBooks();
    App.toast(editId ? '世界书已重命名' : '世界书已创建');
    // 新建后顺势选封面（取消则使用默认渐变+首字封面）
    if (newBook && newBook.id) {
      App.toast('可为新书选择一张封面（取消使用默认）');
      this.pickBookCover(newBook.id);
    }
  },

  showWBEntryModal(editEntryId: any) {
    const wbEntryEditId = document.getElementById('wbEntryEditId');
    const wbEntryType = document.getElementById('wbEntryType');
    const wbEntryName = document.getElementById('wbEntryName');
    const wbEntryContent = document.getElementById('wbEntryContent');
    const wbEntryInject = document.getElementById('wbEntryInject');
    const modalTitle = document.getElementById('modalWBEntryTitle');

    if (wbEntryEditId) wbEntryEditId.value = '';
    if (wbEntryType) wbEntryType.value = '世界观';
    if (wbEntryName) wbEntryName.value = '';
    if (wbEntryContent) wbEntryContent.value = '';
    if (wbEntryInject) wbEntryInject.checked = true;
    if (modalTitle) modalTitle.textContent = '添加条目';
    if (editEntryId) {
      const wb = WorldBookManager.getActive();
      if (wb) {
        const entry = wb.entries.find(e => e.id === editEntryId);
        if (entry) {
          if (wbEntryEditId) wbEntryEditId.value = entry.id;
          if (wbEntryType) wbEntryType.value = entry.type || '世界观';
          if (wbEntryName) wbEntryName.value = entry.name || '';
          if (wbEntryContent) wbEntryContent.value = entry.content || '';
          if (wbEntryInject) wbEntryInject.checked = entry.inject !== false;
          if (modalTitle) modalTitle.textContent = '编辑条目';
        }
      }
    }
    this.toggleWBEntryFields();
    this.showModal('modalWBEntry');
  },

  saveWBEntryFromModal() {
    const wb = WorldBookManager.getActive();
    if (!wb) { App.toast('请先选择一个世界书'); return; }
    const data = {
      type: document.getElementById('wbEntryType')!.value,
      name: document.getElementById('wbEntryName')!.value.trim(),
      content: document.getElementById('wbEntryContent')!.value.trim(),
      inject: document.getElementById('wbEntryInject')!.checked
    };
    if (!data.name) { App.toast('请输入条目名称'); return; }
    // 变量条目：名称会被当作回报格式里的键（模型按「名称：值」写），带冒号/换行会把格式打乱
    if (data.type === '变量' && /[:：\n\r]/.test(data.name)) { App.toast('变量名里不能有冒号或换行（模型按「名称：值」回报）'); return; }
    const editId = document.getElementById('wbEntryEditId')!.value;
    if (editId) { WorldBookManager.updateEntry(wb.id, editId, data); }
    else { WorldBookManager.addEntry(wb.id, data); }
    this.closeModal('modalWBEntry');
    this.renderWBEntries();
    // 刷新书架与工具栏切换列表的条目计数
    this.renderWbShelf();
    this.renderWBSwitch();
    App.toast(editId ? '条目已更新' : '条目已添加');
  },

  // 类型下拉＝世界观/角色/初始/其他/变量（'前端' 已随类型精简迁移消失），字段区始终显示；
  // 类型为「变量」时多显示一段说明（一个条目 = 一个变量：名称=变量名、内容=讲解、注入开关=启用）。
  // 保留这个钩子是因为 select 的 onchange 还在调它。
  toggleWBEntryFields() {
    const el = document.getElementById('wbEntryFields');
    if (el) el.style.display = '';
    const hint = document.getElementById('wbEntryVarHint');
    if (hint) {
      let type = '';
      try { type = String((document.getElementById('wbEntryType') as any)?.value || ''); } catch (e) { type = ''; }
      hint.style.display = type === '变量' ? '' : 'none';
    }
  },

  deleteWBEntry(entryId: any) {
    const wb = WorldBookManager.getActive();
    if (!wb) return;
    const entry = wb.entries.find(e => e.id === entryId);
    this.showConfirm('确定删除条目"' + (entry ? entry.name : '') + '"？', () => {
      WorldBookManager.deleteEntry(wb.id, entryId);
      this.renderWBEntries();
      this.renderWbShelf();
      this.renderWBSwitch();
      App.toast('条目已删除');
    });
  },

  // ===== 头像（世界书角色条目 & 数据库角色档案）=====
  _avatarTarget: null,

  // 触发文件选择：type='wb'（世界书条目）或 'db'（数据库角色档案）
  pickAvatar(type: any, id: any) {
    this._avatarTarget = { type: type, id: id };
    var input = document.getElementById('avatarFileInput');
    input!.value = '';
    input!.click();
  },

  // 临时世界书里**新增**的条目不在原书里，头像只能写进 overlay 的 added（原书那条路找不到它）。
  // 属于临时设定：重置临时设定 / 回滚后头像一起消失（用户确认过这个取舍）。
  // 读写都在 chat 模式下进行——小说的生成会把模式设成 novel，不切就会写到小说那份 overlay 上。
  _saveTempAvatar(entryId: any, dataUrl: any): boolean {
    try {
      if (typeof SettingSyncManager === 'undefined' || typeof SettingSyncManager.setTempAvatar !== 'function') return false;
      var id = String(entryId || '');
      var ok = (typeof SettingSyncManager.withMode === 'function')
        ? SettingSyncManager.withMode('chat', function () { return SettingSyncManager.setTempAvatar(id, dataUrl); })
        : SettingSyncManager.setTempAvatar(id, dataUrl);
      if (!ok) return false;
      try { this.renderAgentPage(); } catch (e) { /* 比奇页没开也不影响 */ }
      try { this.renderWBEntries(); } catch (e) { /* ignore */ }
      return true;
    } catch (e) { return false; }
  },

  onAvatarPicked(input: any) {
    var file = input.files && input.files[0];
    var target = this._avatarTarget;
    if (!file || !target) return;
    if (!file.type.startsWith('image/')) { App.toast('请选择图片文件'); return; }
    var self = this;
    // 头像写进世界书条目后，对话模式的气泡与角色简介要立刻重画——以前只刷新世界书那页，
    // 用户得切到别的视图再回来才看得到新头像（气泡头像是渲染时按角色名现查条目的）。
    var refreshChat = function () {
      try { if (typeof ChatMode !== 'undefined' && ChatMode.refreshAvatars) { ChatMode.refreshAvatars(); } } catch (e) { /* 对话模式没开也不影响 */ }
    };
    this._compressImage(file, 512, function (dataUrl: any) {
      if (target.type === 'wb') {
        var all = WorldBookManager.getAll();
        var wb = WorldBookManager.getActive();
        var entry = (wb && wb.entries) ? wb.entries.find(function (e: any) { return e.id === target.id; }) : null;
        if (entry) {
          entry.avatar = dataUrl;
          WorldBookManager.saveAll(all);
          self.renderWBEntries();
          App.toast('头像已更新');
          refreshChat();
        } else if (self._saveTempAvatar(target.id, dataUrl)) {
          // 临时新增条目（比奇/对话模式登记的角色）：头像写进 overlay，属于临时设定
          App.toast('头像已更新（临时角色：重置临时设定后会消失）');
          refreshChat();
        } else {
          // 以前这里什么都不做（用户点了换头像毫无反应）——现在至少说清为什么
          App.toast('找不到这个条目（可能已被重置或已写入原书）');
        }
      } else {
        // 数据库角色档案：头像写回世界书同名字条条目（若存在），否则存到角色档案记录自身
        var tableId = DatabaseManager.getActiveTableId();
        var rec = (DatabaseManager as any).getRecords(tableId).find(function (r: any) { return r.id === target.id; });
        if (rec) {
          var pk = DatabaseManager._primaryColumn(DatabaseManager.getTable(tableId)!);
          var name = rec.values[pk];
          var wb = WorldBookManager.getActive();
          var matched = wb && wb.entries ? wb.entries.find(function (e) { return e.type === '角色' && e.name === name; }) : null;
          if (matched) {
            var all = WorldBookManager.getAll();
            matched.avatar = dataUrl;
            WorldBookManager.saveAll(all);
            App.toast('已更新世界书角色头像');
            refreshChat();
          } else {
            rec.values['__avatar'] = dataUrl;
            DatabaseManager.saveDB(DatabaseManager.getDB());
            App.toast('已保存该角色头像');
          }
          self.renderDBRecords();
        }
      }
    });
  },

  _compressImage(file: any, maxSize: any, cb: any) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var img = new Image();
      img.onload = function () {
        var scale = maxSize / Math.max(img.width, img.height);
        if (scale >= 1) { cb((e!.target as any).result); return; }
        var canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas!.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
        // 高清：512px 源 + JPEG 0.92，放大查看也清晰；列表小图不受影响
        cb(canvas.toDataURL('image/jpeg', 0.92));
      };
      img.onerror = function () { App.toast('图片加载失败'); };
      img.src = String((e!.target as any).result);
    };
    reader.readAsDataURL(file);
  },

  viewAvatar(src: any) {
    var viewer = document.getElementById('imgViewer');
    document.getElementById('imgViewerImg')!.src = src;
    viewer!.style.display = 'flex';
  },

  // 数据库角色档案取头像：优先世界书同名字角色条目的头像，其次记录自带 __avatar
  _dbAvatarFor(record: any, tableId: any) {
    const table = DatabaseManager.getTable(tableId);
    if (!table) return null;
    var pk = DatabaseManager._primaryColumn(table);
    var name = record.values[pk];
    var wb = WorldBookManager.getActive();
    if (wb && wb.entries) {
      var matched = wb.entries.find(function (e) { return e.type === '角色' && e.name === name; });
      if (matched && matched.avatar) return matched.avatar;
    }
    if (record.values['__avatar']) return record.values['__avatar'];
    return null;
  },

  // ===== 插件区 & 数据库全屏页 =====
  renderPlugins() {
    var container = document.getElementById('pluginList');
    if (!container) return;
    var all: any[] = (typeof PluginManager !== 'undefined') ? PluginManager.getAll() : [];
    if (!all || all.length === 0) { container.innerHTML = ''; return; }
    var html = '';
    all.forEach(function (p: any) {
      var enabled = PluginManager.isEnabled(p.id);
      var danger = 'var(--danger)';
      var canOpen = p.type === 'database' || (p.type === 'widget' && p.shell === 'biqi');
      html += '<section class="set-group" style="margin-bottom:6px;">' +
        '<div class="set-row" ' + (canOpen ? 'onclick="UIManager.openPlugin(\'' + p.id + '\')"' : '') + ' style="cursor:' + (canOpen ? 'pointer' : 'default') + ';">' +
          '<div class="set-main">' +
            '<div class="set-title">' + p.name + (p.builtin ? ' <span style="font-size:10px;color:var(--text-muted);border:1px solid var(--border);border-radius:4px;padding:0 4px;vertical-align:1px;">内置</span>' : '') + '</div>' +
            '<div class="set-sub">' + (p.description || '') + '</div>' +
          '</div>' +
          '<label class="toggle" onclick="event.stopPropagation()" title="开启后生效">' +
            '<input type="checkbox" ' + (enabled ? 'checked' : '') + ' onchange="UIManager.togglePlugin(\'' + p.id + '\',this.checked)"><span class="slider"></span>' +
          '</label>' +
          (p.builtin ? '' : '<button class="ghost-btn" onclick="event.stopPropagation();UIManager.deletePlugin(\'' + p.id + '\')" style="color:' + danger + ';padding:6px 10px;">删除</button>') +
        '</div>' +
      '</section>';
    });
    container.innerHTML = html;
  },

  togglePlugin(id: string, checked: boolean) {
    if (typeof PluginManager === 'undefined') return;
    var bumped = PluginManager.setEnabled(id, !!checked);
    var p = PluginManager.get(id);
    App.toast((checked ? '已开启' : '已关闭') + '：' + ((p && p.name) || id) + (bumped ? '（已自动关闭「' + bumped + '」：两者维护同一份临时世界书）' : ''));
    this.renderPlugins();
    if (typeof BiqiAgent !== 'undefined' && BiqiAgent.render) BiqiAgent.render();
  },

  deletePlugin(id: string) {
    if (typeof PluginManager === 'undefined') return;
    var p = PluginManager.get(id);
    UIManager.showConfirm('删除插件「' + ((p && p.name) || id) + '」？已写入的数据库数据保留，但该模板将不再生效。', function () {
      PluginManager.uninstall(id);
      App.toast('已删除插件');
      UIManager.renderPlugins();
      if (typeof BiqiAgent !== 'undefined' && BiqiAgent.render) BiqiAgent.render();
    });
  },

  // 打开插件（database 类型 → 全屏页；widget+biqi → 写作页的比奇面板）
  openPlugin(id: string) {
    if (typeof PluginManager === 'undefined') return;
    var p = PluginManager.get(id);
    if (!p) return;
    if (p.type === 'widget' && p.shell === 'biqi') {
      if (!PluginManager.isEnabled(id)) { App.toast('请先开启插件「' + p.name + '」'); return; }
      if (typeof MobileUI !== 'undefined' && MobileUI.switchView) MobileUI.switchView('writing');
      if (typeof BiqiAgent !== 'undefined' && BiqiAgent.toggle) { if ((BiqiAgent as any)._open) BiqiAgent.render(); else BiqiAgent.toggle(); }
      return;
    }
    if (p.type !== 'database') { App.toast('该插件暂无可打开的页面'); return; }
    if (!PluginManager.isEnabled(id)) { App.toast('请先开启插件「' + p.name + '」'); return; }
    this.openDatabase();
  },

  openDatabase() {
    // 数据库页默认跟着**当前视图**：从对话模式进来就看对话那一份（同一本书两个模式各存一份表）
    var chatActive = false;
    try { var tab = document.getElementById('tab-chat'); chatActive = !!(tab && tab.classList.contains('active')); } catch (e) { /* ignore */ }
    this._dbViewMode = chatActive ? 'chat' : 'novel';
    try { DatabaseManager.setMode(this._dbViewMode); } catch (e) { /* ignore */ }
    document.getElementById('pluginFullscreen')!.style.display = 'flex';
    this._dbSettingsOpen = false;
    this.renderDatabase();
  },

  // 数据库页当前看的是哪个模式（小说 / 对话）。页面里所有读写都先把这个作用域声明一遍——
  // 后台填表（另一种模式）也会改 DatabaseManager 的作用域，不重申就可能看串/写串。
  _dbViewMode: 'novel' as 'novel' | 'chat',

  switchDBMode(m: any) {
    this._dbViewMode = (m === 'chat') ? 'chat' : 'novel';
    try { DatabaseManager.setMode(this._dbViewMode); } catch (e) { /* ignore */ }
    document.getElementById('dbSearch')!.value = '';
    this.renderDatabase();
    App.toast(this._dbViewMode === 'chat' ? '这是对话模式的记忆表' : '这是小说模式的记忆表');
  },

  closeDatabase() {
    document.getElementById('pluginFullscreen')!.style.display = 'none';
  },

  // ===== 临时世界书页（比奇的 widget 页：临时设定 + 重置/回滚；原「Agent 设定同步」的入口已下线） =====
  openAgentPage() {
    document.getElementById('agentFullscreen')!.style.display = 'flex';
    this.renderAgentPage();
  },

  closeAgentPage() {
    document.getElementById('agentFullscreen')!.style.display = 'none';
  },

  refreshAgentBadge() {
    var badge = document.getElementById('agentCountBadge');
    if (!badge) return;
    try {
      if (typeof SettingSyncManager === 'undefined') { badge.textContent = ''; return; }
      var n = SettingSyncManager.overlayCount();
      badge.textContent = n > 0 ? String(n) : '';
    } catch (e) { /* ignore */ }
  },

  // Agent 页全文查看：正文预览默认折叠（截断 + max-height），点「展开全文」显示完整内容。
  // 注意：存储层不是截断原因（单条 content 上限 4000 字），此前看不到全文只是 UI 预览截断。
  _agentFullText: {} as Record<string, string>,
  toggleAgentBody(id: string): void {
    var el = document.getElementById('agentBody_' + id);
    if (!el) return;
    var btn = document.getElementById('agentBodyBtn_' + id);
    var expanded = el.getAttribute('data-expanded') === '1';
    if (expanded) {
      el.setAttribute('data-expanded', '0');
      el.style.maxHeight = '72px';
      el.style.overflow = 'hidden';
      el.textContent = el.getAttribute('data-preview') || '';
      if (btn) btn.textContent = '展开全文';
    } else {
      el.setAttribute('data-expanded', '1');
      el.style.maxHeight = 'none';
      el.style.overflow = 'visible';
      var full = (this as any)._agentFullText[id];
      if (typeof full !== 'string') full = el.getAttribute('data-preview') || '';
      el.textContent = full;
      if (btn) btn.textContent = '收起';
    }
  },

  // 生成「预览 + 展开」正文块；过长时附展开按钮与总字数
  _agentBodyHtml(id: string, content: any, previewLen: number): string {
    var text = String(content || '');
    var needToggle = text.length > previewLen;
    if (needToggle) (this as any)._agentFullText[id] = text;
    var preview = needToggle ? text.slice(0, previewLen) + '…' : text;
    var html = '<div id="agentBody_' + id + '" data-expanded="0" data-preview="' +
      htmlEscape(preview).replace(/"/g, '&quot;') + '" style="font-size:12px;color:var(--text-muted);margin-top:4px;white-space:pre-wrap;word-break:break-word;max-height:72px;overflow:hidden;">' +
      htmlEscape(preview) + '</div>';
    if (needToggle) {
      html += '<div style="display:flex;align-items:center;gap:8px;margin-top:2px;">' +
        '<button id="agentBodyBtn_' + id + '" class="ghost-btn" style="padding:2px 8px;font-size:11px;" onclick="UIManager.toggleAgentBody(\'' + id + '\')">展开全文</button>' +
        '<span style="font-size:10px;color:var(--text-muted);">共 ' + text.length + ' 字</span>' +
        '</div>';
    }
    return html;
  },

  renderAgentPage() {
    var listEl = document.getElementById('agentOverlayList');
    var statusEl = document.getElementById('agentPageStatus');
    if (!listEl || typeof SettingSyncManager === 'undefined') return;
    var self = this;
    // 「立即结算」「待裁决提议」两块随 Agent 设定同步插件一起下线（比奇是即时落盘，没有攒批待裁决；
    // 历史遗留的待裁决由 App 启动清理扫掉，见 SettingSyncManager.cleanupLegacyPending）
    try {
      var eff = SettingSyncManager.getEffectiveEntries();
      (this as any)._agentFullText = {};
      this.refreshAgentBadge();
      if (statusEl) {
        var snaps = SettingSyncManager.getSnapshots();
        statusEl.textContent = '临时变更 ' + SettingSyncManager.overlayCount() + ' 处 · 快照 ' + snaps.length + ' 个';
      }
      // --- 已生效临时设定 ---
      if (eff.length === 0) {
        listEl.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-muted);font-size:13px;">暂无设定条目（原书为空且无临时新增）</div>';
      } else {
        var html = '';
        eff.forEach(function (e: any) {
          var st = SettingSyncManager.entryStatus(e.id);
          var badge = st === 'added'
            ? '<span style="font-size:10px;color:#fff;background:#7c3aed;border-radius:4px;padding:1px 6px;">临时新增</span>'
            : st === 'modified'
              ? '<span style="font-size:10px;color:#fff;background:#d97706;border-radius:4px;padding:1px 6px;">临时修改</span>'
              : '';
          html += '<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:6px;">' +
            '<div style="display:flex;align-items:center;gap:6px;">' +
              '<span style="font-size:11px;color:var(--text-muted);">[' + htmlEscape(e.type || '其他') + ']</span>' +
              '<span style="font-weight:700;font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + htmlEscape(e.name || '（未命名）') + '</span>' + badge +
              ((e.type === '角色') ? (e.avatar
                ? '<img class="wb-avatar" src="' + htmlEscape(avatarUrl(e.avatar) || '') + '" onclick="UIManager.viewAvatar(this.src)" alt="">'
                : '<span class="wb-avatar-empty">👤</span>') +
                '<button class="ghost-btn" style="padding:4px 8px;" onclick="UIManager.pickAvatar(\'wb\',\'' + e.id + '\')">换头像</button>' : '') +
              '<button class="ghost-btn" style="padding:4px 8px;" onclick="UIManager.editAgentEntry(\'' + e.id + '\')">编辑</button>' +
            '</div>' +
            self._agentBodyHtml(e.id, e.content, 160) +
          '</div>';
        });
        listEl.innerHTML = html;
      }
    } catch (e) { console.warn('[Agent] render failed:', e); }
  },

  // ===== 变量页（世界书「变量」条目：一个条目 = 一个变量，模型每轮在正文之后回报）=====
  // 只读：值由模型维护，用户能改的只有「条目」（名称＝变量名、内容＝讲解、注入开关＝启用/停用）。
  _varViewMode: 'novel' as 'novel' | 'chat',

  openVariablesPage() {
    // 默认跟着**当前视图**：从对话模式进来就看对话那一份（与数据库页同规则）
    var chatActive = false;
    try { var tab = document.getElementById('tab-chat'); chatActive = !!(tab && tab.classList.contains('active')); } catch (e) { /* ignore */ }
    this._varViewMode = chatActive ? 'chat' : 'novel';
    // 全屏页互斥：同时开两个会叠在一起（返回键会关错页）
    try { var pfs = document.getElementById('pluginFullscreen'); if (pfs) pfs.style.display = 'none'; } catch (e) { /* ignore */ }
    try { var ags = document.getElementById('agentFullscreen'); if (ags) ags.style.display = 'none'; } catch (e) { /* ignore */ }
    document.getElementById('variablesFullscreen')!.style.display = 'flex';
    this.renderVariablesPage();
  },

  closeVariablesPage() {
    document.getElementById('variablesFullscreen')!.style.display = 'none';
  },

  /** 输入栏上侧那个人字旁的角标：本模式的变量条数（0 不显示）。两条输入栏各一份，一起刷。 */
  refreshVarBadge() {
    try {
      var nv = StatusVars.count('novel');
      var ch = StatusVars.count('chat');
      var a = document.getElementById('varCount'); if (a) a.textContent = nv > 0 ? String(nv) : '';
      var b = document.getElementById('chatVarCount'); if (b) b.textContent = ch > 0 ? String(ch) : '';
      var t = document.getElementById('varToggleBtn');
      if (t) t.title = nv > 0 ? ('查看当前变量（' + nv + ' 个，小说模式）') : '查看当前变量（在世界书里新建「变量」条目即可启用）';
      var t2 = document.getElementById('chatVarToggleBtn');
      if (t2) t2.title = ch > 0 ? ('查看当前变量（' + ch + ' 个，对话模式）') : '查看当前变量（在世界书里新建「变量」条目即可启用）';
    } catch (e) { /* ignore */ }
  },

  /**
   * 变量页（**纯查看**：只有「从哪打开就是哪个模式」的列表，没有切换/复制/清空/编辑入口）。
   * 值由模型每轮维护；撤回续写/演出会回退、重置本书会清空（不在这里给按钮）。
   */
  renderVariablesPage() {
    var listEl = document.getElementById('variablesList');
    var countEl = document.getElementById('varPageCount');
    var statusEl = document.getElementById('varPageStatus');
    if (!listEl) return;
    var mode: any = this._varViewMode;
    try {
      var entries = StatusVars.entries(mode);
      var vals = StatusVars.values(mode);
      var snap = StatusVars.snap(mode);
      var label = mode === 'chat' ? '对话' : '小说';
      // 面板必须写清"看的是哪本书"：用户反馈过"我启用了变量却说什么都没有"——很可能是在另一本书里
      var bookName = '';
      try {
        var wbNow = WorldBookManager.getActive();
        bookName = String((wbNow && (wbNow.name || wbNow.title)) || '');
      } catch (e) { bookName = ''; }
      var where = (bookName ? '《' + bookName + '》 · ' : '') + label + '模式';
      if (countEl) countEl.textContent = entries.length > 0 ? (entries.length + ' 个 · ' + label) : '';
      if (statusEl) {
        statusEl.textContent = entries.length === 0
          ? (where + '：还没有启用中的「变量」条目')
          : (snap.at ? (where + ' · 最后更新：' + fmtVarTime(snap.at)) : (where + '：还没有收到回报（下一轮生成之后出现）'));
      }
      if (entries.length === 0) {
        // 自查信息（差在哪 / 这本书现在有什么）**只在管理员模式**显示：普通用户要的是干净界面，
        // 这些是排查用的（2026-09-26 用户要求：以后这类检查只在管理员模式搞）。
        var diagOn = false;
        try { diagOn = typeof AdminMode !== 'undefined' && AdminMode.isOn(); } catch (e) { diagOn = false; }
        var diagHtml = '';
        if (diagOn) {
          var near: any[] = [];
          try { near = StatusVars.nearMisses(mode); } catch (e) { near = []; }
          if (near.length > 0) {
            diagHtml += '<div style="margin:10px 0 0;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);">' +
              '<div style="font-size:12px;font-weight:700;margin-bottom:4px;">这些条目差在哪（管理员视图）：</div>' +
              near.map(function (x: any) {
                return '<div style="font-size:12px;color:var(--text-secondary);line-height:1.8;">· ' +
                  htmlEscape(x.name) + ' —— ' + htmlEscape(x.reason) + '</div>';
              }).join('') +
              '</div>';
          }
          try {
            var inv = StatusVars.inventory();
            var types = inv.byType.map(function (t: any) {
              return '<span style="' + (t.type === '变量' ? 'color:var(--primary);font-weight:700;' : '') + '">' + htmlEscape(t.type) + ' ' + t.n + '</span>';
            }).join(' · ');
            diagHtml += '<div style="margin:10px 0 0;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-secondary);">' +
              '<div style="font-size:12px;font-weight:700;margin-bottom:4px;">这本书现在有什么（管理员视图，共 ' + inv.total + ' 条）</div>' +
              '<div style="font-size:12px;color:var(--text-secondary);line-height:1.8;">' + (types || '（一条都没有）') + '</div>' +
              (inv.items.length > 0
                ? '<div style="font-size:11.5px;color:var(--text-muted);line-height:1.8;margin-top:3px;word-break:break-word;">' +
                  inv.items.slice(0, 20).map(function (x: any) {
                    return htmlEscape(x.name) + '〔' + htmlEscape(x.type) + (x.inject ? '' : '·注入关') + '〕';
                  }).join('、') + (inv.items.length > 20 ? ' …等 ' + inv.items.length + ' 条' : '') + '</div>'
                : '') +
              (inv.staleValues.length > 0
                ? '<div style="font-size:11.5px;color:var(--text-secondary);line-height:1.8;margin-top:3px;">存值里还有：' +
                  inv.staleValues.map(function (n: string) { return htmlEscape(n); }).join('、') +
                  '（这些名字已经没有对应条目了）</div>'
                : '') +
              '</div>';
          } catch (e) { /* 清单失败不影响空态文案 */ }
        }
        listEl.innerHTML =
          '<div style="padding:10px 4px;color:var(--text-muted);font-size:13px;line-height:1.95;">' +
          '这本书还没有启用中的<b>「变量」</b>条目（条目必须是<b>类型＝变量</b>才会生效）。<br>' +
          '在世界书里新建一条类型为「变量」的条目：<b>名称＝变量名</b>（如「任务数量」），<b>内容＝给模型的讲解</b>。' +
          '</div>' + diagHtml;
        return;
      }
      var html = '';
      entries.forEach(function (e: any) {
        var name = String(e.name || '').trim();
        var hit = vals[name];
        var v = (hit && hit.v) ? String(hit.v) : '';
        html += '<div class="var-item">' +
          '<div class="var-item-head"><span class="var-item-name">' + htmlEscape(name) + '</span>' +
          '<span class="var-item-val' + (v ? '' : ' empty') + '">' + (v ? htmlEscape(v) : '暂无（还没回报）') + '</span></div>' +
          (String(e.content || '').trim() ? '<div class="var-item-note">' + htmlEscape(String(e.content).trim()) + '</div>' : '') +
          '</div>';
      });
      listEl.innerHTML = html;
    } catch (e) {
      listEl.innerHTML = '<div style="padding:16px;color:var(--text-muted);font-size:13px;">变量页渲染失败</div>';
    }
  },

  /** Agent 页编辑：改未变更条 → overlay.modified；改临时条 → overlay 本体；原书零触碰 */
  editAgentEntry(entryId: any) {
    if (typeof SettingSyncManager === 'undefined') return;
    var overlay = SettingSyncManager.getOverlay();
    var added = overlay.added.find(function (e: any) { return e.id === entryId; });
    var wb = WorldBookManager.getActive();
    var orig = wb && wb.entries ? wb.entries.find(function (e: any) { return e.id === entryId; }) : null;
    const cur = added || (orig ? SettingSyncManager.getDisplayEntry(orig) : null);
    if (!cur) { App.toast('条目不存在'); return; }
    var self = this;
    // 复用世界书编辑弹窗做输入，保存时走 overlay 路由
    this.showWBEntryModal(null);
    setTimeout(function () {
      var typeEl = document.getElementById('wbEntryType') as any;
      var nameEl = document.getElementById('wbEntryName') as any;
      var contentEl = document.getElementById('wbEntryContent') as any;
      var injectEl = document.getElementById('wbEntryInject') as any;
      var titleEl = document.getElementById('modalWBEntryTitle');
      if (typeEl) typeEl.value = cur.type || '其他';
      if (nameEl) nameEl.value = cur.name || '';
      if (contentEl) contentEl.value = cur.content || '';
      if (injectEl) injectEl.checked = (cur as any).inject !== false;
      if (titleEl) titleEl.textContent = '编辑临时设定（不碰原书）';
      // 劫持一次保存：把 modal 的保存按钮临时指向 overlay 路由
      var footer = document.querySelector('#modalWBEntry .modal-footer .primary') as any;
      if (footer && !footer.dataset.agentHooked) {
        footer.dataset.agentHooked = '1';
        footer.setAttribute('onclick', 'UIManager.saveAgentEntryFromModal("' + entryId + '")');
      } else if (footer) {
        footer.setAttribute('onclick', 'UIManager.saveAgentEntryFromModal("' + entryId + '")');
      }
      (self as any)._agentEditId = entryId;
      (self as any)._agentIsAdded = !!added;
    }, 0);
  },

  saveAgentEntryFromModal(entryId: any) {
    if (typeof SettingSyncManager === 'undefined') return;
    var id = entryId || (this as any)._agentEditId;
    if (!id) { App.toast('条目不存在'); return; }
    var typeEl = document.getElementById('wbEntryType') as any;
    var nameEl = document.getElementById('wbEntryName') as any;
    var contentEl = document.getElementById('wbEntryContent') as any;
    var name = nameEl ? String(nameEl.value || '').trim() : '';
    var content = contentEl ? String(contentEl.value || '').trim() : '';
    var type = typeEl ? String(typeEl.value || '其他') : '其他';
    var injectEl = document.getElementById('wbEntryInject') as any;
    var inject = injectEl ? !!injectEl.checked : true;
    if (!name) { App.toast('请输入条目名称'); return; }
    var overlay = SettingSyncManager.getOverlay();
    var idx = overlay.added.findIndex(function (e: any) { return e.id === id; });
    if (idx >= 0) {
      // 临时新增条目：注入开关能改（对话模式登记的龙套默认不注入，想让它进提示词就在这里勾上）
      overlay.added[idx] = { ...overlay.added[idx], name, content, type, inject };
    } else {
      // 临时修改：overlay.modified 的结构只承载 name/content/type（注入状态仍由原书条目决定）
      overlay.modified[id] = { name, content, type };
      // 若该条曾被停用，编辑即视为重新启用
      var di = overlay.disabled.indexOf(id);
      if (di >= 0) overlay.disabled.splice(di, 1);
    }
    try { SettingSyncManager.saveOverlay(overlay); } catch (e) { /* ignore */ }
    // 恢复 modal 保存按钮指向原世界书保存
    var footer = document.querySelector('#modalWBEntry .modal-footer .primary') as any;
    if (footer) footer.setAttribute('onclick', 'UIManager.saveWBEntryFromModal()');
    this.closeModal('modalWBEntry');
    this.renderAgentPage();
    App.toast('临时设定已更新（原书未动）');
  },

  resetAgentOverlay() {
    var self = this;
    this.showConfirm('重置临时设定？将清空：临时修改/新增/停用 + 快照。原世界书不受影响。', function () {
      if (typeof SettingSyncManager === 'undefined') return;
      SettingSyncManager.resetAll();
      self.renderAgentPage();
      App.toast('临时设定已重置，原书未动');
    });
  },

  rollbackAgentOverlay() {
    if (typeof SettingSyncManager === 'undefined') return;
    if (SettingSyncManager.rollback()) {
      this.renderAgentPage();
      App.toast('已回滚到上一批');
    } else {
      App.toast('没有可回滚的快照');
    }
  },

  toggleDBSettings() {
    this._dbSettingsOpen = !this._dbSettingsOpen;
    var panel = document.getElementById('dbSettingsPanel');
    panel!.style.display = this._dbSettingsOpen ? 'block' : 'none';
    if (this._dbSettingsOpen) this._dbRenderSettings();
  },

  _dbRenderSettings() {
    var panel = document.getElementById('dbSettingsPanel');
    var settings = DatabaseManager.getSettings();
    var enabled = DatabaseManager.isEnabled();
    panel!.innerHTML =
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">开关在「插件」页；此处仅配置填表 API。</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">填表 API（留空 = 用主 API）</div>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
        '<select id="dbApiMode" style="flex:1;font-size:12px;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;" onchange="UIManager._dbApiModeChanged(this.value)">' +
          '<option value="main"' + (settings.mode !== 'custom' ? ' selected' : '') + '>用主 API</option>' +
          '<option value="custom"' + (settings.mode === 'custom' ? ' selected' : '') + '>独立配置</option>' +
        '</select>' +
      '</div>' +
      '<div id="dbApiCustom" style="display:' + (settings.mode === 'custom' ? 'block' : 'none') + ';">' +
        '<input type="text" id="dbApiEndpoint" placeholder="Endpoint（如 https://api.deepseek.com/v1）" value="' + htmlEscape(settings.endpoint || '') + '" style="width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;margin-bottom:5px;box-sizing:border-box;">' +
        '<input type="password" id="dbApiKey" placeholder="API Key" value="' + htmlEscape(settings.apiKey || '') + '" style="width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;margin-bottom:5px;box-sizing:border-box;">' +
        '<input type="text" id="dbApiModel" placeholder="模型名（如 deepseek-chat）" value="' + htmlEscape(settings.model || '') + '" style="width:100%;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;box-sizing:border-box;">' +
      '</div>' +
      '<div style="margin-top:8px;"><button class="small" onclick="UIManager._dbSaveSettings()">保存设置</button></div>';
  },

  _dbApiModeChanged(mode: any) {
    document.getElementById('dbApiCustom')!.style.display = mode === 'custom' ? 'block' : 'none';
  },

  _dbSaveSettings() {
    var mode = document.getElementById('dbApiMode')!.value;
    DatabaseManager.saveSettings({
      mode: mode,
      endpoint: document.getElementById('dbApiEndpoint')!.value.trim(),
      apiKey: document.getElementById('dbApiKey')!.value.trim(),
      model: document.getElementById('dbApiModel')!.value.trim()
    });
    App.toast('数据库设置已保存');
  },

  renderDatabase() {
    // 先申明这份页面看的是哪个模式（后台填表可能把作用域切到另一份）
    try { DatabaseManager.setMode(this._dbViewMode); } catch (e) { /* ignore */ }
    var book = BookManager.getActive();
    document.getElementById('dbBookName')!.textContent = book ? (book.title || '未命名') : '';
    var sw = document.getElementById('dbModeSwitch');
    if (sw) {
      var btns = sw.querySelectorAll('button');
      for (var bi = 0; bi < btns.length; bi++) {
        if (btns[bi].getAttribute('data-mode') === this._dbViewMode) btns[bi].classList.add('active');
        else btns[bi].classList.remove('active');
      }
    }
    document.getElementById('dbSearch')!.value = '';
    var activeTableId = DatabaseManager.getActiveTableId();
    // 顶部表名 chips（含各表记录数）
    var bar = document.getElementById('dbTableBar');
    if (bar) {
      bar.innerHTML = DatabaseManager.getTables().map(function (t) {
        var n = (DatabaseManager.getRecords(t.id) || []).length;
        return '<span class="db-chip' + (t.id === activeTableId ? ' active' : '') + '" onclick="UIManager.switchDBTable(\'' + t.id + '\')">' +
          (t as any).name + '<i class="db-chip-n">' + n + '</i></span>';
      }).join('');
    }
    var countEl = document.getElementById('dbRecordCount');
    if (countEl) {
      var total = 0;
      DatabaseManager.getTables().forEach(function (t) { total += (DatabaseManager.getRecords(t.id) || []).length; });
      countEl.textContent = total + ' 条';
    }
    var statusEl = document.getElementById('dbStatus');
    statusEl!.textContent = DatabaseManager.isEnabled() ? '填表已开启' : '填表已关闭';
    this.renderDBRecords();
  },

  switchDBTable(tableId: any) {
    DatabaseManager.setActiveTable(tableId);
    document.getElementById('dbSearch')!.value = '';
    this.renderDatabase();
  },

  renderDBRecords() {
    // 读之前重申作用域：这一页始终只看它自己那份（小说 / 对话各一份表）
    try { DatabaseManager.setMode(this._dbViewMode); } catch (e) { /* ignore */ }
    var container = document.getElementById('dbRecords');
    var tableId = DatabaseManager.getActiveTableId();
    const table = DatabaseManager.getTable(tableId);
    if (!table) { container!.innerHTML = ''; return; }
    var records = DatabaseManager.getRecords(tableId);
    var query = (document.getElementById('dbSearch')!.value || '').trim().toLowerCase();
    var pk = DatabaseManager._primaryColumn(table);
    if (table.id === 'plot_summary') DatabaseManager.ensurePlotRecord();
    records = DatabaseManager.getRecords(tableId);
    var filtered = query
      ? records!.filter(function (r) { return JSON.stringify(r.values).toLowerCase().includes(query); })
      : records;
    if (filtered!.length === 0) {
      container!.innerHTML = '<div class="db-empty">' + (query ? '没有匹配的记录' : '暂无记录，点"＋ 添加"或下方"回溯填表"') + '</div>';
      return;
    }
    var editId = this._dbEditId || null;
    container!.innerHTML = filtered!.map(function (r) {
      var pkVal = (r.values[pk] || '未命名') + '';
      var isEdit = editId === r.id;
      // 首字段预览（主键后第一个有值的非空字段，跳过"未提及"等占位词）
      var preview = '';
      var skipWords = ['未提及', '无', '未知', '不详', '暂无', 'n/a', 'N/A'];
      for (var ci = 1; ci < table.columns.length; ci++) {
        var cName = table.columns[ci].replace(/^[#*]/, '');
        var cv = r.values[cName];
        if (cv && String(cv).trim()) {
          var tv = String(cv).trim();
          var isPlaceholder = skipWords.some(function (w) { return tv === w || tv === w + '。' || tv === w + '；' || tv === w + '；'; });
          if (!isPlaceholder) { preview = tv.replace(/\n/g, ' '); break; }
        }
      }
      var avatarHtml = '';
      if (tableId === 'character_profile') {
        var avSrc = UIManager._dbAvatarFor(r, tableId);
        avatarHtml = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
          (avSrc
            ? '<img class="db-avatar" src="' + htmlEscape(avatarUrl(avSrc) || '') + '" onclick="UIManager.viewAvatar(this.src)" alt="">'
            : '<span class="db-avatar-empty">👤</span>') +
          '<button class="small" onclick="event.stopPropagation();UIManager.pickAvatar(\'db\',\'' + r.id + '\')">换头像</button>' +
        '</div>';
      }
      var fieldsHtml = '';
      if (isEdit) {
        table.columns.forEach(function (col: any) {
          var colName = col.replace(/^[#*]/, '');
          // 剧情摘要表的主键"主线摘要"也是内容字段，不能跳过（否则内容查看不了）
          if (colName === pk && table.id !== 'plot_summary') return;
          var v = r.values[colName] || '';
          var isAppend = col.charAt(0) === '#';
          var long = (v && String(v).length > 40) || isAppend;
          fieldsHtml += '<div style="margin:5px 0;"><span style="font-size:11px;color:var(--text-muted);">' + htmlEscape(colName) + (isAppend ? '（追加）' : '') + '</span><br>' +
            (long
              ? '<textarea id="dbEdit_' + colName + '" rows="3" style="width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;margin-top:2px;">' + htmlEscape(String(v)) + '</textarea>'
              : '<input type="text" id="dbEdit_' + colName + '" value="' + htmlEscape(String(v)) + '" style="width:100%;box-sizing:border-box;font-size:12px;padding:5px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:inherit;margin-top:2px;">') +
            '</div>';
        });
        fieldsHtml += '<div class="db-rr-actions">' +
          '<button class="small primary" onclick="event.stopPropagation();UIManager.saveDBRecordInline()">✓ 保存</button>' +
          '<button class="small" onclick="event.stopPropagation();UIManager.cancelDBRecordInline()">取消</button>' +
          '</div>';
      } else {
        if (table.id === 'plot_summary') {
          // 剧情摘要：时间线卡片展示（每行一条：[日期] 内容 → 日期chip + 内容）
          table.columns.forEach(function (col: any) {
            var colName = col.replace(/^[#*]/, '');
            var v = String(r.values[colName] || '').trim();
            var lines = v ? v.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
            fieldsHtml += '<div class="db-plot-sec">' + htmlEscape(colName) + '<i class="db-chip-n">' + lines.length + '</i></div>';
            if (!lines.length) {
              fieldsHtml += '<div class="db-empty" style="padding:6px 0 2px;">暂无内容，续写后自动累积或点「立即填表」</div>';
              return;
            }
            lines.forEach(function (line) {
              var dm = line.match(/^\[([^\]]+)\]\s*([\s\S]*)$/);
              var date = dm ? dm[1].trim() : '';
              var text = dm ? dm[2].trim() : line;
              fieldsHtml += '<div class="db-plot-item">' +
                (date ? '<span class="db-plot-date">' + htmlEscape(date) + '</span>' : '') +
                '<span class="db-plot-text">' + htmlEscape(text) + '</span>' +
              '</div>';
            });
          });
        } else {
          table.columns.forEach(function (col: any) {
            var colName = col.replace(/^[#*]/, '');
            // 剧情摘要表的主键"主线摘要"也是内容字段，不能跳过
            if (colName === pk && table.id !== 'plot_summary') return;
            var v = r.values[colName];
            if (v && String(v).trim()) {
              fieldsHtml += '<div class="db-field-row"><span class="db-field-name">' + htmlEscape(colName) + '</span><span class="db-field-val">' + htmlEscape(String(v)).replace(/\n/g, '<br>') + '</span></div>';
            }
          });
        }
        fieldsHtml += '<div class="db-rr-actions">' +
          '<button class="small" onclick="event.stopPropagation();UIManager.editDBRecordInline(\'' + r.id + '\')">✎ 编辑</button>' +
          '<button class="small danger" onclick="event.stopPropagation();UIManager.deleteDBRecord(\'' + r.id + '\')">✕ 删除</button>' +
          '</div>';
      }
      // 行头：主键首字方块（角色表用头像）
      var headAvatar = '';
      if (tableId === 'character_profile') {
        var headAv = UIManager._dbAvatarFor(r, tableId);
        headAvatar = headAv
          ? '<img class="db-rr-avatar" src="' + htmlEscape(avatarUrl(headAv) || '') + '" onclick="event.stopPropagation();UIManager.viewAvatar(this.src)" alt="">'
          : '<span class="db-rr-initial">' + htmlEscape(pkVal.trim().charAt(0) || '?') + '</span>';
      }
      var html = '<div class="db-record-row' + (isEdit ? ' open' : '') + '" onclick="UIManager.toggleDBRecord(this)">' +
        '<div class="db-rr-head">' +
          (headAvatar || '<span class="db-rr-initial">' + htmlEscape(pkVal.trim().charAt(0) || '?') + '</span>') +
          '<span class="db-rr-pk">' + htmlEscape(pkVal) + '</span>' +
          '<span style="color:var(--text-muted);font-size:10px;">▸</span>' +
        '</div>' +
        (preview ? '<div class="db-rr-preview">' + htmlEscape(preview) + '</div>' : '') +
        '<div class="db-record-detail">' +
          avatarHtml +
          fieldsHtml +
        '</div>' +
      '</div>';
      return html;
    }).join('');
  },

  editDBRecordInline(recordId: any) {
    this._dbEditId = recordId;
    this.renderDBRecords();
  },

  cancelDBRecordInline() {
    this._dbEditId = null;
    this.renderDBRecords();
  },

  saveDBRecordInline() {
    var tableId = DatabaseManager.getActiveTableId();
    var recordId = this._dbEditId;
    var table = DatabaseManager.getTable(tableId);
    if (!table || !recordId) return;
    var values = {} as Record<string, any>;
    table.columns.forEach(function (col: any) {
      var colName = col.replace(/^[#*]/, '');
      var el = document.getElementById('dbEdit_' + colName);
      if (el) values[colName] = el.value;
    });
    DatabaseManager.updateRecord(tableId, recordId, values);
    this._dbEditId = null;
    this.renderDBRecords();
    App.toast('已保存');
  },

  toggleDBRecord(rowEl: any) {
    // 编辑态下点击行不折叠
    if (rowEl.querySelector('input[id^="dbEdit_"], textarea[id^="dbEdit_"]')) return;
    rowEl.classList.toggle('open');
  },

  showDBRecordModal(recordId: any) {
    var tableId = DatabaseManager.getActiveTableId();
    var table = DatabaseManager.getTable(tableId);
    if (!table) return;
    document.getElementById('dbRecordTableId')!.value = tableId;
    document.getElementById('dbRecordId')!.value = recordId || '';
    document.getElementById('dbRecordModalTitle')!.textContent = recordId ? '编辑记录' : '添加记录 - ' + table.name;
    var rec = recordId ? (DatabaseManager as any).getRecords(tableId!).find(function (r: any) { return r.id === recordId; }) : null;
    var fields = document.getElementById('dbRecordFields');
    // 保留隐藏字段
    var hiddenHtml = '<input type="hidden" id="dbRecordTableId" value="' + tableId + '"><input type="hidden" id="dbRecordId" value="' + (recordId || '') + '">';
    var inputsHtml = '';
    table.columns.forEach(function (col: any) {
      var colName = col.replace(/^[#*]/, '');
      var isAppend = col.charAt(0) === '#';
      var label = colName + (isAppend ? '（追加）' : '');
      var val = rec && rec.values[colName] ? rec.values[colName] : '';
      inputsHtml += '<div class="form-group"><label>' + htmlEscape(label) + '</label>' +
        (isAppend
          ? '<textarea id="dbF_' + colName + '" rows="4" placeholder="追加的新内容（会拼到旧内容后面）">' + htmlEscape(String(val)) + '</textarea>'
          : '<input type="text" id="dbF_' + colName + '" value="' + htmlEscape(String(val)) + '">') +
        '</div>';
    });
    fields!.innerHTML = hiddenHtml + inputsHtml;
    this.showModal('modalDBRecord');
  },

  saveDBRecordFromModal() {
    var tableId = document.getElementById('dbRecordTableId')!.value;
    var recordId = document.getElementById('dbRecordId')!.value;
    var table = DatabaseManager.getTable(tableId);
    if (!table) return;
    var values = {} as Record<string, any>;
    table.columns.forEach(function (col: any) {
      var colName = col.replace(/^[#*]/, '');
      var el = document.getElementById('dbF_' + colName);
      if (el) values[colName] = el.value;
    });
    if (recordId) {
      DatabaseManager.updateRecord(tableId, recordId, values);
    } else {
      DatabaseManager.upsertRecord(tableId, values);
    }
    this.closeModal('modalDBRecord');
    this.renderDBRecords();
    App.toast('已保存');
  },

  deleteDBRecord(recordId: any) {
    var tableId = DatabaseManager.getActiveTableId();
    this.showConfirm('确定删除这条记录？', function () {
      DatabaseManager.deleteRecord(tableId, recordId);
      UIManager.renderDBRecords();
    });
  },

  renderBooks() {
    // 世界书=小说：书籍概念已废弃，无需渲染旧 bookSelect
  },

  // ========== 「我的」卡片式设置页渲染 ==========
  renderMePage() {
    // 主题缩略图：纯 CSS 迷你窗口，颜色取自各主题真实配色
    const strip = document.getElementById('themeStrip');
    if (strip) {
      const palettes = {
        light:     { win:'#ffffff', bar:'#3b6fe0', side:'#eef0f4', body:'#f6f7f9', line:'#d9dee8' },
        dark:      { win:'#1a2030', bar:'#6b93f0', side:'#232b3f', body:'#131722', line:'#2c3548' },
        newspaper: { win:'#f4f0e6', bar:'#3a5a40', side:'#d3d7c0', body:'#e9e4d8', line:'#c2c7ac' },
        dream: { win:'#fffbfd', bar:'#e878a8', side:'#f8e9f1', body:'#fdf3f8', line:'#f1d9e7' }
      };
      const names = { light:'白天', dark:'黑夜', newspaper:'青墨染', dream:'梦境粉' };
      const ui = SM().get<any>('uiSettings', {});
      const curTheme = ui.theme || (ui.darkMode ? 'dark' : 'light');
      strip.innerHTML = (App.THEMES || []).map((t: any) => {
        const c = (palettes as any)[t.key] || palettes.light;
        return '<div class="theme-thumb' + (t.key === curTheme ? ' active' : '') + '" onclick="App.setTheme(\'' + t.key + '\')">' +
          '<div class="tt-tick">✓</div>' +
          '<div class="tt-win" style="background:' + c.win + ';">' +
            '<div class="tt-bar" style="background:' + c.bar + ';"></div>' +
            '<div class="tt-cols">' +
              '<div class="tt-side" style="background:' + c.side + ';"></div>' +
              '<div class="tt-body" style="background:' + c.body + ';">' +
                '<div class="tt-line" style="background:' + c.line + ';width:88%;"></div>' +
                '<div class="tt-line" style="background:' + c.line + ';width:70%;"></div>' +
                '<div class="tt-line" style="background:' + c.line + ';width:80%;"></div>' +
              '</div></div></div>' +
          '<div class="tt-name">' + (names as any)[t.key] + '</div></div>';
      }).join('');
    }
    // 正文字体行选中态
    const curFont = SM().get<any>('editorFont', 'system');
    document.querySelectorAll('#subtab-me .set-row-opt[data-font-opt]').forEach(r => {
      r.classList.toggle('active', r.dataset.fontOpt === curFont);
    });
    // 字号分段控件（首次构建 + 滑块定位）
    const seg = document.getElementById('sizeSeg');
    if (seg) {
      const sizes = App.EDITOR_SIZES || [];
      if (!seg.querySelector('.seg-item')) {
        seg.innerHTML = '<div class="seg-thumb"></div>' + sizes.map((s: any) =>
          '<div class="seg-item" data-px="' + s.px + '" onclick="App.setEditorSize(' + s.px + ')">' + String(s.label).replace(/\s*\d+/, '') + '</div>'
        ).join('');
      }
      const curPx = parseInt(SM().get<any>('editorFontSize', 16), 10) || 16;
      const items = Array.from(seg.querySelectorAll('.seg-item'));
      let idx = sizes.findIndex((s: any) => s.px === curPx);
      if (idx < 0) idx = 1;
      items.forEach((el, i: any) => el.classList.toggle('active', i === idx));
      const thumb = seg.querySelector('.seg-thumb');
      const it = items[idx];
      if (thumb && it) { thumb.style.left = it.offsetLeft + 'px'; thumb.style.width = it.offsetWidth + 'px'; }
    }
    // 实时预览块
    const pv = document.getElementById('typePreview');
    if (pv) {
      const f = (App.EDITOR_FONTS || []).find((x: any) => x.key === curFont);
      pv.style.fontFamily = f && f.family ? f.family : '';
      const px = parseInt(SM().get<any>('editorFontSize', 16), 10) || 16;
      pv.style.fontSize = px + 'px';
      const meta = document.getElementById('typePreviewMeta');
      if (meta) meta.textContent = '预览 · ' + (f ? f.label : '系统默认') + ' · ' + px + 'px';
    }
    // 版本号（只加载一次）
    const vEl = document.getElementById('meVersion');
    if (vEl && !vEl.dataset.loaded) {
      fetch('version.json?_=' + Date.now()).then(r => r.ok ? r.json() : null).then(v => {
        vEl.dataset.loaded = '1';
        if (v && v.versionName) vEl.textContent = formatVersion('v' + v.versionName);
        else vEl.textContent = '未知';
      }).catch(() => { vEl.dataset.loaded = '1'; vEl.textContent = '未知'; });
    }
    // AI 配置状态 / 当前预设名
    const aiState = document.getElementById('aiConfigState');
    if (aiState) {
      try {
        const cfg = SM().get<any>('apiConfig', {});
        aiState.textContent = (cfg && cfg.endpoint) ? '已配置' : '未配置';
      } catch (e) {}
    }
    const pState = document.getElementById('presetState');
    if (pState && typeof PresetManager !== 'undefined' && PresetManager.getCurrentPreset) {
      try {
        const p = PresetManager.getCurrentPreset();
        pState.textContent = p && p.name ? p.name : '';
      } catch (e) {}
    }
  },

  renderChapters() {
    const data = App!.getNovelData(); const chapters = data!.chapters || []; const currentId = data!.currentChapterId;
    // 章节下拉（编辑器工具栏）渲染：第一章/第二章…，最后一个可删除，底部添加
    const container = document.getElementById('chDropdownList');
    if (container) {
      container.innerHTML = chapters.map((ch, i: any) => {
        const label = '第' + ChineseNum(i + 1) + '章';
        const isLast = i === chapters.length - 1;
        const delBtn = isLast
          ? '<span class="ch-del" onclick="event.stopPropagation();App.deleteChapter(\'' + ch.id + '\')">✕</span>'
          : '';
        return '<div class="ch-dropdown-item ' + (ch.id===currentId?'active':'') + '" onclick="App.switchChapter(\'' + ch.id + '\')"><span>' + label + '</span>' + delBtn + '</div>';
      }).join('');
    }
    // 更新下拉按钮标题为当前章
    const btn = document.getElementById('chDropdownBtn');
    if (btn) {
      const idx = chapters.findIndex(c => c.id === currentId);
      btn.textContent = '第' + ChineseNum(idx + 1) + '章 ▾';
    }
  }
};

// ==================== ChineseNum (章节命名用) ====================
function ChineseNum(n: any): string {
  const units = ['', '十', '百', '千'];
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (n <= 0) return '零';
  if (n < 10) return digits[n];
  if (n < 20) return '十' + (n % 10 ? digits[n % 10] : '');
  if (n < 100) {
    const t = Math.floor(n / 10), o = n % 10;
    return digits[t] + '十' + (o ? digits[o] : '');
  }
  if (n < 1000) {
    const h = Math.floor(n / 100), r = n % 100;
    return digits[h] + '百' + (r ? (r < 10 ? '零' + digits[r] : ChineseNum(r)) : '');
  }
  return String(n); // 1000+ 直接数字
}

// ==================== MobileUI Controller ====================


// ---- build-legacy 构建管线生成的全局挂载 ----
const __pl = globalThis as any;
__pl.TYPE_CHIPS = TYPE_CHIPS;
__pl.typeChip = typeChip;
__pl.UIManager = UIManager;
__pl.ChineseNum = ChineseNum;
