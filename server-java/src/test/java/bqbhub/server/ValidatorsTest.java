package bqbhub.server;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 输入校验与取值：重点是 num/numLong 的语义（对应 JS 的 `Number(x) || dflt`）与 int 截断回归。 */
class ValidatorsTest {

    @Test
    void numLong_毫秒时间戳原样往返() {
        // 线上事故回归（2026-10-11）：时间戳走 num() 会被 Number.intValue() 截成低 32 位
        // （1791740506926 → 739144494，即 1970 年），client_logs / admin_traces 全被写坏。
        // 长整数字段（毫秒时间戳）必须走 numLong。
        long ts = 1791740506926L;
        assertEquals(ts, Validators.numLong(ts, 0));
        assertEquals(ts, Validators.numLong(String.valueOf(ts), 0));
        assertEquals(ts, Validators.numLong(String.valueOf(ts), 1));
        assertEquals(ts, Validators.numLong((double) ts, 0));
        assertEquals(739144494, Validators.num((Object) ts, 0));   // num 只能用于小量级的值
        assertNotEquals(ts, (long) Validators.num((Object) ts, 0));
    }

    @Test
    void numLong_边界与缺省() {
        assertEquals(7L, Validators.numLong((Object) null, 7L));
        assertEquals(7L, Validators.numLong("", 7L));
        assertEquals(7L, Validators.numLong("abc", 7L));
        assertEquals(7L, Validators.numLong(0L, 7L));          // 0 → 缺省（对应 JS 的 || dflt）
        assertEquals(7L, Validators.numLong("0", 7L));
        assertEquals(-5L, Validators.numLong("-5", 7L));
        assertEquals(2147483648L, Validators.numLong("2147483648", 0));  // 超过 int 上界
        assertEquals(Long.MAX_VALUE, Validators.numLong(String.valueOf(Long.MAX_VALUE), 0));
    }

    @Test
    void num_整数语义() {
        assertEquals(20, Validators.num((Object) null, 20));
        assertEquals(20, Validators.num("", 20));
        assertEquals(20, Validators.num("abc", 20));
        assertEquals(20, Validators.num(0, 20));               // 0 → 缺省
        assertEquals(20, Validators.num("0", 20));
        assertEquals(12, Validators.num((Object) "12.9", 20));  // Object 重载：先转 double 再截断（JS 语义）
        assertEquals(12, Validators.num(12.9d, 20));
        assertEquals(20, Validators.num("12.9", 20));           // String 重载走 parseInt：小数串解析失败 → 缺省
        assertEquals(20, Validators.num("NaN", 20));
        assertEquals(20, Validators.num("1791740506926", 20));  // 字符串形式超 int → 解析失败回落缺省
    }

    @Test
    void cut_按UTF16截断() {
        assertEquals("中文", Validators.cut("中文abc", 2));
        assertEquals("abc", Validators.cut("abc", 10));
        assertEquals("", Validators.cut((String) null, 5));
        assertEquals("", Validators.cut((Object) null, 5));
        assertEquals("12", Validators.cut(123, 2));             // 数字先转字符串
        assertEquals("🌙", Validators.cut("🌙x", 2));            // 代理对按两个 char 算（与 JS slice 一致）
    }

    @Test
    void cpLen_按码点计数() {
        assertEquals(0, Validators.cpLen(null));
        assertEquals(2, Validators.cpLen("中文"));
        assertEquals(1, Validators.cpLen("🌙"));                 // emoji 算 1（前端 300 字上限的口径）
        assertEquals(2, Validators.cpLen("🌙x"));
    }

    @Test
    void 用户名() {
        assertTrue(Validators.validUsername("ab"));
        assertTrue(Validators.validUsername("中文名字"));
        assertTrue(Validators.validUsername("a_b9"));
        assertTrue(Validators.validUsername("x".repeat(Validators.USERNAME_MAX)));
        assertFalse(Validators.validUsername(null));
        assertFalse(Validators.validUsername("a"));
        assertFalse(Validators.validUsername("x".repeat(Validators.USERNAME_MAX + 1)));
        assertFalse(Validators.validUsername("a b"));
        assertFalse(Validators.validUsername("a-b"));
    }

    @Test
    void 口令长度() {
        assertTrue(Validators.validPassword("1234"));
        assertTrue(Validators.validPassword("x".repeat(64)));
        assertFalse(Validators.validPassword(null));
        assertFalse(Validators.validPassword("123"));
        assertFalse(Validators.validPassword("x".repeat(65)));
    }

    @Test
    void 邮箱() {
        assertTrue(Validators.validEmail("a@b.co"));
        assertTrue(Validators.validEmail("a.b+c@sub.example.com"));
        assertFalse(Validators.validEmail(null));
        assertFalse(Validators.validEmail("a@b"));
        assertFalse(Validators.validEmail("a b@c.com"));
        assertFalse(Validators.validEmail("a@" + "x".repeat(64) + ".com"));
    }

    @Test
    void 验证码与安装标识() {
        assertTrue(Validators.validCode("123456"));
        assertFalse(Validators.validCode("12345"));
        assertFalse(Validators.validCode("12345a"));
        assertFalse(Validators.validCode(null));

        assertTrue(Validators.validInstallId("abcdefgh"));
        assertTrue(Validators.validInstallId("A_-9".repeat(16)));
        assertFalse(Validators.validInstallId("abcdefg"));
        assertFalse(Validators.validInstallId("abc!efgh"));
        assertFalse(Validators.validInstallId("x".repeat(65)));
        assertFalse(Validators.validInstallId(null));
    }

    @Test
    void str与trim() {
        assertEquals("", Validators.str(null));
        assertEquals("12", Validators.str(12));
        assertEquals("", Validators.trim(null));
        assertEquals("x", Validators.trim("  x "));
    }
}
