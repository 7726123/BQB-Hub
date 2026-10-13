package bqbhub.server.system;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;
import java.util.Map;

/** 匿名统计与客户端日志的读写（SQL 逐字来自原 SystemController）；口径/裁剪策略在 {@link TelemetryService}。 */
@Repository
public class TelemetryRepository {

    private final JdbcTemplate jdbc;

    public TelemetryRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 设备心跳：版本字段每次都覆盖（空值 = 跑内置网页包，也要如实记下来） */
    void upsertDevice(String id, long now, String day, String appVersion, String webVersion, String platform) {
        jdbc.update("INSERT INTO devices (install_id, first_ts, last_ts, first_day, last_day, app_version, web_version, platform) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON CONFLICT(install_id) DO UPDATE SET last_ts = excluded.last_ts, last_day = excluded.last_day, "
                        + "app_version = excluded.app_version, web_version = excluded.web_version, platform = excluded.platform",
                id, now, now, day, day, appVersion, webVersion, platform);
    }

    void insertDeviceDay(String id, String day) {
        jdbc.update("INSERT OR IGNORE INTO device_days (install_id, day) VALUES (?, ?)", id, day);
    }

    long count(String sql, Object... args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }

    List<Map<String, Object>> versionsByApp() {
        return jdbc.queryForList("SELECT app_version v, COUNT(*) c FROM devices GROUP BY app_version ORDER BY c DESC LIMIT 8");
    }

    List<Map<String, Object>> versionsByWeb() {
        return jdbc.queryForList("SELECT web_version w, COUNT(*) c FROM devices GROUP BY web_version ORDER BY c DESC LIMIT 8");
    }

    void insertClientLog(Object ts, Object v, Object plat, Object kind, Object msg, String ua, Object w) {
        jdbc.update("INSERT INTO client_logs (ts, app_version, platform, kind, msg, ua, web) VALUES (?, ?, ?, ?, ?, ?, ?)",
                ts, v, plat, kind, msg, ua, w);
    }

    /** 按保留期裁剪（每 200 次写入才调一次） */
    void deleteClientLogsBefore(long cutoff) {
        jdbc.update("DELETE FROM client_logs WHERE ts < ?", cutoff);
    }

    List<Map<String, Object>> clientLogs(int limit) {
        return jdbc.queryForList(
                "SELECT ts, app_version, platform, kind, msg, ua, web FROM client_logs ORDER BY ts DESC LIMIT ?", limit);
    }
}
