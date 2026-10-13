package bqbhub.server.system;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.DayKey;
import bqbhub.server.Limiters;
import bqbhub.server.Validators;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 遥测面（逐条对应 server/src/routes/system.js 的中段）：匿名设备心跳 / 管理端统计 /
 * 使用助手漏答（落 JSONL，不入库）/ 客户端错误上报（入库 + 定期裁剪）。
 * 隐私口径：只存随机安装标识与版本信息；漏答的 IP 只留 sha256 前 12 位。
 */
@Service
public class TelemetryService {

    static final long ONLINE_MS = 5 * 60 * 1000L;
    static final long CL_KEEP_MS = 90L * 24 * 3600 * 1000;

    private final TelemetryRepository repo;
    private final AppConfig cfg;
    private final Limiters limiters;
    private final ObjectMapper json;
    private final AtomicInteger clInsertCount = new AtomicInteger();

    public TelemetryService(TelemetryRepository repo, AppConfig cfg, Limiters limiters, ObjectMapper json) {
        this.repo = repo;
        this.cfg = cfg;
        this.limiters = limiters;
        this.json = json;
    }

    // ---------------------------------------------------------------- 匿名使用统计

    public Map<String, Object> ping(Map<String, Object> body, String clientIp) {
        String id = Validators.str(body.get("id")).trim();
        if (!Validators.validInstallId(id)) throw ApiError.of(400, "bad install id");
        if (!limiters.ping.allow(clientIp)) throw ApiError.of(429, "rate limited");
        long now = System.currentTimeMillis();
        String day = DayKey.day(now);
        try {
            repo.upsertDevice(id, now, day,
                    Validators.cut(body.get("v"), 40), Validators.cut(body.get("w"), 40), Validators.cut(body.get("plat"), 20));
            repo.insertDeviceDay(id, day);
        } catch (Exception e) {
            throw ApiError.of(500, "store fail");
        }
        return Map.of("ok", true);
    }

    public Map<String, Object> stats() {
        long now = System.currentTimeMillis();
        String today = DayKey.today();
        long feedbackUnread = 0;
        try {
            feedbackUnread = repo.count("SELECT COUNT(*) c FROM feedback WHERE read_at IS NULL");
        } catch (Exception e) { /* 表不存在也照常返回统计 */ }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("feedbackUnread", feedbackUnread);
        m.put("online", repo.count("SELECT COUNT(*) c FROM devices WHERE last_ts >= ?", now - ONLINE_MS));
        m.put("today", repo.count("SELECT COUNT(*) c FROM device_days WHERE day = ?", today));
        m.put("week", repo.count("SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?", DayKey.daysAgo(6)));
        m.put("month", repo.count("SELECT COUNT(DISTINCT install_id) c FROM device_days WHERE day >= ?", DayKey.daysAgo(29)));
        m.put("total", repo.count("SELECT COUNT(*) c FROM devices"));
        m.put("newToday", repo.count("SELECT COUNT(*) c FROM devices WHERE first_day = ?", today));
        m.put("versions", repo.versionsByApp());
        m.put("webs", repo.versionsByWeb());
        m.put("day", today);
        m.put("onlineWindowMs", ONLINE_MS);
        return m;
    }

    // ---------------------------------------------------------------- 使用助手漏答

    public Map<String, Object> assistantMiss(Map<String, Object> body, String clientIp) {
        if (!limiters.miss.allow(clientIp)) throw ApiError.of(429, "rate limited");
        List<Map<String, Object>> conv = new ArrayList<>();
        Object raw = body.get("conversation");
        if (raw instanceof List<?> list) {
            for (Object o : list.subList(0, Math.min(list.size(), 8))) {
                Map<String, Object> m = o instanceof Map<?, ?> mm ? castMap(mm) : Map.of();
                Map<String, Object> item = new LinkedHashMap<>();
                item.put("role", "user".equals(Validators.str(m.get("role"))) ? "user" : "assistant");
                item.put("content", Validators.cut(m.get("content"), 500));
                conv.add(item);
            }
        }
        if (conv.isEmpty()) throw ApiError.of(400, "empty");
        String ipHash = sha256Hex(clientIp).substring(0, 12);
        try {
            Map<String, Object> line = new LinkedHashMap<>();
            line.put("ts", java.time.Instant.now().toString());
            line.put("ipHash", ipHash);
            line.put("conversation", conv);
            Path f = cfg.dataDir.resolve("assistant-misses.jsonl");
            Files.writeString(f, json.writeValueAsString(line) + "\n", StandardCharsets.UTF_8,
                    Files.exists(f) ? StandardOpenOption.APPEND : StandardOpenOption.CREATE);
        } catch (IOException e) {
            throw ApiError.of(500, "store fail");
        }
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 客户端错误上报

    public Map<String, Object> clientLogsPost(Map<String, Object> body, String clientIp, String userAgent) {
        List<Map<String, Object>> items = new ArrayList<>();
        Object raw = body.get("logs");
        if (raw instanceof List<?> list) {
            for (Object o : list.subList(0, Math.min(list.size(), 8))) {
                Map<String, Object> l = o instanceof Map<?, ?> mm ? castMap(mm) : Map.of();
                Map<String, Object> it = new LinkedHashMap<>();
                // 毫秒时间戳必须用 numLong（num() 会 intValue 截断成 1970 年，见 Validators.numLong 注释）
                long lts = Validators.numLong(l.get("t"), 0L);
                it.put("ts", lts != 0L ? lts : System.currentTimeMillis());
                it.put("v", Validators.cut(l.get("v"), 40));
                it.put("plat", Validators.cut(l.get("plat"), 20));
                it.put("kind", Validators.cut(l.get("k"), 60));
                it.put("msg", Validators.cut(l.get("m"), 400));
                it.put("w", Validators.cut(l.get("w"), 40));
                if (!Validators.str(it.get("kind")).isEmpty() && !Validators.str(it.get("msg")).isEmpty()) items.add(it);
            }
        }
        if (items.isEmpty()) throw ApiError.of(400, "empty");
        if (!limiters.clientLogs.allow(clientIp)) throw ApiError.of(429, "rate limited");
        String ua = Validators.cut(userAgent, 200);
        for (Map<String, Object> it : items) {
            repo.insertClientLog(it.get("ts"), it.get("v"), it.get("plat"), it.get("kind"), it.get("msg"), ua, it.get("w"));
        }
        if (clInsertCount.incrementAndGet() % 200 == 0) {
            try {
                repo.deleteClientLogsBefore(System.currentTimeMillis() - CL_KEEP_MS);
            } catch (Exception e) { /* 裁剪失败不影响写入 */ }
        }
        return Map.of("ok", true, "stored", items.size());
    }

    public Map<String, Object> clientLogs(String limitStr) {
        int lim = Math.min(Validators.num(limitStr, 100), 500);
        return Map.of("logs", repo.clientLogs(lim));
    }

    // ---------------------------------------------------------------- 内部

    private static String sha256Hex(String s) {
        try {
            return bqbhub.server.Scrypt.hex(MessageDigest.getInstance("SHA-256").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            return bqbhub.server.Scrypt.hex(new byte[32]);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }
}
