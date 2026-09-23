// 世界书条目「查看全文」：点卡片右侧「查看」一点即读（只读、可滑动），不再需要"先展开再点编辑"。
// 覆盖：卡片上按钮与旧箭头的替换、弹窗填充（标题/字数/注入状态/转义/换行/滚动复位）、
// 空内容提示、条目不存在、以及弹窗里「编辑」的跳转。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../src/infra/storage';
import { WorldBookManager } from '../src/domain/worldbook';
import '../src/domain/editor';   // ui.ts 的渲染色用全局 htmlEscape（由 editor.ts 挂载）
import '../src/domain/ui';

type Any = Record<string, any>;
const g = globalThis as unknown as Any;
const WB = () => WorldBookManager as unknown as Any;   // worldbook.ts 已不挂全局（单 bundle 改造），按 ES import 取
const U = () => g.UIManager as Any;

const els: Record<string, Any> = {};
const origDoc = (globalThis as unknown as { document: Any }).document;
const origGetById = origDoc.getElementById;

function fakeEl(extra: Any = {}): Any {
  return Object.assign({
    value: '', textContent: '', innerHTML: '', scrollTop: 0, style: {},
    // renderWBEntries 末尾会挂拖拽排序（_bindSortable）→ 元素桩需要事件接口
    addEventListener() {}, removeEventListener() {}, setPointerCapture() {}, releasePointerCapture() {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    querySelector() { return null; }, querySelectorAll() { return []; },
  }, extra);
}

let entryId = '';

beforeEach(() => {
  g.StorageManager.remove('worldBooks');
  g.StorageManager.remove('activeWorldBookId');
  Object.keys(els).forEach((k) => delete els[k]);
  origDoc.getElementById = (id: string) => (els[id] = els[id] || fakeEl({ id }));
  g.App = { toast: vi.fn() };
  g.UIManager = Object.assign(U() || {}, { showModal: vi.fn(), closeModal: vi.fn() });
  const wb = WB().createBook('查看测试书');
  const e = WB().addEntry(wb.id, { type: '角色', name: '夏洛', content: '第一行\n第二行 <b>不是标签</b>' });
  entryId = e.id;
});

afterEach(() => {
  origDoc.getElementById = origGetById;
  vi.restoreAllMocks();
});

describe('条目卡片的「查看」入口', () => {
  it('卡片右侧是「查看」按钮，且一点就带着条目 id 调 viewWBEntry（不再是展开箭头 ▶）', () => {
    els['wbEntryList'] = fakeEl();   // renderWBEntries 的列表容器
    U().renderWBEntries();
    const html = String(els['wbEntryList'].innerHTML || '');
    expect(html).toContain('ec-view');
    expect(html).toContain('查看');
    expect(html).not.toContain('ec-caret');            // 旧箭头已移除
    expect(html).toContain('UIManager.viewWBEntry(');  // 直接进查看，不是先展开
    expect(html).toContain(entryId);
    // 停止冒泡：点「查看」不应顺带展开/收起卡片
    expect(html).toContain('event.stopPropagation();UIManager.viewWBEntry(');
  });

  it('展开/收起仍可用（点整行），编辑与删除按钮照旧在展开区里', () => {
    els['wbEntryList'] = fakeEl();   // renderWBEntries 的列表容器
    U().renderWBEntries();
    const html = String(els['wbEntryList'].innerHTML || '');
    expect(html).toContain('UIManager.toggleWBEntry(this)');
    expect(html).toContain('UIManager.showWBEntryModal(');
    expect(html).toContain('UIManager.deleteWBEntry(');
  });
});

describe('viewWBEntry：只读全文弹窗', () => {
  it('填充标题/字数/注入状态与正文，并打开弹窗', () => {
    U().viewWBEntry(entryId);
    expect(els['wbViewTitle'].textContent).toBe('夏洛');
    expect(els['wbViewMeta'].textContent).toContain('角色');
    expect(els['wbViewMeta'].textContent).toContain('19 字');
    expect(els['wbViewMeta'].textContent).toContain('注入开');
    // 正文转义后渲染，换行变 <br>（与其它渲染处一致）
    expect(els['wbViewContent'].innerHTML).toContain('第一行<br>第二行');
    expect(els['wbViewContent'].innerHTML).toContain('&lt;b&gt;不是标签&lt;/b&gt;');
    expect(g.UIManager.showModal).toHaveBeenCalledWith('modalWBEntryView');
  });

  it('每次打开都把滚动位置复位到顶部（不沿用上一条的位置）', () => {
    els['wbViewContent'] = fakeEl({ scrollTop: 500 });
    U().viewWBEntry(entryId);
    expect(els['wbViewContent'].scrollTop).toBe(0);
  });

  it('空内容给明确提示，而不是一片空白', () => {
    const wb = WB().getActive();
    const empty = WB().addEntry(wb.id, { type: '其他', name: '空条目', content: '' });
    U().viewWBEntry(empty.id);
    expect(els['wbViewContent'].innerHTML).toContain('还没有内容');
  });

  it('注入关闭时如实显示「注入关」', () => {
    const wb = WB().getActive();
    const off = WB().addEntry(wb.id, { type: '角色', name: '关注入', content: 'x', inject: false });
    U().viewWBEntry(off.id);
    expect(els['wbViewMeta'].textContent).toContain('注入关');
  });

  it('条目不存在：提示且不打开弹窗（不白屏）', () => {
    U().viewWBEntry('not-exist');
    expect(g.App.toast).toHaveBeenCalled();
    expect(g.UIManager.showModal).not.toHaveBeenCalled();
  });

  it('弹窗里的「编辑」：关掉查看并带着同一条目打开编辑弹窗', () => {
    const spy = vi.spyOn(U(), 'showWBEntryModal').mockImplementation(() => {});
    U().viewWBEntry(entryId);
    U().editFromWBView();
    expect(g.UIManager.closeModal).toHaveBeenCalledWith('modalWBEntryView');
    expect(spy).toHaveBeenCalledWith(entryId);
  });
});
