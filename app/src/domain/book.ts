// BookManager + parseSampler + normalizeQuotes（迁移自 www/modules/book.js）。
// BookManager 是书切换/同步的胶水层：同步角色/指引到当前书对象。
import { SM } from '../infra/gate';
import { _wbKey } from '../lib/usage';
import { WorldBookManager } from './worldbook';
import { CharacterManager } from './character';

export const BookManager = {
  getAll(): unknown[] { return SM().get<unknown[]>('books', []) ?? []; },
  saveAll(arr: unknown[]): void { SM().set('books', arr); },
  getActiveId(): string | null { return SM().get<string>('activeBookId', null); },
  setActiveId(id: string | null): void { SM().set('activeBookId', id); },
  // 世界书=小说：getActive 返回当前激活的世界书（即 novelData）
  getActive(): WorldBookGlobal | null { return WorldBookManager.getNovelData(); },
  saveActive(data: Partial<WorldBookGlobal>): void { WorldBookManager.saveNovelData(data); },
  syncToBook(): void {
    const book = this.getActive(); if (!book) return;
    book.characters = CharacterManager.getAll();
    book.writingGuide = SM().get<string>('writingGuide', '') ?? '';
    book.activeProtagonistId = SM().get<string>('activeProtagonistId', null);
    book.activeWorldBookId = SM().get<string>('activeWorldBookId', null);
    book.activeOpeningId = SM().get<string>(_wbKey('activeOpeningId'), null);
    book.appliedOpeningContent = SM().get<string>(_wbKey('appliedOpeningContent'), '') ?? '';
    this.saveActive(book);
  },
  syncFromBook(): void {
    const book = this.getActive(); if (!book) return;
    // 世界书=小说：新书可能没有 characters 等字段，缺省即从空加载（避免把上一本书的角色/写作指引带到新书）。
    SM().set('characters', book.characters || []);
    SM().set('writingGuide', book.writingGuide || '');
    SM().set('activeProtagonistId', book.activeProtagonistId || null);
    // 注意：不要用 book.activeWorldBookId 覆盖全局激活状态——切换目标由调用方 setActiveId 决定
    SM().set(_wbKey('activeOpeningId'), book.activeOpeningId || null);
    SM().set(_wbKey('appliedOpeningContent'), book.appliedOpeningContent || '');
  },
  switchBook(id: string): void {
    // 先把当前状态同步进当前书，再切换并从目标书恢复
    this.syncToBook();
    WorldBookManager.setActiveId(id);
    this.syncFromBook();
  },
  renameBook(name: string): void {
    const wb = this.getActive();
    if (!wb) return;
    wb.name = name.trim() || wb.name; wb.title = wb.name;
    WorldBookManager.saveNovelData(wb);
    const titleInput = document.getElementById('titleInput') as HTMLInputElement | null;
    if (titleInput) titleInput.value = wb.name || '';
  },
  deleteBook(): void {
    const id = WorldBookManager.getActiveId();
    if (!id) { App.toast('至少保留一本书'); return; }
    const all = WorldBookManager.getAll();
    if (all.length <= 1) { App.toast('至少保留一本书'); return; }
    WorldBookManager.deleteBook(id);
    App.loadEditorContent?.(); App.renderAll?.();
    App.toast('书已删除');
  },
  migrateFromLegacy(): void {
    // 世界书=小说 数据合并：旧的 books[] 直接废弃（用户确认删除），
    // 先静默备份到 legacy_books_backup（不展示不迁移），再从 storage 移除。
    try {
      const legacyBooks = SM().get<unknown[]>('books', null);
      if (legacyBooks && legacyBooks.length > 0) {
        SM().set('legacy_books_backup', legacyBooks);
      }
    } catch (e) { /* 尽力而为 */ }
    SM().remove('books');
    SM().remove('activeBookId');
    // 确保有一个激活的世界书（世界书即小说容器）
    if (!WorldBookManager.getActiveId()) {
      WorldBookManager.createBook('我的小说');
    }
  }
};

// ==================== parseSampler（预设导入采样参数归一化） ====================
// 逐字段 ?? 链与原实现保持一致（snake_case → camelCase 兼容多种来源格式）
// 返回 any 值 Record：采样参数字段动态、消费方宽松读取（与旧环境声明 Record<string, any> 一致）
export function parseSampler(src: Record<string, unknown>): Record<string, any> {
  return {
    endpoint: src.endpoint || src.apiUrl || '',
    model: src.model || src.modelName || '',
    apiKey: src.apiKey || '',
    temperature: src.temp ?? src.temperature ?? 0.8,
    maxTokens: src.max_tokens ?? src.maxTokens ?? src.max_length ?? src.maxResponse ?? 2048,
    topP: src.top_p ?? src.topP ?? 0.9,
    presencePenalty: src.presence_penalty ?? src.presencePenalty ?? 0,
    frequencyPenalty: src.frequency_penalty ?? src.frequencyPenalty ?? 0,
    topK: src.top_k ?? src.topK ?? 0,
    topA: src.top_a ?? src.topA ?? 1,
    minP: src.min_p ?? src.minP ?? 0,
    repetitionPenalty: src.repetition_penalty ?? src.repetitionPenalty ?? src.rep_pen ?? 1,
    maxContextUnlocked: src.max_context_unlocked ?? src.maxContextUnlocked ?? true,
    openaiMaxContext: src.openai_max_context ?? src.openaiMaxContext ?? 2000000,
    openaiMaxTokens: src.openai_max_tokens ?? src.openaiMaxTokens ?? 32000,
    namesBehavior: src.names_behavior ?? src.namesBehavior ?? 0,
    sendIfEmpty: src.send_if_empty ?? src.sendIfEmpty ?? '',
    impersonationPrompt: src.impersonation_prompt ?? src.impersonationPrompt ?? '',
    newChatPrompt: src.new_chat_prompt ?? src.newChatPrompt ?? '',
    newGroupChatPrompt: src.new_group_chat_prompt ?? src.newGroupChatPrompt ?? '',
    newExampleChatPrompt: src.new_example_chat_prompt ?? src.newExampleChatPrompt ?? '',
    continueNudgePrompt: src.continue_nudge_prompt ?? src.continueNudgePrompt ?? '',
    biasPresetSelected: src.bias_preset_selected ?? src.biasPresetSelected ?? 'Default (none)',
    wiFormat: src.wi_format ?? src.wiFormat ?? '',
    scenarioFormat: src.scenario_format ?? src.scenarioFormat ?? '',
    personalityFormat: src.personality_format ?? src.personalityFormat ?? '',
    groupNudgePrompt: src.group_nudge_prompt ?? src.groupNudgePrompt ?? '',
    streamOpenai: src.stream_openai ?? src.streamOpenai ?? true,
    prompts: Array.isArray(src.prompts) ? (src.prompts as Record<string, unknown>[]).map(p => ({ ...p })) : []
  };
}

// ==================== normalizeQuotes（中日引号归一化） ====================
// 1. 左右弯引号统一为「」；2. 残留 " 按上下文定向；3. 段内配对修复
// （<!-- --> 注释块先整体保护、末尾原样还原；引用须在注释保护之后，见下）
export function normalizeQuotes(text: string): string {
  // 保护注释块（<!-- ... -->）逐字保留——**必须放在引号归一之前**：
  // 放在后面时，注释里的 « » " 已经被上一步改写成「」，注释内容被改动
  // （属性测试反例：`<!-- 擢贆ശù»檼䷋ -->` 的 » 被归一成 」）。
  // 占位符不含引号字符，所以后续所有替换都碰不到它。
  const comments: string[] = [];
  text = text.replace(/<!--[\s\S]*?(?:-->|$)/g, function (m) { comments.push(m); return '\u0001C' + (comments.length - 1) + '\u0001'; });
  text = text.replace(/[“«「]/g, '「');
  text = text.replace(/[”»」]/g, '」');
  text = text.replace(/(^|[。！？，、；：\n])"/g, '$1「');
  text = text.replace(/"([。！？，、；：\n]|$)/g, '」$1');
  text = text.replace(/"/g, '」');
  // 按空行切段，保留分隔符，段边界可见
  const segs = text.split(/(\n[ \t]*\n)/);
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].indexOf('「') < 0 && segs[i].indexOf('」') < 0) continue;
    segs[i] = segs[i].replace(/「|」/g, (function () {
      let open = false;
      return function (m: string): string {
        if (m === '「') {
          if (open) return ''; // 段内已有未闭合「 → 多余的「直接删除
          open = true; return '「';
        }
        if (open) { open = false; return '」'; }
        return ''; // 段内没有待闭合的「 → 多余的」直接删除
      };
    })());
  }
  text = segs.join('');
  text = text.replace(/\u0001C(\d+)\u0001/g, function (_, idx: string) { return comments[+idx]; });
  return text;
}

// 挂载已移除（单 bundle 改造 P3-B）：消费方 ES import BookManager/parseSampler/normalizeQuotes；book.js 停发