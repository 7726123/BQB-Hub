package bqbhub.server.feedback;

import bqbhub.server.ApiError;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Validators;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 意见反馈（逐条对应 server/src/routes/feedback.js）：
 *   提交（公开，设备 2 条/分钟 + 三条兜底 + 10 分钟去重 + 1000 条裁剪）
 *   管理端列表 / 标记已读 / 删除。
 * 隐私口径同 Node 版：只存内容 + 随机安装标识 + 版本/平台，**原始 IP 只在内存限流里用，不入库**。
 *
 * 这里持有业务规则与事务边界（插入 + 裁剪必须在同一事务，见 insertAndTrim）；
 * HTTP 的解析/状态码在 FeedbackController，SQL 在 FeedbackRepository。
 * 入参里的 clientIp 由 Controller 从请求上取好（Service 不依赖 servlet 类型，便于单测）。
 */
@Service
public class FeedbackService {

    static final int MAX_LEN = 300;
    static final int MAX_ITEMS = 1000;
    static final long DEDUPE_MS = 10 * 60 * 1000L;
    static final int DEVICE_DAILY_MAX = 20;
    static final int GLOBAL_HOURLY_MAX = 200;
    static final int LIST_MAX = 200;

    private final FeedbackRepository repo;
    private final Limiters limiters;
    private final TransactionTemplate tx;

    public FeedbackService(FeedbackRepository repo, Limiters limiters, PlatformTransactionManager txm) {
        this.repo = repo;
        this.limiters = limiters;
        this.tx = new TransactionTemplate(txm);
    }

    // ---------------------------------------------------------------- 提交（公开）

    public Map<String, Object> submit(Map<String, Object> body, String clientIp) {
        String text = Validators.str(body.get("text")).replace("\r\n", "\n").replace("\r", "\n").trim();
        if (text.isEmpty()) throw ApiError.of(400, "内容不能为空");
        if (Validators.cpLen(text) > MAX_LEN) throw ApiError.of(400, "内容超过 " + MAX_LEN + " 字");
        String installId = Validators.str(body.get("id")).trim();
        if (!Validators.validInstallId(installId)) throw ApiError.of(400, "bad install id");

        long now = System.currentTimeMillis();
        // 用户可见的那条规则放最前面：每分钟 2 条
        if (!limiters.fbDevice.allow("d" + installId)) throw ApiError.of(429, "提得太频繁了，请过一分钟再试");
        if (!limiters.fbIp.allow("ip" + clientIp)) throw ApiError.of(429, "提交过于频繁，请稍后再试");
        if (repo.countByInstallSince(installId, now - 86400000L) >= DEVICE_DAILY_MAX) {
            throw ApiError.of(429, "今天提交得有点多，明天再来吧");
        }
        if (repo.countSince(now - 3600000L) >= GLOBAL_HOURLY_MAX) {
            throw ApiError.of(429, "服务器正忙，请稍后再试");
        }
        // 同设备 10 分钟内重复内容：不重复入库，但仍答「收到」
        if (repo.existsRecentDuplicate(installId, text, now - DEDUPE_MS)) {
            return Map.of("ok", true, "deduped", true);
        }
        try {
            tx.executeWithoutResult(status -> insertAndTrim(text, installId,
                    Validators.cut(body.get("v"), 40), Validators.cut(body.get("plat"), 20), now));
        } catch (Exception e) {
            System.out.println("[feedback] 写入失败: " + e.getMessage());
            throw ApiError.of(500, "store fail");
        }
        return Map.of("ok", true);
    }

    /**
     * 插入 + 裁剪放同一事务（对应 feedback.js 的 insertAndTrim）。
     * 裁剪口径：超 1000 条时**优先删最旧的已查看**，仍未达标才动未查看；裁掉几号就记进 feedback_meta。
     */
    private void insertAndTrim(String text, String installId, String version, String platform, long now) {
        repo.insert(text, installId, version, platform, now);
        int over = (int) repo.countAll() - MAX_ITEMS;
        int trimmed = 0;
        if (over > 0) {
            trimmed += repo.deleteOldestRead(over);
            over = (int) repo.countAll() - MAX_ITEMS;
            if (over > 0) {
                trimmed += repo.deleteOldestUnread(over);
            }
            if (trimmed > 0) {
                repo.bumpTrimmed(trimmed);
            }
        }
    }

    // ---------------------------------------------------------------- 管理端

    public Map<String, Object> adminList(String status, String limit) {
        String st = Validators.trim(Validators.str(status));
        if (st.isEmpty()) st = "unread";
        if (!List.of("unread", "read", "all").contains(st)) throw ApiError.of(400, "未知的状态");
        int lim = Validators.num(limit, 50);
        if (lim < 1) lim = 50;
        if (lim > LIST_MAX) lim = LIST_MAX;
        String where = "unread".equals(st) ? " WHERE read_at IS NULL" : ("read".equals(st) ? " WHERE read_at IS NOT NULL" : "");
        try {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("items", repo.list(where, lim));
            out.put("unread", repo.countUnread());
            out.put("read", repo.countRead());
            out.put("total", repo.countAll());
            out.put("trimmed", repo.trimmed());
            return out;
        } catch (Exception e) {
            System.out.println("[feedback] 读取失败: " + e.getMessage());
            throw ApiError.of(500, "read fail");
        }
    }

    public Map<String, Object> adminRead(Map<String, Object> body) {
        long now = System.currentTimeMillis();
        try {
            if (Boolean.TRUE.equals(body.get("all"))) {
                int n = repo.markAllRead(now);
                return Map.of("ok", true, "changed", n);
            }
            List<Long> ids = parseIds(body.get("ids"));
            if (ids.isEmpty()) throw ApiError.of(400, "没有要标记的条目");
            int changed = 0;
            for (Long id : ids) changed += repo.markRead(id, now);
            return Map.of("ok", true, "changed", changed);
        } catch (ApiError e) {
            throw e;
        } catch (Exception e) {
            throw ApiError.of(500, "mark fail");
        }
    }

    public Map<String, Object> adminDelete(Map<String, Object> body) {
        List<Long> ids = parseIds(body.get("ids") != null ? body.get("ids") : body.get("id"));
        if (ids.isEmpty()) throw ApiError.of(400, "没有要删除的条目");
        try {
            int changed = 0;
            for (Long id : ids) changed += repo.delete(id);
            return Map.of("ok", true, "changed", changed);
        } catch (Exception e) {
            throw ApiError.of(500, "delete fail");
        }
    }

    // ---------------------------------------------------------------- 内部

    private List<Long> parseIds(Object raw) {
        List<Long> ids = new ArrayList<>();
        List<?> list;
        if (raw instanceof List<?> l) list = l;
        else if (raw == null) list = List.of();
        else list = List.of(raw);
        for (Object o : list) {
            long v = Validators.num(o, 0);
            if (v > 0) ids.add(v);
            if (ids.size() >= LIST_MAX) break;
        }
        return ids;
    }
}
