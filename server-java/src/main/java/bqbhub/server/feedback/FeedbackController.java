package bqbhub.server.feedback;

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
 * 意见反馈的 HTTP 层（路由与错误文案逐条对应 server/src/routes/feedback.js）：
 * 只做「取参数 / 守卫 / 交给 Service / 返回 Map」，业务规则在 {@link FeedbackService}、SQL 在 {@link FeedbackRepository}。
 * 提交接口是公开的（无 requireUser），所以这里除了管理端守卫没有别的鉴权。
 */
@RestController
public class FeedbackController {

    private final FeedbackService service;
    private final AdminGuard adminGuard;

    public FeedbackController(FeedbackService service, AdminGuard adminGuard) {
        this.service = service;
        this.adminGuard = adminGuard;
    }

    @PostMapping("/api/feedback")
    public Map<String, Object> submit(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.submit(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @GetMapping("/api/admin/feedback")
    public Map<String, Object> adminList(@RequestParam(required = false) String status,
                                        @RequestParam(required = false) String limit,
                                        HttpServletRequest req) {
        adminGuard.requireFeedback(req);
        return service.adminList(status, limit);
    }

    @PostMapping("/api/admin/feedback/read")
    public Map<String, Object> adminRead(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        adminGuard.requireFeedback(req);
        return service.adminRead(body == null ? Map.of() : body);
    }

    @PostMapping("/api/admin/feedback/delete")
    public Map<String, Object> adminDelete(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        adminGuard.requireFeedback(req);
        return service.adminDelete(body == null ? Map.of() : body);
    }
}
