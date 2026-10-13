package bqbhub.server.card;

import bqbhub.server.ApiError;
import bqbhub.server.AuthService;
import bqbhub.server.SchemaMigrations;
import bqbhub.server.TestDb;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 卡片社交的计数口径与权限（原 CardController 的三段事务）：
 * 点赞切换幂等、评论的 comments/commenters 维护、软删除按「评论原作者」回退计数、删除权限。
 */
class CardServiceTest {

    @TempDir
    Path tmp;

    private JdbcTemplate jdbc;
    private CardService svc;
    private AuthService.User alice;   // 卡作者
    private AuthService.User bob;     // 路人
    private AuthService.User carol;   // 另一个路人
    private long cardId;

    @BeforeEach
    void setUp() {
        DataSource ds = TestDb.dataSource(tmp.resolve("card.db"));
        jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(jdbc).run();
        svc = new CardService(new CardRepository(jdbc), new DataSourceTransactionManager(ds));
        alice = new AuthService.User(1, "alice", "");
        bob = new AuthService.User(2, "bob", "");
        carol = new AuthService.User(3, "carol", "");
        jdbc.update("INSERT INTO world_books (title, author_id, author_name, filename, created_at, status) VALUES ('卡', 1, 'alice', 'a.json', 1, 'approved')");
        cardId = jdbc.queryForObject("SELECT id FROM world_books", Long.class);
    }

    private static String err(Runnable r) {
        return assertThrows(ApiError.class, r::run).body.get("error").toString();
    }

    private Map<String, Object> likeBody() {
        return Map.of("type", "worldbook", "id", cardId);
    }

    private Map<String, Object> commentBody(String content) {
        return Map.of("type", "worldbook", "id", cardId, "content", content);
    }

    @Test
    void 点赞切换_计数跟着明细走() {
        Map<String, Object> first = svc.like(likeBody(), bob, false);
        assertEquals(Map.of("ok", true, "liked", true, "likes", 1L), first);
        assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM card_likes", Integer.class));

        Map<String, Object> second = svc.like(likeBody(), bob, false);
        assertEquals(false, second.get("liked"));
        assertEquals(0L, second.get("likes"));
        assertEquals(0, jdbc.queryForObject("SELECT COUNT(*) FROM card_likes", Integer.class));

        // 两个人各赞一次 → 计数 2；第三人取消不影响别人
        svc.like(likeBody(), bob, false);
        svc.like(likeBody(), carol, false);
        assertEquals(2L, jdbc.queryForObject("SELECT likes FROM world_books WHERE id = ?", Long.class, cardId));
    }

    @Test
    void 点赞与评论_未过审的卡按不存在处理() {
        jdbc.update("UPDATE world_books SET status = 'pending' WHERE id = ?", cardId);
        assertEquals("未找到该卡片", err(() -> svc.like(likeBody(), bob, false)));
        assertEquals("未找到该卡片", err(() -> svc.comment(commentBody("hi"), bob, false)));
        // 作者自己与管理员仍可用
        assertTrue(svc.like(likeBody(), alice, false).containsKey("liked"));
        assertTrue(svc.like(likeBody(), bob, true).containsKey("liked"));
        // 未知类型
        assertEquals("未知的卡片类型", err(() -> svc.like(Map.of("type", "nope", "id", 1), bob, false)));
    }

    @Test
    void 评论_计数与去重人数() {
        Map<String, Object> out = svc.comment(commentBody("第一条"), bob, false);
        assertTrue(out.containsKey("comment"));
        assertEquals(1L, jdbc.queryForObject("SELECT comments FROM world_books WHERE id = ?", Long.class, cardId));
        assertEquals(1L, jdbc.queryForObject("SELECT commenters FROM world_books WHERE id = ?", Long.class, cardId));

        // 同一个人再评一条：comments+1，commenters 不变
        svc.comment(commentBody("第二条"), bob, false);
        assertEquals(2L, jdbc.queryForObject("SELECT comments FROM world_books WHERE id = ?", Long.class, cardId));
        assertEquals(1L, jdbc.queryForObject("SELECT commenters FROM world_books WHERE id = ?", Long.class, cardId));

        // 换个人评：两个都 +1
        svc.comment(commentBody("第三条"), carol, false);
        assertEquals(3L, jdbc.queryForObject("SELECT comments FROM world_books WHERE id = ?", Long.class, cardId));
        assertEquals(2L, jdbc.queryForObject("SELECT commenters FROM world_books WHERE id = ?", Long.class, cardId));

        assertEquals("评论内容不能为空", err(() -> svc.comment(commentBody("   "), bob, false)));
        assertEquals("评论不能超过 500 字", err(() -> svc.comment(commentBody("字".repeat(501)), bob, false)));
    }

    @Test
    void 评论列表_倒序分页与total口径() {
        for (int i = 1; i <= 5; i++) svc.comment(commentBody("c" + i), bob, false);
        Map<String, Object> page1 = svc.comments("worldbook", String.valueOf(cardId), "2", null, bob);
        assertEquals(2, ((List<?>) page1.get("comments")).size());
        assertEquals(5L, page1.get("total"));
        assertEquals(bob.id, page1.get("mine"));
        assertTrue(String.valueOf(page1.get("comments")).contains("c5"), "倒序：最新的在前");

        long lastId = jdbc.queryForObject("SELECT MAX(id) FROM card_comments", Long.class);
        Map<String, Object> page2 = svc.comments("worldbook", String.valueOf(cardId), "2", String.valueOf(lastId), bob);
        assertTrue(String.valueOf(page2.get("comments")).contains("c3"));

        // 卡片不存在：不报 404，total 回 0
        Map<String, Object> gone = svc.comments("worldbook", "9999", "10", null, bob);
        assertEquals(0L, gone.get("total"));
        assertEquals("未知的卡片类型", err(() -> svc.comments("nope", "1", "10", null, bob)));
    }

    @Test
    void 删除评论_软删除与按原作者回退计数() {
        svc.comment(commentBody("bob1"), bob, false);
        long bob1 = jdbc.queryForObject("SELECT MIN(id) FROM card_comments", Long.class);
        svc.comment(commentBody("bob2"), bob, false);
        svc.comment(commentBody("carol1"), carol, false);
        assertEquals(2L, jdbc.queryForObject("SELECT commenters FROM world_books WHERE id = ?", Long.class, cardId), "bob 两条只算一个人");

        // bob 还有另一条 → 只减 comments
        assertEquals(Map.of("ok", true), svc.deleteComment(String.valueOf(bob1), bob, false));
        assertEquals(1, jdbc.queryForObject("SELECT deleted FROM card_comments WHERE id = ?", Integer.class, bob1));
        assertEquals(2L, jdbc.queryForObject("SELECT comments FROM world_books WHERE id = ?", Long.class, cardId));
        assertEquals(2L, jdbc.queryForObject("SELECT commenters FROM world_books WHERE id = ?", Long.class, cardId));

        // 删 bob 最后一条 → comments 与 commenters 都减
        long bob2 = jdbc.queryForObject("SELECT MAX(id) FROM card_comments WHERE user_id = 2", Long.class);
        svc.deleteComment(String.valueOf(bob2), bob, false);
        assertEquals(1L, jdbc.queryForObject("SELECT comments FROM world_books WHERE id = ?", Long.class, cardId));
        assertEquals(1L, jdbc.queryForObject("SELECT commenters FROM world_books WHERE id = ?", Long.class, cardId));

        // 权限：路人 403；卡作者能删别人的；管理员能删
        long carol1 = jdbc.queryForObject("SELECT MAX(id) FROM card_comments", Long.class);
        AuthService.User stranger = new AuthService.User(9, "stranger", "");
        assertEquals("只能删除自己的评论", err(() -> svc.deleteComment(String.valueOf(carol1), stranger, false)));
        assertEquals(Map.of("ok", true), svc.deleteComment(String.valueOf(carol1), alice, false));
        assertEquals("未找到该评论", err(() -> svc.deleteComment(String.valueOf(carol1), alice, false)));
    }
}
