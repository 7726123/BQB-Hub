package bqbhub.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 认证路由（逐条对应 server/src/routes/auth.js）：
 *   验证码 / 注册 / 登录（密码与验证码两种）/ 我是谁 / 退出 / 改昵称。
 * 状态码与中文文案都照抄 —— 契约测试（api / hardening / cover / review / card / feedback ...）
 * 全都通过它们建立会话，改文案前先看测试断言。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    static final long CODE_TTL_MS = 10 * 60 * 1000L;
    static final long CODE_RESEND_MS = 60 * 1000L;
    static final int CODE_DAILY_MAX = 5;

    private final JdbcTemplate jdbc;
    private final AuthService auth;
    private final Limiters limiters;
    private final Mailer mailer;

    public AuthController(JdbcTemplate jdbc, AuthService auth, Limiters limiters, Mailer mailer) {
        this.jdbc = jdbc;
        this.auth = auth;
        this.limiters = limiters;
        this.mailer = mailer;
    }

    // ---------------------------------------------------------------- 发送验证码
    @PostMapping("/send-code")
    public Map<String, Object> sendCode(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        String ip = AuthService.clientIp(req);
        if (!limiters.sendCode.allow(ip)) throw ApiError.of(429, "发送太频繁，请稍后再试");

        Map<String, Object> b = body == null ? Map.of() : body;
        String email = Validators.str(b.get("email")).trim().toLowerCase();
        String typeRaw = Validators.str(b.get("type"));
        String type = ("reset".equals(typeRaw) || "login".equals(typeRaw)) ? typeRaw : "register";
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");

        long now = System.currentTimeMillis();
        if (count("SELECT COUNT(*) FROM verify_codes WHERE email = ? AND created_at > ?", email, now - CODE_RESEND_MS) >= 1) {
            throw ApiError.of(429, "发送太频繁，请 1 分钟后再试");
        }
        if (count("SELECT COUNT(*) FROM verify_codes WHERE email = ? AND created_at > ?", email, now - 86400000L) >= CODE_DAILY_MAX) {
            throw ApiError.of(429, "该邮箱今日发送次数已达上限");
        }
        boolean registered = !jdbc.queryForList("SELECT id FROM users WHERE email = ?", email).isEmpty();
        if ("register".equals(type) && registered) {
            throw ApiError.of(409, "该邮箱已注册，请直接登录或找回密码");
        }
        if (!"register".equals(type) && !registered) {
            throw ApiError.of(404, "该邮箱尚未注册");
        }

        String code = String.valueOf(ThreadLocalRandom.current().nextInt(100000, 1000000));
        jdbc.update("INSERT INTO verify_codes (email, code, type, expires_at, created_at, used) VALUES (?, ?, ?, ?, ?, 0)",
                email, code, type, now + CODE_TTL_MS, now);
        jdbc.update("DELETE FROM verify_codes WHERE expires_at < ?", now - 86400000L); // 顺带清理过期记录

        String purpose = "register".equals(type) ? "注册账号" : ("login".equals(type) ? "验证码登录" : "找回密码");
        try {
            mailer.send(email, "【轻小说社区】" + purpose + "验证码：" + code,
                    "您正在" + purpose + "，验证码：" + code + "\n\n" + (CODE_TTL_MS / 60000) + " 分钟内有效。若非本人操作，请忽略本邮件。");
        } catch (Mailer.NotConfigured e) {
            throw ApiError.of(500, "服务器未配置邮箱（管理员需填写 server/config.json）");
        } catch (RuntimeException e) {
            System.out.println("[auth] 邮件发送失败: " + e.getMessage());
            throw ApiError.of(500, "邮件发送失败，请稍后再试");
        }
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 重置密码
    @PostMapping("/reset-password")
    public Map<String, Object> resetPassword(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String email = Validators.str(b.get("email")).trim().toLowerCase();
        String code = Validators.str(b.get("code")).trim();
        String newPassword = Validators.str(b.get("newPassword"));
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");
        if (!Validators.validCode(code)) throw ApiError.of(400, "验证码应为 6 位数字");
        if (!Validators.validPassword(newPassword)) throw ApiError.of(400, "新密码至少 4 位");

        String ck = "reset:" + email;
        if (!limiters.codeGuess.allow(ck)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> vc = findCode(email, code, "reset");
        if (vc == null) throw ApiError.of(400, "验证码错误或已过期");
        Map<String, Object> user = firstRow("SELECT * FROM users WHERE email = ?", email);
        if (user == null) throw ApiError.of(404, "该邮箱尚未注册");
        limiters.codeGuess.reset(ck);

        String[] hp = Scrypt.hashLogin(newPassword);
        jdbc.update("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?", hp[1], hp[0], num(user.get("id")));
        markCodeUsed(num(vc.get("id")));
        auth.revokeAllForUser(num(user.get("id"))); // 重置密码后强制所有设备重新登录
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 注册
    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String username = Validators.str(b.get("username")).trim();
        String password = Validators.str(b.get("password"));
        String email = Validators.str(b.get("email")).trim().toLowerCase();
        String code = Validators.str(b.get("code")).trim();
        if (!Validators.validUsername(username)) throw ApiError.of(400, "用户名需 2-20 位且只能由中英文/数字/_ 组成");
        if (!Validators.validPassword(password)) throw ApiError.of(400, "密码至少 4 位");
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");
        if (!Validators.validCode(code)) throw ApiError.of(400, "验证码应为 6 位数字");
        if (!limiters.register.allow(AuthService.clientIp(req))) throw ApiError.of(429, "注册过于频繁，请稍后再试");

        String ck = "register:" + email;
        if (!limiters.codeGuess.allow(ck)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> vc = findCode(email, code, "register");
        if (vc == null) throw ApiError.of(400, "验证码错误或已过期");
        limiters.codeGuess.reset(ck);

        String[] hp = Scrypt.hashLogin(password);
        long userId;
        try {
            userId = insertAndReturnId("INSERT INTO users (username, pass_hash, pass_salt, created_at, email) VALUES (?, ?, ?, ?, ?)",
                    username, hp[1], hp[0], System.currentTimeMillis(), email);
        } catch (Exception e) {
            String msg = Validators.str(e.getMessage());
            if (msg.contains("idx_users_email")) throw ApiError.of(409, "该邮箱已注册");
            if (msg.contains("UNIQUE")) throw ApiError.of(409, "用户名已被占用");
            throw e;
        }
        markCodeUsed(num(vc.get("id")));
        Map<String, Object> sess = auth.createSession(userId);

        Map<String, Object> user = new LinkedHashMap<>();
        user.put("id", userId);
        user.put("username", username);
        user.put("email", email);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("token", sess.get("token"));
        out.put("user", user);
        return out;
    }

    // ---------------------------------------------------------------- 登录（密码）
    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String email = Validators.str(b.get("email")).trim().toLowerCase();
        String password = Validators.str(b.get("password"));
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");

        String lk = AuthService.clientIp(req) + "|" + email;
        if (!limiters.login.allow(lk)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> user = firstRow("SELECT * FROM users WHERE email = ?", email);
        if (user == null || !Scrypt.verifyLogin(password,
                Validators.str(user.get("pass_salt")), Validators.str(user.get("pass_hash")))) {
            throw ApiError.of(401, "邮箱或密码错误");
        }
        limiters.login.reset(lk);
        return sessionResponse(user);
    }

    // ---------------------------------------------------------------- 登录（验证码）
    @PostMapping("/login-code")
    public Map<String, Object> loginCode(@RequestBody(required = false) Map<String, Object> body) {
        Map<String, Object> b = body == null ? Map.of() : body;
        String email = Validators.str(b.get("email")).trim().toLowerCase();
        String code = Validators.str(b.get("code")).trim();
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");
        if (!Validators.validCode(code)) throw ApiError.of(400, "验证码应为 6 位数字");

        String ck = "login:" + email;
        if (!limiters.codeGuess.allow(ck)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> vc = findCode(email, code, "login");
        if (vc == null) throw ApiError.of(400, "验证码错误或已过期");
        Map<String, Object> user = firstRow("SELECT * FROM users WHERE email = ?", email);
        if (user == null) throw ApiError.of(404, "该邮箱尚未注册");
        limiters.codeGuess.reset(ck);
        markCodeUsed(num(vc.get("id")));
        return sessionResponse(user);
    }

    // ---------------------------------------------------------------- 我是谁 / 退出 / 改名
    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest req) {
        return Map.of("user", auth.requireUser(req).toJson());
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(HttpServletRequest req) {
        auth.revoke(auth.bearer(req));
        return Map.of("ok", true);
    }

    @PostMapping("/rename")
    public Map<String, Object> rename(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        String nickname = Validators.str((body == null ? Map.of() : body).get("nickname")).trim();
        if (!Validators.validUsername(nickname)) throw ApiError.of(400, "昵称需 2-20 位且只能由中英文/数字/_ 组成");
        if (nickname.equals(me.username)) {
            return Map.of("ok", true, "user", Map.of("id", me.id, "username", nickname));
        }
        try {
            jdbc.update("UPDATE users SET username = ? WHERE id = ?", nickname, me.id);
        } catch (Exception e) {
            if (Validators.str(e.getMessage()).contains("UNIQUE")) throw ApiError.of(409, "该昵称已被占用");
            throw e;
        }
        return Map.of("ok", true, "user", Map.of("id", me.id, "username", nickname));
    }

    // ---------------------------------------------------------------- 内部
    private Map<String, Object> sessionResponse(Map<String, Object> user) {
        Map<String, Object> sess = auth.createSession(num(user.get("id")));
        Map<String, Object> u = new LinkedHashMap<>();
        u.put("id", num(user.get("id")));
        u.put("username", Validators.str(user.get("username")));
        u.put("email", Validators.str(user.get("email")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("token", sess.get("token"));
        out.put("user", u);
        return out;
    }

    private Map<String, Object> findCode(String email, String code, String type) {
        return firstRow("SELECT * FROM verify_codes WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at > ? "
                + "ORDER BY id DESC LIMIT 1", email, code, type, System.currentTimeMillis());
    }

    private void markCodeUsed(long id) {
        jdbc.update("UPDATE verify_codes SET used = 1 WHERE id = ?", id);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long count(String sql, Object... args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
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

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
