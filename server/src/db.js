// 数据层：SQLite（node:sqlite，WAL）+ 结构迁移 + 种子数据
// 老库迁移的策略：PRAGMA table_info 探测缺列 → ALTER TABLE 补齐，幂等可重放
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

fs.mkdirSync(config.DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(config.DATA_DIR, 'chat.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    pass_hash TEXT NOT NULL,
    pass_salt TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS world_books (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '综合',
    tags TEXT NOT NULL DEFAULT '',
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS presets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '综合',
    tags TEXT NOT NULL DEFAULT '',
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS plugins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plugin_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    plugin_type TEXT NOT NULL DEFAULT '',
    plugin_version TEXT NOT NULL DEFAULT '1.0.0',
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    filename TEXT NOT NULL,
    is_zip INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS verify_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    used INTEGER NOT NULL DEFAULT 0
  );
  -- 社区卡片社交：点赞（一人一赞，主键天然幂等）+ 评论（软删除保留审计）
  -- target_type ∈ worldbook / preset（以后加插件市场只是多一个取值）
  CREATE TABLE IF NOT EXISTS card_likes (
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (target_type, target_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS card_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    deleted_by INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_card_likes_recent ON card_likes(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_card_comments_recent ON card_comments(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_card_comments_target ON card_comments(target_type, target_id, id DESC);
  CREATE TABLE IF NOT EXISTS admin_traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    book TEXT NOT NULL DEFAULT '',
    round INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL DEFAULT '',
    window_chars INTEGER NOT NULL DEFAULT 0,
    budget INTEGER NOT NULL DEFAULT 0,
    instruction TEXT NOT NULL DEFAULT '',
    continuation TEXT NOT NULL DEFAULT '',
    recall_json TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS client_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    app_version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    msg TEXT NOT NULL,
    ua TEXT NOT NULL DEFAULT ''
  );
  -- 匿名使用统计（设备维度计数，见 routes/system.js 的 /api/app/ping）
  -- 只存随机安装标识与版本号：不含任何内容、设备信息、位置；原始 IP 不入库（限流只在内存里用）。
  CREATE TABLE IF NOT EXISTS devices (
    install_id TEXT PRIMARY KEY,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    first_day TEXT NOT NULL DEFAULT '',
    last_day TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    web_version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT ''
  );
  -- 每设备每天一行（去重靠主键）：日活 = 某天计数；近 7/30 天 = 按日期范围 distinct
  CREATE TABLE IF NOT EXISTS device_days (
    install_id TEXT NOT NULL,
    day TEXT NOT NULL,
    PRIMARY KEY (install_id, day)
  );
`);

// 迁移封装：缺列则补列（幂等）
function addColIfMissing(table, col, ddl) {
  try {
    const cols = db.prepare('PRAGMA table_info(' + table + ')').all();
    if (!cols.some((c) => c.name === col)) db.exec(ddl);
  } catch (e) { console.warn('迁移 ' + table + '.' + col + ' 失败:', e.message); }
}
addColIfMissing('users', 'email', 'ALTER TABLE users ADD COLUMN email TEXT');
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)'); } catch (e) { console.warn('索引失败:', e.message); }
addColIfMissing('world_books', 'cover', 'ALTER TABLE world_books ADD COLUMN cover TEXT');
addColIfMissing('presets', 'cover', 'ALTER TABLE presets ADD COLUMN cover TEXT');
// 世界书检索字段（2026-09）：meta = 结构化元数据 JSON（题材/面向/关系/原作名/角色名/条目名/字数…），
// search_text = 参与 FTS5 检索的拼装文本，admin_only = 仅管理员可见（测试数据集用）
addColIfMissing('world_books', 'meta', "ALTER TABLE world_books ADD COLUMN meta TEXT NOT NULL DEFAULT ''");
addColIfMissing('world_books', 'search_text', "ALTER TABLE world_books ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
addColIfMissing('world_books', 'admin_only', 'ALTER TABLE world_books ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0');
// 社交计数缓存列（热门排序用 likes + 3×commenters；列表每行都要显示，不能每行 COUNT 子查询）：
// commenters = 非删除评论的去重人数（同一用户多条评论只算一次），评论增删时同步维护
for (const t of ['world_books', 'presets']) {
  addColIfMissing(t, 'likes', 'ALTER TABLE ' + t + " ADD COLUMN likes INTEGER NOT NULL DEFAULT 0");
  addColIfMissing(t, 'comments', 'ALTER TABLE ' + t + " ADD COLUMN comments INTEGER NOT NULL DEFAULT 0");
  addColIfMissing(t, 'commenters', 'ALTER TABLE ' + t + " ADD COLUMN commenters INTEGER NOT NULL DEFAULT 0");
}
// 审核门（2026-09）：新上传写 'pending'，管理员审核通过后才进入公开列表；status 的默认值
// 'approved' 让存量内容保持可见（不回填、不动线上）。reviewed_at = 最近一次审核动作时间。
for (const t of ['world_books', 'presets', 'plugins']) {
  addColIfMissing(t, 'status', 'ALTER TABLE ' + t + " ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
  addColIfMissing(t, 'reviewed_at', 'ALTER TABLE ' + t + ' ADD COLUMN reviewed_at INTEGER NOT NULL DEFAULT 0');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_' + t + '_status ON ' + t + '(status)'); } catch (e) { console.warn('索引失败:', e.message); }
}
// 审核动作留痕：通过 / 驳回 / 删除各记一条（管理员处置过的证据，不与内容本体混在一起）
db.exec(`CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  target_type TEXT NOT NULL,
  target_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  admin TEXT NOT NULL DEFAULT ''
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_review_log_ts ON review_log(ts DESC)'); } catch (e) { console.warn('索引失败:', e.message); }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_world_books_admin_only ON world_books(admin_only)'); } catch (e) { console.warn('索引失败:', e.message); }
// FTS5 检索索引（trigram 分词：中文 ≥3 字短语精确子串匹配；2 字词与「无 FTS5 的运行时」走 LIKE 兜底，
// 见 wbsearch.js）。注意：Node 22.12 的 node:sqlite 未编译 FTS5（实测 no such module: fts5），
// 因此这里失败必须优雅降级而不是让进程起不来。
db.hasFts5 = false;
try {
  db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS wb_fts USING fts5(search_text, title, description, tokenize='trigram')");
  db.hasFts5 = true;
} catch (e) {
  console.warn('FTS5 不可用（检索自动降级为多路 LIKE）:', e.message);
}
// 网页包热更新：上报里带上正在运行的网页包版本。排查时必须能区分「装了哪个 APK」与
// 「跑的哪个网页包」——同一个 APK 可能因热更在跑不同代码（见交接文档「热更新」章节）。
addColIfMissing('client_logs', 'web', "ALTER TABLE client_logs ADD COLUMN web TEXT NOT NULL DEFAULT ''");
try { db.exec('CREATE INDEX IF NOT EXISTS idx_client_logs_ts ON client_logs(ts DESC)'); } catch (e) { console.warn('索引失败:', e.message); }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_device_days_day ON device_days(day)'); } catch (e) { console.warn('索引失败:', e.message); }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_admin_traces_ts ON admin_traces(ts DESC)'); } catch (e) { console.warn('索引失败:', e.message); }

// 聊天系统下线（2026-09）：messages / channels 两表连同数据整体移除，社区只保留世界书与预设。
// 幂等：表已删时 DROP IF EXISTS 直接跳过；老库首次启动即完成数据清理。
try {
  db.exec('DROP TABLE IF EXISTS messages');
  db.exec('DROP TABLE IF EXISTS channels');
} catch (e) { console.warn('移除聊天表失败:', e.message); }

// 意见反馈：用户单向给管理员提意见（匿名，带随机安装标识/版本/平台；**原始 IP 只在内存限流里用，不入库**）。
// 保留上限 1000 条（见 routes/feedback.js 的 trim）：超限时**优先清理最旧的「已查看」**，
// 仍未达标才动未查看——未读是管理员还没处理的工作，不该被新反馈挤掉。
db.exec(`CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL,
  install_id TEXT NOT NULL DEFAULT '',
  version TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER
)`);
try { db.exec('CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC)'); } catch (e) { console.warn('索引失败:', e.message); }
// 累计被裁掉的条数（管理页显示「已清理 N 条」，让"反馈会消失"这件事对管理员可见）
db.exec('CREATE TABLE IF NOT EXISTS feedback_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)');

fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

module.exports = db;