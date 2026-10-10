package bqbhub.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 审核队列（管理员）+ 我的投稿（作者），逐条对应 server/src/routes/review.js。
 *
 * 管理员侧沿用 App 的「管理员模式」凭证（X-Admin-Token，见 AuthService.isAdmin），不引入新口令体系；
 * 队列默认只列待审，并附带三类内容的待审计数供角标显示。
 * 作者侧给一个自己的投稿列表：未过审的内容不进公开列表，作者要能在别处看到自己的稿子与状态。
 *
 * 限流口径与 Node 版一致（按 IP / 按账号键控，复用 {@link Limiters} 里冻结的配额）：
 *   队列与动作 = reviewLimiter（120/分钟/IP）；我的投稿 = readLimiter（120/分钟/账号，requireAuth 之后）。
 */
@RestController
public class ReviewController {

    /** 类型 → 表（白名单，防注入，对应 review.js 的 TABLES） */
    private static final List<String> TYPES = List.of("worldbook", "preset", "plugin");
    private static final List<String> STATUS_OK = List.of("pending", "approved", "rejected");
    private static final int MAX_LIMIT = 200;
    private static final int MAX_SCAN = 500;

    /** 三类内容合并排序：created_at 倒序（List.sort 稳定，同刻时保持类型顺序，与 Node 的稳定排序一致） */
    private static final Comparator<Map<String, Object>> BY_CREATED_DESC =
            (a, b) -> Long.compare(numOr0(b.get("created_at")), numOr0(a.get("created_at")));

    private final JdbcTemplate jdbc;
    private final AuthService auth;
    private final Limiters limiters;
    private final AppConfig cfg;

    public ReviewController(JdbcTemplate jdbc, AuthService auth, Limiters limiters, AppConfig cfg) {
        this.jdbc = jdbc;
        this.auth = auth;
        this.limiters = limiters;
        this.cfg = cfg;
    }

    // ---------------------------------------------------------------- 审核队列（管理员）
    @GetMapping("/api/admin/review")
    public Map<String, Object> queue(@RequestParam(required = false) String type,
                                     @RequestParam(required = false) String status,
                                     @RequestParam(required = false) String limit,
                                     @RequestParam(required = false) String offset,
                                     HttpServletRequest req) {
        if (!limiters.review.allow("ip" + AuthService.clientIp(req))) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
        String ty = Validators.trim(Validators.str(type));
        if (!ty.isEmpty() && tableFor(ty) == null) throw ApiError.of(400, "未知的内容类型");
        // 对应 String(req.query.status || 'pending').trim()：空串回退 pending，纯空白则按未知状态 400
        String st = Validators.str(status);
        if (st.isEmpty()) st = "pending";
        st = st.trim();
        if (!STATUS_OK.contains(st)) throw ApiError.of(400, "未知的审核状态");
        Page pg = pageArgs(limit, offset);

        List<String> types = ty.isEmpty() ? TYPES : List.of(ty);
        // 每类先取 offset+limit 行（封顶 MAX_SCAN）再合并排序切片；总数与待审计数走 COUNT，不受分页影响
        int cap = (int) Math.min((long) pg.offset() + pg.limit(), MAX_SCAN);
        List<Map<String, Object>> items = new ArrayList<>();
        for (String t : types) items.addAll(selectRows(t, st, null, cap));
        items.sort(BY_CREATED_DESC);
        long total = 0;
        for (String t : types) total += countRows(t, st, null);
        Map<String, Object> counts = new LinkedHashMap<>();
        for (String t : TYPES) counts.put(t, countRows(t, "pending", null));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", slice(items, pg.offset(), pg.limit()));
        out.put("total", total);
        out.put("counts", counts);
        return out;
    }

    // ---------------------------------------------------------------- 通过 / 驳回（管理员）
    @PostMapping("/api/admin/review/action")
    public Map<String, Object> action(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        if (!limiters.review.allow("ip" + AuthService.clientIp(req))) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        if (!auth.isAdmin(req)) throw ApiError.of(401, "需要管理员令牌");
        Map<String, Object> b = body == null ? Map.of() : body;
        String type = Validators.str(b.get("type"));
        if (tableFor(type) == null) throw ApiError.of(400, "未知的内容类型");
        long id = Validators.num(b.get("id"), 0);
        String action = Validators.str(b.get("action"));
        if (!"approve".equals(action) && !"reject".equals(action)) throw ApiError.of(400, "未知的审核动作");
        // 插件 zip 用 plugin_id 拼文件名，所以插件要多取一列
        String cols = "plugin".equals(type) ? "id, filename, plugin_id" : "id, filename";
        Map<String, Object> row = firstRow("SELECT " + cols + " FROM " + tableFor(type) + " WHERE id = ?", id);
        if (row == null) throw ApiError.of(404, "未找到该内容");

        String status = "approve".equals(action) ? "approved" : "rejected";
        jdbc.update("UPDATE " + tableFor(type) + " SET status = ?, reviewed_at = ? WHERE id = ?",
                status, System.currentTimeMillis(), id);
        if ("reject".equals(action)) {
            // 驳回保留记录（作者能看到状态并自行删除），但内容文件当场删掉：
            // 不合格内容不该继续留在服务器磁盘上，这是「审核不只看状态、还要真正下架」的落点
            Media.removePayload(cfg, type, Validators.str(row.get("filename")), Validators.str(row.get("plugin_id")));
        }
        ReviewLog.log(jdbc, type, id, action, Validators.str(b.get("note")), "admin"); // 留痕失败不影响动作结果
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("type", type);
        out.put("id", id);
        out.put("status", status);
        return out;
    }

    // ---------------------------------------------------------------- 我的投稿（作者视角）
    @GetMapping("/api/my/submissions")
    public Map<String, Object> mySubmissions(@RequestParam(required = false) String limit,
                                             @RequestParam(required = false) String offset,
                                             HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        Page pg = pageArgs(limit, offset);

        int cap = (int) Math.min((long) pg.offset() + pg.limit(), MAX_SCAN);
        List<Map<String, Object>> items = new ArrayList<>();
        for (String t : TYPES) items.addAll(selectRows(t, null, me.id, cap));
        items.sort(BY_CREATED_DESC);
        long total = 0;
        for (String t : TYPES) total += countRows(t, null, me.id);
        long pending = 0;
        long rejected = 0;
        for (String t : TYPES) {
            pending += countRows(t, "pending", me.id);
            rejected += countRows(t, "rejected", me.id);
        }
        Map<String, Object> counts = new LinkedHashMap<>();
        counts.put("pending", pending);
        counts.put("rejected", rejected);

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", slice(items, pg.offset(), pg.limit()));
        out.put("total", total);
        out.put("counts", counts);
        return out;
    }

    // ---------------------------------------------------------------- 内部
    /** 类型 → 表名（白名单，防注入） */
    private static String tableFor(String type) {
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
    private List<Map<String, Object>> selectRows(String type, String status, Long authorId, int cap) {
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

    private long countRows(String type, String status, Long authorId) {
        Filter f = filter(status, authorId);
        Long v = jdbc.queryForObject("SELECT COUNT(*) c FROM " + tableFor(type) + f.whereSql(), Long.class, f.args().toArray());
        return v == null ? 0 : v;
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

    private record Page(int limit, int offset) {
    }

    /** 分页参数（对应 review.js 的 pageArgs）：limit 缺省 50、收敛到 1..200；offset 缺省 0、不为负 */
    private static Page pageArgs(String limit, String offset) {
        int lim = Validators.num(limit, 50);
        if (lim < 1) lim = 50;
        if (lim > MAX_LIMIT) lim = MAX_LIMIT;
        int off = Validators.num(offset, 0);
        if (off < 0) off = 0;
        return new Page(lim, off);
    }

    /** 对应 JS 的 slice(offset, offset+limit)：越界给空列表 */
    private static List<Map<String, Object>> slice(List<Map<String, Object>> items, int offset, int limit) {
        int from = Math.min(offset, items.size());
        int to = (int) Math.min((long) offset + limit, items.size());
        return items.subList(from, to);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private static long numOr0(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
