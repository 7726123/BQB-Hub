package bqbhub.server;

import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 审核留痕（对应 server/src/reviewlog.js）：只记「谁在什么时候对哪条内容做了什么」。
 * 刻意不存正文/文件引用 —— 留痕本身不该成为新的风险面。
 * action: approve | reject | delete
 */
public final class ReviewLog {

    private ReviewLog() {
    }

    public static void log(JdbcTemplate jdbc, String targetType, long targetId, String action, String note, String admin) {
        try {
            jdbc.update("INSERT INTO review_log (ts, target_type, target_id, action, note, admin) VALUES (?, ?, ?, ?, ?, ?)",
                    System.currentTimeMillis(), Validators.str(targetType), targetId, Validators.str(action),
                    Validators.cut(note, 200), Validators.str(admin));
        } catch (Exception e) {
            System.out.println("[review] 留痕写入失败: " + e.getMessage());
        }
    }
}
