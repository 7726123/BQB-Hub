package bqbhub.server.review;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.SchemaMigrations;
import bqbhub.server.TestDb;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 审核队列/我的投稿：状态与类型过滤、三类合并排序、计数、通过/驳回（驳回删载荷）、分页夹取。 */
class ReviewServiceTest {

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private ReviewService svc;
    private Path uploadRoot;
    private AuthService.User alice;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("review.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        uploadRoot = tmp.resolve("uploads");
        AppConfig cfg = new AppConfig(Map.of(
                "UPLOAD_DIR", uploadRoot.toString(),
                "CONFIG_FILE", tmp.resolve("config.json").toString()));
        svc = new ReviewService(new ReviewRepository(jdbc), cfg, new Limiters());
        alice = new AuthService.User(1, "alice", "");
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    /** 造一条内容（worldbook/preset 用 filename 指载荷，plugin 用 plugin_id） */
    private long seed(String type, String title, String status, long authorId, long createdAt, String filename) {
        return switch (type) {
            case "worldbook" -> {
                jdbc.update("INSERT INTO world_books (title, author_id, author_name, filename, created_at, status) VALUES (?, ?, 'a', ?, ?, ?)",
                        title, authorId, filename, createdAt, status);
                yield jdbc.queryForObject("SELECT id FROM world_books WHERE title = ? ORDER BY id DESC LIMIT 1", Long.class, title);
            }
            case "preset" -> {
                jdbc.update("INSERT INTO presets (title, author_id, author_name, filename, created_at, status) VALUES (?, ?, 'a', ?, ?, ?)",
                        title, authorId, filename, createdAt, status);
                yield jdbc.queryForObject("SELECT id FROM presets WHERE title = ? ORDER BY id DESC LIMIT 1", Long.class, title);
            }
            default -> {
                jdbc.update("INSERT INTO plugins (plugin_id, title, author_id, author_name, filename, created_at, status) VALUES (?, ?, ?, 'a', ?, ?, ?)",
                        title, title, authorId, filename, createdAt, status);
                yield jdbc.queryForObject("SELECT id FROM plugins WHERE plugin_id = ?", Long.class, title);
            }
        };
    }

    @Test
    void 队列_默认只看待审_三类合并按时间倒序_计数不受分页影响() {
        seed("worldbook", "w1", "pending", 1, 100, "wb_1.json");
        seed("preset", "p1", "pending", 1, 300, "ps_1.json");
        seed("plugin", "pl1", "approved", 1, 200, "pl1.json");

        Map<String, Object> out = svc.queue(null, null, null, null);
        List<?> items = (List<?>) out.get("items");
        assertEquals(2, items.size(), "默认只列 pending");
        assertEquals("p1", ((Map<?, ?>) items.get(0)).get("title"), "created_at 大的在前");
        assertEquals("preset", ((Map<?, ?>) items.get(0)).get("type"));
        assertEquals(2L, out.get("total"));
        Map<?, ?> counts = (Map<?, ?>) out.get("counts");
        assertEquals(1L, counts.get("worldbook"));
        assertEquals(1L, counts.get("preset"));
        assertEquals(0L, counts.get("plugin"), "插件那条已过审");

        // 只看一类 + 指定状态
        assertEquals(1L, svc.queue("preset", "pending", null, null).get("total"));
        assertEquals(1L, svc.queue(null, "approved", null, null).get("total"));
        assertEquals(0L, svc.queue("plugin", "rejected", null, null).get("total"));

        assertEquals("未知的内容类型", err(() -> svc.queue("nope", null, null, null)));
        assertEquals("未知的审核状态", err(() -> svc.queue(null, "  ", null, null)));
    }

    @Test
    void 通过与驳回_状态留痕与驳回删载荷() throws Exception {
        Path payload = uploadRoot.resolve("worldbook").resolve("wb_9.json");
        Files.createDirectories(payload.getParent());
        Files.writeString(payload, "{}");
        long id = seed("worldbook", "待审", "pending", 1, 100, "wb_9.json");

        Map<String, Object> ok = svc.action(Map.of("type", "worldbook", "id", id, "action", "approve", "note", "看着没问题"));
        assertEquals("approved", ok.get("status"));
        assertEquals("approved", jdbc.queryForObject("SELECT status FROM world_books WHERE id = ?", String.class, id));
        assertTrue(jdbc.queryForObject("SELECT reviewed_at FROM world_books WHERE id = ?", Long.class, id) > 0);
        assertTrue(Files.exists(payload), "通过不删载荷");

        // 驳回：状态 + 删载荷 + 留痕
        long id2 = seed("worldbook", "待驳回", "pending", 1, 200, "wb_10.json");
        Path payload2 = uploadRoot.resolve("worldbook").resolve("wb_10.json");
        Files.writeString(payload2, "{}");
        assertEquals("rejected", svc.action(Map.of("type", "worldbook", "id", id2, "action", "reject", "note", "内容不合格")).get("status"));
        assertFalse(Files.exists(payload2), "驳回要当场下架载荷");

        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM review_log WHERE admin = 'admin'", Integer.class));
        assertTrue(String.valueOf(jdbc.queryForList("SELECT note FROM review_log")).contains("内容不合格"));

        assertEquals("未知的内容类型", err(() -> svc.action(Map.of("type", "nope", "id", 1, "action", "approve"))));
        assertEquals("未知的审核动作", err(() -> svc.action(Map.of("type", "worldbook", "id", id, "action", "delete"))));
        assertEquals("未找到该内容", err(() -> svc.action(Map.of("type", "worldbook", "id", 9999, "action", "approve"))));
    }

    @Test
    void 插件驳回_载荷用plugin_id拼zip路径一起清() throws Exception {
        long id = seed("plugin", "myplug", "pending", 1, 100, "myplug.json");
        Path dir = uploadRoot.resolve("plugin");
        Files.createDirectories(dir.resolve("files"));
        Files.writeString(dir.resolve("myplug.json"), "{}");
        Files.writeString(dir.resolve("files").resolve("myplug.zip"), "PK");

        svc.action(Map.of("type", "plugin", "id", id, "action", "reject", "note", "n"));
        assertFalse(Files.exists(dir.resolve("myplug.json")));
        assertFalse(Files.exists(dir.resolve("files").resolve("myplug.zip")), "插件的 zip 载荷也要清掉");
    }

    @Test
    void 我的投稿_只出自己的_计数与分页() {
        seed("worldbook", "mine-pending", "pending", alice.id, 300, "a.json");
        seed("preset", "mine-rejected", "rejected", alice.id, 200, "b.json");
        seed("worldbook", "others", "pending", 999, 100, "c.json");

        Map<String, Object> out = svc.mySubmissions(null, null, alice);
        assertEquals(2L, out.get("total"));
        assertEquals(2, ((List<?>) out.get("items")).size());
        assertFalse(String.valueOf(out.get("items")).contains("others"));
        Map<?, ?> counts = (Map<?, ?>) out.get("counts");
        assertEquals(1L, counts.get("pending"));
        assertEquals(1L, counts.get("rejected"));

        // 分页：limit 1 → 只给最新那条
        Map<String, Object> p = svc.mySubmissions("1", "0", alice);
        assertEquals(1, ((List<?>) p.get("items")).size());
        assertEquals("mine-pending", ((Map<?, ?>) ((List<?>) p.get("items")).get(0)).get("title"));
        assertEquals(2L, p.get("total"), "total 不受分页影响");
        // offset 越界 → 空列表
        assertEquals(0, ((List<?>) svc.mySubmissions("1", "99", alice).get("items")).size());
    }
}
