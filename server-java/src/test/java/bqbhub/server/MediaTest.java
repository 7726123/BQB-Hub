package bqbhub.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 内容载荷安全：
 *   ① 封面 data URI 必须**整串**匹配（只校验前缀时，载荷里带一个引号就能闭合 <img src> 属性注入 onerror）；
 *   ② 磁盘载荷路径不许越出 uploadDir（文件名来自请求体，`../` 与绝对路径都要挡住）。
 */
class MediaTest {

    @TempDir
    Path tmp;

    private AppConfig cfg() {
        return new AppConfig(Map.of(
                "UPLOAD_DIR", tmp.toString(),
                "CONFIG_FILE", tmp.resolve("config.json").toString()));
    }

    @Test
    void 封面_接受纯base64图片dataURI() {
        assertTrue(Media.validCover("data:image/png;base64," + "A".repeat(16)));
        assertTrue(Media.validCover("data:image/jpeg;base64,AAAA/+8="));
        assertTrue(Media.validCover("data:image/jpg;base64,AAAA/+8="));
        assertTrue(Media.validCover("data:image/webp;base64,AAAA/+8="));
        assertTrue(Media.validCover("data:image/gif;base64,R0lGODlh"));
        assertTrue(Media.validCover("data:image/png;base64," + "A".repeat(64 * 1024)));
    }

    @Test
    void 封面_拒绝注入与非法载荷() {
        assertFalse(Media.validCover(null));
        assertFalse(Media.validCover(""));
        assertFalse(Media.validCover("data:image/png;base64,AAA\" onload=\"alert(1)"));
        assertFalse(Media.validCover("data:image/png;base64,AAA' onerror='alert(1)"));
        assertFalse(Media.validCover("data:image/png;base64,AAA>alert(1)"));
        assertFalse(Media.validCover("data:image/svg+xml;base64,AAAA"));
        assertFalse(Media.validCover("data:text/html;base64,AAAA"));
        assertFalse(Media.validCover("data:image/png;base64,AAAA "));
        assertFalse(Media.validCover("data:image/png,AAAA"));                       // 少了 ;base64
        assertFalse(Media.validCover("data:image/png;base64,AAA" + "\n" + "AAA"));  // 换行
        assertFalse(Media.validCover("data:image/png;base64,A=A=A"));               // = 只能收尾
        assertFalse(Media.validCover("data:image/png;base64," + "A".repeat(Media.COVER_MAX)));  // 超长
    }

    @Test
    void 载荷路径_世界书与预设() {
        Path root = tmp.normalize();
        List<Path> wb = Media.payloadPaths(cfg(), "worldbook", "abc.json", null);
        assertEquals(1, wb.size());
        assertEquals(root.resolve("worldbook").resolve("abc.json"), wb.get(0));

        List<Path> ps = Media.payloadPaths(cfg(), "preset", "p.json", null);
        assertEquals(1, ps.size());
        assertEquals(root.resolve("preset").resolve("p.json"), ps.get(0));

        assertTrue(Media.payloadPaths(cfg(), "unknown", "x", null).isEmpty());
    }

    @Test
    void 载荷路径_插件含zip且两个都在根内() {
        List<Path> p = Media.payloadPaths(cfg(), "plugin", "m.json", "plug-1");
        assertEquals(2, p.size());
        Path root = tmp.normalize();
        for (Path x : p) assertTrue(x.startsWith(root), x.toString());
        assertTrue(p.contains(root.resolve("plugin").resolve("files").resolve("plug-1.zip")));
    }

    @Test
    void 载荷路径_出不了上传根() {
        for (String bad : new String[]{"../../etc/passwd", "..", "/etc/passwd", "/tmp/x.json", "a/../../../x"}) {
            assertTrue(Media.payloadPaths(cfg(), "worldbook", bad, null).isEmpty(), "不该放行：" + bad);
        }
        // 边界是 uploadDir 本身（不强制落进 worldbook 子目录）：往上一层但仍留在根内的路径按现状放行。
        // 不是安全洞（最终仍是根内的文件），钉住现状免得以后误判"一定在世界书子目录里"。
        List<Path> up = Media.payloadPaths(cfg(), "worldbook", "../x.json", null);
        assertEquals(1, up.size());
        assertEquals(tmp.normalize().resolve("x.json"), up.get(0));
        // 子目录（仍在根内）按现状放行
        assertEquals(1, Media.payloadPaths(cfg(), "worldbook", "sub/dir.json", null).size());
    }

    @Test
    void 删除载荷_bestEffort() throws Exception {
        Path f = tmp.resolve("worldbook").resolve("gone.json");
        Files.createDirectories(f.getParent());
        Files.write(f, "x".getBytes(StandardCharsets.UTF_8));
        assertTrue(Files.exists(f));

        assertEquals(1, Media.removePayload(cfg(), "worldbook", "gone.json", null));
        assertFalse(Files.exists(f));
        // 返回的是**尝试删除的路径数**（与 Node 版口径一致）：文件已经没了也照样算 1
        assertEquals(1, Media.removePayload(cfg(), "worldbook", "gone.json", null));
        assertEquals(0, Media.removePayload(cfg(), "unknown-type", "x", null));
    }
}
