package bqbhub.server.system;

import bqbhub.server.AdminToken;
import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.Limiters;
import bqbhub.server.Scrypt;
import bqbhub.server.Validators;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 管理员面（逐条对应 server/src/routes/system.js 的后半）：口令校验换留档令牌 / 留档写入 / 留档读取与清空。
 * 两种凭证：App 的管理员模式令牌（X-Admin-Token，HMAC，见 AdminToken）与系统版的机器凭据（X-System-Key）。
 * 读取/清空走的是运维口令（x-admin-key，见 support/AdminKeyGuard），由 Controller 守卫。
 */
@Service
public class AdminOpsService {

    static final int TRACE_KEEP = 1000;

    private final AdminOpsRepository repo;
    private final AppConfig cfg;
    private final Limiters limiters;
    private final ObjectMapper json;

    public AdminOpsService(AdminOpsRepository repo, AppConfig cfg, Limiters limiters, ObjectMapper json) {
        this.repo = repo;
        this.cfg = cfg;
        this.limiters = limiters;
        this.json = json;
    }

    // ---------------------------------------------------------------- 管理员口令校验

    public Map<String, Object> adminVerify(Map<String, Object> body, String clientIp) {
        if (!limiters.adminVerify.allow(clientIp)) {
            throw ApiError.of(429, "尝试过于频繁，请稍后再试").put("ok", false);
        }
        if (cfg.adminPasswordHash == null || cfg.adminPasswordHash.isEmpty()) {
            throw ApiError.of(403, "管理员校验未配置").put("ok", false);
        }
        String pw = Validators.str(body.get("password"));
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

    public Map<String, Object> tracePost(Map<String, Object> body, boolean bySystemKey, String adminToken, String clientIp) {
        if (!bySystemKey && (cfg.adminPasswordHash == null || cfg.adminPasswordHash.isEmpty())) {
            throw ApiError.of(403, "管理员校验未配置").put("ok", false);
        }
        if (!bySystemKey && !AdminToken.verify(cfg.adminPasswordHash, adminToken)) {
            throw ApiError.of(401, "令牌无效或已过期").put("ok", false);
        }
        if (!limiters.trace.allow(clientIp)) {
            throw ApiError.of(429, "请求过于频繁").put("ok", false);
        }
        Object recall = body.get("recall");
        String recallJson = (recall instanceof String s) ? s : toJson(recall == null ? List.of() : recall);
        long tsIn = Validators.numLong(body.get("ts"), 0L);   // 毫秒时间戳不能走 int 版
        long ts = tsIn != 0L ? tsIn : System.currentTimeMillis();
        long id = repo.insertTrace(ts, Validators.cut(body.get("book"), 120), Validators.num(body.get("round"), 0),
                Validators.cut(body.get("model"), 80), Validators.num(body.get("windowChars"), 0),
                Validators.num(body.get("budget"), 0), Validators.cut(body.get("instruction"), 2000),
                Validators.cut(body.get("continuation"), 20000), Validators.cut(recallJson, 200000));
        try {
            repo.trimTraces(TRACE_KEEP);
        } catch (Exception e) { /* 裁剪失败不影响写入 */ }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        return out;
    }

    public List<Map<String, Object>> traces(String limitStr, String offsetStr, String book) {
        int lim = Math.min(Validators.num(limitStr, 50), 200);
        int off = Math.max(Validators.num(offsetStr, 0), 0);
        return repo.traces(Validators.str(book), lim, off);
    }

    public Map<String, Object> deleteTraces() {
        int deleted = repo.deleteAll();
        return Map.of("ok", true, "deleted", deleted);
    }

    private String toJson(Object o) {
        try {
            return json.writeValueAsString(o);
        } catch (Exception e) {
            return "[]";
        }
    }
}
