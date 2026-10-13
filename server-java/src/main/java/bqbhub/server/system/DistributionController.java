package bqbhub.server.system;

import bqbhub.server.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/** 分发面路由（对应 Node 版 routes/system.js 的前半）：健康检查 / 版本 / APK / 网页包热更新。 */
@RestController
public class DistributionController {

    private final DistributionService service;
    private final AuthService auth;

    public DistributionController(DistributionService service, AuthService auth) {
        this.service = service;
        this.auth = auth;
    }

    @GetMapping({"/", "/api/health"})
    public Map<String, Object> health() {
        return service.health();
    }

    @GetMapping("/api/app/version")
    public Map<String, Object> appVersion(HttpServletRequest req) {
        return service.appVersion(req.isSecure(), req.getHeader("Host"));
    }

    @GetMapping("/apk/{file}")
    public ResponseEntity<Resource> apk(@PathVariable String file) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/vnd.android.package-archive")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + file + "\"")
                .body(new FileSystemResource(service.apkPath(file)));
    }

    @GetMapping("/api/app/web-bundle")
    public ResponseEntity<Map<String, Object>> webBundleManifest(
            @RequestParam(required = false) String channel, HttpServletRequest req) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(service.webBundleManifest(channel, auth.isSystem(req)));
    }

    @GetMapping("/web-bundle/{file}")
    public ResponseEntity<Resource> webBundleFile(@PathVariable String file) {
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/zip")
                .header(HttpHeaders.CACHE_CONTROL, "no-store")
                .body(new FileSystemResource(service.webBundleFile(file)));
    }
}
