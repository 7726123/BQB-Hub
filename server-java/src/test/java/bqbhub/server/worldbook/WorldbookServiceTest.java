package bqbhub.server.worldbook;

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
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 世界书业务规则（以前埋在 528 行的 Controller 里）：审核门、admin_only、封面校验、
 * 上传时的机械抽取与合并、元数据补写权限、删除权限与留痕、载荷路径安全。
 */
class WorldbookServiceTest {

    private static final String CONTENT = "{\"entries\":["
            + "{\"name\":\"林晚\",\"type\":\"角色\",\"content\":\"黑长发，话不多\"},"
            + "{\"name\":\"世界背景\",\"type\":\"世界观\",\"content\":\"架空大陆\"}]}";

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private WorldbookService svc;
    private Path uploadRoot;
    private AuthService.User alice;
    private AuthService.User bob;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("worldbook.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        uploadRoot = tmp.resolve("uploads");
        AppConfig cfg = new AppConfig(Map.of(
                "UPLOAD_DIR", uploadRoot.toString(),
                "CONFIG_FILE", tmp.resolve("config.json").toString()));
        svc = new WorldbookService(new WorldbookRepository(jdbc), cfg, new Limiters());
        alice = new AuthService.User(1, "alice", "a@example.com");
        bob = new AuthService.User(2, "bob", "");
    }

    private static Map<String, Object> body(String title, String content) {
        return Map.of("title", title, "content", content, "category", "综合", "description", "简介");
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    private long upload(String title, String content, AuthService.User who, boolean admin) {
        return ((Number) svc.upload(body(title, content), who, admin).get("id")).longValue();
    }

    @Test
    void 上传_审核门与机械抽取落库() throws Exception {
        long id = upload("待审的", CONTENT, alice, false);
        assertEquals("pending", jdbc.queryForObject("SELECT status FROM world_books WHERE id = ?", String.class, id));
        assertEquals("wb_" + id + ".json", jdbc.queryForObject("SELECT filename FROM world_books WHERE id = ?", String.class, id));
        assertTrue(Files.isRegularFile(uploadRoot.resolve("worldbook").resolve("wb_" + id + ".json")));

        String meta = jdbc.queryForObject("SELECT meta FROM world_books WHERE id = ?", String.class, id);
        assertTrue(meta.contains("\"entryCount\":2"), meta);
        assertTrue(meta.contains("林晚"), meta);
        String searchText = jdbc.queryForObject("SELECT search_text FROM world_books WHERE id = ?", String.class, id);
        assertTrue(searchText.contains("待审的") && searchText.contains("林晚"), searchText);

        long ok = upload("直接过审", CONTENT, alice, true);
        assertEquals("approved", jdbc.queryForObject("SELECT status FROM world_books WHERE id = ?", String.class, ok));
    }

    @Test
    void 上传_adminOnly需要管理员_校验顺序也一致() {
        // adminOnly 的 403 在标题校验之前（与 Node 版同序）
        assertEquals("设置 adminOnly 需要管理员令牌", err(() -> svc.upload(
                Map.of("adminOnly", 1), alice, false)));

        Map<String, Object> okAdminOnly = Map.of("title", "只有管理员能看", "content", CONTENT, "adminOnly", 1);
        assertEquals("approved", svc.upload(okAdminOnly, alice, true).get("status"));
        assertEquals(1, jdbc.queryForObject("SELECT admin_only FROM world_books WHERE title = '只有管理员能看'", Integer.class));
    }

    @Test
    void 上传_校验文案逐条不变() {
        assertEquals("标题需 1-60 字符", err(() -> svc.upload(body("", CONTENT), alice, false)));
        assertEquals("分类格式不正确", err(() -> svc.upload(Map.of("title", "t", "content", CONTENT, "category", "!!!"), alice, false)));
        assertEquals("世界书内容不能为空且需小于 2MB", err(() -> svc.upload(body("t", ""), alice, false)));
        assertEquals("文件内容不是有效的 JSON", err(() -> svc.upload(body("t", "not json"), alice, false)));
        assertEquals("封面格式不正确", err(() -> svc.upload(Map.of("title", "t", "content", CONTENT, "cover", "data:image/png;base64,A\" onerror=x"), alice, false)));
        assertEquals("封面图片过大（需小于 320KB）", err(() -> svc.upload(
                Map.of("title", "t", "content", CONTENT, "cover", "data:image/png;base64," + "A".repeat(Media.COVER_MAX)), alice, false)));
    }

    @Test
    void 列表_审核门与adminOnly与检索分支() {
        long pending = upload("待审的", CONTENT, alice, false);
        long approved = upload("公开的", CONTENT, alice, true);
        long adminOnly = ((Number) svc.upload(Map.of("title", "管理员的", "content", CONTENT, "adminOnly", 1), alice, true).get("id")).longValue();

        Map<String, Object> pub = svc.list(null, null, null, null, null, null, null, bob, false);
        assertEquals(1L, pub.get("total"));
        assertEquals("new", pub.get("sort"));
        assertFalse(String.valueOf(pub.get("items")).contains("待审的"));

        Map<String, Object> asAdmin = svc.list(null, null, null, null, null, null, null, alice, true);
        assertEquals(2L, asAdmin.get("total"), "管理员能看到 admin_only 行");
        assertTrue(String.valueOf(asAdmin.get("items")).contains("管理员的"));
        assertFalse(String.valueOf(svc.list(null, null, null, null, null, null, null, alice, false).get("items")).contains("待审的"),
                "作者本人也不在公开列表里看到自己的待审稿（要在「我的投稿」里看）");

        // 分类过滤
        assertEquals(1L, svc.list("综合", null, null, null, null, null, null, bob, false).get("total"));
        assertEquals(0L, svc.list("不存在的分类", null, null, null, null, null, null, bob, false).get("total"));

        // q 非空 → 走检索分支：多 modes/facets、无 sort
        Map<String, Object> searched = svc.list(null, "公开", null, null, null, null, null, bob, false);
        assertTrue(searched.containsKey("modes") && searched.containsKey("facets"));
        assertFalse(searched.containsKey("sort"));
        assertTrue(((List<?>) searched.get("items")).size() >= 1);

        // /search 端点：没有查询词 → 400
        assertEquals("缺少查询词", err(() -> svc.search("", null, null, null, null, null, bob, false)));
        assertEquals(pending, ((Number) jdbc.queryForObject("SELECT id FROM world_books WHERE status='pending'", Object.class)).longValue());
    }

    @Test
    void 补写元数据_权限与结构字段保护() {
        long id = upload("待补写", CONTENT, alice, false);
        assertEquals("只能补写自己上传的世界书", err(() -> svc.meta(Map.of("id", id, "meta", Map.of("genre", "奇幻")), bob, false)));
        assertEquals("元数据格式不正确", err(() -> svc.meta(Map.of("id", id, "meta", "not json"), alice, false)));
        assertEquals("未找到该世界书", err(() -> svc.meta(Map.of("id", 9999, "meta", Map.of()), alice, false)));

        assertEquals(Map.of("ok", true), svc.meta(Map.of("id", id, "meta", Map.of("genre", "奇幻", "entryCount", 99), "tags", "奇幻,校园"), alice, false));
        String meta = jdbc.queryForObject("SELECT meta FROM world_books WHERE id = ?", String.class, id);
        assertTrue(meta.contains("\"genre\":\"奇幻\""), meta);
        assertTrue(meta.contains("\"entryCount\":2"), "结构字段仍是机械抽取的 2，不是提交的 99");
        assertEquals("奇幻,校园", jdbc.queryForObject("SELECT tags FROM world_books WHERE id = ?", String.class, id));
    }

    @Test
    void 详情与载荷_adminOnly与可见性与路径安全() throws Exception {
        long pending = upload("待审的", CONTENT, alice, false);
        long approved = upload("公开的", CONTENT, alice, true);
        long adminOnly = ((Number) svc.upload(Map.of("title", "管理员的", "content", CONTENT, "adminOnly", 1), alice, true).get("id")).longValue();

        assertEquals("未找到该世界书", err(() -> svc.detail(String.valueOf(pending), bob, false)));
        assertTrue(svc.detail(String.valueOf(pending), alice, false).containsKey("item"));
        assertTrue(svc.detail(String.valueOf(approved), bob, false).containsKey("item"));
        assertEquals("未找到该世界书", err(() -> svc.detail(String.valueOf(adminOnly), bob, false)));
        assertTrue(svc.detail(String.valueOf(adminOnly), bob, true).containsKey("item"));

        // 预览不计下载数；下载计 1
        Map<String, Object> preview = svc.preview(String.valueOf(approved), bob, false);
        assertEquals(true, preview.get("ok"));
        assertEquals(2, ((List<?>) preview.get("entries")).size());
        assertEquals(0, jdbc.queryForObject("SELECT downloads FROM world_books WHERE id = ?", Integer.class, approved));
        WorldbookService.Payload p = svc.download(String.valueOf(approved), bob, false);
        assertEquals(CONTENT, new String(p.bytes(), StandardCharsets.UTF_8));
        assertEquals(1, jdbc.queryForObject("SELECT downloads FROM world_books WHERE id = ?", Integer.class, approved));

        // 路径安全：出上传根 → 400；文件丢了 → 404；filename 空 → 404
        jdbc.update("UPDATE world_books SET filename = '../../evil.json' WHERE id = ?", approved);
        assertEquals("非法路径", err(() -> svc.download(String.valueOf(approved), bob, false)));
        jdbc.update("UPDATE world_books SET filename = 'wb_gone.json' WHERE id = ?", approved);
        assertEquals("文件已丢失", err(() -> svc.download(String.valueOf(approved), bob, false)));
        jdbc.update("UPDATE world_books SET filename = '' WHERE id = ?", approved);
        assertEquals("未找到该世界书", err(() -> svc.download(String.valueOf(approved), bob, false)));
    }

    @Test
    void 删除_作者与管理员adminOnly留痕() throws Exception {
        long pending = upload("待审的", CONTENT, alice, false);
        long approved = upload("公开的", CONTENT, alice, true);
        long adminOnly = ((Number) svc.upload(Map.of("title", "管理员的", "content", CONTENT, "adminOnly", 1), alice, true).get("id")).longValue();

        assertEquals("只能删除自己上传的世界书", err(() -> svc.delete(String.valueOf(approved), bob, false)));
        // admin_only 的行：管理员能删；非 admin_only 的公开内容：管理员也不能删（与 Node 版一致）
        assertEquals("只能删除自己上传的世界书", err(() -> svc.delete(String.valueOf(approved), bob, true)));
        assertEquals(Map.of("ok", true), svc.delete(String.valueOf(adminOnly), bob, true));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM review_log WHERE target_type='worldbook' AND target_id = ? AND action='delete'", Integer.class, adminOnly));

        Path f = uploadRoot.resolve("worldbook").resolve("wb_" + pending + ".json");
        assertTrue(Files.isRegularFile(f));
        assertEquals(Map.of("ok", true), svc.delete(String.valueOf(pending), alice, false));
        assertFalse(Files.exists(f));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM world_books WHERE id = ?", Integer.class, pending));
    }

    @Test
    @SuppressWarnings("unchecked")
    void 单行检索_只命中已过审且带facets() {
        long pending = upload("待审的剑", CONTENT, alice, false);
        long ok = upload("公开的剑", CONTENT, alice, true);
        Map<String, Object> r = svc.search("剑", null, null, null, null, null, bob, false);
        assertTrue(r.containsKey("terms"));
        List<Long> ids = ((List<Map<String, Object>>) r.get("items")).stream()
                .map(m -> ((Number) m.get("id")).longValue()).toList();
        assertTrue(ids.contains(ok), "过审那条应命中：" + ids);

        // 待审稿不进检索（管理员也一样，见 WbSearch 的审核门）——
        // 注意检索是按词命中的：用「公开的剑」也能搜到，所以这里按 id 断言，不按整串比对
        List<Long> asAdminIds = ((List<Map<String, Object>>) svc.search("待审的剑", null, null, null, null, null, alice, true).get("items")).stream()
                .map(m -> ((Number) m.get("id")).longValue()).toList();
        assertFalse(asAdminIds.contains(pending), "待审稿不该出现在检索里：" + asAdminIds);
    }
}
