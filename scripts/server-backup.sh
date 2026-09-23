#!/usr/bin/env bash
# BQB Hub 社区服务每日备份：SQLite(WAL checkpoint) + 上传文件 + 版本配置
# 保留最近 7 份；由 cron 每天 3:30 调用
TS=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR=/server/backups
mkdir -p "$BACKUP_DIR"
cd /server || exit 1

# 先做 WAL checkpoint，保证备份文件一致（服务运行中也可执行）
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/server/data/chat.db');try{db.prepare('PRAGMA wal_checkpoint(FULL)').get()}catch(e){console.warn('checkpoint:',e.message)}db.close()" 2>/dev/null || true

tar czf "$BACKUP_DIR/novel-backup-$TS.tar.gz" -C /server data uploads app-version.json 2>/dev/null
# 保留最近 7 份
ls -1t "$BACKUP_DIR"/novel-backup-*.tar.gz 2>/dev/null | tail -n +8 | xargs -r rm -f
echo "[$(date '+%F %T')] backup ok: $BACKUP_DIR/novel-backup-$TS.tar.gz ($(stat -c %s "$BACKUP_DIR/novel-backup-$TS.tar.gz" 2>/dev/null || echo 0) bytes, $(ls -1 "$BACKUP_DIR" | wc -l) kept)"
