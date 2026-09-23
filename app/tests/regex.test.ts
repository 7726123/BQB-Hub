import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { RegexEngine, type RegexRule } from '../src/lib/regex';

describe('RegexEngine', () => {
  beforeEach(() => {
    // 隔离规则数据
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('regexRules', []);
  });

  it('按顺序应用启用且 timing 匹配的规则', () => {
    const rules: RegexRule[] = [
      { name: 'a', enabled: true, timing: 'before', order: 0, findRegex: '猫', replaceString: '猫娘' },
      { name: 'b', enabled: true, timing: 'before', order: 1, findRegex: '娘', replaceString: '娘（可爱）' },
      { name: 'off', enabled: false, timing: 'before', order: 2, findRegex: 'x', replaceString: 'y' },
      { name: 'wrong-timing', enabled: true, timing: 'after', order: 3, findRegex: '猫', replaceString: '狗' }
    ];
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('regexRules', rules);
    expect(RegexEngine.applyRules('一只猫', 'before')).toBe('一只猫娘（可爱）');
  });

  it('支持 /pattern/flags 写法', () => {
    const rules: RegexRule[] = [
      { name: 're', enabled: true, timing: 'after', order: 0, findRegex: '/\\d+/g', replaceString: 'N' }
    ];
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('regexRules', rules);
    expect(RegexEngine.applyRules('章节 1 与章节 2', 'after')).toBe('章节 N 与章节 N');
  });

  it('{{match}} 占位符替换为匹配原文', () => {
    const rules: RegexRule[] = [
      { name: 'wrap', enabled: true, timing: 'before', order: 0, findRegex: '树', replaceString: '【{{match}}】' }
    ];
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('regexRules', rules);
    expect(RegexEngine.applyRules('大树小树', 'before')).toBe('大【树】小【树】');
  });

  it('无效正则静默跳过，不抛错', () => {
    const rules: RegexRule[] = [
      { name: 'bad', enabled: true, timing: 'before', order: 0, findRegex: '([', replaceString: 'x' }
    ];
    (globalThis as unknown as { StorageManager: { set(k: string, v: unknown): void } }).StorageManager.set('regexRules', rules);
    expect(RegexEngine.applyRules('正常文本', 'before')).toBe('正常文本');
  });

  it('testRule 直接返回替换结果，错误时返回提示', () => {
    expect(RegexEngine.testRule('a+', 'A', 'aaa')).toBe('A');
    const err = RegexEngine.testRule('([', 'x', 't');
    expect(err).toMatch(/^正则错误: /);
  });

  it('saveRules 按数组顺序写回 order', () => {
    const rules: RegexRule[] = [
      { name: 'x', enabled: true, timing: 'before', order: 99, findRegex: 'a', replaceString: 'b' },
      { name: 'y', enabled: true, timing: 'before', order: -1, findRegex: 'c', replaceString: 'd' }
    ];
    RegexEngine.saveRules(rules);
    expect(rules[0].order).toBe(0);
    expect(rules[1].order).toBe(1);
  });
});