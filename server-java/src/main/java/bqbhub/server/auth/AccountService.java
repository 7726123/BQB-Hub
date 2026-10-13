package bqbhub.server.auth;

import bqbhub.server.ApiError;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Mailer;
import bqbhub.server.Scrypt;
import bqbhub.server.Validators;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;

/**
 * 账号流程（逐条对应 server/src/routes/auth.js）：
 *   验证码 / 注册 / 登录（密码与验证码两种）/ 退出 / 改昵称。
 * 状态码与中文文案都照抄 —— 契约测试（api / hardening / cover / review / card / feedback ...）
 * 全都通过它们建立会话，改文案前先看测试断言。
 *
 * 命名说明：根包的 {@link AuthService} 是**会话原语**（token/管理员/系统版判定），所有领域共用；
 * 本类只管 /api/auth 这组账号流程。SQL 在 {@link AccountRepository}，HTTP 在 {@link AuthController}。
 */
@Service
public class AccountService {

    static final long CODE_TTL_MS = 10 * 60 * 1000L;
    static final long CODE_RESEND_MS = 60 * 1000L;
    static final int CODE_DAILY_MAX = 5;

    private final AccountRepository repo;
    private final AuthService auth;
    private final Limiters limiters;
    private final Mailer mailer;

    public AccountService(AccountRepository repo, AuthService auth, Limiters limiters, Mailer mailer) {
        this.repo = repo;
        this.auth = auth;
        this.limiters = limiters;
        this.mailer = mailer;
    }

    // ---------------------------------------------------------------- 发送验证码

    public Map<String, Object> sendCode(Map<String, Object> body, String clientIp) {
        if (!limiters.sendCode.allow(clientIp)) throw ApiError.of(429, "发送太频繁，请稍后再试");

        String email = Validators.str(body.get("email")).trim().toLowerCase();
        String typeRaw = Validators.str(body.get("type"));
        String type = ("reset".equals(typeRaw) || "login".equals(typeRaw)) ? typeRaw : "register";
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");

        long now = System.currentTimeMillis();
        if (repo.countCodesSince(email, now - CODE_RESEND_MS) >= 1) {
            throw ApiError.of(429, "发送太频繁，请 1 分钟后再试");
        }
        if (repo.countCodesSince(email, now - 86400000L) >= CODE_DAILY_MAX) {
            throw ApiError.of(429, "该邮箱今日发送次数已达上限");
        }
        boolean registered = repo.emailRegistered(email);
        if ("register".equals(type) && registered) {
            throw ApiError.of(409, "该邮箱已注册，请直接登录或找回密码");
        }
        if (!"register".equals(type) && !registered) {
            throw ApiError.of(404, "该邮箱尚未注册");
        }

        String code = String.valueOf(ThreadLocalRandom.current().nextInt(100000, 1000000));
        repo.insertCode(email, code, type, now + CODE_TTL_MS, now);
        repo.purgeCodesOlderThan(now - 86400000L);

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

    public Map<String, Object> resetPassword(Map<String, Object> body) {
        String email = Validators.str(body.get("email")).trim().toLowerCase();
        String code = Validators.str(body.get("code")).trim();
        String newPassword = Validators.str(body.get("newPassword"));
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");
        if (!Validators.validCode(code)) throw ApiError.of(400, "验证码应为 6 位数字");
        if (!Validators.validPassword(newPassword)) throw ApiError.of(400, "新密码至少 4 位");

        String ck = "reset:" + email;
        if (!limiters.codeGuess.allow(ck)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> vc = repo.findCode(email, code, "reset", System.currentTimeMillis());
        if (vc == null) throw ApiError.of(400, "验证码错误或已过期");
        Map<String, Object> user = repo.userByEmail(email);
        if (user == null) throw ApiError.of(404, "该邮箱尚未注册");
        limiters.codeGuess.reset(ck);

        String[] hp = Scrypt.hashLogin(newPassword);
        long userId = num(user.get("id"));
        repo.updatePassword(userId, hp[1], hp[0]);
        repo.markCodeUsed(num(vc.get("id")));
        auth.revokeAllForUser(userId); // 重置密码后强制所有设备重新登录
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 注册

    public Map<String, Object> register(Map<String, Object> body, String clientIp) {
        String username = Validators.str(body.get("username")).trim();
        String password = Validators.str(body.get("password"));
        String email = Validators.str(body.get("email")).trim().toLowerCase();
        String code = Validators.str(body.get("code")).trim();
        if (!Validators.validUsername(username)) throw ApiError.of(400, "用户名需 2-20 位且只能由中英文/数字/_ 组成");
        if (!Validators.validPassword(password)) throw ApiError.of(400, "密码至少 4 位");
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");
        if (!Validators.validCode(code)) throw ApiError.of(400, "验证码应为 6 位数字");
        if (!limiters.register.allow(clientIp)) throw ApiError.of(429, "注册过于频繁，请稍后再试");

        String ck = "register:" + email;
        if (!limiters.codeGuess.allow(ck)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> vc = repo.findCode(email, code, "register", System.currentTimeMillis());
        if (vc == null) throw ApiError.of(400, "验证码错误或已过期");
        limiters.codeGuess.reset(ck);

        String[] hp = Scrypt.hashLogin(password);
        long userId;
        try {
            userId = repo.insertUser(username, hp[1], hp[0], System.currentTimeMillis(), email);
        } catch (Exception e) {
            String msg = Validators.str(e.getMessage());
            // SQLite 报的是列名（"UNIQUE constraint failed: users.email"），不是索引名——
            // 原写法查 "idx_users_email" 是死分支，重复邮箱会被误报成「用户名已被占用」（Node 版同样如此）
            if (msg.contains("users.email")) throw ApiError.of(409, "该邮箱已注册");
            if (msg.contains("UNIQUE")) throw ApiError.of(409, "用户名已被占用");
            throw e;
        }
        repo.markCodeUsed(num(vc.get("id")));
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

    public Map<String, Object> login(Map<String, Object> body, String clientIp) {
        String email = Validators.str(body.get("email")).trim().toLowerCase();
        String password = Validators.str(body.get("password"));
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");

        String lk = clientIp + "|" + email;
        if (!limiters.login.allow(lk)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> user = repo.userByEmail(email);
        if (user == null || !Scrypt.verifyLogin(password,
                Validators.str(user.get("pass_salt")), Validators.str(user.get("pass_hash")))) {
            throw ApiError.of(401, "邮箱或密码错误");
        }
        limiters.login.reset(lk);
        return sessionResponse(user);
    }

    // ---------------------------------------------------------------- 登录（验证码）

    public Map<String, Object> loginCode(Map<String, Object> body) {
        String email = Validators.str(body.get("email")).trim().toLowerCase();
        String code = Validators.str(body.get("code")).trim();
        if (!Validators.validEmail(email)) throw ApiError.of(400, "邮箱格式不正确");
        if (!Validators.validCode(code)) throw ApiError.of(400, "验证码应为 6 位数字");

        String ck = "login:" + email;
        if (!limiters.codeGuess.allow(ck)) throw ApiError.of(429, "尝试过于频繁，请 10 分钟后再试");
        Map<String, Object> vc = repo.findCode(email, code, "login", System.currentTimeMillis());
        if (vc == null) throw ApiError.of(400, "验证码错误或已过期");
        Map<String, Object> user = repo.userByEmail(email);
        if (user == null) throw ApiError.of(404, "该邮箱尚未注册");
        limiters.codeGuess.reset(ck);
        repo.markCodeUsed(num(vc.get("id")));
        return sessionResponse(user);
    }

    // ---------------------------------------------------------------- 改昵称

    public Map<String, Object> rename(Map<String, Object> body, AuthService.User me) {
        String nickname = Validators.str(body.get("nickname")).trim();
        if (!Validators.validUsername(nickname)) throw ApiError.of(400, "昵称需 2-20 位且只能由中英文/数字/_ 组成");
        if (nickname.equals(me.username)) {
            return Map.of("ok", true, "user", Map.of("id", me.id, "username", nickname));
        }
        try {
            repo.updateUsername(me.id, nickname);
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

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
