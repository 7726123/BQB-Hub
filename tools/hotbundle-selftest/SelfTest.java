import com.novelwriter.app.HotBundleCore;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.TreeSet;

/**
 * 热更新链路的桌面 JVM 自测（不需要手机/模拟器）。
 *
 * 由 `node scripts/hot-bundle.mjs selftest` 驱动：先用测试密钥造出真实样本
 * （假 web/ + 假 APK 资源 + 真签名 manifest + 各种攻击样本），再用本程序验证
 * Java 侧（也就是真正装在用户手机上的那段逻辑）的行为。
 *
 * 覆盖：验签通过/失败、payload 解析、文件集合、解包、逐文件哈希、资源补齐、
 * 中文逐字节一致、zip-slip、路径穿越、缺文件、篡改 zip、篡改 payload、换密钥签名。
 */
public class SelfTest {

    private static int pass = 0;
    private static int fail = 0;

    private interface Check { void run() throws Exception; }

    public static void main(String[] args) throws Exception {
        File fx = args.length > 0 ? new File(args[0]) : new File(System.getProperty("java.io.tmpdir"), "bqb-hotbundle-selftest");
        if (!fx.isDirectory()) {
            System.out.println("✘ 找不到样本目录：" + fx + "\n  先运行：node scripts/hot-bundle.mjs selftest");
            System.exit(1);
        }
        File outDir = new File(fx, "out");
        File attackDir = new File(fx, "attack");
        File assetsDir = new File(fx, "assets/public");
        File webDir = new File(fx, "web");
        File work = new File(fx, "work");
        HotBundleCore.deleteRecursive(work);
        if (!work.mkdirs()) throw new IOException("无法建立工作目录");

        String manifestJson = readText(new File(outDir, "manifest.json"));
        byte[] payload = HotBundleCore.base64Decode(jsonString(manifestJson, "payload"));
        byte[] sig = HotBundleCore.base64Decode(jsonString(manifestJson, "sig"));
        byte[] pub = pemToDer(readText(new File(fx, "keys/hot-bundle.pub.pem")));

        final List<HotBundleCore.FileEntry> files = new ArrayList<>();
        final HotBundleCore.Meta meta = HotBundleCore.parsePayload(payload, files);

        // ===== 1. 正常路径：验签 → 解包 → 逐文件校验 → 资源补齐 =====
        shouldPass("验签通过（Node 签名 ↔ Java 验签互操作）", new Check() {
            public void run() throws Exception { HotBundleCore.verifySignature(pub, payload, sig); }
        });
        shouldPass("payload 解析出正确的版本/序号/最低 APK", new Check() {
            public void run() throws Exception {
                if (!"1.5.97.9".equals(meta.v)) throw new AssertionError("v=" + meta.v);
                if (meta.code != 157999) throw new AssertionError("code=" + meta.code);
                if (meta.minNative != 157) throw new AssertionError("minNative=" + meta.minNative);
                if (!meta.zipSha256.matches("[0-9a-f]{64}")) throw new AssertionError("zipSha256 格式");
            }
        });
        shouldPass("文件清单不含字体与 version.json（它们由客户端从 APK 资源补齐）", new Check() {
            public void run() throws Exception {
                TreeSet<String> got = new TreeSet<>();
                for (HotBundleCore.FileEntry f : files) got.add(f.p);
                TreeSet<String> want = new TreeSet<>(List.of("index.html", "modules/main.js", "manifest.json", "cordova.js"));
                if (!got.equals(want)) throw new AssertionError("实际=" + got);
            }
        });
        final File dest = new File(work, "extract");
        shouldPass("解包成功", new Check() {
            public void run() throws Exception {
                if (!dest.mkdirs()) throw new IOException("mkdirs 失败");
                HotBundleCore.extractZip(new File(outDir, meta.zip), dest);
            }
        });
        shouldPass("逐文件哈希/字节数校验通过", new Check() {
            public void run() throws Exception { HotBundleCore.verifyTree(dest, files); }
        });
        final int[] seeded = new int[1];
        shouldPass("从 APK 资源补齐缺失文件（字体 + version.json）", new Check() {
            public void run() throws Exception {
                seeded[0] = HotBundleCore.seedMissing(dest, new FileSource(assetsDir));
                HotBundleCore.requireIndex(dest);
                if (seeded[0] != 2) throw new AssertionError("补齐 " + seeded[0] + " 个（期望 2）");
            }
        });
        shouldPass("补齐后的 index.html / 字体与源文件逐字节一致（中文未损坏）", new Check() {
            public void run() throws Exception {
                byte[] a = Files.readAllBytes(new File(dest, "index.html").toPath());
                byte[] b = Files.readAllBytes(new File(webDir, "index.html").toPath());
                if (!java.util.Arrays.equals(a, b)) throw new AssertionError("index.html 不一致");
                if (!new String(a, StandardCharsets.UTF_8).contains("中文标题：写卡助手")) throw new AssertionError("中文丢失");
                byte[] f1 = Files.readAllBytes(new File(dest, "assets/fonts/font.bin").toPath());
                byte[] f2 = Files.readAllBytes(new File(assetsDir, "assets/fonts/font.bin").toPath());
                if (!java.util.Arrays.equals(f1, f2)) throw new AssertionError("字体不一致");
            }
        });

        // ===== 2. 攻击样本：必须全部被拒 =====
        final String forgedJson = readText(new File(attackDir, "forged-code.json"));
        final byte[] forgedPayload = HotBundleCore.base64Decode(jsonString(forgedJson, "payload"));
        final byte[] forgedSig = HotBundleCore.base64Decode(jsonString(forgedJson, "sig"));
        shouldFail("篡改 payload 的 code（保持原签名）→ 验签失败", new Check() {
            public void run() throws Exception { HotBundleCore.verifySignature(pub, forgedPayload, forgedSig); }
        });

        final String wrongKeyJson = readText(new File(attackDir, "wrong-key.json"));
        final byte[] wrongSig = HotBundleCore.base64Decode(jsonString(wrongKeyJson, "sig"));
        shouldFail("用别的密钥签名 → 验签失败", new Check() {
            public void run() throws Exception { HotBundleCore.verifySignature(pub, payload, wrongSig); }
        });

        // 注意：这条是「哈希必须不同」的正常断言——安装流程在下载后比对 zip 哈希，
        // 不一致即拒绝；若哈希相同才说明校验形同虚设。
        shouldPass("篡改 zip 一个字节 → 哈希与签名不符（安装流程据此拒绝）", new Check() {
            public void run() throws Exception {
                String h = HotBundleCore.sha256Hex(new File(attackDir, "tampered.zip"));
                if (h.equals(meta.zipSha256)) throw new AssertionError("篡改后哈希竟然与签名一致");
            }
        });

        shouldFail("zip 内含 ../ 条目（zip-slip）→ 解包拒绝", new Check() {
            public void run() throws Exception {
                File d = new File(work, "slip");
                HotBundleCore.deleteRecursive(d);
                d.mkdirs();
                HotBundleCore.extractZip(new File(attackDir, "zipslip.zip"), d);
            }
        });

        shouldFail("payload 里带穿越路径 → 解析拒绝", new Check() {
            public void run() throws Exception {
                List<HotBundleCore.FileEntry> f2 = new ArrayList<>();
                String bad = HotBundleCore.PAYLOAD_MAGIC + "\nv=1\ncode=1\nminNative=1\nzip=a.zip\n"
                    + "zipSha256=" + "0".repeat(64) + "\nfile=" + "0".repeat(64) + " 1 ../../etc/passwd";
                HotBundleCore.parsePayload(bad.getBytes(StandardCharsets.UTF_8), f2);
            }
        });

        final String missingJson = readText(new File(attackDir, "missing-file.json"));
        final byte[] missingPayload = HotBundleCore.base64Decode(jsonString(missingJson, "payload"));
        final byte[] missingSig = HotBundleCore.base64Decode(jsonString(missingJson, "sig"));
        shouldFail("签名有效但 zip 里缺清单文件 → 校验拒绝", new Check() {
            public void run() throws Exception {
                HotBundleCore.verifySignature(pub, missingPayload, missingSig); // 签名本身是有效的
                List<HotBundleCore.FileEntry> f2 = new ArrayList<>();
                HotBundleCore.parsePayload(missingPayload, f2);
                File d = new File(work, "missing");
                HotBundleCore.deleteRecursive(d);
                d.mkdirs();
                HotBundleCore.extractZip(new File(outDir, meta.zip), d);
                HotBundleCore.verifyTree(d, f2);
            }
        });

        shouldFail("解包后文件被改动 → 哈希校验拒绝", new Check() {
            public void run() throws Exception {
                File d = new File(work, "tamper-tree");
                HotBundleCore.deleteRecursive(d);
                d.mkdirs();
                HotBundleCore.extractZip(new File(outDir, meta.zip), d);
                File f = new File(d, "modules/main.js");
                Files.write(f.toPath(), "// altered".getBytes(StandardCharsets.UTF_8));
                HotBundleCore.verifyTree(d, files);
            }
        });

        shouldFail("缺 index.html → 拒绝安装", new Check() {
            public void run() throws Exception {
                File d = new File(work, "noindex");
                HotBundleCore.deleteRecursive(d);
                if (!d.mkdirs()) throw new IOException("mkdirs");
                Files.write(new File(d, "a.txt").toPath(), "x".getBytes(StandardCharsets.UTF_8));
                HotBundleCore.requireIndex(d);
            }
        });

        System.out.println();
        System.out.println("通过 " + pass + " 项，失败 " + fail + " 项");
        System.exit(fail == 0 ? 0 : 1);
    }

    // ===== 断言小工具 =====
    private static void shouldPass(String name, Check c) {
        try { c.run(); System.out.println("✔ " + name); pass++; }
        catch (Throwable t) { System.out.println("✘ " + name + " —— 意外失败：" + brief(t)); fail++; }
    }
    private static void shouldFail(String name, Check c) {
        try { c.run(); System.out.println("✘ " + name + " —— 预期被拒，实际通过了"); fail++; }
        catch (Throwable t) { System.out.println("✔ " + name + "（已拒：" + brief(t) + "）"); pass++; }
    }
    private static String brief(Throwable t) {
        String m = t.getMessage();
        return t.getClass().getSimpleName() + (m == null ? "" : ": " + m);
    }

    // ===== 测试专用小工具（不参与打包，故可以直接用 Files/正则）=====
    /** 极简 JSON 字符串取值：样本里的 payload/sig 都是 base64（无转义），够用。 */
    private static String jsonString(String json, String key) {
        int i = json.indexOf("\"" + key + "\"");
        if (i < 0) throw new IllegalArgumentException("JSON 里没有 " + key);
        int colon = json.indexOf(':', i);
        int q1 = json.indexOf('"', colon);
        int q2 = json.indexOf('"', q1 + 1);
        return json.substring(q1 + 1, q2);
    }

    private static String readText(File f) throws IOException {
        return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8);
    }

    private static byte[] pemToDer(String pem) {
        String body = pem.replaceAll("-----[A-Z ]+-----", "").replaceAll("\\s", "");
        return Base64.getDecoder().decode(body);
    }

    /** 用目录模拟 APK 内置资源（Android 侧由 AssetManager 实现同一接口）。 */
    private static final class FileSource implements HotBundleCore.Source {
        private final File root;
        FileSource(File root) { this.root = root; }
        public List<String> list() throws IOException {
            List<String> out = new ArrayList<>();
            walk(root, "", out);
            return out;
        }
        private void walk(File dir, String prefix, List<String> out) {
            File[] kids = dir.listFiles();
            if (kids == null) return;
            for (File k : kids) {
                String rel = prefix.isEmpty() ? k.getName() : prefix + "/" + k.getName();
                if (k.isDirectory()) walk(k, rel, out);
                else out.add(rel);
            }
        }
        public InputStream open(String rel) throws IOException {
            return new BufferedInputStream(new FileInputStream(new File(root, rel)));
        }
    }
}
