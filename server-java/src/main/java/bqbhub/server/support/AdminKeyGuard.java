package bqbhub.server.support;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.Validators;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 运维口令守卫（x-admin-key → cfg.adminKey）：常量时间比较，读/清空留档与客户端日志列表用。
 * 注意它**不是**管理员令牌（AdminGuard/AdminToken 那套），是服务器上手填的运维口令（对应 Node 版 requireAdminKey）。
 */
@Component
public class AdminKeyGuard {

    private final AppConfig cfg;

    public AdminKeyGuard(AppConfig cfg) {
        this.cfg = cfg;
    }

    public void require(HttpServletRequest req) {
        String key = Validators.str(req.getHeader("x-admin-key"));
        String want = Validators.str(cfg.adminKey);
        boolean ok = !want.isEmpty() && MessageDigest.isEqual(
                key.getBytes(StandardCharsets.UTF_8), want.getBytes(StandardCharsets.UTF_8));
        if (!ok) throw ApiError.of(403, "forbidden");
    }
}
