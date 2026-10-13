package bqbhub.server.support;

import bqbhub.server.ApiError;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.stereotype.Component;

/**
 * 管理端统一守卫：限流桶 + 管理员令牌，**顺序与 Node 版逐条一致**（限流在前，401 在后）。
 * 以前这段在 FeedbackController / ReviewController 里各写一遍（逻辑相同、桶不同）。
 */
@Component
public class AdminGuard {

    private final AuthService auth;
    private final Limiters limiters;

    public AdminGuard(AuthService auth, Limiters limiters) {
        this.auth = auth;
        this.limiters = limiters;
    }

    /** 反馈管理（/api/admin/feedback*）：审核队列桶 + 反馈管理桶 + 管理员令牌 */
    public void requireFeedback(HttpServletRequest req) {
        String ip = AuthService.clientIp(req);
        if (!limiters.review.allow("ip" + ip) || !limiters.fbAdmin.allow("ip" + ip)) {
            throw ApiError.of(429, "请求过于频繁，请稍后再试");
        }
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
    }

    /** 审核队列（/api/admin/review*）：只走审核队列桶 + 管理员令牌（与 Node 版一致，无反馈桶） */
    public void requireReview(HttpServletRequest req) {
        String ip = AuthService.clientIp(req);
        if (!limiters.review.allow("ip" + ip)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
    }
}
