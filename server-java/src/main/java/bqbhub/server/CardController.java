package bqbhub.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 卡片社交（逐条对应 server/src/routes/card.js）：点赞（切换、主键幂等、一人一赞）+
 * 评论（发布 / 倒序分页列表 / 软删除）+ 计数缓存列维护。
 * 一套路由同时服务世界书与预设（target_type 区分）；计数口径：
 *   likes = 点赞数；comments = 非删除评论数；commenters = 非删除评论的去重人数。
 * 排序打分（热门 = likes + 3×commenters、24 小时活跃分）与列表共用，落在 {@link Social}。
 *
 * 并发口径：Node 版是单连接同步、天然串行；Java 是连接池 + 多线程，所以「明细行
 * （card_likes / card_comments）+ 卡片行上的计数缓存列」的每次写操作都放进同一事务，
 * 避免并发下计数与明细对不上（与 Db.java 头注释的并发说明同源）。
 */
@RestController
public class CardController {

    static final int COMMENT_MAX = 500;

    private final JdbcTemplate jdbc;
    private final AuthService auth;
    private final TransactionTemplate tx;

    // 写操作限流（内存滑动窗，阈值与 Node 版 card.js 一致，按账号键控）。
    // 不放进 Limiters：那份阈值注册表属于冻结的接口契约（见 Limiters 头注释），
    // 这里是本路由私有口径，声明在 Controller 内即可。
    private final RateLimiter likeLimiter = new RateLimiter(60_000, 60);    // 点赞 60 次/分钟/账号
    private final RateLimiter commentLimiter = new RateLimiter(60_000, 5);  // 评论 5 次/分钟/账号

    public CardController(JdbcTemplate jdbc, AuthService auth, PlatformTransactionManager txm) {
        this.jdbc = jdbc;
        this.auth = auth;
        this.tx = new TransactionTemplate(txm);
    }

    // ---------------------------------------------------------------- 点赞 / 取消（切换）
    @PostMapping("/api/card/like")
    public Map<String, Object> like(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        Map<String, Object> b = body == null ? Map.of() : body;
        String type = Validators.str(b.get("type"));
        long id = Validators.num(b.get("id"), 0);
        String table = tableFor(type);
        if (table == null) throw ApiError.of(400, "未知的卡片类型");
        if (cardRow(type, id, me, req) == null) throw ApiError.of(404, "未找到该卡片");
        if (!likeLimiter.allow("u" + me.id)) throw ApiError.of(429, "操作过于频繁，请稍后再试");

        boolean[] liked = new boolean[1];
        long[] likes = new long[1];
        tx.executeWithoutResult(status -> {
            List<Map<String, Object>> has = jdbc.queryForList(
                    "SELECT 1 FROM card_likes WHERE target_type = ? AND target_id = ? AND user_id = ?", type, id, me.id);
            if (!has.isEmpty()) {
                jdbc.update("DELETE FROM card_likes WHERE target_type = ? AND target_id = ? AND user_id = ?", type, id, me.id);
                jdbc.update("UPDATE " + table + " SET likes = MAX(0, likes - 1) WHERE id = ?", id);
                liked[0] = false;
            } else {
                jdbc.update("INSERT INTO card_likes (target_type, target_id, user_id, created_at) VALUES (?, ?, ?, ?)",
                        type, id, me.id, System.currentTimeMillis());
                jdbc.update("UPDATE " + table + " SET likes = likes + 1 WHERE id = ?", id);
                liked[0] = true;
            }
            List<Map<String, Object>> row = jdbc.queryForList("SELECT likes FROM " + table + " WHERE id = ?", id);
            Object lv = row.isEmpty() ? null : row.get(0).get("likes");
            likes[0] = lv instanceof Number n ? n.longValue() : 0;
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("liked", liked[0]);
        out.put("likes", likes[0]);
        return out;
    }

    // ---------------------------------------------------------------- 评论列表（倒序分页）
    @GetMapping("/api/card/comments")
    public Map<String, Object> comments(@RequestParam(required = false) String type,
                                        @RequestParam(required = false) String id,
                                        @RequestParam(required = false) String limit,
                                        @RequestParam(value = "before_id", required = false) String beforeIdParam,
                                        HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        String t = Validators.str(type);
        long cardId = Validators.num(id, 0);
        if (tableFor(t) == null) throw ApiError.of(400, "未知的卡片类型");
        int lim = Validators.num(limit, 20);
        if (lim < 1) lim = 20;
        if (lim > 50) lim = 50;
        long beforeId = Validators.num(beforeIdParam, 0);
        // 与 Node 版一致：本接口不按审核可见性过滤（只列已存在的评论行）；
        // total 取自卡片行上的计数缓存列，卡片已删（或不存在）时回 0，不报 404。
        List<Map<String, Object>> rows = beforeId > 0
                ? jdbc.queryForList("SELECT id, user_id, username, content, created_at FROM card_comments "
                        + "WHERE target_type = ? AND target_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?",
                        t, cardId, beforeId, lim)
                : jdbc.queryForList("SELECT id, user_id, username, content, created_at FROM card_comments "
                        + "WHERE target_type = ? AND target_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?",
                        t, cardId, lim);
        List<Map<String, Object>> totalRow = jdbc.queryForList("SELECT comments FROM " + tableFor(t) + " WHERE id = ?", cardId);
        Object total = totalRow.isEmpty() ? null : totalRow.get(0).get("comments");

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("comments", rows);
        out.put("total", total instanceof Number n ? n.longValue() : 0);
        out.put("mine", me.id);
        return out;
    }

    // ---------------------------------------------------------------- 发评论
    @PostMapping("/api/card/comment")
    public Map<String, Object> comment(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        Map<String, Object> b = body == null ? Map.of() : body;
        String type = Validators.str(b.get("type"));
        long id = Validators.num(b.get("id"), 0);
        String content = Validators.str(b.get("content")).trim();
        String table = tableFor(type);
        if (table == null) throw ApiError.of(400, "未知的卡片类型");
        if (content.isEmpty()) throw ApiError.of(400, "评论内容不能为空");
        // JS 的 String.length 按 UTF-16 码元计，与 Java 的 String.length 同口径，直接比即可
        if (content.length() > COMMENT_MAX) throw ApiError.of(400, "评论不能超过 " + COMMENT_MAX + " 字");
        if (cardRow(type, id, me, req) == null) throw ApiError.of(404, "未找到该卡片");
        if (!commentLimiter.allow("u" + me.id)) throw ApiError.of(429, "评论太频繁了，请稍后再试");

        long[] cid = new long[1];
        tx.executeWithoutResult(status -> {
            List<Map<String, Object>> first = jdbc.queryForList(
                    "SELECT 1 FROM card_comments WHERE target_type = ? AND target_id = ? AND user_id = ? AND deleted = 0 LIMIT 1",
                    type, id, me.id);
            GeneratedKeyHolder key = new GeneratedKeyHolder();
            jdbc.update(con -> {
                var ps = con.prepareStatement(
                        "INSERT INTO card_comments (target_type, target_id, user_id, username, content, created_at, deleted, deleted_by) "
                                + "VALUES (?, ?, ?, ?, ?, ?, 0, 0)", Statement.RETURN_GENERATED_KEYS);
                ps.setString(1, type);
                ps.setLong(2, id);
                ps.setLong(3, me.id);
                ps.setString(4, me.username);
                ps.setString(5, content);
                ps.setLong(6, System.currentTimeMillis());
                return ps;
            }, key);
            Number k = key.getKey();
            cid[0] = k == null ? 0 : k.longValue();
            // 首次评论这张卡的人让 commenters+1（热门分按人去重）
            jdbc.update("UPDATE " + table + " SET comments = comments + 1"
                    + (first.isEmpty() ? ", commenters = commenters + 1" : "") + " WHERE id = ?", id);
        });
        Map<String, Object> row = firstRow(
                "SELECT id, user_id, username, content, created_at FROM card_comments WHERE id = ?", cid[0]);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("comment", row);
        return out;
    }

    // ---------------------------------------------------------------- 删除评论（软删除，保留审计）
    @DeleteMapping("/api/card/comment")
    public Map<String, Object> deleteComment(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        long cid = Validators.num(id, 0);
        Map<String, Object> row = firstRow(
                "SELECT id, target_type, target_id, user_id FROM card_comments WHERE id = ? AND deleted = 0", cid);
        if (row == null) throw ApiError.of(404, "未找到该评论");
        String type = Validators.str(row.get("target_type"));
        long targetId = num(row.get("target_id"));
        long commenterId = num(row.get("user_id"));
        String table = tableFor(type);
        // 卡作者判定：与 Node 版一致，这里传 null 不按审核可见性过滤（只取 author_id）
        Map<String, Object> card = cardRow(type, targetId, null, null);
        boolean isCommentAuthor = commenterId == me.id;
        boolean isCardAuthor = card != null && num(card.get("author_id")) == me.id;
        boolean isAdmin = auth.isAdmin(req);
        if (!isCommentAuthor && !isCardAuthor && !isAdmin) throw ApiError.of(403, "只能删除自己的评论");

        tx.executeWithoutResult(status -> {
            jdbc.update("UPDATE card_comments SET deleted = 1, deleted_by = ? WHERE id = ?", me.id, cid);
            // 计数回退按**评论原作者**算：该用户在这张卡下已无有效评论时，评论人数 -1（热门分同步）
            Long left = jdbc.queryForObject(
                    "SELECT COUNT(*) c FROM card_comments WHERE target_type = ? AND target_id = ? AND user_id = ? AND deleted = 0",
                    Long.class, type, targetId, commenterId);
            if (table != null) {
                jdbc.update("UPDATE " + table + " SET comments = MAX(0, comments - 1)"
                        + ((left == null || left == 0) ? ", commenters = MAX(0, commenters - 1)" : "") + " WHERE id = ?", targetId);
            }
        });
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 内部
    /** 卡片类型 → 表名（白名单，防注入；对应 card.js 的 TABLES） */
    private static String tableFor(String type) {
        if (type == null) return null;
        return switch (type) {
            case "worldbook" -> "world_books";
            case "preset" -> "presets";
            default -> null;
        };
    }

    /**
     * 卡片是否存在（顺带取作者 id）；req 非空时按审核可见性过滤 —— 未过审的卡对
     * 「点赞/评论」一律按不存在处理（对应 card.js 的 cardRow + visibility.canSee）。
     */
    private Map<String, Object> cardRow(String type, long id, AuthService.User me, HttpServletRequest req) {
        String table = tableFor(type);
        if (table == null) return null;
        Map<String, Object> row = firstRow("SELECT id, author_id, status FROM " + table + " WHERE id = ?", id);
        if (row != null && req != null && !canSee(me, req, row)) return null;
        return row;
    }

    /** 单行可见性（与 visibility.js 的 canSee 同口径）：管理员全可见；其余人只可见已通过的或自己上传的 */
    private boolean canSee(AuthService.User me, HttpServletRequest req, Map<String, Object> row) {
        if (auth.isAdmin(req)) return true;
        if ("approved".equals(Validators.str(row.get("status")))) return true;
        return me != null && num(row.get("author_id")) == me.id;
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
