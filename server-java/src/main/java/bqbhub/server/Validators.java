package bqbhub.server;

import java.util.regex.Pattern;

/** 输入校验与取值：语义对应 server/src/auth.js 的 valid* 与各路由里的取字段写法。 */
public final class Validators {

    private static final Pattern USERNAME = Pattern.compile("^[A-Za-z0-9_\\u4e00-\\u9fa5]+$");
    private static final Pattern EMAIL = Pattern.compile("^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}$");
    private static final Pattern CODE = Pattern.compile("^\\d{6}$");
    private static final Pattern INSTALL_ID = Pattern.compile("^[A-Za-z0-9_-]{8,64}$");

    public static final int USERNAME_MIN = 2;
    public static final int USERNAME_MAX = 20;
    public static final int PASSWORD_MIN = 4;

    private Validators() {
    }

    public static boolean validUsername(String u) {
        if (u == null) return false;
        return USERNAME.matcher(u).matches() && u.length() >= USERNAME_MIN && u.length() <= USERNAME_MAX;
    }

    public static boolean validPassword(String p) {
        return p != null && p.length() >= PASSWORD_MIN && p.length() <= 64;
    }

    public static boolean validEmail(String e) {
        if (e == null) return false;
        return EMAIL.matcher(e).matches() && e.length() <= 64;
    }

    public static boolean validCode(String c) {
        return c != null && CODE.matcher(c).matches();
    }

    public static boolean validInstallId(String id) {
        return id != null && INSTALL_ID.matcher(id).matches();
    }

    /** 按码点计长度（emoji 算 1，与前端提示一致；对应 feedback 的 cpLen） */
    public static int cpLen(String s) {
        return s == null ? 0 : s.codePointCount(0, s.length());
    }

    /** 对应 JS 的 `String(x || '')`：null/缺失 → 空串 */
    public static String str(Object o) {
        return o == null ? "" : String.valueOf(o);
    }

    public static String trim(String s) {
        return s == null ? "" : s.trim();
    }

    /** 取整数字段（对应 Number(x) || dflt） */
    public static int num(Object o, int dflt) {
        if (o instanceof Number n) {
            int v = n.intValue();
            return v == 0 ? dflt : v;
        }
        try {
            double d = Double.parseDouble(str(o));
            int v = (int) d;
            return (Double.isNaN(d) || v == 0) ? dflt : v;
        } catch (Exception e) {
            return dflt;
        }
    }

    public static int num(String s, int dflt) {
        try {
            int v = Integer.parseInt(s.trim());
            return v == 0 ? dflt : v;
        } catch (Exception e) {
            return dflt;
        }
    }

    /** 截断（对应 JS 的 String(v).slice(0, n)） */
    public static String cut(Object o, int n) {
        String s = str(o);
        return s.length() <= n ? s : s.substring(0, n);
    }

    public static String cut(String s, int n) {
        if (s == null) return "";
        return s.length() <= n ? s : s.substring(0, n);
    }
}
