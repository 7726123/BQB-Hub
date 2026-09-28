// 外部全局依赖的统一类型声明。
// 访问约定（重要）：未迁移模块的全局是旧脚本顶层 const，只进全局词法作用域、
// 不挂 globalThis 属性——TS 模块里一律用裸标识符 + typeof 守卫访问。
// 接口按当前已迁移模块的实际使用面声明（最小化），新迁移模块按需扩充此文件。
// StorageManager 不在此声明：lib.dom 有同名全局类型会冲突，
// 统一经 src/infra/gate.ts 的 SM() 访问（见该文件说明）。
interface WBEntryGlobal {
  id: string;
  type?: string;
  name?: string;
  content?: string;
  inject?: boolean;
  keywords?: string;
  [k: string]: any;
}
interface WorldBookGlobal {
  id: string;
  name?: string;
  title?: string;
  cover?: string;
  chapters?: { id: string; title: string; content: string; createdAt: number }[];
  currentChapterId?: string;
  entries: WBEntryGlobal[];
  characters?: any[];
  writingGuide?: string;
  activeProtagonistId?: string | null;
  activeWorldBookId?: string | null;
  activeOpeningId?: string | null;
  appliedOpeningContent?: string;
  [k: string]: any;
}

declare const App: {
  [k: string]: any;
  toast(msg: string): void;
  loadEditorContent(): void;
  renderAll(): void;
  getPricingConfig(): { input: number; cached: number; output: number };
  getBackendAPIConfig(): { endpoint?: string; apiKey?: string; model?: string };
  getProtagonist(): { name?: string } | null;
  getCurrentChapter(): { id: string; title: string } | null;
  getNovelData(): { chapters?: { id: string; title?: string; content?: string }[]; currentChapterId?: string; worldSetting?: string } | null;
  updateWordCount(): void;
  saveCurrentChapter(): void;
  resetChatInput(el: any): void;
  sendFromWritingInput(): void;
};

// 反馈页（domain/feedback.ts）：内联 onclick 与 mobile.ts 的切页钩子都按全局访问
declare const Feedback: {
  MAX_LEN: number;
  render(): void;
  onInput(): void;
  submit(): Promise<{ ok: boolean; kind: string; message: string }>;
  getMine(): Array<{ text: string; at: number }>;
  renderMine(): void;
  [k: string]: any;
};

declare const BiqiAgent: {
  [k: string]: any;
  init(): void;
  render(): void;
  toggle(): void;
  close(): void;
  send(): void;
  _open?: boolean;
};

// 对话模式（domain/chatmode.ts）：内联 onclick 与 mobile.ts 的切页钩子都按全局访问
declare const ChatMode: {
  [k: string]: any;
  init(): void;
  render(): void;
  reload(): void;
  send(): void;
  undo(id: string): void;
  undoLast(): void;
  refreshAvatars(): void;
  scrollToBottomAnimated(): void;
  openProfile(name: string): void;
  closeProfile(): void;
  clearAll(): void;
  loadMore(): void;
  switchBook(id: string): void;
};

// 真实模式（domain/realmode.ts，逻辑由独立分支负责）：内联 onclick 与 mobile.ts 的切页钩子都按全局访问
declare const RealMode: { [k: string]: any };

declare const UIManager: {
  [k: string]: any;
  populateSystemPromptUI(): void;
  renderPresets(): void;
  renderModuleList(): void;
  renderRegexRules(): void;
  renderWBEntries(): void;
  showModal(id: string): void;
  closeModal(id: string): void;
  toggleWBSwitch(): void;
  closeWBSwitch(): void;
  switchSubTab(name: string): void;
  renderMePage(): void;
};

declare const APIHandler: {
  [k: string]: any;
  _apiCalls: { label: string; time?: number; promptTokens?: number; cachedTokens?: number; completionTokens?: number; totalTokens?: number; cost?: number; usageMissing?: boolean }[];
  fetchCompletions(
    messages: { role: string; content: string }[],
    onDelta: (s: string) => void,
    onOk: (fullContent: string | null, aborted?: boolean, reasoning?: string) => void,
    onErr: (err: string) => void,
    overrides?: Record<string, any>
  ): void;
  [k: string]: any;
};

declare const PresetManager: {
  [k: string]: any;
  getActiveAPIConfig(): { apiKey?: string; [k: string]: any };
  getActiveSystemPrompt(): string;
  getCurrentPresetId(): string | null;
  getPresets(): { id: string; backendApiConfig?: { endpoint?: string; apiKey?: string; model?: string }; [k: string]: any }[];
  [k: string]: any;
};

declare const ArchiveStore: { [k: string]: any; get(): { blocks: { id: string; text: string; head?: string }[]; dict: string[]; dictVer: number } };

declare const htmlEscape: (s: string) => string;

declare const EditorManager: {
  [k: string]: any;
  getRecentStoryText(): string;
  [k: string]: any;
};

declare const BM25: {
  [k: string]: any;
  tokenize(text: string): string[];
};

// 记忆检索 v2：查询生成器（lib/bm25.ts 挂载）
declare const MemoryQueryBuilder: {
  [k: string]: any;
  build(recentText: string, opts?: { dict?: string[]; getDf?: (t: string) => number; maxRare?: number; maxLen?: number; dfCap?: number; instruction?: string; getCount?: (t: string) => number; recentParts?: string[]; n?: number }): string;
  extractEntities(text: string, dict?: string[]): string[];
  rareBigrams(text: string, getDf: (t: string) => number, maxRare?: number, dfCap?: number): string[];
  namedAnchors(instruction: string, getDf: (t: string) => number, cap?: number, getCount?: (t: string) => number): string[];
  countTermHits(text: string, terms: string[]): number;
};

interface CommunityChatGlobal { server: string; onEnter(): void; [k: string]: any }
interface CommunityChatGlobal { server: string; onEnter(): void; [k: string]: any }
declare const HttpBridge: { [k: string]: any };
declare const CommunityChat: CommunityChatGlobal;

// ---- 已迁移模块的运行时全局（app/ui 等胶水层裸标识符引用） ----
declare const Modals: { [k: string]: any };
declare const MobileUI: { [k: string]: any };
declare const UsageAssistant: { [k: string]: any };
declare const Waterline: { [k: string]: any };
declare const ArchiveIndex: { [k: string]: any };
declare var _storageInit: Promise<void>;
declare const FrozenContext: { [k: string]: any };
declare const USAGE_MANUAL: string;
declare const ASSISTANT_SYSTEM: string;
declare const typeChip: { [k: string]: any };
declare const ChineseNum: { [k: string]: any };

// legacy DOM 宽松：胶水层直接读写 DOM 属性（迁移期放宽，随逐模块细化移除）
interface Window {
  HttpBridge?: any;
  showSaveFilePicker?: any;
}
// HTMLElement 仅保留索引签名：显式成员（value/checked/files 等）会覆盖
// HTMLInputElement 等子类的必选成员、破坏继承赋值兼容（踩过的坑），
// 属性访问全部走 [k: string]: any。
interface HTMLElement {
  [k: string]: any;
}
// 注意：不能把 Node/Element 的必选成员（textContent/scrollTop 等）覆盖为可选——
// 子类把父类必选改可选会破坏到父类的赋值兼容（TS 继承逆变）。
interface Element {
  [k: string]: any;
  style?: any;
  dataset?: any;
  offsetTop?: number;
  innerText?: string;
}
interface EventTarget {
  [k: string]: any;
  closest(sel: string): Element | null;
  files?: FileList;
}
interface EventTarget {
  [k: string]: any;
  closest(sel: string): Element | null;
  files?: FileList;
}
