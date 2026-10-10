package bqbhub.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Component;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

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
        Path serverRoot = Paths.get("").toAbsolutePath();
        this.port = intEnv("PORT", 8899);
        this.dataDir = pathEnv("DATA_DIR", serverRoot.resolve("data"));
        this.uploadDir = pathEnv("UPLOAD_DIR", serverRoot.resolve("uploads"));
        this.apkDir = pathEnv("APK_DIR", serverRoot.resolve("apk"));
        this.appVersionFile = pathEnv("APP_VERSION_FILE", serverRoot.resolve("app-version.json"));
        this.webBundleDir = pathEnv("WEB_BUNDLE_DIR", serverRoot.resolve("web-bundles"));
        this.configFile = pathEnv("CONFIG_FILE", serverRoot.resolve("config.json"));
        this.tlsPort = intEnv("TLS_PORT", 80);
        this.tlsCertFile = pathEnv("TLS_CERT_FILE", serverRoot.resolve("certs/server.crt"));
        this.tlsKeyFile = pathEnv("TLS_KEY_FILE", serverRoot.resolve("certs/server.key"));

        String adminKey = env("ADMIN_KEY", "");
        String adminPasswordHash = env("ADMIN_PW_HASH", "");
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
        this.regionBlock = regionBlock;
        this.smtp = smtp;
    }

    private static String env(String k, String dflt) {
        String v = System.getenv(k);
        return (v == null || v.isEmpty()) ? dflt : v;
    }

    private static int intEnv(String k, int dflt) {
        try {
            String v = System.getenv(k);
            return (v == null || v.isEmpty()) ? dflt : Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    private static Path pathEnv(String k, Path dflt) {
        String v = System.getenv(k);
        return (v == null || v.isEmpty()) ? dflt : Paths.get(v);
    }

    private static String text(JsonNode node, String field, String dflt) {
        JsonNode v = node.get(field);
        return (v == null || !v.isTextual()) ? dflt : v.asText();
    }
}
