// 管理员模式（系统版专用）：
//   · 判定只看运行期 edition（来自系统版 APK 的原生上报），正式版恒关——没有连点手势、没有本地开关；
//   · 管理请求带机器凭据（X-System-Key + X-Install-Id）；
//   · 兜底令牌（口令换的 12h 令牌）存取与过期；两套凭据叠加。
import '../src/infra/storage';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdminMode } from '../src/domain/adminmode';
import { __setEditionForTest, isSystemEdition } from '../src/lib/edition';

describe('AdminMode（系统版专用；正式版没有管理员模式）', () => {
  beforeEach(() => { __setEditionForTest('normal'); });
  afterEach(() => { __setEditionForTest('normal'); });

  it('正式版：恒关——改 localStorage 也打不开（旧的本地开关已作废）', () => {
    expect(AdminMode.isOn()).toBe(false);
    try { localStorage.setItem('adminMode', 'true'); } catch (e) { /* 环境无 localStorage 亦可 */ }
    expect(AdminMode.isOn()).toBe(false);
    // 连点手势与本地开关的 API 已整体删除（正式版网页包里不再有这段代码）
    const rec = AdminMode as unknown as Record<string, unknown>;
    expect(rec.tap).toBeUndefined();
    expect(rec.set).toBeUndefined();
    expect(rec.exit).toBeUndefined();
  });

  it('系统版：常开；判定来自 edition，而不是本地存储', () => {
    __setEditionForTest('system', 'k-123');
    expect(isSystemEdition()).toBe(true);
    expect(AdminMode.isOn()).toBe(true);
  });

  it('管理请求头：系统版带 X-System-Key 与 X-Install-Id；正式版为空对象', () => {
    __setEditionForTest('system', 'k-123');
    const h = AdminMode.adminRequestHeaders();
    expect(h['X-System-Key']).toBe('k-123');
    expect(h['X-Install-Id']).toMatch(/^[0-9a-f]{32}$/);

    __setEditionForTest('normal');
    expect(AdminMode.adminRequestHeaders()).toEqual({});
  });

  it('系统版但凭据为空（异常构建）：不带 X-System-Key（服务端会拒绝，如实反映）', () => {
    __setEditionForTest('system', '');
    expect(AdminMode.adminRequestHeaders()['X-System-Key']).toBeUndefined();
  });

  it('兜底令牌：存/取/过期即失效/清空', () => {
    expect(AdminMode.traceToken()).toBe('');
    AdminMode._saveToken('tk-1', Date.now() + 3600 * 1000);
    expect(AdminMode.traceToken()).toBe('tk-1');

    AdminMode._saveToken('tk-old', Date.now() - 1);   // 过期
    expect(AdminMode.traceToken()).toBe('');

    AdminMode._saveToken('tk-2', Date.now() + 3600 * 1000);
    AdminMode._saveToken('', 0);                       // 清空
    expect(AdminMode.traceToken()).toBe('');
  });

  it('兜底令牌有值时叠加进管理请求头（服务端两套凭据任一生效）', () => {
    __setEditionForTest('system', 'k-123');
    AdminMode._saveToken('tk-9', Date.now() + 3600 * 1000);
    try {
      const h = AdminMode.adminRequestHeaders();
      expect(h['X-Admin-Token']).toBe('tk-9');
      expect(h['X-System-Key']).toBe('k-123');
    } finally { AdminMode._saveToken('', 0); }
  });
});

// 源码守卫（2026-10 起：正式版彻底移除管理员模式入口——手势、口令框入口都不再从「检查更新」可达）
describe('源码守卫：手势已死', () => {
  it('update.ts 里不再引用 AdminMode / 弹口令框（连点入口整体删除）', () => {
    const src = readFileSync(resolve(__dirname, '../src/domain/update.ts'), 'utf8');
    expect(src).not.toContain('AdminMode');
    expect(src).not.toContain('showAdminAuth');
  });

  it('adminmode.ts 里不再有连点计数（ADMIN_TAPS / .tap( / _taps）', () => {
    const src = readFileSync(resolve(__dirname, '../src/domain/adminmode.ts'), 'utf8');
    expect(src).not.toContain('ADMIN_TAPS');
    expect(src).not.toContain('.tap(');
    expect(src).not.toContain('_taps');
  });
});
