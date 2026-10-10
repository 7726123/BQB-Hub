package bqbhub.server;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Base64;

/**
 * 管理员留档令牌：无状态 HMAC（逐条对应 server/src/adminpass.js）。
 *
 * 格式与 Node 版**完全一致**（这是有意的）：payload = 过期时间戳，密钥 = 服务器上的口令派生值，
 * mac = HMAC-SHA256(key=storedHash 字符串, msg="admin-trace:"+exp) 的 base64url（无填充），
 * 令牌 = "exp.mac"。保持一致的两个理由：
 *   1) 灰度切换时，App 上已经拿到的 12 小时令牌在换到 Java 之后仍然有效（用户无感）；
 *   2) 反向回滚时同理。
 */
public final class AdminToken {

    public static final long TTL_MS = 12 * 3600 * 1000L;

    private AdminToken() {
    }

    public static String issue(String storedHash) {
        return issue(storedHash, TTL_MS);
    }

    public static String issue(String storedHash, long ttlMs) {
        if (storedHash == null || storedHash.isEmpty()) return null;
        return issueForExp(storedHash, expFor(ttlMs));
    }

    /** 过期时间戳（响应体里的 exp 字段要用同一个值） */
    public static long expFor(long ttlMs) {
        return System.currentTimeMillis() + (ttlMs > 0 ? ttlMs : TTL_MS);
    }

    /** 按指定过期时间签发（对应 adminpass.issueToken 返回的 {token, exp}） */
    public static String issueForExp(String storedHash, long exp) {
        if (storedHash == null || storedHash.isEmpty()) return null;
        return exp + "." + mac(storedHash, exp);
    }

    public static boolean verify(String storedHash, String token) {
        try {
            if (storedHash == null || storedHash.isEmpty() || token == null) return false;
            int dot = token.indexOf('.');
            if (dot <= 0 || token.indexOf('.', dot + 1) >= 0) return false;
            long exp = Long.parseLong(token.substring(0, dot));
            if (System.currentTimeMillis() > exp) return false;
            String want = mac(storedHash, exp);
            String got = token.substring(dot + 1);
            return MessageDigest.isEqual(
                    got.getBytes(StandardCharsets.US_ASCII),
                    want.getBytes(StandardCharsets.US_ASCII));
        } catch (Exception e) {
            return false;
        }
    }

    private static String mac(String storedHash, long exp) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(storedHash.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] out = mac.doFinal(("admin-trace:" + exp).getBytes(StandardCharsets.UTF_8));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(out);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
