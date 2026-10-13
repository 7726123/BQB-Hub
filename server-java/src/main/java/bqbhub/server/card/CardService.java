package bqbhub.server.card;

import bqbhub.server.ApiError;
import bqbhub.server.AuthService;
import bqbhub.server.RateLimiter;
import bqbhub.server.Validators;
import bqbhub.server.support.Visibility;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 卡片社交（逐条对应 server/src/routes/card.js）：点赞（切换、主键幂等、一人一赞）+
 * 评论（发布 / 倒序分页列表 / 软删除）+ 计数缓存列维护。
 * 一套路由同时服务世界书与预设（target_type 区分）；计数口径：
 *   likes = 点赞数；comments = 非删除评论数；commenters = 非删除评论的去重人数。
 *
 * 并发口径：Node 版是单连接同步、天然串行；Java 是连接池 + 多线程，所以「明细行
 * （card_likes / card_comments）+ 卡片行上的计数缓存列」的每次写操作都放进同一事务，
 * 避免并发下计数与明细对不上（与 Db.java 头注释的并发说明同源）。
 */
@Service
public class CardService {

    static final int COMMENT_MAX = 500;

    // 写操作限流（内存滑动窗，阈值与 Node 版 card.js 一致，按账号键控）。
    // 仍然不放进 Limiters：那份阈值注册表属于冻结的接口契约（见 Limiters 头注释），
    // 这里是本路由私有口径，声明在这个 Service 里即可。
    private final RateLimiter likeLimiter = new RateLimiter(60_000, 60);    // 点赞 60 次/分钟/账号
    private final RateLimiter commentLimiter = new RateLimiter(60_000, 5);  // 评论 5 次/分钟/账号

    private final CardRepository repo;
    private final TransactionTemplate tx;

    public CardService(CardRepository repo, PlatformTransactionManager txm) {
        this.repo = repo;
        this.tx = new TransactionTemplate(txm);
    }

    // ---------------------------------------------------------------- 点赞 / 取消（切换）

    public Map<String, Object> like(Map<String, Object> body, AuthService.User me, boolean admin) {
        String type = Validators.str(body.get("type"));
        long id = Validators.num(body.get("id"), 0);
        String table = CardRepository.tableFor(type);
        if (table == null) throw ApiError.of(400, "未知的卡片类型");
        if (cardRow(type, id, me, admin, true) == null) throw ApiError.of(404, "未找到该卡片");
        if (!likeLimiter.allow("u" + me.id)) throw ApiError.of(429, "操作过于频繁，请稍后再试");

        boolean[] liked = new boolean[1];
        long[] likes = new long[1];
        tx.executeWithoutResult(status -> {
            if (repo.hasLike(type, id, me.id)) {
                repo.deleteLike(type, id, me.id);
                repo.decrementLikes(table, id);
                liked[0] = false;
            } else {
                repo.insertLike(type, id, me.id, System.currentTimeMillis());
                repo.incrementLikes(table, id);
                liked[0] = true;
            }
            likes[0] = repo.likesOf(table, id);
        });

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("liked", liked[0]);
        out.put("likes", likes[0]);
        return out;
    }

    // ---------------------------------------------------------------- 评论列表（倒序分页）

    public Map<String, Object> comments(String type, String id, String limit, String beforeIdParam, AuthService.User me) {
        String t = Validators.str(type);
        long cardId = Validators.num(id, 0);
        String table = CardRepository.tableFor(t);
        if (table == null) throw ApiError.of(400, "未知的卡片类型");
        int lim = Validators.num(limit, 20);
        if (lim < 1) lim = 20;
        if (lim > 50) lim = 50;
        long beforeId = Validators.num(beforeIdParam, 0);
        // 与 Node 版一致：本接口不按审核可见性过滤（只列已存在的评论行）；
        // total 取自卡片行上的计数缓存列，卡片已删（或不存在）时回 0，不报 404。
        List<Map<String, Object>> rows = beforeId > 0
                ? repo.commentsDescBefore(t, cardId, beforeId, lim)
                : repo.commentsDesc(t, cardId, lim);
        Long total = repo.commentsCacheOf(table, cardId);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("comments", rows);
        out.put("total", total == null ? 0 : total);
        out.put("mine", me.id);
        return out;
    }

    // ---------------------------------------------------------------- 发评论

    public Map<String, Object> comment(Map<String, Object> body, AuthService.User me, boolean admin) {
        String type = Validators.str(body.get("type"));
        long id = Validators.num(body.get("id"), 0);
        String content = Validators.str(body.get("content")).trim();
        String table = CardRepository.tableFor(type);
        if (table == null) throw ApiError.of(400, "未知的卡片类型");
        if (content.isEmpty()) throw ApiError.of(400, "评论内容不能为空");
        // JS 的 String.length 按 UTF-16 码元计，与 Java 的 String.length 同口径，直接比即可
        if (content.length() > COMMENT_MAX) throw ApiError.of(400, "评论不能超过 " + COMMENT_MAX + " 字");
        if (cardRow(type, id, me, admin, true) == null) throw ApiError.of(404, "未找到该卡片");
        if (!commentLimiter.allow("u" + me.id)) throw ApiError.of(429, "评论太频繁了，请稍后再试");

        long[] cid = new long[1];
        tx.executeWithoutResult(status -> {
            boolean firstByUser = !repo.hasComment(type, id, me.id);
            cid[0] = repo.insertComment(type, id, me.id, me.username, content, System.currentTimeMillis());
            repo.incrementComments(table, id, firstByUser);
        });
        Map<String, Object> row = repo.commentById(cid[0]);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("comment", row);
        return out;
    }

    // ---------------------------------------------------------------- 删除评论（软删除，保留审计）

    public Map<String, Object> deleteComment(String id, AuthService.User me, boolean admin) {
        long cid = Validators.num(id, 0);
        Map<String, Object> row = repo.commentRowForDelete(cid);
        if (row == null) throw ApiError.of(404, "未找到该评论");
        String type = Validators.str(row.get("target_type"));
        long targetId = num(row.get("target_id"));
        long commenterId = num(row.get("user_id"));
        String table = CardRepository.tableFor(type);
        // 卡作者判定：与 Node 版一致，这里不按审核可见性过滤（只取 author_id）
        Map<String, Object> card = cardRow(type, targetId, null, false, false);
        boolean isCommentAuthor = commenterId == me.id;
        boolean isCardAuthor = card != null && num(card.get("author_id")) == me.id;
        if (!isCommentAuthor && !isCardAuthor && !admin) throw ApiError.of(403, "只能删除自己的评论");

        tx.executeWithoutResult(status -> {
            repo.softDeleteComment(cid, me.id);
            // 计数回退按**评论原作者**算：该用户在这张卡下已无有效评论时，评论人数 -1（热门分同步）
            boolean noneLeft = repo.remainingComments(type, targetId, commenterId) == 0;
            if (table != null) {
                repo.decrementComments(table, targetId, noneLeft);
            }
        });
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 内部

    /**
     * 卡片是否存在（顺带取作者 id）；applyVisibility 为真时按审核可见性过滤 —— 未过审的卡对
     * 「点赞/评论」一律按不存在处理（对应 card.js 的 cardRow + visibility.canSee）。
     */
    private Map<String, Object> cardRow(String type, long id, AuthService.User me, boolean admin, boolean applyVisibility) {
        String table = CardRepository.tableFor(type);
        if (table == null) return null;
        Map<String, Object> row = repo.cardRow(table, id);
        if (row != null && applyVisibility && !Visibility.canSee(admin, me, row)) return null;
        return row;
    }

    private static long num(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
