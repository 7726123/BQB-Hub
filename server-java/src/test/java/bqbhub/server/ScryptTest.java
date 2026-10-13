package bqbhub.server;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 口令派生（登录口令 A 规格 + 管理员口令 B 规格）。
 *
 * 最要紧的是**跨语言夹具**：`server/tools/scrypt-parity/*.tsv` 是 Node 侧生成的固定向量，
 * 以前只有那个手工跑的对拍脚本会验；现在每次 `mvn test` / CI 都验——
 * 这两条规格一旦漂移，全部老用户登不进来、线上管理员口令失效。
 */
class ScryptTest {

    // ---------------------------------------------------------------- 往返与格式

    @Test
    void 登录口令_生成与校验往返() {
        String[] h = Scrypt.hashLogin("pw-测试-🌙");
        assertEquals(32, h[0].length(), "盐是 16 字节的 hex 字符串（32 个 ASCII 字符）");
        assertEquals(128, h[1].length(), "登录哈希是 64 字节的 hex（128 个 ASCII 字符）");
        assertTrue(Scrypt.verifyLogin("pw-测试-🌙", h[0], h[1]));
        assertFalse(Scrypt.verifyLogin("pw-测试-🌙2", h[0], h[1]));
        assertFalse(Scrypt.verifyLogin("", h[0], h[1]));
        assertFalse(Scrypt.verifyLogin("x", "", h[1]));
        assertFalse(Scrypt.verifyLogin("x", h[0], ""));
        assertFalse(Scrypt.verifyLogin("x", null, h[1]));
        assertFalse(Scrypt.verifyLogin("x", h[0], null));
    }

    @Test
    void 登录口令_库里存大写hex也要认() {
        // Java 侧比对做了大小写归一（Node 版是直接 hex 对 hex）。历史数据一律小写，
        // 这里只是把「更宽松」这一现状钉住，避免以后被"优化"掉。
        String[] h = Scrypt.hashLogin("Abc-123");
        assertTrue(Scrypt.verifyLogin("Abc-123", h[0], h[1].toUpperCase()));
    }

    @Test
    void 管理员口令_生成格式与校验往返() {
        String stored = Scrypt.hashAdmin("admin-pw-测试");
        assertTrue(stored.matches("^scrypt\\$16384\\$8\\$1\\$[A-Za-z0-9+/]+={0,2}\\$[A-Za-z0-9+/]+={0,2}$"), stored);
        assertTrue(Scrypt.verifyAdmin("admin-pw-测试", stored));
        assertFalse(Scrypt.verifyAdmin("admin-pw-测试2", stored));
        assertFalse(Scrypt.verifyAdmin("x", null));
        assertFalse(Scrypt.verifyAdmin("x", ""));
        assertFalse(Scrypt.verifyAdmin("x", "bcrypt$1$2$3$4$5"));
        assertFalse(Scrypt.verifyAdmin("x", "scrypt$16384$8$1$AAAA$BBBB"));  // 长度不足也会算出来但不相等
        assertFalse(Scrypt.verifyAdmin("x", "scrypt$16384$8$1$$"));
        assertFalse(Scrypt.verifyAdmin("x", "scrypt$abc$8$1$AAAA$BBBB"));   // 参数非数字
    }

    // ---------------------------------------------------------------- 跨语言夹具

    @Test
    void 跨语言夹具_Node生成的登录口令() throws Exception {
        List<String[]> rows = fixture("fixtures.tsv", 4);
        assertTrue(rows.size() >= 7, "夹具至少要 7 条，实际 " + rows.size());
        for (String[] r : rows) {
            String password = new String(hexToBytes(r[1]), StandardCharsets.UTF_8);
            String saltRaw = r[2];
            String expect = r[3];
            assertTrue(Scrypt.verifyLogin(password, saltRaw, expect),
                    "夹具未通过：" + r[0] + "（盐按字符串的 UTF-8 字节参与，不是 hex 解码）");
            assertFalse(Scrypt.verifyLogin(password + "x", saltRaw, expect), "夹具反向不应通过：" + r[0]);
        }
    }

    @Test
    void 跨语言夹具_Node生成的管理员口令() throws Exception {
        List<String[]> rows = fixture("admin-fixtures.tsv", 4);
        assertTrue(rows.size() >= 2, "夹具至少要 2 条，实际 " + rows.size());
        for (String[] r : rows) {
            String password = new String(hexToBytes(r[1]), StandardCharsets.UTF_8);
            String stored = r[3];
            assertNotNull(stored);
            assertTrue(Scrypt.verifyAdmin(password, stored), "夹具未通过：" + r[0]);
            assertFalse(Scrypt.verifyAdmin(password + "x", stored), "夹具反向不应通过：" + r[0]);
        }
    }

    // ---------------------------------------------------------------- 工具

    /** 读 `server/tools/scrypt-parity/<file>`：TAB 分隔，跳过 # 注释行 */
    private static List<String[]> fixture(String file, int cols) throws Exception {
        Path p = Path.of("..", "server", "tools", "scrypt-parity", file).toAbsolutePath().normalize();
        assertTrue(Files.isRegularFile(p), "夹具文件不存在：" + p);
        List<String[]> out = new ArrayList<>();
        for (String line : Files.readAllLines(p, StandardCharsets.UTF_8)) {
            if (line.isBlank() || line.startsWith("#")) continue;
            String[] parts = line.split("\t", -1);
            assertEquals(cols, parts.length, "夹具列数不对：" + line);
            out.add(parts);
        }
        return out;
    }

    private static byte[] hexToBytes(String hex) {
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }
}
