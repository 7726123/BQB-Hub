package bqbhub.server.preset;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Media;
import bqbhub.server.SchemaMigrations;
import bqbhub.server.TestDb;
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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 预设的业务规则（以前埋在 Controller 里）：审核门、封面整串校验、文件落盘与删除顺序、行级可见性、下载计数。
 */
class PresetServiceTest {

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private PresetService svc;
    private Path uploadRoot;
    private AuthService.User alice;
    private AuthService.User bob;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("preset.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        uploadRoot = tmp.resolve("uploads");
        AppConfig cfg = new AppConfig(Map.of(
                "UPLOAD_DIR", uploadRoot.toString(),
                "CONFIG_FILE", tmp.resolve("config.json").toString()));
        svc = new PresetService(new PresetRepository(jdbc), cfg, new Limiters());
        alice = new AuthService.User(1, "alice", "a@example.com");
        bob = new AuthService.User(2, "bob", "");
    }

    private static Map<String, Object> body(String title, String content) {
        return Map.of("title", title, "content", content, "category", "综合", "description", "说明");
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    private long upload(String title, String content, AuthService.User who, boolean admin) {
        Map<String, Object> out = svc.upload(body(title, content), who, admin);
        assertEquals(true, out.get("ok"));
        return ((Number) out.get("id")).longValue();
    }

    @Test
    void 上传_非管理员进审核队列_文件落盘且回填文件名() throws Exception {
        long id = upload("我的预设", "{\"a\":1}", alice, false);
        assertEquals("pending", jdbc.queryForObject("SELECT status FROM presets WHERE id = ?", String.class, id));
        assertEquals("ps_" + id + ".json", jdbc.queryForObject("SELECT filename FROM presets WHERE id = ?", String.class, id));
        Path f = uploadRoot.resolve("preset").resolve("ps_" + id + ".json");
        assertTrue(Files.isRegularFile(f));
        assertEquals("{\"a\":1}", Files.readString(f, StandardCharsets.UTF_8));
        assertEquals("{\"a\":1}".getBytes(StandardCharsets.UTF_8).length,
                ((Number) jdbc.queryForObject("SELECT size FROM presets WHERE id = ?", Object.class, id)).intValue());
    }

    @Test
    void 上传_管理员直接过审() {
        long id = upload("管理员的预设", "{}", alice, true);
        assertEquals("approved", jdbc.queryForObject("SELECT status FROM presets WHERE id = ?", String.class, id));
    }

    @Test
    void 上传_校验文案逐条不变() {
        assertEquals("标题需 1-60 字符", err(() -> svc.upload(body("", "{}"), alice, false)));
        assertEquals("标题需 1-60 字符", err(() -> svc.upload(body("x".repeat(61), "{}"), alice, false)));
        assertEquals("分类格式不正确", err(() -> svc.upload(Map.of("title", "t", "content", "{}", "category", "!!!"), alice, false)));
        assertEquals("预设内容不能为空且需小于 2MB", err(() -> svc.upload(body("t", ""), alice, false)));
        assertEquals("文件内容不是有效的 JSON", err(() -> svc.upload(body("t", "not json"), alice, false)));
        assertEquals("封面格式不正确", err(() -> svc.upload(Map.of("title", "t", "content", "{}", "cover", "data:image/png;base64,AAA\" onerror=x"), alice, false)));
        assertEquals("封面图片过大（需小于 320KB）", err(() -> svc.upload(
                Map.of("title", "t", "content", "{}", "cover", "data:image/png;base64," + "A".repeat(Media.COVER_MAX)), alice, false)));
        // 合法封面能过
        Map<String, Object> withCover = new java.util.HashMap<>(body("带封面", "{}"));
        withCover.put("cover", "data:image/png;base64,AAAA");
        long id = ((Number) svc.upload(withCover, alice, false).get("id")).longValue();
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM presets WHERE id = ? AND cover <> ''", Integer.class, id));
    }

    @Test
    void 列表_只出现已过审的_分类与检索可过滤() throws Exception {
        long pending = upload("待审的", "{}", alice, false);
        long ok1 = upload("剑与魔法", "{}", alice, true);
        long ok2 = upload("日常校园", "{}", alice, true);
        jdbc.update("UPDATE presets SET category = '奇幻' WHERE id = ?", ok1);

        Map<String, Object> all = svc.list(null, null, null, null, null, bob.id);
        assertEquals(2L, all.get("total"), "pending 不进公开列表（连作者自己也不在列表里看到）");
        assertEquals(2, ((List<?>) all.get("items")).size());
        String allJson = String.valueOf(all.get("items"));
        assertTrue(allJson.contains("剑与魔法") && allJson.contains("日常校园"));
        assertFalse(allJson.contains("待审的"), "待审稿不该出现在列表里（id=" + pending + "）");

        Map<String, Object> byCat = svc.list("奇幻", null, null, null, null, bob.id);
        assertEquals(1L, byCat.get("total"));

        Map<String, Object> byQ = svc.list(null, "校园", null, null, null, bob.id);
        assertEquals(1L, byQ.get("total"));

        // 分页：pageSize 1 → 第二页拿到另一条
        Map<String, Object> p1 = svc.list(null, null, "new", "1", "1", bob.id);
        Map<String, Object> p2 = svc.list(null, null, "new", "2", "1", bob.id);
        assertEquals(1, ((List<?>) p1.get("items")).size());
        assertEquals(1, ((List<?>) p2.get("items")).size());
        assertNotEquals(p1.get("items"), p2.get("items"));
        assertEquals(1, p1.get("page"));
        assertEquals(1, p1.get("pageSize"));
        assertEquals("new", p1.get("sort"));
    }

    @Test
    void 详情_可见性口径() {
        long pending = upload("待审的", "{}", alice, false);
        long approved = upload("已过审的", "{}", alice, true);

        assertEquals("未找到该预设", err(() -> svc.detail(String.valueOf(pending), bob, false)));
        assertEquals("未找到该预设", err(() -> svc.detail("9999", bob, false)));
        assertTrue(svc.detail(String.valueOf(pending), alice, false).containsKey("item"), "作者能看自己的待审稿");
        assertTrue(svc.detail(String.valueOf(pending), bob, true).containsKey("item"), "管理员能看");
        assertTrue(svc.detail(String.valueOf(approved), bob, false).containsKey("item"), "过审的谁都能看");
    }

    @Test
    void 删除_非作者403_作者删除会清载荷与点赞评论() throws Exception {
        long id = upload("要删的", "{}", alice, true);
        Path f = uploadRoot.resolve("preset").resolve("ps_" + id + ".json");
        assertTrue(Files.isRegularFile(f));
        jdbc.update("INSERT INTO card_likes (target_type, target_id, user_id, created_at) VALUES ('preset', ?, ?, 1)", id, bob.id);
        jdbc.update("INSERT INTO card_comments (target_type, target_id, user_id, username, content, created_at) VALUES ('preset', ?, ?, 'bob', 'hi', 1)", id, bob.id);

        assertEquals("只能删除自己上传的预设", err(() -> svc.delete(String.valueOf(id), bob)));
        assertEquals("未找到该预设", err(() -> svc.delete("9999", alice)));

        assertEquals(Map.of("ok", true), svc.delete(String.valueOf(id), alice));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM presets WHERE id = ?", Integer.class, id));
        assertFalse(Files.exists(f), "载荷文件应被删掉");
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM card_likes WHERE target_type='preset' AND target_id = ?", Integer.class, id));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM card_comments WHERE target_type='preset' AND target_id = ?", Integer.class, id));
    }

    @Test
    void 下载_返回原文件并计数_非法路径与丢文件各有文案() throws Exception {
        long id = upload("下载的", "{\"k\":\"v\"}", alice, true);
        PresetService.Payload p = svc.download(String.valueOf(id), bob, false);
        assertEquals("{\"k\":\"v\"}", new String(p.bytes(), StandardCharsets.UTF_8));
        assertEquals(id, p.id());
        assertEquals(1, jdbc.queryForObject("SELECT downloads FROM presets WHERE id = ?", Integer.class, id));
        svc.download(String.valueOf(id), bob, false);
        assertEquals(2, jdbc.queryForObject("SELECT downloads FROM presets WHERE id = ?", Integer.class, id));

        // 边界是上传根本身：只出 preset 子目录（../evil.json）会落进上传根、仍被当成"找不到文件"；
        // 要出上传根（../../evil.json）才是 400 非法路径——与 Media.payloadPaths 的口径一致
        jdbc.update("UPDATE presets SET filename = '../evil.json' WHERE id = ?", id);
        assertEquals("文件已丢失", err(() -> svc.download(String.valueOf(id), bob, false)));

        jdbc.update("UPDATE presets SET filename = '../../evil.json' WHERE id = ?", id);
        assertEquals("非法路径", err(() -> svc.download(String.valueOf(id), bob, false)));

        jdbc.update("UPDATE presets SET filename = 'ps_gone.json' WHERE id = ?", id);
        assertEquals("文件已丢失", err(() -> svc.download(String.valueOf(id), bob, false)));

        jdbc.update("UPDATE presets SET filename = '' WHERE id = ?", id);
        assertEquals("未找到该预设", err(() -> svc.download(String.valueOf(id), bob, false)));
    }
}
