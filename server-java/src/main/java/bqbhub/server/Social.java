package bqbhub.server;

import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 卡片社交的读侧工具 + 级联清理（对应 server/src/routes/card.js 里被世界书/预设共用的几个函数）。
 * 写侧（点赞/评论接口）在 CardController 里；这里只有三件事：
 *   · withLiked：给列表项补 liked（当前登录用户是否已赞）
 *   · activeScores：24 小时活跃分（点赞数 + 3×去重评论人数）
 *   · purgeCard：内容被删时级联清掉它的点赞与评论
 * 排序权重（SCORE_COMMENT_WEIGHT=3 / 24 小时窗口）与世界书、预设列表共用，改这里等于改列表口径。
 */
public final class Social {

    public static final int SCORE_COMMENT_WEIGHT = 3;
    public static final long ACTIVE_WINDOW_MS = 24L * 60 * 60 * 1000;

    private Social() {
    }

    /** 给列表项补 liked（Node 版即使查库失败也照常返回，这里同样 best-effort） */
    public static List<Map<String, Object>> withLiked(JdbcTemplate jdbc, String type, List<Map<String, Object>> items, long userId) {
        if (items == null || items.isEmpty()) return items == null ? List.of() : items;
        java.util.Set<Long> liked = new java.util.HashSet<>();
        try {
            if (userId > 0) {
                List<Number> ids = new ArrayList<>();
                for (Map<String, Object> it : items) {
                    Object id = it.get("id");
                    if (id instanceof Number n) ids.add(n);
                }
                if (!ids.isEmpty()) {
                    String ph = String.join(",", ids.stream().map(x -> "?").toList());
                    List<Object> args = new ArrayList<>();
                    args.add(type);
                    args.add(userId);
                    args.addAll(ids);
                    for (Map<String, Object> r : jdbc.queryForList(
                            "SELECT target_id FROM card_likes WHERE target_type = ? AND user_id = ? AND target_id IN (" + ph + ")", args.toArray())) {
                        liked.add(((Number) r.get("target_id")).longValue());
                    }
                }
            }
        } catch (Exception e) { /* liked 是增强信息，查询失败不致命 */ }
        List<Map<String, Object>> out = new ArrayList<>(items.size());
        for (Map<String, Object> it : items) {
            Map<String, Object> copy = new LinkedHashMap<>(it);
            Object id = it.get("id");
            copy.put("liked", id instanceof Number n && liked.contains(n.longValue()));
            out.add(copy);
        }
        return out;
    }

    /** 24 小时活跃分：窗口内点赞数 + 3×去重评论人数（id → 分数） */
    public static Map<Long, Long> activeScores(JdbcTemplate jdbc, String type, long since) {
        Map<Long, Long> map = new HashMap<>();
        try {
            for (Map<String, Object> r : jdbc.queryForList(
                    "SELECT target_id AS id, COUNT(*) AS n FROM card_likes WHERE target_type = ? AND created_at >= ? GROUP BY target_id", type, since)) {
                long id = ((Number) r.get("id")).longValue();
                map.merge(id, ((Number) r.get("n")).longValue(), Long::sum);
            }
            for (Map<String, Object> r : jdbc.queryForList(
                    "SELECT target_id AS id, COUNT(DISTINCT user_id) AS n FROM card_comments WHERE target_type = ? AND deleted = 0 AND created_at >= ? GROUP BY target_id", type, since)) {
                long id = ((Number) r.get("id")).longValue();
                map.merge(id, (long) SCORE_COMMENT_WEIGHT * ((Number) r.get("n")).longValue(), Long::sum);
            }
        } catch (Exception e) {
            System.out.println("[card] 活跃分计算失败: " + e.getMessage());
        }
        return map;
    }

    /** 内容删除时级联清掉点赞与评论（元数据与留痕不动） */
    public static void purgeCard(JdbcTemplate jdbc, String type, long id) {
        try {
            jdbc.update("DELETE FROM card_likes WHERE target_type = ? AND target_id = ?", type, id);
            jdbc.update("DELETE FROM card_comments WHERE target_type = ? AND target_id = ?", type, id);
        } catch (Exception e) {
            System.out.println("[card] 级联清理失败: " + type + " " + id + " " + e.getMessage());
        }
    }
}
