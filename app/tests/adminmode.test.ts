// 管理员模式：连击计数（进入/退出/超时重计）与状态持久化。
// 口令校验走服务器，这里只测本地纯逻辑；真实 StorageManager（localStorage 降级）由本文件自己装上。
import '../src/infra/storage';
import { describe, it, expect, beforeEach } from 'vitest';
import { AdminMode, ADMIN_TAPS, ADMIN_TAP_GAP_MS } from '../src/domain/adminmode';

function tapTimes(n: number, base: number, step = 200): ('enter' | 'exit' | null)[] {
  const out: ('enter' | 'exit' | null)[] = [];
  for (let i = 0; i < n; i++) out.push(AdminMode.tap(base + i * step));
  return out;
}

describe('AdminMode', () => {
  beforeEach(() => {
    AdminMode.set(false);
    AdminMode._taps = 0;
    AdminMode._lastTap = 0;
  });

  it('连点 10 下触发进入：前 9 下返回 null', () => {
    const r = AdminMode.isOn() ? tapTimes(ADMIN_TAPS, 100000) : tapTimes(ADMIN_TAPS, 100000);
    expect(r.slice(0, ADMIN_TAPS - 1).every(x => x === null)).toBe(true);
    expect(r[ADMIN_TAPS - 1]).toBe('enter');
    expect(AdminMode.isOn()).toBe(false);   // enableWithPassword 才落库；tap 只返回意图
  });

  it('已开启时连点 10 下 → exit', () => {
    AdminMode.set(true);
    const r = tapTimes(ADMIN_TAPS, 200000);
    expect(r[ADMIN_TAPS - 1]).toBe('exit');
    expect(AdminMode.isOn()).toBe(true);    // 真正退出要等 requestExit → exit
  });

  it('间隔超过阈值重新计数（9 下 + 长间隔 + 9 下不成触发）', () => {
    let t = 300000;
    for (let i = 0; i < ADMIN_TAPS - 1; i++) { expect(AdminMode.tap(t)).toBe(null); t += 100; }
    t += ADMIN_TAP_GAP_MS + 1;               // 断开
    for (let i = 0; i < ADMIN_TAPS - 1; i++) { expect(AdminMode.tap(t)).toBe(null); t += 100; }
    expect(AdminMode.tap(t)).toBe('enter');  // 第 10 下才触发
  });

  it('触发后计数归零（不会连点 20 下触发两次）', () => {
    let t = 400000;
    for (let i = 0; i < ADMIN_TAPS - 1; i++) AdminMode.tap(t += 100);
    expect(AdminMode.tap(t += 100)).toBe('enter');
    expect(AdminMode.tap(t += 100)).toBe(null);
    expect(AdminMode.tap(t += 100)).toBe(null);
  });

  it('不再有窗口覆盖：正文窗口只由设置决定（管理员与普通用户一致）', () => {
    expect((AdminMode as unknown as Record<string, unknown>).waterOverride).toBeUndefined();
    // 开启/关闭都不该碰水位线与归档区（它们由窗口设置驱动，见 removed-features.test.ts 的源码护栏）
    AdminMode.set(true);
    expect((AdminMode as unknown as Record<string, unknown>).waterOverride).toBeUndefined();
    AdminMode.set(false);
  });

  it('set/isOn 走 StorageManager 持久化', () => {
    AdminMode.set(true);
    expect(AdminMode.isOn()).toBe(true);
    AdminMode.set(false);
    expect(AdminMode.isOn()).toBe(false);
  });
});
