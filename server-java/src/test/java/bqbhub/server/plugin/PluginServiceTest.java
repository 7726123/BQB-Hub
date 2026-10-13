package bqbhub.server.plugin;

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
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 插件业务规则：清单校验文案、zip 内 plugin.json、id 去重、审核门、下载可见性与删除权限与载荷清理。 */
class PluginServiceTest {

    private static final String MANIFEST = "{\"id\":\"my-plugin\",\"name\":\"示例插件\",\"version\":\"1.0.0\",\"type\":\"preset\"}";

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private PluginService svc;
    private Path uploadRoot;
    private AuthService.User alice;
    private AuthService.User bob;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("plugin.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        uploadRoot = tmp.resolve("uploads");
        AppConfig cfg = new AppConfig(Map.of(
                "UPLOAD_DIR", uploadRoot.toString(),
                "CONFIG_FILE", tmp.resolve("config.json").toString()));
        svc = new PluginService(new PluginRepository(jdbc), cfg, new Limiters());
        alice = new AuthService.User(1, "alice", "");
        bob = new AuthService.User(2, "bob", "");
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    private static String zipDataUri(String json, boolean withPluginJson) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(bos)) {
            if (withPluginJson) {
                zos.putNextEntry(new ZipEntry("plugin.json"));
                zos.write(json.getBytes(StandardCharsets.UTF_8));
                zos.closeEntry();
            }
            zos.putNextEntry(new ZipEntry("readme.txt"));
            zos.write("hi".getBytes(StandardCharsets.UTF_8));
            zos.closeEntry();
        }
        return "data:application/zip;base64," + Base64.getEncoder().encodeToString(bos.toByteArray());
    }

    private long uploadJson(String manifest, boolean admin) {
        return ((Number) svc.upload(Map.of("content", manifest), alice, admin).get("id")).longValue();
    }

    @Test
    void 上传清单_审核门与落盘() throws Exception {
        Map<String, Object> out = svc.upload(Map.of("content", MANIFEST), alice, false);
        assertEquals(true, out.get("ok"));
        assertEquals("my-plugin", out.get("plugin_id"));
        assertEquals("pending", out.get("status"));
        long id = ((Number) out.get("id")).longValue();
        assertEquals("my-plugin.json", jdbc.queryForObject("SELECT filename FROM plugins WHERE id = ?", String.class, id));
        Path f = uploadRoot.resolve("plugin").resolve("my-plugin.json");
        assertTrue(Files.isRegularFile(f));
        assertTrue(Files.readString(f, StandardCharsets.UTF_8).contains("\"示例插件\""), "落盘的是带缩进的清单");

        assertEquals("approved", svc.upload(Map.of("content", "{\"id\":\"p2\",\"name\":\"n\",\"version\":\"1\",\"type\":\"regex\"}"), alice, true).get("status"));

        // id 冲突
        assertTrue(err(() -> svc.upload(Map.of("content", MANIFEST), alice, true)).startsWith("插件 id=my-plugin 已存在"));
    }

    @Test
    void 上传zip_读内嵌清单并落两份文件() throws Exception {
        Map<String, Object> out = svc.upload(Map.of("isZip", true, "content", zipDataUri(MANIFEST, true)), alice, true);
        assertEquals("my-plugin", out.get("plugin_id"));
        assertTrue(Files.isRegularFile(uploadRoot.resolve("plugin").resolve("my-plugin.json")));
        assertTrue(Files.isRegularFile(uploadRoot.resolve("plugin").resolve("files").resolve("my-plugin.zip")));
        long id = ((Number) out.get("id")).longValue();
        assertEquals(1, jdbc.queryForObject("SELECT is_zip FROM plugins WHERE id = ?", Integer.class, id));

        String noManifest = zipDataUri(MANIFEST, false);
        assertEquals("zip 内缺少 plugin.json（或服务器缺少 unzip）",
                err(() -> svc.upload(Map.of("isZip", true, "content", noManifest), alice, true)));
        assertEquals("zip 内容格式不正确", err(() -> svc.upload(Map.of("isZip", true, "content", "not-a-zip"), alice, true)));
        assertEquals("文件内容不是有效的 JSON", err(() -> svc.upload(Map.of("content", "not json"), alice, true)));
    }

    @Test
    void 清单校验文案逐条不变() {
        assertEquals("插件清单无效", err(() -> svc.upload(Map.of("content", "\"just a string\""), alice, true)));
        assertEquals("插件 ID 需为 1-64 位字母/数字/_-", err(() -> svc.upload(Map.of("content", "{\"id\":\"-bad\",\"name\":\"n\",\"version\":\"1\",\"type\":\"preset\"}"), alice, true)));
        assertEquals("插件名称需 1-40 字符", err(() -> svc.upload(Map.of("content", "{\"id\":\"ok1\",\"name\":\"  \",\"version\":\"1\",\"type\":\"preset\"}"), alice, true)));
        assertEquals("插件版本号缺失或过长", err(() -> svc.upload(Map.of("content", "{\"id\":\"ok1\",\"name\":\"n\",\"version\":\"\",\"type\":\"preset\"}"), alice, true)));
        assertEquals("插件类型必须是 database/regex/preset/memory/widget", err(() -> svc.upload(Map.of("content", "{\"id\":\"ok1\",\"name\":\"n\",\"version\":\"1\",\"type\":\"nope\"}"), alice, true)));
        assertEquals("database 插件需要 data.tables", err(() -> svc.upload(Map.of("content", "{\"id\":\"ok1\",\"name\":\"n\",\"version\":\"1\",\"type\":\"database\"}"), alice, true)));
        assertEquals("表格「t1」缺少列定义", err(() -> svc.upload(Map.of("content", "{\"id\":\"ok1\",\"name\":\"n\",\"version\":\"1\",\"type\":\"database\",\"data\":{\"tables\":[{\"name\":\"t1\"}]}}"), alice, true)));
        // 合法的 database 清单能过
        long id = uploadJson("{\"id\":\"db1\",\"name\":\"n\",\"version\":\"1\",\"type\":\"database\",\"data\":{\"tables\":[{\"name\":\"t1\",\"columns\":[{\"name\":\"c\"}]}]}}", true);
        assertTrue(id > 0);
    }

    @Test
    void 列表只看已过审() {
        uploadJson(MANIFEST, false);
        uploadJson("{\"id\":\"public\",\"name\":\"公开插件\",\"version\":\"1\",\"type\":\"preset\"}", true);
        List<?> items = (List<?>) svc.list(bob).get("items");
        assertEquals(1, items.size());
        assertTrue(String.valueOf(items).contains("public"));
        assertFalse(String.valueOf(items).contains("my-plugin"));
    }

    @Test
    void 下载_可见性计数与清单返回() {
        long id = uploadJson(MANIFEST, true);
        Map<String, Object> out = svc.download("my-plugin", bob, false);
        assertTrue(out.containsKey("manifest"));
        assertEquals("示例插件", ((Map<?, ?>) out.get("manifest")).get("name"));
        assertEquals(1, jdbc.queryForObject("SELECT downloads FROM plugins WHERE id = ?", Integer.class, id));

        assertEquals("未找到该插件", err(() -> svc.download("nope", bob, false)));
        // 待审插件：作者可见、别人 404
        uploadJson("{\"id\":\"pending1\",\"name\":\"待审\",\"version\":\"1\",\"type\":\"preset\"}", false);
        assertEquals("未找到该插件", err(() -> svc.download("pending1", bob, false)));
        assertTrue(svc.download("pending1", alice, false).containsKey("manifest"));
    }

    @Test
    void 删除_权限与载荷清理() throws Exception {
        svc.upload(Map.of("isZip", true, "content", zipDataUri(MANIFEST, true)), alice, true);
        Path mf = uploadRoot.resolve("plugin").resolve("my-plugin.json");
        Path zf = uploadRoot.resolve("plugin").resolve("files").resolve("my-plugin.zip");
        assertTrue(Files.isRegularFile(mf) && Files.isRegularFile(zf));

        assertEquals("只能删除自己上传的插件", err(() -> svc.delete("my-plugin", bob)));
        assertEquals("未找到该插件", err(() -> svc.delete("nope", alice)));

        assertEquals(Map.of("ok", true), svc.delete("my-plugin", alice));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM plugins WHERE plugin_id = 'my-plugin'", Integer.class));
        assertFalse(Files.exists(mf), "清单文件应被删掉");
        assertFalse(Files.exists(zf), "zip 载荷应被删掉");
    }
}
