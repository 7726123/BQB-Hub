package bqbhub.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 社区插件路由（逐条对应 server/src/routes/plugin.js）：列表 / 上传 / 下载 / 删除。
 * 插件 = 声明式清单（manifest JSON）+ 可选 zip 资源包；服务器只校验结构、不执行任何内容。
 * Node 版读 zip 里的 plugin.json 靠 shell 调 unzip；Java 直接用 ZipInputStream（少一个外部依赖，
 * 缺 plugin.json 的报错文案保持一致）。
 */
@RestController
@RequestMapping("/api/plugin")
public class PluginController {

    static final List<String> TYPES_OK = List.of("database", "regex", "preset", "memory", "widget");
    private static final ObjectMapper JSON = new ObjectMapper();

    private final JdbcTemplate jdbc;
    private final AppConfig cfg;
    private final AuthService auth;
    private final Limiters limiters;

    public PluginController(JdbcTemplate jdbc, AppConfig cfg, AuthService auth, Limiters limiters) {
        this.jdbc = jdbc;
        this.cfg = cfg;
        this.auth = auth;
        this.limiters = limiters;
    }

    @GetMapping("/list")
    public Map<String, Object> list(HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT id, plugin_id, title, description, plugin_type, plugin_version, author_id, author_name, downloads, created_at "
                        + "FROM plugins WHERE status = 'approved' ORDER BY created_at DESC LIMIT 200");
        return Map.of("items", rows);
    }

    @PostMapping("/upload")
    public Map<String, Object> upload(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.upload.allow("u" + me.id)) throw ApiError.of(429, "上传过于频繁，请稍后再试");
        Map<String, Object> b = body == null ? Map.of() : body;
        boolean isZip = truthy(b.get("isZip"));
        byte[] zipBytes = null;
        JsonNode manifest = null;

        if (isZip) {
            String raw = Validators.str(b.get("content"));
            if (!raw.matches("(?s)^data:application/zip;base64,.+$")) throw ApiError.of(400, "zip 内容格式不正确");
            String b64 = raw.substring(raw.indexOf(',') + 1);
            try {
                zipBytes = Base64.getDecoder().decode(b64);
            } catch (Exception e) {
                throw ApiError.of(400, "zip 内容格式不正确");
            }
            if (zipBytes.length > 10 * 1024 * 1024) throw ApiError.of(400, "zip 需小于 10MB");
            manifest = readPluginJsonFromZip(zipBytes);
            if (manifest == null) throw ApiError.of(400, "zip 内缺少 plugin.json（或服务器缺少 unzip）");
        } else {
            try {
                manifest = JSON.readTree(Validators.str(b.get("content")));
            } catch (Exception e) {
                throw ApiError.of(400, "文件内容不是有效的 JSON");
            }
        }

        String verr = validateManifest(manifest);
        if (verr != null) throw ApiError.of(400, verr);
        String pluginId = manifest.path("id").asText("");
        if (!jdbc.queryForList("SELECT id FROM plugins WHERE plugin_id = ?", pluginId).isEmpty()) {
            throw ApiError.of(400, "插件 id=" + pluginId + " 已存在，请修改 manifest 的 id 或联系作者更新");
        }
        long now = System.currentTimeMillis();
        Path pdir = cfg.uploadDir.resolve("plugin");
        long size = isZip ? zipBytes.length : Validators.str(b.get("content")).getBytes(StandardCharsets.UTF_8).length;
        String status = auth.isAdmin(req) ? "approved" : "pending";
        long id = insertAndReturnId("INSERT INTO plugins (plugin_id, title, description, plugin_type, plugin_version, author_id, author_name, filename, is_zip, size, downloads, created_at, status) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                pluginId, manifest.path("name").asText(""),
                Validators.cut(manifest.path("description").asText(""), 500),
                manifest.path("type").asText(""), manifest.path("version").asText(""),
                me.id, me.username, "", isZip ? 1 : 0, size, now, status);
        String mfile = pluginId + ".json";
        try {
            Files.createDirectories(pdir);
            Files.writeString(pdir.resolve(mfile), prettyJson(manifest), StandardCharsets.UTF_8);
            if (isZip) {
                Path zdir = pdir.resolve("files");
                Files.createDirectories(zdir);
                Files.write(zdir.resolve(pluginId + ".zip"), zipBytes);
            }
        } catch (IOException e) {
            throw ApiError.of(500, "写入文件失败");
        }
        jdbc.update("UPDATE plugins SET filename = ? WHERE id = ?", mfile, id);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        out.put("plugin_id", pluginId);
        out.put("status", status);
        return out;
    }

    @GetMapping("/download/{pluginId}")
    public Map<String, Object> download(@PathVariable String pluginId, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        Map<String, Object> row = firstRow("SELECT id, plugin_id, filename, author_id, status FROM plugins WHERE plugin_id = ?", Validators.str(pluginId));
        if (row == null || Validators.str(row.get("filename")).isEmpty()) throw ApiError.of(404, "未找到该插件");
        if (!canSee(req, me, row)) throw ApiError.of(404, "未找到该插件");
        Path pdir = cfg.uploadDir.normalize().resolve("plugin");
        Path abs = pdir.resolve(Validators.str(row.get("filename"))).normalize();
        if (!abs.startsWith(pdir)) throw ApiError.of(400, "非法路径");
        if (!Files.isRegularFile(abs)) throw ApiError.of(404, "文件已丢失");
        jdbc.update("UPDATE plugins SET downloads = downloads + 1 WHERE id = ?", ((Number) row.get("id")).longValue());
        JsonNode manifest;
        try {
            manifest = JSON.readTree(Files.readString(abs, StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw ApiError.of(500, "清单损坏");
        }
        if (manifest == null) throw ApiError.of(500, "清单损坏");
        return Map.of("manifest", JSON.convertValue(manifest, Map.class));
    }

    @DeleteMapping("/delete")
    public Map<String, Object> delete(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        String pluginId = Validators.str(id);
        Map<String, Object> row = firstRow("SELECT id, author_id, filename FROM plugins WHERE plugin_id = ?", pluginId);
        if (row == null) throw ApiError.of(404, "未找到该插件");
        if (((Number) row.get("author_id")).longValue() != me.id) throw ApiError.of(403, "只能删除自己上传的插件");
        jdbc.update("DELETE FROM plugins WHERE plugin_id = ?", pluginId);
        Media.removePayload(cfg, "plugin", Validators.str(row.get("filename")), pluginId);
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 内部
    /** 从 zip 里读 plugin.json（失败/缺失返回 null） */
    private static JsonNode readPluginJsonFromZip(byte[] zipBytes) {
        try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if ("plugin.json".equals(name) || name.endsWith("/plugin.json")) {
                    String text = new String(zin.readAllBytes(), StandardCharsets.UTF_8);
                    return JSON.readTree(text);
                }
            }
        } catch (Exception e) { /* 落回 null → 路由回 400 */ }
        return null;
    }

    /** 清单结构校验；返回错误文案或 null */
    private static String validateManifest(JsonNode m) {
        if (m == null || !m.isObject()) return "插件清单无效";
        String id = m.path("id").asText("");
        if (id.isEmpty() || !id.matches("^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$")) return "插件 ID 需为 1-64 位字母/数字/_-";
        String name = m.path("name").asText("");
        if (name.trim().isEmpty() || name.length() > 40) return "插件名称需 1-40 字符";
        String version = m.path("version").asText("");
        if (version.isEmpty() || version.length() > 20) return "插件版本号缺失或过长";
        String type = m.path("type").asText("");
        if (!TYPES_OK.contains(type)) return "插件类型必须是 " + String.join("/", TYPES_OK);
        if ("database".equals(type)) {
            JsonNode tables = m.path("data").path("tables");
            if (!tables.isArray() || tables.isEmpty()) return "database 插件需要 data.tables";
            for (JsonNode t : tables) {
                String tname = t.path("name").asText("");
                JsonNode cols = t.path("columns");
                if (tname.isEmpty() || !cols.isArray() || cols.isEmpty()) return "表格「" + (tname.isEmpty() ? "?" : tname) + "」缺少列定义";
            }
        }
        return null;
    }

    private boolean canSee(HttpServletRequest req, AuthService.User me, Map<String, Object> row) {
        if (auth.isAdmin(req)) return true;
        if ("approved".equals(Validators.str(row.get("status")))) return true;
        Object authorId = row.get("author_id");
        return authorId instanceof Number n && n.longValue() == me.id;
    }

    private static String prettyJson(JsonNode node) {
        try {
            return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(node);
        } catch (Exception e) {
            return node.toString();
        }
    }

    private static boolean truthy(Object o) {
        if (o instanceof Boolean b) return b;
        String s = Validators.str(o);
        return "1".equals(s) || "true".equalsIgnoreCase(s);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long insertAndReturnId(String sql, Object... args) {
        var keyHolder = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(sql, java.sql.Statement.RETURN_GENERATED_KEYS);
            for (int i = 0; i < args.length; i++) ps.setObject(i + 1, args[i]);
            return ps;
        }, keyHolder);
        Number key = keyHolder.getKey();
        return key == null ? 0 : key.longValue();
    }
}
