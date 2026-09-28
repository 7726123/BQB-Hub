import { describe, it, expect } from 'vitest';
import { Modals } from '../src/domain/modals';

describe('Modals 模板完整性', () => {
  it('28 个弹窗模板，每个都有唯一 id 且 div 正确闭合', () => {
    const ids = Object.keys(Modals._modals);
    expect(ids).toHaveLength(28);
    expect(new Set(ids).size).toBe(28);
    ids.forEach(function (id) {
      const t = Modals._modals[id];
      expect(t).toContain('class="modal-overlay"');
      expect(t).toMatch(new RegExp('id="' + id + '"'));
      const opens = (t.match(/<div\b/g) || []).length;
      const closes = (t.match(/<\/div>/g) || []).length;
      expect(opens, id + ' div 闭合数').toBe(closes);
    });
  });

  it('关键交互元素存在', () => {
    expect(Modals._modals.modalWBEntry).toContain('id="wbEntryInject"');
    expect(Modals._modals.modalCommunityWbCrop).toContain('id="cropHandleSE"');
    expect(Modals._modals.modalAppUpdate).toContain('id="updBtn"');
  });
});
