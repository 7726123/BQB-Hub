package bqbhub.server.preset;

import bqbhub.server.Social;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 预设表的读写（SQL 逐字来自原 PresetController，不新造查询）。
 * 列表的三种排序（new/hot/active）与点赞/评论装饰（Social）都在这里；
 * 业务口径（审核门、封面校验、文件落盘、删除顺序）在 {@link PresetService}。
 */
@Repository
public class PresetRepository {

    static final String COLS = "id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, likes, comments, commenters";

    /** 一页列表 + 总数（active 分支的 total 是命中条数，与 Node 版口径一致） */
    record Page(List<Map<String, Object>> items, long total) {
    }

    private final JdbcTemplate jdbc;

    public PresetRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    Page list(String cat, String query, String sortKey, int size, int offset, long meId) {
        List<String> conds = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        conds.add("status = 'approved'");   // 未过审的稿子不进公开列表
        if (!cat.isEmpty()) {
            conds.add("category = ?");
            args.add(cat);
        }
        if (!query.isEmpty()) {
            conds.add("(title LIKE ? OR description LIKE ?)");
            args.add("%" + query + "%");
            args.add("%" + query + "%");
        }
        String whereSql = " WHERE " + String.join(" AND ", conds);

        if ("active".equals(sortKey)) {
            Map<Long, Long> act = Social.activeScores(jdbc, "preset", System.currentTimeMillis() - Social.ACTIVE_WINDOW_MS);
            if (act.isEmpty()) return new Page(List.of(), 0);
            List<Long> ids = new ArrayList<>(act.keySet());
            ids.sort((a, b) -> Long.compare(act.get(b), act.get(a)));
            String ph = String.join(",", ids.stream().map(x -> "?").toList());
            List<Object> args2 = new ArrayList<>(args);
            args2.addAll(ids);
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT " + COLS + " FROM presets" + whereSql + " AND id IN (" + ph + ")", args2.toArray());
            Map<Long, Map<String, Object>> byId = new LinkedHashMap<>();
            for (Map<String, Object> r : rows) byId.put(((Number) r.get("id")).longValue(), r);
            List<Map<String, Object>> ordered = new ArrayList<>();
            for (Long id : ids) if (byId.containsKey(id)) ordered.add(byId.get(id));
            int from = Math.min(offset, ordered.size());
            int to = Math.min(offset + size, ordered.size());
            List<Map<String, Object>> pageRows = new ArrayList<>(ordered.subList(from, to));
            return new Page(Social.withLiked(jdbc, "preset", pageRows, meId), ordered.size());
        }

        String order = "hot".equals(sortKey)
                ? "(likes + " + Social.SCORE_COMMENT_WEIGHT + " * commenters) DESC, created_at DESC"
                : "created_at DESC";
        long total = one("SELECT COUNT(*) c FROM presets" + whereSql, args.toArray());
        List<Object> args3 = new ArrayList<>(args);
        args3.add(size);
        args3.add(offset);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + COLS + " FROM presets" + whereSql + " ORDER BY " + order + " LIMIT ? OFFSET ?", args3.toArray());
        return new Page(Social.withLiked(jdbc, "preset", rows, meId), total);
    }

    /** 详情/下载/删除的可见性判断都需要 status 与 author_id，这一行取的就是它们 */
    Map<String, Object> rowForDetail(long id) {
        return firstRow("SELECT " + COLS + ", status FROM presets WHERE id = ?", id);
    }

    Map<String, Object> rowForDelete(long id) {
        return firstRow("SELECT id, author_id, filename FROM presets WHERE id = ?", id);
    }

    Map<String, Object> rowForDownload(long id) {
        return firstRow("SELECT id, title, filename, author_id, status FROM presets WHERE id = ?", id);
    }

    /** 带上「我点没点过赞」的装饰（单行版） */
    Map<String, Object> decorate(Map<String, Object> row, long meId) {
        return Social.withLiked(jdbc, "preset", List.of(row), meId).get(0);
    }

    long insert(String title, String description, String category, long authorId, String authorName,
                long size, long now, String cover, String status) {
        var keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(
                    "INSERT INTO presets (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, status) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setObject(1, title);
            ps.setObject(2, description);
            ps.setObject(3, category);
            ps.setObject(4, "");
            ps.setObject(5, authorId);
            ps.setObject(6, authorName);
            ps.setObject(7, "");
            ps.setObject(8, size);
            ps.setObject(9, now);
            ps.setObject(10, cover);
            ps.setObject(11, status);
            return ps;
        }, keyHolder);
        Number key = keyHolder.getKey();
        return key == null ? 0 : key.longValue();
    }

    void setFilename(long id, String filename) {
        jdbc.update("UPDATE presets SET filename = ? WHERE id = ?", filename, id);
    }

    void delete(long id) {
        jdbc.update("DELETE FROM presets WHERE id = ?", id);
    }

    void purgeSocial(long id) {
        Social.purgeCard(jdbc, "preset", id);   // 级联清掉它的点赞与评论
    }

    void incrementDownloads(long id) {
        jdbc.update("UPDATE presets SET downloads = downloads + 1 WHERE id = ?", id);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long one(String sql, Object[] args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }
}
