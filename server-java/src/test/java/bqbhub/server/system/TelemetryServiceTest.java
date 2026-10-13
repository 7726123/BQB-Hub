package bqbhub.server.system;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.Limiters;
import bqbhub.server.SchemaMigrations;
import bqbhub.server.TestDb;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 系统面业务规则：心跳 upsert 与分日、统计口径、漏答落 JSONL、客户端日志裁剪、留档写入与只留 1000 条。 */
class TelemetryServiceTest {

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private TelemetryService telemetry;
    private AdminOpsService adminOps;
    private Path dataDir;

    @BeforeEach
    void setUp() throws Exception {
        DataSource ds = TestDb.dataSource(tmp.resolve("system.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        dataDir = tmp.resolve("data");
        Files.createDirectories(dataDir);   // 生产上由 Db 的构造器建（这里不启 Spring，手动补）
        AppConfig cfg = new AppConfig(Map.of(
                "DATA_DIR", dataDir.toString(),
                "CONFIG_FILE", tmp.resolve("config.json").toString()));
        ObjectMapper json = new ObjectMapper();
        Limiters limiters = new Limiters();
        telemetry = new TelemetryService(new TelemetryRepository(jdbc), cfg, limiters, json);
        adminOps = new AdminOpsService(new AdminOpsRepository(jdbc), cfg, limiters, json);
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    @Test
    void 心跳_首次落库_再次覆盖版本与最近时间() {
        assertEquals("bad install id", err(() -> telemetry.ping(Map.of("id", "short"), "1.1.1.1")));
        assertEquals(Map.of("ok", true), telemetry.ping(Map.of("id", "install-0001", "v", "1.6.1", "w", "1.6.1.1", "plat", "android"), "1.1.1.1"));

        Map<String, Object> row = jdbc.queryForMap("SELECT * FROM devices WHERE install_id = 'install-0001'");
        assertEquals("1.6.1", row.get("app_version"));
        assertEquals("1.6.1.1", row.get("web_version"));
        assertEquals("android", row.get("platform"));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM device_days", Integer.class));

        // 第二次心跳（空版本 = 跑内置网页包，也要如实覆盖）
        telemetry.ping(Map.of("id", "install-0001", "v", "1.6.2", "w", "", "plat", "android"), "1.1.1.1");
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM devices", Integer.class), "同一设备只有一行");
        assertEquals("1.6.2", jdbc.queryForObject("SELECT app_version FROM devices WHERE install_id = 'install-0001'", String.class));
        assertEquals("", jdbc.queryForObject("SELECT web_version FROM devices WHERE install_id = 'install-0001'", String.class));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM device_days", Integer.class), "同一天只记一条");
    }

    @Test
    void 统计_在线窗口与分日口径() {
        long now = System.currentTimeMillis();
        telemetry.ping(Map.of("id", "install-0001", "v", "1.6.1"), "1.1.1.1");   // 今天 + 在线
        jdbc.update("INSERT INTO devices (install_id, first_ts, last_ts, first_day, last_day, app_version, web_version, platform) VALUES ('old-0001', ?, ?, '2026-01-01', '2026-01-01', '1.5.101', '', '')",
                now - 30L * 86400000L, now - 30L * 86400000L);                    // 一个月前，不在线
        jdbc.update("INSERT INTO device_days (install_id, day) VALUES ('old-0001', ?)", bqbhub.server.DayKey.today());
        jdbc.update("INSERT INTO feedback (text, install_id, version, platform, created_at) VALUES ('x', 'install-0001', '', '', ?)", now);

        Map<String, Object> s = telemetry.stats();
        assertEquals(2L, s.get("total"));
        assertEquals(1L, s.get("online"), "只有刚心跳的那台在线");
        assertEquals(2L, s.get("today"));
        assertEquals(1L, s.get("newToday"), "今天新装只有 1 台");
        assertEquals(1L, s.get("feedbackUnread"));
        assertEquals(bqbhub.server.DayKey.today(), s.get("day"));
        assertEquals(TelemetryService.ONLINE_MS, s.get("onlineWindowMs"));
        assertTrue(((List<?>) s.get("versions")).size() >= 1);
        assertTrue(((List<?>) s.get("webs")).size() >= 1);
    }

    @Test
    void 漏答_落JSONL_只留必要字段与哈希后的IP() throws Exception {
        assertEquals("empty", err(() -> telemetry.assistantMiss(Map.of(), "9.9.9.9")));

        Map<String, Object> body = Map.of("conversation", List.of(
                Map.of("role", "user", "content", "这个词是什么意思"),
                Map.of("role", "assistant", "content", "抱歉，我不知道")));
        assertEquals(Map.of("ok", true), telemetry.assistantMiss(body, "9.9.9.9"));

        Path f = dataDir.resolve("assistant-misses.jsonl");
        assertTrue(Files.isRegularFile(f));
        String line = Files.readString(f, StandardCharsets.UTF_8).trim();
        assertTrue(line.contains("\"ipHash\""));
        assertTrue(line.contains("这个词是什么意思"));
        assertFalse(line.contains("9.9.9.9"), "原始 IP 不入库，只留 sha256 前 12 位");
        assertTrue(line.matches(".*\"ipHash\":\"[0-9a-f]{12}\".*"));
        // 第二条是追加不是覆盖
        telemetry.assistantMiss(body, "9.9.9.9");
        assertEquals(2, Files.readAllLines(f).size());
    }

    @Test
    void 客户端日志_字段裁剪与空报告() {
        assertEquals("empty", err(() -> telemetry.clientLogsPost(Map.of("logs", List.of(Map.of("k", "", "m", "x"))), "1.1.1.1", "ua")));

        long ts = 1791740506926L;   // 毫秒时间戳必须原样保留（int 截断回归）
        Map<String, Object> out = telemetry.clientLogsPost(Map.of("logs", List.of(
                Map.of("t", ts, "v", "1.6.1", "plat", "android", "k", "写卡", "m", "失败", "w", "1.6.1.1"))), "1.1.1.1", "test-ua");
        assertEquals(1, out.get("stored"));
        assertEquals(ts, jdbc.queryForObject("SELECT ts FROM client_logs", Long.class));
        assertEquals("写卡", jdbc.queryForObject("SELECT kind FROM client_logs", String.class));
        assertEquals("test-ua", jdbc.queryForObject("SELECT ua FROM client_logs", String.class));
        assertEquals("1.6.1.1", jdbc.queryForObject("SELECT web FROM client_logs", String.class));

        // 不带 t 的用服务器时间兜底
        telemetry.clientLogsPost(Map.of("logs", List.of(Map.of("k", "k", "m", "m"))), "1.1.1.1", "ua");
        assertTrue(jdbc.queryForObject("SELECT MAX(ts) FROM client_logs", Long.class) > 1_000_000_000_000L);

        assertEquals(2, ((List<?>) telemetry.clientLogs(null).get("logs")).size());
    }

    @Test
    void 留档_写入按ts排序_只留最新1000条_可清空() {
        long id = ((Number) adminOps.tracePost(Map.of("book", "测试书", "round", 3, "model", "m", "instruction", "i", "continuation", "c"), true, null, "1.1.1.1").get("id")).longValue();
        assertTrue(id > 0);
        long ts = 1791740506926L;
        adminOps.tracePost(Map.of("ts", ts, "book", "b", "recall", Map.of("pieces", List.of(), "chars", 0)), true, null, "1.1.1.1");
        assertEquals(ts, jdbc.queryForObject("SELECT ts FROM admin_traces WHERE book = 'b'", Long.class), "毫秒时间戳原样入库");

        for (int i = 0; i < 5; i++) {
            adminOps.tracePost(Map.of("book", "堆积", "round", i, "model", "m", "instruction", "i", "continuation", "c"), true, null, "1.1.1.1");
        }
        List<Map<String, Object>> rows = adminOps.traces(null, null, "测试书");
        assertEquals(1, rows.size());
        assertEquals("测试书", rows.get(0).get("book"));

        // trim 的口径：只留最新 N 条（这里把 keep 调小，直接验证那条 SQL）
        new AdminOpsRepository(jdbc).trimTraces(3);
        assertEquals(3, jdbc.queryForObject("SELECT COUNT(*) FROM admin_traces", Integer.class));

        Map<String, Object> del = adminOps.deleteTraces();
        assertEquals(true, del.get("ok"));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM admin_traces", Integer.class));
    }

    @Test
    void 留档HTML_转义与空数据() {
        adminOps.tracePost(Map.of("book", "<script>alert(1)</script>", "round", 1, "model", "m",
                "instruction", "看\"这里\"", "continuation", "正文<>&", "recall", "{\"pieces\":[{\"head\":\"片<a>\",\"chars\":5,\"src\":\"记忆\"}],\"chars\":5}"), true, null, "1.1.1.1");
        String html = TracesHtml.render(adminOps.traces(null, null, null));
        assertTrue(html.contains("&lt;script&gt;alert(1)&lt;/script&gt;"), "书名的尖括号必须转义");
        assertTrue(html.contains("&quot;这里&quot;"));
        assertTrue(html.contains("正文&lt;&gt;&amp;"));
        assertTrue(html.contains("记忆召回（1 段 / 5 字）"));
        assertTrue(TracesHtml.render(List.of()).contains("暂无数据"));
    }
}
