// 平滑流式渲染：40ms/8字 匀速消费 + 思考块独立建框 + 帧内对话高亮 + 增量 DOM
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EditorManager } from '../src/domain/editor';

const anyG = globalThis as unknown as Record<string, unknown>;
anyG.App = { getProtagonist: () => ({ name: '主角' }), updateWordCount: () => {} };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
// 真实 normalizeQuotes（book.ts 导出）：editor.ts 流式曾对每帧单独跑“段内多余引号删除”，
// 导致跨帧拆开的「…」第二帧的」被误删（`「你好啊」我说` 流式变 `「你好啊我说`）。
// 桩若用直通函数会掩盖该回归，因此这里用真实实现。
import { normalizeQuotes as realNormalizeQuotes } from '../src/domain/book';
anyG.normalizeQuotes = realNormalizeQuotes;

// ---- 迷你 DOM stub ----
function makeEl(tag: string): any {
  const el: any = {
    tagName: tag.toUpperCase(),
    children: [],
    className: '',
    innerHTML: '',
    textContent: '',
    style: {},
    parentNode: null,
    nodeType: 1,
    appendChild(c: any) {
      if (c && c.parentNode && c.parentNode !== el) { // 真 DOM 语义：追加即从旧父节点移除
        const pi = c.parentNode.children.indexOf(c);
        if (pi >= 0) c.parentNode.children.splice(pi, 1);
      }
      if (c && c.tagName === 'FRAG') { // 展开 fragment 子节点（对齐真 DOM 语义）
        c.children.slice().forEach((x: any) => { x.parentNode = el; x.parentElement = el; el.children.push(x); });
        c.children.length = 0; // fragment 清空
        return c;
      }
      c.parentNode = el; c.parentElement = el; el.children.push(c); return c;
    },
    replaceChild(nw: any, old: any) { // 完成态对白高亮原位替换文本节点
      const i = el.children.indexOf(old);
      if (i < 0) return old;
      el.children.splice(i, 1);
      const add = (c: any, at: number) => { c.parentNode = el; c.parentElement = el; el.children.splice(at, 0, c); };
      if (nw && nw.tagName === 'FRAG') nw.children.slice().forEach((x: any, k: number) => add(x, i + k));
      else add(nw, i);
      return old;
    },
    append(...cs: any[]) { cs.forEach((c: any) => el.appendChild(c)); },
    removeChild(c: any) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    remove() {},
    addEventListener() {},
    closest() { return null; },
    querySelector() { return null; },
    setAttribute() {},
    get firstChild() { return el.children[0] || null; },
    // 完成态/流式高亮用 frag.childNodes.length —— stub 必须提供 childNodes（缺了会 undefined.length）
    get childNodes() { return el.children; },
    get scrollHeight() { return 0; },
    // _commitFinished 视口锚定：锚点 top=0、滚动容器 bottom 足够大 → 视为可见（delta 补偿走零差）
    getBoundingClientRect() { return { top: 0, bottom: 999999, left: 0, right: 0, width: 0, height: 0 }; },
    click() {},
  };
  Object.defineProperty(el, 'textContent', {
    get() { return el.children.map((c: any) => c.nodeType === 3 ? c.nodeValue : c.textContent || '').join(''); },
    set(v: string) { el.children = [makeText(v)]; },
  });
  // innerHTML 语义化：赋值重建为单个文本子节点（_commitFinished 补回路径 _div.innerHTML=… 依赖）
  let _html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return _html; },
    set(v: unknown) {
      _html = String(v ?? '');
      const n = makeText(_html);
      n.parentNode = el; n.parentElement = el; // 挂靠父节点，appendChild 的移除语义才能生效
      el.children = [n];
    },
  });
  return el;
}
function makeText(v: string): any {
  return { nodeType: 3, nodeValue: v, textContent: v, parentNode: null, parentElement: null };
}

beforeEach(() => {
  vi.useFakeTimers();
  const els = new Map<string, any>();
  const editorEl = makeEl('div');
  anyG.document = {
    getElementById: (id: string) => { if (id === 'editor') return editorEl; return null; },
    createElement: (t: string) => makeEl(t),
    createTextNode: (t: string) => makeText(t),
    createDocumentFragment: () => makeEl('frag'),
    createRange: () => ({ setStartAfter() {}, collapse() {} }),
    createTreeWalker: (root: any) => { // 快照式文本节点遍历（SHOW_TEXT 语义）
      const out: any[] = [];
      (function walk(n: any) { (n.children || []).forEach((c: any) => { if (c.nodeType === 3) out.push(c); else walk(c); }); })(root);
      let i = 0;
      return { nextNode: () => (i < out.length ? out[i++] : null) };
    },
    execCommand: () => false,
    addEventListener() {},
    body: makeEl('body'),
  } as any;
  anyG.window = globalThis;
  anyG.NodeFilter = { SHOW_TEXT: 4 }; // _commitFinished 对白高亮的 createTreeWalker 参数
  anyG.getComputedStyle = () => ({ overflowY: 'visible' }); // _scrollParentOf：stub 层级无滚动容器
  anyG.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  anyG.requestAnimationFrame = (fn: any) => fn();
  // 重置 EditorManager 流式状态
  EditorManager.editorEl = editorEl;
  EditorManager.lastWrapper = null;
  EditorManager.lastBr = null;
  EditorManager._streamingWrapper = null;
  EditorManager._streamingBr = null;
  EditorManager._streamingTimer = null;
  EditorManager._streamingRaw = '';
  EditorManager._pendingStream = '';
  EditorManager._tokenHold = '';
  EditorManager._streamThinkBox = null;
  EditorManager._streamSink = null;
  EditorManager._dashCount = 0;
  EditorManager._streamingScrolled = true; // 跳过 rAF 滚动
});

afterEach(() => { vi.useRealTimers(); });

const sinkText = () => (EditorManager._streamSink ? EditorManager._streamSink.textContent : '');
const thinkCount = () => (EditorManager._streamThinkBox ? EditorManager._streamThinkBox.children.length : 0);

// =====================================================================================
// 世界书「变量」：<status> 回报块的上屏过滤（sink 是最终正文，收口点再剥已经来不及）。
// 未启用变量条目时必须逐字节直通；启用后块不上屏、正文一字不差、完成提交也不留块。
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import '../src/infra/storage';

describe('变量回报块的流式过滤（世界书「变量」条目）', () => {
  function seedVarBook(on: boolean) {
    WBM.saveAll([]);
    const b = WBM.createBook('变量流式书');
    const all = WBM.getAll();
    all.find((w) => w.id === b.id)!.entries = on
      ? [{ id: 'v1', type: '变量', name: '任务数量', content: '每月 10 次；用完为止。' }]
      : [];
    WBM.saveAll(all);
    WBM.setActiveId(b.id);
  }
  afterEach(() => { try { WBM.saveAll([]); WBM.setActiveId(null); } catch (e) { /* ignore */ } });

  it('没启用变量条目 → 原样上屏（对不使用该功能的书零变化）', () => {
    seedVarBook(false);
    EditorManager.startStreaming();
    EditorManager.appendStreaming('正文。<status>\n任务数量：7\n</status>');
    vi.advanceTimersByTime(500);
    expect(sinkText()).toContain('<status>');
    expect(sinkText()).toContain('任务数量：7');
  });

  it('启用后：块不上屏（含跨分片劈开的标记），正文一字不差', () => {
    seedVarBook(true);
    EditorManager.startStreaming();
    const parts = ['苏黎推开门。', '<sta', 'tus>\n任务数量：7\n</sta', 'tus>\n', '她说了那句话。'];
    parts.forEach(p => EditorManager.appendStreaming(p));
    vi.advanceTimersByTime(1000);
    const seen = sinkText();
    expect(seen).not.toContain('<status>');
    expect(seen).not.toContain('任务数量');
    expect(seen.replace(/\s/g, '')).toBe('苏黎推开门。她说了那句话。');
  });

  it('完成提交：块不残留、正文恰好一次、扣留字符不丢', () => {
    seedVarBook(true);
    EditorManager.startStreaming();
    EditorManager.appendStreaming('苏黎推开门。\n<status>\n任务数量：7\n</status>');
    vi.advanceTimersByTime(40);               // 只消费第一帧，其余压在 _pendingStream（完成瞬间常态）
    const sinkEl = EditorManager._streamSink!;
    EditorManager._commitFinished('苏黎推开门。', null);
    expect(sinkEl.textContent!.replace(/\s/g, '')).toBe('苏黎推开门。');   // 不重复、不缺字
    expect(sinkEl.textContent).not.toContain('任务数量');
  });

  it('收尾时若扣留的是真正文（孤立 <），必须吐回而不是丢掉', () => {
    seedVarBook(true);
    EditorManager.startStreaming();
    EditorManager.appendStreaming('他写下 a<');
    vi.advanceTimersByTime(40);
    const sinkEl = EditorManager._streamSink!;
    EditorManager._commitFinished('他写下 a<', null);
    expect(sinkEl.textContent).toBe('他写下 a<');
  });
});

describe('平滑流式渲染', () => {
  it('正文每 40ms 匀速消费 8 字（大块突发 → 打字机）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('一'.repeat(28));
    vi.advanceTimersByTime(40);   // 第 1 帧 → 8
    expect(sinkText().length).toBe(8);
    vi.advanceTimersByTime(40);   // 第 2 帧 → 16
    expect(sinkText().length).toBe(16);
    vi.advanceTimersByTime(40);   // 第 3 帧 → 24
    expect(sinkText().length).toBe(24);
    vi.advanceTimersByTime(40);   // 第 4 帧 → 28（消费完）
    expect(sinkText().length).toBe(28);
  });

  it('思考注释块一次建框（不节流），且正文不进框', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<!-- 梳理：\n这是一段很长的思考内容啊。\n-->正文开始了。');
    vi.advanceTimersByTime(40);
    expect(thinkCount()).toBe(1); // details 一次建成
    expect(sinkText()).toContain('正文开始了。');
    expect(sinkText()).not.toContain('思考内容');
  });

  it('帧内完整「」对话 → span.dialogue 高亮', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('他说：「好」然后离开。');
    vi.advanceTimersByTime(40);
    const sink = EditorManager._streamSink!;
    const span = Array.from(sink.children).find((c: any) => c.tagName === 'SPAN' && c.className === 'dialogue');
    expect(span).toBeTruthy();
    expect(span!.textContent).toBe('「好」');
  });

  it('跨帧拆开的「…」：第二帧的」不被删（真实 normalizeQuotes 下字符完整保留）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('「你好啊');
    vi.advanceTimersByTime(60);
    EditorManager.appendStreaming('」我说。');
    vi.advanceTimersByTime(120);
    const sink2 = EditorManager._streamSink!;
    // 回归点：normalizeQuotes 的“段内多余引号删除”若对每帧单独执行，
    // 帧2 `」我说。` 单独成段（无开着的「）会把」删掉，导致 `「你好啊我说。`（闭合丢失）。
    // 修复后流式只做归一化，字符完整：`「你好啊」我说。`
    expect(sink2.textContent).toContain('「你好啊」我说。');
    expect(EditorManager._pendingStream).toBe('');
  });

  it('跨帧「打开即高亮（流式期间 dialogue span 已出现），直到」闭合，字符完整', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('她说：「话还没说');
    vi.advanceTimersByTime(60);
    const sink1 = EditorManager._streamSink!;
    // 新行为：流式期间「一出现即建 dialogue span（打开即高亮），跨帧持续追加——不再等闭合
    expect(Array.from(sink1.children).some((c: any) => c.className === 'dialogue')).toBe(true);
    EditorManager.appendStreaming('完」就走了。');
    vi.advanceTimersByTime(120);
    const sink2 = EditorManager._streamSink!;
    expect(sink2.textContent).toContain('话还没说完」就走了。'); // 内容完整保留
    expect(EditorManager._pendingStream).toBe(''); // 队列消费完
  });

  it('未闭合「梳理」注释实时进蓝框（流式期间可见），跨帧持续追加，闭合后收尾', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<!-- 梳理：');
    vi.advanceTimersByTime(40);
    expect(thinkCount()).toBe(1);
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('梳理：');
    EditorManager.appendStreaming('这是正在进行的思考内容');
    vi.advanceTimersByTime(60);
    expect(thinkCount()).toBe(1);
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('这是正在进行的思考内容');
    EditorManager.appendStreaming('-->正文来了。');
    vi.advanceTimersByTime(80);
    expect(thinkCount()).toBe(1);
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('这是正在进行的思考内容');
    expect(EditorManager._openThink).toBeNull();
    expect(sinkText()).toContain('正文来了。');
  });

  it('cancelStreaming 清理队列与容器', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('一些文本');
    EditorManager.cancelStreaming();
    expect(EditorManager._streamingWrapper).toBeNull();
    expect(EditorManager._pendingStream).toBe('');
  });

  it('API 原生思维链 appendReasoning 实时进思考框（opencode v4flash 首字快的通道）', () => {
    EditorManager.startStreaming();
    EditorManager.appendReasoning('吾有一梦，今方始筑：');
    expect(EditorManager._openThink).not.toBeNull(); // 建实时框
    const thinkCount = () => (EditorManager._streamThinkBox?.children || []).length;
    expect(thinkCount()).toBe(1);
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('吾有一梦，今方始筑：');
    // 跨帧持续追加
    EditorManager.appendReasoning('一、检设定……');
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('一、检设定');
    expect(thinkCount()).toBe(1); // 不建新框
    // 正文照常走正文流（reasoning 不进正文）
    EditorManager.appendStreaming('正文第一段。');
    vi.advanceTimersByTime(60);
    const sinkText = () => (EditorManager._streamSink?.textContent || '');
    expect(sinkText()).toContain('正文第一段');
    // 思考框内容仍在（reasoning 独立通道）
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('一、检设定');
  });

  // ---- 补丁考古回归组：结尾重复 bug 同型复发 3 次（v1.5.25 / v1.5.26 / v1.5.40），锁定可观测契约 ----

  it('v1.5.40 回归：完成提交时缓冲必须排空——结尾恰好出现一次，不残留定时器', () => {
    EditorManager.startStreaming();
    const T = '第一段她说她要走。第二段雨还在下。';
    for (let i = 0; i < T.length; i += 8) EditorManager.appendStreaming(T.slice(i, i + 8));
    vi.advanceTimersByTime(40); // 只消费第 1 帧，其余压在 _pendingStream（真实完成瞬间常态）
    const seen = sinkText();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(T.length);
    const sinkEl = EditorManager._streamSink!; // 提交后 _streamSink 会被置空，先捕获
    EditorManager._commitFinished('<details class="cot-thinking"><summary>思维链</summary>x</details>' + T, null);
    expect(EditorManager._pendingStream).toBe('');          // 已排空
    expect(EditorManager._streamingTimer).toBeNull();       // 不再有无主定时器（晚到 flush = 旧重复根因）
    expect(sinkEl.textContent).toBe(T);                     // 完整且恰好一次
    expect(sinkEl.textContent!.split('雨还在下').length - 1).toBe(1);
  });

  it('v1.5.40 回归：补尾切口按紧凑长度映射回原始下标——换行不再把切口前推出重叠段', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('第一段\n\n第二段\n\n她');
    vi.advanceTimersByTime(500);
    expect(sinkText()).toBe('第一段\n\n第二段\n\n她');
    const sinkEl = EditorManager._streamSink!;
    EditorManager._commitFinished('<details class="cot-thinking"><summary>思维链</summary>x</details>第一段\n\n第二段\n\n她走了。', null);
    const t = sinkEl.textContent!;
    expect(t.replace(/\s/g, '')).toBe('第一段第二段她走了。');
    expect((t.match(/段/g) || []).length).toBe(2); // 旧缺陷切口前移会多渲染一个「段」
    expect(t.split('她走了').length - 1).toBe(1);
  });

  it('v1.5.25 回归：流式半角引号与完成态「」按交替配对视为等价——不触发整段补回', () => {
    EditorManager.startStreaming();
    const T = '她说："你好"。再见。';
    EditorManager.appendStreaming(T);
    vi.advanceTimersByTime(500);
    const sinkEl = EditorManager._streamSink!;
    EditorManager._commitFinished('<details class="cot-thinking"><summary>思维链</summary>x</details>她说：「你好」。再见。', null);
    expect(sinkEl.textContent!.split('再见').length - 1).toBe(1); // 旧缺陷：整体比较不等 → 正文两遍
    expect(sinkEl.textContent).toContain('你好');
  });

  it('漏闭合思考吞正文：完成态 sink 为空 → 用 html 正文整体补回（正文优先）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<!-- 梳理：\n推理到一半');
    vi.advanceTimersByTime(100);
    expect(sinkText()).toBe(''); // 全被吞进思考框
    const sinkEl = EditorManager._streamSink!;
    EditorManager._commitFinished('<details class="cot-thinking"><summary>思维链</summary>x</details>她转身离开。', null);
    expect(sinkEl.textContent).toContain('她转身离开。');
  });

  // 回归（v1.5.90）：末尾"疑似标记前缀"（'-' 是 '-->' 的前缀、'【' 是 '【正文】' 的前缀）
  // 被扣留后，下一轮扫描把它插到了**未消费前文之前** → 末尾字符顺序颠倒：
  // 单帧 "abcdefghi-" 上屏成 "abcdefgh-i"（属性测试反例，缩到最小就是它）。
  it('回归：末尾扣留的前缀不得打乱字符顺序（单帧 / 分段到达）', () => {
    const flushAll = () => {
      let guard = 0;
      while ((EditorManager._pendingStream || EditorManager._tokenHold) && guard++ < 5000) vi.advanceTimersByTime(40);
    };
    const read = (chunks: string[]): string => {
      EditorManager.startStreaming();
      for (const c of chunks) EditorManager.appendStreaming(c);
      flushAll();
      const sinkEl = EditorManager._streamSink;
      EditorManager._commitFinished('', null);
      return sinkEl ? (sinkEl.textContent || '') : '';
    };
    const cases: string[][] = [
      ['abcdefghi-'],            // 9 字：'-' 被扣留
      ['abcdefghij-'],           // 11 字：扣留后越过一帧边界
      ['hello world-'],          // 12 字
      ['abcdefgh中-'],
      ['abcdefg中文-'],
      ['她推门而入，我说-'],
      ['abc', 'defghi-'],        // 分段：扣留发生在第二段
      ['abcd--'],                // '--' 是 '-->' 的更长前缀
      ['前后文都正常，只是结尾带了一个破折号-'],
    ];
    for (const chunks of cases) {
      const want = chunks.join('');
      expect(read(chunks), JSON.stringify(chunks)).toBe(want);
    }
  });

  // ---- fast-check 属性测试：流式分帧不变量（v1.5.15 跨帧「」类的机器化猎场） ----
  it('属性：任意分帧方式下 sink 输出逐字一致（不丢字、不重排 = 分帧无关）', async () => {
    const fc = (await import('fast-check')).default;
    // 随机输入排除三类"不属于本不变量"的东西（历史上正是它们让整套测试偶发假红）：
    //  ① sink 有意做通道归属改写的输入：'<!--'（注释被剥离）、'<think'（思考通道）；
    //  ② 帧边界替换语义：'{'（0x7B）、'——'（0x2014，破折号上限计数）；
    //  ③ 引号类字符（" “ ” « »）：sink 按"段内配对 + 半角引号开/闭交替"处理，多余的会被删除，
    //     不是逐字符替换能表达的模型——这类语义由本文件 v1.5.15 / v1.5.25 的定向用例覆盖。
    // 排除之后不变量就干净了：任意文本任意分帧，上屏文本必须与原文逐字相同（不丢字、不重排）。
    const QUOTE_CHARS = '\u0022\u201c\u201d\u00ab\u00bb';
    const unmodelable = (s: string) => s.includes('<!--') || s.includes('<think');
    const charArb = fc.integer({ min: 0x20, max: 0x9FFF })
      .filter((c) => c !== 0x2014 && c !== 0x7B && !QUOTE_CHARS.includes(String.fromCodePoint(c)))
      .map((c) => String.fromCodePoint(c));
    const textArb = fc.string({ unit: charArb, size: 'small' }).filter((s) => !unmodelable(s));
    // 排空缓冲：pending 与"跨 chunk 标记前缀扣留"都要排空（扣留内容在完成提交时释放）
    const flushAll = () => {
      let guard = 0;
      while ((EditorManager._pendingStream || EditorManager._tokenHold) && guard++ < 5000) vi.advanceTimersByTime(40);
    };
    // 收尾用完成提交（_commitFinished 会把扣留的前缀并回正文），而非 cancelStreaming（中止本就丢弃）。
    // 注意提交会清空 _streamSink 引用，需在提交前抓住容器再读文本。
    const commitAndRead = (): string => {
      flushAll();
      const sinkEl = EditorManager._streamSink;
      EditorManager._commitFinished('', null);
      return sinkEl ? (sinkEl.textContent || '') : '';
    };
    // 每轮清空正文容器（stub DOM）：连续多轮流式会累积编辑器内容，
    // 不清就是"接着上一轮写"，而本属性每轮都应当是独立的一次生成。
    const resetEditorDom = () => {
      const el = (globalThis as unknown as { document: { getElementById(id: string): { children: unknown[] } | null } }).document.getElementById('editor');
      if (el) el.children = [];
    };
    fc.assert(fc.property(textArb, fc.array(fc.integer({ min: 1, max: 7 }), { maxLength: 40 }), (s, cuts) => {
      resetEditorDom();
      EditorManager.startStreaming();
      let pos = 0;
      for (const cut of cuts) {
        if (pos >= s.length) break;
        const n = Math.min(cut, s.length - pos);
        EditorManager.appendStreaming(s.slice(pos, pos + n));
        pos += n;
      }
      if (pos < s.length) EditorManager.appendStreaming(s.slice(pos));
      const chunked = commitAndRead();
      expect(chunked).toBe(s); // 分帧方式不影响最终文本（跨帧状态机无泄漏、不丢字、不重排）
    }), { numRuns: 60 });
  });
});

// 思考协议：思考长度不参与任何判定（思维链可能上万字），边界只认 `</thinking>` 与 `【正文】`
describe('思考协议（长度不参与判定）', () => {
  it('超长思考（约 1 万字）+ 正常闭合：全部进思考框，正文零残留', () => {
    EditorManager.startStreaming();
    const cot = '推演'.repeat(5000); // 10000 字
    EditorManager.appendStreaming('<thinking>\n' + cot);
    vi.advanceTimersByTime(120);
    expect(thinkCount()).toBe(1);
    expect(EditorManager._streamThinkBox!.children[0].textContent!.length).toBeGreaterThanOrEqual(10000);
    expect(sinkText()).toBe(''); // 一个字都不许漏进正文（旧 400 字逃逸会在此漏掉大半）
    EditorManager.appendStreaming('\n</thinking>\n【正文】\n她转身离开。');
    vi.advanceTimersByTime(200);
    expect(sinkText()).toContain('她转身离开。');
    expect(sinkText()).not.toContain('推演');
    expect(sinkText()).not.toContain('【正文】');
    expect(EditorManager._openThink).toBeNull();
  });

  it('未闭合思考 + `【正文】` 标记（跨 chunk 分帧）→ 标记处切分，正文完整且标记不上屏', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<thinking>\n推理中…');
    vi.advanceTimersByTime(60);
    EditorManager.appendStreaming('【正'); // 标记被网络分帧劈开
    vi.advanceTimersByTime(60);
    EditorManager.appendStreaming('文】\n正文第一段。');
    vi.advanceTimersByTime(200);
    expect(EditorManager._openThink).toBeNull(); // 标记到达即闭合思考框
    expect(sinkText()).toContain('正文第一段。');
    expect(sinkText()).not.toContain('【正文】');
    expect(EditorManager._streamThinkBox!.children[0].textContent).toContain('推理中…');
  });

  it('未闭合思考无标记：流式期间内容留在思考框，正文为空（不按长度逃逸）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<thinking>\n' + '推理'.repeat(300)); // 600 字 > 旧 400 字阈值
    vi.advanceTimersByTime(300);
    expect(sinkText()).toBe('');
    expect(thinkCount()).toBe(1);
    expect(EditorManager._openThink).not.toBeNull();
  });

  it('完成提交不再生产"框里一份 + 正文一份"（app 层把未闭合思考放进框时，正文保持为空）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<!-- 梳理：\n推理到一半');
    vi.advanceTimersByTime(100);
    const sinkEl = EditorManager._streamSink!;
    EditorManager._commitFinished('<details class="cot-thinking" contenteditable="false"><summary>思考</summary>推理到一半</details>', null);
    expect(sinkEl.textContent).toBe('');
  });
});

describe('流式 SETTING_DELTA 过滤（Agent 设定同步块不上屏）', () => {
  const flushAll2 = () => {
    let guard = 0;
    while (EditorManager._pendingStream && guard++ < 5000) vi.advanceTimersByTime(40);
  };

  it('完整 delta 块不上屏，正文保留', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('他握紧了断剑。\n[SETTING_DELTA][{"op":"add","target":"断剑","content":"已断"}][/SETTING_DELTA]\n雨停了。');
    flushAll2();
    expect(sinkText()).toContain('他握紧了断剑。');
    expect(sinkText()).toContain('雨停了。');
    expect(sinkText()).not.toContain('SETTING_DELTA');
    expect(sinkText()).not.toContain('断剑"');
    EditorManager.cancelStreaming();
  });

  it('空数组块 [SETTING_DELTA][][/SETTING_DELTA] 不上屏', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('第一段。\n[SETTING_DELTA][][/SETTING_DELTA]\n第二段。');
    flushAll2();
    expect(sinkText()).toContain('第一段。');
    expect(sinkText()).toContain('第二段。');
    expect(sinkText()).not.toContain('SETTING_DELTA');
    EditorManager.cancelStreaming();
  });

  it('跨 chunk 分帧到达的 delta 块也被完整丢弃', () => {
    EditorManager.startStreaming();
    const parts = ['正文开', '头。[SETTING_', 'DELTA][{"op":"add","target":"x",', '"content":"y"}][/SETTING_DELTA]结尾。'];
    for (const p of parts) EditorManager.appendStreaming(p);
    flushAll2();
    expect(sinkText()).toContain('正文开头。');
    expect(sinkText()).toContain('结尾。');
    expect(sinkText()).not.toContain('SETTING_DELTA');
    expect(sinkText()).not.toContain('"content"');
    EditorManager.cancelStreaming();
  });

  it('残缺块（无闭标签到文末）也被丢弃，不残留 [SETTING_DELTA]', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('正文推进中[SETTING_DELTA][{"op":"add","target":"x","content":"y"}');
    flushAll2();
    expect(sinkText()).toContain('正文推进中');
    expect(sinkText()).not.toContain('SETTING_DELTA');
    EditorManager.cancelStreaming();
  });

  it('多行格式化 JSON 的 delta 块也被完整丢弃（块内换行不提前恢复正文）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('正文结束。\n[SETTING_DELTA][\n  {"op":"add","target":"x",\n  "content":"y"\n}\n][/SETTING_DELTA]');
    flushAll2();
    expect(sinkText()).toContain('正文结束。');
    expect(sinkText()).not.toContain('SETTING_DELTA');
    expect(sinkText()).not.toContain('"op"');
    EditorManager.cancelStreaming();
  });

  it('被丢弃的 delta 仍计入 _streamingRaw（供 onDone 解析），且状态跨轮重置', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('前文[SETTING_DELTA][{"op":"del","target":"旧条"}][/SETTING_DELTA]后文');
    flushAll2();
    // _streamingRaw 保留原文（onDone 用 fullContent 解析，这里验证丢弃不破坏 raw）
    expect(EditorManager._streamingRaw).toContain('SETTING_DELTA');
    expect(EditorManager._discardingDelta).toBe(false);
    EditorManager.cancelStreaming();
    // cancel 后状态重置，新一轮正常
    EditorManager.startStreaming();
    EditorManager.appendStreaming('新轮正文');
    flushAll2();
    expect(sinkText()).toBe('新轮正文');
    expect(EditorManager._discardingDelta).toBe(false);
    EditorManager.cancelStreaming();
  });

  // 线上问题：模型写成 SETTINGS_DELTA（复数）/ SERIES_DELTA 等变体时，字面量过滤失效 → 标记上屏。
  it('标记变体（SETTINGS_DELTA/SERIES_DELTA）的块不上屏', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('正文一。\n[SETTINGS_DELTA][{"op":"add","target":"x","content":"y"}][/SETTINGS_DELTA]\n正文二。');
    flushAll2();
    expect(sinkText()).toContain('正文一。');
    expect(sinkText()).toContain('正文二。');
    expect(sinkText()).not.toMatch(/DELTA/i);
    expect(sinkText()).not.toContain('"content"');
    EditorManager.cancelStreaming();
  });

  it('变体标记跨 chunk 到达（含开/闭拼写不一致）也被丢弃', () => {
    EditorManager.startStreaming();
    const parts = ['雨停了。[SERI', 'ES_DELTA][{"op":"add","targ', 'et":"x","content":"y"}][/SETTINGS_DELTA]他走了。'];
    for (const p of parts) EditorManager.appendStreaming(p);
    flushAll2();
    expect(sinkText()).toContain('雨停了。');
    expect(sinkText()).toContain('他走了。');
    expect(sinkText()).not.toMatch(/DELTA/i);
    EditorManager.cancelStreaming();
  });

  it('漏闭的变体残块不复现到屏上', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('正文推进中[SERIES_DELTA][{"op":"add","target":"x","content":"y"}');
    flushAll2();
    expect(sinkText()).toContain('正文推进中');
    expect(sinkText()).not.toMatch(/DELTA/i);
    expect(sinkText()).not.toContain('"content"');
    EditorManager.cancelStreaming();
  });

  it('正文普通方括号不被扣留（[重要] 等照常上屏）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('他写下[重要]两字，然后笑了。');
    flushAll2();
    expect(sinkText()).toContain('[重要]');
    expect(sinkText()).toContain('然后笑了');
    EditorManager.cancelStreaming();
  });
});
// 回归：闭合思考块之后紧跟的 `【正文】` 标记必须在流式层剥掉（真机 mock 暴露）
describe('闭标记 + 正文标记（分帧）', () => {
  it('两段式到达：<thinking>…长思考 与 </thinking>+【正文】+正文 分两个 chunk', () => {
    EditorManager.startStreaming();
    const cot = '推演：'.repeat(2000);
    EditorManager.appendStreaming('<thinking>\n' + cot);
    vi.advanceTimersByTime(120);
    EditorManager.appendStreaming('\n</thinking>\n【正文】\n雨点敲在伞面上。');
    vi.advanceTimersByTime(200);
    expect(sinkText()).toBe('雨点敲在伞面上。');
    expect(sinkText()).not.toContain('【正文】');
    expect(sinkText()).not.toContain('</thinking>');
  });
  it('同一 chunk 到达（整体闭合 + 标记）', () => {
    EditorManager.startStreaming();
    EditorManager.appendStreaming('<thinking>\n短思考\n</thinking>\n【正文】\n正文一。');
    vi.advanceTimersByTime(200);
    expect(sinkText()).toBe('正文一。');
  });
});

// 回归：极快端点把整段回复在两帧之间送完 → 提交时的排空必须仍走思考/正文分离
describe('完成提交排空（未跑过帧的极端时序）', () => {
  it('整段一次性到达（不推进任何帧）→ 思考进框、正文干净、标记不上屏', () => {
    EditorManager.startStreaming();
    const cot = '推演：'.repeat(2000);
    // 注意：不 advanceTimers（模拟 onDone 先于 40ms 帧到达）
    EditorManager.appendStreaming('<thinking>\n' + cot + '\n</thinking>\n【正文】\n雨点敲在伞面上。');
    const sinkEl = EditorManager._streamSink!;
    const boxEl = EditorManager._streamThinkBox!;
    EditorManager._commitFinished('<details class="cot-thinking" contenteditable="false"><summary>思考</summary>' + cot + '</details>\n雨点敲在伞面上。', null);
    expect(sinkEl.textContent).toBe('雨点敲在伞面上。');
    expect(sinkEl.textContent).not.toContain('<thinking>');
    expect(sinkEl.textContent).not.toContain('【正文】');
    expect(boxEl.textContent).toContain('推演：');
  });
});
