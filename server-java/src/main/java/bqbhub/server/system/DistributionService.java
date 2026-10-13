package bqbhub.server.system;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.Validators;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 分发面（逐条对应 server/src/routes/system.js 的前半）：健康检查 / 版本 / APK / 网页包热更新。
 * 全部只读文件与配置，不碰数据库。响应头由 {@link DistributionController} 拼。
 */
@Service
public class DistributionService {

    private static final Pattern BUNDLE_NAME = Pattern.compile("^[\\w.\\-]+$");

    private final AppConfig cfg;
    private final ObjectMapper json;

    public DistributionService(AppConfig cfg, ObjectMapper json) {
        this.cfg = cfg;
        this.json = json;
    }

    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("name", AppConfig.APP_NAME);
        m.put("port", cfg.port);
        return m;
    }

    public Map<String, Object> appVersion(boolean secure, String hostHeader) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode info = null;
        try {
            JsonNode v = json.readTree(Files.readString(cfg.appVersionFile));
            if (v != null && v.hasNonNull("versionCode") && v.get("versionCode").asInt(0) != 0) info = v;
        } catch (Exception e) { /* 没有配置则返回空版本，App 端不提示 */ }
        if (info == null) {
            out.put("versionCode", 0);
            out.put("versionName", "");
            out.put("note", "");
            out.put("apkUrl", "");
            return out;
        }
        // 协议感知：HTTPS 请求返回 https 下载地址，旧客户端走 HTTP 时保持 http
        String proto = secure ? "https" : "http";
        String host = Validators.str(hostHeader);
        if (host.isEmpty()) host = "localhost:" + cfg.port;
        String apk = Validators.str(info.path("apk").asText("app.apk"));
        String defaultUrl = proto + "://" + host + "/apk/" + URLEncoder.encode(apk, StandardCharsets.UTF_8).replace("+", "%20");
        out.put("versionCode", info.path("versionCode").asInt(0));
        out.put("versionName", info.path("versionName").asText(""));
        out.put("note", info.path("note").asText(""));
        out.put("apkUrl", info.path("apkUrl").asText(defaultUrl));
        return out;
    }

    /** APK 文件（路径安全：目录内、真实文件） */
    public Path apkPath(String file) {
        if (file.isEmpty() || file.contains("/") || file.contains("\\") || file.contains("..")) {
            throw ApiError.of(400, "invalid file name");
        }
        Path p = cfg.apkDir.resolve(file).normalize();
        if (!p.startsWith(cfg.apkDir) || !Files.isRegularFile(p)) throw ApiError.of(404, "apk not found");
        return p;
    }

    /**
     * 网页包清单：channel=beta（系统版内测渠道）只对系统版开放——X-System-Key（叠加 X-Install-Id 白名单）命中
     * 才读 manifest-beta.json；其余一律读正式 manifest.json。beta 缺失/损坏时同样回落正式，
     * 所以「还没发过 beta」不会让系统版收不到包（对应 Node 版 routes/system.js 的同名逻辑）。
     */
    public Map<String, Object> webBundleManifest(String channel, boolean isSystem) {
        Map<String, Object> man = null;
        if ("beta".equals(Validators.trim(Validators.str(channel))) && isSystem) {
            man = readManifest("manifest-beta.json");
        }
        if (man == null) man = readManifest("manifest.json");
        if (man == null) man = Map.of();
        return man;
    }

    /** 网页包 zip（路径安全：名字白名单 + 目录内、真实文件） */
    public Path webBundleFile(String file) {
        if (file.isEmpty() || file.contains("/") || file.contains("\\") || file.contains("..")
                || !BUNDLE_NAME.matcher(file).matches()) {
            throw ApiError.of(400, "invalid file name");
        }
        Path p = cfg.webBundleDir.resolve(file).normalize();
        if (!p.startsWith(cfg.webBundleDir) || !Files.isRegularFile(p)) throw ApiError.of(404, "bundle not found");
        return p;
    }

    private Map<String, Object> readManifest(String name) {
        try {
            Map<String, Object> m = json.readValue(Files.readString(cfg.webBundleDir.resolve(name)), Map.class);
            return (m != null && m.get("payload") instanceof String && m.get("sig") instanceof String) ? m : null;
        } catch (Exception e) { return null; }
    }
}
