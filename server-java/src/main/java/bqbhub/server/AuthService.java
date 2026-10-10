package bqbhub.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 会话与鉴权（对应 server/src/auth.js 的会话部分 + 各路由的 requireAuth / isAdminReq）。
 * 会话令牌是不透明随机串、存在 sessions 表里 —— 与 Node 版同构，
 * 所以灰度切换时老会话天然继续有效（换 Java 不用让用户重登）。
 */
@Component
public class AuthService {

    public static final long TOKEN_TTL_MS = 30L * 24 * 3600 * 1000; // 30 天，满足「本机免登录」
    private static final SecureRandom RND = new SecureRandom();

    private final JdbcTemplate jdbc;
    private final AppConfig cfg;

    public AuthService(JdbcTemplate jdbc, AppConfig cfg) {
        this.jdbc = jdbc;
        this.cfg = cfg;
    }

    /** 会话用户（字段与 Node 版 req.user 一致：id / username / email） */
    public static final class User {
        public final long id;
        public final String username;
        public final String email;

        User(long id, String username, String email) {
            this.id = id;
            this.username = username;
            this.email = email;
        }

        public Map<String, Object> toJson() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("username", username);
            m.put("email", email);
            return m;
        }
    }

    public String bearer(HttpServletRequest req) {
        String h = Validators.str(req.getHeader("Authorization"));
        if (h.startsWith("Bearer ")) return h.substring(7).trim();
        return "";
    }

    public User userByToken(String token) {
        if (token == null || token.isEmpty()) return null;
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT s.token, u.id, u.username, u.email, s.expires_at FROM sessions s "
                        + "JOIN users u ON u.id = s.user_id WHERE s.token = ?", token);
        if (rows.isEmpty()) return null;
        Map<String, Object> r = rows.get(0);
        long exp = ((Number) r.get("expires_at")).longValue();
        if (exp < System.currentTimeMillis()) {
            jdbc.update("DELETE FROM sessions WHERE token = ?", token);
            return null;
        }
        return new User(((Number) r.get("id")).longValue(),
                Validators.str(r.get("username")), Validators.str(r.get("email")));
    }

    /** 对应 requireAuth 中间件：失败 401 {"error":"未登录或登录已过期"} */
    public User requireUser(HttpServletRequest req) {
        User u = userByToken(bearer(req));
        if (u == null) throw ApiError.of(401, "未登录或登录已过期");
        return u;
    }

    public Map<String, Object> createSession(long userId) {
        String token = randomHex(32);
        long exp = System.currentTimeMillis() + TOKEN_TTL_MS;
        jdbc.update("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)", token, userId, exp);
        jdbc.update("DELETE FROM sessions WHERE expires_at < ?", System.currentTimeMillis()); // 顺带清理过期会话
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("token", token);
        m.put("expiresAt", exp);
        return m;
    }

    public void revoke(String token) {
        if (token != null && !token.isEmpty()) jdbc.update("DELETE FROM sessions WHERE token = ?", token);
    }

    public void revokeAllForUser(long userId) {
        jdbc.update("DELETE FROM sessions WHERE user_id = ?", userId);
    }

    /** 对应 isAdminReq：需要 X-Admin-Token（由 /api/admin/verify 签发的无状态 HMAC） */
    public boolean isAdmin(HttpServletRequest req) {
        if (cfg.adminPasswordHash == null || cfg.adminPasswordHash.isEmpty()) return false;
        String tk = Validators.str(req.getHeader("X-Admin-Token")).trim();
        if (tk.isEmpty()) return false;
        return AdminToken.verify(cfg.adminPasswordHash, tk);
    }

    /** 管理端写接口取令牌：Bearer 优先，其次 X-Admin-Token（与 system.js 的 trace 写法一致） */
    public String adminToken(HttpServletRequest req) {
        String h = Validators.str(req.getHeader("Authorization"));
        if (h.startsWith("Bearer ")) return h.substring(7);
        return Validators.str(req.getHeader("X-Admin-Token"));
    }

    /** 客户端 IP（对应 Node 的 req.socket.remoteAddress） */
    public static String clientIp(HttpServletRequest req) {
        String ip = req.getRemoteAddr();
        return (ip == null || ip.isEmpty()) ? "unknown" : ip;
    }

    public static String randomHex(int bytes) {
        byte[] b = new byte[bytes];
        RND.nextBytes(b);
        return Scrypt.hex(b);
    }
}
