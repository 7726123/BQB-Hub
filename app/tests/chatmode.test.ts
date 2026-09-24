// 对话模式（domain/chatmode.ts）：按书隔离、提示词组装、流式缓冲、落库与诊断。
// 覆盖用户明确要求的三件事：① 记录按书分开（切书自动切换、生成途中切书不串台）；
// ② 两种模式共用同一份世界书（不读小说模式的临时 overlay）；③ 提示词里指定字数（不让 AI 自己分配）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import '../src/infra/storage';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { PresetManager } from '../src/domain/preset';
import { APIHandler } from '../src/domain/api';
import { SettingSyncManager } from '../src/domain/settingsync';
import { parseBubbles } from '../src/lib/bubble';
import { ChatMode } from '../src/domain/chatmode';

const here = dirname(fileURLToPath(import.meta.url));
const g = globalThis as unknown as Record<string, any>;

// ---- 迷你 DOM（只实现被测代码用到的成员）----
function makeEl(id: string): any {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  return {
    id, style: {}, innerHTML: '', textContent: '', value: '', placeholder: '',
    scrollTop: 0, scrollHeight: 100, clientHeight: 100,
    classList: { add: () => {}, remove: () => {}, toggle: () => false, contains: () => false },
    addEventListener: (t: string, fn: (e: any) => void) => { (listeners[t] ||= []).push(fn); },
    removeEventListener: () => {},
    _fire: (t: string, e: any = {}) => (listeners[t] || []).forEach(fn => fn(e)),
  };
}
const els: Record<string, any> = {};
function setupDom() {
  ['chatStream', 'chatInput', 'chatBookTitle', 'chatSendBtn', 'chatStopBtn', 'chatUndoBtn', 'chatStatus',
    'chatBookSelect', 'chatProfileModal', 'chatProfileBody', 'chatProfileTitle']
    .forEach(id => { els[id] = makeEl(id); if (id === 'chatBookSelect') els[id].innerHTML = ''; });
}
globalThis.document = {
  getElementById: (id: string) => els[id] || null,
} as any;

// ---- 预设 / 世界书 / 全局桩 ----
const PRESET_ID = 'p_chat_test';
function setupPreset(lengthWords: number | null, opts: { overlayEntries?: any[] } = {}) {
  const mods: any[] = [
    { id: 'm_style', name: '文风', content: '# 文风\n- 克制。', enabled: true, role: 'system', order: 8 },
    { id: 'm_pov', name: '视角·第一人称', content: '# 视角\n- 主角用「我」。', enabled: true, role: 'system', order: 9 },
    { id: 'm_off', name: '关掉的模块', content: '# 不该出现\n- 这段话不能被注入。', enabled: false, role: 'system', order: 10 },
  ];
  if (lengthWords) mods.push({ id: 'm_len', name: '字数·' + lengthWords, content: '# 字数\n\n- 本次输出约 ' + lengthWords + ' 字。', enabled: true, role: 'system', order: 15 });
  PresetManager.savePresets([{ id: PRESET_ID, name: '测试预设', prompts: [], promptModules: mods, systemPromptId: 'sp_default', isDefault: false, createdAt: 1 } as any]);
  PresetManager.setCurrentPresetId(PRESET_ID);
  // 小说模式的临时 overlay：对话模式必须**不读**它（用户要求两种模式各存各的）
  if (opts.overlayEntries) {
    g.SettingSyncManager = { isActive: () => true, getEffectiveEntries: () => opts.overlayEntries };
  } else {
    delete g.SettingSyncManager;
  }
}

function seedBooks() {
  WBM.saveAll([]);
  const a = WBM.createBook('甲书');
  WBM.saveAll(WBM.getAll());
  const b = WBM.createBook('乙书');
  WBM.saveAll(WBM.getAll());
  // 甲书：三个角色 + 一条世界观（含头像）；乙书：一个角色
  const all = WBM.getAll();
  all.find(w => w.id === a.id)!.entries = [
    { id: 'e1', type: '角色', name: '林薇', content: '说话直接，讨厌被同情。', avatar: 'data:image/jpeg;base64,AAAA' },
    { id: 'e2', type: '角色', name: '陈亦', content: '话少，会弹吉他。' },
    { id: 'e3', type: '角色', name: '林薇（副）', content: '学生会副会长。', inject: true },
    { id: 'e4', type: '世界观', name: '学校与天台', content: '天台平时锁着。' },
  ];
  all.find(w => w.id === b.id)!.entries = [{ id: 'f1', type: '角色', name: '苏老师', content: '班主任。' }];
  WBM.saveAll(all);
  WBM.setActiveId(a.id);
  return { a: a.id, b: b.id };
}

const apiCalls: any[] = [];
function stubApp() {
  g.htmlEscape = undefined;
  g.App = {
    toast: vi.fn(),
    getProtagonist: () => ({ name: '林叶' }),
    thinkingLevel: () => 'off',
    saveCurrentChapter: vi.fn(),
  };
  g.confirm = () => true;   // 撤回覆盖输入框前的确认
  g.EditorManager = { insertAtCursor: vi.fn(() => true) };
  g.UIManager = { viewAvatar: vi.fn(), pickAvatar: vi.fn() };
  // chatmode 走 ES import 拿 APIHandler（不是全局），所以桩要打在真实对象的方法上
  (APIHandler as any).abort = vi.fn();
  (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any, _onErr: any, ov: any) => {
    apiCalls.push({ msgs, ov });
    onDelta('林薇：「你怎么才来。」\n林叶：我把笔帽扣上。\n白：天暗了下来。');
    onOk('林薇：「你怎么才来。」\n林叶：我把笔帽扣上。\n白：天暗了下来。', false, '思考内容');
  };
}

beforeEach(() => {
  setupDom();
  stubApp();
  apiCalls.length = 0;
  ['worldBooks', 'activeWorldBookId', 'presets', 'currentPresetId', 'chatInputMode'].forEach(k => {
    try { g.StorageManager.remove(k); } catch (e) { /* ignore */ }
  });
  ChatMode._sending = false; ChatMode._acc = ''; ChatMode._streamBookId = ''; ChatMode._loadedBookId = '';
  ChatMode._window = 120; ChatMode._status = ''; ChatMode._reasoningChars = 0;
});

describe('按书隔离', () => {
  it('记录挂在自己的书上：切换当前书 → log() 跟着换', () => {
    const { a, b } = seedBooks();
    ChatMode.append('ai', '甲书的第一轮');
    WBM.setActiveId(b);
    expect(ChatMode.log()).toHaveLength(0);
    ChatMode.append('ai', '乙书的第一轮');
    WBM.setActiveId(a);
    expect(ChatMode.log().map(m => m.raw)).toEqual(['甲书的第一轮']);
  });

  it('生成途中切书：结果落回开始的哪本书，不串台', () => {
    const { a, b } = seedBooks();
    ChatMode._appendToBook(a, 'ai', '属于甲书');
    WBM.setActiveId(b);
    ChatMode._appendToBook(a, 'ai', '也属于甲书');
    expect(ChatMode.log()).toHaveLength(0);
    WBM.setActiveId(a);
    expect(ChatMode.log().map(m => m.raw)).toEqual(['属于甲书', '也属于甲书']);
  });

  it('存储上限：超出后丢最早的，条数不涨', () => {
    const { a } = seedBooks();
    const wb = WBM.getAll().find(w => w.id === a)!;
    wb.chatLog = Array.from({ length: 1200 }, (_, i) => ({ id: 'x' + i, kind: 'ai', raw: '第' + i, at: i }));
    WBM.saveAll(WBM.getAll());
    ChatMode._appendToBook(a, 'ai', '最后一条');
    const log = ChatMode.log();
    expect(log).toHaveLength(1200);
    expect(log[log.length - 1].raw).toBe('最后一条');
    expect(log[0].raw).toBe('第1');   // 最早的「第0」被丢掉
  });
});

describe('提示词组装（同一份世界书 + 指定字数）', () => {
  it('system：启用模块按 order 注入，含世界书与格式块，禁用模块不出现', () => {
    seedBooks();
    setupPreset(1500);
    const sys = ChatMode.buildSystem();
    expect(sys.indexOf('# 文风')).toBeGreaterThan(-1);
    expect(sys.indexOf('# 视角')).toBeGreaterThan(-1);
    expect(sys.indexOf('不该出现')).toBe(-1);
    expect(sys.indexOf('## 世界书条目')).toBeGreaterThan(-1);
    expect(sys.indexOf('林薇')).toBeGreaterThan(-1);
    expect(sys.indexOf('对话演出（本模式唯一的输出格式）')).toBeGreaterThan(-1);
    expect(sys.indexOf('林薇、陈亦')).toBeGreaterThan(-1);        // 名单 = 世界书「角色」条目名…
    expect(sys.indexOf('、林叶')).toBeGreaterThan(-1);             // …+ 主角名
    expect(sys.indexOf('本次输出约 1500 字')).toBeGreaterThan(-1);
    expect(sys.indexOf('深度思考已关闭')).toBeGreaterThan(-1);      // thinkingLevel=off
  });

  it('读对话模式自己的临时世界书，不读小说模式那份（各存各的）', () => {
    seedBooks();
    setupPreset(1500);
    // chatmode 走 ES import 拿 SettingSyncManager（不是全局），桩要打在真实对象上
    const SS = SettingSyncManager as any;
    const orig = { isActive: SS.isActive, setMode: SS.setMode, getEffectiveEntries: SS.getEffectiveEntries };
    let mode = 'novel';
    SS.isActive = () => true;
    SS.setMode = (m: string) => { mode = m; };
    SS.getEffectiveEntries = () => (mode === 'chat'
      ? [{ id: 'e1', type: '角色', name: '林薇', content: '说话直接。' }, { id: 'c1', type: '角色', name: '对话模式新增', content: '只存在于对话模式 overlay' }]
      : [{ id: 'e1', type: '角色', name: '林薇', content: '说话直接。' }, { id: 'n1', type: '角色', name: '小说模式新增', content: '只存在于小说模式 overlay' }]);
    try {
      const sys = ChatMode.buildSystem();
      expect(mode).toBe('chat');                                  // 组装前已切到对话模式
      expect(sys.indexOf('对话模式新增')).toBeGreaterThan(-1);      // 对话模式的改动参与演出
      expect(sys.indexOf('小说模式新增')).toBe(-1);                 // 小说模式的改动不参与
      expect(ChatMode.roster()).toContain('对话模式新增');           // 新增角色也进名单（有气泡有头像）
    } finally {
      SS.isActive = orig.isActive; SS.setMode = orig.setMode; SS.getEffectiveEntries = orig.getEffectiveEntries;
    }
  });

  it('user：带演出记录、【作者】与【本轮目标】——字数写在这里（实测只写 system 会掉到 65–80%）', () => {
    seedBooks();
    setupPreset(1500);
    ChatMode.append('ai', '林薇：「你怎么才来。」');
    ChatMode.append('director', '演到她说出理由');
    const user = ChatMode.buildUser('接着演');
    expect(user.indexOf('演出记录')).toBeGreaterThan(-1);
    expect(user.indexOf('林薇：「你怎么才来。」')).toBeGreaterThan(-1);
    expect(user.indexOf('【作者的指令】演到她说出理由')).toBeGreaterThan(-1);
    expect(user.indexOf('【作者】接着演')).toBeGreaterThan(-1);
    expect(/【本轮目标】约 1500 字/.test(user)).toBe(true);   // 预设写了字数 → 用户消息末尾重申一次
  });

  it('字数只认预设：预设写了就取它，没写就返回 null（不兜底、不注入数字）', () => {
    seedBooks();
    setupPreset(2500);
    expect(ChatMode.lengthWords()).toBe(2500);
    setupPreset(null);
    expect(ChatMode.lengthWords()).toBe(null);
    expect(ChatMode.buildUser('接着演').indexOf('【本轮目标】')).toBe(-1);   // 预设没写 → 不注入字数行
    expect(ChatMode.buildSystem().indexOf('本次输出约')).toBe(-1);
  });

  it('没设主角时名单里补上「我」：否则格式块的名单约束会把主角的台词挡掉', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => null;                 // 本例：世界书里没设主角
    expect(ChatMode.roster()).toEqual(['林薇', '陈亦', '林薇（副）', '我']);
    expect(ChatMode.aliases()).toEqual({});
    // 设了主角：名单带主角名，「我」通过别名映射到主角身上
    g.App.getProtagonist = () => ({ name: '林叶' });
    expect(ChatMode.roster()).toEqual(['林薇', '陈亦', '林薇（副）', '林叶']);
    expect(ChatMode.aliases()).toEqual({ '我': '林叶', '主角': '林叶' });
    expect(parseBubbles('我：「谁的。」', ChatMode.parseOpts())[0].speaker).toBe('林叶');
  });

  // 用户报告：扮演温水和彦时对话里"多出一个角色"——模型用姓/名单独称呼主角（甚至并成
  // 「温水与和彦」），解析不认 → 当成名单外的新人物另起一个头像气泡。别名把简写收回主角名下。
  it('主角名的姓/名简写与并列写法都归到主角本人（不再多出一个角色）', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '温水和彦' });
    const opts = ChatMode.parseOpts();
    expect(ChatMode.aliases()['温水']).toBe('温水和彦');       // 姓
    expect(ChatMode.aliases()['和彦']).toBe('温水和彦');       // 名
    for (const label of ['温水', '和彦', '温水君', '温水与和彦', '温水和彦']) {
      const b = parseBubbles(label + '：我把门推开。', opts);
      expect(b[0].speaker, label).toBe('温水和彦');
      expect(b[0].known, label).toBe(true);
    }
    // 世界书里真有同名角色时以名单为准（别名只是兜底，不抢名单）
    const wb = WBM.getAll().find(w => w.id === ChatMode.bookId())!;
    wb.entries = wb.entries.concat([{ id: 'e9', type: '角色', name: '温水', content: '别的角色。' }]);
    WBM.saveAll(WBM.getAll());
    expect(parseBubbles('温水：我在。', ChatMode.parseOpts())[0].speaker).toBe('温水');
  });

  it('格式块：主角标注「作者本人·主角」，并写明主角=作者、不许分身', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => ({ name: '温水和彦' });
    const sys = ChatMode.buildSystem();
    expect(sys.indexOf('温水和彦（作者本人·主角）')).toBeGreaterThan(-1);
    expect(sys.indexOf('主角就是作者本人')).toBeGreaterThan(-1);
    expect(sys.indexOf('主角只有一个人，不许分身')).toBeGreaterThan(-1);
    // 没设主角：同样写死「主角=作者的第一人称」，且不给半个名字
    g.App.getProtagonist = () => null;
    const sys2 = ChatMode.buildSystem();
    expect(sys2.indexOf('主角就是作者本人')).toBeGreaterThan(-1);
    expect(sys2.indexOf('作者本人·主角）')).toBe(-1);
  });

  it('占位符里不再写具体人名（换书/换世界书后不会误导），也不再由 JS 改写', () => {
    const html = readFileSync(resolve(here, '../../web/index.html'), 'utf8');
    const hit = /id="chatInput"[^>]*placeholder="([^"]*)"/.exec(html);
    expect(hit).toBeTruthy();
    expect(hit![1].indexOf('「我」')).toBeGreaterThan(-1);
    expect(hit![1].indexOf('主角')).toBe(-1);
    // chatmode 不再碰 placeholder：以前它把主角名塞进提示语，切到别的书还留着上一本的名字
    const src = readFileSync(resolve(here, '../src/domain/chatmode.ts'), 'utf8');
    expect(src.indexOf('placeholder')).toBe(-1);
  });

  it('生成请求：system 带格式块，user 带本轮目标；请求参数用大 max_tokens（推理模型思考会吃额度）', async () => {
    seedBooks();
    setupPreset(1000);
    await ChatMode.generate('放学后的教室，林薇把一封信放在我桌上');
    expect(apiCalls).toHaveLength(1);
    const call = apiCalls[0];
    expect(call.msgs[0].role).toBe('system');
    expect(call.msgs[0].content.indexOf('对话演出')).toBeGreaterThan(-1);
    expect(call.msgs[1].content.indexOf('【本轮目标】约 1000 字')).toBeGreaterThan(-1);
    expect(call.ov.maxTokens).toBe(65535);
    expect(call.ov.callLabel).toBe('chat');
    expect(typeof call.ov.onReasoning).toBe('function');
  });
});

describe('落库与诊断', () => {
  it('正常一轮：作者指令 + AI 演出各一条，字数已统计，状态复位', async () => {
    seedBooks();
    setupPreset(1000);
    const ta = els['chatInput'];
    ta.value = ' 演到她说出理由 ';
    ChatMode.send();
    await vi.waitFor(() => expect(ChatMode._sending).toBe(false));
    const log = ChatMode.log();
    expect(log.map(m => m.kind)).toEqual(['author', 'ai']);
    expect(log[0].raw).toBe('演到她说出理由');
    expect(log[1].words).toBeGreaterThan(10);
    expect(log[1].truncated).toBe(false);
    expect(ta.value).toBe('');            // 输入框已清空
  });

  it('作者输入没有模式开关：按内容自动分（戏里的一句 → 主角气泡；长句要求 → 淡色一行）', async () => {
    seedBooks();
    setupPreset(1000);
    els['chatInput'].value = '哈？你在说什么啊！';
    ChatMode.send();
    await vi.waitFor(() => expect(ChatMode._sending).toBe(false));
    expect(ChatMode.log()[0].kind).toBe('author');           // 统一记 author
    expect(ChatMode.authorLooksInCharacter('哈？你在说什么啊！')).toBe(true);   // 有标点/语气 → 戏里的一句
    expect(ChatMode.authorLooksInCharacter('（站起来。）')).toBe(true);
    expect(ChatMode.authorLooksInCharacter('我：随便你。')).toBe(true);
    expect(ChatMode.authorLooksInCharacter('林薇：你走开')).toBe(true);
    expect(ChatMode.authorLooksInCharacter('演到她说出理由，停在主角回答之前，别提前收尾')).toBe(false);
    expect(ChatMode.authorLooksInCharacter('【当前场景】放学后的教室')).toBe(false);
  });

  it('空正文不落库，只提示（绝不渲染空气泡）', () => {
    seedBooks();
    setupPreset(1000);
    (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any) => { onOk('', false, '只有思考'); };
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._finish('   ', false, 'stop');
    expect(ChatMode.log()).toHaveLength(0);
    expect(g.App.toast).toHaveBeenCalled();
  });

  // 用户问「思考中被截断，是不是 token 限制太少」：推理模型的思考与正文共用同一个输出额度，
  // 思考跑满就写不出正文。这里守住"把话说清楚"：文案要指出额度被思考吃掉多少。
  it('空正文 + finish_reason=length + 思考很长 → 提示额度被思考吃满（不是笼统的"没拿到内容"）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._reasoningChars = 7342;
    ChatMode._finish('', false, 'length');
    const msg = (g.App.toast as any).mock.calls.map((c: any[]) => String(c[0])).join('\n');
    expect(msg).toContain('额度被思考吃满');
    expect(msg).toContain('7342');
    expect(ChatMode.log()).toHaveLength(0);
  });

  it('被截断（finish_reason=length）与格式漂移都会标记出来，截断文案带思考字数', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode._reasoningChars = 1200;
    ChatMode._finish('林薇：「一」', false, 'length');
    let last = ChatMode.log().slice(-1)[0];
    expect(last.truncated).toBe(true);
    expect(last.reasoning).toBe(1200);                       // 落库带着思考字数
    expect(ChatMode._bubbleHtml(last)).toContain('思考已用掉约 1200 字额度');
    // 整段散文（没有任何说话人前缀）→ 漂移
    ChatMode._finish('她把信放在桌上。'.repeat(10), false, 'stop');
    last = ChatMode.log().slice(-1)[0];
    expect(last.drift).toBe(true);
    // 正常演出 → 不报漂移、不带思考字数
    ChatMode._reasoningChars = 0;
    ChatMode._finish('林薇：「你怎么才来。」\n林叶：我把笔帽扣上。', false, 'stop');
    last = ChatMode.log().slice(-1)[0];
    expect(last.drift).toBe(false);
    expect(last.reasoning).toBe(undefined);
  });
});

describe('头像与角色简介（自动聚合）', () => {
  it('头像优先取世界书角色条目的 avatar，缺省用首字色块且颜色稳定', () => {
    seedBooks();
    expect(ChatMode.avatar('林薇').src).toBe('data:image/jpeg;base64,AAAA');
    const a1 = ChatMode.avatar('陈亦'), a2 = ChatMode.avatar('陈亦');
    expect(a1.src).toBe(null);
    expect(a1.initial).toBe('陈');
    expect(a1.color).toBe(a2.color);
    expect(ChatMode.avatar('白').initial).toBe('白');
  });

  it('简介聚合：精确名 + 去尊称 + 包含匹配，一个角色的多条设定都列出来', () => {
    seedBooks();
    expect(ChatMode.profile('林薇').map(e => e.name)).toEqual(['林薇', '林薇（副）']);
    expect(ChatMode.profile('林薇小姐')[0].name).toBe('林薇');
    expect(ChatMode.profile('不存在的人')).toEqual([]);
  });

  it('打开简介：把命中的条目渲染进弹窗（含换头像入口）', () => {
    seedBooks();
    ChatMode.openProfile('林薇');
    const html = els['chatProfileBody'].innerHTML;
    expect(html.indexOf('学生会副会长')).toBeGreaterThan(-1);
    expect(html.indexOf('换头像')).toBeGreaterThan(-1);
    expect(els['chatProfileModal'].style.display).toBe('flex');
    ChatMode.closeProfile();
    expect(els['chatProfileModal'].style.display).toBe('none');
  });
});

describe('渲染与流式', () => {
  it('空记录 → 空状态；有记录 → 气泡；作者戏里的一句靠右（撤回已不在气泡上）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.render();
    expect(els['chatStream'].innerHTML.indexOf('还没有演出记录')).toBeGreaterThan(-1);
    ChatMode.append('ai', '林薇：「你怎么才来。」\n林叶：我把笔帽扣上。', { words: 21 });
    ChatMode.append('author', '我：「谁的。」');
    ChatMode.append('author', '演到她说出理由');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('chat-bubble')).toBeGreaterThan(-1);
    expect(html.indexOf('chat-say')).toBeGreaterThan(-1);
    expect(html.indexOf('chat-act')).toBeGreaterThan(-1);
    // 撤回挪到输入行左侧的 ↩（与写作页一致）：气泡上不再挂按钮
    expect(html.indexOf('ChatMode.undo(')).toBe(-1);
    expect(html.indexOf('→正文')).toBe(-1);
    expect(html.indexOf('重演')).toBe(-1);
    expect(html.indexOf('删除')).toBe(-1);
    expect(html.indexOf('chat-row-me')).toBeGreaterThan(-1);           // 「我：…」→ 主角气泡靠右
    expect(html.indexOf('演到她说出理由')).toBeGreaterThan(-1);         // 长句要求仍在
    expect(html.indexOf('chat-note')).toBeGreaterThan(-1);             // …但渲染成淡色一行，不是气泡
    expect(html.indexOf('21 字')).toBeGreaterThan(-1);                  // 字数标签还在
  });

  // 用户反馈：第一轮一点发送就挂一段「（这一轮没有内容）」，看着像这一轮白跑了。
  // 真相：那是**流式占位**——推理模型先思考几十秒，这段时间正文还没吐出来；不是空回复。
  it('流式占位显示思考状态，不是「这一轮没有内容」', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode._sending = true;
    ChatMode._streamBookId = ChatMode.bookId();
    ChatMode._acc = '';
    ChatMode._status = '正在思考…（已想 128 字）';
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('（这一轮没有内容）')).toBe(-1);      // 不能吓人
    expect(html.indexOf('chat-waiting')).toBeGreaterThan(-1);
    expect(html.indexOf('正在思考…（已想 128 字）')).toBeGreaterThan(-1);
    // 正文到达后占位消失，正常出气泡
    ChatMode._acc = '林薇：「你怎么才来。」';
    ChatMode.render();
    const html2 = els['chatStream'].innerHTML;
    expect(html2.indexOf('chat-waiting')).toBe(-1);
    expect(html2.indexOf('你怎么才来')).toBeGreaterThan(-1);
    ChatMode._sending = false; ChatMode._acc = ''; ChatMode._streamBookId = '';
  });

  it('真的空回复（已落库、非流式）才显示「这一轮没有内容」', () => {
    seedBooks();
    setupPreset(1000);
    const m = ChatMode.append('ai', '   ');
    ChatMode.render();
    expect(els['chatStream'].innerHTML.indexOf('（这一轮没有内容）')).toBeGreaterThan(-1);
    expect(m.kind).toBe('ai');
  });

  it('旁白不带「白」头像与名字，直接一行淡色文字', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '白：教室后门开着，值日生把扫帚往墙边一放。\n林薇：「给你的。」');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.indexOf('chat-narr')).toBeGreaterThan(-1);
    expect(html.indexOf('>白<')).toBe(-1);                 // 没有「白」这个名字标签
    expect(html.split('chat-av').length - 1).toBe(1);      // 只有一个头像（林薇的）
  });

  it('同一角色的连续输出合并成一个气泡（不再一句一条）；主角靠右、其他角色与旁白靠左', () => {
    seedBooks();
    setupPreset(1000);
    g.App.getProtagonist = () => null;      // 没设主角 → 主角以「我」发言
    ChatMode.append('ai', '林薇：「一。」\n林薇：她抬手把窗帘拉上。\n林薇：「二。」\n我：我把笔放下。\n白：灯亮了。\n白：走廊空了。');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect((html.match(/class="chat-row/g) || []).length).toBe(2);   // 林薇 / 我（旁白走 .chat-narr，不算气泡行）
    expect((html.match(/class="chat-narr"/g) || []).length).toBe(1); // 两行旁白合并成一段
    expect(html.indexOf('一。')).toBeGreaterThan(-1);
    expect(html.indexOf('二。')).toBeGreaterThan(-1);
    const rowOf = (needle: string) => {
      const i = html.indexOf(needle);
      return html.slice(html.lastIndexOf('<div class="chat-row', i), html.indexOf('</div></div>', i));
    };
    expect(rowOf('我把笔放下')).toContain('chat-row-me');            // 主角（我）靠右
    expect(rowOf('她抬手把窗帘拉上')).not.toContain('chat-row-me');   // 其他角色靠左
    expect(html.indexOf('走廊空了')).toBeGreaterThan(-1);               // 旁白在页面里，但没有气泡行/头像
  });

  it('设了主角时按主角名靠右（只有主角那一条）', () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.append('ai', '林叶：我把信折好。\n林薇：「随便你。」');
    ChatMode.render();
    const html = els['chatStream'].innerHTML;
    expect(html.split('chat-row-me').length - 1).toBe(1);
    const i = html.indexOf('我把信折好');
    expect(html.slice(html.lastIndexOf('<div class="chat-row', i), i)).toContain('chat-row-me');
  });

  it('流式：末尾半截说话人前缀先扣住，不画进上一个气泡', () => {
    seedBooks();
    setupPreset(1000);
    expect(ChatMode._streamTail('林薇：「你好。」\n林')).toBe('林薇：「你好。」\n');
    expect(ChatMode._streamTail('林薇：「你好。」\n林薇：「你也好。」')).toBe('林薇：「你好。」\n林薇：「你也好。」');
    expect(ChatMode._streamTail('林薇：「你好。」\n她在门口停下')).toBe('林薇：「你好。」\n她在门口停下');
  });

  it('转正文：剥掉说话人前缀、保留「」台词，可整段或多条拼接', () => {
    seedBooks();
    setupPreset(1000);
    const m1 = ChatMode.append('ai', '林薇：「你怎么才来。」\n她把伞收起来。');
    const m2 = ChatMode.append('ai', '林叶：我把笔帽扣上。');
    expect(ChatMode.toProseText(m1.id)).toBe('「你怎么才来。」\n她把伞收起来。');
    expect(ChatMode.toProseText()).toBe('「你怎么才来。」\n她把伞收起来。\n\n我把笔帽扣上。');
  });
});

describe('重演 / 删除 / 换书', () => {
  it('撤回：本轮演出整条去掉，作者当轮写的要求放回输入框（上一轮的字不被覆盖丢）', async () => {
    seedBooks();
    setupPreset(1000);
    await ChatMode.generate('第一轮要求');
    const log1 = ChatMode.log();
    expect(log1).toHaveLength(2);
    const ta = els['chatInput'];
    ta.value = '这是没发出去的新内容';
    ChatMode.undo(log1[1].id);
    // 输入框有内容时会先确认；测试里 confirm 返回 true（见 stub）→ 覆盖为被撤回那轮的要求
    expect(ChatMode.log()).toHaveLength(0);
    expect(ta.value).toBe('第一轮要求');
  });

  it('撤回空指令的一轮：只去掉演出，不动输入框', async () => {
    seedBooks();
    setupPreset(1000);
    await ChatMode.generate('');
    expect(ChatMode.log()).toHaveLength(1);
    const ta = els['chatInput'];
    ta.value = '';
    ChatMode.undo(ChatMode.log()[0].id);
    expect(ChatMode.log()).toHaveLength(0);
    expect(ta.value).toBe('');
  });

  it('输入行左侧的 ↩（undoLast）：撤回最近一轮，当轮要求回到输入框；没演出时只提示', async () => {
    seedBooks();
    setupPreset(1000);
    ChatMode.undoLast();
    expect(g.App.toast).toHaveBeenCalled();                 // 没有可撤回的轮次 → 提示，不动记录
    await ChatMode.generate('第一轮要求');
    await ChatMode.generate('第二轮要求');
    expect(ChatMode.log().map(m => m.kind)).toEqual(['author', 'ai', 'author', 'ai']);
    els['chatInput'].value = '';
    ChatMode.undoLast();
    expect(ChatMode.log().map(m => m.raw)).toEqual(['第一轮要求', '林薇：「你怎么才来。」\n林叶：我把笔帽扣上。\n白：天暗了下来。']);
    expect(els['chatInput'].value).toBe('第二轮要求');
  });

  it('生成中：发送换成红色停止键（与写作页同一对按钮、同一个位置）', async () => {
    seedBooks();
    setupPreset(1000);
    // 异步返回，抢在回调前看按钮状态
    (APIHandler as any).fetchCompletions = (msgs: any[], onDelta: any, onOk: any) => {
      setTimeout(() => { onDelta('林薇：「一。」'); onOk('林薇：「一。」', false, ''); }, 0);
    };
    const p = ChatMode.generate('演一段');
    expect(els['chatSendBtn'].style.display).toBe('none');
    expect(els['chatStopBtn'].style.display).toBe('flex');
    await p;
    expect(els['chatSendBtn'].style.display).toBe('flex');
    expect(els['chatStopBtn'].style.display).toBe('none');
  });

  it('换书改当前书并重载（用真实的 BookManager）', () => {
    const { a, b } = seedBooks();
    ChatMode.append('ai', '甲书的内容');
    expect(WBM.getActiveId()).toBe(a);
    ChatMode.switchBook(b);
    expect(WBM.getActiveId()).toBe(b);
    expect(ChatMode.log()).toHaveLength(0);       // 乙书还没有记录
  });

  it('演出进归档（记忆参与）：剥掉说话人前缀、增量只写一次、新消息再补', () => {
    seedBooks();
    setupPreset(1000);
    const calls: Array<{ chunks: string[]; max: number }> = [];
    g.ArchiveStore = { addBlocks: (chunks: string[], max: number) => calls.push({ chunks, max }) };
    ChatMode.append('ai', '林薇：「一。」\n白：灯亮了。');
    ChatMode.syncArchive();
    expect(calls).toHaveLength(1);
    expect(calls[0].chunks.join('\n')).toContain('灯亮了。');
    expect(calls[0].chunks.join('\n')).not.toContain('林薇：');   // 前缀已剥掉，归档里是连续文本
    expect(calls[0].max).toBe(900);
    ChatMode.syncArchive();                                      // 幂等：没有新消息不再写
    expect(calls).toHaveLength(1);
    ChatMode.append('ai', '林叶：我把信折好。');
    ChatMode.syncArchive();
    expect(calls).toHaveLength(2);
    expect(calls[1].chunks.join('\n')).toContain('我把信折好。');
    delete g.ArchiveStore;
  });
});
