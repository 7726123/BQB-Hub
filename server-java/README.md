# BQB Hub 社区服务端 · Java 版（Spring Boot + SQLite）

换栈第一步的产物：**只换语言、不换数据库**。目标实现与 Node 版（`server/`）共用同一套验收测试，
契约写在 [`server/tests/CONTRACT.md`](../server/tests/CONTRACT.md)——环境变量、HTTP 接口、状态码、
限流阈值、口令派生格式全部与 Node 版一致，所以同一套用例可以对着两个实现跑。

**验收状态（2026-10-10）**：契约套件对 Java 目标 **84 例 = 81 通过 + 3 嵌入专用跳过 + 0 失败**
（与 Node 版基线逐例一致，`npm run test:contract` 退出码 0）；TLS 双端口与协议感知 apkUrl 已进契约
（`server/tests/tls.test.js`，Java 侧 4/4 通过，PKCS#8 与 PKCS#1 两种私钥格式都验过）。
**线上已切换**：2026-10-10 傍晚在真实数据上灰度演练 22/22 通过后切换，线上服务现由本实现提供
（`bqbhub-java` active+enabled）；切换过程、证据与回滚命令见交接文档 §13.164。

## 怎么构建 / 怎么跑

```bash
# 构建（JDK 17+；本机 JAVA_HOME=/d/jdk-17.0.12，maven 在 /d/JAVAstudy/apache-maven-3.8.8）
cd server-java && mvn -DskipTests package        # 产物 target/bqbhub-server-java.jar

# 运行：环境变量与 Node 版同名（见 CONTRACT.md 第一节）
PORT=8899 DATA_DIR=/srv/data CONFIG_FILE=/srv/config.json \
APP_VERSION_FILE=/srv/app-version.json WEB_BUNDLE_DIR=/srv/web-bundles \
UPLOAD_DIR=/srv/uploads APK_DIR=/srv/apk ADMIN_KEY=... ADMIN_PW_HASH=... \
java -Xmx384m -XX:MaxMetaspaceSize=128m -Xss512k -jar target/bqbhub-server-java.jar
```

**内存参数建议**（单机 2 核 / 1.6G / 无 swap 的现状，见交接文档 §13.161）：
`-Xmx384m -XX:MaxMetaspaceSize=128m -Xss512k`，配 systemd `MemoryMax=900M` + `Restart=always`；
上线前先加 2G swapfile（不然 OOM killer 会挑 RSS 最大的进程杀，换 JVM 后就是它）。
Spring Boot 冷启动约 3 秒（契约测试默认 30 秒等待，够）。

> **实测（2026-10-10，本机 JDK 17，上面这组参数）**：空载 RSS **192MB**、启动 **3.16 秒**；
> 随后跑完整套契约测试（JVM 起停十余次）没有再往上爆。也就是说「换成 Java 内存吃不下」这个顾虑
> 在这台机器上基本不成立（Node 版约 100MB，Java 版约 200MB，离 1.6G 的上限还有很大余量）。

## 验收：契约套件对着 Java 跑

```bash
cd ../server
CONTRACT_CMD="java -jar \"C:/Users/a7726/BQB Hub/server-java/target/bqbhub-server-java.jar\"" npm run test:contract
# 或单文件：
CONTRACT=1 CONTRACT_CMD="java -jar ..." node --experimental-sqlite --test tests/card.test.js
```

连线说明：契约模式会 spawn 这个 jar，通过环境变量给它隔离目录（`DATA_DIR` 等），
夹具直读它建的 `chat.db`；`clearLimiters()` 的等价物是重启进程（内存限流桶随之归零）。

## 与 Node 版的差异 / 缺口（上线前必须过一遍）

| # | 项 | 状态 | 说明 |
| --- | --- | --- | --- |
| 1 | TLS 第二端口 | ✅ 已实现 | `TlsConfig`：启动时把 PEM（证书链 + 私钥，PKCS#8/PKCS#1 都认，用 BC 的 `PEMParser`）转成 PKCS12 临时文件喂给第二个 Tomcat 连接器（`TLSv1.2,TLSv1.3` + honorCipherOrder，对齐 Node 的 `minVersion:'TLSv1.2'`）；**证书不可读只跑 HTTP、启动不失败**。契约测试 `server/tests/tls.test.js` 4 例（Node/Java 两侧都过） |
| 2 | 地区拦截（geoip） | ❌ 未实现 | `regionBlock=true` 时启动会打 `[warn]`，行为等于不拦截。当前生产/测试都是 false |
| 3 | FTS5 检索索引 | 有意不建 | Node 运行时（node:sqlite）没有 FTS5，检索本来就走多路 LIKE；Java 侧保持一致，两边结果才可比 |
| 4 | 发信 | ✅ jakarta.mail | 配置仍读 `config.json` 的 smtp 段；未配置时回 500 + 同款文案（与 nodemailer 行为一致） |
| 5 | 限流 | ✅ 内存单实例 | 与 Node 版同款（多实例部署要换 Redis，两边一样是 TODO） |
| 6 | 口令派生 | ✅ 已对拍 | `server/tools/scrypt-parity` 正向 9/9、反向 2/2 逐字节一致（BC 1.67 与 1.78.1 都验过） |
| 7 | 管理员留档令牌 | ✅ 格式一致 | HMAC 格式与 Node 版逐字节相同：灰度切换时 App 上已拿到的 12 小时令牌继续有效 |
| 8 | 会话 | ✅ 同构 | 不透明随机令牌存 `sessions` 表：换 Java 后老会话天然有效，用户不用重登 |
| 9 | `Range` 请求处理 | ✅ 更好（差异） | Java 走 Spring 静态资源：支持 `Range` → `206` 与断点续传；Node 版忽略 `Range` 整包返回 `200`。App 下载 APK/热更包都是普通 GET，两边行为一致（冒烟脚本会把这条差异标出来） |

## 系统版凭据与内测渠道（2026-10-11）

- 服务端多认一种**机器凭据**：`X-System-Key`（= 环境变量 `SYSTEM_KEY` 或 `config.json` 的 `systemKey`），
  在全部管理接口上与 `X-Admin-Token` 等价（Node/Java 两侧同步实现：`AuthService.isSystem` ↔ `auth.js` 的 `isSystemReq`）。
  可选 `systemInstallIds` 白名单：非空时，带凭据的请求还必须带白名单内的 `X-Install-Id` 才生效。
- `GET /api/app/web-bundle?channel=beta`：只有「精确 `beta` + 凭据命中」才读 `manifest-beta.json`，
  其余（无凭据 / 坏凭据 / 未知渠道值）一律读正式 `manifest.json`；beta 缺失或结构不完整时**回落正式**
  （系统版永远拿得到可用包）。zip 与正式包在同一目录平铺，客户端按签名 payload 取包名，原生不区分渠道。
- 契约：`server/tests/{adminpass,web-bundle,system-key}.test.js` + `CONTRACT.md` 的「系统版契约」小节；
  **Node 与 Java 各 90 例逐例一致**（2026-10-11 实测，含"改 config.json + 重启目标"的白名单用例）。
- 线上 `/server/config.json` 已并入 `systemKey`（改动前留了 `config.json.bak-<时间>` 备份）。
  **轮换** = 改服务器 config.json + 改本机 `~/.gradle/gradle.properties` 的 `BQB_SYSTEM_KEY` + 重建系统版 APK
  （旧包立即失效）；系统版的分发纪律见发布技能里的「系统版」一节（不发 Release / 不进公开目录）。
- 热更渠道的打包与提升在 `scripts/hot-bundle.mjs`：`pack --channel beta` 写 `manifest-beta.json`，
  `promote` 把 beta 原样提升为正式（含签名 / code 严格递增 / zip 存在三道守卫）。

## 部署与灰度演练（`deploy/`、`tools/`）

前置：目标机要有 JDK/JRE 17+。OpenCloudOS 9（线上那台）：
`dnf install -y java-17-openjdk-headless`（实测装的是 TencentKonaJDK 17.0.20，约 180MB）。

**灰度演练（完全不碰线上）**：`bash deploy/canary-setup.sh`
1. 只读检查线上服务与端口；
2. 用 `VACUUM INTO` 从线上库拉一份**一致性快照**（不打断线上读写）到 `canary/data/chat.db`；
3. 拷贝 `uploads/`（几百 KB）与 `config.json`/`app-version.json`；`apk/`、`web-bundles/`、`certs/` 做成**只读软链**
   （绝不复制 2G 的 APK 目录）；线上库与上传目录**一个字节都不写**；
4. 生成并启动 `bqbhub-java-canary.service`（候选端口默认 HTTP 18899 / TLS 18443；**只 start 不 enable**，
   机器重启后回到只跑线上）；
5. 等健康检查通过并打印冒烟命令。重跑会自动停旧实例 + 重做快照（对比项只对刚快照的副本成立）。

**对比冒烟**：`node --experimental-sqlite tools/smoke.mjs --base … --tls-base … --live … --live-tls … --db … --seed-login`
覆盖：分发内容逐字节一致（version / 热更 manifest / APK 首段）、统计口径与版本分布一致、管理端反馈计数一致、
**线上实现签发的留档令牌被候选接受**（HMAC 逐字节兼容）、TLS 双端口与协议感知 apkUrl、写路径落进副本、
**Node 生成的派生值可登录**（老用户迁移等价验证）、错误口令 401 负例。令牌/口令走环境变量传入，不进 `ps`。

**切换那一刻**（人工决定）：`bash deploy/flip-to-java.sh` —— 停候选 → 停 Node 并摘掉自启（单元保留）
→ 装并启用 `bqbhub-java.service` → 双端口健康检查；**Java 起不来会自动回滚到 Node**。
回滚（任何时刻）：`systemctl disable --now bqbhub-java && systemctl enable --now novel-community`。
⚠ **旧部署脚本要挡**：仓库里那套 Node 版 `deploy.sh` 会 `restart novel-community`（换服务名后就是抢端口 +
覆盖单元）。切换后已在线上给它加了护栏（检测到 `bqbhub-java` enabled 就 exit 1）；自己搭环境时留意同一件事。

**线上实测（2026-10-10，那台 2C/1.6G）**：canary 冒烟 **22/22 通过**；Node 与 Java 同时在线时
RSS 分别 **227MB / 200MB**，机器可用内存 823MB（余量充足）。演练期间线上库 `devices=3 / feedback=0`
一字未变（canary 副本 4/1，增量全是冒烟自己写的）。切换后线上 java RSS **174MB**、真实流量正常
（含 `/apk/…` 的 206 分段下载）。

## 实现要点（踩过的坑都在这）

- **SQLite 逐条执行 DDL**：xerial 驱动的 `Statement.execute` 遇到「返回结果集的语句」（如 `PRAGMA`）
  会停在它那里，一个字符串里塞多条 DDL 会**静默丢掉后面的**（第一版整批建表没跑，只有后面的单条建表生效）。
- **并发口径**：`journal_mode=WAL&busy_timeout=5000&synchronous=NORMAL&transaction_mode=IMMEDIATE`
  写进 JDBC URL；连接池默认 4（`DB_POOL_SIZE` 可调，单写者场景设 1 即复刻 Node 的单连接串行语义）。
  多语句写事务只有反馈的「插入 + 裁剪」，走 `TransactionTemplate`（同一个连接）。
- **数据源由自己建**：`Db` 建 Hikari 并把 `DataSource` 暴露成 Bean，Boot 的自动配置因此退让，
  不用在 YAML 里重复配库（路径全部来自环境变量）。
- **错误形状统一**：`ApiError` + `@RestControllerAdvice`，未知路径回 `{"error":"未找到 <path>"}`
  （与 Node 版同款），请求体坏 → 400 `无效的请求体`，其余 500 `服务器内部错误`（栈只进日志）。
- **口令派生**：登录 `scrypt(pw_utf8, salt_string_utf8, 64)` hex（★盐是那个 hex **字符串**的 UTF-8 字节，
  不是 hex 解码）；管理员 `scrypt$N$r$p$saltB64$hashB64`（32 字节）。用 Bouncy Castle，别用
  `spring-security-crypto` 的 `SCryptPasswordEncoder`（它输出 `$scrypt$N=..` 格式，读不了线上 config.json）。
- **客户端中断不打堆栈**：取消下载/手机切网会抛 `AsyncRequestNotUsableException`（Tomcat 侧是 `ClientAbortException`）——
  这在移动端是常态，`ApiErrorAdvice` 里有专用 handler：只记一行 `[client-abort]`、不写响应体（响应已断开，
  写什么都写不进去）。第一版落到通用 500 分支，结果每次断流都在 journal 里刷 40 行堆栈（上线当天就踩到）。
- **测试钩子**：Java 侧不需要导出限流器对象（契约模式靠重启清桶），所以没有 `_limiters` 这类导出。
- **TLS 只能从 keystore 读**：Tomcat 的 `SSLHostConfigCertificate` 只接受 keystore 文件（没有
  「直接给 KeyStore 对象」的 API），所以启动时把 PEM 转成 PKCS12 临时文件（`Files.createTempFile`
  → POSIX 下是 600 权限，`deleteOnExit`）。私钥解析走 BC 的 `PEMParser`（在 **bcpkix** 里，不是 bcprov），
  PKCS#8（线上证书是这种，已确认 `BEGIN PRIVATE KEY`）与 PKCS#1 都支持；加密私钥不支持（配置里没有口令位）。
- **双端口**：主连接器是 HTTP（`${PORT}`），TLS 用 `factory.addAdditionalTomcatConnectors` +
  `connector.addSslHostConfig(...)`（注意是 **catalina** 的 `Connector`，不是 coyote 的）。

## 目录

```
pom.xml                        Spring Boot 3.3.5 + spring-boot-starter-{web,jdbc,mail} + sqlite-jdbc + bcprov
src/main/resources/application.yml   端口来自 ${PORT}；Tomcat 线程收窄到 50；静态资源映射关闭
src/main/java/bqbhub/server/
  ServerApplication / AppConfig / Db / Beans        启动、配置（环境变量 + config.json）、库与迁移
  ApiFilter / ApiError / ApiErrorAdvice             安全头、CORS、日志、统一错误
  TlsConfig                                        HTTPS 第二端口（PEM→PKCS12，缺证书降级为只跑 HTTP）
  RateLimiter / Limiters                           内存滑动窗 + 阈值表（阈值属契约）
  Scrypt / AdminToken / AuthService / Mailer        口令派生、留档令牌、会话、发信
  AuthController / SystemController / FeedbackController / ProxyController
  WorldbookController / PresetController / PluginController / CardController / ReviewController
  WbSearch / Social / Media / ReviewLog / Validators / DayKey   检索、社交读侧、载荷校验等工具
```

## 下一步（不急）

1. **切流量前的灰度演练**：让 Java 版在备用端口对着 `chat.db` 的副本跑，用契约套件 + 真机冒烟确认后
   再改 systemd 起哪个进程；注意同一份库**只允许一个进程写**（两个实现同时写会互撞锁）。
2. geoip 地区拦截（缺口 2）——只有真要开 `regionBlock` 时才需要。
3. MyBatis-Plus：等要做后台管理这类 CRUD 密集功能时再上（现在是 JdbcTemplate + 逐条直译 SQL，
   方言不变的阶段这是成本最低的写法）。
4. 换掉 SQLite 时：先抽 DAO 层，再把 `CONTRACT.md` 第二节列出的「直读库夹具」改成走接口。
