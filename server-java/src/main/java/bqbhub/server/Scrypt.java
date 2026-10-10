package bqbhub.server;

import org.bouncycastle.crypto.generators.SCrypt;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Base64;

/**
 * 口令派生：scrypt（Bouncy Castle），参数与 Node 版**逐字节一致**。
 * 两条规格（已由 server/tools/scrypt-parity 正反向对拍验证）：
 *
 *  A. 登录口令（server/src/auth.js）
 *       salt = 16 随机字节的 hex 字符串（32 个 ASCII 字符）
 *       hash = scrypt(pw_utf8, salt_string_utf8, 64, N=16384,r=8,p=1) → hex
 *       ★ 盐是「那个 hex 字符串」的 UTF-8 字节，不是把它 hex 解码 —— 解码不报错、只会永远对不上
 *       库里：users.pass_salt = salt 字符串，users.pass_hash = hash hex
 *
 *  B. 管理员口令（server/src/adminpass.js；线上 config.json 的 adminPasswordHash 就是它）
 *       stored = "scrypt$16384$8$1$<saltB64>$<hashB64>"（salt 16 真字节，hash 32 字节）
 */
public final class Scrypt {

    public static final int N = 16384;
    public static final int R = 8;
    public static final int P = 1;
    public static final int LOGIN_KEYLEN = 64;
    public static final int ADMIN_KEYLEN = 32;
    public static final int SALT_LEN = 16;

    private static final SecureRandom RND = new SecureRandom();

    private Scrypt() {
    }

    /** 登录口令：返回 {saltHex, hashHex}（对应 auth.hashPassword） */
    public static String[] hashLogin(String password) {
        byte[] salt = new byte[SALT_LEN];
        RND.nextBytes(salt);
        String saltHex = hex(salt);
        String hashHex = hex(derive(password, saltHex, LOGIN_KEYLEN));
        return new String[]{saltHex, hashHex};
    }

    /** 登录口令校验（对应 auth.verifyPassword） */
    public static boolean verifyLogin(String password, String saltHex, String expectedHex) {
        if (saltHex == null || expectedHex == null || saltHex.isEmpty() || expectedHex.isEmpty()) return false;
        try {
            String got = hex(derive(password, saltHex, LOGIN_KEYLEN));
            return constantTimeEqualsIgnoreCase(got, expectedHex);
        } catch (Exception e) {
            return false;
        }
    }

    /** 管理员口令派生值（对应 adminpass.hashPassword） */
    public static String hashAdmin(String password) {
        byte[] salt = new byte[SALT_LEN];
        RND.nextBytes(salt);
        byte[] hash = SCrypt.generate(utf8(password), salt, N, R, P, ADMIN_KEYLEN);
        return "scrypt$" + N + "$" + R + "$" + P + "$"
                + Base64.getEncoder().encodeToString(salt) + "$"
                + Base64.getEncoder().encodeToString(hash);
    }

    /** 管理员口令校验（对应 adminpass.verifyPassword：照 stored 里的参数复算，长度取自 stored） */
    public static boolean verifyAdmin(String password, String stored) {
        try {
            if (stored == null) return false;
            String[] parts = stored.split("\\$", -1);
            if (parts.length != 6 || !"scrypt".equals(parts[0])) return false;
            int n = Integer.parseInt(parts[1]);
            int r = Integer.parseInt(parts[2]);
            int p = Integer.parseInt(parts[3]);
            byte[] salt = Base64.getDecoder().decode(parts[4]);
            byte[] want = Base64.getDecoder().decode(parts[5]);
            if (salt.length == 0 || want.length == 0) return false;
            byte[] got = SCrypt.generate(utf8(password), salt, n, r, p, want.length);
            return MessageDigest.isEqual(got, want);
        } catch (Exception e) {
            return false;
        }
    }

    // ---------------------------------------------------------------- 内部

    /** A 路径的派生：盐按「字符串的 UTF-8 字节」参与 */
    private static byte[] derive(String password, String saltString, int keylen) {
        return SCrypt.generate(utf8(password), utf8(saltString), N, R, P, keylen);
    }

    private static byte[] utf8(String s) {
        return (s == null ? "" : s).getBytes(StandardCharsets.UTF_8);
    }

    public static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    private static boolean constantTimeEqualsIgnoreCase(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.US_ASCII),
                b.toLowerCase().getBytes(StandardCharsets.US_ASCII));
    }
}
