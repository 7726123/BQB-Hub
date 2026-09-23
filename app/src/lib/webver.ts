// 正在运行的网页包版本（热更新）——无依赖的叶子模块，避免 clientlog / ui / hotbundle 之间成环。
// 语义：'' = 跑 APK 内置资源；非空如 '1.5.97w1' = 跑的是热更新下来的网页包。
// 写入方只有 domain/hotbundle.ts（启动时由原生拿状态），读取方是版本显示与错误上报。
let _webVersion = '';

export function getWebVersion(): string {
  return _webVersion;
}

export function setWebVersion(v: string): void {
  _webVersion = String(v || '');
}

/**
 * 版本展示串：**只显示正常版本号**（热更新不改版本号，界面上不再出现「网页包 x」这种第二版本名）。
 * 正在运行的代码版本仍记录在 getWebVersion() 里，供错误上报与管理员版本分布使用。
 */
export function formatVersion(appVersion: string): string {
  return String(appVersion || '');
}
