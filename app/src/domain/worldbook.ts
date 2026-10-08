// WorldBookManager：世界书 = 小说容器（chapters/entries 挂在书对象上）。
// 迁移自 www/modules/worldbook.js；挂 globalThis 供未迁移模块使用。
// 注入模型见 ADR-0001：条目单一 inject 开关，默认注入；「初始」在正文为空时单独注入一次。
import { SM } from '../infra/gate';
import { ImageCache } from '../lib/imagecache';

// 世界书内容变了 → 通知写卡页的工作副本重新对齐（写卡与世界书维护的是**同一本书**，两边必须一致：
// 世界书页改了条目/删了条目/改了类型/换过顺序、导入了酒馆卡……写卡这边立即跟随；反向由写卡的直写负责）。
// 用全局查找而不是 import：worldbook 是底层模块，反向依赖 domain/cardwriter 会成依赖环；
// 写卡模块没加载（或测试环境没挂）时静默跳过。对齐本身幂等：内容一致时是纯比较、零副作用。
function _notifyCardWriterChanged() {
  try {
    const cw: any = (globalThis as any).CardWriterChat;
    if (cw && typeof cw._onWorldbookChanged === 'function') cw._onWorldbookChanged();
  } catch (e) { /* 通知失败不影响世界书写入 */ }
}

/**
 * 真实模式专用的条目类型：由真实模式按角色单独注入（private 视角），**从不进小说/对话的常规注入**
 * （见下方 filterRelevantEntries / selectInjectableEntries 里那两条跳过）。
 * 2026-10-08 起真实模式只在管理员模式里开放，所以这两类条目的界面入口/列表也只在管理员模式下出现
 * （界面裁剪见 ui.ts 的 visibleEntriesFor / syncWbEntryTypeOptions，写卡草稿见 cardwriter.ts）。
 * 这里只放"类型名"这一份事实，供各界面共用，避免三处各写一份名单。
 */
export const REAL_ONLY_ENTRY_TYPES = ['初始记忆', '部分人知道'];

export const WorldBookManager = {
  getAll(): WorldBookGlobal[] { return SM().get<WorldBookGlobal[]>('worldBooks', []) ?? []; },
  saveAll(arr: WorldBookGlobal[]): void { SM().set('worldBooks', arr); _notifyCardWriterChanged(); },
  getActiveId(): string | null { return SM().get<string>('activeWorldBookId', null); },
  setActiveId(id: string | null): void { SM().set('activeWorldBookId', id); },
  getActive(): WorldBookGlobal | null {
    const id = this.getActiveId();
    if (!id) return null;
    return this.getAll().find(wb => wb.id === id) || null;
  },
  // 世界书 = 小说容器：chapters 存在世界书对象上
  getNovelData(): WorldBookGlobal | null {
    const wb = this.getActive();
    if (!wb) return null;
    // 兼容旧世界书（无 chapters/title）——惰性初始化
    let changed = false;
    if (!wb.chapters) { wb.chapters = [{ id: 'ch_1', title: '第1章', content: '', createdAt: Date.now() }]; wb.currentChapterId = 'ch_1'; changed = true; }
    if (!wb.title && wb.name) { wb.title = wb.name; changed = true; }
    if (changed) this.saveAll(this.getAll());
    return wb;
  },
  saveNovelData(data: Partial<WorldBookGlobal>): void {
    const all = this.getAll(); const id = this.getActiveId();
    if (!id) return;
    const idx = all.findIndex(w => w.id === id);
    if (idx >= 0) { all[idx] = { ...all[idx], ...data, id }; this.saveAll(all); }
  },
  createBook(name?: string): WorldBookGlobal {
    const wb: WorldBookGlobal = {
      id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: name || '未命名小说', title: name || '未命名小说',
      chapters: [{ id: 'ch_1', title: '第1章', content: '', createdAt: Date.now() }],
      currentChapterId: 'ch_1', entries: [], createdAt: Date.now()
    };
    const all = this.getAll(); all.push(wb); this.saveAll(all);
    this.setActiveId(wb.id);
    return wb;
  },
  renameBook(id: string, name: string): void {
    const all = this.getAll(); const wb = all.find(w => w.id === id);
    if (wb) { wb.name = name; wb.title = name; this.saveAll(all); }
  },
  deleteBook(id: string): void {
    let all = this.getAll(); all = all.filter(w => w.id !== id); this.saveAll(all);
    // 这本书的"生成图本地存档"一起删（用户明确要的："清空对话后这些图就可以删了"；删书同理，别留孤儿数据）
    try { void ImageCache.delByBook(String(id || '')); } catch (e) { /* 删存档失败不影响删书 */ }
    if (this.getActiveId() === id) {
      const next = all[0];
      if (next) {
        this.setActiveId(next.id);
        if (typeof App !== 'undefined' && App.loadEditorContent) { App.loadEditorContent(); App.renderAll?.(); }
      } else {
        // 没有世界书了，创建一个默认的
        this.createBook('默认世界书');
        if (typeof App !== 'undefined' && App.loadEditorContent) { App.loadEditorContent(); App.renderAll?.(); }
      }
    }
  },
  addEntry(bookId: string, entryData: Partial<WBEntryGlobal>): WBEntryGlobal | null {
    const all = this.getAll(); const wb = all.find(w => w.id === bookId);
    if (!wb) return null;
    // 注入开关：新建条目默认注入（「初始」由写作端在正文为空时单独注入）
    // 带过来的额外字段必须留着（如「初始记忆」的 bindId/bindName）——只挑已知字段会把绑定静默丢掉，
    // 而绑丢失后 1 对 1 校验也查不到重复（页面验收 2026-09-28 抓到的就是这个）。
    const entry: WBEntryGlobal = {
      ...entryData,
      id: 'wbe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: entryData.type || '其他', name: entryData.name || '', content: entryData.content || '', inject: entryData.inject !== false,
    };
    wb.entries.push(entry); this.saveAll(all);
    return entry;
  },
  updateEntry(bookId: string, entryId: string, entryData: Partial<WBEntryGlobal>): void {
    const all = this.getAll(); const wb = all.find(w => w.id === bookId);
    if (!wb) return;
    const idx = wb.entries.findIndex(e => e.id === entryId);
    if (idx >= 0) { wb.entries[idx] = { ...wb.entries[idx], ...entryData, id: entryId }; this.saveAll(all); }
  },
  // 类型精简迁移：只保留 世界观/角色/初始/初始记忆/部分人知道/其他/变量，其余统一改为「其他」。幂等。
  // 「变量」是 2026-09-26 重新启用的类型（一个条目 = 一个变量：名称=变量名、内容=给模型的讲解、
  // 注入开关=启用/停用），必须留在白名单里，否则下次启动就被改成「其他」而失去注入与收集。
  // 「初始记忆」（1 对 1 绑定一个角色，bindId/bindName）与「部分人知道」（绑一组角色名，bindNames）
  // 都是 2026-09-28 新增的类型，同理必须留白名单——否则下次启动会被改成「其他」，绑定就废了。
  migrateEntryTypes(): boolean {
    const KEEP = ['世界观', '角色', '初始', '初始记忆', '部分人知道', '其他', '变量'];
    const all = this.getAll();
    let changed = false;
    all.forEach(function (wb) {
      (wb.entries || []).forEach(function (e) {
        if (e.type && KEEP.indexOf(e.type) < 0) {
          e.type = '其他';
          changed = true;
        }
      });
    });
    if (changed) this.saveAll(all);
    return changed;
  },
  // 「开头」条目类型已废弃（v1.5.81）：存量条目一次性删除，内容另存备份键便于找回。
  // 幂等：跑过一次就置标记位；备份保留最后一次删除的内容。
  removeOpeningEntries(): number {
    const KEY = 'removedOpeningEntriesBackup';
    let removed = 0;
    const backup: Record<string, unknown[]> = {};
    const all = this.getAll();
    all.forEach(function (wb) {
      const list = (wb.entries || []).filter(function (e) { return e && e.type === '开头'; });
      if (list.length > 0) {
        backup[wb.id] = list;
        wb.entries = (wb.entries || []).filter(function (e) { return !(e && e.type === '开头'); });
        removed += list.length;
      }
    });
    if (removed > 0) {
      this.saveAll(all);
      try { SM().set(KEY, backup); } catch (e) { /* ignore */ }
    }
    return removed;
  },
  deleteEntry(bookId: string, entryId: string): void {
    const all = this.getAll(); const wb = all.find(w => w.id === bookId);
    if (!wb) return;
    wb.entries = wb.entries.filter(e => e.id !== entryId); this.saveAll(all);
  },
  toggleEntryInject(entryId: string, checked: boolean): void {
    const all = this.getAll();
    const wb = all.find(w => w.id === this.getActiveId());
    if (!wb) return;
    const entry = wb.entries.find(e => e.id === entryId);
    if (entry) { entry.inject = !!checked; this.saveAll(all); }
  },
  initDefaults(): void {
    if (this.getAll().length === 0) {
      this.createBook('默认世界书');
    }
  },
  filterRelevantEntries(): WBEntryGlobal[] {
    // 关键词/常驻/条件注入机制已移除：所有开启「注入」的条目一律注入；
    // 「初始」在正文为空时由写作端单独注入，不参与常规注入
    const active = this.getActive();
    if (!active || !active.entries) return [];
    return active.entries.filter(function (e) {
      // 「初始记忆」「部分人知道」= 角色的私有视角（只有被绑定/被点名的角色看得到，由真实模式按角色注入）
      // → 不进常规注入。混进来就等于把秘密发给所有人。
      return e.type !== '初始' && e.type !== '初始记忆' && e.type !== '部分人知道' && e.inject !== false;
    });
  },
  // 书本封面（400×600 jpeg dataURL；社区上传/书架展示共用）
  setCover(bookId: string, dataUrl: string): void {
    const all = this.getAll(); const wb = all.find(w => w.id === bookId);
    if (!wb) return;
    wb.cover = dataUrl || '';
    this.saveAll(all);
  },
  // 酒馆卡导入时留存的原始数据（character_book 原文 + 卡面字段）：
  // 写卡「把酒馆卡改造成适配卡」要用它——read_current_book_json 会把整本书的字段一起读出去，
  // 挂在这里 Agent 就能拿到酒馆原文；不放进 entries 是为了不污染条目列表与续写注入。
  setTavernSource(bookId: string, src: Record<string, unknown> | null): void {
    const all = this.getAll(); const wb = all.find(w => w.id === bookId);
    if (!wb) return;
    if (src) wb.tavernSource = src; else delete wb.tavernSource;
    this.saveAll(all);
  }
};

// 世界书注入上限（字）：不再提供用户设置项，固定为 10 万字——市面绝大多数模型的上下文都装得下
// （10 万字 ≈ 7 万 token），同时保证一本世界书基本能整本注入。
// 取用规则：条目按类型优先级（角色 > 世界观 > 其他），同类保持书内原序；
// 超上限的条目整体跳过（不截半条），输出保持书内原序 —— 只依赖稳定输入（条目 + 上限），
// 不依赖正文/近期文本，稳定前缀才能逐字节命中 prompt 缓存（ADR-0001 遗留的"上下文无上限"问题）。
export const WB_INJECT_MAX_CHARS = 100000;
export interface WBInjectResult { kept: any[]; skipped: number; chars: number; budget: number }
export function selectInjectableEntries(entries: any[], budgetChars: number): WBInjectResult {
  // 没有名字的条目不注入：模型看不到名字就没法引用它，只会在提示词里留一行「### [其他] undefined」
  // （2026-09-25 一致性检查：导入卡/手改数据里可能有空名条目，注入侧统一跳过）
  // 「初始记忆」「部分人知道」也不注入：它们是角色私有视角，只有该角色看得到（真实模式按角色单独注入）——
  // 混进公共世界书注入等于把秘密发给所有人。
  const list = (entries || []).filter(function (e: any) {
    return e && e.inject !== false && e.type !== '变量' && e.type !== '前端' && e.type !== '初始'
      && e.type !== '初始记忆'
      && e.type !== '部分人知道'
      && String(e.name || '').trim().length > 0;
  });
  const sizeOf = function (e: any) { return String(e.content || '').length + String(e.name || '').length + 12; };
  const budget = Number(budgetChars) || 0;
  if (budget <= 0) {
    return { kept: list, skipped: 0, chars: list.reduce(function (n: number, e: any) { return n + sizeOf(e); }, 0), budget: 0 };
  }
  const weight = function (e: any) { return e.type === '角色' ? 0 : (e.type === '世界观' ? 1 : 2); };
  const order = list.map(function (e: any, i: number) { return { e: e, i: i }; })
    .sort(function (a: any, b: any) { return weight(a.e) - weight(b.e) || a.i - b.i; });
  let used = 0, skipped = 0;
  const keepIdx = new Set<number>();
  order.forEach(function (it: any) {
    const n = sizeOf(it.e);
    if (used + n > budget) { skipped++; return; }
    used += n; keepIdx.add(it.i);
  });
  const kept = list.filter(function (_e: any, i: number) { return keepIdx.has(i); });
  return { kept: kept, skipped: skipped, chars: used, budget: budget };
}

// 世界书里有没有**真的叫 user/User** 的条目。有的话 user 是这张卡里的正经角色名，
// 主角占位符展开（{{user}}/{user}/裸 user）与对话模式的「user → 主角」别名都要让位，不能接管它。
export function hasUserNamedEntry(entries: Array<{ name?: string }> | null | undefined): boolean {
  return (entries || []).some(function (e) { return !!e && String((e as any).name || '').trim().toLowerCase() === 'user'; });
}

// 挂载已移除（单 bundle 改造 P3-B）：13 个消费方 ES import 本模块；worldbook.js 产物停发
export default WorldBookManager;