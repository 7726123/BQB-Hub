package bqbhub.server.card;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.Statement;
import java.util.List;
import java.util.Map;

/**
 * 卡片社交的读写（SQL 逐字来自原 CardController）：
 * 明细行（card_likes / card_comments）+ 卡片行上的计数缓存列。
 * SQL 里会出现「表名拼接」——只用 {@link #tableFor} 的白名单结果，别处不要自己拼。
 * 事务边界与计数口径在 {@link CardService}。
 */
@Repository
public class CardRepository {

    private final JdbcTemplate jdbc;

    public CardRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 卡片类型 → 表名（白名单，防注入；对应 card.js 的 TABLES） */
    static String tableFor(String type) {
        if (type == null) return null;
        return switch (type) {
            case "worldbook" -> "world_books";
            case "preset" -> "presets";
            default -> null;
        };
    }

    /** 卡片行（是否存在的判定 + 作者/状态，可见性过滤在 Service） */
    Map<String, Object> cardRow(String table, long id) {
        return firstRow("SELECT id, author_id, status FROM " + table + " WHERE id = ?", id);
    }

    // ---------------------------------------------------------------- 点赞

    boolean hasLike(String type, long id, long userId) {
        return !jdbc.queryForList("SELECT 1 FROM card_likes WHERE target_type = ? AND target_id = ? AND user_id = ?",
                type, id, userId).isEmpty();
    }

    void insertLike(String type, long id, long userId, long now) {
        jdbc.update("INSERT INTO card_likes (target_type, target_id, user_id, created_at) VALUES (?, ?, ?, ?)",
                type, id, userId, now);
    }

    void deleteLike(String type, long id, long userId) {
        jdbc.update("DELETE FROM card_likes WHERE target_type = ? AND target_id = ? AND user_id = ?", type, id, userId);
    }

    void incrementLikes(String table, long id) {
        jdbc.update("UPDATE " + table + " SET likes = likes + 1 WHERE id = ?", id);
    }

    void decrementLikes(String table, long id) {
        jdbc.update("UPDATE " + table + " SET likes = MAX(0, likes - 1) WHERE id = ?", id);
    }

    long likesOf(String table, long id) {
        List<Map<String, Object>> row = jdbc.queryForList("SELECT likes FROM " + table + " WHERE id = ?", id);
        Object lv = row.isEmpty() ? null : row.get(0).get("likes");
        return lv instanceof Number n ? n.longValue() : 0;
    }

    // ---------------------------------------------------------------- 评论

    List<Map<String, Object>> commentsDesc(String type, long cardId, int limit) {
        return jdbc.queryForList("SELECT id, user_id, username, content, created_at FROM card_comments "
                + "WHERE target_type = ? AND target_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?",
                type, cardId, limit);
    }

    List<Map<String, Object>> commentsDescBefore(String type, long cardId, long beforeId, int limit) {
        return jdbc.queryForList("SELECT id, user_id, username, content, created_at FROM card_comments "
                + "WHERE target_type = ? AND target_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?",
                type, cardId, beforeId, limit);
    }

    /** 卡片行上的评论数缓存列（卡片不存在时由调用方回 0） */
    Long commentsCacheOf(String table, long cardId) {
        List<Map<String, Object>> row = jdbc.queryForList("SELECT comments FROM " + table + " WHERE id = ?", cardId);
        Object v = row.isEmpty() ? null : row.get(0).get("comments");
        return v instanceof Number n ? n.longValue() : null;
    }

    boolean hasComment(String type, long id, long userId) {
        return !jdbc.queryForList("SELECT 1 FROM card_comments WHERE target_type = ? AND target_id = ? AND user_id = ? AND deleted = 0 LIMIT 1",
                type, id, userId).isEmpty();
    }

    long insertComment(String type, long id, long userId, String username, String content, long now) {
        GeneratedKeyHolder key = new GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(
                    "INSERT INTO card_comments (target_type, target_id, user_id, username, content, created_at, deleted, deleted_by) "
                            + "VALUES (?, ?, ?, ?, ?, ?, 0, 0)", Statement.RETURN_GENERATED_KEYS);
            ps.setString(1, type);
            ps.setLong(2, id);
            ps.setLong(3, userId);
            ps.setString(4, username);
            ps.setString(5, content);
            ps.setLong(6, now);
            return ps;
        }, key);
        Number k = key.getKey();
        return k == null ? 0 : k.longValue();
    }

    /** 首次评论这张卡的人让 commenters+1（热门分按人去重） */
    void incrementComments(String table, long id, boolean firstByUser) {
        jdbc.update("UPDATE " + table + " SET comments = comments + 1"
                + (firstByUser ? ", commenters = commenters + 1" : "") + " WHERE id = ?", id);
    }

    Map<String, Object> commentById(long cid) {
        return firstRow("SELECT id, user_id, username, content, created_at FROM card_comments WHERE id = ?", cid);
    }

    Map<String, Object> commentRowForDelete(long cid) {
        return firstRow("SELECT id, target_type, target_id, user_id FROM card_comments WHERE id = ? AND deleted = 0", cid);
    }

    void softDeleteComment(long cid, long deletedBy) {
        jdbc.update("UPDATE card_comments SET deleted = 1, deleted_by = ? WHERE id = ?", deletedBy, cid);
    }

    /** 该用户在目标卡下还剩几条有效评论（决定 commenters 要不要一起回退） */
    long remainingComments(String type, long targetId, long userId) {
        Long left = jdbc.queryForObject(
                "SELECT COUNT(*) c FROM card_comments WHERE target_type = ? AND target_id = ? AND user_id = ? AND deleted = 0",
                Long.class, type, targetId, userId);
        return left == null ? 0 : left;
    }

    void decrementComments(String table, long targetId, boolean alsoCommenters) {
        jdbc.update("UPDATE " + table + " SET comments = MAX(0, comments - 1)"
                + (alsoCommenters ? ", commenters = MAX(0, commenters - 1)" : "") + " WHERE id = ?", targetId);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }
}
