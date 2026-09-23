import { describe, it, expect, beforeEach } from 'vitest';
// 先加载真实 storage（挂全局），再加载被测模块
import '../src/infra/storage';
import { VariableManager } from '../src/lib/variables';
import { WorldBookManager as WBM } from '../src/domain/worldbook';

// WorldBookManager 桩（P3-B：variables 经 import 使用真实实例，覆写其方法模拟可控 activeId/entries）
const wbState: { id: string | number | null; entries: { type?: string; name?: string; content?: string }[] } = {
  id: 'wb1', entries: []
};
(WBM as unknown as { getActiveId(): unknown }).getActiveId = () => wbState.id;
(WBM as unknown as { getActive(): unknown }).getActive = () => (wbState.id ? { id: wbState.id, entries: wbState.entries } : null);

describe('VariableManager', () => {
  beforeEach(() => {
    wbState.id = 'wb1';
    wbState.entries = [];
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('wbVariables', {});
    VariableManager._key = 'wbVariables';
  });

  it('set/get 按世界书隔离', () => {
    VariableManager.set('好感度', '10');
    expect(VariableManager.get('好感度')).toBe('10');
    wbState.id = 'wb2';
    expect(VariableManager.get('好感度', '无')).toBe('无');
    wbState.id = 'wb1';
    expect(VariableManager.get('好感度')).toBe('10');
  });

  it('getComputedValue 用当前变量求值表达式', () => {
    VariableManager.set('灵力', '5');
    VariableManager.set('等级', '2');
    expect(VariableManager.getComputedValue('灵力 * 等级')).toBe('10');
    expect(VariableManager.getComputedValue('bad syntax (((')).toBe('');
  });

  it('parseVarBlock 解析 [VAR] 块与 +/- 增量', () => {
    VariableManager.set('金币', '100');
    const vars = VariableManager.parseVarBlock('前文\n[VAR]\n金币 = +50\n心情 = 开心\n忽略 computed: x = computed:1+1\n[/VAR]\n后文');
    expect(vars).toEqual({ 金币: '150', 心情: '开心' });
    expect(VariableManager.parseVarBlock('没有块')).toBeNull();
  });

  it('evalCondition 六种比较与宽松放行', () => {
    VariableManager.set('hp', '50');
    expect(VariableManager.evalCondition('hp > 40')).toBe(true);
    expect(VariableManager.evalCondition('hp > 60')).toBe(false);
    expect(VariableManager.evalCondition('hp >= 50')).toBe(true);
    expect(VariableManager.evalCondition('hp <= 49')).toBe(false);
    expect(VariableManager.evalCondition('hp = 50')).toBe(true);
    expect(VariableManager.evalCondition('hp != 50')).toBe(false);
    expect(VariableManager.evalCondition('未定义变量 > 1')).toBe(true); // 未定义宽松放行
    expect(VariableManager.evalCondition('')).toBe(true);
    // 字符串比较
    VariableManager.set('状态', '受伤');
    expect(VariableManager.evalCondition('状态 = 受伤')).toBe(true);
    expect(VariableManager.evalCondition('状态 = 健康')).toBe(false);
  });

  it('computed 变量从条目内容重算', () => {
    wbState.entries = [{ type: '变量', name: 'v', content: '基础 = 3\n总伤 = computed:基础 * 10' }];
    VariableManager.set('基础', '3');
    VariableManager.setBatch({});
    expect(VariableManager.get('总伤')).toBe('30');
  });

  it('clear 只清当前书', () => {
    VariableManager.set('x', '1');
    wbState.id = 'wb2';
    VariableManager.set('y', '2');
    wbState.id = 'wb1';
    VariableManager.clear();
    expect(VariableManager.get('x', '')).toBe('');
    wbState.id = 'wb2';
    expect(VariableManager.get('y')).toBe('2');
  });
});