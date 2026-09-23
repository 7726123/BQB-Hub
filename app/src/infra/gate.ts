// StorageManager 访问门：lib.dom 内置了同名全局类型（Web Storage API 的
// StorageManager 构造器），TS 里裸标识符会被 dom 类型劫持——因此不能像其他
// 外部全局那样 declare。storage 产物已显式挂载 globalThis.StorageManager，
// 这里通过 globalThis 访问（import type 只取类型，不引入运行时代码/副作用，
// bundle 内嵌本模块是安全的）。
import type { StorageManagerClass } from './storage';

export const SM = (): StorageManagerClass =>
  (globalThis as unknown as { StorageManager?: StorageManagerClass }).StorageManager!;