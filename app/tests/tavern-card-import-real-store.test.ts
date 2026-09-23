// 回归（v1.5.88 真凶）：酒馆卡导入必须落条目 —— 走真实存储 + 真实 WorldBookManager，**不桩适配器**。
//
// 背景：app.ts 曾用 `globalThis.TavernAdapter` 取适配器，而 tavern-adapter.ts 从不挂全局
// （单 bundle 改造后成了纯 ES 模块，cardwriter 用 import 正常，app.ts 读到 undefined）——
// 于是「世界书 → 导入角色卡」一路静默降级：只建了一本空书，卡内世界书条目一条都不落。
// 教训：这类测试**不要**给被测依赖打桩（早期探针手工给 globalThis.TavernAdapter 赋值，
// 正好把这个 bug 遮住了）。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import '../src/infra/storage';                    // 真实 StorageManager（无 IDB 时降级 localStorage）
import { WorldBookManager as WBM } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;
const els = new Map<string, any>();

function el(): any {
  return {
    value: '', innerHTML: '', textContent: '', disabled: false, style: { setProperty() {}, display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, remove() {},
    children: [], scrollTop: 0, checked: false, files: [],
    querySelector: () => el(), querySelectorAll: () => [],
  };
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = (len >>> 24) & 255; out[1] = (len >>> 16) & 255; out[2] = (len >>> 8) & 255; out[3] = len & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}
function cardPng(card: any): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(card));
  let bin = '';
  json.forEach((b) => { bin += String.fromCharCode(b); });
  const b64 = Buffer.from(bin, 'binary').toString('base64');
  const text = new Uint8Array([...'chara'].map((c) => c.charCodeAt(0)).concat([0], [...b64].map((c) => c.charCodeAt(0))));
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', new Uint8Array(13)), chunk('tEXt', text), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  parts.forEach((p) => { out.set(p, off); off += p.length; });
  return out;
}

const CARD = {
  spec: 'chara_card_v3', spec_version: '3.0', name: '导入回归卡',
  data: {
    name: '导入回归卡', description: '测试用', personality: '', scenario: '', first_mes: '你好', mes_example: '',
    character_book: {
      name: '导入回归卡世界书',
      entries: [
        { id: 0, comment: '角色:林晚', keys: [], content: '姓名：林晚\n{{char}} 是怕黑的高中女生。', enabled: true, constant: true, insertion_order: 100 },
        { id: 1, comment: '世界观:雨城', keys: ['雨城'], content: '雨城：常年下雨的南方小镇。', enabled: true, insertion_order: 100 },
        { id: 2, comment: '[mvu_update]变量更新规则', keys: [], content: '好感度 = getvar::affection', enabled: true, constant: true, insertion_order: 101 },
      ],
    },
  },
};
let png: Uint8Array = new Uint8Array(0);

beforeAll(async () => {
  png = cardPng(CARD);
  anyG.FileReader = class {
    result: any = null; onload: any = null; onerror: any = null;
    readAsArrayBuffer() {
      this.result = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
      setTimeout(() => this.onload && this.onload({ target: this }), 0);
    }
    readAsDataURL() { this.readAsArrayBuffer(); }
    readAsText() { this.readAsArrayBuffer(); }
  } as any;
  anyG.PresetManager = { getActiveAPIConfig: () => null, getActiveSystemPrompt: () => '', getPresets: () => [] };
  anyG.htmlEscape = (x: unknown) => String(x ?? '');
  anyG.BiqiAgent = { reloadForBook: () => {} };
  anyG.CharacterManager = { getByWorldBook: () => [], create: () => ({}) };
  await import('../src/domain/app');
});

beforeEach(() => {
  els.clear();
  anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), querySelectorAll: () => [], getElementsByClassName: () => [],
    addEventListener() {}, body: el(),
  };
  anyG.UIManager = { showModal: () => {}, closeModal: () => {}, renderWorldBooks: () => {}, renderWBEntries: () => {}, pickBookCover: () => {}, showConfirm: () => {} };
  const A = (anyG as any).App;
  A.toast = () => {};
  A.getProtagonist = () => ({ name: '主角' });
  A.loadEditorContent = () => {};
  A.renderAll = () => {};
  const SM = (anyG as any).StorageManager;
  SM.set('worldBooks', []); SM.set('activeWorldBookId', null);
});

describe('酒馆卡导入（真实存储路径，不桩适配器）', () => {
  it('导入后条目真的落进书里并可读回（回归：曾 0 条目）', async () => {
    const App = (anyG as any).App;
    App.handleImportCharCard({ target: { files: [{ name: 'card.png' }], value: '' } });
    for (let i = 0; i < 60 && (App._pendingCharCards || []).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    expect((App._pendingCharCards || []).length, 'PNG 应被解析出至少一张卡').toBe(1);
    await App.processCharCards();

    const all = WBM.getAll();
    expect(all.length).toBe(1);
    const book: any = all[0];
    expect(book.entries.length, '卡内世界书条目必须落库（曾因 TavernAdapter 取全局而恒为 0）').toBeGreaterThan(0);
    expect(book.tavernSource, '同时必须留存酒馆原文供写卡改造').toBeTruthy();

    // 真实持久化：从存储重新读回也要有（不只是内存副本）
    const persisted: any = (anyG as any).StorageManager.get('worldBooks', []);
    expect(persisted[0].entries.length).toBe(book.entries.length);
    expect(WBM.getActiveId()).toBe(book.id);
  });

  it('落库内容已清洗：不带 {{char}} 之类酒馆宏', async () => {
    const App = (anyG as any).App;
    App.handleImportCharCard({ target: { files: [{ name: 'card.png' }], value: '' } });
    for (let i = 0; i < 60 && (App._pendingCharCards || []).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    await App.processCharCards();
    const book: any = WBM.getAll()[0];
    const joined = book.entries.map((e: any) => e.content).join('\n');
    expect(joined).not.toContain('{{char}}');
    expect(joined).toContain('林晚');       // 宏被替换/清除，内容还在
    expect(book.entries.some((e: any) => e.type === '角色')).toBe(true);
  });
});
