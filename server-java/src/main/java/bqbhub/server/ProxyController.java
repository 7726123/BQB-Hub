package bqbhub.server;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * CORS 代理（逐条对应 server/src/routes/proxy.js）：把 WebView 无法直连的无 CORS 端点
 * （opencode.ai）经本服务器转发。**只允许白名单 target**（防 SSRF）+ 按 IP 限流 60/分钟。
 *
 * 契约测试在契约模式下只验「白名单外 404」：白名单内的 60 次限流用例是嵌入专用
 * （那需要用进程内 fetch 打桩拦住上游请求，见 CONTRACT.md 排除清单）。
 */
@RestController
public class ProxyController {

    static final Map<String, String> TARGETS = Map.of("opencode", "https://opencode.ai/zen/go");
    static final Duration PROXY_TIMEOUT = Duration.ofMinutes(5);

    private final Limiters limiters;
    private final ObjectMapper json;
    private final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();

    public ProxyController(Limiters limiters, ObjectMapper json) {
        this.limiters = limiters;
        this.json = json;
    }

    @PostMapping("/api/proxy/{name}/{*rest}")
    public void proxy(@PathVariable String name,
                      @PathVariable String rest,
                      @RequestBody(required = false) byte[] body,
                      HttpServletRequest req,
                      HttpServletResponse res) throws Exception {
        String target = TARGETS.get(name);
        if (target == null) {
            writeJson(res, 404, Map.of("error", "未知代理目标"));
            return;
        }
        if (!limiters.proxy.allow(AuthService.clientIp(req))) {
            writeJson(res, 429, Map.of("error", "请求过于频繁，请稍后再试"));
            return;
        }
        String path = rest == null ? "" : (rest.startsWith("/") ? rest : "/" + rest);
        try {
            String ct = Validators.str(req.getContentType());
            String accept = Validators.str(req.getHeader("Accept"));
            HttpRequest up = HttpRequest.newBuilder(URI.create(target + path))
                    .timeout(PROXY_TIMEOUT)
                    .header("Content-Type", ct.isEmpty() ? "application/json" : ct)
                    .header("Authorization", Validators.str(req.getHeader("Authorization")))
                    .header("Accept", accept.isEmpty() ? "text/event-stream" : accept)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body == null ? new byte[0] : body))
                    .build();
            HttpResponse<InputStream> r = client.send(up, HttpResponse.BodyHandlers.ofInputStream());
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
            res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.setContentType(r.headers().firstValue("content-type").orElse("application/json"));
            if (r.statusCode() >= 400) {
                String text = new String(r.body().readAllBytes(), StandardCharsets.UTF_8);
                writeJson(res, r.statusCode(), Map.of("error", hideKey(text)));
                return;
            }
            res.setStatus(200);
            // 流式透传（含 SSE）：上游是长连接，不能整段读进内存
            try (InputStream in = r.body(); OutputStream out = res.getOutputStream()) {
                in.transferTo(out);
                out.flush();
            }
        } catch (java.net.http.HttpTimeoutException e) {
            writeJson(res, 504, Map.of("error", "代理上游超时"));
        } catch (Exception e) {
            writeJson(res, 502, Map.of("error", "代理上游失败: " + hideKey(Validators.str(e.getMessage()))));
        }
    }

    /** 记录失败信息时隐藏 key（与 Node 版同款） */
    private static String hideKey(String s) {
        return Validators.str(s).replaceAll("(?i)Bearer\\s+\\S+", "Bearer ***");
    }

    private void writeJson(HttpServletResponse res, int status, Map<String, Object> body) throws Exception {
        res.setStatus(status);
        res.setContentType("application/json;charset=UTF-8");
        res.getWriter().write(json.writeValueAsString(new LinkedHashMap<>(body)));
    }
}
