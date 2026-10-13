package bqbhub.server;

import org.springframework.jdbc.core.JdbcTemplate;

import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 结构迁移：建表 + 老库就地升级 + 版本标记（原 Db.migrate 整段搬来这里，行为不变）。
 *
 * 版本口径（见 docs/adr/ADR-0006-migration-versioning.md）：
 *   `PRAGMA user_version` 是唯一标记，**Java 独占维护**（Node 版不读也不写）。
 *   0 = 从未迁移过（Node 建的库、老库都算）→ 跑基线段（全部幂等步骤，与 server/src/db.js 一一对应）→ 置 {@link #BASELINE}；
 *   之后的新改动按 {@link #NUMBERED} 编号追加，`if (v < version)` 逐级补齐，缺哪级补哪级。
 *
 * 铁律（ADR-0004 冻结点之后的约定，违反会砸掉回滚能力）：
 *   ① 纯增量 + 带默认值 / 不改名不删列——Node 回滚窗口内旧代码仍要能读写；
 *   ② 每条迁移必须幂等（可重复启动、可对旧库就地升级是契约要求）；
 *   ③ 不建 FTS5 索引（Node 运行时没有 FTS5，两边检索结果必须一致）。
 */
public final class SchemaMigrations {

    /** 基线版本：等于「本类写成时的全部幂等步骤」（原 Db.migrate 的整段）。 */
    public static final int BASELINE = 1;

    /** 编号迁移（基线之后的新改动按版本号追加；目前为空）。 */
    static final List<Migration> NUMBERED = List.of();

    /** 一条编号迁移：把库从 (version-1) 升到 version 要做的事（必须幂等）。 */
    interface Step {
        void apply(JdbcTemplate jdbc);
    }

    record Migration(int version, String note, Step step) {
    }

    private final JdbcTemplate jdbc;
    private final List<Migration> numbered;

    public SchemaMigrations(JdbcTemplate jdbc) {
        this(jdbc, NUMBERED);
    }

    /** 测试用：注入编号迁移以验证「缺哪级补哪级」的机制。 */
    SchemaMigrations(JdbcTemplate jdbc, List<Migration> numbered) {
        this.jdbc = jdbc;
        this.numbered = numbered;
    }

    /** 幂等：可重复调用（每次启动都会调一次）。 */
    public void run() {
        int v = userVersion();
        if (v == 0) {
            legacy();
            v = BASELINE;
            setUserVersion(v);
            System.out.println("[db] 结构迁移：基线段完成（user_version=" + v + "）");
        } else if (v > BASELINE + numbered.size()) {
            // 库比代码新（例如刚从新版回滚旧版代码）：不动它，只提示——此时任何写入都可能撞上新列约束
            System.out.println("[db] ⚠ 库结构版本 v" + v + " 高于本代码认识的版本，跳过迁移（回滚到了旧版本？）");
        }
        for (Migration m : numbered) {
            if (v < m.version()) {
                m.step().apply(jdbc);
                setUserVersion(m.version());
                v = m.version();
                System.out.println("[db] 结构迁移 → v" + m.version() + "：" + m.note());
            }
        }
    }

    /** 库里的结构版本（0 = 从未迁移过；Node 建的库也是 0）。 */
    int userVersion() {
        try {
            Map<String, Object> row = jdbc.queryForMap("PRAGMA user_version");
            for (Object v : row.values()) {
                if (v instanceof Number n) return n.intValue();
            }
        } catch (Exception e) {
            warn("读取 user_version 失败", e);
        }
        return 0;
    }

    void setUserVersion(int v) {
        jdbc.execute("PRAGMA user_version = " + v);
    }

    // ---------------------------------------------------------------- 基线段（= 原 Db.migrate，逐条搬移）

    private void legacy() {
        // ⚠ 必须逐条执行：xerial 的 Statement.execute 遇到「返回结果集的语句」会停在那里，
        // 一个字符串里塞多条 DDL 会静默丢掉后面的（第一版就踩了：整批建表没跑）。
        for (String stmt : SCHEMA_SQL.split(";")) {
            String s = stmt.trim();
            if (!s.isEmpty()) jdbc.execute(s);
        }

        // 老库就地升级：缺列则补列（幂等，可重复启动）——与 db.js 的 addColIfMissing 一一对应
        addColIfMissing("users", "email", "ALTER TABLE users ADD COLUMN email TEXT");
        try { jdbc.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"); } catch (Exception e) { warn("索引失败", e); }
        addColIfMissing("world_books", "cover", "ALTER TABLE world_books ADD COLUMN cover TEXT");
        addColIfMissing("presets", "cover", "ALTER TABLE presets ADD COLUMN cover TEXT");
        addColIfMissing("world_books", "meta", "ALTER TABLE world_books ADD COLUMN meta TEXT NOT NULL DEFAULT ''");
        addColIfMissing("world_books", "search_text", "ALTER TABLE world_books ADD COLUMN search_text TEXT NOT NULL DEFAULT ''");
        addColIfMissing("world_books", "admin_only", "ALTER TABLE world_books ADD COLUMN admin_only INTEGER NOT NULL DEFAULT 0");
        for (String t : new String[]{"world_books", "presets"}) {
            addColIfMissing(t, "likes", "ALTER TABLE " + t + " ADD COLUMN likes INTEGER NOT NULL DEFAULT 0");
            addColIfMissing(t, "comments", "ALTER TABLE " + t + " ADD COLUMN comments INTEGER NOT NULL DEFAULT 0");
            addColIfMissing(t, "commenters", "ALTER TABLE " + t + " ADD COLUMN commenters INTEGER NOT NULL DEFAULT 0");
        }
        for (String t : new String[]{"world_books", "presets", "plugins"}) {
            addColIfMissing(t, "status", "ALTER TABLE " + t + " ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'");
            addColIfMissing(t, "reviewed_at", "ALTER TABLE " + t + " ADD COLUMN reviewed_at INTEGER NOT NULL DEFAULT 0");
            try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_" + t + "_status ON " + t + "(status)"); } catch (Exception e) { warn("索引失败", e); }
        }
        jdbc.execute("CREATE TABLE IF NOT EXISTS review_log ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, target_type TEXT NOT NULL, "
                + "target_id INTEGER NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', admin TEXT NOT NULL DEFAULT '')");
        try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_review_log_ts ON review_log(ts DESC)"); } catch (Exception e) { warn("索引失败", e); }
        try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_world_books_admin_only ON world_books(admin_only)"); } catch (Exception e) { warn("索引失败", e); }
        // 不建 FTS5 索引：Node 运行时（node:sqlite）没有 FTS5，检索走多路 LIKE 兜底；
        // Java 侧保持同一行为，否则两边检索结果会不一致（契约测试会抓）。
        addColIfMissing("client_logs", "web", "ALTER TABLE client_logs ADD COLUMN web TEXT NOT NULL DEFAULT ''");
        try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_client_logs_ts ON client_logs(ts DESC)"); } catch (Exception e) { warn("索引失败", e); }
        try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_device_days_day ON device_days(day)"); } catch (Exception e) { warn("索引失败", e); }
        try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_admin_traces_ts ON admin_traces(ts DESC)"); } catch (Exception e) { warn("索引失败", e); }

        // 聊天系统下线：老库里的 messages / channels 整体移除（幂等）
        try {
            jdbc.execute("DROP TABLE IF EXISTS messages");
            jdbc.execute("DROP TABLE IF EXISTS channels");
        } catch (Exception e) { warn("移除聊天表失败", e); }

        jdbc.execute("CREATE TABLE IF NOT EXISTS feedback ("
                + "id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, install_id TEXT NOT NULL DEFAULT '', "
                + "version TEXT NOT NULL DEFAULT '', platform TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, read_at INTEGER)");
        try { jdbc.execute("CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at DESC)"); } catch (Exception e) { warn("索引失败", e); }
        jdbc.execute("CREATE TABLE IF NOT EXISTS feedback_meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)");
    }

    /** 缺列则补列（幂等）：SQLite 没有 information_schema，用 PRAGMA table_info 探测（与 Node 版同款） */
    private void addColIfMissing(String table, String col, String ddl) {
        try {
            if (!columns(table).contains(col)) {
                jdbc.execute(ddl);
            }
        } catch (Exception e) {
            warn("迁移 " + table + "." + col + " 失败", e);
        }
    }

    private Set<String> columns(String table) {
        Set<String> out = new HashSet<>();
        try {
            for (Map<String, Object> row : jdbc.queryForList("PRAGMA table_info(" + table + ")")) {
                Object name = row.get("name");
                if (name != null) out.add(String.valueOf(name));
            }
        } catch (Exception e) {
            warn("读取表结构失败 " + table, e);
        }
        return out;
    }

    private static void warn(String msg, Exception e) {
        System.out.println("[db] " + msg + ": " + (e == null ? "" : e.getMessage()));
    }

    /** 基础建表（与 server/src/db.js 的 db.exec 大段一一对应；逐条执行，见 legacy() 的注释） */
    private static final String SCHEMA_SQL = """
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              username TEXT NOT NULL UNIQUE,
              pass_hash TEXT NOT NULL,
              pass_salt TEXT NOT NULL,
              created_at INTEGER NOT NULL
            )
            ;
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY,
              user_id INTEGER NOT NULL,
              expires_at INTEGER NOT NULL
            )
            ;
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
            )
            ;
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
            )
            ;
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
            )
            ;
            CREATE TABLE IF NOT EXISTS verify_codes (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              email TEXT NOT NULL,
              code TEXT NOT NULL,
              type TEXT NOT NULL,
              expires_at INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              used INTEGER NOT NULL DEFAULT 0
            )
            ;
            CREATE TABLE IF NOT EXISTS card_likes (
              target_type TEXT NOT NULL,
              target_id INTEGER NOT NULL,
              user_id INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (target_type, target_id, user_id)
            )
            ;
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
            )
            ;
            CREATE INDEX IF NOT EXISTS idx_card_likes_recent ON card_likes(created_at DESC)
            ;
            CREATE INDEX IF NOT EXISTS idx_card_comments_recent ON card_comments(created_at DESC)
            ;
            CREATE INDEX IF NOT EXISTS idx_card_comments_target ON card_comments(target_type, target_id, id DESC)
            ;
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
            )
            ;
            CREATE TABLE IF NOT EXISTS client_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              ts INTEGER NOT NULL,
              app_version TEXT NOT NULL DEFAULT '',
              platform TEXT NOT NULL DEFAULT '',
              kind TEXT NOT NULL,
              msg TEXT NOT NULL,
              ua TEXT NOT NULL DEFAULT ''
            )
            ;
            CREATE TABLE IF NOT EXISTS devices (
              install_id TEXT PRIMARY KEY,
              first_ts INTEGER NOT NULL,
              last_ts INTEGER NOT NULL,
              first_day TEXT NOT NULL DEFAULT '',
              last_day TEXT NOT NULL DEFAULT '',
              app_version TEXT NOT NULL DEFAULT '',
              web_version TEXT NOT NULL DEFAULT '',
              platform TEXT NOT NULL DEFAULT ''
            )
            ;
            CREATE TABLE IF NOT EXISTS device_days (
              install_id TEXT NOT NULL,
              day TEXT NOT NULL,
              PRIMARY KEY (install_id, day)
            )
            """;
}
