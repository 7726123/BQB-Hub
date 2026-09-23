import { defineConfig } from 'vite';

// BQB Hub 前端构建工程
// 当前为骨架（占位入口）：迁移阶段将把 web/index.html 与模块逐个迁入 src/
// 迁移完成后 outDir 应指向 ../web（Capacitor webDir）
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    host: true
  }
});