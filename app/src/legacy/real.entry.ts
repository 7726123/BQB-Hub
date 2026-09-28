// 遗留全局入口：真实模式（realstate 隔离核 + realmode 视图与调用链，挂 globalThis.RealMode）。
// RealState 也挂一份：页面自查/验收要直接看"某个角色的视角切片里有什么"（物理隔离的探针）。
import { RealState } from '../domain/realstate';
import '../domain/realmode';

(globalThis as any).RealState = RealState;
