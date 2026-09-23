import { defineConfig } from 'vitest/config';

// 检索评测专用配置：与主测试套件完全隔离（主套件 include 只有 tests/**）。
// 运行：cd app && npx vitest run --config tools/retrieval-eval/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tools/retrieval-eval/**/*.test.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
  },
});
