package bqbhub.server;

import jakarta.servlet.RequestDispatcher;
import jakarta.servlet.http.HttpServletRequest;
import org.apache.catalina.connector.ClientAbortException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.ErrorResponseException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.async.AsyncRequestNotUsableException;
import org.springframework.web.servlet.NoHandlerFoundException;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 统一错误处理（对应 server/src/app.js 的 404 与错误处理中间件）：
 *   未知路径 → 404 {"error":"未找到 <path>"}；请求体坏/过大 → 400 {"error":"无效的请求体"}；
 *   其余未捕获异常 → 500 {"error":"服务器内部错误"}（日志留栈，响应不泄露细节）。
 */
@RestControllerAdvice
public class ApiErrorAdvice {

    @ExceptionHandler(ApiError.class)
    public ResponseEntity<Map<String, Object>> business(ApiError e) {
        return ResponseEntity.status(e.status).body(e.body);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<Map<String, Object>> badBody(HttpMessageNotReadableException e) {
        return json(400, "无效的请求体");
    }

    /** 未匹配的路径 / 方法不匹配：都按 Node 版的「未找到」口径返回 404 */
    @ExceptionHandler({NoHandlerFoundException.class, NoResourceFoundException.class, HttpRequestMethodNotSupportedException.class})
    public ResponseEntity<Map<String, Object>> notFound(Exception e, HttpServletRequest req) {
        String path = Validators.str(req.getAttribute(RequestDispatcher.ERROR_REQUEST_URI) != null
                ? req.getAttribute(RequestDispatcher.ERROR_REQUEST_URI) : req.getRequestURI());
        return json(404, "未找到 " + path);
    }

    @ExceptionHandler(MissingServletRequestParameterException.class)
    public ResponseEntity<Map<String, Object>> missingParam(MissingServletRequestParameterException e) {
        return json(400, "请求参数缺失：" + e.getParameterName());
    }

    /**
     * 客户端中断了响应（取消下载、手机切网/退出、APK 下到一半被掐）：这在移动端是**常态**，
     * 不是服务端错误——只记一行，不打堆栈、也不写响应体（响应已经提交/断开，写什么都写不进去；
     * 第一版落到通用 500 分支，结果每次取消下载都在日志里刷 40 行堆栈）。
     */
    @ExceptionHandler({AsyncRequestNotUsableException.class, ClientAbortException.class})
    public void clientAbort(Exception e) {
        System.out.println("[client-abort] 客户端中断了响应（下载/连接被取消）: " + e.getMessage());
    }

    /** Spring 自己的 4xx（类型转换失败等）：保留状态码，别吞成 500 */
    @ExceptionHandler(ErrorResponseException.class)
    public ResponseEntity<Map<String, Object>> spring4xx(ErrorResponseException e) {
        int status = e.getStatusCode().value();
        String msg = status == 404 ? "未找到 " + e.getBody().getInstance() : "请求无效";
        return json(status, msg);
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> fatal(Exception e) {
        System.out.println("[error] " + e);
        e.printStackTrace();
        return json(500, "服务器内部错误");
    }

    private static ResponseEntity<Map<String, Object>> json(int status, String error) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("error", error);
        return ResponseEntity.status(status).body(body);
    }

    /** Spring 兜底错误页（/error）也换成同一 JSON 口径，免得漏出 Whitelabel 结构 */
    @org.springframework.web.bind.annotation.RestController
    public static class ErrorFallback implements org.springframework.boot.web.servlet.error.ErrorController {
        @org.springframework.web.bind.annotation.RequestMapping("/error")
        public ResponseEntity<Map<String, Object>> error(HttpServletRequest req) {
            Object st = req.getAttribute(RequestDispatcher.ERROR_STATUS_CODE);
            int status = st == null ? 500 : Integer.parseInt(String.valueOf(st));
            Object uri = req.getAttribute(RequestDispatcher.ERROR_REQUEST_URI);
            String path = Validators.str(uri);
            if (status == 404) return json(404, "未找到 " + path);
            if (status == 400) return json(400, "无效的请求体");
            if (status >= 500) return json(500, "服务器内部错误");
            return ResponseEntity.status(HttpStatus.valueOf(status)).body(Map.of("error", "请求无效"));
        }
    }
}
