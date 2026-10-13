package bqbhub.server.system;

import bqbhub.server.ApiError;
import bqbhub.server.AuthService;
import bqbhub.server.support.AdminKeyGuard;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 遥测路由（对应 Node 版 routes/system.js 的中段）：心跳 / 统计 / 漏答 / 客户端日志。 */
@RestController
public class TelemetryController {

    private final TelemetryService service;
    private final AuthService auth;
    private final AdminKeyGuard adminKeyGuard;

    public TelemetryController(TelemetryService service, AuthService auth, AdminKeyGuard adminKeyGuard) {
        this.service = service;
        this.auth = auth;
        this.adminKeyGuard = adminKeyGuard;
    }

    @PostMapping("/api/app/ping")
    public Map<String, Object> ping(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.ping(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @GetMapping("/api/admin/stats")
    public Map<String, Object> stats(HttpServletRequest req) {
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
        return service.stats();
    }

    @PostMapping("/api/usage-assistant/miss")
    public Map<String, Object> assistantMiss(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.assistantMiss(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @PostMapping("/api/client-logs")
    public Map<String, Object> clientLogsPost(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.clientLogsPost(body == null ? Map.of() : body, AuthService.clientIp(req), req.getHeader("User-Agent"));
    }

    @GetMapping("/api/client-logs")
    public Map<String, Object> clientLogsGet(@RequestParam(required = false) String limit, HttpServletRequest req) {
        adminKeyGuard.require(req);
        return service.clientLogs(limit);
    }
}
