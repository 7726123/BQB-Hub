package bqbhub.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Pattern;

/**
 * 系统路由（逐条对应 server/src/routes/system.js）：
 * 健康检查 / 版本 / APK 与热更包分发 / 匿名统计上报 / 管理端统计 / 客户端错误上报 /
 * 使用助手漏答 / 管理员口令校验 / 管理员模式留档。
 * 状态码、文案、裁剪上限、限流阈值都照抄 Node 版。
 */
@RestController
public class SystemController {

    static final long ONLINE_MS = 5 * 60 * 1000L;
    static final long CL_KEEP_MS = 90L * 24 * 3600 * 1000;
    static final int TRACE_KEEP = 1000;
    private static final Pattern BUNDLE_NAME = Pattern.compile("^[\\w.\\-]+$");

    private final JdbcTemplate jdbc;
    private final AppConfig cfg;
    private final AuthService auth;
    private final Limiters limiters;
    private final ObjectMapper json;
    private final AtomicInteger clInsertCount = new AtomicInteger();

    public SystemController(JdbcTemplate jdbc, AppConfig cfg, AuthService auth, Limiters limiters, ObjectMapper json) {
        this.jdbc = jdbc;
        this.cfg = cfg;
        this.auth = auth;
        this.limiters = limiters;
        this.json = json;
    }

    // ---------------------------------------------------------------- 健康检查
    @GetMapping({"/", "/api/health"})
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("ok", true);
        m.put("name", AppConfig.APP_NAME);
        m.put("port", cfg.port);
        return m;
    }

    // ---------------------------------------------------------------- App 版本
    @GetMapping("/api/app/version")
    public Map<String, Object> appVersion(HttpServletRequest req) {
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
        String proto = req.isSecure() ? "https" : "http";
        String host = Validators.str(req.getHeader("Host"));
        if (host.isEmpty()) host = "localhost:" + cfg.port;
        String apk = Validators.str(info.path("apk").asText("app.apk"));
        String defaultUrl = proto + "://" + host + "/apk/" + URLEncoder.encode(apk, StandardCharsets.UTF_8).replace("+", "%20");
        out.put("versionCode", info.path("versionCode").asInt(0));
        out.put("versionName", info.path("versionName").asText(""));
        out.put("note", info.path("note").asText(""));
        out.put("apkUrl", info.path("apkUrl").asText(defaultUrl));
        return out;
    }

    // ---------------------------------------------------------------- APK 下载
    @GetMapping("/apk/{file}")
    public ResponseEntity<Resource> apk(@PathVariable String file) {
        if (file.isEmpty() || file.contains("/") || file.contains("\\") || file.contains("..")) {
            throw ApiError.of(400, "invalid file name");
        }
        Path p = cfg.apkDir.resolve(file).normalize();
        if (!p.startsWith(cfg.apkDir) || !Files.isRegularFile(p)) throw ApiError.of(404, "apk not found");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/vnd.android.package-archive")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + file + "\"")
                .body(new FileSystemResource(p));
    }

    // ---------------------------------------------------------------- 网页包热更新
    @GetMapping("/api/app/web-bundle")
    public ResponseEntity<Map<String, Object>> webBundleManifest() {
        Map<String, Object> man = null;
        try {
            man = json.readValue(Files.readString(cfg.webBundleDir.resolve("manifest.json")), Map.class);
        } catch (Exception e) { /* 还没发过热包 */ }
        boolean ok = man != null && man.get("payload") instanceof String && man.get("sig") instanceof String;
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(ok ? man : Map.of());
    }

    @GetMapping("/web-bundle/{file}")
    public ResponseEntity<Resource> webBundleFile(@PathVariable String file) {
        if (file.isEmpty() || file.contains("/") || file.contains("\\") || file.contains("..")
                || !BUNDLE_NAME.matcher(file).matches()) {
            throw ApiError.of(400, "invalid file name");
        }
        Path p = cfg.webBundleDir.resolve(file).normalize();
        if (!p.startsWith(cfg.webBundleDir) || !Files.isRegularFile(p)) throw ApiError.of(404, "bundle not found");
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/zip")
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(new FileSystemResource(p));
    }

    // ---------------------------------------------------------------- 匿名使用统计
    @PostMapping("/api/app/ping")
    public Map<String, Object> ping(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String id = Validators.str(b.get("id")).trim();
        if (!Validators.validInstallId(id)) throw ApiError.of(400, "bad install id");
        if (!limiters.ping.allow(AuthService.clientIp(req))) throw ApiError.of(429, "rate limited");
        long now = System.currentTimeMillis();
        String day = DayKey.day(now);
        try {
            // 版本字段每次都覆盖（空值 = 跑内置网页包，也要如实记下来）
            jdbc.update("INSERT INTO devices (install_id, first_ts, last_ts, first_day, last_day, app_version, web_version, platform) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                            + "ON CONFLICT(install_id) DO UPDATE SET last_ts = excluded.last_ts, last_day = excluded.last_day, "
                            + "app_version = excluded.app_version, web_version = excluded.web_version, platform = excluded.platform",
                    id, now, now, day, day,
                    Validators.cut(b.get("v"), 40), Validators.cut(b.get("w"), 40), Validators.cut(b.get("plat"), 20));
            jdbc.update("INSERT OR IGNORE INTO device_days (install_id, day) VALUES (?, ?)", id, day);
        } catch (Exception e) {
            throw ApiError.of(500, "store fail");
        }
        return Map.of("ok", true);
    }

    @GetMapping("/api/admin/stats")
    public Map<String, Object> stats(HttpServletRequest req) {
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
        long now = System.currentTimeMillis();
        String today = DayKey.today();
        long feedbackUnread = 0;
        try {
            feedbackUnread = one("SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL");
        } catch (Exception e) { /* 表不存在也照常返回统计 */ }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("feedbackUnread", feedbackUnread);
        m.put("online", one("SELECT COUNT(*) c FROM devices WHERE last_ts >= ?", now - ONLINE_MS));
        m.put("today", one("SELECT COUNT(*) c FROM device_days WHERE day = ?", today));
        m.put("week", one("SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?", DayKey.daysAgo(6)));
        m.put("month", one("SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?", DayKey.daysAgo(29)));
        m.put("total", one("SELECT COUNT(*) c FROM devices"));
        m.put("newToday", one("SELECT COUNT(*) c FROM devices WHERE first_day = ?", today));
        m.put("versions", jdbc.queryForList("SELECT app_version v, COUNT(*) c FROM devices GROUP BY app_version ORDER BY c DESC LIMIT 8"));
        m.put("webs", jdbc.queryForList("SELECT web_version w, COUNT(*) c FROM devices GROUP BY web_version ORDER BY c DESC LIMIT 8"));
        m.put("day", today);
        m.put("onlineWindowMs", ONLINE_MS);
        return m;
    }

    // ---------------------------------------------------------------- 使用助手漏答
    @PostMapping("/api/usage-assistant/miss")
    public Map<String, Object> assistantMiss(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        if (!limiters.miss.allow(AuthService.clientIp(req))) throw ApiError.of(429, "rate limited");
        Map<String, Object> b = body == null ? Map.of() : body;
        List<Map<String, Object>> conv = new ArrayList<>();
        Object raw = b.get("conversation");
        if (raw instanceof List<?> list) {
            for (Object o : list.subList(0, Math.min(list.size(), 8))) {
                Map<String, Object> m = o instanceof Map<?, ?> mm ? castMap(mm) : Map.of();
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("role", "user".equals(Validators.str(m.get("role"))) ? "user" : "assistant");
                item.put("content", Validators.cut(m.get("content"), 500));
                conv.add(item);
            }
        }
        if (conv.isEmpty()) throw ApiError.of(400, "empty");
        String ipHash = sha256Hex(AuthService.clientIp(req)).substring(0, 12);
        try {
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("ts", java.time.Instant.now().toString());
            line.put("ipHash", ipHash);
            line.put("conversation", conv);
            Path f = cfg.dataDir.resolve("assistant-misses.jsonl");
            Files.writeString(f, json.writeValueAsString(line) + "\n", StandardCharsets.UTF_8,
                    Files.exists(f) ? java.nio.file.StandardOpenOption.APPEND : java.nio.file.StandardOpenOption.CREATE);
        } catch (IOException e) {
            throw ApiError.of(500, "store fail");
        }
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 客户端错误上报
    @PostMapping("/api/client-logs")
    public Map<String, Object> clientLogsPost(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        Map<String, Object> b = body == null ? Map.of() : body;
        List<Map<String, Object>> items = new ArrayList<>();
        Object raw = b.get("logs");
        if (raw instanceof List<?> list) {
            for (Object o : list.subList(0, Math.min(list.size(), 8))) {
                Map<String, Object> l = o instanceof Map<?, ?> mm ? castMap(mm) : Map.of();
                Map<String, Object> it = new LinkedHashMap<>();
                it.put("ts", Validators.num(l.get("t"), 0) != 0 ? Validators.num(l.get("t"), 0) : System.currentTimeMillis());
                it.put("v", Validators.cut(l.get("v"), 40));
                it.put("plat", Validators.cut(l.get("plat"), 20));
                it.put("kind", Validators.cut(l.get("k"), 60));
                it.put("msg", Validators.cut(l.get("m"), 400));
                it.put("w", Validators.cut(l.get("w"), 40));
                if (!Validators.str(it.get("kind")).isEmpty() && !Validators.str(it.get("msg")).isEmpty()) items.add(it);
            }
        }
        if (items.isEmpty()) throw ApiError.of(400, "empty");
        if (!limiters.clientLogs.allow(AuthService.clientIp(req))) throw ApiError.of(429, "rate limited");
        String ua = Validators.cut(req.getHeader("User-Agent"), 200);
        for (Map<String, Object> it : items) {
            jdbc.update("INSERT INTO client_logs (ts, app_version, platform, kind, msg, ua, web) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    it.get("ts"), it.get("v"), it.get("plat"), it.get("kind"), it.get("msg"), ua, it.get("w"));
        }
        if (clInsertCount.incrementAndGet() % 200 == 0) {
            try {
                jdbc.update("DELETE FROM client_logs WHERE ts < ?", System.currentTimeMillis() - CL_KEEP_MS);
            } catch (Exception e) { /* 裁剪失败不影响写入 */ }
        }
        return Map.of("ok", true, "stored", items.size());
    }

    @GetMapping("/api/client-logs")
    public Map<String, Object> clientLogsGet(@RequestParam(required = false) String limit, HttpServletRequest req) {
        requireAdminKey(req);
        int lim = Math.min(Validators.num(limit, 100), 500);
        return Map.of("logs", jdbc.queryForList(
                "SELECT ts, app_version, platform, kind, msg, ua, web FROM client_logs ORDER BY ts DESC LIMIT ?", lim));
    }

    // ---------------------------------------------------------------- 管理员口令校验
    @PostMapping("/api/admin/verify")
    public Map<String, Object> adminVerify(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        if (!limiters.adminVerify.allow(AuthService.clientIp(req))) {
            throw ApiError.of(429, "尝试过于频繁，请稍后再试").put("ok", false);
        }
        if (cfg.adminPasswordHash == null || cfg.adminPasswordHash.isEmpty()) {
            throw ApiError.of(403, "管理员校验未配置").put("ok", false);
        }
        String pw = Validators.str((body == null ? Map.of() : body).get("password"));
        if (pw.isEmpty() || pw.length() > 128 || !Scrypt.verifyAdmin(pw, cfg.adminPasswordHash)) {
            throw ApiError.of(401, "口令错误").put("ok", false);
        }
        long exp = AdminToken.expFor(AdminToken.TTL_MS);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("token", AdminToken.issueForExp(cfg.adminPasswordHash, exp));
        out.put("exp", exp);
        return out;
    }

    // ---------------------------------------------------------------- 管理员留档
    @PostMapping("/api/admin/trace")
    public Map<String, Object> tracePost(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        if (cfg.adminPasswordHash == null || cfg.adminPasswordHash.isEmpty()) {
            throw ApiError.of(403, "管理员校验未配置").put("ok", false);
        }
        if (!AdminToken.verify(cfg.adminPasswordHash, auth.adminToken(req))) {
            throw ApiError.of(401, "令牌无效或已过期").put("ok", false);
        }
        if (!limiters.trace.allow(AuthService.clientIp(req))) {
            throw ApiError.of(429, "请求过于频繁").put("ok", false);
        }
        Map<String, Object> b = body == null ? Map.of() : body;
        Object recall = b.get("recall");
        String recallJson = (recall instanceof String s) ? s : toJson(recall == null ? List.of() : recall);
        long ts = Validators.num(b.get("ts"), 0) != 0 ? Validators.num(b.get("ts"), 0) : System.currentTimeMillis();
        var keyHolder = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement("INSERT INTO admin_traces (ts, book, round, model, window_chars, budget, instruction, continuation, recall_json) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", java.sql.Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, ts);
            ps.setString(2, Validators.cut(b.get("book"), 120));
            ps.setInt(3, Validators.num(b.get("round"), 0));
            ps.setString(4, Validators.cut(b.get("model"), 80));
            ps.setInt(5, Validators.num(b.get("windowChars"), 0));
            ps.setInt(6, Validators.num(b.get("budget"), 0));
            ps.setString(7, Validators.cut(b.get("instruction"), 2000));
            ps.setString(8, Validators.cut(b.get("continuation"), 20000));
            ps.setString(9, Validators.cut(recallJson, 200000));
            return ps;
        }, keyHolder);
        Number id = keyHolder.getKey();
        try {
            jdbc.update("DELETE FROM admin_traces WHERE id <= (SELECT MAX(id) - ? FROM admin_traces)", TRACE_KEEP);
        } catch (Exception e) { /* 裁剪失败不影响写入 */ }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id == null ? 0 : id.longValue());
        return out;
    }

    @GetMapping("/api/admin/traces")
    public ResponseEntity<?> tracesGet(@RequestParam(required = false) String limit,
                                       @RequestParam(required = false) String offset,
                                       @RequestParam(required = false) String book,
                                       @RequestParam(required = false) String format,
                                       HttpServletRequest req) {
        requireAdminKey(req);
        int lim = Math.min(Validators.num(limit, 50), 200);
        int off = Math.max(Validators.num(offset, 0), 0);
        String bk = Validators.str(book);
        List<Map<String, Object>> rows = bk.isEmpty()
                ? jdbc.queryForList("SELECT * FROM admin_traces ORDER BY ts DESC LIMIT ? OFFSET ?", lim, off)
                : jdbc.queryForList("SELECT * FROM admin_traces WHERE book = ? ORDER BY ts DESC LIMIT ? OFFSET ?", bk, lim, off);
        if ("html".equals(Validators.str(format))) {
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(tracesHtml(rows));
        }
        return ResponseEntity.ok(Map.of("traces", rows));
    }

    @DeleteMapping("/api/admin/traces")
    public Map<String, Object> tracesDelete(HttpServletRequest req) {
        requireAdminKey(req);
        int deleted = jdbc.update("DELETE FROM admin_traces");
        return Map.of("ok", true, "deleted", deleted);
    }

    // ---------------------------------------------------------------- 内部
    private void requireAdminKey(HttpServletRequest req) {
        String key = Validators.str(req.getHeader("x-admin-key"));
        String want = Validators.str(cfg.adminKey);
        boolean ok = !want.isEmpty() && MessageDigest.isEqual(
                key.getBytes(StandardCharsets.UTF_8), want.getBytes(StandardCharsets.UTF_8));
        if (!ok) throw ApiError.of(403, "forbidden");
    }

    private long one(String sql, Object... args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }

    private String toJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (Exception e) {
            return "[]";
        }
    }

    private static String sha256Hex(String s) {
        try {
            return Scrypt.hex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return Scrypt.hex(new byte[32]);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }

    private String tracesHtml(List<Map<String, Object>> rows) {
        StringBuilder sb = new StringBuilder();
        sb.append("<!doctype html><meta charset=\"utf-8\"><title>管理员模式留档</title>")
                .append("<body style=\"font-family:-apple-system,Microsoft YaHei,sans-serif;max-width:920px;margin:20px auto;padding:0 14px\">")
                .append("<h2>管理员模式留档（最近 ").append(rows.size()).append(" 条）</h2>")
                .append("<p style=\"color:#666;font-size:13px\">读取/清空需 adminKey；写入由 App 在管理员模式下自动完成。")
                .append("加 <code>&amp;format=json</code> 可取原始 JSON。</p>");
        for (Map<String, Object> r : rows) {
            StringBuilder pieces = new StringBuilder();
            int recallCount = 0;
            long recallChars = 0;
            Object candidates = null;
            try {
                JsonNode recall = json.readTree(Validators.str(r.get("recall_json")));
                JsonNode arr = recall.path("pieces");
                recallCount = arr.isArray() ? arr.size() : 0;
                recallChars = recall.path("chars").asLong(0);
                candidates = recall.hasNonNull("candidates") ? recall.get("candidates").asLong() : null;
                int i = 0;
                for (JsonNode p : arr) {
                    i++;
                    pieces.append("<li><b>[").append(i).append("]</b> ")
                            .append(escapeHtml(Validators.cut(p.path("head").asText(""), 120)))
                            .append(" … <span style=\"color:#888\">(").append(p.path("chars").asLong(0)).append(" 字")
                            .append(p.path("src").asText("").isEmpty() ? "" : "｜" + escapeHtml(p.path("src").asText("")))
                            .append(")</span></li>");
                }
            } catch (Exception e) { /* recall 解析失败就按空处理 */ }
            sb.append("<section style=\"border:1px solid #ddd;border-radius:8px;padding:10px 14px;margin:12px 0\">")
                    .append("<div style=\"color:#666;font-size:13px\">#").append(r.get("id")).append(" · ")
                    .append(new java.util.Date(((Number) r.get("ts")).longValue()).toString())
                    .append(" · 书：").append(escapeHtml(Validators.str(r.get("book"))))
                    .append(" · 第 ").append(r.get("round")).append(" 轮 · 模型 ").append(escapeHtml(Validators.str(r.get("model"))))
                    .append(" · 窗口 ").append(r.get("window_chars")).append(" 字 · 回读预算 ").append(r.get("budget")).append(" 字</div>")
                    .append("<div style=\"margin:6px 0\"><b>指令：</b>")
                    .append(escapeHtml(Validators.str(r.get("instruction"))).isEmpty() ? "<i>（无）</i>" : escapeHtml(Validators.str(r.get("instruction"))))
                    .append("</div>")
                    .append("<div style=\"margin:6px 0\"><b>记忆召回（").append(recallCount).append(" 段 / ").append(recallChars).append(" 字")
                    .append(candidates == null ? "" : "，候选 " + candidates).append("）：</b><ul style=\"margin:4px 0 4px 18px;padding:0\">")
                    .append(pieces.length() == 0 ? "<li><i>无</i></li>" : pieces).append("</ul></div>")
                    .append("<details><summary style=\"cursor:pointer\"><b>续写正文</b></summary><pre style=\"white-space:pre-wrap;font-family:inherit\">")
                    .append(escapeHtml(Validators.str(r.get("continuation")))).append("</pre></details></section>");
        }
        if (rows.isEmpty()) sb.append("<p><i>暂无数据</i></p>");
        return sb.append("</body>").toString();
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (char c : s.toCharArray()) {
            switch (c) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }
}
