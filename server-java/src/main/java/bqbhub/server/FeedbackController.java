package bqbhub.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 意见反馈（逐条对应 server/src/routes/feedback.js）：
 *   提交（公开，设备 2 条/分钟 + 三条兜底 + 10 分钟去重 + 1000 条裁剪）
 *   管理端列表 / 标记已读 / 删除。
 * 隐私口径同 Node 版：只存内容 + 随机安装标识 + 版本/平台，**原始 IP 只在内存限流里用，不入库**。
 */
@RestController
public class FeedbackController {

    static final int MAX_LEN = 300;
    static final int MAX_ITEMS = 1000;
    static final long DEDUPE_MS = 10 * 60 * 1000L;
    static final int DEVICE_DAILY_MAX = 20;
    static final int GLOBAL_HOURLY_MAX = 200;
    static final int LIST_MAX = 200;

    private final JdbcTemplate jdbc;
    private final AuthService auth;
    private final Limiters limiters;
    private final TransactionTemplate tx;

    public FeedbackController(JdbcTemplate jdbc, AuthService auth, Limiters limiters, org.springframework.transaction.PlatformTransactionManager txm) {
        this.jdbc = jdbc;
        this.auth = auth;
        this.limiters = limiters;
        this.tx = new TransactionTemplate(txm);
    }

    // ---------------------------------------------------------------- 提交（公开）
    @PostMapping("/api/feedback")
    public Map<String, Object> submit(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String text = Validators.str(b.get("text")).replace("\r\n", "\n").replace("\r", "\n").trim();
        if (text.isEmpty()) throw ApiError.of(400, "内容不能为空");
        if (Validators.cpLen(text) > MAX_LEN) throw ApiError.of(400, "内容超过 " + MAX_LEN + " 字");
        String installId = Validators.str(b.get("id")).trim();
        if (!Validators.validInstallId(installId)) throw ApiError.of(400, "bad install id");

        long now = System.currentTimeMillis();
        // 用户可见的那条规则放最前面：每分钟 2 条
        if (!limiters.fbDevice.allow("d" + installId)) throw ApiError.of(429, "提得太频繁了，请过一分钟再试");
        if (!limiters.fbIp.allow("ip" + AuthService.clientIp(req))) throw ApiError.of(429, "提交过于频繁，请稍后再试");
        if (count("SELECT COUNT(*) c FROM feedback WHERE install_id = ? AND created_at > ?", installId, now - 86400000L) >= DEVICE_DAILY_MAX) {
            throw ApiError.of(429, "今天提交得有点多，明天再来吧");
        }
        if (count("SELECT COUNT(*) c FROM feedback WHERE created_at > ?", now - 3600000L) >= GLOBAL_HOURLY_MAX) {
            throw ApiError.of(429, "服务器正忙，请稍后再试");
        }
        // 同设备 10 分钟内重复内容：不重复入库，但仍答「收到」
        if (!jdbc.queryForList("SELECT id FROM feedback WHERE install_id = ? AND text = ? AND created_at > ? LIMIT 1",
                installId, text, now - DEDUPE_MS).isEmpty()) {
            return Map.of("ok", true, "deduped", true);
        }
        try {
            tx.executeWithoutResult(status -> insertAndTrim(text, installId,
                    Validators.cut(b.get("v"), 40), Validators.cut(b.get("plat"), 20), now));
        } catch (Exception e) {
            System.out.println("[feedback] 写入失败: " + e.getMessage());
            throw ApiError.of(500, "store fail");
        }
        return Map.of("ok", true);
    }

    /**
     * 插入 + 裁剪放同一事务（对应 feedback.js 的 insertAndTrim）。
     * 裁剪口径：超 1000 条时**优先删最旧的已查看**，仍未达标才动未查看；裁掉几号就记进 feedback_meta。
     */
    private void insertAndTrim(String text, String installId, String version, String platform, long now) {
        jdbc.update("INSERT INTO feedback (text, install_id, version, platform, created_at) VALUES (?, ?, ?, ?, ?)",
                text, installId, version, platform, now);
        int over = (int) count("SELECT COUNT(*) c FROM feedback") - MAX_ITEMS;
        int trimmed = 0;
        if (over > 0) {
            trimmed += jdbc.update("DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE read_at IS NOT NULL ORDER BY created_at ASC LIMIT ?)", over);
            over = (int) count("SELECT COUNT(*) c FROM feedback") - MAX_ITEMS;
            if (over > 0) {
                trimmed += jdbc.update("DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE read_at IS NULL ORDER BY created_at ASC LIMIT ?)", over);
            }
            if (trimmed > 0) {
                jdbc.update("INSERT INTO feedback_meta (k, v) VALUES ('trimmed', ?) ON CONFLICT(k) DO UPDATE SET v = v + ?", trimmed, trimmed);
            }
        }
    }

    // ---------------------------------------------------------------- 管理端
    @GetMapping("/api/admin/feedback")
    public Map<String, Object> adminList(@RequestParam(required = false) String status,
                                         @RequestParam(required = false) String limit,
                                         HttpServletRequest req) {
        adminGuard(req);
        String st = Validators.trim(Validators.str(status));
        if (st.isEmpty()) st = "unread";
        if (!List.of("unread", "read", "all").contains(st)) throw ApiError.of(400, "未知的状态");
        int lim = Validators.num(limit, 50);
        if (lim < 1) lim = 50;
        if (lim > LIST_MAX) lim = LIST_MAX;
        String where = "unread".equals(st) ? " WHERE read_at IS NULL" : ("read".equals(st) ? " WHERE read_at IS NOT NULL" : "");
        try {
            List<Map<String, Object>> items = jdbc.queryForList(
                    "SELECT id, text, version, platform, created_at, read_at FROM feedback" + where
                            + " ORDER BY created_at DESC LIMIT ?", lim);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("items", items);
            out.put("unread", count("SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL"));
            out.put("read", count("SELECT COUNT(*) c FROM feedback WHERE read_at IS NOT NULL"));
            out.put("total", count("SELECT COUNT(*) c FROM feedback"));
            List<Map<String, Object>> tr = jdbc.queryForList("SELECT v FROM feedback_meta WHERE k = 'trimmed'");
            out.put("trimmed", tr.isEmpty() ? 0 : ((Number) tr.get(0).get("v")).longValue());
            return out;
        } catch (Exception e) {
            System.out.println("[feedback] 读取失败: " + e.getMessage());
            throw ApiError.of(500, "read fail");
        }
    }

    @PostMapping("/api/admin/feedback/read")
    public Map<String, Object> adminRead(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        adminGuard(req);
        Map<String, Object> b = body == null ? Map.of() : body;
        long now = System.currentTimeMillis();
        try {
            if (Boolean.TRUE.equals(b.get("all"))) {
                int n = jdbc.update("UPDATE feedback SET read_at = ? WHERE read_at IS NULL", now);
                return Map.of("ok", true, "changed", n);
            }
            List<Long> ids = parseIds(b.get("ids"));
            if (ids.isEmpty()) throw ApiError.of(400, "没有要标记的条目");
            int changed = 0;
            for (Long id : ids) changed += jdbc.update("UPDATE feedback SET read_at = ? WHERE id = ? AND read_at IS NULL", now, id);
            return Map.of("ok", true, "changed", changed);
        } catch (ApiError e) {
            throw e;
        } catch (Exception e) {
            throw ApiError.of(500, "mark fail");
        }
    }

    @PostMapping("/api/admin/feedback/delete")
    public Map<String, Object> adminDelete(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        adminGuard(req);
        Map<String, Object> b = body == null ? Map.of() : body;
        List<Long> ids = parseIds(b.get("ids") != null ? b.get("ids") : b.get("id"));
        if (ids.isEmpty()) throw ApiError.of(400, "没有要删除的条目");
        try {
            int changed = 0;
            for (Long id : ids) changed += jdbc.update("DELETE FROM feedback WHERE id = ?", id);
            return Map.of("ok", true, "changed", changed);
        } catch (Exception e) {
            throw ApiError.of(500, "delete fail");
        }
    }

    // ---------------------------------------------------------------- 内部
    /** 管理端统一限流（审核队列 120/分钟/IP + 反馈管理 120/分钟/IP）+ 管理员令牌，顺序与 Node 版一致 */
    private void adminGuard(HttpServletRequest req) {
        String ip = AuthService.clientIp(req);
        if (!limiters.review.allow("ip" + ip) || !limiters.fbAdmin.allow("ip" + ip)) {
            throw ApiError.of(429, "请求过于频繁，请稍后再试");
        }
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
    }

    private List<Long> parseIds(Object raw) {
        List<Long> ids = new ArrayList<>();
        List<?> list;
        if (raw instanceof List<?> l) list = l;
        else if (raw == null) list = List.of();
        else list = List.of(raw);
        for (Object o : list) {
            long v = Validators.num(o, 0);
            if (v > 0) ids.add(v);
            if (ids.size() >= LIST_MAX) break;
        }
        return ids;
    }

    private long count(String sql, Object... args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }
}
