package bqbhub.server.auth;

import bqbhub.server.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

/**
 * 认证的 HTTP 层（路由与文案逐条对应 server/src/routes/auth.js）。
 * 账号流程在 {@link AccountService}；/me 与 /logout 只是会话原语的一行转发（{@link AuthService}）。
 */
@RestController
@RequestMapping("/api/auth")
public class AuthController {

    private final AccountService service;
    private final AuthService auth;

    public AuthController(AccountService service, AuthService auth) {
        this.service = service;
        this.auth = auth;
    }

    @PostMapping("/send-code")
    public Map<String, Object> sendCode(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.sendCode(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @PostMapping("/reset-password")
    public Map<String, Object> resetPassword(@RequestBody(required = false) Map<String, Object> body) {
        return service.resetPassword(body == null ? Map.of() : body);
    }

    @PostMapping("/register")
    public Map<String, Object> register(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.register(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        return service.login(body == null ? Map.of() : body, AuthService.clientIp(req));
    }

    @PostMapping("/login-code")
    public Map<String, Object> loginCode(@RequestBody(required = false) Map<String, Object> body) {
        return service.loginCode(body == null ? Map.of() : body);
    }

    @GetMapping("/me")
    public Map<String, Object> me(HttpServletRequest req) {
        return Map.of("user", auth.requireUser(req).toJson());
    }

    @PostMapping("/logout")
    public Map<String, Object> logout(HttpServletRequest req) {
        auth.revoke(auth.bearer(req));
        return Map.of("ok", true);
    }

    @PostMapping("/rename")
    public Map<String, Object> rename(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        return service.rename(body == null ? Map.of() : body, me);
    }
}
