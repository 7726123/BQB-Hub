# scrypt 跨语言对拍（Node ⇄ Java）

**为什么有这套东西**：服务端从 Node 换到 Java 时，唯一「错了就全量用户受影响」的点是口令派生。
只要有一处字节不同，所有老用户都登不进来（`users.pass_hash`/`pass_salt` 对不上）、
线上 `config.json` 里的管理员口令也会失效。这个目录用夹具把这件事**先证明掉**，再动手写 Java。

它证明两件事：

1. **正向**：Node 用现有实现算出的 9 条夹具（7 登录 + 2 管理员），Java 逐字节复算一致
   → 老用户原密码能登、线上管理员口令认得。
2. **反向**：Java 现场生成的哈希，Node 版也能认
   → 灰度/双跑期间两边可以互相认口令。

## 一跑就见结果

```bash
# Git Bash / Linux / macOS
cd server/tools/scrypt-parity
bash run.sh

# Windows cmd（或双击）
run.cmd
```

需要：Node、JDK 17+、Bouncy Castle 的 `bcprov*.jar`（脚本会自动去 Gradle / Maven 缓存里找；
也可 `BCPROV_JAR=/path/to/bcprov.jar` 指定，或用 `curl` 从 Maven 中央仓库下一个）。

> 两个已经踩过的坑，脚本里都处理了：
> 1. **不要用 `~/.gradle/caches/jars-9/` 下的 bcprov 副本**——那是 Gradle 改写过的插桩 jar，
>    当 classpath 用会报 `NoClassDefFoundError: org/gradle/internal/classpath/Instrumented`。
>    脚本只在 `modules-2`/`~/.m2` 里找原始 jar。
> 2. **Windows 上 javac 默认用 GBK**，源码里的中文注释会编译失败 → 必须
>    `javac -encoding UTF-8`。

## 两条口令路径的规格（改它们 = 让老用户登不进来）

### A. 登录口令（`server/src/auth.js`）

```js
salt = crypto.randomBytes(16).toString('hex')                       // 32 个 ASCII 字符
hash = crypto.scryptSync(pw_utf8, salt_string_utf8, 64)             // N=16384, r=8, p=1
// 库里：users.pass_salt = salt_string, users.pass_hash = hash.toString('hex')
```

**关键坑**：盐是「16 随机字节的 hex 字符串」，要用**这个字符串的 UTF-8 字节**参与 scrypt，
**不是**把字符串 hex 解码成 16 字节。解码了不会报错，只会算出永远对不上的哈希。

Java 侧（Bouncy Castle）：

```java
byte[] salt = saltString.getBytes(StandardCharsets.UTF_8);   // ← 不是 hexToBytes(saltString)
byte[] hash = SCrypt.generate(pw.getBytes(StandardCharsets.UTF_8), salt, 16384, 8, 1, 64);
String stored = hex(hash);
```

### B. 管理员口令（`server/src/adminpass.js`，也是线上 `config.json` 的 `adminPasswordHash`）

```
stored = "scrypt$16384$8$1$<saltBase64>$<hashBase64>"
salt   = 16 随机字节（真字节，base64 存）；派生长度 32 字节
```

这一段是**已有实现自定义的格式**，不是 `spring-security-crypto` 的
`SCryptPasswordEncoder`（后者输出 `$scrypt$N=..,r=..,p=..$...`，且编码方式不同）。
Java 侧要读现有的 `config.json`，就必须自己按上面格式解析 + 用原始 `SCrypt.generate` 复算，
不要直接套 `SCryptPasswordEncoder`。

## 本机实测记录（2026-10-10）

| 项 | 值 |
| --- | --- |
| Node | v24.14.1（`scryptSync(pw,salt,64)` 与显式 `{N:16384,r:8,p:1}` 输出一致，脚本自检 ✔） |
| JDK | 17.0.12 |
| Bouncy Castle | `bcprov-jdk15on-1.67`（Gradle 缓存原始 jar）与 `bcprov-jdk18on-1.78.1`（Maven 中央仓库），两者结果相同 |
| 正向 | 9/9 PASS（英文/中文/emoji/64 长/首尾空格/非 hex 盐/空口令 + 2 条管理员） |
| 反向 | 2/2 PASS（Java 生成的登录哈希与管理员派生值，Node 全部能认） |
| 负例 | 把盐误当 hex 解码 → 全部 FAIL（`实得` 与 `期望` 完全不同）；非 hex 盐向量直接 `NumberFormatException` 退出码 1 |
| Node 版本无关 | 服务器上 Node v22.12.0 重跑夹具生成：`fixtures.tsv` md5 与本地 Node v24.14.1 完全一致（上传到 `/tmp` 跑完即清理） |

夹具（`fixtures.tsv` / `admin-fixtures.tsv`）随脚本一起提交，可复现：向量里的盐是固定的。
`java-generated.tsv` 是**运行产物**（Java 每次跑都会重写，用于反向校验），可删可重生成。

## 落地到 Java 工程时

- 依赖：`org.bouncycastle:bcprov-jdk18on`（版本随意，SCrypt 算法不随版本变；本机用 1.67 与 1.78.1 验过）。
- 校验时用常量时间比较（`MessageDigest.isEqual`），与 Node 的 `crypto.timingSafeEqual` 对齐。
- 不要把 `users.pass_salt` 改成解码后的字节——**库里的列保持原样**，Java 读进来当日志/字符串用。
- 想换更强的算法（bcrypt/argon2）也行，但要**先写兼容校验**：老哈希按老规则认，认过了再升级重存。
  这个目录里的正反向对拍就是把「老哈希能认」这件事钉住的手段。
- 管理员口令的生成命令（新口令上墙时用）：Java 侧复刻 `adminpass.hashPassword` 的格式，
  或先用 Node 侧 `node -e "console.log(require('./src/adminpass').hashPassword(process.env.PW))"` 生成。
