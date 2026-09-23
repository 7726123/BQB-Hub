package com.novelwriter.app;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.MessageDigest;
import java.security.spec.X509EncodedKeySpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 热更新包（网页包）的纯逻辑核心：验签 / 解包 / 哈希校验 / 资源补齐。
 *
 * 刻意不依赖任何 Android 类（只用 JDK），因此可以在桌面 JVM 上直接跑
 * tools/hotbundle-selftest 做真实验签与解包验证——这层是整条热更新链的安全边界，
 * 必须能脱离手机验证（见交接文档「热更新」章节）。
 *
 * 信任边界：客户端只信任 payload（本类解析）与 sig（本类验签）。payload 之外的字段
 * （HTTP 响应里的其它 JSON 字段、文件名、URL）一律视为不可信输入。
 */
public final class HotBundleCore {

    public static final String PAYLOAD_MAGIC = "hotbundle-v1";
    /** 单包最多文件数（防解包炸弹） */
    public static final int MAX_FILES = 4096;
    /** 解包后总字节上限 */
    public static final long MAX_TOTAL_BYTES = 64L * 1024 * 1024;
    /** 单个 zip 下载上限 */
    public static final long MAX_ZIP_BYTES = 32L * 1024 * 1024;
    /** 路径长度上限 */
    public static final int MAX_PATH_LEN = 512;

    private HotBundleCore() {}

    /** 签名覆盖的元信息（全部来自 payload，绝不用 HTTP 响应里的同名字段）。 */
    public static final class Meta {
        public String v = "";
        public long code = 0;
        public int minNative = -1;
        public String zip = "";
        public String zipSha256 = "";
    }

    /** payload 里的一个文件条目。 */
    public static final class FileEntry {
        public final String p;
        public final long s;
        public final String h;
        public FileEntry(String p, long s, String h) { this.p = p; this.s = s; this.h = h; }
    }

    /** 包内容非法（与 IOException 区分：前者是「可疑/损坏」，后者是「读写失败」）。 */
    public static class BundleError extends Exception {
        public BundleError(String msg) { super(msg); }
    }

    /** 补齐来源（APK 内置资源）。桌面上用目录实现，Android 上用 AssetManager。 */
    public interface Source {
        /** 相对路径列表（'/' 分隔）。 */
        List<String> list() throws IOException;
        InputStream open(String rel) throws IOException;
    }

    // ===== payload 解析 =====

    /**
     * 解析规范化 payload。格式（LF 分隔，末尾无换行）：
     * <pre>
     * hotbundle-v1
     * v=1.5.96w1
     * code=157000
     * minNative=157
     * zip=web-1.5.96w1.zip
     * zipSha256=&lt;hex&gt;
     * file=&lt;sha256hex&gt; &lt;size&gt; &lt;path&gt;
     * </pre>
     * 路径放在行尾，因此路径里允许出现 '=' 与空格。未知行忽略（便于将来扩展字段）。
     */
    public static Meta parsePayload(byte[] payload, List<FileEntry> outFiles) throws BundleError {
        String text = new String(payload, java.nio.charset.StandardCharsets.UTF_8);
        String[] lines = text.split("\n", -1);
        if (lines.length == 0 || !PAYLOAD_MAGIC.equals(lines[0])) {
            throw new BundleError("payload 头部不是 " + PAYLOAD_MAGIC);
        }
        Meta m = new Meta();
        boolean sawZipSha = false;
        for (int i = 1; i < lines.length; i++) {
            String ln = lines[i];
            if (ln.isEmpty()) continue;
            if (ln.startsWith("v=")) {
                m.v = ln.substring(2);
            } else if (ln.startsWith("code=")) {
                m.code = parseLong(ln.substring(5));
            } else if (ln.startsWith("minNative=")) {
                long n = parseLong(ln.substring(10));
                if (n < 0 || n > Integer.MAX_VALUE) throw new BundleError("minNative 越界");
                m.minNative = (int) n;
            } else if (ln.startsWith("zip=")) {
                m.zip = ln.substring(4);
            } else if (ln.startsWith("zipSha256=")) {
                m.zipSha256 = ln.substring(10).toLowerCase(Locale.ROOT);
                sawZipSha = true;
            } else if (ln.startsWith("file=")) {
                if (outFiles.size() >= MAX_FILES) throw new BundleError("文件数超过上限 " + MAX_FILES);
                String rest = ln.substring(5);
                int sp1 = rest.indexOf(' ');
                int sp2 = sp1 < 0 ? -1 : rest.indexOf(' ', sp1 + 1);
                if (sp1 <= 0 || sp2 < 0) throw new BundleError("file= 行格式错误");
                String h = rest.substring(0, sp1).toLowerCase(Locale.ROOT);
                long size = parseLong(rest.substring(sp1 + 1, sp2));
                String p = rest.substring(sp2 + 1);
                if (h.length() != 64) throw new BundleError("哈希长度不是 64：" + p);
                if (size < 0) throw new BundleError("字节数为负：" + p);
                checkRel(p);
                outFiles.add(new FileEntry(p, size, h));
            }
            // 其它行：忽略（向前兼容）
        }
        if (m.v.isEmpty()) throw new BundleError("payload 缺少 v");
        if (m.code <= 0) throw new BundleError("payload 缺少 code");
        if (m.minNative < 0) throw new BundleError("payload 缺少 minNative");
        if (m.zip.isEmpty() || m.zip.indexOf('/') >= 0 || m.zip.indexOf('\\') >= 0) throw new BundleError("zip 名非法");
        if (!sawZipSha || m.zipSha256.length() != 64) throw new BundleError("payload 缺少 zipSha256");
        Set<String> seen = new HashSet<>();
        for (FileEntry f : outFiles) {
            if (!seen.add(f.p)) throw new BundleError("文件重复列出：" + f.p);
        }
        return m;
    }

    private static long parseLong(String s) throws BundleError {
        try {
            return Long.parseLong(s.trim());
        } catch (NumberFormatException e) {
            throw new BundleError("数字字段非法：" + s);
        }
    }

    /** 相对路径白名单校验：必须是干净的相对路径（防目录穿越 / 绝对路径 / 反斜杠）。 */
    public static void checkRel(String rel) throws BundleError {
        if (rel == null || rel.isEmpty()) throw new BundleError("空路径");
        if (rel.length() > MAX_PATH_LEN) throw new BundleError("路径过长：" + rel);
        if (rel.charAt(0) == '/' || rel.charAt(0) == '\\') throw new BundleError("绝对路径：" + rel);
        if (rel.indexOf('\\') >= 0) throw new BundleError("路径含反斜杠：" + rel);
        if (rel.indexOf('\0') >= 0) throw new BundleError("路径含 NUL");
        if (rel.length() > 1 && rel.charAt(1) == ':') throw new BundleError("路径含盘符：" + rel);
        String[] parts = rel.split("/", -1);
        for (String seg : parts) {
            if (seg.isEmpty()) throw new BundleError("路径含空段：" + rel);
            if (".".equals(seg) || "..".equals(seg)) throw new BundleError("路径含穿越段：" + rel);
        }
    }

    // ===== 验签 =====

    /** RSA-SHA256(PKCS#1 v1.5) 验签；publicKeyDer 为 X.509 SubjectPublicKeyInfo（SPKI）编码。 */
    public static void verifySignature(byte[] publicKeyDer, byte[] payload, byte[] sig) throws BundleError {
        try {
            PublicKey pk = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(publicKeyDer));
            Signature verifier = Signature.getInstance("SHA256withRSA");
            verifier.initVerify(pk);
            verifier.update(payload);
            if (!verifier.verify(sig)) throw new BundleError("签名校验不通过");
        } catch (BundleError e) {
            throw e;
        } catch (Exception e) {
            throw new BundleError("验签异常：" + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    public static byte[] base64Decode(String s) throws BundleError {
        try {
            return Base64.getDecoder().decode(s.trim());
        } catch (IllegalArgumentException e) {
            throw new BundleError("base64 解码失败");
        }
    }

    // ===== 哈希 =====

    public static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return toHex(md.digest(data));
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    public static String sha256Hex(File f) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            }
            return toHex(md.digest());
        } catch (IOException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    private static String toHex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) {
            sb.append(Character.forDigit((x >> 4) & 0xF, 16));
            sb.append(Character.forDigit(x & 0xF, 16));
        }
        return sb.toString();
    }

    // ===== 解包 =====

    /**
     * 解压 zip 到 dest（dest 必须为空目录或不存在，由调用方保证）。
     * 防护：路径穿越、重复条目、文件数/总字节上限。
     * @return 解出的相对路径列表
     */
    public static List<String> extractZip(File zip, File dest) throws IOException, BundleError {
        List<String> out = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        long total = 0;
        try (ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry e;
            byte[] buf = new byte[65536];
            while ((e = zin.getNextEntry()) != null) {
                String name = e.getName();
                if (e.isDirectory()) continue;
                checkRel(name);
                if (!seen.add(name)) throw new BundleError("zip 内条目重复：" + name);
                if (out.size() >= MAX_FILES) throw new BundleError("zip 文件数超过上限");
                File target = new File(dest, name);
                File parent = target.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("建目录失败：" + parent);
                try (BufferedOutputStream os = new BufferedOutputStream(new FileOutputStream(target))) {
                    int n;
                    while ((n = zin.read(buf)) != -1) {
                        total += n;
                        if (total > MAX_TOTAL_BYTES) throw new BundleError("解包总字节超过上限");
                        os.write(buf, 0, n);
                    }
                }
                out.add(name);
            }
        }
        return out;
    }

    /** 逐个校验 payload 列出的文件：存在、大小一致、sha256 一致。 */
    public static void verifyTree(File root, List<FileEntry> files) throws IOException, BundleError {
        for (FileEntry f : files) {
            File t = new File(root, f.p);
            if (!t.isFile()) throw new BundleError("缺少文件：" + f.p);
            if (f.s >= 0 && t.length() != f.s) throw new BundleError("字节数不符：" + f.p + "（" + t.length() + "≠" + f.s + "）");
            String h = sha256Hex(t);
            if (!h.equals(f.h)) throw new BundleError("哈希不符：" + f.p);
        }
    }

    /** 把 source 里有、dest 里没有的文件补齐进 dest（客户端资源里的字体等大文件走这条路，不进 zip）。 */
    public static int seedMissing(File dest, Source source) throws IOException, BundleError {
        List<String> rels = source.list();
        int n = 0;
        byte[] buf = new byte[65536];
        for (String rel : rels) {
            checkRel(rel);
            File target = new File(dest, rel);
            if (target.exists()) continue;
            File parent = target.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) throw new IOException("建目录失败：" + parent);
            try (InputStream in = new BufferedInputStream(source.open(rel));
                 BufferedOutputStream os = new BufferedOutputStream(new FileOutputStream(target))) {
                int c;
                while ((c = in.read(buf)) != -1) os.write(buf, 0, c);
            }
            n++;
        }
        return n;
    }

    /** 安装前必须存在的文件（缺一个就是坏包）。 */
    public static void requireIndex(File root) throws BundleError {
        if (!new File(root, "index.html").isFile()) throw new BundleError("包内缺少 index.html");
    }

    public static byte[] readAll(InputStream in, long cap) throws IOException, BundleError {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        long total = 0;
        int n;
        while ((n = in.read(buf)) != -1) {
            total += n;
            if (cap > 0 && total > cap) throw new BundleError("内容超过上限 " + cap);
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    public static long dirSize(File dir) {
        long n = 0;
        File[] kids = dir.listFiles();
        if (kids == null) return 0;
        for (File f : kids) n += f.isDirectory() ? dirSize(f) : f.length();
        return n;
    }

    public static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteRecursive(k);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
