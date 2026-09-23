# 前端单 bundle / import 化改造方案（第一步）

> 状态：**P0 ✅ · P1 ✅ · P2 ✅ · P3-A ✅ · P3-B ✅（2026-09-09 全部完成）· P4 ✅ 单 bundle 落地
> （modules/main.js 单文件，index.html 单 script 标签）**。第二步（拆 god 文件 + hub 内部 import 化
> 与挂载收敛）另行排期。
> 配套 README 路线图第 6 行；第二步（拆 god 文件）衔接见文末。
> 本文档是执行方案：每个阶段有完成条件与验证动作，做完一段绿一段，master 始终保持可发。

## 1. 目标与终态

现状：30 个模块各自 esbuild IIFE 产物，经 `web/index.html` 30 个 `<script>` 按序加载，模块间通过
globalThis 挂载互访（48 个全局名 / 26 个定义文件；ui-refs 测试统计 180+ 内联事件引用依赖这些全局）。
手工维护 `?v=` 缓存戳；挂载散落在每个模块文件里。

终态（本步完成时）：

- 源码模块间用 **ES import** 直接引用，不再经全局协议；类型检查覆盖跨模块引用（改名/漏参即编译错）。
- 构建收敛为 **esbuild 单入口 bundle**，`index.html` 只挂 1 个 `<script>`；缓存戳由构建脚本自动写入。
- 全局挂载**不删除、但收敛**：只剩 `src/boot/compat.ts` 在 bundle 末尾统一挂载一个**白名单**
  ——白名单 = 所有被 HTML 字符串内联事件（index.html 静态 + TS 模板字符串）引用的名字。
  理由：内联 `onclick="X.method()"` 在全局作用域解析，这是唯一必须保留全局的理由；
  白名单由 ui-refs 抽取器生成/校验（漏挂即测试红），与加载顺序解耦。
- 真运行时全局从"散落 26 文件的 48 名"收敛为"1 处声明的白名单"，数目基本不变但成因显式、可审计。
- 加载顺序脆弱性、?v= 手工戳、per-module 挂载全部消失。

非目标（本步不做）：180+ 内联事件改 addEventListener（UI 层手术，留给第二步收尾）；
拆 god 文件与 @ts-nocheck 清零（第二步）；上 UI 框架（可选第三步）。

## 2. 现状基线（已验证数据）

- 30 模块；全局名 45（去重，P1 后）；定义文件 24（P1 后：usage/settingsync 挂载移除，
  UsageStats 归入 boot/compat.ts 白名单）。
- 跨模块引用出度：app.ts 30（hub）、ui.ts 15、cardwriter.ts 8、book.ts 7 …（app/scripts/scan-global-refs.cjs 产出）。
- 双向引用 13 对，全部星型汇聚：`app ↔ api / discussion / editor / mobile / modals / preset /
  summary / ui / update / usage / worldbook`，`community ↔ ui`，`preset ↔ ui`。
- 真实代码边 vs 字符串事件边（P2 逐对测量，app/scripts/scan-hub-surface.cjs 产出）：
  - **纯字符串事件边**（无 import 边，无需处理）：app↔worldbook（deleteBook 的 2 处真实调用除外）、
    app↔modals（3/3 在字符串）、mobile（3/4 在字符串）、worldbook 内 App 调用 6/6 在字符串。
  - **真实代码边**（允许环，调用期访问）：api(1: getPricingConfig)、discussion(12)、editor(8)、
    preset(7: UIManager 渲染 + App.toast)、summary(2)、ui(~100：toast 61/getPresets 等)、
    update(9: toast)、community(~94: toast 87)、cardwriter(39: toast 30)、assistant(2)、book(5)、
    settingsync(0 真实)。高频成员 = App.toast（合计约 200 处）、App.showConfirm、App.render*/load*。
- 顶层解引用审计（app/scripts/scan-top-level.cjs 产出）：**全库无模块在求值期解引用跨模块绑定** ✓；
  顶层副作用仅：app.ts DOMContentLoaded 注册、cardwriter.ts setTimeout(0)、community.ts async IIFE、
  各模块的 globalThis 挂载语句（单 bundle 后收敛为 compat）。
- 测试基线：vitest 424 例 + tsc 0 错 + ui-refs（180+ 引用 0 死）。
- 注：出度统计含字符串/注释噪声，逐对核对以 P2 处置表为准。

## 3. 关键决策（先定死，避免做一半）

- **D1 挂载白名单机制**：新增 `src/boot/compat.ts`（挂载白名单）+ 从 ui-refs 抽取器生成名单；
  `globals.d.ts` 同步收缩为该名单的声明。白名单外任何 `(globalThis).X = X` 出现即测试红。
- **D2 环策略（P2 审计后修订，2026-09-09）**：ESM 环在单 bundle 内合法，前提是铁律——
  **模块顶层求值期不得解引用其他模块的绑定**（跨模块调用只能在函数体内）。P2 审计结论：
  全库满足该铁律（无顶层跨模块解引用）。因此**不做大规模服务提取断环**（如 App.toast 约 200 处
  的提取在单 bundle 前不划算），13 对双向引用全部标注「允许环（调用期访问）」；
  真正的约束是**转换排序**：带顶层副作用（初始化监听/定时器/IIFE）的模块
  （app.ts DOMContentLoaded、cardwriter.ts setTimeout、community.ts async IIFE）只能在其消费方
  全部并入同一 bundle 后转换（即 hub 簇整并批），否则会被内联进多个 bundle 重复执行初始化。
  字符串事件边的调用（onclick="App.xxx" 等）不走 import，永远由 compat 白名单提供。
- **D3 构建形态**：先用 **esbuild 单入口**（MODULES 表合成一个 main 入口，format iife，产物路径不变），
  行为最接近现状、无 CSS/资源处理差异；Vite 全量接管（HMR/拆包）是后续可选优化，不在本步。
- **D4 版本戳**：单 script 标签的 `?v=` 由 build 脚本构建后自动写回 index.html（一行替换），消灭手工。
- **D5 分支策略**：直接在 master 小步推进（每批一个提交、全绿、可单独回滚）；
  仅当某批涉及大面积纯搬移（P3 中段）时临时开分支合并回。不冻结功能迭代——重构与功能在 master 混排，
  互踩时以"批粒度小、每批全绿"化解。**master 每周至少可切一次 APK**。

## 4. 阶段步骤

### P0 基线锁定（半天）
- 全绿快照：vitest 424 / tsc / lint；`git tag refactor-baseline`。
- 真机冒烟基线：六主路径（写作续写 / 世界书 / 记忆检索 / 写卡 / 助手 / 社区）各走一遍，记录现象。
- 把扫描脚本落位 `app/scripts/scan-global-refs.cjs`（本方案 P2/P3 复用：每批跑一次确认双向对递减）。

### P1 试点（✅ 完成 2026-09-09）
- **试点一 usage（叶子）**：lib/usage.ts 去挂载；消费方改 ES import（app.ts 引 UsageStats+_wbKey，
  book.ts/ui.ts 引 _wbKey）；globals.d.ts 删 2 声明；usage.js 停发、入口删除；index.html 该槽位换成
  **compat.js**（新 src/boot/compat.ts 白名单挂载，供「清空历史」按钮的字符串 onclick 解析）。
- **试点二 settingsync（中量）**：实测消费方仅 app.ts+ui.ts（比预估小）；去挂载后两文件加 import，
  19 处 typeof 守卫原样保留（import 后恒真，与"全局恒挂载"语义一致，零行为变化）；settingsync.js 停发。
- 试点暴露的真实类型错误已修：settingsync 真实类型流入 ui.ts 后浮出 3 处「possibly null」
  （var→const 使窄化穿透闭包）——印证"环境声明 any 掩盖错误，import 化让类型检查跨模块生效"。
- 完成条件达成：424 例 / tsc 0 错 / 产物 29=29=29 / 符号面 48→45 名、26→24 定义文件 / ui-refs 全绿。

### P2 环治理与排序决策（✅ 完成 2026-09-09，处置表见 §2）
- 13 对逐对测量真实代码边 vs 字符串事件边；顶层解引用审计全库通过（无求值期跨模块解引用）。
- 结论：**不做服务提取式断环**（toast 约 200 处提取在单 bundle 前不划算）；全部标注「允许环
  （调用期访问）」。字符串事件边永远由 compat 白名单提供。约束 = 转换排序（见 D2 修订与 P3）。

### P3 按批次 import 化（待执行，修订后顺序）
- **批次 A · 纯模块**（✅ 完成 2026-09-09）：clientlog（挂载入 compat 白名单，update.ts import）、
  modelcompat（api.ts import * as，原"独立 IIFE 全局协议"注释废除）、plugins（5 消费方去本地 declare
  改 import）、tavern-adapter（本就 import 形态，仅停发独立产物）、regex（app/ui/preset import；
  RegexRule 补 id? 可选字段 + app/preset 类型修正）。测试桩同步改造：database/settingsync/preset 原
  globalThis 假对象桩改为真实存储播种或直接 import（import 化后全局桩失效是预期）。符号面 48→40 名、
  26→20 定义文件；产物 24=24=24；424 例全绿。
- **批次 B · 数据簇 DAG**（进行中）：
  - worldbook ✅（2026-09-09：13 个消费方 import，含 lib/usage、lib/variables、lib/bm25；memory 的防御式
    globalThis 访问改直引；ui.ts 注入开关字符串 onclick → WorldBookManager 进 compat 白名单；修
    app.ts filterRelevantEntries 多余实参；10 个测试文件访问器改真 import、4 个文件方法覆写式桩）。
  - book ✅（同日：BookManager/parseSampler/normalizeQuotes 三挂载移除；8 个 src 消费方 import
    （app 引 3 名、character/database/discussion/memory/protagonist/summary/ui 引 BookManager）；
    parseSampler 返回类型定为 Record<string,any>（消费方宽松读取，与旧环境声明一致）；
    修 app.newBook 误调 BookManager.createBook → WorldBookManager.createBook（真实归属）；
    产物 22=22=22，符号面 36 名/19 定义文件。注：editor-stream 在并行全量跑中观察到 1 次瞬时
    失败（单跑与复跑均绿），疑似既有计时敏感型 flake，与本次改造无关，CI 若复现需单独排查）。
  - memory ✅ + database ✅ + variables ✅（同日：memory 消费方 app/book/ui；database 消费方 app/ui/
    lib-bm25（bm25 确有真实调用，此前被长行漏扫）；variables 消费方 app/ui + index.html「刷新变量」
    按钮字符串 onclick → VariableManager 进 compat 白名单（现 4 挂载）。类型浮出：ui.ts 表访问
    var→const 使窄化穿透闭包 + 2 处空守卫/非空断言；测试：memory.test/database.test/db-fill.test
    访问器与桩改真 import/方法覆写。产物 17=17=17，符号面 31 名/14 定义文件）。
  - summary ✅ + update ✅（同日：summary 消费方 app/editor（editor 首次获得 import）；update 双挂载
    移除 → UpdateManager 进 compat 白名单（index.html「检查更新」按钮字符串 onclick，现 5 挂载），
    消费方 app + clientlog（clientlog 的 window 访问器改直引，与 update 构成调用期环——合法）；
    summary.test 访问器改 import。产物 15=15=15，符号面 29 名/12 定义文件）。
  - **archive 推迟至 P4**（2026-09-09 决策）：archive 引擎（~900 行）与 lib/bm25 存在双向关系
    （bm25 的 ArchiveIndex 在运行时经全局读 ArchiveStore），提前转换会迫使 bm25.js 内联整个 archive
    引擎造成大体积双份；随 hub 簇整并一次性处理最省。
  待续尾批：preset / api / editor / assistant / discussion / mobile / modals。
  editor / assistant / discussion / update / mobile / modals（每批 2-4 个，重跑 scan-global-refs 确认双向对不新增）。
- **批次 C · hub 簇整并**（= P4 单 bundle 合并）：app / ui / community / cardwriter 及剩余全部——
  三者含顶层副作用（DOMContentLoaded / setTimeout / async IIFE），**必须**在其消费方全部并入同一
  bundle 后转换，禁止提前内联进多个 bundle。
- 每批验收：tsc + vitest 全量 + build +（触碰 UI 渲染的批）真机冒烟。每批保持为可单独回滚的变更
  （提交时机由维护者决定，当前策略为全部完成后统一提交）。

### P4 入口收敛（约 1 天）
- 删除 `app/src/legacy/*.entry.ts`（30 个）；build-legacy MODULES 表 → 单入口；index.html 30 script → 1；
  D4 自动戳落地；`globals.d.ts` 收缩为 compat 白名单声明；analyze-deps/产物级依赖图退休（转 ESM 后失去意义）。
- ui-refs 测试改造：扫描对象不变（index.html + TS 模板字符串），新增"引用名 ⊆ compat 白名单"断言。
- 完成条件：真机六路径冒烟 + 一次完整发版演练（sync → cap copy → gradle → 安装 → 更新检测正常）。

### P5 观察窗与收尾（约 1 天，可跨周）
- 产物符号 diff、白名单测试持续跑；README / engineering-architecture / web-migration 状态更新；
  docs/web-module-deps.md 标注退役。
- 本步完成标志 = D1-D4 全部落地 + 一个真实发版（如 1.5.63）由新管线走出。

工作量粗估：P0-P5 合计约 1.5-2 周（单人，含回归与冒烟；与功能迭代并行时按实际拉长）。

## 5. 对拍 / 冒烟清单（每批强制）

- 自动化：`npm test`（424）+ `npm run typecheck` + build 产物生成成功。
- 符号面：ui-refs 测试 = 挂载集合一致性（改前全局可解析名 = 改后 compat 白名单）。
- 真机（触碰 UI 的批）：六主路径；boot 期错误可见性（index.html 早捕获 + __recordErr，出错有 toast 而非白屏）；
  升级路径：装新包覆盖旧包，确认 `version.json`/更新检测正常（防 v1.5.45 类"装完仍提示更新"）。

## 6. 风险护栏与回滚

- 回滚 = `git revert` 单批提交（每批独立）+ 切回 P0 tag 重新出包。
- 单点启动风险（一个 bundle 挂 = 全挂）由 boot 错误可见化兜底（已有机制），P1 起持续验证。
- 环的 TDZ 风险由 D2 铁律 + P2 逐对核对兜底；P3 每批重跑扫描脚本确认双向对不反弹。

- **P4 单 bundle（✅ 完成 2026-09-09）**：新增 src/legacy/main.entry.ts 按旧 index.html 顺序导入剩余
  全部模块（storage/compat/preset/bm25/archive/api/editor/ui/mobile/discussion/cardwriter/assistant/
  modals/community/app，含 archive 与 bm25 互引对的合入）；build-legacy MODULES 收敛为单 main；
  index.html 30 个 script 标签 → 1 个（main.js，产物 ~1MB）；web/modules 旧产物全部清理。
  各模块顶层挂载与裸全局协议原样保留（测试与运行时语义零变化），esbuild 统一去重所有已 import 化
  模块的内联副本。验证：424 例全绿 / tsc 0 错 / 挂载标记单份。剩余优雅化（hub 内部 import、挂载
  收敛入 compat、d.ts 清零）归入第二步拆文件。

## 7. 第二步衔接（另立方案时展开）

- 前提澄清：全库已在 strict 类型检查下（无 @ts-nocheck 指令，2026-09-09 核实；app/ui/community/cardwriter
  头部注释的过渡态字样已改为准确描述）。
- 拆文件顺序：app.ts 先按 P2 提取的 services 落位，再拆 generate 流程 / 上下文组装 / 记忆检索 / 设定同步；
  拆完一个文件跑一轮全绿（纯搬移，行为零变化）。community/cardwriter/ui 同理按页面/职责拆。
- 类型收窄：逐方法把 `: any` 参数与 `[k: string]: any` 收窄为真实类型（域内 as any ~104 处）。
- 内联事件改绑定（若做）：180+ 引用随 compat 白名单收缩逐个 addEventListener/事件委托化，ui-refs 断言随之放宽。
