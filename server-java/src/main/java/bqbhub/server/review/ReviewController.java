package bqbhub.server.review;

import bqbhub.server.AuthService;
import bqbhub.server.support.AdminGuard;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 审核队列的 HTTP 层（路由与文案逐条对应 server/src/routes/review.js）。
 * 管理员守卫（限流桶 + 令牌）走共用的 {@link AdminGuard#requireReview}；业务在 {@link ReviewService}。
 */
@RestController
public class ReviewController {

    private final ReviewService service;
    private final AuthService auth;
    private final AdminGuard adminGuard;

    public ReviewController(ReviewService service, AuthService auth, AdminGuard adminGuard) {
        this.service = service;
        this.auth = auth;
        this.adminGuard = adminGuard;
    }

    @GetMapping("/api/admin/review")
    public Map<String, Object> queue(@RequestParam(required = false) String type,
                                     @RequestParam(required = false) String status,
                                     @RequestParam(required = false) String limit,
                                     @RequestParam(required = false) String offset,
                                     HttpServletRequest req) {
        adminGuard.requireReview(req);
        return service.queue(type, status, limit, offset);
    }

    @PostMapping("/api/admin/review/action")
    public Map<String, Object> action(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        adminGuard.requireReview(req);
        return service.action(body == null ? Map.of() : body);
    }

    @GetMapping("/api/my/submissions")
    public Map<String, Object> mySubmissions(@RequestParam(required = false) String limit,
                                             @RequestParam(required = false) String offset,
                                             HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.mySubmissions(limit, offset, me);
    }
}
