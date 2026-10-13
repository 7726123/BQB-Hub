package bqbhub.server;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 管理员留档令牌（无状态 HMAC，"exp.mac"）。
 * 格式必须与 Node 版逐字节一致：切换期间 App 上已签发的 12 小时令牌要仍然有效，回滚同理。
 */
class AdminTokenTest {

    private static final String STORED =
            "scrypt$16384$8$1$ABEiM0RVZneImaq7zN3u/w==$P4dQtSfNzmeTyYzc1cV/dJ0birTAVe2KmmOw5SVBRsQ=";

    @Test
    void 签发与校验往返() {
        String tok = AdminToken.issue(STORED);
        assertNotNull(tok);
        assertTrue(tok.matches("\\d+\\.[A-Za-z0-9_-]+"), tok);
        assertTrue(AdminToken.verify(STORED, tok));
    }

    @Test
    void 换密钥或篡改一律不认() {
        String tok = AdminToken.issue(STORED);
        assertFalse(AdminToken.verify(STORED + "x", tok));
        assertFalse(AdminToken.verify(STORED, tok + "A"));
        String exp = tok.substring(0, tok.indexOf('.'));
        assertFalse(AdminToken.verify(STORED, exp + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
        assertFalse(AdminToken.verify(STORED, (Long.parseLong(exp) + 1) + tok.substring(tok.indexOf('.'))));
    }

    @Test
    void 格式不对或未配置一律false() {
        assertFalse(AdminToken.verify(STORED, null));
        assertFalse(AdminToken.verify(STORED, ""));
        assertFalse(AdminToken.verify(STORED, "123"));
        assertFalse(AdminToken.verify(STORED, "1.2.3"));
        assertFalse(AdminToken.verify(STORED, "abc.def"));
        assertFalse(AdminToken.verify("", AdminToken.issue(STORED)));
        assertFalse(AdminToken.verify(null, AdminToken.issue(STORED)));
        assertNull(AdminToken.issue(""));
        assertNull(AdminToken.issue(null));
    }

    @Test
    void 过期令牌不再有效() {
        long past = System.currentTimeMillis() - 1000;
        assertFalse(AdminToken.verify(STORED, AdminToken.issueForExp(STORED, past)));
        long future = System.currentTimeMillis() + 60_000;
        assertTrue(AdminToken.verify(STORED, AdminToken.issueForExp(STORED, future)));
        // expFor 返回的过期时间戳要能直接放进响应体（App 用它算剩余有效期）
        long exp = AdminToken.expFor(60_000);
        assertTrue(exp >= System.currentTimeMillis() + 59_000 && exp <= System.currentTimeMillis() + 61_000, "expFor=" + exp);
    }

    @Test
    void 跨语言固定向量_Node签发的令牌Java要认() {
        // 由 Node 版 adminpass.issueToken 的同一算法生成（mac = base64url(HMAC-SHA256(key=storedHash,
        // msg="admin-trace:"+exp))），固定 exp=2100-01-01 免得随时间过期。
        String tok = "4102444800000.VFaz5Vb9rQ8ciNVXZIH-I8Yag0z5NMtXiTJ2yYycNbg";
        assertTrue(AdminToken.verify(STORED, tok));
        assertFalse(AdminToken.verify(STORED, "4102444800000.VFaz5Vb9rQ8ciNVXZIH-I8Yag0z5NMtXiTJ2yYycNbh"));
    }
}
