#!/usr/bin/env bash
# 切换：把线上服务从 Node 版（novel-community）换成 Java 版（bqbhub-java）。
#
# 前置：候选实例已按 §13.163 演练通过（真实数据冒烟全绿）。
# 本脚本顺序：停候选 → 停 Node 并摘掉它的开机自启（单元文件保留，回滚用）→
#             安装并启用 Java 单元 → 双端口健康检查 → **失败则自动回滚到 Node**。
# 用法（root）：bash flip-to-java.sh [--no-rollback]
set -euo pipefail

UNIT=/etc/systemd/system/bqbhub-java.service
UNIT_SRC=/server-java/deploy/bqbhub-java.service
AUTO_ROLLBACK=1
[ "${1:-}" = "--no-rollback" ] && AUTO_ROLLBACK=0

echo "== 切换前状态 =="
printf 'novel-community: %s\n' "$(systemctl is-active novel-community || true)"
printf 'canary:          %s\n' "$(systemctl is-active bqbhub-java-canary 2>/dev/null || true)"
curl -fsS http://127.0.0.1:8899/api/health >/dev/null && echo "线上 HTTP 8899 健康 ✓" || { echo "⚠ 线上不健康，终止切换"; exit 1; }

echo "== 1) 停候选实例（切换后 Java 用线上库，绝不能两个进程同时写）=="
systemctl stop bqbhub-java-canary 2>/dev/null || true

echo "== 2) 停 Node 版并摘掉它的开机自启（单元文件保留，便于回滚）=="
systemctl stop novel-community
systemctl disable novel-community 2>&1 | tail -1 || true

echo "== 3) 安装并启用 Java 版 =="
[ -f "$UNIT_SRC" ] || { echo "缺 $UNIT_SRC"; exit 2; }
cp "$UNIT_SRC" "$UNIT"
systemctl daemon-reload
systemctl enable --now bqbhub-java 2>&1 | tail -1 || true

echo "== 4) 等就绪 + 双端口验证 =="
ok=0
for i in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8899/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 0.5
done
if [ "$ok" != 1 ]; then
  echo "⚠ Java 版没起来，日志尾部："
  journalctl -u bqbhub-java -n 60 --no-pager | tail -40 || true
  if [ "$AUTO_ROLLBACK" = 1 ]; then
    echo "== 自动回滚到 Node 版 =="
    systemctl disable --now bqbhub-java 2>/dev/null || true
    systemctl enable --now novel-community
    sleep 2
    curl -fsS http://127.0.0.1:8899/api/health >/dev/null && echo "已回滚，线上恢复（Node）✓" || echo "⚠ 回滚后仍不健康，人工介入！"
  fi
  exit 1
fi
echo -n 'HTTP 8899: '; curl -s http://127.0.0.1:8899/api/health; echo
echo -n 'TLS 80:    '; curl -sk https://127.0.0.1:80/api/health; echo
echo -n 'version:   '; curl -s http://127.0.0.1:8899/api/app/version; echo
echo -n 'web-bundle:'; curl -s http://127.0.0.1:8899/api/app/web-bundle | head -c 120; echo

echo "== 状态 =="
printf 'bqbhub-java:     active=%s enabled=%s\n' "$(systemctl is-active bqbhub-java)" "$(systemctl is-enabled bqbhub-java)"
printf 'novel-community: active=%s enabled=%s（单元文件保留，回滚用）\n' "$(systemctl is-active novel-community || true)" "$(systemctl is-enabled novel-community 2>/dev/null || echo disabled)"
echo
echo "回滚（任何时候）：systemctl disable --now bqbhub-java && systemctl enable --now novel-community"
