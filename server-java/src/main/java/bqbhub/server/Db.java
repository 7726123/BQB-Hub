package bqbhub.server;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.ResultSet;
import java.util.HashSet;
import java.util.Set;

/**
 * 数据层：SQLite（xerial sqlite-jdbc + Hikari）+ 结构迁移。
 * 逐条对应 server/src/db.js —— 表名/列名/默认值/迁移顺序保持一致，
 * 因为契约测试的夹具会**直读同一个库文件**（见 server/tests/CONTRACT.md 第二节）。
 *
 * 并发口径（交接文档 §13.161 的「真坑 ①」）：
 *   Node 版是单连接同步、天然串行，从没见过 SQLITE_BUSY；Java 多线程 + 连接池会撞写锁。
 *   这里的做法：WAL + busy_timeout=5000 + transaction_mode=IMMEDIATE（URL 参数交给驱动），
 *   连接池默认 4（可用 DB_POOL_SIZE 调；单写者场景设 1 即复刻 Node 语义）。
 *   多语句写事务（反馈插入+裁剪）走同一连接，见 FeedbackController 的 TransactionTemplate。
 */
@Component
public class Db {

    public final JdbcTemplate jdbc;
    private final HikariDataSource ds;

    public Db(AppConfig cfg) throws Exception {
        Files.createDirectories(cfg.dataDir);
        Files.createDirectories(cfg.uploadDir);
        Files.createDirectories(cfg.apkDir);
        Files.createDirectories(cfg.webBundleDir);

        HikariConfig hc = new HikariConfig();
        hc.setJdbcUrl("jdbc:sqlite:" + cfg.dataDir.resolve("chat.db").toString()
                + "?journal_mode=WAL&busy_timeout=5000&synchronous=NORMAL&transaction_mode=IMMEDIATE");
        hc.setPoolName("sqlite");
        hc.setMaximumPoolSize(intEnv("DB_POOL_SIZE", 4));
        hc.setAutoCommit(true);
        this.ds = new HikariDataSource(hc);
        this.jdbc = new JdbcTemplate(ds);
        migrate();
    }

    private static int intEnv(String k, int dflt) {
        try {
            String v = System.getenv(k);
            return (v == null || v.isEmpty()) ? dflt : Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    /** 关池（测试/优雅停机用） */
    public void close() {
        try { ds.close(); } catch (Exception e) { /* ignore */ }
    }

    /**
     * 暴露数据源：让 Spring 的自动配置（DataSource / JdbcTemplate / 事务管理器）看到我们自建的这一个，
     * 从而**不再**去读 spring.datasource.url（我们不用 YAML 配库，路径来自环境变量）。
     */
    public javax.sql.DataSource dataSource() {
        return ds;
    }

    // ---------------------------------------------------------------- 结构迁移
    private void migrate() {
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

    /** 缺列则补列（幂等）：SQLite 没有 information_schema，用 JDBC 元数据探测 */
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
        try (Connection c = ds.getConnection()) {
            DatabaseMetaData md = c.getMetaData();
            try (ResultSet rs = md.getColumns(null, null, table, null)) {
                while (rs.next()) out.add(rs.getString("COLUMN_NAME"));
            }
        } catch (Exception e) {
            warn("读取表结构失败 " + table, e);
        }
        return out;
    }

    private static void warn(String msg, Exception e) {
        System.out.println("[db] " + msg + ": " + (e == null ? "" : e.getMessage()));
    }

    /** 基础建表（与 server/src/db.js 的 db.exec 大段一一对应；逐条执行，见 migrate 的注释） */
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
