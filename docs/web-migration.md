# 前端模块迁移路线（旧 web 目录 → app/）

> **2026-09-09 状态**：迁移主体已完成——30/30 模块纳入统一构建管线（此后新增 settingsync、tavern-adapter 等），
> vitest 424 例；**全库处于 strict 类型检查下，不存在 @ts-nocheck 指令**——community/cardwriter/ui/app 头部
> 注释曾写「暂以 @ts-nocheck 过渡态」属陈旧文字（2026-09-09 核实：tsc 全量覆盖 0 错），XxxShape 接口标注完成。
> 单 bundle / import 化已全部完成（2026-09-09：17 模块 import 化 + modules/main.js 单产物，
> 见 docs/single-bundle-refactor.md）。
> 本文档保留为迁移期记录，细节以代码为准。

目标：把 web/ 下的全局脚本模块逐个迁入 app/src，最终让 Capacitor 的 webDir 指向构建产物。

## 现状

- 30 个模块以 `<script>` 顺序加载，通过**全局作用域 / globalThis 挂载**共享符号（已迁移模块显式挂载，
  globals.d.ts 集中声明）。
- 统一构建管线（esbuild IIFE 逐模块产物，`cd app && npm run sync:legacy`）；`web/index.html` 是加载清单
  （各带 `?v=` 缓存戳，仍手工维护）。
- 依赖图（脚本自动生成）：见 [web-module-deps.md](web-module-deps.md)。

## 迁移顺序（按依赖拓扑，先迁被依赖者）

✅ 已完成（30/30，全部模块纳入统一构建管线；settingsync 等为迁移期间新增模块）：
- 基础/纯逻辑层（深度类型化）：`storage`、`variables`、`regex`、`usage`、`bm25`
- 领域层（深度类型化）：`worldbook`、`book`（+parseSampler+normalizeQuotes）、`protagonist`、`character`、`preset`
- 能力层（深度类型化）：`api`、`archive`、`summary`、`database`、`memory`、`editor`、`vector`
- UI 层：`ui`、`mobile`、`discussion`、`cardwriter`、`assistant`、`modals`、`community`、`update`、`app`
  —— mobile/discussion/assistant/update/modals 深度类型化（纯函数抽取 + 单测）；
  community/cardwriter/ui/app 为超大文件（接口标注完成；注释残留过渡态字样，实际全量检查，见文首）

迁移中修复的历史 bug（3 个）：
1. 正则 {{match}} 占位符从不生效（$& 被外层 replace 展开）
2. computed 表达式对中文变量名失效（ 词边界不含中文）
3. **summary.js 从未被 index.html 加载**——三层摘要功能（段落/场景/章节摘要、伏笔提取）
   整体从未生效（app.js 调用点都带 typeof 守卫所以不报错）；已补 script 标签启用
4. memory.js 的 saveVault 防清空（BLOCKED）机制对"同引用原地清空"无效：getVault 返回
   cache 内同一对象，原地清空直接污染 cache。**已于 2026-08-23 修复**：getVault 返回深克隆、
   saveVault 存深克隆（阻断引用共享），BLOCKED 真实生效；显式删除类操作
   （deleteEntry/markConsolidated/deleteByChapter）显式 force 放行（删光最后一并合法）。
   测试固化 4 个场景 + 真机验证（假清空被拦截、显式删除正常）。

外部全局类型已集中到 app/src/globals.d.ts（StorageManager 因 lib.dom 同名冲突走
src/infra/gate.ts 的 SM() 访问器），新增迁移模块按需扩充 globals.d.ts 即可。

> 迁移方式：TS 源码在 app/src（infra/storage.ts、lib/*.ts），由 `npm run sync:legacy`
> （app/scripts/build-legacy.mjs，esbuild IIFE）输出回 web/modules/<同名>.js，
> 保持 index.html 全局 script 顺序加载不变。
> 产物行为由 vitest 单测（424 例）+ node 产物端到端验证 + 真机 WebView CDP 验证。
>
> **依赖解析约定（重要）**：TS 模块对未迁移全局一律用**裸标识符 + typeof 守卫**。
> 旧脚本的全局是顶层 `const`（只进全局词法作用域，不挂 globalThis 属性），
> 用 `globalThis.X` 访问会得到 undefined——真机踩过的坑，已修正为裸标识符
> （解析顺序：全局词法作用域 → 全局对象环境，两种声明方式都命中）。
>
> 迁移中修复的历史 bug：① 正则 {{match}} 占位符从不生效（$& 转义）；② computed
> 表达式对中文变量名失效（\b 词边界不含中文，改用自定义断言边界）。

1. **纯逻辑层（零/少 UI）**：~~storage~~ → ~~variables~~ → ~~regex~~ → ~~usage~~ → ~~bm25~~
2. **领域层**：~~preset~~ → ~~protagonist~~ → ~~character~~ → ~~worldbook~~ → ~~book~~
3. **能力层**：~~api~~ → ~~archive~~ → ~~summary~~ → ~~database~~ → ~~memory~~ → ~~editor~~
2. **领域层**：`preset` → `protagonist` → `character` → `worldbook` → `archive` → `memory` → `database` → `vector` → `summary`
3. **能力层（API/IO）**：`api` → `update` → `editor`
4. **UI 层（最后）**：`ui` → `mobile` → `discussion` → `cardwriter` → `assistant` → `modals` → `community` → `app`

## 每个模块的迁移步骤

1. 移入 `app/src/<layer>/`，改为 ES Module（显式 `export`，全局符号改为 `import`）。
2. 逐个替换其他模块里的全局引用（交叉迁移：迁 A 时把 B 对 A 的引用改成 import）。
3. 在 `web/index.html` 的 script 清单中**移除已迁模块**，新增 `<script type="module" src="/src/main.ts">` 承载迁移部分。
4. 纯逻辑尽量抽成纯函数并补 Vitest 单测（注入/检索/记忆归档类逻辑是重点）。
5. 每个模块迁移完成 → `npm run build` + 模拟器冒烟（写作/世界书/记忆/写卡/社区/助手六条主路径）。

## 注意事项

- **全局共享是最大风险**：模块依赖顺序不能乱。迁移一个模块 = 它的全局符号先从 `window` 作用域消失，任何残留引用都会运行时炸。因此依赖分析脚本必须重跑核对。
- 缓存戳 `?v=` 在模块化后不再需要（Vite 产物自带 hash）。
- 迁移完成前，vitest 只能测迁移过去的纯逻辑；未迁移部分保持现状不动。
- Capacitor webDir 切换是最后动作：`vite build` 产物与现有 web 目录的**行为对拍**（同一页面截图/冒烟清单）通过后再改 `capacitor.config.json`。

## 相关脚本

- ~~`node scripts/analyze-deps.mjs` → 重新生成依赖图~~（单 bundle 改造后该脚本与产物级依赖图一起退休，已删除）
- `cd app && npm run build` → 类型检查 + 构建验证
## 接口化终态说明（4 个巨型 UI 模块，2026-09 修订）

community/cardwriter/ui/app（约 9700 行，见 TECH_DEBT_AUDIT F009「god 文件」）走"接口化"过渡：

- 各主对象的 `XxxShape` 接口已生成并标注（`const X: XxxShape = {...}`，方法契约进入类型系统），
  动态字段经 `[k: string]: any` 兜底；
- 4 个文件头部注释曾写「暂以 @ts-nocheck 过渡态」，但**实际不存在该指令**——tsc 对全库 30/30
  严格检查（0 错），注释为陈旧文字（2026-09-09 核实并已改源文件注释）。
- 剩余路线（每步以 tsc 零错为验收）：
  ①逐方法把 `: any` 参数与 `[k: string]: any` 收窄为真实类型（域内 `as any` 约 104 处，审计 F015）
  ②按 docs/single-bundle-refactor.md 拆 4 个巨文件（纯搬移 + 行为零变化）。
- DOM 宽松：globals.d.ts 中 Element/EventTarget/HTMLElement 的附加成员仅为读写打通，
  不允许把父类必选成员（textContent 等）覆盖为可选（会破坏继承赋值兼容，踩过的坑）。
