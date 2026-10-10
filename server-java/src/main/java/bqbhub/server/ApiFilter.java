package bqbhub.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;

/**
 * 管线中间件（逐条对应 server/src/app.js）：
 *   安全响应头 → CORS + OPTIONS 204 → 请求日志（X-Request-Id）→ 地区拦截（未移植，见 Region）
 *   → /api/auth/** 的 IP 限流（120/分钟）。
 * 头部与状态码都被契约测试断言（hardening-limits 的「安全响应头」用例），别随手改。
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class ApiFilter extends OncePerRequestFilter {

    private final AppConfig cfg;
    private final Limiters limiters;
    private final ObjectMapper json;

    public ApiFilter(AppConfig cfg, Limiters limiters, ObjectMapper json) {
        this.cfg = cfg;
        this.limiters = limiters;
        this.json = json;
    }

    @PostConstruct
    void warnAboutRegionBlock() {
        if (cfg.regionBlock) {
            System.out.println("[warn] 配置里 regionBlock=true，但 Java 版还没接 geoip（见 server-java/README.md 缺口清单）");
        }
    }

    @Override
    protected void doFilterInternal(HttpServletRequest req, HttpServletResponse res, FilterChain chain)
            throws ServletException, IOException {
        // 纯 API 服务：不需要被 iframe 嵌入，也不该被嗅探内容类型
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("Referrer-Policy", "no-referrer");
        // CORS（手机 http://局域网IP 访问本服务必需）
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Admin-Token");
        res.setHeader("Access-Control-Max-Age", "86400");

        if ("OPTIONS".equalsIgnoreCase(req.getMethod())) {
            res.setStatus(204);
            return;
        }

        String requestId = UUID.randomUUID().toString();
        res.setHeader("X-Request-Id", requestId);
        long start = System.currentTimeMillis();
        try {
            String ip = AuthService.clientIp(req);
            if (cfg.regionBlock && Region.blocked(ip)) {
                writeJson(res, 403, Map.of("error", "当前地区暂不可用"));
                return;
            }
            String uri = Validators.str(req.getRequestURI());
            if (uri.startsWith("/api/auth") && !limiters.authIp.allow(ip)) {
                writeJson(res, 429, Map.of("error", "请求过于频繁，请稍后再试"));
                return;
            }
            chain.doFilter(req, res);
        } finally {
            System.out.println("[" + Instant.now() + "] " + requestId + " " + req.getMethod() + " "
                    + req.getRequestURI() + " -> " + res.getStatus() + " "
                    + (System.currentTimeMillis() - start) + "ms");
        }
    }

    private void writeJson(HttpServletResponse res, int status, Map<String, Object> body) throws IOException {
        res.setStatus(status);
        res.setContentType("application/json;charset=UTF-8");
        Map<String, Object> ordered = new LinkedHashMap<>(body);
        res.getWriter().write(json.writeValueAsString(ordered));
    }
}
