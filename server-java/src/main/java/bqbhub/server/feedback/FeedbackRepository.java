package bqbhub.server.feedback;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/**
 * 反馈表的读写（SQL 逐字来自原 FeedbackController，不新造查询）。
 * 只碰 JdbcTemplate：业务口径（配额、去重、裁剪策略、事务边界）都在 {@link FeedbackService}。
 */
@Repository
public class FeedbackRepository {

    static final String COLS = "id, text, version, platform, created_at, read_at";

    private final JdbcTemplate jdbc;

    public FeedbackRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    long countByInstallSince(String installId, long since) {
        return count("SELECT COUNT(*) c FROM feedback WHERE install_id = ? AND created_at > ?", installId, since);
    }

    long countSince(long since) {
        return count("SELECT COUNT(*) c FROM feedback WHERE created_at > ?", since);
    }

    boolean existsRecentDuplicate(String installId, String text, long since) {
        return !jdbc.queryForList("SELECT id FROM feedback WHERE install_id = ? AND text = ? AND created_at > ? LIMIT 1",
                installId, text, since).isEmpty();
    }

    void insert(String text, String installId, String version, String platform, long now) {
        jdbc.update("INSERT INTO feedback (text, install_id, version, platform, created_at) VALUES (?, ?, ?, ?, ?)",
                text, installId, version, platform, now);
    }

    long countAll() {
        return count("SELECT COUNT(*) c FROM feedback");
    }

    /** 裁剪最旧的**已查看**条目（返回删掉的行数） */
    int deleteOldestRead(int limit) {
        return jdbc.update("DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE read_at IS NOT NULL ORDER BY created_at ASC LIMIT ?)", limit);
    }

    /** 仍超量时再动未查看（返回删掉的行数） */
    int deleteOldestUnread(int limit) {
        return jdbc.update("DELETE FROM feedback WHERE id IN (SELECT id FROM feedback WHERE read_at IS NULL ORDER BY created_at ASC LIMIT ?)", limit);
    }

    void bumpTrimmed(long n) {
        jdbc.update("INSERT INTO feedback_meta (k, v) VALUES ('trimmed', ?) ON CONFLICT(k) DO UPDATE SET v = v + ?", n, n);
    }

    List<Map<String, Object>> list(String where, int limit) {
        return jdbc.queryForList("SELECT " + COLS + " FROM feedback" + where + " ORDER BY created_at DESC LIMIT ?", limit);
    }

    long countUnread() {
        return count("SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL");
    }

    long countRead() {
        return count("SELECT COUNT(*) c FROM feedback WHERE read_at IS NOT NULL");
    }

    long trimmed() {
        List<Map<String, Object>> tr = jdbc.queryForList("SELECT v FROM feedback_meta WHERE k = 'trimmed'");
        return tr.isEmpty() ? 0 : ((Number) tr.get(0).get("v")).longValue();
    }

    int markAllRead(long now) {
        return jdbc.update("UPDATE feedback SET read_at = ? WHERE read_at IS NULL", now);
    }

    int markRead(long id, long now) {
        return jdbc.update("UPDATE feedback SET read_at = ? WHERE id = ? AND read_at IS NULL", now, id);
    }

    int delete(long id) {
        return jdbc.update("DELETE FROM feedback WHERE id = ?", id);
    }

    private long count(String sql, Object... args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }
}
