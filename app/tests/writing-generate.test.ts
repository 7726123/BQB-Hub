// 写作页「生成」链路的收尾不变量：一轮生成无论以哪种方式结束，
// isGenerating 都必须复位 —— generate() 开头是 `if (this.isGenerating) return;`，
// 一旦这个标志卡在 true，之后每次点「发送」都会静默无反应（正文不生成、连报错都没有），
// 只有重启 App 才能恢复。v1.5.90 用户报告的「按发送完全没反应」就是这个卡死状态。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { MINIMAL_PRESET_MODULES } from '../src/domain/preset';

// 真实 App 模块（import 时会把 App 挂到 globalThis）
await import('../src/domain/app');
const G = globalThis as any;
const App = G.App;

// ---- 迷你 DOM：任何 id 都给一个容忍写入的假元素（未知属性返回空函数，避免 null 解引用）----
function makeEl(id = 'el'): any {
  const store: any = {
    id, tagName: 'DIV', innerHTML: '', outerHTML: '', textContent: '', value: '', checked: false,
    disabled: false, style: {}, dataset: {}, children: [], childNodes: [],
    selectionStart: 0, selectionEnd: 0, scrollHeight: 10, clientHeight: 10, scrollTop: 0,
    offsetHeight: 10, offsetWidth: 10, files: [], className: '',
  };
  const noop = () => undefined;
  return new Proxy(store, {
    get(t, p) {
      if (typeof p === 'symbol') return (t as any)[p];
      if (p in t) return t[p];
      return noop;
    },
    set(t, p, v) { (t as any)[p] = v; return true; },
  });
}

const els: Record<string, any> = {};
const el = (id: string) => (els[id] ||= makeEl(id));

// 宽容单例桩：显式给的方法照用，未列出的方法一律返回空字符串（避免逐个补桩）
function tolerant<T extends object>(impl: T): T {
  return new Proxy(impl, {
    get(t, p) {
      if (typeof p === 'symbol') return (t as any)[p];
      if (p in t) return (t as any)[p];
      return () => '';
    },
    set(t, p, v) { (t as any)[p] = v; return true; },
  }) as T;
}

beforeEach(() => {
  G.document = {
    getElementById: (id: string) => el(id),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => makeEl('new'),
    body: makeEl('body'),
    documentElement: makeEl('html'),
    visibilityState: 'visible',
  };
  el('streamingOutput').checked = false;
  el('writingGuide').value = '';
  el('generationStatus').textContent = '';
  el('btnStop').style.display = 'none';

  // 全局单例（app.ts 通过 globalThis 读取，不入 import）
  G.EditorManager = tolerant({
    getContent: () => '', getPlainText: () => '', startStreaming: () => {}, appendStreaming: () => {},
    finishStreaming: () => {}, insertAtCursor: () => {}, cancelStreaming: () => {}, appendReasoning: () => {},
    _thinkingRequired: false,
  });
  G.PresetManager = tolerant({
    getActiveAPIConfig: () => ({ apiKey: 'k', model: 'test-model', endpoint: 'http://x/v1', temperature: 0.9 }),
    getCurrentPreset: () => null,
    getActiveSystemPrompt: () => '',
  });
  // 归档水位线（archive.ts 挂的全局；真实运行时一定存在）
  G.Waterline = tolerant({ update: () => ({ frozen: '', x: 0, head: 0, blockCount: 0 }), clear: () => {} });
  G.ArchiveStore = tolerant({ initStorage: () => Promise.resolve(), count: () => 0 });

  // App 自身方法的桩：把「取书/取主角/思考强度/落盘」等外部依赖摘掉，
  // 只保留 generate() 的流程与收尾逻辑（被测对象）
  App.isGenerating = false;
  App.getNovelData = () => ({});
  App.getProtagonist = () => ({ name: '主角' });
  App.thinkingLevel = () => 'off';
  App.saveCurrentChapter = () => {};
  App._uploadAdminTrace = () => {};
  App._bumpContinuationCount = () => {};
  // 注：_checkAndUpdateVars / updateSceneState 已于 v1.5.97.13 删除，不再需要打桩
  // （下面有回归用例守住它们不回来、场景状态也不进提示词）
  App.fillMemoryTable = () => Promise.resolve(0);
  App.reviewSettingDelta = () => {};
  App.getPricingConfig = () => ({ input: 0, cached: 0, output: 0 });
  App.toast = () => {};
  // 注意：_saveVarSnapshot / _restoreVarSnapshot **不打桩**——它们曾被漏实现（单 bundle 重构丢的），
  // generate() 第一步就调它，于是整个发送链路失效。这里保留真实实现作为回归护栏。
});

// 有的用例会把 App.generate 整体换成抛错桩（测"启动阶段抛错"），而 vi.restoreAllMocks()
// 只能还原 spy、还原不了普通属性赋值——不还原会污染后面的用例（曾让新增的视角用例全部抛 boom）。
const REAL_APP_GENERATE = App.generate;
afterEach(() => { vi.restoreAllMocks(); App.generate = REAL_APP_GENERATE; });

describe('写作页发送：生成轮次收尾必须复位 isGenerating', () => {
  it('空回复（HTTP 200 但没内容）后，isGenerating 必须复位，且下一次发送能真正发出请求', async () => {
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      // 对齐 api.ts 的真实行为：非 SSE 且解析不出内容时 onDone('', false)（"未收到有效回复"）
      fetchCompletions: vi.fn(async (msgs: any, _onChunk: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };

    await App.generate('autoContinue');
    expect(App.isGenerating).toBe(false);      // ← 修复前为 true（卡死）

    await App.generate('autoContinue');
    expect(calls.length).toBe(2);              // ← 修复前是 1：第二次被开头静默 return 掉
  });

  it('后置处理抛异常时，isGenerating 也必须复位（否则按钮永久无反应）', async () => {
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (_m: any, _c: any, onDone: any) => { onDone('正文一段。', false, ''); }),
    };
    App._bumpContinuationCount = () => { throw new Error('后置处理炸了'); };

    await App.generate('autoContinue');
    await new Promise((r) => setTimeout(r, 0));   // 后置处理是 fire-and-forget
    expect(App.isGenerating).toBe(false);
  });

  it('正常成功一轮（含后置处理）后，isGenerating 也要复位', async () => {
    let postDone = false;
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (_m: any, _c: any, onDone: any) => { onDone('正文一段。', false, ''); }),
    };
    App._bumpContinuationCount = () => { postDone = true; };

    await App.generate('autoContinue');
    await new Promise((r) => setTimeout(r, 0));
    expect(postDone).toBe(true);
    expect(App.isGenerating).toBe(false);
  });

  it('generate() 启动阶段就抛错时：复位标志并给出可见提示（不再静默无反应）', async () => {
    const toasts: string[] = [];
    App.toast = (m: any) => toasts.push(String(m));
    App.generate = () => Promise.reject(new Error('boom'));
    el('writingInput').value = '写点什么';

    App.sendFromWritingInput();
    await new Promise((r) => setTimeout(r, 0));

    expect(App.isGenerating).toBe(false);
    expect(toasts.join('|')).toContain('生成启动失败');
  });
});

// 主角占位符：世界书条目/角色卡里的 {{user}}/{user} 在发给模型前展开成主角名。
// 此前只有预设 systemPrompt 走替换（app.ts:988 那一段），而世界书内容是之后才拼进 _stableCtx 的，
// 从未经过替换——条目里的占位符会以字面量发给模型。写卡 agent 现在按规则原样保留占位符，
// 落到具体名字全靠这一层，所以这条链路必须有护栏。
describe('主角占位符 {{user}}/{user} → 主角名（发给模型前展开）', () => {
  it('世界书条目里的 {{user}}/{user}/{{ user }} 展开为主角名，{{char}} 仍换「其他角色」，裸 user 不动', () => {
    App.getProtagonist = () => ({ name: '陆离' });
    const expand = (G as any)._expandSTInMessages;
    expect(typeof expand).toBe('function');
    const messages: any[] = [
      { role: 'system', content: '### [其他] 初遇\n{{user}} 与 月宫绾音 初次见面，{user} 递上了伞。{{ user }} 的手在抖。' },
      { role: 'user', content: 'the user said hello（裸 user 不是占位符，不替换）' },
      { role: 'system', content: '{{char}} 对 {{user}} 抱有敌意。' },
    ];
    expand(messages);
    expect(messages[0].content).toContain('陆离 与 月宫绾音 初次见面，陆离 递上了伞。陆离 的手在抖。');
    expect(messages[0].content).not.toContain('{{user}}');
    expect(messages[1].content).toBe('the user said hello（裸 user 不是占位符，不替换）');
    expect(messages[2].content).toBe('其他角色 对 陆离 抱有敌意。');
  });
});

// 护栏：app.ts 里 `this.X(` 的自调用必须在 app/src 下有实现。
// 这类错误（调用留着、实现被重构丢掉）编译期不报、运行期才炸；而 generate() 第一步就调用
// _saveVarSnapshot()，一炸整个发送链路失效，用户看到的只是「点发送完全没反应」。
describe('App 自调用方法都必须有实现', () => {
  it('app.ts 中 this.X( 的每个 X 都能在 app/src 下找到定义', () => {
    const srcRoot = path.resolve(__dirname, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.ts')) files.push(p);
      }
    };
    walk(srcRoot);

    const defined = new Set<string>();
    const DEF = /^\s{2,}(?:async\s+|get\s+|set\s+)?(_?[A-Za-z][A-Za-z0-9_]*)\s*(?:\(|:\s*(?:function|\(|async))/gm;
    const ASSIGN = /\b(?:App|[A-Z][A-Za-z0-9_]*)\.(_?[A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:function|\()/g;
    const PL = /__pl\.(_?[A-Za-z][A-Za-z0-9_]*)\s*=/g;
    for (const f of files) {
      const raw = fs.readFileSync(f, 'utf8');
      for (const m of raw.matchAll(DEF)) defined.add(m[1]);
      for (const m of raw.matchAll(ASSIGN)) defined.add(m[1]);
      for (const m of raw.matchAll(PL)) defined.add(m[1]);
    }

    const appSrc = fs.readFileSync(path.join(srcRoot, 'domain', 'app.ts'), 'utf8');
    const missing = new Set<string>();
    for (const m of appSrc.matchAll(/\bthis\.(_?[A-Za-z][A-Za-z0-9_]*)\s*\(/g)) {
      if (!defined.has(m[1])) missing.add(m[1]);
    }
    expect([...missing]).toEqual([]);
  });
});
// 变量快照语义：撤回要「整表回滚」——本轮新加的键必须消失，不是合并。
describe('世界书变量快照：撤回时整表回滚', () => {
  it('快照后的新增键在回滚时被清除，旧值被还原', async () => {
    const { WorldBookManager } = await import('../src/domain/worldbook');
    const origGetActiveId = (WorldBookManager as any).getActiveId;
    (WorldBookManager as any).getActiveId = () => 'wb1';
    const mem = new Map<string, string>();
    G.StorageManager = {
      get: (k: string, d?: any) => (mem.has(k) ? JSON.parse(mem.get(k)!) : d),
      set: (k: string, v: any) => { mem.set(k, JSON.stringify(v)); },
    };
    mem.set('wbVariables', JSON.stringify({ wb1: { 好感: '10' } }));

    App._saveVarSnapshot();
    // 模拟一轮生成：新增变量 + 改旧变量
    mem.set('wbVariables', JSON.stringify({ wb1: { 好感: '87', 新键: 'x' } }));

    App._restoreVarSnapshot();
    const after = JSON.parse(mem.get('wbVariables') || '{}');
    expect(after.wb1).toEqual({ 好感: '10' });

    (WorldBookManager as any).getActiveId = origGetActiveId;
  });
});

// 一次点击只能触发一次发送：index.html 的 onclick 是唯一绑定来源。
// 曾经 mobile.ts 里又 addEventListener 了一次 → 第二次调用走「空输入」分支，
// 把刚写入的场景草稿清掉，并在 isGenerating 已置位时静默 return（草稿莫名消失）。
describe('写作发送按钮：绑定来源唯一', () => {
  it('index.html 有 onclick，且 mobile.ts 不再重复绑定', () => {
    const root = path.resolve(__dirname, '..', '..'); // app/.. = 仓库根
    const html = fs.readFileSync(path.join(root, 'web', 'index.html'), 'utf8');
    const mobile = fs.readFileSync(path.join(root, 'app', 'src', 'domain', 'mobile.ts'), 'utf8');
    expect(/id="writingSendBtn"[^>]*onclick="App\.sendFromWritingInput\(\)"/.test(html), 'onclick 绑定').toBe(true);
    expect(/getElementById\('writingSendBtn'\)[\s\S]{0,120}addEventListener/.test(mobile), '重复绑定').toBe(false);
  });
});

// 叙事视角只由预设的「视角」条目决定（preset.ts 的 min_09..min_12），App 不再硬编码视角指令。
// 回归背景：旧实现在「没选主角」时会往 user 指令里塞一整段"从任意角色视角展开＋视角切换规则"，
// 而默认预设开着「视角·第一人称」——两套视角同一次请求里都下发，且指令在 system 之后（更强），
// 结果就是视角自相矛盾、时对时错。改成：App 对视角不表态，主角只决定 {{user}} 与资料注入。
describe('叙事视角不由 App 硬编码', () => {
  const POV_WORDS = ['视角', '任意角色', '视角切换规则', '自然续写'];

  function instructionOf(msgs: any[]): string {
    const user = (msgs || []).filter((m) => m && m.role === 'user').pop();
    const content = String((user && user.content) || '');
    const i = content.indexOf('【指令】');
    return i >= 0 ? content.slice(i) : content;
  }

  async function instructionWith(protagonist: any): Promise<string> {
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _onChunk: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };
    App.getProtagonist = () => protagonist;
    App.isGenerating = false;
    await App.generate('autoContinue');
    return instructionOf(calls[0]);
  }

  it('续写指令里不出现任何视角字样（视角交给预设）', async () => {
    const instr = await instructionWith({ name: '夏洛' });
    expect(instr).toContain('请根据以上内容续写');
    for (const w of POV_WORDS) expect(instr, '不应含「' + w + '」').not.toContain(w);
  });

  it('有没有主角，指令完全一致（旧实现会变成多视角长指令）', async () => {
    const withProtag = await instructionWith({ name: '夏洛' });
    const withoutProtag = await instructionWith({});
    expect(withoutProtag).toBe(withProtag);
  });

  it('预设的视角条目照常进 system 提示词（App 只是不再另发一套）', async () => {
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _onChunk: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };
    G.PresetManager = tolerant({
      getActiveAPIConfig: () => ({ apiKey: 'k', model: 'test-model', endpoint: 'http://x/v1', temperature: 0.9 }),
      getCurrentPreset: () => null,
      getActiveSystemPrompt: () => '# 视角：第三人称·多线\n\n- 可以写任意角色的所见所想，可以在不同场景之间切换。',
    });
    App.getProtagonist = () => ({ name: '夏洛' });
    App.isGenerating = false;
    await App.generate('autoContinue');
    const systemText = (calls[0] || []).filter((m: any) => m.role === 'system').map((m: any) => String(m.content)).join('\n');
    expect(systemText).toContain('第三人称·多线');   // 视角来自预设，原样下发
  });
});

// 反 AI 味（min_20_ai_flavor）：v1.5.97.10 新增的内置预设条目 + 续写指令末尾的收尾强化。
// 分工：条目管「整篇别写机器腔」，指令末尾那一句管「章末别升华」——模型写长文时对 system 里
// 禁令的服从度会随篇幅下滑，而 user 指令贴着生成位置。
describe('反 AI 味：条目进 system，收尾在指令里强化', () => {
  async function instructionOnce(protagonist: any): Promise<string> {
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _onChunk: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };
    App.getProtagonist = () => protagonist;
    App.isGenerating = false;
    await App.generate('autoContinue');
    const user = (calls[0] || []).filter((m: any) => m && m.role === 'user').pop();
    const content = String((user && user.content) || '');
    const i = content.indexOf('【指令】');
    return i >= 0 ? content.slice(i) : content;
  }

  it('预设的「反 AI 味」条目真的进 system 提示词', async () => {
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _onChunk: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };
    G.PresetManager = tolerant({
      getActiveAPIConfig: () => ({ apiKey: 'k', model: 'test-model', endpoint: 'http://x/v1', temperature: 0.9 }),
      getCurrentPreset: () => ({
        id: 'preset_minimal', name: '轻小说·最小预设', prompts: [], createdAt: 0,
        promptModules: MINIMAL_PRESET_MODULES.map((m) => ({ ...m })),
      }),
      getActiveSystemPrompt: () => '',
    });
    App.getProtagonist = () => ({ name: '夏洛' });
    App.isGenerating = false;
    await App.generate('autoContinue');
    const systemText = (calls[0] || []).filter((m: any) => m.role === 'system').map((m: any) => String(m.content)).join('\n');
    expect(systemText).toContain('反 AI 味');
    expect(systemText).toContain('章末不总结');
  });

  it('续写指令末尾强化收尾（治章末升华/预告）', async () => {
    const instr = await instructionOnce({ name: '夏洛' });
    expect(instr).toContain('收尾停在动作、对白或画面上，不要总结、升华，也不要预告后文。');
  });
});

// v1.5.97.13：删掉两处"隐形"的额外模型调用——场景状态分析（每次生成后必跑一次、却没有 UI/开关，
// 作用已被「记忆」插件的数据库覆盖）与变量自动更新（变量条目类型早被 migrateEntryTypes() 并入「其他」，
// 永不触发）。这里守住：它们不回来，场景状态也不进提示词。
describe('场景状态分析与变量自动更新已删除', () => {
  it('两个方法不存在了，且一次生成只发一次 API 请求', async () => {
    expect(typeof (App as Record<string, unknown>).updateSceneState).toBe('undefined');
    expect(typeof (App as Record<string, unknown>)._checkAndUpdateVars).toBe('undefined');
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _c: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };
    App.getProtagonist = () => ({ name: '夏洛' });
    App.isGenerating = false;
    await App.generate('autoContinue');
    expect(calls).toHaveLength(1);
  });

  it('场景状态不再进提示词', async () => {
    // 用内存版 StorageManager（同本文件里变量快照用例的桩法），预先塞入一份旧场景状态
    const mem = new Map<string, string>();
    G.StorageManager = {
      get: (k: string, d?: any) => (mem.has(k) ? JSON.parse(mem.get(k)!) : d),
      set: (k: string, v: any) => { mem.set(k, JSON.stringify(v)); },
    };
    mem.set('sceneState', JSON.stringify({ location: '旧校舍', charactersPresent: ['夏洛'], tensionLevel: 8 }));
    const calls: any[] = [];
    G.APIHandler = {
      _apiCalls: [],
      abort: () => {},
      fetchCompletions: vi.fn(async (msgs: any, _c: any, onDone: any) => { calls.push(msgs); onDone('', false, ''); }),
    };
    App.getProtagonist = () => ({ name: '夏洛' });
    App.isGenerating = false;
    await App.generate('autoContinue');
    const all = (calls[0] || []).map((m: any) => String(m.content)).join('\n');
    expect(all).not.toContain('当前场景状态');
    expect(all).not.toContain('旧校舍');
  });
});
