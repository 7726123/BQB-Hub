package bqbhub.server.worldbook;

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
 * 世界书表的读写（SQL 逐字来自原 WorldbookController，不新造查询）。
 *
 * 列表有三分支（检索 q / active 榜 / 常规 new+hot），**三支的响应键集不同**
 * （检索多 modes/facets、其余多 sort），所以这里直接返回组装好的 Map——
 * 口径与 Node 版逐字对齐；业务规则（审核门、admin_only、封面校验、路径安全）在 {@link WorldbookService}。
 */
@Repository
public class WorldbookRepository {

    static final String COLS = "id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, meta, admin_only, likes, comments, commenters";

    private final JdbcTemplate jdbc;

    public WorldbookRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- 列表

    /** 检索分支：交给 WbSearch，再补 page/pageSize 与 liked 装饰（terms 按 Node 版口径不外传） */
    Map<String, Object> searchList(String query, String sort, String strict, String nsfw, boolean admin,
                                   String page, int pageNum, int size, long meId) {
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("q", query);
        o.put("page", page);
        o.put("pageSize", size);
        o.put("sort", sort);
        o.put("strict", strict);
        o.put("nsfw", nsfw);
        o.put("admin", admin);
        Map<String, Object> r = WbSearch.search(jdbc, o);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", Social.withLiked(jdbc, "worldbook", castItems(r.get("items")), meId));
        out.put("total", r.get("total"));
        out.put("page", pageNum);
        out.put("pageSize", size);
        out.put("modes", r.get("modes"));
        out.put("facets", r.get("facets"));
        return out;
    }

    /** /search 端点：原样返回 WbSearch 的结果（含 terms） */
    Map<String, Object> rawSearch(Map<String, Object> o) {
        return WbSearch.search(jdbc, o);
    }

    /** 常规/active 榜分支（无 q） */
    Map<String, Object> list(String cat, String sortKey, int pageNum, int size, long meId, boolean admin) {
        int offset = (pageNum - 1) * size;
        List<String> conds = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (!admin) conds.add("admin_only = 0");
        conds.add("status = 'approved'");   // 未过审的稿子不进公开列表（作者在「我的投稿」里看自己的）
        if (!cat.isEmpty()) {
            conds.add("category = ?");
            args.add(cat);
        }
        String whereSql = conds.isEmpty() ? "" : " WHERE " + String.join(" AND ", conds);

        if ("active".equals(sortKey)) {
            Map<Long, Long> act = Social.activeScores(jdbc, "worldbook", System.currentTimeMillis() - Social.ACTIVE_WINDOW_MS);
            Map<String, Object> out = new LinkedHashMap<>();
            if (act.isEmpty()) {
                out.put("items", List.of());
                out.put("total", 0);
                out.put("page", pageNum);
                out.put("pageSize", size);
                out.put("sort", sortKey);
                return out;
            }
            List<Long> ids = new ArrayList<>(act.keySet());
            ids.sort((a, b) -> Long.compare(act.get(b), act.get(a)));
            String ph = String.join(",", ids.stream().map(x -> "?").toList());
            List<Object> args2 = new ArrayList<>(args);
            args2.addAll(ids);
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT " + COLS + " FROM world_books" + (whereSql.isEmpty() ? " WHERE " : whereSql + " AND ") + "id IN (" + ph + ")", args2.toArray());
            Map<Long, Map<String, Object>> byId = new LinkedHashMap<>();
            for (Map<String, Object> r : rows) byId.put(((Number) r.get("id")).longValue(), r);
            List<Map<String, Object>> ordered = new ArrayList<>();
            for (Long id : ids) if (byId.containsKey(id)) ordered.add(byId.get(id));
            int from = Math.min(offset, ordered.size());
            int to = Math.min(offset + size, ordered.size());
            List<Map<String, Object>> pageRows = new ArrayList<>();
            for (Map<String, Object> r : ordered.subList(from, to)) pageRows.add(WbSearch.decorate(r));
            out.put("items", Social.withLiked(jdbc, "worldbook", pageRows, meId));
            out.put("total", ordered.size());
            out.put("page", pageNum);
            out.put("pageSize", size);
            out.put("sort", sortKey);
            return out;
        }

        String order = "hot".equals(sortKey)
                ? "(likes + " + Social.SCORE_COMMENT_WEIGHT + " * commenters) DESC, created_at DESC"
                : "created_at DESC";
        long total = one("SELECT COUNT(*) c FROM world_books" + whereSql, args.toArray());
        List<Object> args3 = new ArrayList<>(args);
        args3.add(size);
        args3.add(offset);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + COLS + " FROM world_books" + whereSql + " ORDER BY " + order + " LIMIT ? OFFSET ?", args3.toArray());
        List<Map<String, Object>> decorated = new ArrayList<>();
        for (Map<String, Object> r : rows) decorated.add(WbSearch.decorate(r));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", Social.withLiked(jdbc, "worldbook", decorated, meId));
        out.put("total", total);
        out.put("page", pageNum);
        out.put("pageSize", size);
        out.put("sort", sortKey);
        return out;
    }

    // ---------------------------------------------------------------- 单行

    Map<String, Object> rowForDetail(long id) {
        return firstRow("SELECT " + COLS + ", status FROM world_books WHERE id = ?", id);
    }

    Map<String, Object> rowForMeta(long id) {
        return firstRow("SELECT id, title, description, category, tags, author_id, meta FROM world_books WHERE id = ?", id);
    }

    Map<String, Object> rowForPayload(long id) {
        return firstRow("SELECT id, title, filename, admin_only, author_id, status FROM world_books WHERE id = ?", id);
    }

    Map<String, Object> rowForDelete(long id) {
        return firstRow("SELECT id, author_id, filename, admin_only FROM world_books WHERE id = ?", id);
    }

    Map<String, Object> decorateAndLike(Map<String, Object> row, long meId) {
        return Social.withLiked(jdbc, "worldbook", List.of(WbSearch.decorate(row)), meId).get(0);
    }

    long insert(String title, String description, String category, String tags, long authorId, String authorName,
                long size, long now, String cover, String metaJson, int adminOnly, String status) {
        var keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(
                    "INSERT INTO world_books (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, search_text, admin_only, status) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setObject(1, title);
            ps.setObject(2, description);
            ps.setObject(3, category);
            ps.setObject(4, tags);
            ps.setObject(5, authorId);
            ps.setObject(6, authorName);
            ps.setObject(7, "");
            ps.setObject(8, size);
            ps.setObject(9, now);
            ps.setObject(10, cover);
            ps.setObject(11, metaJson);
            ps.setObject(12, "");
            ps.setObject(13, adminOnly);
            ps.setObject(14, status);
            return ps;
        }, keyHolder);
        Number key = keyHolder.getKey();
        return key == null ? 0 : key.longValue();
    }

    void setFilenameAndSearchText(long id, String filename, String searchText) {
        jdbc.update("UPDATE world_books SET filename = ?, search_text = ? WHERE id = ?", filename, searchText, id);
    }

    void updateMetaAndSearchText(long id, String metaJson, String searchText, String tags) {
        jdbc.update("UPDATE world_books SET meta = ?, search_text = ?, tags = ? WHERE id = ?", metaJson, searchText, tags, id);
    }

    void incrementDownloads(long id) {
        jdbc.update("UPDATE world_books SET downloads = downloads + 1 WHERE id = ?", id);
    }

    void delete(long id) {
        jdbc.update("DELETE FROM world_books WHERE id = ?", id);
    }

    void purgeSocial(long id) {
        Social.purgeCard(jdbc, "worldbook", id);   // 级联清掉它的点赞与评论
    }

    /** 管理员删他人内容 → 留痕（Service 不该碰 JdbcTemplate，留痕这种写库动作放这里） */
    void logAdminDelete(long id) {
        bqbhub.server.ReviewLog.log(jdbc, "worldbook", id, "delete", "", "admin");
    }

    // ---------------------------------------------------------------- 内部

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castItems(Object o) {
        return o instanceof List<?> l ? (List<Map<String, Object>>) l : new ArrayList<>();
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
