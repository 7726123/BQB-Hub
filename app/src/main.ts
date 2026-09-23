// 占位入口：当前工程为构建骨架，尚未承载业务模块。
// 用最小代码验证 Vite + TS 严格模式链路可用（typecheck → bundle → build）。
const root = document.getElementById('status');
if (root) {
  root.textContent = `构建链路 OK（${new Date().toISOString().slice(0, 19)}）`;
}

export {};