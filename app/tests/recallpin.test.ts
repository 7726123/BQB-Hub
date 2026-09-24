import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import { RecallPin } from '../src/domain/recallpin';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;

const BK = 'wb_pin_test';
const item = (k: string, n = 100) => ({ key: k, text: k.padEnd(n, '字') });

describe('RecallPin（归档回读 epoch 钉住）', () => {
  beforeEach(() => { sm().remove('recallPin_' + BK); });

  it('首轮：epoch 为空，候选全进本轮补充（rotated=true，下轮起才钉住）', () => {
    const r = RecallPin.step(BK, { x: 0, cands: [item('a'), item('b')] });
    expect(r.rotated).toBe(true);
    expect(r.epoch).toHaveLength(0);
    expect(r.fresh.map((i) => i.key)).toEqual(['a', 'b']);
  });

  it('同 epoch 内只追加：上轮列表原序保留 + 新命中补在尾部，重复项不再收', () => {
    RecallPin.step(BK, { x: 0, cands: [item('a'), item('b')] });
    const r2 = RecallPin.step(BK, { x: 0, cands: [item('b'), item('c')] });  // b 重复、c 新
    expect(r2.rotated).toBe(false);
    expect(r2.fresh.map((i) => i.key)).toEqual(['a', 'b', 'c']);           // 顺序稳定 = 前缀稳定
    const r3 = RecallPin.step(BK, { x: 0, cands: [] });
    expect(r3.fresh.map((i) => i.key)).toEqual(['a', 'b', 'c']);           // 无新命中时字节不变
  });

  it('归档轮（x 变化）= 重选：本轮补充并入 epoch 块，补充区清空', () => {
    RecallPin.step(BK, { x: 0, cands: [item('a'), item('b')] });
    RecallPin.step(BK, { x: 0, cands: [item('c')] });
    const r = RecallPin.step(BK, { x: 8000, cands: [item('d')] });         // 窗口左移 = 归档轮
    expect(r.rotated).toBe(true);
    expect(r.epoch.map((i) => i.key)).toEqual(['a', 'b', 'c']);            // 上一 epoch 的补充转正
    expect(r.fresh.map((i) => i.key)).toEqual(['d']);                      // 本轮新命中照旧进补充区
    const r2 = RecallPin.step(BK, { x: 8000, cands: [] });
    expect(r2.epoch.map((i) => i.key)).toEqual(['a', 'b', 'c']);           // epoch 内不再变
  });

  it('epoch 块超限丢尾部（保块首=缓存前缀），补充区超限丢头部（保最新=相关性）', () => {
    const cands = [item('k1', 600), item('k2', 600), item('k3', 600), item('k4', 600)];
    RecallPin.step(BK, { x: 0, cands: cands, epochCap: 10000, freshCap: 10000 });
    const r = RecallPin.step(BK, { x: 5000, cands: [], epochCap: 1000, freshCap: 10000 });
    expect(r.epoch.map((i) => i.key)).toEqual(['k1']);                     // epochCap=1000 → 只容得下开头那条
    RecallPin.reset(BK);
    const r2 = RecallPin.step(BK, { x: 0, cands: cands, epochCap: 10000, freshCap: 1000 });
    expect(r2.fresh.map((i) => i.key)).toEqual(['k4']);                    // freshCap=1000 → 保最新一条
  });

  it('reset 清空；空候选不写脏状态', () => {
    RecallPin.step(BK, { x: 0, cands: [item('a')] });
    RecallPin.reset(BK);
    expect(RecallPin.stats(BK)).toMatchObject({ epochItems: 0, freshItems: 0 });
    const r = RecallPin.step(BK, { x: 0, cands: [] });
    expect(r.epoch).toHaveLength(0);
    expect(r.fresh).toHaveLength(0);
  });
});
