package bqbhub.server.support;

import bqbhub.server.AuthService;
import bqbhub.server.Validators;

import java.util.Map;

/**
 * 行级可见性：以前 CardController / PresetController / PluginController / WorldbookController
 * 各写一遍同一段判断（三处逐字相同；卡片那处只多了 `me != null` 的守卫——合并后行为等价：
 * 卡片接口允许匿名，me 为 null 时两侧都返回 false）。
 */
public final class Visibility {

    private Visibility() {
    }

    /** 管理员可见全部；已过审（status='approved'）所有人可见；否则只有作者本人看得到。 */
    public static boolean canSee(boolean admin, AuthService.User me, Map<String, Object> row) {
        if (admin) return true;
        if ("approved".equals(Validators.str(row.get("status")))) return true;
        Object authorId = row.get("author_id");
        return me != null && authorId instanceof Number n && n.longValue() == me.id;
    }

    /** admin_only 行（只对管理员可见；与 status 是两套口径，世界书列表/详情/下载都要看它） */
    public static boolean isAdminOnly(Map<String, Object> row) {
        Object v = row.get("admin_only");
        return v instanceof Number n && n.longValue() != 0;
    }
}
