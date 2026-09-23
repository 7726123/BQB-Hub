// 服务地址协议选择：Android 7+ 走内置自签 CA 的 HTTPS，更早/非 Android 走明文。
// 边界意义重大——误判成 HTTPS 会让老设备社区功能直接不可用，因此锁死行为。
import { describe, it, expect, afterEach } from 'vitest';
import { supportsCustomCa, defaultServerBase, SERVER_HOST, SERVER_HTTP_PORT, SERVER_HTTPS_PORT } from '../src/lib/server-url';

const g = globalThis as unknown as Record<string, unknown>;

function setEnv(platform: string | null, ua: string): void {
  g.Capacitor = platform === null ? undefined : { getPlatform: () => platform };
  // 测试环境的 navigator 可能只有 getter（happy-dom/jsdom 差异），统一用 defineProperty 覆盖
  Object.defineProperty(g, 'navigator', { value: { userAgent: ua }, configurable: true, writable: true });
}
afterEach(() => { g.Capacitor = undefined; });

describe('server-url 协议选择', () => {
  it('Android 7+ → 走 HTTPS（内置 CA 生效）', () => {
    setEnv('android', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36');
    expect(supportsCustomCa()).toBe(true);
    expect(defaultServerBase()).toBe('https://' + SERVER_HOST + ':' + SERVER_HTTPS_PORT);
  });

  it('Android 7.0 边界 → HTTPS', () => {
    setEnv('android', 'Mozilla/5.0 (Linux; Android 7.0; SM-G930F)');
    expect(supportsCustomCa()).toBe(true);
  });

  it('Android 6.0（network_security_config 不生效）→ 明文端口', () => {
    setEnv('android', 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5)');
    expect(supportsCustomCa()).toBe(false);
    expect(defaultServerBase()).toBe('http://' + SERVER_HOST + ':' + SERVER_HTTP_PORT);
  });

  it('Chrome UA 缩减（版本号冻结为 Android 10）→ 仍判定 HTTPS', () => {
    // Chrome 110+ 把 UA 里的 Android 版本冻结为 10；老设备拿不到该串（最高 Chrome 106）
    setEnv('android', 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 Chrome/120.0.0.0');
    expect(supportsCustomCa()).toBe(true);
  });

  it('非 Android / UA 缺失 → 回落明文（不改动即当前线上行为）', () => {
    setEnv('web', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    expect(supportsCustomCa()).toBe(false);
    setEnv('android', 'no version here');
    expect(supportsCustomCa()).toBe(false);
    setEnv(null, 'Mozilla/5.0 (Linux; Android 14)');
    expect(supportsCustomCa()).toBe(false);
  });
});
