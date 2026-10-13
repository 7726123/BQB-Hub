# ADR-0006：数据库结构迁移用 `PRAGMA user_version` 编号，Java 独占维护

- 状态：已采纳（v1.6.1 之后）
- 日期：2026-10

## 背景

换栈以来所有迁移都是「一串幂等 `addColIfMissing` / `CREATE ... IF NOT EXISTS`」，写在 `Db.migrate()`
（现 `SchemaMigrations.legacy()`）里，**没有任何版本标记**：每次启动都把所有步骤重跑一遍，
顺序靠代码书写次序，谁也不知道某个库"迁到哪一步了"。

单人不痛：步骤幂等，重跑无害。多人协作就痛：
① 两个人同时加列，都往同一个方法尾部追加，合并冲突且顺序不可控；
② 线上库与本地库的差别无法用一句话描述（"迁到哪一版了？"）；
③ 以后的迁移如果需要「先补数据再改结构」这类非幂等操作，没有版本标记就没法安全地只跑一次。

## 决策

1. 引入 `SchemaMigrations`：`Db` 只负责建连接池，建表/迁移全部交给它（行为与原 `Db.migrate()` 逐条一致）。
2. **`PRAGMA user_version` 是唯一版本标记**：
   - `0` = 从未迁移过（Node 建的库、老库都算）→ 跑基线段（现有全部幂等步骤）→ 置 `BASELINE = 1`；
   - 之后的新改动按编号追加（`NUMBERED`），`if (user_version < N)` 逐级补齐，缺哪级补哪级；
   - 库版本**高于**代码认识的版本（回滚场景）→ 只打印提示、什么都不做。
3. **Java 独占维护这个标记**：Node 版不读也不写（它跑起来时 `user_version` 原样留着）。
   这样 ADR-0004 的"冻结 + 回滚"不受影响——回滚到 Node 只是没人升版本号，不是版本冲突。
4. 迁移铁律（配合 ADR-0004 的冻结点约定）：
   - **纯增量 + 带默认值**、不改名不删列 → Node 回滚窗口内旧代码仍能读写老列；
   - 每条迁移**必须幂等**（"可重复启动、可对旧库就地升级"是 CONTRACT.md 的契约要求）；
   - 不建 FTS5（Node 运行时没有 FTS5，两边检索结果必须一致）；
   - 迁移的版本号一旦上线就不再修改其内容，只能追加新版本。
5. 这套编号**不进契约套件**：契约套件对 Node 也跑（ADR-0004 之前的口径），断言 `user_version`
   等于要求 Node 也实现编号，与"单实现"方向相反。验收放在 Java 单测里（`SchemaMigrationsTest`）。

## 后果

- 正面：线上库"迁到哪一版"可一句话回答；并行改动不再往同一个方法尾部挤；
  以后要做非幂等迁移（补数据、重建表）也有地方放。
- 正面：`mvn test` / CI 直接覆盖「老库就地升级」「重复启动幂等」「缺哪级补哪级」——
  以前只有「重启目标进程」隐式覆盖。
- 负面：多了一个必须记住的纪律（改 schema 就得加编号 + 保持纯增量）；忘了加编号时
  `user_version` 不动、但结构其实变了 → 由 code review 与 ADR 提醒兜底。
- 中性：`BASELINE = 1` 只是一个分界点，不代表库的"真实年龄"。

## 关联

- `server-java/src/main/java/bqbhub/server/SchemaMigrations.java`
- `server-java/src/test/java/bqbhub/server/SchemaMigrationsTest.java`（5 例）
- ADR-0004（Node 版冻结：纯增量迁移是回滚能力的支撑）
- `server/tests/CONTRACT.md` 第二节（数据库契约：夹具直读同一库文件）
