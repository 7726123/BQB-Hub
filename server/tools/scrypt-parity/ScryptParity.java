// scrypt 跨语言对拍 · Java 侧（用 Bouncy Castle 的 SCrypt，和 Spring Boot 里推荐的做法一致）。
//
// 做两件事：
//   1) 正向：读 fixtures.tsv / admin-fixtures.tsv，用 Java 重算，必须与 Node 的输出逐字节一致
//      —— 证明「换成 Java 之后，老用户还能用原密码登录、线上 config.json 的管理员口令还认」。
//   2) 反向：用固定盐现场生成两条（登录 + 管理员），写 java-generated.tsv 给 Node 校验
//      —— 证明「Java 现场生成的哈希，Node 版也认」，灰度迁移期两边可以并存。
//
// 关键坑（正反两个方向都踩不得）：
//   · 登录路径的盐是「16 随机字节的 hex 字符串」（32 个 ASCII 字符），要用**这个字符串的 UTF-8 字节**
//     当盐，而不是 hex 解码成 16 字节。解码了不会报错，只会算出永远对不上的哈希。
//   · 派生长度：登录 64 字节（hex 存），管理员 32 字节（base64 存进 scrypt$N$r$p$salt$hash）。
//
// 编译运行：见同目录 run.sh / run.cmd（需要 bcprov jar）
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;

import org.bouncycastle.crypto.generators.SCrypt;

public class ScryptParity {

    static final int N = 16384;
    static final int R = 8;
    static final int P = 1;
    static final int LOGIN_KEYLEN = 64;   // src/auth.js: scryptSync(pw, salt, 64)
    static final int ADMIN_KEYLEN = 32;   // src/adminpass.js: KEYLEN = 32

    static int total = 0;
    static int fail = 0;

    public static void main(String[] args) throws Exception {
        Path dir = Paths.get(args.length > 0 ? args[0] : ".");
        System.out.println("== scrypt 对拍（Java 侧）==");
        System.out.println("Java：" + System.getProperty("java.version")
                + "   Bouncy Castle SCrypt（classpath 里的 bcprov）");
        System.out.println();

        // ---- 1) 正向：登录口令路径 ----
        for (String line : table(dir.resolve("fixtures.tsv"))) {
            String[] f = line.split("\t", -1);
            String note = f[0];
            byte[] pw = hexToBytes(f[1]);
            byte[] salt = f[2].getBytes(StandardCharsets.UTF_8);   // ★ 盐 = 字符串字节，不是 hex 解码
            String want = f[3].toLowerCase();
            String got = bytesToHex(SCrypt.generate(pw, salt, N, R, P, LOGIN_KEYLEN));
            report(got.equals(want), "[登录] " + note, want, got);
        }

        // ---- 2) 正向：管理员口令路径（认线上 config.json 里已存的派生值）----
        for (String line : table(dir.resolve("admin-fixtures.tsv"))) {
            String[] f = line.split("\t", -1);
            String note = f[0];
            byte[] pw = hexToBytes(f[1]);
            String stored = f[3];
            String[] parts = stored.split("\\$");
            // stored = scrypt$N$r$p$saltB64$hashB64
            int n = Integer.parseInt(parts[1]);
            int r = Integer.parseInt(parts[2]);
            int p = Integer.parseInt(parts[3]);
            byte[] salt = Base64.getDecoder().decode(parts[4]);
            byte[] want = Base64.getDecoder().decode(parts[5]);
            byte[] got = SCrypt.generate(pw, salt, n, r, p, want.length);
            report(bytesToHex(got).equals(bytesToHex(want)), "[管理员] " + note, stored, stored);
        }

        // ---- 3) 反向：Java 现场生成，交给 Node 校验 ----
        List<String> out = new ArrayList<>();
        out.add("# Java 侧现场生成（ScryptParity.java），由 gen-fixtures.mjs --verify-java 校验");
        out.add("# 列：kind <TAB> note <TAB> passwordHex <TAB> salt <TAB> result");
        String pwJ = "java-generated-口令";
        String saltStr = "0123456789abcdef0123456789abcdef";
        out.add(String.join("\t", "login", "java 生成的登录哈希", hexToBytesStr(pwJ.getBytes(StandardCharsets.UTF_8)),
                saltStr, bytesToHex(SCrypt.generate(pwJ.getBytes(StandardCharsets.UTF_8),
                        saltStr.getBytes(StandardCharsets.UTF_8), N, R, P, LOGIN_KEYLEN))));
        byte[] adminSalt = hexToBytes("00ff00ff00ff00ff00ff00ff00ff00ff");
        byte[] adminHash = SCrypt.generate("java-generated-admin".getBytes(StandardCharsets.UTF_8), adminSalt, N, R, P, ADMIN_KEYLEN);
        String adminStored = String.join("$", "scrypt", String.valueOf(N), String.valueOf(R), String.valueOf(P),
                Base64.getEncoder().encodeToString(adminSalt), Base64.getEncoder().encodeToString(adminHash));
        out.add(String.join("\t", "admin", "java 生成的管理员派生值", hexToBytesStr("java-generated-admin".getBytes(StandardCharsets.UTF_8)),
                Base64.getEncoder().encodeToString(adminSalt), adminStored));
        Files.write(dir.resolve("java-generated.tsv"), out);

        System.out.println();
        if (fail == 0) {
            System.out.println("正向校验通过：Node 的 " + total + " 条夹具，Java 全部逐字节复算一致");
            System.out.println("（已写出 java-generated.tsv，交给 Node 反向校验）");
        } else {
            System.out.println("正向校验失败：" + fail + "/" + total + " 条不一致");
        }
        System.exit(fail == 0 ? 0 : 1);
    }

    static void report(boolean ok, String label, String want, String got) {
        total++;
        if (!ok) fail++;
        System.out.println((ok ? "PASS  " : "FAIL  ") + label);
        if (!ok) {
            System.out.println("        期望 " + want);
            System.out.println("        实得 " + got);
        }
    }

    static List<String> table(Path p) throws Exception {
        List<String> out = new ArrayList<>();
        for (String line : Files.readAllLines(p, StandardCharsets.UTF_8)) {
            if (line.isBlank() || line.startsWith("#")) continue;
            out.add(line);
        }
        return out;
    }

    static String bytesToHex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x));
        return sb.toString();
    }

    static String hexToBytesStr(byte[] b) { return bytesToHex(b); }

    static byte[] hexToBytes(String s) {
        byte[] out = new byte[s.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(s.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
