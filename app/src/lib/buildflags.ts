// 干净版（离线版）开关：全项目"要不要碰我方服务器"的唯一判据。
//
// 两个构建：
//   · 完整版（默认）：esbuild 不注入 __BQB_CLEAN__ → typeof 判定为 false，行为与历史完全一致；
//   · 干净版：`npm run sync:legacy:clean`（scripts/build-clean.mjs）用
//     esbuild --define:__BQB_CLEAN__=true 构建，注入后该标识符在产物里就是 true。
//
// 为什么用函数而不是顶层常量：测试要能直接翻开关（__setCleanForTest），
// 不必为两种版本各跑一遍构建；各调用点也就能在运行期读到最新值。
declare const __BQB_CLEAN__: boolean;

let _clean: boolean = typeof __BQB_CLEAN__ !== 'undefined' && __BQB_CLEAN__ === true;

/** 当前是不是干净版（无社区/账号/在线更新/热更新/埋点/反馈/管理端的构建）。 */
export function isClean(): boolean { return _clean; }

/** 仅测试用：临时切换干净版开关。 */
export function __setCleanForTest(v: boolean): void { _clean = !!v; }
