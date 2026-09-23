// 世界书注入上限：固定 10 万字（v1.5.82 起不再提供设置项，超上限条目整条跳过）
import { describe, it, expect } from 'vitest';
import { selectInjectableEntries, WB_INJECT_MAX_CHARS } from '../src/domain/worldbook';

type E = { id: string; name: string; type: string; content: string; inject?: boolean };
const mk = (name: string, chars: number, type = '其他', inject = true): E => ({ id: name, name, type, content: 'x'.repeat(chars), inject });
const names = (r: { kept: any[] }) => r.kept.map((e: any) => e.name);

describe('世界书注入上限（固定 10 万字）', () => {
  it('上限常量是 10 万字：一本常见规模的世界书能整本注入', () => {
    expect(WB_INJECT_MAX_CHARS).toBe(100000);
    const r = selectInjectableEntries([mk('a', 30000), mk('b', 30000), mk('c', 30000)], WB_INJECT_MAX_CHARS);
    expect(r.skipped).toBe(0);
    expect(names(r)).toEqual(['a', 'b', 'c']);
  });

  it('超出上限：整条跳过（不截半条），按 角色 > 世界观 > 其他 取用，输出保持书内原序', () => {
    const entries = [mk('其他1', 60000), mk('角色1', 60000, '角色'), mk('世界观1', 1000, '世界观')];
    const r = selectInjectableEntries(entries, WB_INJECT_MAX_CHARS);
    expect(r.skipped).toBe(1);                 // 其他1 放不进去
    expect(names(r)).toEqual(['角色1', '世界观1']); // 原序输出，不是优先级顺序
    expect(r.budget).toBe(WB_INJECT_MAX_CHARS);
  });

  it('初始 / 变量 / 前端 与 inject:false 的条目从不参与注入', () => {
    const entries = [
      mk('常驻', 100), mk('初始', 100, '初始'), mk('变量', 100, '变量'),
      mk('前端', 100, '前端'), mk('关了注入', 100, '其他', false)
    ];
    const r = selectInjectableEntries(entries, WB_INJECT_MAX_CHARS);
    expect(names(r)).toEqual(['常驻']);
  });

  it('budget<=0 仍是"不限制"（内部语义保留；调用方一律传上限常量）', () => {
    const entries = [mk('a', 200000)];
    const r = selectInjectableEntries(entries, 0);
    expect(r.skipped).toBe(0);
    expect(r.kept.length).toBe(1);
  });
});
