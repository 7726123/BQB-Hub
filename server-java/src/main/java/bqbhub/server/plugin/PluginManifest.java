package bqbhub.server.plugin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 插件清单（manifest）的解析与校验（原 PluginController 的私有静态方法，文案一条没改）。
 * Node 版读 zip 里的 plugin.json 靠 shell 调 unzip；Java 直接用 ZipInputStream（少一个外部依赖，
 * 缺 plugin.json 的报错文案保持一致）。
 * 插件 = 声明式清单 + 可选 zip 资源包；服务器只校验结构、**不执行任何内容**。
 */
final class PluginManifest {

    static final List<String> TYPES_OK = List.of("database", "regex", "preset", "memory", "widget");
    private static final ObjectMapper JSON = new ObjectMapper();

    private PluginManifest() {
    }

    /** 解析清单 JSON；非法返回 null（调用方按上下文给 400 文案） */
    static JsonNode parse(String text) {
        try {
            return JSON.readTree(text);
        } catch (Exception e) {
            return null;
        }
    }

    /** 从 zip 里读 plugin.json（失败/缺失返回 null） */
    static JsonNode readFromZip(byte[] zipBytes) {
        try (ZipInputStream zin = new ZipInputStream(new ByteArrayInputStream(zipBytes))) {
            ZipEntry e;
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if ("plugin.json".equals(name) || name.endsWith("/plugin.json")) {
                    String text = new String(zin.readAllBytes(), StandardCharsets.UTF_8);
                    return parse(text);
                }
            }
        } catch (Exception e) { /* 落回 null → 路由回 400 */ }
        return null;
    }

    /** 清单结构校验；返回错误文案或 null */
    static String validate(JsonNode m) {
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

    /** 落盘时用带缩进的 JSON（与 Node 版一致） */
    static String pretty(JsonNode node) {
        try {
            return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(node);
        } catch (Exception e) {
            return node.toString();
        }
    }

    /** 下载响应里的清单（JsonNode → Map） */
    static Map<String, Object> asMap(JsonNode node) {
        return JSON.convertValue(node, Map.class);
    }

    static boolean truthy(Object o) {
        if (o instanceof Boolean b) return b;
        String s = bqbhub.server.Validators.str(o);
        return "1".equals(s) || "true".equalsIgnoreCase(s);
    }
}
