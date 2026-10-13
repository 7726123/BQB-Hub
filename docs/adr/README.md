# 架构决策记录（ADR）

按时间顺序编号；每条只记"当时为什么这么定"，落地细节看关联代码与测试。

| # | 决策 | 状态 |
|---|---|---|
| [0001](ADR-0001-inject-toggle.md) | 世界书条目注入模型精简为单一开关 | 已采纳（v33） |
| [0002](ADR-0002-region-block.md) | 大陆地区拦截做成布尔开关（geoip 未移植） | 已采纳 |
| [0003](ADR-0003-assistant-miss-protocol.md) | 使用助手漏答上报的协议与隐私口径 | 已采纳 |
| [0004](ADR-0004-node-freeze.md) | Node 版冻结为参考实现与回滚备份 | 已采纳（v1.6.1） |
| [0005](ADR-0005-backend-layers.md) | 后端按"功能包 + Controller / Service / Repository 三层"组织 | 已采纳（2026-10） |
| [0006](ADR-0006-migration-versioning.md) | 结构迁移用 `PRAGMA user_version` 编号，Java 独占维护 | 已采纳（2026-10） |

模板（与既有条目一致）：标题「`# ADR-00NN：<一句话决策>`」+ 元信息（状态 / 日期）+ 四节
`背景` / `决策` / `后果` / `关联`。新增 ADR 时同时更新本表。
