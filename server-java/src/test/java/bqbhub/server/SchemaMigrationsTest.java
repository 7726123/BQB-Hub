package bqbhub.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.file.Path;
import java.util.List;
import java.util.Set;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 结构迁移 + 版本标记（{@code PRAGMA user_version}）。
 *
 * 这里钉的是契约里那句「启动时幂等建表/迁移（可重复启动、可对旧库就地升级）」——
 * 以前只有「重启目标进程」隐式覆盖，没有一条直接对着老库跑的用例。
 */
class SchemaMigrationsTest {

    @TempDir
    Path tmp;

    /** 契约夹具（server/tests/helpers.js 与各测试文件）直读的表与列：一个都不能少。 */
    private static final Set<String> WORLD_BOOKS_COLS = Set.of(
            "id", "title", "description", "category", "tags", "author_id", "author_name", "filename",
            "size", "downloads", "created_at", "cover", "meta", "search_text", "admin_only",
            "likes", "comments", "commenters", "status", "reviewed_at");

    /** presets 没有 meta/search_text（只有世界书有检索索引列）。 */
    private static final Set<String> PRESET_COLS = Set.of(
            "id", "title", "description", "category", "tags", "author_id", "author_name", "filename",
            "size", "downloads", "created_at", "cover", "likes", "comments", "commenters", "status", "reviewed_at");

    @Test
    void 空库建全表并置版本() {
        JdbcTemplate j = TestDb.open(tmp.resolve("fresh.db"));
        SchemaMigrations m = new SchemaMigrations(j);
        m.run();

        assertEquals(SchemaMigrations.BASELINE, m.userVersion());
        assertTrue(TestDb.columns(j, "users").containsAll(
                Set.of("id", "username", "pass_hash", "pass_salt", "created_at", "email")));
        assertTrue(TestDb.columns(j, "world_books").containsAll(WORLD_BOOKS_COLS));
        assertTrue(TestDb.columns(j, "presets").containsAll(PRESET_COLS));
        assertTrue(TestDb.columns(j, "plugins").containsAll(Set.of(
                "plugin_id", "title", "description", "plugin_type", "plugin_version", "filename", "is_zip",
                "status", "reviewed_at")));
        assertTrue(TestDb.columns(j, "client_logs").containsAll(Set.of("ts", "app_version", "platform", "kind", "msg", "ua", "web")));
        assertTrue(TestDb.columns(j, "admin_traces").containsAll(Set.of("ts", "book", "round", "model", "window_chars", "budget", "instruction", "continuation", "recall_json")));
        assertTrue(TestDb.columns(j, "review_log").containsAll(Set.of("ts", "target_type", "target_id", "action", "note", "admin")));
        assertTrue(TestDb.columns(j, "feedback").containsAll(Set.of("text", "install_id", "version", "platform", "created_at", "read_at")));
        assertTrue(TestDb.columns(j, "feedback_meta").containsAll(Set.of("k", "v")));
        assertTrue(TestDb.columns(j, "devices").containsAll(Set.of("install_id", "first_ts", "last_ts", "first_day", "last_day", "app_version", "web_version", "platform")));
        assertTrue(TestDb.columns(j, "device_days").containsAll(Set.of("install_id", "day")));
        assertTrue(TestDb.columns(j, "card_likes").containsAll(Set.of("target_type", "target_id", "user_id", "created_at")));
        assertTrue(TestDb.columns(j, "card_comments").containsAll(Set.of("target_type", "target_id", "user_id", "username", "content", "created_at", "deleted", "deleted_by")));
        assertTrue(TestDb.columns(j, "sessions").containsAll(Set.of("token", "user_id", "expires_at")));
        assertTrue(TestDb.columns(j, "verify_codes").containsAll(Set.of("email", "code", "type", "expires_at", "created_at", "used")));
        // 已下线的聊天表不该被建出来
        assertTrue(TestDb.columns(j, "messages").isEmpty());
        assertTrue(TestDb.columns(j, "channels").isEmpty());
    }

    @Test
    void 老库就地升级_缺列补齐且老数据按缺省值走() {
        Path db = tmp.resolve("legacy.db");
        JdbcTemplate j = TestDb.open(db);
        // 手工造"老库"：老的 users（无 email）、老的 world_books（无 cover/meta/search_text/admin_only/社交计数/审核列）
        j.execute("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, pass_hash TEXT NOT NULL, pass_salt TEXT NOT NULL, created_at INTEGER NOT NULL)");
        j.execute("CREATE TABLE world_books (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '综合', tags TEXT NOT NULL DEFAULT '', author_id INTEGER NOT NULL, author_name TEXT NOT NULL, filename TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, downloads INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)");
        j.update("INSERT INTO users (username, pass_hash, pass_salt, created_at) VALUES ('老用户','h','s',1)");
        j.update("INSERT INTO world_books (title, author_id, author_name, filename, created_at) VALUES ('老卡',1,'老用户','a.json',1)");

        SchemaMigrations m = new SchemaMigrations(j);
        m.run();

        assertEquals(SchemaMigrations.BASELINE, m.userVersion());
        assertTrue(TestDb.columns(j, "users").contains("email"), "老库要补上 users.email");
        assertTrue(TestDb.columns(j, "world_books").containsAll(WORLD_BOOKS_COLS), "老库要补上全部新列");

        // 老数据不动、缺省值生效：status 默认 approved（公开列表可见）、admin_only=0、计数为 0
        var row = j.queryForMap("SELECT status, admin_only, likes, comments, commenters, meta, search_text FROM world_books WHERE title = '老卡'");
        assertEquals("approved", row.get("status"));
        assertEquals(0, ((Number) row.get("admin_only")).intValue());
        assertEquals(0, ((Number) row.get("likes")).intValue());
        assertEquals("", row.get("meta"));
        assertEquals("", row.get("search_text"));
        assertEquals(1, j.queryForObject("SELECT COUNT(*) FROM users", Integer.class));
    }

    @Test
    void 幂等_重复启动不报错也不重置版本() {
        JdbcTemplate j = TestDb.open(tmp.resolve("twice.db"));
        SchemaMigrations m = new SchemaMigrations(j);
        m.run();
        j.update("INSERT INTO world_books (title, author_id, author_name, filename, created_at) VALUES ('卡',1,'a','a.json',1)");

        m.run();
        m.run();

        assertEquals(SchemaMigrations.BASELINE, m.userVersion());
        assertEquals(1, j.queryForList("SELECT id FROM world_books").size());
    }

    @Test
    void 缺哪级补哪级_编号迁移不会重跑已完成的() {
        JdbcTemplate j = TestDb.open(tmp.resolve("numbered.db"));
        // 探针表：每条迁移往里插一行，重跑会多一行 → 可断言"只补差额"
        j.execute("CREATE TABLE probe (v INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0)");
        List<SchemaMigrations.Migration> fake = List.of(
                new SchemaMigrations.Migration(2, "假迁移 v2", x -> x.update("INSERT INTO probe (v) VALUES (2)")),
                new SchemaMigrations.Migration(3, "假迁移 v3", x -> x.update("INSERT INTO probe (v) VALUES (3)")));

        SchemaMigrations m = new SchemaMigrations(j, fake);
        m.run();
        assertEquals(3, m.userVersion(), "全新库：基线 1 → v2 → v3");
        assertEquals(2, j.queryForList("SELECT v FROM probe").size());

        // 模拟"库里是 v2、代码多了一条 v3"：只应补 v3
        m.setUserVersion(2);
        j.update("DELETE FROM probe WHERE v = 3");
        m.run();
        assertEquals(3, m.userVersion());
        assertEquals(List.of(2, 3), j.queryForList("SELECT v FROM probe ORDER BY v", Integer.class));
    }

    @Test
    void 库比代码新时不动它() {
        JdbcTemplate j = TestDb.open(tmp.resolve("newer.db"));
        SchemaMigrations m = new SchemaMigrations(j);
        m.run();
        m.setUserVersion(99);   // 例如刚从新版回滚到旧版代码

        m.run();                // 不报错、也不重置版本

        assertEquals(99, m.userVersion());
        assertFalse(TestDb.columns(j, "world_books").isEmpty(), "已有库不该被动过");
    }
}
