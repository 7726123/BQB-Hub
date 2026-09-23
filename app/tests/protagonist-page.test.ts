// 主角页：「取消选择」只清空当前主角、保留资料；文案不再把主角说成"视角"。
// 背景：叙事视角已改为只由预设的「视角」条目决定（见 writing-generate.test.ts 的
// 「叙事视角不由 App 硬编码」），所以"没选主角"是合法状态，取消选择不该是危险操作。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/editor';        // 提供全局 htmlEscape（ui.ts 渲染色用）
import '../src/domain/worldbook';
import { WorldBookManager } from '../src/domain/worldbook';
import '../src/domain/ui';
import { ProtagonistManager } from '../src/domain/protagonist';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const U = () => g.UIManager as Any;
const PM = ProtagonistManager as unknown as Any;

const els: Record<string, Any> = {};
const origDoc = (globalThis as unknown as { document: Any }).document;
const origGetById = origDoc.getElementById;

function fakeEl(extra: Any = {}): Any {
  return Object.assign({
    value: '', textContent: '', innerHTML: '', style: {},
    addEventListener() {}, removeEventListener() {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; }, querySelectorAll() { return []; },
  }, extra);
}

beforeEach(() => {
  Object.keys(els).forEach((k) => delete els[k]);
  origDoc.getElementById = (id: string) => (els[id] = els[id] || fakeEl({ id }));
  g.App = { toast: vi.fn() };
  g.UIManager = Object.assign(U() || {}, { showConfirm: vi.fn(), showModal: vi.fn(), closeModal: vi.fn() });
  g.StorageManager.remove('protagonists');
  g.StorageManager.remove('activeProtagonistId');
  g.StorageManager.remove('worldBooks');
  WorldBookManager.createBook('主角页测试书');   // setActiveId 会写到当前世界书
});

afterEach(() => {
  origDoc.getElementById = origGetById;
  vi.restoreAllMocks();
});

describe('主角页：取消选择（保留资料）', () => {
  it('取消后当前主角为空，但主角资料还在', () => {
    const a = PM.create({ name: '夏洛' });
    expect(PM.getActiveId()).toBe(a.id);          // create 会自动选为当前主角

    U().clearProtagonist();

    expect(PM.getActiveId()).toBeNull();
    expect(PM.getAll().length).toBe(1);            // ← 资料保留（不是删除）
    expect(PM.getAll()[0].name).toBe('夏洛');
    expect(g.App.toast).toHaveBeenCalledWith(expect.stringContaining('已取消选择'));
  });

  it('取消后可以再选回来', () => {
    const a = PM.create({ name: '夏洛' });
    U().clearProtagonist();
    U().selectProtagonist(a.id);
    expect(PM.getActiveId()).toBe(a.id);
  });

  it('渲染：当前主角卡片给「取消选择」，其他卡片给「选为当前主角」', () => {
    const a = PM.create({ name: '夏洛' });
    const b = PM.create({ name: '希尔' });
    PM.setActiveId(a.id);

    U().renderProtagonists();
    const html = String(els['protagList'].innerHTML || '');
    expect(html).toContain('UIManager.clearProtagonist()');
    expect(html).toContain('取消选择');
    expect(html).toContain('✓ 当前主角');                  // 文案解耦：不再是"主视角"
    expect(html).not.toContain('主视角');
    expect(html).toContain('选为当前主角');
    // 两张卡都在（取消/选择都不删资料）
    expect(html).toContain('夏洛');
    expect(html).toContain('希尔');
    expect(b.id).toBeTruthy();
  });

  it('未选主角时给出中性说明（不再警告"请选择主角作为当前视角"）', () => {
    PM.create({ name: '夏洛' });
    PM.setActiveId(null);
    U().renderProtagonists();
    const html = String(els['protagList'].innerHTML || '');
    expect(html).toContain('选为当前主角');
    // 提示条由 index.html 承载，文案必须说清"视角由预设决定、与主角无关"
    const fs = require('node:fs');
    const path = require('node:path');
    const doc = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'index.html'), 'utf8');
    const m = /id="protagSelectPrompt"[^>]*>([\s\S]*?)<\/p>/.exec(doc);
    expect(m, '提示条应存在').toBeTruthy();
    expect(m![1]).toContain('视角');
    expect(m![1]).toContain('无关');
    expect(m![1]).not.toContain('请选择一个主角作为当前视角');
  });
});
