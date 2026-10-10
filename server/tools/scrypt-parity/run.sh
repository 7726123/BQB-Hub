#!/usr/bin/env bash
# scrypt 跨语言对拍 · 一键运行（Git Bash / Linux / macOS）
# 正向：Node 生成夹具 → Java 逐字节复算；反向：Java 现场生成 → Node 校验。
set -euo pipefail
cd "$(dirname "$0")"

echo "== scrypt 跨语言对拍 =="
command -v node >/dev/null || { echo "缺少 node"; exit 1; }
command -v javac >/dev/null || { echo "缺少 JDK（javac）。装 JDK 17+ 后重试。"; exit 1; }

# Bouncy Castle jar：优先 BCPROV_JAR，其次 Gradle / Maven 缓存里的**原始** jar。
# 注意：不要用 ~/.gradle/caches/jars-9/ 下的副本——那是 Gradle 改写过的插桩 jar，
# 直接当 classpath 用会报 NoClassDefFoundError: org/gradle/internal/classpath/Instrumented。
BC_JAR="${BCPROV_JAR:-}"
if [ -z "$BC_JAR" ]; then
  BC_JAR=$(find "$HOME/.gradle/caches/modules-2" "$HOME/.m2/repository" -name 'bcprov*.jar' 2>/dev/null | head -1 || true)
fi
if [ -z "$BC_JAR" ] || [ ! -f "$BC_JAR" ]; then
  cat <<'EOF'
没找到 Bouncy Castle（bcprov）jar。三种办法任选：
  1) 本机跑过 Android/Gradle 工程：把 BCPROV_JAR 指向 ~/.gradle/caches 下的 bcprov*.jar
  2) 从 Maven 中央仓库下载：
       curl -L -o bcprov.jar https://repo1.maven.org/maven2/org/bouncycastle/bcprov-jdk18on/1.78.1/bcprov-jdk18on-1.78.1.jar
       BCPROV_JAR=./bcprov.jar ./run.sh
  3) 将来的 Java 工程本来就要加依赖 org.bouncycastle:bcprov-jdk18on（版本随意，SCrypt 算法不随版本变）
EOF
  exit 2
fi
echo "BC jar：$BC_JAR"

# 1) Node 生成夹具（含默认参数自检）
node gen-fixtures.mjs

# 2) 编译并运行 Java 侧
# 临时目录与 jar 路径都转成 Windows 路径：Git Bash 的 java/javac 是原生程序，
# 只认 Windows 路径，且 MSYS 会改写含 ';' 的参数（classpath）——用 cygpath 明确转换最稳。
OUT="$(mktemp -d)"
W() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi; }
if command -v cygpath >/dev/null 2>&1; then SEP=';'; else SEP=':'; fi
BC_W="$(W "$BC_JAR")"
OUT_W="$(W "$OUT")"

# -encoding UTF-8 必须带：Windows 上 javac 默认用平台编码（GBK），源码里的中文注释会编译失败
# -Dfile.encoding/stdout.encoding：让 JVM 往管道输出 UTF-8（Git Bash / Linux 终端都是 UTF-8；run.cmd 里不强制，配合 cmd 的 GBK 控制台）
javac -J-Dfile.encoding=UTF-8 -encoding UTF-8 -cp "$BC_W" -d "$OUT_W" ScryptParity.java
java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8 -cp "$OUT_W$SEP$BC_W" ScryptParity .

# 3) 反向：Node 校验 Java 生成的结果
node gen-fixtures.mjs --verify-java java-generated.tsv
echo
echo "全部通过：两条口令路径在 Node 与 Java 之间逐字节一致（正向 + 反向）。"
