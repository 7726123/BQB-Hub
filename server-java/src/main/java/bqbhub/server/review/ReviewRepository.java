package bqbhub.server.review;

import bqbhub.server.Validators;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 审核队列的读写（SQL 逐字来自原 ReviewController；三类内容合并排序由 {@link ReviewService} 负责）。
 * 表名拼接只认 {@link #tableFor} 白名单。
 */
@Repository
public class ReviewRepository {

    private final JdbcTemplate jdbc;

    public ReviewRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 类型 → 表名（白名单，防注入，对应 review.js 的 TABLES） */
    static String tableFor(String type) {
        return switch (Validators.str(type)) {
            case "worldbook" -> "world_books";
            case "preset" -> "presets";
            case "plugin" -> "plugins";
            default -> null;
        };
    }

    /** 列表列集：插件用 plugin_type 顶 category、没有封面列（与 review.js 的 selectRows 一致） */
    private static String columns(String type) {
        return "plugin".equals(type)
                ? "id, title, description, plugin_type AS category, plugin_version, author_id, author_name, size, downloads, created_at, status, reviewed_at, '' AS cover"
                : "id, title, description, category, author_id, author_name, size, downloads, created_at, status, reviewed_at, cover";
    }

    /** 按状态 / 作者过滤（两者都可为 null），顺带给行打上 type 标记 */
    List<Map<String, Object>> selectRows(String type, String status, Long authorId, int cap) {
        Filter f = filter(status, authorId);
        List<Object> args = new ArrayList<>(f.args());
        args.add(cap);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + columns(type) + " FROM " + tableFor(type) + f.whereSql() + " ORDER BY created_at DESC LIMIT ?",
                args.toArray());
        List<Map<String, Object>> out = new ArrayList<>(rows.size());
        for (Map<String, Object> r : rows) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("type", type);
            m.putAll(r);
            out.add(m);
        }
        return out;
    }

    long countRows(String type, String status, Long authorId) {
        Filter f = filter(status, authorId);
        Long v = jdbc.queryForObject("SELECT COUNT(*) c FROM " + tableFor(type) + f.whereSql(), Long.class, f.args().toArray());
        return v == null ? 0 : v;
    }

    /** 动作要用的行（插件 zip 用 plugin_id 拼文件名，所以插件多取一列） */
    Map<String, Object> rowForAction(String type, long id) {
        String cols = "plugin".equals(type) ? "id, filename, plugin_id" : "id, filename";
        return firstRow("SELECT " + cols + " FROM " + tableFor(type) + " WHERE id = ?", id);
    }

    void updateStatus(String type, long id, String status, long reviewedAt) {
        jdbc.update("UPDATE " + tableFor(type) + " SET status = ?, reviewed_at = ? WHERE id = ?", status, reviewedAt, id);
    }

    /** 留痕失败不影响动作结果 */
    void logAction(String type, long id, String action, String note) {
        bqbhub.server.ReviewLog.log(jdbc, type, id, action, note, "admin");
    }

    private record Filter(String whereSql, List<Object> args) {
    }

    private static Filter filter(String status, Long authorId) {
        List<String> conds = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (status != null) {
            conds.add("status = ?");
            args.add(status);
        }
        if (authorId != null) {
            conds.add("author_id = ?");
            args.add(authorId);
        }
        return new Filter(conds.isEmpty() ? "" : " WHERE " + String.join(" AND ", conds), args);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }
}
