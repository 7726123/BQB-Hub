package bqbhub.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 配置中心：环境变量 + 本地 config.json（对应 server/src/config.js）。
 * 环境变量名与 Node 版完全一致（契约），config.json 里 smtp/regionBlock/adminKey/adminPasswordHash
 * 的优先级也与 Node 版一致：文件值覆盖环境变量默认值。
 */
@Component
public class AppConfig {

    /** 目标进程实例信息（health 返回体里带，与 Node 版同款） */
    public static final String APP_NAME = "novel-writer-community";

    public final int port;
    public final Path dataDir;
    public final Path uploadDir;
    public final Path apkDir;
    public final Path appVersionFile;
    public final Path webBundleDir;
    public final Path configFile;
    public final String adminKey;
    public final String adminPasswordHash;
    /** 系统版（内部构建）机器凭据：等价于管理员（对应 Node 版 config.systemKey，见交接文档「系统版」） */
    public final String systemKey;
    /** 可选设备白名单：非空时 systemKey 还必须叠加白名单内的 X-Install-Id 才生效 */
    public final List<String> systemInstallIds;
    public final boolean regionBlock;
    public final int tlsPort;
    public final Path tlsCertFile;
    public final Path tlsKeyFile;
    public final Smtp smtp;

    public static final class Smtp {
        public final String host;
        public final int port;
        public final boolean secure;
        public final String user;
        public final String pass;
        public final String from;

        Smtp(String host, int port, boolean secure, String user, String pass, String from) {
            this.host = host;
            this.port = port;
            this.secure = secure;
            this.user = user;
            this.pass = pass;
            this.from = from;
        }

        public boolean configured() {
            return host != null && !host.isEmpty();
        }
    }

    public AppConfig() {
        this(System.getenv());
    }

    /**
     * 环境变量从传入的 map 读（测试/feature 包用：JUnit 里改不了进程环境，见 AppConfigTest / MediaTest）。
     * Spring 有多个构造器时用**默认（无参）构造器**，所以注解与依赖注入行为不变。
     */
    public AppConfig(Map<String, String> env) {
        Path serverRoot = Paths.get("").toAbsolutePath();
        this.port = intEnv(env, "PORT", 8899);
        this.dataDir = pathEnv(env, "DATA_DIR", serverRoot.resolve("data"));
        this.uploadDir = pathEnv(env, "UPLOAD_DIR", serverRoot.resolve("uploads"));
        this.apkDir = pathEnv(env, "APK_DIR", serverRoot.resolve("apk"));
        this.appVersionFile = pathEnv(env, "APP_VERSION_FILE", serverRoot.resolve("app-version.json"));
        this.webBundleDir = pathEnv(env, "WEB_BUNDLE_DIR", serverRoot.resolve("web-bundles"));
        this.configFile = pathEnv(env, "CONFIG_FILE", serverRoot.resolve("config.json"));
        this.tlsPort = intEnv(env, "TLS_PORT", 80);
        this.tlsCertFile = pathEnv(env, "TLS_CERT_FILE", serverRoot.resolve("certs/server.crt"));
        this.tlsKeyFile = pathEnv(env, "TLS_KEY_FILE", serverRoot.resolve("certs/server.key"));

        String adminKey = env(env, "ADMIN_KEY", "");
        String adminPasswordHash = env(env, "ADMIN_PW_HASH", "");
        String systemKey = env(env, "SYSTEM_KEY", "");
        List<String> systemInstallIds = List.of();
        boolean regionBlock = false;
        Smtp smtp = new Smtp("", 465, true, "", "", "");

        try {
            JsonNode c = new ObjectMapper().readTree(Files.readString(configFile));
            if (c != null) {
                if (c.hasNonNull("regionBlock") && c.get("regionBlock").isBoolean()) {
                    regionBlock = c.get("regionBlock").asBoolean();
                }
                if (c.hasNonNull("adminKey") && c.get("adminKey").isTextual()) {
                    adminKey = c.get("adminKey").asText().trim();
                }
                if (c.hasNonNull("adminPasswordHash") && c.get("adminPasswordHash").isTextual()) {
                    adminPasswordHash = c.get("adminPasswordHash").asText().trim();
                }
                if (c.hasNonNull("systemKey") && c.get("systemKey").isTextual()) {
                    systemKey = c.get("systemKey").asText().trim();
                }
                JsonNode ids = c.get("systemInstallIds");
                if (ids != null && ids.isArray()) {
                    List<String> list = new ArrayList<>();
                    for (JsonNode n : ids) {
                        if (n.isTextual() && !n.asText().trim().isEmpty()) list.add(n.asText().trim());
                    }
                    systemInstallIds = list;
                }
                JsonNode s = c.get("smtp");
                if (s != null && s.isObject()) {
                    smtp = new Smtp(
                            text(s, "host", smtp.host),
                            s.hasNonNull("port") ? s.get("port").asInt(smtp.port) : smtp.port,
                            s.hasNonNull("secure") ? s.get("secure").asBoolean(smtp.secure) : smtp.secure,
                            text(s, "user", smtp.user),
                            text(s, "pass", smtp.pass),
                            text(s, "from", smtp.from));
                }
            }
        } catch (Exception e) {
            // 没有配置文件时使用默认值（与 Node 版一致：静默）
        }

        this.adminKey = adminKey;
        this.adminPasswordHash = adminPasswordHash;
        this.systemKey = systemKey;
        this.systemInstallIds = systemInstallIds;
        this.regionBlock = regionBlock;
        this.smtp = smtp;
    }

    private static String env(Map<String, String> env, String k, String dflt) {
        String v = env.get(k);
        return (v == null || v.isEmpty()) ? dflt : v;
    }

    private static int intEnv(Map<String, String> env, String k, int dflt) {
        String v = env.get(k);
        if (v == null || v.isEmpty()) return dflt;
        try {
            return Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    private static Path pathEnv(Map<String, String> env, String k, Path dflt) {
        String v = env.get(k);
        return (v == null || v.isEmpty()) ? dflt : Paths.get(v);
    }

    private static String text(JsonNode node, String field, String dflt) {
        JsonNode v = node.get(field);
        return (v == null || !v.isTextual()) ? dflt : v.asText();
    }
}
