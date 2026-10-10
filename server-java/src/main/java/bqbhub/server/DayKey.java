package bqbhub.server;

import java.time.Instant;
import java.time.ZoneId;

/**
 * 统计分日：按中国时区（对应 Node 版 `new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai'})`，
 * 输出 YYYY-MM-DD）。服务器可能在 UTC，客户端在 +8，用上海时区保证「今天」与用户感知一致。
 */
public final class DayKey {

    public static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private DayKey() {
    }

    public static String day(long ts) {
        return Instant.ofEpochMilli(ts).atZone(ZONE).toLocalDate().toString();
    }

    public static String today() {
        return day(System.currentTimeMillis());
    }

    public static String daysAgo(int n) {
        return day(System.currentTimeMillis() - n * 86400000L);
    }
}
