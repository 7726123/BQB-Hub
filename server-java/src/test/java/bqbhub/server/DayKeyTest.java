package bqbhub.server;

import org.junit.jupiter.api.Test;

import java.time.Instant;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 统计分日：一律按 Asia/Shanghai（服务器可能在 UTC，客户端在 +8）。 */
class DayKeyTest {

    @Test
    void 按上海时区切日() {
        assertEquals("1970-01-01", DayKey.day(0));
        // 上海 = UTC+8：UTC 15:59:59 还是当天，16:00:00 就跨到次日
        assertEquals("2026-01-01", DayKey.day(Instant.parse("2026-01-01T15:59:59Z").toEpochMilli()));
        assertEquals("2026-01-02", DayKey.day(Instant.parse("2026-01-01T16:00:00Z").toEpochMilli()));
        assertEquals("2025-12-31", DayKey.day(Instant.parse("2025-12-31T15:59:59Z").toEpochMilli()));
    }

    @Test
    void 格式与相对日() {
        assertTrue(DayKey.today().matches("\\d{4}-\\d{2}-\\d{2}"));
        assertEquals(DayKey.today(), DayKey.daysAgo(0));
        assertEquals(DayKey.day(System.currentTimeMillis() - 86400000L), DayKey.daysAgo(1));
        assertEquals(DayKey.day(System.currentTimeMillis() - 7 * 86400000L), DayKey.daysAgo(7));
    }
}
