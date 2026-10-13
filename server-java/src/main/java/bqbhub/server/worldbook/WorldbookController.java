package bqbhub.server.worldbook;

import bqbhub.server.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 世界书的 HTTP 层（路由与错误文案逐条对应 server/src/routes/worldbook.js）：
 * 取参数 / requireUser / 交给 Service / 拼下载响应头。业务在 {@link WorldbookService}，SQL 在 {@link WorldbookRepository}。
 */
@RestController
@RequestMapping("/api/worldbook")
public class WorldbookController {

    private final WorldbookService service;
    private final AuthService auth;

    public WorldbookController(WorldbookService service, AuthService auth) {
        this.service = service;
        this.auth = auth;
    }

    @GetMapping("/list")
    public Map<String, Object> list(@RequestParam(required = false) String q,
                                    @RequestParam(required = false) String category,
                                    @RequestParam(required = false) String sort,
                                    @RequestParam(required = false) String page,
                                    @RequestParam(required = false) String pageSize,
                                    @RequestParam(required = false) String strict,
                                    @RequestParam(required = false) String nsfw,
                                    HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.list(category, q, sort, page, pageSize, strict, nsfw, me, auth.isAdmin(req));
    }

    @GetMapping("/search")
    public Map<String, Object> search(@RequestParam(required = false) String q,
                                     @RequestParam(required = false) String sort,
                                     @RequestParam(required = false) String page,
                                     @RequestParam(required = false) String pageSize,
                                     @RequestParam(required = false) String strict,
                                     @RequestParam(required = false) String nsfw,
                                     HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.search(q, sort, page, pageSize, strict, nsfw, me, auth.isAdmin(req));
    }

    @PostMapping("/upload")
    public Map<String, Object> upload(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.upload(body == null ? Map.of() : body, me, auth.isAdmin(req));
    }

    @PostMapping("/meta")
    public Map<String, Object> meta(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.meta(body == null ? Map.of() : body, me, auth.isAdmin(req));
    }

    @GetMapping("/detail")
    public Map<String, Object> detail(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.detail(id, me, auth.isAdmin(req));
    }

    @GetMapping("/preview")
    public Map<String, Object> preview(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.preview(id, me, auth.isAdmin(req));
    }

    @GetMapping("/download")
    public ResponseEntity<Resource> download(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        WorldbookService.Payload p = service.download(id, me, auth.isAdmin(req));
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/json; charset=utf-8")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"worldbook_" + p.id() + ".json\"")
                .body(new ByteArrayResource(p.bytes()));
    }

    @DeleteMapping("/delete")
    public Map<String, Object> delete(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.delete(id, me, auth.isAdmin(req));
    }
}
