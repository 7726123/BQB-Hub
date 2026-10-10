package bqbhub.server;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/**
 * 内容载荷工具（逐条对应 server/src/media.js）：
 *   封面 data URI 的**整串**校验 + 磁盘载荷清理。
 *
 * 封面为什么必须整串校验：cover 会被拼进 <img src="..."> 属性，老客户端没做转义且改不动，
 * 只校验前缀时载荷里带一个引号就能闭合属性注入 onerror → 存储型 XSS。因此只接受
 * 「纯 base64 的图片 data URI」，多一个字符都不放过（契约测试 cover.test.js 就是钉这个）。
 */
public final class Media {

    public static final int COVER_MAX = 320 * 1024;
    private static final Pattern COVER_RE = Pattern.compile("^data:image/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$");

    private Media() {
    }

    public static boolean validCover(String s) {
        return s != null && s.length() <= COVER_MAX && COVER_RE.matcher(s).matches();
    }

    /** 某条内容的磁盘载荷相对路径（世界书/预设的 JSON、插件的清单与 zip） */
    public static List<Path> payloadPaths(AppConfig cfg, String type, String filename, String pluginId) {
        Path root = cfg.uploadDir.normalize();
        List<Path> out = new ArrayList<>();
        if ("worldbook".equals(type)) {
            addInside(out, root, root.resolve("worldbook").resolve(Validators.str(filename)));
        } else if ("preset".equals(type)) {
            addInside(out, root, root.resolve("preset").resolve(Validators.str(filename)));
        } else if ("plugin".equals(type)) {
            addInside(out, root, root.resolve("plugin").resolve(Validators.str(filename)));
            addInside(out, root, root.resolve("plugin").resolve("files").resolve(Validators.str(pluginId) + ".zip"));
        }
        return out;
    }

    private static void addInside(List<Path> out, Path root, Path p) {
        Path abs = p.normalize();
        if (abs.startsWith(root) && !abs.equals(root)) out.add(abs);
    }

    /** 删除载荷（best-effort：不存在/已删都算成功） */
    public static int removePayload(AppConfig cfg, String type, String filename, String pluginId) {
        int n = 0;
        for (Path p : payloadPaths(cfg, type, filename, pluginId)) {
            try {
                Files.deleteIfExists(p);
                n++;
            } catch (IOException e) { /* 不存在或已删 */ }
        }
        return n;
    }
}
