package bqbhub.server;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 业务错误：状态码 + JSON 响应体（形状与 Node 版一致，错误消息也是同一批中文文案）。
 * 由 {@link ApiErrorAdvice} 统一转成响应；路由里直接 throw，不再手写 res.status(...).json(...)。
 */
public class ApiError extends RuntimeException {

    public final int status;
    public final Map<String, Object> body;

    public ApiError(int status, Map<String, Object> body) {
        super(String.valueOf(body));
        this.status = status;
        this.body = body;
    }

    public static ApiError of(int status, String error) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("error", error);
        return new ApiError(status, m);
    }

    /** 追加字段（如 {ok:false, error:...}） */
    public ApiError put(String key, Object value) {
        body.put(key, value);
        return this;
    }
}
