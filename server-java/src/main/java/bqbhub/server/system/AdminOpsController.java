package bqbhub.server.system;

import bqbhub.server.AuthService;
import bqbhub.server.support.AdminKeyGuard;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/** 管理员面路由（对应 Node 版 routes/system.js 的后半）：口令校验换令牌 / 留档写入 / 留档读取与清空。 */
@RestController
public class AdminOpsController {

    private final AdminOpsService service;
    private final AuthService auth;
    private final AdminKeyGuard adminKeyGuard;

    public AdminOpsController(AdminOpsService service, AuthService auth, AdminKeyGuard adminKeyGuard) {
        this.service = service;
        this.auth = auth;
        this.adminKeyGuard = adminKeyGuard;
    }

    @PostMapping("/api/admin/verify")
    public Map<String, Object> adminVerify(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.adminVerify(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @PostMapping("/api/admin/trace")
    public Map<String, Object> tracePost(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.tracePost(body == null ? Map.of() : body,
                auth.isSystem(req), auth.adminToken(req), AuthService.clientIp(req));
    }

    @GetMapping("/api/admin/traces")
    public ResponseEntity<?> tracesGet(@RequestParam(required = false) String limit,
                                       @RequestParam(required = false) String offset,
                                       @RequestParam(required = false) String book,
                                       @RequestParam(required = false) String format,
                                       HttpServletRequest req) {
        adminKeyGuard.require(req);
        List<Map<String, Object>> rows = service.traces(limit, offset, book);
        if ("html".equals(bqbhub.server.Validators.str(format))) {
            return ResponseEntity.ok()
                    .header(HttpHeaders.CONTENT_TYPE, "text/html; charset=utf-8")
                    .body(TracesHtml.render(rows));
        }
        return ResponseEntity.ok(Map.of("traces", rows));
    }

    @DeleteMapping("/api/admin/traces")
    public Map<String, Object> tracesDelete(HttpServletRequest req) {
        adminKeyGuard.require(req);
        return service.deleteTraces();
    }
}
