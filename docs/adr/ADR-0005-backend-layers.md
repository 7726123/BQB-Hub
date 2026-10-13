# ADR-0005：后端按「功能包 + Controller / Service / Repository 三层」组织

- 状态：已采纳（2026-10）
- 日期：2026-10

## 背景

Java 服务端自换栈起是**一个扁平包**：30 个文件全在 `bqbhub.server`，9 个 `@RestController` 同时握着
HTTP 解析、业务规则（审核门 / 配额 / 限流口径 / 文件落盘）与内联 SQL（`jdbc.*` 在控制器里共 100 余处）。
单人不痛；要多人协作与阅读时，代价集中在这三处：

1. **换不掉实现细节**：想动一处 SQL（加索引、换写法、上 ORM）都得改控制器，并重跑黑盒契约；
2. **没有测试缝合点**：`src/test` 为空，改动只能靠契约套件（要起整个应用 + 临时库）；
3. **业务规则没有归属**：审核门、`admin_only`、配额散在控制器里，"HTTP 边界就是业务边界"。

同时有一条硬约束：**SQL 逐字不变**（Node 对拍 + 契约断言了错误文案与结果），所以不能顺手引 ORM/实体映射。

## 决策

1. **功能包 + 三层**（不是教科书四层/六层的大搬迁）：
   - 根包留基础设施：`ServerApplication` / `AppConfig` / `Beans` / `Db` / `SchemaMigrations` /
     `ApiError` / `ApiErrorAdvice` / `ApiFilter` / `TlsConfig`；
   - `support/`：新加的共享守卫与判定（`AdminGuard` / `AdminKeyGuard` / `Visibility`）。
     其余共享内核**仍在根包**（`Validators` / `Social` / `Media` / `Mailer` / `Limiters` / `RateLimiter` /
     `Scrypt` / `DayKey` / `AdminToken` / `Region` / `ReviewLog`），`AuthService` 是会话原语、所有领域共用，
     也留在根包——不做纯搬运式的 import 大改（那是噪声，不是收益）；
   - 领域包 `auth/ card/ feedback/ plugin/ preset/ proxy/ review/ system/ worldbook/`，每个域内：
     `XController`（参数解析 / 守卫 / 状态码 / 响应组装）→ `XService`（业务规则、事务、限额口径）→
     `XRepository`（SQL，只碰 `JdbcTemplate`）。
   - 大而杂的 `system`（465 行 / 14 路由）按受众拆成三组：分发（健康/版本/APK/网页包）、
     遥测（心跳/统计/漏答/客户端日志）、管理员（口令换令牌/留档）。
2. **SQL 字符串逐字保留**（搬移而非重写）；**不引 ORM、不引 DTO**（返回仍是 `Map`，避免 Jackson 序列化差异砸契约）。
3. **事务边界归 Service**（`FeedbackService` / `CardService` 的 `TransactionTemplate` 原样搬移，不新开事务）。
4. **边界由测试执行**：`LayeringTest`（ArchUnit）钉四条——Controller 不许碰 `JdbcTemplate`、
   功能包里只有 `*Repository` 能用它（`WbSearch` 是检索查询引擎，显式豁免）、
   Controller 不许跳过 Service 直接依赖 `*Repository`、`support` 不许反向依赖领域包。
5. **本层重构不改对外行为**：每个域的迁移都是独立 `refactor(server)` 提交，验收 = 契约套件对 jar 全绿。

## 后果

- 正面：读代码时"HTTP / 规则 / SQL"各在一处；Service 可以脱离 Spring 上下文单测
  （`TestDb` + 真 `JdbcTemplate`，见各 `*ServiceTest`）；契约套件继续作为对外行为的唯一真相。
- 正面：合并冲突面从"一个 528 行文件"缩到"各自领域包"；新人按域接手即可。
- 负面：多了一层（Controller → Service → Repository），小改动要碰两个文件；
  少数场景 Repository 会返回组装好的响应 Map（如世界书列表的三分支键集不同），并非纯数据访问——已在类注释里写明。
- 中性：`ProxyController` 没有 Service/Repository 拆分（无 SQL、纯流式转发），只移进了 `proxy/` 包。

## 关联

- `server-java/src/test/java/bqbhub/server/LayeringTest.java`（边界测试）
- `server-java/src/test/java/bqbhub/server/TestDb.java`（Service 单测的临时库）
- ADR-0004（Node 冻结：迁移期不允许顺手改 SQL 行为）
- `pom.xml`（archunit-junit5 依赖）
