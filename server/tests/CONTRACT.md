# 服务端接口契约（契约测试）

同一套用例，两跑法：

| 模式 | 命令 | 目标 | 用例数 |
| --- | --- | --- | --- |
| 嵌入（默认） | `npm test` | 本进程 `require('../src/app')`，DB 直连 `src/db` | 14 文件 / 110 例（106 通过 + 4 契约专用 skip） |
| 契约 | `npm run test:contract` | **独立进程**（默认 `node src/main.js`），只经「环境变量 + HTTP + SQLite 库文件」 | 13 文件 / 90 例（87 通过 + 3 嵌入专用 skip） |

契约模式的用途：**换实现不改用例**。将来服务端改 Spring Boot，只把目标换成 Java 包即可：

```bash
# 先拿基线（Node 版）
npm run test:contract

# 再验收 Java 版（Windows PowerShell: $env:CONTRACT_CMD="java -jar ..."）
CONTRACT_CMD="java -jar ../server-java/target/app.jar" npm run test:contract
```

- 额外参数原样转给 `node --test`：`npm run test:contract -- --test-name-pattern=爆破`
- `CONTRACT_BOOT_MS`（默认 30000）：目标进程启动等待上限，Java 冷启动慢就调大
- 硬约束：**契约模式的用例进程不得加载任何 `src/` 模块**（`helpers.stop()` 自检，发现即失败）。
  这意味着用例只依赖下面写明的外部契约，不依赖当前实现。
- `clearLimiters()` 的实现差异：嵌入模式直接清内存桶；契约模式的等价物是**重启目标进程**
  （内存桶随进程归零；会话/内容都在 SQLite 与上传目录里，不受影响）。所以任何实现都必须做到
  「重启后内存态限流归零、其余状态从 DATA_DIR 恢复」。

## 一、进程与环境变量契约

目标进程启动时必须：

1. 从环境变量读配置（下表），目录不存在则创建；启动时幂等建表/迁移（可重复启动、可对旧库就地升级）。
2. 监听 `PORT` 的 HTTP。TLS 端口可选：**证书文件缺失时必须只跑 HTTP 而不是启动失败**（测试用不存在的证书路径）。
3. 提供健康检查：`GET /api/health`（还有 `/`）→ `200 {ok:true,...}`。契约测试靠它等启动完成。
4. 测试环境必须无外部副作用：SMTP 配空 → `send-code` 不真发信；不访问外网。

| 环境变量 | 用途 | 契约模式给的值 |
| --- | --- | --- |
| `PORT` | HTTP 监听端口 | 随进程 pid 派生（13000+pid%1000） |
| `DATA_DIR` | 库与运行时数据（`chat.db` 就在这） | 临时目录 |
| `UPLOAD_DIR` | 社区内容文件（`worldbook/`、`preset/`、`plugin/` 子目录） | `<tmp>/uploads` |
| `APK_DIR` | APK 分发目录 | `<tmp>/apk` |
| `APP_VERSION_FILE` | 版本信息 JSON（`versionCode/versionName/note/apk/apkUrl`） | `<tmp>/app-version.json` |
| `WEB_BUNDLE_DIR` | 热更新 `manifest.json` 与 `web-*.zip` | `<tmp>/web-bundles` |
| `CONFIG_FILE` | 本地配置 JSON（`smtp`/`regionBlock`/`adminKey`/`adminPasswordHash`/`systemKey`/`systemInstallIds`） | `<tmp>/config.json` |
| `ADMIN_KEY` | `GET /api/client-logs` 的查看口令（空=关闭，403） | `test-admin-key` |
| `ADMIN_PW_HASH` | App 管理员模式口令的派生值（空=入口关闭，403） | `test-admin-pw` 的派生值 |
| `SYSTEM_KEY` | 系统版（内部构建）机器凭据（空=系统版功能关闭）；config.json 的 `systemKey` 优先 | `test-system-key-2b7f4c9d1e` |
| `TLS_PORT` / `TLS_CERT_FILE` / `TLS_KEY_FILE` | 自签 TLS 第二端口；证书缺失只跑 HTTP（见第三节末「TLS 契约」） | 契约模式启动时现签一张测试自签证书（临时目录，**不入库**），端口 = HTTP 端口 + 1000 |

## 二、数据库契约（本阶段：保持 SQLite）

- 库文件必须是 `$DATA_DIR/chat.db`，且**可被另一个进程同时读写**（契约夹具直连库做前置数据：
  写验证码、审核直通、插种子设备等）。WAL + busy 等待即可满足；写操作要能容忍另一进程短暂持锁。
- 统计按 `Asia/Shanghai` 分日（`device_days.day` 是 `YYYY-MM-DD` 字符串）。
- 夹具直读的表与列（即被断言的结构，改名前先改这条）：

| 表 | 被直读的列（用途） |
| --- | --- |
| `users` | `id`、`username`、`pass_hash`、`pass_salt`（后两者由 HTTP 流程间接断言） |
| `sessions` | 令牌行（登录态） |
| `verify_codes` | `email`/`code`/`type`/`expires_at`/`used`（夹具直插验证码绕开 SMTP） |
| `world_books` / `presets` / `plugins` | `status`（`pending`/`approved`/`rejected`，缺省 approved）、`id` |
| `card_likes` / `card_comments` | 社交计数 |
| `feedback` | `text`/`install_id`/`version`/`platform`/`created_at`/`read_at` |
| `feedback_meta` | `k`/`v`（`trimmed` 计数） |
| `review_log` | `target_type`/`target_id`/`action`/`admin` |
| `admin_traces` | `instruction`/`recall_json`（留档） |
| `client_logs` | `app_version`/`web`/`platform`/`ts` |
| `devices` | `install_id`/`first_ts`/`last_ts`/`first_day`/`last_day`/`app_version`/`web_version`/`platform` |
| `device_days` | `install_id`/`day`（主键去重） |
| `world_books` 检索 | `search_text`/`meta`/`cover`/`admin_only`（元数据后补写、检索命中） |

## 三、HTTP 接口契约

- `/api/health`、`/`：健康检查
- 认证：`POST /api/auth/register|login|login-code|send-code|logout|reset-password|rename|me`（`Authorization: Bearer <token>`）
- 社区：`/api/worldbook/*`、`/api/preset/*`、`/api/plugin/*` 的 `list|upload|detail|preview|download|delete|meta|search`
- 社交：`POST /api/card/like|comment`、`GET /api/card/comments`、`DELETE /api/card/comment`
- 审核/管理：`GET /api/admin/review`、`POST /api/admin/review/action`、`GET /api/my/submissions`（需 `X-Admin-Token`）
- 反馈：`POST /api/feedback`（公开+限流）、`/api/admin/feedback`、`/api/admin/feedback/read|delete`
- 留档：`POST /api/admin/trace`（Bearer 管理员令牌）、`GET|DELETE /api/admin/traces`（需 `x-admin-key`，支持 `format=html`）
- 管理员模式：`POST /api/admin/verify` → `200 {ok:true,token}`（令牌是无状态凭证，格式自定，只要本实现能校验）
- 分发：`GET /api/app/version`、`GET /apk/:file`、`GET /api/app/web-bundle`（`no-store`；`channel=beta` 见下「系统版契约」）、`GET /web-bundle/:file`（`Content-Type: application/zip`）
- 统计/上报：`POST /api/app/ping`、`GET /api/admin/stats`、`POST /api/client-logs`、`GET /api/client-logs`
- 代理：`POST /api/proxy/:name/*`（白名单外 404）、`OPTIONS` 预检 204

状态码用法（被断言）：`400` 参数/格式非法、`401` 未登录或令牌错、`403` 口令未配置或 adminKey 错、
`404` 不可见（待审稿/白名单外/不存在）、`429` 限流。

限流阈值（内存态，进程重启归零；**阈值本身属于契约**）：
登录 10 次/（IP+账号）；验证码猜测 10 次/邮箱；`send-code` 10 次/IP；
`POST /api/admin/verify` 8 次/分钟/IP；上传 30 次/小时/账号；读接口 120 次/分钟/账号；
代理 60 次/分钟/IP；反馈每设备 2 条/分钟（另有设备 20 条/24h、IP 20 条/1h、全站 200 条/1h 兜底）。

行为语义要点：反馈单条 300 字按**码点**计；同设备 10 分钟内完全相同内容去重（仍答收到）；
反馈保留 1000 条、超限优先删最旧**已读**；审核门（pending 不进公开列表/检索/详情/预览/下载、
不能点赞评论；作者在「我的投稿」可见；管理员直传即 approved）；封面 data URI 整串校验
（属性逃逸载荷 400、320KB 上限）；`/web-bundle` 非法文件名与路径穿越 400。

### TLS 契约（双端口并存）

Node 版同时监听 HTTP 与 HTTPS（自签证书，App v1.5.65+ 走 TLS 端口；`server/src/tls.js`）。
这一条也进了契约（`tests/tls.test.js`，契约模式专用——嵌入模式的进程内服务没有独立 TLS 监听）：

1. **证书可用 → 双端口并存**：同一个应用同时可从 `http://127.0.0.1:<PORT>` 与
   `https://127.0.0.1:<TLS_PORT>` 访问（请求走同一套路由、同一份会话）。
2. **协议感知**：HTTPS 请求下 `GET /api/app/version` 的 `apkUrl` 必须是 `https://…`，HTTP 下仍是 `http://…`
   （App 靠这个字段在 TLS 端口下载 APK；写错会让客户端下载失败）。
3. **最低 TLSv1.2**（对应 Node 的 `minVersion: 'TLSv1.2'`）：默认握手应协商到 TLSv1.2 或 TLSv1.3。
4. **证书不可读 → 只跑 HTTP，启动不许失败**。这一条由**其余所有文件**隐式覆盖：helpers 在正常运行里
   不给证书（嵌入模式指向不存在的路径），目标仍必须起得来；只有契约模式才喂测试自签证书。
5. 证书是 PEM（`TLS_CERT_FILE` 证书、`TLS_KEY_FILE` 私钥，私钥可能是 PKCS#8 `BEGIN PRIVATE KEY`
   或 PKCS#1 `BEGIN RSA PRIVATE KEY`——两种都要能读，线上证书是前者）。
   **测试证书不入库**：契约模式启动时由 helpers 用 `openssl req -x509` 现签一张自签证书放进临时目录
   （仓库里放 PEM 私钥会被 GitHub/Gitee 的密钥扫描 + push protection 拦下，而推送是非交互脚本）；
   本机没有 openssl 时这几个用例运行时跳过（跳过信息会写明原因），目标只跑 HTTP。
   PKCS#1 解析路径另用 `openssl genrsa -traditional` 现生成一对、以 `TLS_KEY_FILE=…` 覆盖跑一遍验证
   （Java 侧验过 4/4，见交接文档 §13.162 补记）。

### 系统版契约（机器凭据与内测渠道）

「系统版」是预配置管理员的内部构建（App 侧 Android flavor，见交接文档「系统版」）：不带口令，
用机器凭据 `X-System-Key` 直连管理接口。契约落在 `adminpass.test.js`、`web-bundle.test.js`、
`system-key.test.js`：

1. **凭据等价于管理员**：带对 `X-System-Key`（= 环境变量 `SYSTEM_KEY` / config.json `systemKey`）的请求，
   与带合法 `X-Admin-Token` 在全部管理接口上等价（`/api/admin/stats|review|review/action|feedback*|trace`
   + admin_only 世界书）；无凭据或坏凭据一律 `401`。比较必须常量时间。
2. **可选设备白名单**：config.json `systemInstallIds` 非空时，带凭据的请求还必须带白名单内的
   `X-Install-Id`（客户端随机 32 位 hex 安装标识，见 `app/src/domain/stats.ts`），否则 `401`；
   空/缺省 = 不启用（线上默认）。白名单只影响凭据路径，不带凭据的普通请求完全不受影响。
3. **内测渠道 `GET /api/app/web-bundle?channel=beta`**：只有「精确 `channel=beta` 且凭据命中」才读
   `manifest-beta.json`；其余（无凭据 / 坏凭据 / 未知渠道值）一律读正式 `manifest.json`。
   beta 缺失或结构不完整时**必须回落正式包**（系统版永远拿得到可用包）。
4. 凭据空值 = 系统版功能整体关闭（不认 key、不给 beta）；正式渠道与旧客户端行为完全不变。

## 四、排除清单（嵌入专用 3 例 + 2 个文件；契约专用 1 个文件）

| 排除项 | 原因 | 契约侧等价覆盖 |
| --- | --- | --- |
| `ratelimit.test.js` | 限流算法单元（滑动窗实现） | 各接口 429 用例 |
| `wbsearch.test.js` | 检索实现单元（打分/分词） | `worldbook/search`、元数据补写后可检索 |
| 「代理白名单内限流」（hardening-limits） | 靠进程内 `fetch` 打桩拦上游；契约模式下目标是独立进程，真发 61 次到 opencode.ai 不可接受 | 白名单外 404 仍跑；阈值争议时用嵌入模式验 |
| 「未配置口令 403」（adminpass） | 需要运行时改内存配置 | 该分支属部署态，人工验收 |
| 「hashPassword 对拍」（adminpass） | `src/adminpass` 内部函数 | 派生格式由 HTTP 用例 + `tools/scrypt-parity` 对拍保证 |

**契约专用**（嵌入模式自动 skip，见 `helpers.contractOnly`）：`tls.test.js` 的 4 例——
嵌入模式的进程内服务没有独立 TLS 监听；TLS 行为只能在「独立进程 + 真实端口」下验证。

## 五、换成 Java 时的顺序

1. 现在就在 Node 上跑 `npm run test:contract`，把 80/77/3skip 作为基线并留档。
2. Java 版先做到「环境变量 + health + SQLite 同库同表」——SQL 可逐条直译（方言不变是本阶段红利）。
3. `CONTRACT_CMD` 指向 Java 包跑同一套；失败项对照本文档逐条修，或用例里标注「实现差异」。
4. 必须在两侧都过的关键项：口令派生格式（`scrypt$16384$8$1$salt$hash`）、管理员令牌可校验、
   系统版机器凭据与内测渠道语义（`X-System-Key` / `X-Install-Id` / `channel=beta`，见「系统版契约」）、
   HTTP 状态码语义、限流阈值、审核门语义、封面/路径穿越校验、`Asia/Shanghai` 统计口径、
   **TLS 双端口与协议感知 apkUrl**（`tests/tls.test.js`）。
5. 将来真要换掉 SQLite 时：本文档第二节的直读夹具要改成走接口（`CONTRACT.md` 是那一步的清单）。

## 六、已知限制

- 未实现「挂到已在运行的实例上」模式（attach 到线上做冒烟）；需要时加 `CONTRACT_BASE_URL`。
- 契约模式的 `clearLimiters()` 是重启目标进程：实现若启动超过 `CONTRACT_BOOT_MS` 会失败（调大即可）。
- 用例进程需要 Node ≥ 22.5 才能读 SQLite 库（`run-contract.js` 已带 `--experimental-sqlite`；
  Node 22.x 必须带，Node 24 可省）。
- 端口按用例文件固定分配（`helpers.js` 的 `FILE_PORTS`，15100–15114）。早先用「pid 取模」，
  并行跑文件时出现过两个 pid 刚好差 1000 → 撞端口（`EADDRINUSE`）的偶发失败，故改掉。
  同一个用例文件被两套运行同时跑（或上次残留进程没退）会报明确的端口占用提示，照提示清理即可。
- 契约模式下，若端口已被**别的残留进程**占着，目标进程会因 EADDRINUSE 直接退出并报错，
  不会出现「对着旧服务跑测试」的假绿。

## 七、自检与负例验证（2026-10-10，Node 基线）

| 验证 | 做法 | 结果 |
| --- | --- | --- |
| 不偷看实现 | `helpers.stop()` 自检 `require.cache` 里不得出现 `server/src/**` | 12 个文件全绿（自检通过） |
| 目标起不来 | `CONTRACT_CMD="node -e process.exit(3)"` | 报 `目标进程提前退出 {"code":3}` + 命令 + 目标输出，退出码 1 |
| 行为偏差能被抓 | 复制一份 `src/`，把登录限流 `max: 10` 改成 `max: 3`，只跑「登录爆破」用例 | 断言失败：`第 4 次应仍为 401`（429 ≠ 401），定位准确 |
| 稳定性 | 嵌入模式连跑 3 次 | 100/100、100/100、100/100 |
| 基线（2026-10-10 晚，加入系统版凭据与内测渠道后） | `npm test` / `npm run test:contract` | 嵌入 110 例（106+4skip）；契约 90 例：87 通过、3 跳过、0 失败；**Node 目标与 Java 目标结果逐例一致**（Java 侧含白名单重启用例） |

