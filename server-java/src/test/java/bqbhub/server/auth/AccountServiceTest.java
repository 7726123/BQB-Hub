package bqbhub.server.auth;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Mailer;
import bqbhub.server.SchemaMigrations;
import bqbhub.server.Scrypt;
import bqbhub.server.TestDb;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 账号流程（原 AuthController 的八条路由）：验证码、注册、两种登录、重置密码、改昵称。
 * 用未配置 SMTP 的 Mailer（send-code 会走「服务器未配置邮箱」分支），验证码直接写库造。
 */
class AccountServiceTest {

    private static final String EMAIL = "alice@example.com";

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private AccountService svc;
    private Limiters limiters;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("auth.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        AppConfig cfg = new AppConfig(Map.of("CONFIG_FILE", tmp.resolve("config.json").toString()));
        AuthService auth = new AuthService(jdbc, cfg);
        limiters = new Limiters();
        svc = new AccountService(new AccountRepository(jdbc), auth, limiters, new Mailer(cfg));
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    private static int status(Runnable r) {
        return assertThrows(ApiError.class, r::run).status;
    }

    /** 直接造一条验证码（绕开邮件） */
    private void seedCode(String email, String code, String type) {
        long now = System.currentTimeMillis();
        jdbc.update("INSERT INTO verify_codes (email, code, type, expires_at, created_at, used) VALUES (?, ?, ?, ?, ?, 0)",
                email, code, type, now + 600_000, now);
    }

    private long seedUser(String email, String name, String password) {
        String[] hp = Scrypt.hashLogin(password);
        jdbc.update("INSERT INTO users (username, pass_hash, pass_salt, created_at, email) VALUES (?, ?, ?, ?, ?)",
                name, hp[1], hp[0], System.currentTimeMillis(), email);
        return jdbc.queryForObject("SELECT id FROM users WHERE email = ?", Long.class, email);
    }

    @Test
    void 发送验证码_校验邮箱与注册状态_邮件未配置时如实报错() {
        assertEquals("邮箱格式不正确", err(() -> svc.sendCode(Map.of("email", "bad"), "1.1.1.1")));
        assertEquals("该邮箱尚未注册", err(() -> svc.sendCode(Map.of("email", "nobody@example.com", "type", "reset"), "1.1.1.1")));

        // 未配置 SMTP：验证码已入库，但邮件发不出 → 500 且文案明确指路
        assertEquals("服务器未配置邮箱（管理员需填写 server/config.json）",
                err(() -> svc.sendCode(Map.of("email", "new@example.com"), "1.1.1.1")));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM verify_codes WHERE email = 'new@example.com'", Integer.class));

        // 1 分钟内重发（换 IP 避开桶）→ 429
        assertEquals("发送太频繁，请 1 分钟后再试", err(() -> svc.sendCode(Map.of("email", "new@example.com"), "2.2.2.2")));

        // 已注册邮箱走 register 类型 → 409
        seedUser(EMAIL, "alice", "pw1234");
        assertEquals("该邮箱已注册，请直接登录或找回密码", err(() -> svc.sendCode(Map.of("email", EMAIL), "3.3.3.3")));
    }

    @Test
    void 注册_校验文案与成功后建会话() {
        assertEquals("用户名需 2-20 位且只能由中英文/数字/_ 组成", err(() -> svc.register(Map.of("username", "a"), "1.1.1.1")));
        assertEquals("密码至少 4 位", err(() -> svc.register(Map.of("username", "alice", "password", "123", "email", EMAIL, "code", "123456"), "1.1.1.1")));
        assertEquals("邮箱格式不正确", err(() -> svc.register(Map.of("username", "alice", "password", "1234", "email", "bad", "code", "123456"), "1.1.1.1")));
        assertEquals("验证码应为 6 位数字", err(() -> svc.register(Map.of("username", "alice", "password", "1234", "email", EMAIL, "code", "12"), "1.1.1.1")));
        assertEquals("验证码错误或已过期", err(() -> svc.register(Map.of("username", "alice", "password", "1234", "email", EMAIL, "code", "123456"), "1.1.1.1")));

        seedCode(EMAIL, "123456", "register");
        Map<String, Object> out = svc.register(Map.of("username", "alice", "password", "pw1234", "email", EMAIL, "code", "123456"), "1.1.1.1");
        assertTrue(String.valueOf(out.get("token")).length() >= 32);
        assertEquals("alice", ((Map<?, ?>) out.get("user")).get("username"));
        assertEquals(EMAIL, ((Map<?, ?>) out.get("user")).get("email"));
        // 验证码被消费、会话已建
        assertEquals(1, jdbc.queryForObject("SELECT used FROM verify_codes WHERE email = ?", Integer.class, EMAIL));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM sessions", Integer.class));

        // 同一验证码不能复用
        assertEquals("验证码错误或已过期", err(() -> svc.register(Map.of("username", "alice2", "password", "pw1234", "email", EMAIL, "code", "123456"), "1.1.1.1")));
        // 用户名被占用（换邮箱、给有效验证码）
        seedCode("dup-user@example.com", "111111", "register");
        assertEquals("用户名已被占用", err(() -> svc.register(Map.of("username", "alice", "password", "pw1234", "email", "dup-user@example.com", "code", "111111"), "2.2.2.2")));
        // 邮箱已注册（换用户名、给有效验证码）
        // ⚠ 现状（与 Node 版一致）：SQLite 报的是 "UNIQUE constraint failed: users.email"，
        // 而代码查的是 "idx_users_email" → 该分支是死代码，这里会落到「用户名已被占用」。
        // 重构阶段先按现状钉住（下一步的 fix 提交再修文案与测试）。
        seedUser("dup-mail@example.com", "someone", "pw1234");
        seedCode("dup-mail@example.com", "222222", "register");
        assertEquals("用户名已被占用", err(() -> svc.register(Map.of("username", "brandnew", "password", "pw1234", "email", "dup-mail@example.com", "code", "222222"), "3.3.3.3")));
    }

    @Test
    void 登录_密码错误与成功后发会话() {
        seedUser(EMAIL, "alice", "pw1234");
        assertEquals("邮箱格式不正确", err(() -> svc.login(Map.of("email", "bad", "password", "pw1234"), "1.1.1.1")));
        assertEquals(401, status(() -> svc.login(Map.of("email", EMAIL, "password", "wrong"), "1.1.1.1")));
        assertEquals("邮箱或密码错误", err(() -> svc.login(Map.of("email", "nobody@example.com", "password", "x"), "1.1.1.1")));

        Map<String, Object> out = svc.login(Map.of("email", EMAIL, "password", "pw1234"), "1.1.1.1");
        assertEquals("alice", ((Map<?, ?>) out.get("user")).get("username"));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM sessions", Integer.class));
    }

    @Test
    void 验证码登录_未注册404_坏码400_成功发会话() {
        seedUser(EMAIL, "alice", "pw1234");
        // 先查码后查人：坏码一律「验证码错误或已过期」
        assertEquals("验证码错误或已过期", err(() -> svc.loginCode(Map.of("email", EMAIL, "code", "123456"))));
        // 码有效但邮箱没注册 → 404
        seedCode("nobody@example.com", "654321", "login");
        assertEquals("该邮箱尚未注册", err(() -> svc.loginCode(Map.of("email", "nobody@example.com", "code", "654321"))));

        seedCode(EMAIL, "123456", "login");
        Map<String, Object> out = svc.loginCode(Map.of("email", EMAIL, "code", "123456"));
        assertEquals("alice", ((Map<?, ?>) out.get("user")).get("username"));
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM sessions", Integer.class));
    }

    @Test
    void 重置密码_换哈希并踢掉所有会话() {
        long uid = seedUser(EMAIL, "alice", "old-pw");
        // 造一个会话，证明重置后会被吊销
        jdbc.update("INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', ?, ?)", uid, System.currentTimeMillis() + 86400000L);
        seedCode(EMAIL, "222222", "reset");

        assertEquals("新密码至少 4 位", err(() -> svc.resetPassword(Map.of("email", EMAIL, "code", "222222", "newPassword", "1"))));
        assertEquals("验证码错误或已过期", err(() -> svc.resetPassword(Map.of("email", EMAIL, "code", "000000", "newPassword", "new-pw"))));

        assertEquals(Map.of("ok", true), svc.resetPassword(Map.of("email", EMAIL, "code", "222222", "newPassword", "new-pw")));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM sessions", Integer.class), "重置后强制重新登录");
        assertEquals(1, jdbc.queryForObject("SELECT used FROM verify_codes WHERE code = '222222'", Integer.class));
        // 新密码能登、老密码不行
        assertTrue(svc.login(Map.of("email", EMAIL, "password", "new-pw"), "9.9.9.9").containsKey("token"));
        assertEquals(401, status(() -> svc.login(Map.of("email", EMAIL, "password", "old-pw"), "8.8.8.8")));
    }

    @Test
    void 改昵称_校验与占用() {
        long uid = seedUser(EMAIL, "alice", "pw1234");
        seedUser("bob@example.com", "bob", "pw1234");
        AuthService.User me = new AuthService.User(uid, "alice", EMAIL);

        assertEquals("昵称需 2-20 位且只能由中英文/数字/_ 组成", err(() -> svc.rename(Map.of("nickname", "a"), me)));
        assertEquals("该昵称已被占用", err(() -> svc.rename(Map.of("nickname", "bob"), me)));

        assertEquals(Map.of("ok", true, "user", Map.of("id", uid, "username", "alice")), svc.rename(Map.of("nickname", "alice"), me));
        Map<String, Object> out = svc.rename(Map.of("nickname", "alice2"), me);
        assertEquals("alice2", ((Map<?, ?>) out.get("user")).get("username"));
        assertEquals("alice2", jdbc.queryForObject("SELECT username FROM users WHERE id = ?", String.class, uid));
    }
}
