# ADR-0004：Node 版冻结为参考实现与回滚备份

- 状态：已采纳（v1.6.1）
- 日期：2026-10

## 背景

服务端有两套同构实现：`server/`（Node，原线上实现）与 `server-java/`（Spring Boot，2026-10-10 切换上线）。
两者靠 `server/tests/CONTRACT.md` 的黑盒契约套件保持一致（13 个用例文件，`CONTRACT_CMD` 指向任一实现即可跑，
对 Java 目标当前 91 例 / 88 通过 + 3 嵌入专用跳过）。这套"双实现对拍"在换栈期是最强的验收网，
但代价是**每个功能都要写两遍**（Java 实现 + Node 同步 + 契约套件扩展）——单人时是安全垫，多人协作时是 2 倍人力。

## 决策

1. **新功能只落 Java**（`server-java/`）；`server/` 冻结，不再跟随新功能。
2. Node 版保留两个用途：**参考实现**（读代码对拍、排查行为差异）与**回滚备份**
   （`server-java/deploy/flip-to-java.sh` 的自动回滚目标 `novel-community`）。
3. 契约套件继续作为验收网，但**只在 Java 上跑**（CI 的 `java-server` job，见 `.github/workflows/ci.yml`）。
4. 回滚能力只保证到**冻结点**（本 ADR 所在提交，`v1.6.1` / `81078c8`）：冻结点之后新增的表/列/接口，Node 版不认识。
   因此冻结点以后凡是改数据库的改动，迁移必须**纯增量 + 带默认值**，保证 Node 回滚窗口内旧代码仍能读写老列。
5. 唯一回头改 Node 的情形：**安全修复**（视为对冻结版的补丁，而非功能同步）。

## 后果

- 正面：每个新功能只写一遍；契约套件从"双实现对拍"回到"单实现验收"，维护面收窄。
- 负面：自动回滚退化为"回到冻结点"，不再跟随新功能；若线上必须回滚到 Node，
  冻结点之后的迁移需要人工回退（迁移纯增量 → 数据不丢，只是新列闲置）。
- 负面：`server/tests` 里日后新增的断言（只对 Java 成立的）不能再直接拿去跑 Node——
  对 Node 运行契约套件只到冻结点的用例集为止。
- 中性：`server/tests/CONTRACT.md` 的"换实现不改用例"依然成立，只是目标实现固定为 Java。

## 关联

- `server-java/README.md`（线上实现与契约验收现状）
- `server/tests/CONTRACT.md`（契约口径与两种跑法）
- `server-java/deploy/flip-to-java.sh`（自动回滚到 `novel-community`）
- ADR-0006（迁移编号策略：`PRAGMA user_version` 由 Java 独占维护）
- `.github/workflows/ci.yml` 的 `java-server` job
