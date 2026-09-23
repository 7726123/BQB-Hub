// vitest 测试环境：node 环境模拟浏览器全局。
// window = globalThis 供模块挂载全局；localStorage 用内存桩；
// indexedDB 故意不提供 → StorageManager.init() 走降级路径（这正是无 IDB 环境的真实行为）。
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

(globalThis as unknown as Record<string, unknown>).window = globalThis;
(globalThis as unknown as Record<string, unknown>).localStorage = new MemoryStorage();
// StorageManager 桩：SM() gate 在模块 import 时就可能被读取（默认值兜底）
(globalThis as unknown as Record<string, unknown>).StorageManager = { get: (_k: string, d?: unknown) => d, set: () => undefined };
// 默认断网：测试绝不允许真的发请求。Node 18+ 自带全局 fetch，一旦被测代码走到上报/上报重试
// （例如 clientlog 的错误上报、以及 2026-09-22 给填表加的诊断上报）就会真打到生产服务器——
// 那次就在 client_logs 里留下了 8 条来自测试环境的假诊断。需要网络的用例自行覆写 globalThis.fetch。
(globalThis as unknown as Record<string, unknown>).fetch = () => Promise.reject(new Error('network disabled in tests'));
// 最小 document 桩：render() 类方法在 node 测试下走「元素不存在即返回」分支
(globalThis as unknown as Record<string, unknown>).document = {
  getElementById: (): null => null,
  addEventListener: (): void => undefined,
  removeEventListener: (): void => undefined,
  querySelector: (): null => null,
  querySelectorAll: (): [] => [],
};