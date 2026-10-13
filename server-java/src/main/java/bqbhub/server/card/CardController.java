package bqbhub.server.card;

import bqbhub.server.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 卡片社交的 HTTP 层（路由与错误文案逐条对应 server/src/routes/card.js）。
 * 业务与事务在 {@link CardService}，SQL 在 {@link CardRepository}。
 */
@RestController
public class CardController {

    private final CardService service;
    private final AuthService auth;

    public CardController(CardService service, AuthService auth) {
        this.service = service;
        this.auth = auth;
    }

    @PostMapping("/api/card/like")
    public Map<String, Object> like(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.like(body == null ? Map.of() : body, me, auth.isAdmin(req));
    }

    @GetMapping("/api/card/comments")
    public Map<String, Object> comments(@RequestParam(required = false) String type,
                                        @RequestParam(required = false) String id,
                                        @RequestParam(required = false) String limit,
                                        @RequestParam(value = "before_id", required = false) String beforeIdParam,
                                        HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.comments(type, id, limit, beforeIdParam, me);
    }

    @PostMapping("/api/card/comment")
    public Map<String, Object> comment(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.comment(body == null ? Map.of() : body, me, auth.isAdmin(req));
    }

    @DeleteMapping("/api/card/comment")
    public Map<String, Object> deleteComment(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.deleteComment(id, me, auth.isAdmin(req));
    }
}
