package bqbhub.server.review;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Media;
import bqbhub.server.Validators;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 审核队列（管理员）+ 我的投稿（作者），逐条对应 server/src/routes/review.js。
 *
 * 管理员侧沿用 App 的「管理员模式」凭证（X-Admin-Token，见 AuthService.isAdmin），不引入新口令体系；
 * 管理员守卫（限流桶 + 令牌）在 support/AdminGuard.requireReview，由 Controller 调用。
 * 队列默认只列待审，并附带三类内容的待审计数供角标显示；
 * 作者侧给一个自己的投稿列表：未过审的内容不进公开列表，作者要能在别处看到自己的稿子与状态。
 */
@Service
public class ReviewService {

    /** 类型白名单（与 Repository 的 tableFor 对应） */
    static final List<String> TYPES = List.of("worldbook", "preset", "plugin");
    static final List<String> STATUS_OK = List.of("pending", "approved", "rejected");
    static final int MAX_LIMIT = 200;
    static final int MAX_SCAN = 500;

    /** 三类内容合并排序：created_at 倒序（List.sort 稳定，同刻时保持类型顺序，与 Node 的稳定排序一致） */
    private static final Comparator<Map<String, Object>> BY_CREATED_DESC =
            (a, b) -> Long.compare(numOr0(b.get("created_at")), numOr0(a.get("created_at")));

    private final ReviewRepository repo;
    private final AppConfig cfg;
    private final Limiters limiters;

    public ReviewService(ReviewRepository repo, AppConfig cfg, Limiters limiters) {
        this.repo = repo;
        this.cfg = cfg;
        this.limiters = limiters;
    }

    // ---------------------------------------------------------------- 审核队列（管理员）

    public Map<String, Object> queue(String type, String status, String limit, String offset) {
        String ty = Validators.trim(Validators.str(type));
        if (!ty.isEmpty() && ReviewRepository.tableFor(ty) == null) throw ApiError.of(400, "未知的内容类型");
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
        for (String t : types) items.addAll(repo.selectRows(t, st, null, cap));
        items.sort(BY_CREATED_DESC);
        long total = 0;
        for (String t : types) total += repo.countRows(t, st, null);
        Map<String, Object> counts = new LinkedHashMap<>();
        for (String t : TYPES) counts.put(t, repo.countRows(t, "pending", null));

        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", slice(items, pg.offset(), pg.limit()));
        out.put("total", total);
        out.put("counts", counts);
        return out;
    }

    // ---------------------------------------------------------------- 通过 / 驳回（管理员）

    public Map<String, Object> action(Map<String, Object> body) {
        String type = Validators.str(body.get("type"));
        if (ReviewRepository.tableFor(type) == null) throw ApiError.of(400, "未知的内容类型");
        long id = Validators.num(body.get("id"), 0);
        String action = Validators.str(body.get("action"));
        if (!"approve".equals(action) && !"reject".equals(action)) throw ApiError.of(400, "未知的审核动作");
        Map<String, Object> row = repo.rowForAction(type, id);
        if (row == null) throw ApiError.of(404, "未找到该内容");

        String status = "approve".equals(action) ? "approved" : "rejected";
        repo.updateStatus(type, id, status, System.currentTimeMillis());
        if ("reject".equals(action)) {
            // 驳回保留记录（作者能看到状态并自行删除），但内容文件当场删掉：
            // 不合格内容不该继续留在服务器磁盘上，这是「审核不只看状态、还要真正下架」的落点
            Media.removePayload(cfg, type, Validators.str(row.get("filename")), Validators.str(row.get("plugin_id")));
        }
        repo.logAction(type, id, action, Validators.str(body.get("note")));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("type", type);
        out.put("id", id);
        out.put("status", status);
        return out;
    }

    // ---------------------------------------------------------------- 我的投稿（作者视角）

    public Map<String, Object> mySubmissions(String limit, String offset, AuthService.User me) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        Page pg = pageArgs(limit, offset);

        int cap = (int) Math.min((long) pg.offset() + pg.limit(), MAX_SCAN);
        List<Map<String, Object>> items = new ArrayList<>();
        for (String t : TYPES) items.addAll(repo.selectRows(t, null, me.id, cap));
        items.sort(BY_CREATED_DESC);
        long total = 0;
        for (String t : TYPES) total += repo.countRows(t, null, me.id);
        long pending = 0;
        long rejected = 0;
        for (String t : TYPES) {
            pending += repo.countRows(t, "pending", me.id);
            rejected += repo.countRows(t, "rejected", me.id);
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

    private static long numOr0(Object o) {
        return o instanceof Number n ? n.longValue() : 0;
    }
}
