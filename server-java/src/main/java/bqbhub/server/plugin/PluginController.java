package bqbhub.server.plugin;

import bqbhub.server.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 插件的 HTTP 层（路由与错误文案逐条对应 server/src/routes/plugin.js）。
 * 业务在 {@link PluginService}，清单规则在 {@link PluginManifest}，SQL 在 {@link PluginRepository}。
 */
@RestController
@RequestMapping("/api/plugin")
public class PluginController {

    private final PluginService service;
    private final AuthService auth;

    public PluginController(PluginService service, AuthService auth) {
        this.service = service;
        this.auth = auth;
    }

    @GetMapping("/list")
    public Map<String, Object> list(HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.list(me);
    }

    @PostMapping("/upload")
    public Map<String, Object> upload(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.upload(body == null ? Map.of() : body, me, auth.isAdmin(req));
    }

    @GetMapping("/download/{pluginId}")
    public Map<String, Object> download(@PathVariable String pluginId, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.download(pluginId, me, auth.isAdmin(req));
    }

    @DeleteMapping("/delete")
    public Map<String, Object> delete(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.delete(id, me);
    }
}
