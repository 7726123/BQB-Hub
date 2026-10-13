package bqbhub.server.worldbook;

import bqbhub.server.Validators;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 世界书元数据与标签的规范化（原 WorldbookController 的私有静态方法，一个字段都没改）。
 * 全是纯函数：服务器只校验/截断/合并，不调任何模型；机械抽取（{@link WbSearch#extractMeta}）
 * 与客户端摘要的合并口径也在 {@link #mergeMeta}。
 */
final class WorldbookMeta {

    private static final Pattern TAG = Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9 ·_-]+$");

    private WorldbookMeta() {
    }

    /** 标签：逗号分隔、去重、单个 ≤12 字、最多 12 个 */
    static String normalizeTags(Object raw) {
        List<String> out = new ArrayList<>();
        String[] arr = Validators.str(raw).split("[,，]");
        for (String s : arr) {
            String t = s.trim();
            if (t.isEmpty()) continue;
            if (t.length() > 12) continue;
            if (!TAG.matcher(t).matches()) continue;
            if (!out.contains(t)) out.add(t);
            if (out.size() >= 12) break;
        }
        return String.join(",", out);
    }

    /** 元数据规范（客户端可用自己的 key 生成，服务器只校验与截断，不调任何模型） */
    static Map<String, Object> normalizeMeta(Object raw) {
        Object m = raw;
        if (m instanceof String s) {
            try {
                m = new com.fasterxml.jackson.databind.ObjectMapper().readValue(s, Map.class);
            } catch (Exception e) {
                m = null;
            }
        }
        if (!(m instanceof Map<?, ?> rawMap)) return null;
        Map<String, Object> mm = castMap(rawMap);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("genre", cut(mm.get("genre"), 12));
        out.put("audience", cut(mm.get("audience"), 8));
        out.put("relation", cut(mm.get("relation"), 8));
        out.put("franchise", cut(mm.get("franchise"), 40));
        out.put("nsfw", truthy(mm.get("nsfw")));
        out.put("chars", strList(mm.get("chars"), 30, 20));
        out.put("entryNames", strList(mm.get("entryNames"), 60, 40));
        out.put("entryCount", numOr(mm.get("entryCount"), 0));
        out.put("words", numOr(mm.get("words"), 0));
        out.put("summary", cut(mm.get("summary"), 240));
        out.put("summaryBy", cut(mm.get("summaryBy"), 12));
        return out;
    }

    /** 上传时的合并：机械抽取兜底，客户端元数据优先，但结构字段（chars/entryNames/条目数/字数）以抽取为准 */
    static Map<String, Object> mergeMeta(Map<String, Object> auto, Map<String, Object> meta) {
        Map<String, Object> out = new LinkedHashMap<>();
        if (meta != null) {
            out.putAll(meta);
        } else {
            out.put("genre", "");
            out.put("audience", "");
            out.put("relation", "");
            out.put("franchise", "");
            out.put("nsfw", false);
        }
        out.put("chars", nonEmpty(meta == null ? null : meta.get("chars")) ? meta.get("chars") : auto.get("chars"));
        out.put("entryNames", nonEmpty(meta == null ? null : meta.get("entryNames")) ? meta.get("entryNames") : auto.get("entryNames"));
        out.put("entryCount", auto.get("entryCount"));
        out.put("words", auto.get("words"));
        if (meta == null) {
            out.put("summary", "");
            out.put("summaryBy", "");
        }
        return out;
    }

    /** 补写时的合并（/meta）：结构字段不被 AI 摘要覆盖（与上传时同一口径） */
    static Map<String, Object> mergeForBackfill(Map<String, Object> prev, Map<String, Object> incoming) {
        Map<String, Object> merged = new LinkedHashMap<>();
        merged.putAll(incoming);
        merged.put("chars", nonEmpty(prev.get("chars")) ? prev.get("chars") : incoming.getOrDefault("chars", List.of()));
        merged.put("entryNames", nonEmpty(prev.get("entryNames")) ? prev.get("entryNames") : incoming.getOrDefault("entryNames", List.of()));
        merged.put("entryCount", numOr(prev.get("entryCount"), numOr(incoming.get("entryCount"), 0)));
        merged.put("words", numOr(prev.get("words"), numOr(incoming.get("words"), 0)));
        return merged;
    }

    static Map<String, Object> rowForText(String title, String description, String tags, String category) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("title", title);
        row.put("description", description);
        row.put("tags", tags);
        row.put("category", category);
        return row;
    }

    /** meta 落库用的 JSON（键顺序取自 LinkedHashMap，与 Node 版一致） */
    static String toJson(Object o) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(o);
        } catch (Exception e) {
            return "{}";
        }
    }

    private static String cut(Object v, int n) {
        return Validators.cut(Validators.str(v).trim(), n);
    }

    private static List<String> strList(Object v, int maxItems, int each) {
        List<String> out = new ArrayList<>();
        if (v instanceof List<?> list) {
            for (Object x : list) {
                String s = Validators.cut(Validators.str(x).trim(), each);
                if (!s.isEmpty()) out.add(s);
                if (out.size() >= maxItems) break;
            }
        }
        return out;
    }

    private static boolean nonEmpty(Object o) {
        return o instanceof List<?> l && !l.isEmpty();
    }

    private static int numOr(Object o, int dflt) {
        return o instanceof Number n ? n.intValue() : dflt;
    }

    private static boolean truthy(Object o) {
        if (o instanceof Boolean b) return b;
        String s = Validators.str(o);
        return "1".equals(s) || "true".equalsIgnoreCase(s);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Map<?, ?> m) {
        return (Map<String, Object>) m;
    }
}
