#!/usr/bin/env bash
# 灰度演练：在服务器上准备一个「候选实现」（Java）实例，**完全不动线上服务**。
#
# 做的事：① 用 VACUUM INTO 从线上库拉一份**一致性快照**（不打断线上读写）；
#         ② 拷贝上传文件与配置（分发目录 apk/web-bundles/certs 只读软链，绝不复制 2G 的 APK）；
#         ③ 生成并启动一个 systemd 单元（**只 start 不 enable**：机器重启后回到只跑线上）；
#         ④ 等健康检查通过并打印后续冒烟命令。
#
# 用法（root，在服务器上跑）：
#   bash canary-setup.sh [--http-port 18899] [--tls-port 18443] [--jar /server-java/bqbhub-server-java.jar]
# 前置：目标机要有 java（OpenCloudOS 9：dnf install -y java-17-openjdk-headless）
# 每次运行都会**重做快照**（冒烟脚本的对比项只对刚快照的库成立）。
set -euo pipefail

HTTP_PORT=18899
TLS_PORT=18443
JAR=/server-java/bqbhub-server-java.jar
CANARY=/server-java/canary
LIVE_ROOT=/server
UNIT=/etc/systemd/system/bqbhub-java-canary.service
SERVICE=bqbhub-java-canary

while [ $# -gt 0 ]; do
  case "$1" in
    --http-port) HTTP_PORT="$2"; shift 2 ;;
    --tls-port) TLS_PORT="$2"; shift 2 ;;
    --jar) JAR="$2"; shift 2 ;;
    --canary) CANARY="$2"; shift 2 ;;
    --live-root) LIVE_ROOT="$2"; shift 2 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done

NODE_BIN=$(command -v node || true)
JAVA_BIN=$(command -v java || true)
[ -n "$NODE_BIN" ] || { echo "找不到 node（快照要用它做 VACUUM INTO）"; exit 2; }
[ -n "$JAVA_BIN" ] || { echo "找不到 java：先 dnf install -y java-17-openjdk-headless"; exit 2; }
[ -f "$JAR" ] || { echo "找不到 jar：$JAR（先 pscp 上传）"; exit 2; }
[ -d "$LIVE_ROOT/data" ] || { echo "找不到线上数据目录：$LIVE_ROOT/data"; exit 2; }

echo "== 0) 现状检查（只读）=="
systemctl is-active novel-community || true
curl -fsS "http://127.0.0.1:8899/api/health" >/dev/null && echo "线上 HTTP 8899 健康 ✓" || echo "⚠ 线上 8899 不健康，先别继续"
# 重跑时先停掉**本 canary**（要重做快照），再检查端口是否被别的进程占着
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  echo "停掉上一轮的 $SERVICE（准备重做快照）"
  systemctl stop "$SERVICE"
  for i in 1 2 3 4 5; do ss -ltn | grep -qE ":$HTTP_PORT\b" || break; sleep 1; done
fi
if ss -ltn | grep -qE ":$HTTP_PORT\b"; then
  echo "⚠ 端口 $HTTP_PORT 被别的进程占用，换端口再跑："; ss -ltnp | grep -E ":$HTTP_PORT\b" || true; exit 1
fi
if ss -ltn | grep -qE ":$TLS_PORT\b"; then
  echo "⚠ 端口 $TLS_PORT 被别的进程占用，换端口再跑："; ss -ltnp | grep -E ":$TLS_PORT\b" || true; exit 1
fi

echo "== 1) 目录 =="
mkdir -p "$CANARY/data" "$CANARY/uploads"

echo "== 2) 一致性快照（VACUUM INTO，不打断线上）=="
rm -f "$CANARY/data/chat.db" "$CANARY/data/chat.db-wal" "$CANARY/data/chat.db-shm"
"$NODE_BIN" --experimental-sqlite -e "
const { DatabaseSync } = require('node:sqlite');
new DatabaseSync('$LIVE_ROOT/data/chat.db').exec(\"VACUUM INTO '$CANARY/data/chat.db'\");
" 2>/dev/null
ls -la "$CANARY/data/chat.db"

echo "== 3) 上传文件 + 配置（拷贝）；分发目录（只读软链）=="
rm -rf "$CANARY/uploads"; mkdir -p "$CANARY/uploads"
cp -a "$LIVE_ROOT/uploads/." "$CANARY/uploads/" 2>/dev/null || true
cp -a "$LIVE_ROOT/config.json" "$CANARY/config.json"
cp -a "$LIVE_ROOT/app-version.json" "$CANARY/app-version.json"
ln -sfn "$LIVE_ROOT/apk" "$CANARY/apk"
ln -sfn "$LIVE_ROOT/web-bundles" "$CANARY/web-bundles"
ln -sfn "$LIVE_ROOT/certs" "$CANARY/certs"
du -sh "$CANARY" 2>/dev/null || true

echo "== 4) systemd 单元（只 start，不 enable）=="
cat > "$UNIT" <<EOF
[Unit]
Description=BQB Hub Java canary (灰度演练；故意不 enable，重启后回到只跑线上)
After=network.target

[Service]
WorkingDirectory=$CANARY
Environment=PORT=$HTTP_PORT
Environment=TLS_PORT=$TLS_PORT
Environment=DATA_DIR=$CANARY/data
Environment=UPLOAD_DIR=$CANARY/uploads
Environment=APK_DIR=$CANARY/apk
Environment=APP_VERSION_FILE=$CANARY/app-version.json
Environment=WEB_BUNDLE_DIR=$CANARY/web-bundles
Environment=CONFIG_FILE=$CANARY/config.json
Environment=TLS_CERT_FILE=$CANARY/certs/server.crt
Environment=TLS_KEY_FILE=$CANARY/certs/server.key
ExecStart=$JAVA_BIN -Xmx384m -XX:MaxMetaspaceSize=128m -Xss512k -jar $JAR
Restart=always
RestartSec=3
MemoryMax=900M

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl restart "$SERVICE"

echo "== 5) 等就绪 =="
ok=0
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$HTTP_PORT/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != 1 ]; then
  echo "候选实例没起来 —— 看日志：journalctl -u $SERVICE -n 60 --no-pager"
  exit 1
fi
echo -n "候选实例就绪："
curl -s "http://127.0.0.1:$HTTP_PORT/api/health"; echo
echo -n "TLS 端口："
curl -sk "https://127.0.0.1:$TLS_PORT/api/health"; echo
echo "线上仍在跑（复核）：$(systemctl is-active novel-community)  $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/api/health)"

JARDIR=$(dirname "$JAR")

cat <<EOF

下一步（在服务器上照抄即可）：
  1) 生成「线上规格」的留档令牌（用线上代码的算法 + 线上 config.json 里的派生值；不打印口令/令牌）
     TOKEN=\$(node --experimental-sqlite -e "const c=require('crypto'),fs=require('fs');const s=JSON.parse(fs.readFileSync('$LIVE_ROOT/config.json','utf8')).adminPasswordHash;const e=Date.now()+12*3600*1000;console.log(e+'.'+c.createHmac('sha256',s).update('admin-trace:'+e).digest('base64url'))")
  2) 冒烟对比（在线上的同一台机器上跑，两个实例都在 127.0.0.1）
     node --experimental-sqlite $JARDIR/tools/smoke.mjs \\
       --base http://127.0.0.1:$HTTP_PORT --tls-base https://127.0.0.1:$TLS_PORT \\
       --live http://127.0.0.1:8899 --live-tls https://127.0.0.1:80 \\
       --admin-token "\$TOKEN" --db $CANARY/data/chat.db --seed-login
  3) 看候选实例日志（排障用）
     journalctl -u $SERVICE -n 80 --no-pager

回滚/清理（演练完或不想留）：
  systemctl stop $SERVICE; rm -f $UNIT; systemctl daemon-reload; rm -rf $CANARY
EOF
