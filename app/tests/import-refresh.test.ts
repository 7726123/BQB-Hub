// 回归：导入世界书/角色卡后必须刷新编辑器（避免"新书里看到旧书正文"）。
// 复刻 agent-loop 的全局桩环境；FileReader mock 返回样本 JSON。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;

const wbm = WBM as unknown as Record<string, any>;
wbm.getAll = () => [];
wbm.getActiveId = () => null;
wbm.getActive = () => null;
wbm.saveAll = () => undefined;
wbm.setActiveId = () => undefined;
anyG.UIManager = { showConfirm: () => undefined, renderWorldBooks: () => undefined, renderWBEntries: () => undefined, closeModal: () => undefined, showModal: () => undefined };
anyG.DatabaseManager = { isEnabled: () => false };
anyG.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x.test/v1', apiKey: 'k', model: 'm' }) };
anyG.htmlEscape = (x: unknown) => String(x == null ? '' : x);
anyG.escapeHTML = (x: unknown) => String(x == null ? '' : x);

function el(): any {
  return {
    value: '', innerHTML: '', textContent: '', style: { setProperty() {}, display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    children: [], scrollTop: 0, checked: false, files: [],
    querySelector: () => el(), querySelectorAll: () => [],
  };
}

// FileReader mock：onload 拿 builder 生成的文本
function mockFileReader(build: () => string) {
  anyG.FileReader = class {
    result: string = '';
    onload: any = null;
    onerror: any = null;
    readAsText() { this.result = build(); setTimeout(() => this.onload && this.onload({ target: this }), 0); }
    readAsDataURL() { this.result = build(); setTimeout(() => this.onload && this.onload({ target: this }), 0); }
    readAsArrayBuffer() { this.result = build(); setTimeout(() => this.onload && this.onload({ target: this }), 0); }
  } as any;
}

beforeAll(async () => {
  await import('../src/domain/app');
  await import('../src/domain/api');
});

const els = new Map<string, any>();
const calls: string[] = [];

beforeEach(() => {
  els.clear(); calls.length = 0;
  const books: any[] = [];
  anyG.WorldBookManager = {
    getAll: () => books.slice(), getActiveId: () => null, getActive: () => null,
    saveAll: (arr: any[]) => { books.length = 0; (arr || []).forEach((x) => books.push(JSON.parse(JSON.stringify(x)))); },
    setActiveId: (id: string) => { (anyG.WorldBookManager as any).activeId = id; },
    getActiveWorldBook: () => null, isEnabled: () => false,
  };
anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), querySelectorAll: () => [], getElementsByClassName: () => [],
    addEventListener() {}, body: el(),
  };
  anyG.StorageManager = { get: (_k: string, d: unknown) => d, set: () => undefined, remove: () => undefined };
  (anyG as any).App.postMessage = undefined;
  // 打补丁到真实 App 实例（不替换，保留 handleImportWorldBook 等方法）
  const real = (anyG as any).App;
  real.toast = () => {};
  real.loadEditorContent = () => { calls.push('loadEditorContent'); };
  real.renderAll = () => { calls.push('renderAll'); };
  real.getBackendAPIConfig = () => null;
  real.getProtagonist = () => ({ name: '主角' });
});

const App = (): any => anyG.App;

describe('导入后刷新编辑器（防串正文回归）', () => {
  it('导入新世界书 JSON → loadEditorContent + renderAll 被调用', async () => {
    mockFileReader(() => JSON.stringify({ name: '测试新书', entries: [{ id: 'e1', type: '世界观', name: 'x', content: 'y' }] }));
    const app = App();
    // 直接触发 handleImportWorldBook（用真实 App 实例上的方法，避免 mock 里没有它）
    const realApp = (anyG as any).App;
    realApp.handleImportWorldBook({ target: { files: [{ name: 'a.json' }] } });
    await new Promise(r => setTimeout(r, 30));
    expect(calls).toContain('loadEditorContent');
    expect(calls).toContain('renderAll');
  });

  it('覆盖已存在的世界书（当前激活）→ 同样刷新编辑器', async () => {
    const books: any[] = [];
    const book = { id: 'wb_1', name: '旧书', entries: [] };
    books.push(book);
    const wbm2 = WBM as unknown as Record<string, any>;
    wbm2.getAll = () => books.slice();
    wbm2.getActiveId = () => 'wb_1';
    wbm2.getActive = () => book;
    wbm2.saveAll = (arr: any[]) => { books.length = 0; (arr || []).forEach((x) => books.push(JSON.parse(JSON.stringify(x)))); };
    wbm2.setActiveId = () => undefined;
    mockFileReader(() => JSON.stringify({ id: 'wb_1', name: '旧书', entries: [{ id: 'e2', type: '其他', name: '新', content: '覆盖内容' }] }));
    let confirmed: any = null;
    (anyG as any).UIManager.showConfirm = (msg: string, fn: () => void) => { confirmed = fn; };
    const realApp = (anyG as any).App;
    realApp.handleImportWorldBook({ target: { files: [{ name: 'a.json' }] } });
    await new Promise(r => setTimeout(r, 30));
    expect(confirmed).toBeTruthy();
    confirmed(); // 确认覆盖
    expect(calls).toContain('loadEditorContent');
    expect(WBM.getAll()[0].entries[0].content).toBe('覆盖内容');
  });
});