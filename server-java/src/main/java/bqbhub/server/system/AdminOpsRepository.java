package bqbhub.server.system;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.sql.Statement;
import java.util.List;
import java.util.Map;

/** 管理员留档表（admin_traces）的读写（SQL 逐字来自原 SystemController）。 */
@Repository
public class AdminOpsRepository {

    private final JdbcTemplate jdbc;

    public AdminOpsRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    long insertTrace(long ts, String book, int round, String model, int windowChars, int budget,
                     String instruction, String continuation, String recallJson) {
        var keyHolder = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement("INSERT INTO admin_traces (ts, book, round, model, window_chars, budget, instruction, continuation, recall_json) "
                    + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", Statement.RETURN_GENERATED_KEYS);
            ps.setLong(1, ts);
            ps.setString(2, book);
            ps.setInt(3, round);
            ps.setString(4, model);
            ps.setInt(5, windowChars);
            ps.setInt(6, budget);
            ps.setString(7, instruction);
            ps.setString(8, continuation);
            ps.setString(9, recallJson);
            return ps;
        }, keyHolder);
        Number id = keyHolder.getKey();
        return id == null ? 0 : id.longValue();
    }

    /** 只留最新 N 条 */
    void trimTraces(int keep) {
        jdbc.update("DELETE FROM admin_traces WHERE id <= (SELECT MAX(id) - ? FROM admin_traces)", keep);
    }

    List<Map<String, Object>> traces(String book, int limit, int offset) {
        return book.isEmpty()
                ? jdbc.queryForList("SELECT * FROM admin_traces ORDER BY ts DESC LIMIT ? OFFSET ?", limit, offset)
                : jdbc.queryForList("SELECT * FROM admin_traces WHERE book = ? ORDER BY ts DESC LIMIT ? OFFSET ?", book, limit, offset);
    }

    int deleteAll() {
        return jdbc.update("DELETE FROM admin_traces");
    }
}
