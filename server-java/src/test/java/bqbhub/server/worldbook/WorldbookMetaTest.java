package bqbhub.server.worldbook;

import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** 世界书元数据的纯函数规则（原 WorldbookController 的私有静态方法）：标签/元数据规范化与两种合并口径。 */
class WorldbookMetaTest {

    @Test
    void 标签_去重限长限个且过滤非法字符() {
        assertEquals("奇幻,校园", WorldbookMeta.normalizeTags("奇幻，校园"));
        assertEquals("奇幻,校园", WorldbookMeta.normalizeTags(" 奇幻 , 奇幻 , 校园 "));
        assertEquals("", WorldbookMeta.normalizeTags(null));
        assertEquals("", WorldbookMeta.normalizeTags(""));
        assertEquals("", WorldbookMeta.normalizeTags("a".repeat(13)));           // 单个超 12 字丢掉
        assertEquals("abc", WorldbookMeta.normalizeTags("abc,<script>"));         // 非法字符丢掉
        List<String> many = new java.util.ArrayList<>();
        for (int i = 0; i < 20; i++) many.add("t" + i);
        assertEquals(12, WorldbookMeta.normalizeTags(String.join(",", many)).split(",").length);
    }

    @Test
    void 元数据_字符串或Map都收_非法返回null() {
        assertNull(WorldbookMeta.normalizeMeta(null));
        assertNull(WorldbookMeta.normalizeMeta("不是 JSON"));
        assertNull(WorldbookMeta.normalizeMeta(123));

        Map<String, Object> fromString = WorldbookMeta.normalizeMeta("{\"genre\":\"奇幻\",\"nsfw\":\"1\"}");
        assertEquals("奇幻", fromString.get("genre"));
        assertEquals(true, fromString.get("nsfw"));

        Map<String, Object> in = new LinkedHashMap<>();
        in.put("genre", "g".repeat(20));
        in.put("summary", "s".repeat(300));
        in.put("audience", "成年向");
        in.put("nsfw", true);
        in.put("chars", List.of(" 林晚 ", "", "x".repeat(30)));
        in.put("entryCount", 5);
        in.put("words", 1234);
        in.put("unknown", "被丢掉");
        Map<String, Object> m = WorldbookMeta.normalizeMeta(in);
        assertEquals("g".repeat(12), m.get("genre"), "genre 截到 12 字");
        assertEquals("s".repeat(240), m.get("summary"), "summary 截到 240 字");
        assertEquals(List.of("林晚", "x".repeat(20)), m.get("chars"), "条目去空、单个截 20 字");
        assertEquals(5, m.get("entryCount"));
        assertEquals(1234, m.get("words"));
        assertEquals(true, m.get("nsfw"));
        assertFalse(m.containsKey("unknown"), "未声明的 key 不进 meta");
        assertEquals(List.of("genre", "audience", "relation", "franchise", "nsfw", "chars", "entryNames", "entryCount", "words", "summary", "summaryBy"),
                List.of(m.keySet().toArray()), "键与顺序都要对齐 Node 版（meta 会原样落库并参与检索）");
    }

    @Test
    void 上传合并_条目数与字数以机械抽取为准() {
        Map<String, Object> auto = WbSearch.extractMeta("{\"entries\":[{\"name\":\"林晚\",\"type\":\"角色\",\"content\":\"黑长发\"}]}");
        assertEquals(1, auto.get("entryCount"));
        assertEquals(List.of("林晚"), auto.get("chars"));

        // 客户端摘要里的 chars/entryNames 非空时优先（AI 只挑重点角色），但条目数/字数永远用抽取结果
        Map<String, Object> meta = WorldbookMeta.normalizeMeta("{\"genre\":\"奇幻\",\"chars\":[\"假的\"],\"entryCount\":99,\"words\":123,\"summary\":\"一句话\"}");
        Map<String, Object> merged = WorldbookMeta.mergeMeta(auto, meta);
        assertEquals("奇幻", merged.get("genre"));
        assertEquals("一句话", merged.get("summary"));
        assertEquals(List.of("假的"), merged.get("chars"), "客户端给了 chars 就用客户端的（与 Node 版一致）");
        assertEquals(1, merged.get("entryCount"), "条目数不信任客户端");
        assertEquals(3, merged.get("words"), "字数不信任客户端（'黑长发' 3 字）");

        // 客户端没给 chars 时，用机械抽取兜底
        Map<String, Object> onlySummary = WorldbookMeta.normalizeMeta("{\"summary\":\"只给摘要\"}");
        assertEquals(List.of("林晚"), WorldbookMeta.mergeMeta(auto, onlySummary).get("chars"));

        // 没有客户端元数据时：抽取兜底 + 空摘要
        Map<String, Object> bare = WorldbookMeta.mergeMeta(auto, null);
        assertEquals("", bare.get("genre"));
        assertEquals("", bare.get("summary"));
        assertEquals(List.of("林晚"), bare.get("chars"));
        assertEquals(1, bare.get("entryCount"));
    }

    @Test
    void 补写合并_已有结构字段不被新摘要覆盖() {
        Map<String, Object> prev = WorldbookMeta.normalizeMeta("{\"chars\":[\"林晚\"],\"entryNames\":[\"林晚\"],\"entryCount\":1,\"words\":10}");
        Map<String, Object> incoming = WorldbookMeta.normalizeMeta("{\"chars\":[\"新的\"],\"entryCount\":99,\"words\":999,\"summary\":\"新摘要\"}");
        Map<String, Object> merged = WorldbookMeta.mergeForBackfill(prev, incoming);
        assertEquals(List.of("林晚"), merged.get("chars"));
        assertEquals(1, merged.get("entryCount"));
        assertEquals(10, merged.get("words"));
        assertEquals("新摘要", merged.get("summary"), "摘要这类描述字段按 incoming（AI 补写）走");

        // normalizeMeta 出来的 prev 总是带 chars/entryNames/entryCount/words 四个键（空数组/0），
        // 所以「prev 的结构字段优先」对它们一律成立：incoming 只可能补上 prev 里没有的键
        Map<String, Object> prevEmpty = WorldbookMeta.normalizeMeta("{}");
        Map<String, Object> merged2 = WorldbookMeta.mergeForBackfill(prevEmpty, incoming);
        assertEquals(List.of("新的"), merged2.get("chars"), "prev 的 chars 是空数组 → 用 incoming");
        assertEquals(0, merged2.get("entryCount"), "prev 的 entryCount 是 0（Number）→ 仍按 prev 走，不取 incoming");
    }

    @Test
    void 检索文本_只拼元信息不拼正文() {
        Map<String, Object> row = WorldbookMeta.rowForText("剑与魔法", "简介", "奇幻", "综合");
        Map<String, Object> meta = WorldbookMeta.normalizeMeta("{\"summary\":\"摘要文本\",\"chars\":[\"林晚\"],\"genre\":\"奇幻\"}");
        String text = WbSearch.buildSearchText(row, meta);
        assertTrue(text.contains("剑与魔法") && text.contains("摘要文本") && text.contains("林晚"));
        assertFalse(text.contains("  "), "空白已归一");
    }
}
