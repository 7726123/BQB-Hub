import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts'],
    // 迁移后的产物单测（直接跑编译后的 web/modules 产物，验证行为等价）
    // include: ['tests/**/*.test.ts', 'tests/build/**/*.test.ts'],
  }
});