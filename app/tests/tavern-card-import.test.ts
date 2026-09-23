// 酒馆卡导入与改造链路的回归（v1.5.88 修的一批问题）：
// ① 导入预览那行「📚 世界书: N 保留…」此前恒不显示（把整张卡当 character_book 传了）；
// ② read_adapter_doc 返回的指南用字面 "\n" 拼接（换行丢了）；
// ③ 导入后没有留存酒馆原文 → 写卡的改造流程拿不到 character_book（Agent 只能看已被机械整理过的条目）；
// ④ adapt_tavern_lorebook 以前强制要 json_text，大卡（几十万字）根本没法让模型回吐；
// ⑤ read_current_book_json 对大书会把整份 JSON 灌进上下文（这里做压缩回退）。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import * as TA from '../src/domain/tavern-adapter';
import { WorldBookManager } from '../src/domain/worldbook';

const anyG = globalThis as unknown as Record<string, unknown>;
const WBM = WorldBookManager as unknown as Record<string, any>;
const CAPTURED: any[] = [];
const TOASTS: string[] = [];
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

// —— 造一张最小可用的酒馆 PNG 卡（CRCs 置 0：解析端不校验） ——
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = (len >>> 24) & 255; out[1] = (len >>> 16) & 255; out[2] = (len >>> 8) & 255; out[3] = len & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  return out;
}
function cardPng(card: any): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const json = new TextEncoder().encode(JSON.stringify(card));
  let bin = '';
  json.forEach((b) => { bin += String.fromCharCode(b); });
  const b64 = Buffer.from(bin, 'binary').toString('base64');
  const text = new Uint8Array([...'chara'].map((c) => c.charCodeAt(0)).concat([0], [...b64].map((c) => c.charCodeAt(0))));
  const parts = [sig, chunk('IHDR', ihdr), chunk('tEXt', text), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  parts.forEach((p) => { out.set(p, off); off += p.length; });
  return out;
}

const CARD = {
  spec: 'chara_card_v3', spec_version: '3.0',
  name: '测试卡',
  data: {
    name: '测试卡', description: '一个测试角色', personality: '冷静', scenario: '', first_mes: '你好', mes_example: '',
    character_book: {
      name: '测试卡世界书',
      entries: [
        { id: 0, comment: '角色:测试卡', keys: [], content: '姓名：测试卡\n高三学生，冷静。', enabled: true, constant: true, insertion_order: 100 },
        { id: 1, comment: '世界观:学园', keys: ['学园'], content: '学园：一所海边的高中。', enabled: true, constant: false, insertion_order: 100 },
        { id: 2, comment: '[mvu_update]变量更新规则', keys: [], content: '好感度 = getvar::affection\n$affection += 1', enabled: true, constant: true, insertion_order: 101 },
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
  anyG.TavernAdapter = TA;
  anyG.PresetManager = { getActiveAPIConfig: () => null, getActiveSystemPrompt: () => '' };
  anyG.StorageManager = { get: (_k: string, d: unknown) => d, set: () => {}, remove: () => {} };
  anyG.htmlEscape = (x: unknown) => String(x ?? '');
  anyG.BiqiAgent = { reloadForBook: () => {} };
  anyG.CharacterManager = { getByWorldBook: () => [], create: () => ({}) };
  await import('../src/domain/app');
  await import('../src/domain/cardwriter');
});

beforeEach(() => {
  CAPTURED.length = 0; TOASTS.length = 0; els.clear();
  anyG.document = {
    getElementById: (id: string) => { if (!els.has(id)) els.set(id, el()); return els.get(id); },
    querySelector: () => el(), querySelectorAll: () => [], getElementsByClassName: () => [],
    addEventListener() {}, body: el(),
  };
  const books: any[] = [];
  WBM.createBook = (n: string) => { const b: any = { id: 'wb_t', name: n, entries: [] }; books.push(b); return b; };
  WBM.addEntry = (wbId: string, e: any) => { CAPTURED.push(e); const b = books.find((x) => x.id === wbId); if (b) b.entries.push(e); };
  WBM.setCover = () => {};
  WBM.setTavernSource = (wbId: string, src: any) => { const b = books.find((x) => x.id === wbId); if (b) { if (src) b.tavernSource = src; else delete b.tavernSource; } };
  WBM.setActiveId = () => {};
  WBM.getActiveId = () => 'wb_t';
  WBM.getActive = () => books.find((x) => x.id === 'wb_t') || null;
  WBM.getAll = () => books;
  WBM.saveAll = () => {};
  anyG.UIManager = { showModal: () => {}, closeModal: () => {}, renderWorldBooks: () => {}, renderWBEntries: () => {}, pickBookCover: () => {}, showConfirm: () => {} };
  const A = (anyG as any).App;
  A.toast = (m: string) => TOASTS.push(m);
  A.getProtagonist = () => ({ name: '主角' });
  A.loadEditorContent = () => {};
  A.renderAll = () => {};
  const C = (anyG as any).CardWriterChat;
  if (C) { C._getTargetId = () => 'wb_t'; C._getTargetBook = () => WBM.getAll().find((x: any) => x.id === 'wb_t') || null; }
});

async function importCard() {
  const A = (anyG as any).App;
  A.handleImportCharCard({ target: { files: [{ name: 'card.png' }], value: '' } });
  for (let i = 0; i < 60 && (A._pendingCharCards || []).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
  await A.processCharCards();
}

describe('酒馆卡导入', () => {
  it('卡片世界书条目落库 + 留存原始酒馆数据（tavernSource）', async () => {
    await importCard();
    expect(CAPTURED.length).toBeGreaterThan(0);
    const book: any = WBM.getAll()[0];
    expect(book.tavernSource, '必须留存酒馆原文，否则写卡改造流程拿不到 character_book').toBeTruthy();
    const cb = book.tavernSource.cards[0].character_book;
    expect(cb.entries.length).toBe(3);
    expect(book.tavernSource.cards[0].name).toBe('测试卡');
  });

  it('预览里给出「📚 世界书: N 保留…」统计（回归：此前恒不显示）', async () => {
    const A = (anyG as any).App;
    A.handleImportCharCard({ target: { files: [{ name: 'card.png' }], value: '' } });
    for (let i = 0; i < 60 && (A._pendingCharCards || []).length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    const preview = String(els.get('charCardPreview')?.innerHTML || '');
    expect(preview).toContain('📚 世界书:');
    expect(preview).toMatch(/\d+ 保留/);
  });

  it('_computeCharBookStats 兼容「整张卡」与「character_book」两种入参', () => {
    const A = (anyG as any).App;
    const byBook = A._computeCharBookStats(CARD.data.character_book);
    const byCard = A._computeCharBookStats(CARD.data);
    expect(byBook).toBeTruthy();
    expect(byCard).toEqual(byBook);
    expect(A._computeCharBookStats(null)).toBe(null);
  });
});

describe('写卡的酒馆改造链路', () => {
  it('read_adapter_doc 返回的指南是真换行（回归：曾用字面 \\n 拼接）', () => {
    const C = (anyG as any).CardWriterChat;
    const doc: string = C._readAdapterDoc();
    expect(doc).toContain('\n');
    expect(doc.includes('\\n'), '不应出现字面反斜杠 n').toBe(false);
    expect(doc).toContain('酒馆世界书 → 本软件适配指南');
  });

  it('adapt_tavern_lorebook 不传 json_text：自动读书内留存的酒馆原文', async () => {
    await importCard();
    const C = (anyG as any).CardWriterChat;
    const report: string = C._executeAdaptTavern({});
    expect(report).toContain('酒馆适配报告');
    expect(report).toContain('书内留存的酒馆原文');
    expect(report).not.toContain('参数无效');
    expect(report).toMatch(/共 3 条/);
  });

  it('没有留存的酒馆原文时：退回当前书条目并说明来源', async () => {
    const C = (anyG as any).CardWriterChat;
    const book: any = WBM.getAll()[0] || (() => { const b: any = { id: 'wb_t', name: '手工书', entries: [{ id: 'e1', type: '世界观', name: '设定A', content: '内容A', inject: true }] }; WBM.getAll = () => [b]; return b; })();
    book.entries = [{ id: 'e1', type: '世界观', name: '设定A', content: '内容A', inject: true }];
    delete book.tavernSource;
    const report: string = C._executeAdaptTavern({});
    expect(report).toContain('当前书已有条目，非酒馆原文');
  });

  it('read_current_book_json：小书原样、大书压缩（含残留标记）', async () => {
    await importCard();
    const C = (anyG as any).CardWriterChat;
    const book: any = WBM.getAll()[0];
    const small = C._readCurrentBookJson();
    expect(small).toContain('tavernSource');

    // 塞一条超大条目，触发压缩回退
    book.entries.push({ id: 'e_big', type: '其他', name: '大条目', content: 'x'.repeat(80 * 1024) + '{{getvar::a}}', inject: true });
    const big = C._readCurrentBookJson();
    expect(big).toContain('_compact');
    expect(big).toContain('hasTavernResidue');
    expect(big.length).toBeLessThan(60 * 1024);
  });
});
