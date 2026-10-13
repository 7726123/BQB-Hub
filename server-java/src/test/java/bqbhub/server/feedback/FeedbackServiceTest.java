package bqbhub.server.feedback;

import bqbhub.server.ApiError;
import bqbhub.server.Limiters;
import bqbhub.server.SchemaMigrations;
import bqbhub.server.TestDb;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 反馈的业务规则（以前这些都埋在 Controller 里、只能靠黑盒契约套件覆盖）：
 * 校验 → 限流 → 配额 → 去重 → 插入+裁剪同一事务；裁剪优先动已查看。
 */
class FeedbackServiceTest {

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private FeedbackService svc;
    private Limiters limiters;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("feedback.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        limiters = new Limiters();
        svc = new FeedbackService(new FeedbackRepository(jdbc), limiters, new DataSourceTransactionManager(ds));
    }

    private static String installId(int n) {
        return "install-" + String.format("%04d", n);
    }

    private Map<String, Object> body(String text, String id) {
        return Map.of("text", text, "id", id, "v", "1.6.1", "plat", "android");
    }

    @Test
    void 正常提交落库并记录版本平台() {
        assertEquals(Map.of("ok", true), svc.submit(body("第一条反馈", installId(1)), "1.2.3.4"));
        Map<String, Object> row = jdbc.queryForMap("SELECT text, install_id FROM feedback");
        assertEquals("第一条反馈", row.get("text"));
        assertEquals(installId(1), row.get("install_id"));
        assertEquals("1.6.1", jdbc.queryForObject("SELECT version FROM feedback", String.class));
        assertEquals("android", jdbc.queryForObject("SELECT platform FROM feedback", String.class));
    }

    @Test
    void 校验_空内容与超长与坏安装标识() {
        assertEquals("内容不能为空", assertThrows(ApiError.class, () -> svc.submit(body("   \r\n ", installId(1)), "1.1.1.1")).body.get("error"));
        assertEquals("内容超过 300 字", assertThrows(ApiError.class, () -> svc.submit(body("字".repeat(301), installId(1)), "1.1.1.1")).body.get("error"));
        assertEquals("bad install id", assertThrows(ApiError.class, () -> svc.submit(body("x", "short"), "1.1.1.1")).body.get("error"));
    }

    @Test
    void 限流_同设备每分钟两条() {
        String id = installId(2);
        assertTrue(svc.submit(body("a", id), "2.2.2.2").containsKey("ok"));
        assertTrue(svc.submit(body("b", id), "2.2.2.2").containsKey("ok"));
        ApiError e = assertThrows(ApiError.class, () -> svc.submit(body("c", id), "2.2.2.2"));
        assertEquals(429, e.status);
        assertEquals("提得太频繁了，请过一分钟再试", e.body.get("error"));
    }

    @Test
    void 去重_同设备十分钟内同样内容不入库但仍答收到() {
        String id = installId(3);
        svc.submit(body("一模一样", id), "3.3.3.3");
        // 第二条同样内容会在「每分钟 2 条」的桶里（第 2 条仍允许）→ 应走去重分支
        Map<String, Object> second = svc.submit(body("一模一样", id), "3.3.3.3");
        assertEquals(Map.of("ok", true, "deduped", true), second);
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM feedback", Integer.class));
    }

    @Test
    void 设备日配额20条() {
        String id = installId(4);
        for (int i = 0; i < FeedbackService.DEVICE_DAILY_MAX; i++) {
            jdbc.update("INSERT INTO feedback (text, install_id, version, platform, created_at) VALUES (?, ?, '', '', ?)",
                    "旧" + i, id, System.currentTimeMillis() - 3600_000L);
        }
        limiters.fbDevice.clear();
        ApiError e = assertThrows(ApiError.class, () -> svc.submit(body("第 21 条", id), "4.4.4.4"));
        assertEquals(429, e.status);
        assertEquals("今天提交得有点多，明天再来吧", e.body.get("error"));
    }

    @Test
    void 裁剪_先删最旧的已查看_不够再动未查看() {
        long now = System.currentTimeMillis();
        // 库里有 1005 条：最旧的 3 条是已查看，其余未查看；再提交 1 条 → 超 6 条要裁
        for (int i = 0; i < 1005; i++) {
            jdbc.update("INSERT INTO feedback (text, install_id, version, platform, created_at, read_at) VALUES (?, ?, '', '', ?, ?)",
                    "旧" + i, installId(9), now - 10_000_000L + i, i < 3 ? 1L : null);
        }
        limiters.fbDevice.clear();
        limiters.fbIp.clear();
        svc.submit(body("新反馈", installId(10)), "5.5.5.5");

        assertEquals(FeedbackService.MAX_ITEMS, jdbc.queryForObject("SELECT COUNT(*) FROM feedback", Integer.class));
        // 3 条已查看全被裁掉，未查看只补裁 3 条最旧的（旧3/旧4/旧5），更新的未查看一条没动
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM feedback WHERE text IN ('旧0','旧1','旧2')", Integer.class));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM feedback WHERE text IN ('旧3','旧4','旧5')", Integer.class));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM feedback WHERE text = '旧6'", Integer.class));
        assertEquals(6L, ((Number) jdbc.queryForMap("SELECT v FROM feedback_meta WHERE k = 'trimmed'").get("v")).longValue());
    }

    @Test
    void 管理端_列表口径与标记已读与删除() {
        String id = installId(11);
        svc.submit(body("一", id), "6.6.6.6");
        svc.submit(body("二", id), "6.6.6.6");
        List<Long> ids = jdbc.queryForList("SELECT id FROM feedback ORDER BY id", Long.class);

        Map<String, Object> unread = svc.adminList("", "50");
        assertEquals(2L, unread.get("unread"));
        assertEquals(0L, unread.get("read"));
        assertEquals(2L, unread.get("total"));
        assertEquals(2, ((List<?>) unread.get("items")).size());

        assertEquals("未知的状态", assertThrows(ApiError.class, () -> svc.adminList("bogus", "1")).body.get("error"));

        assertEquals(Map.of("ok", true, "changed", 2), svc.adminRead(Map.of("ids", ids)));
        assertEquals(0L, svc.adminList("unread", "50").get("unread"));
        assertEquals(2L, svc.adminList("read", "50").get("read"));

        assertEquals("没有要标记的条目", assertThrows(ApiError.class, () -> svc.adminRead(Map.of())).body.get("error"));
        assertEquals(Map.of("ok", true, "changed", 1), svc.adminDelete(Map.of("id", ids.get(0))));
        assertEquals("没有要删除的条目", assertThrows(ApiError.class, () -> svc.adminDelete(Map.of())).body.get("error"));

        // 全量标记已读
        assertEquals(Map.of("ok", true, "changed", 0), svc.adminRead(Map.of("all", true)));
        assertEquals(1L, svc.adminList("all", "50").get("total"));
    }

    @Test
    void 管理端_列表limit夹取与非法值回落() {
        for (int i = 0; i < 60; i++) {
            jdbc.update("INSERT INTO feedback (text, install_id, version, platform, created_at) VALUES (?, ?, '', '', ?)",
                    "行" + i, installId(20 + i % 3), System.currentTimeMillis() - i);
        }
        assertEquals(50, ((List<?>) svc.adminList("all", "0").get("items")).size());      // 0 → 默认 50
        assertEquals(50, ((List<?>) svc.adminList("all", "-3").get("items")).size());     // 负数 → 默认 50
        assertEquals(50, ((List<?>) svc.adminList("all", "abc").get("items")).size());    // 非法 → 默认 50
        assertEquals(7, ((List<?>) svc.adminList("all", "7").get("items")).size());       // 正常值按原样
        assertEquals(60, ((List<?>) svc.adminList("all", "9999").get("items")).size());   // 超上限夹到 200（库里只有 60）
    }
}
