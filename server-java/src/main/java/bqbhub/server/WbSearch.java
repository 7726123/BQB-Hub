package bqbhub.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 世界书检索（逐条对应 server/src/wbsearch.js）：无向量、无模型，靠「多路 LIKE + 别名词典 +
 * facet 软过滤 + RRF 融合 + 热度/新鲜度打分」把对的卡放进候选。
 *
 * 与 Node 版的唯一差别：**不建 FTS5 索引**。Node 运行时（node:sqlite）没有 FTS5，走的本来就是
 * LIKE 兜底；Java 侧保持一致，两边的检索结果才可比（契约测试 review/worldbook-meta/api 都会验检索命中）。
 */
public final class WbSearch {

    static final int MAX_LIMIT = 50;
    static final int CAND_LIMIT = 60;

    private static final ObjectMapper JSON = new ObjectMapper();

    // ---------- 查询侧：问句外壳 + 停用词 + 别名词典 + facet 词典 ----------
    private static final Pattern SHELL_RE = Pattern.compile(
            "有没有|有吗|有木有|想找|想要|想看|推荐|给我|找一下|来几张|来一个|一些|一下|那种|这类|这种|的卡|的设定集|的世界书|世界观|世界书|设定集|卡|吗|呢|了|啊|吧|，|。|？|\\?|、|的|和|与|或|跟|差不多|类似|出场|登场");
    private static final Pattern CJK_RUN = Pattern.compile("[\\u4e00-\\u9fff]+");
    private static final Set<String> CN_STOP = Set.of("的", "了", "是", "有", "和", "与", "在", "我", "你", "他", "她", "它", "这", "那", "吗", "呢", "吧", "啊", "都", "也", "还", "就", "很", "要", "想", "个", "些", "把", "被", "给", "对", "到", "中", "上", "下", "不", "没");

    private static final Map<String, List<String>> SYN = new LinkedHashMap<>();
    private static final Map<String, String> FACET_AUDIENCE = new LinkedHashMap<>();
    private static final Map<String, String> FACET_RELATION = new LinkedHashMap<>();
    private static final Map<String, String> FACET_FANFIC = new LinkedHashMap<>();
    private static final Map<String, List<String>> GENRE_WORDS = new LinkedHashMap<>();

    static {
        SYN.put("剑与魔法", List.of("奇幻", "西幻", "魔法", "骑士", "公会", "冒险者"));
        SYN.put("赛博朋克", List.of("赛博", "义体", "霓虹", "黑客", "公司城市"));
        SYN.put("克苏鲁", List.of("克苏鲁", "旧神", "理智", "不可名状"));
        SYN.put("武侠", List.of("武侠", "仙侠", "剑修", "江湖", "宗门", "修真"));
        SYN.put("校园", List.of("校园", "学园", "社团", "青春"));
        SYN.put("女性向", List.of("女性向", "乙女", "少女向"));
        SYN.put("男性向", List.of("男性向"));
        SYN.put("一般向", List.of("一般向"));
        SYN.put("BL", List.of("BL", "耽美", "腐向"));
        SYN.put("GL", List.of("GL", "百合"));
        SYN.put("纯爱", List.of("纯爱", "一对一"));
        SYN.put("后宫", List.of("后宫", "多女主", "多男主"));
        SYN.put("同人", List.of("同人", "二创"));

        FACET_AUDIENCE.put("女性向", "女性向");
        FACET_AUDIENCE.put("乙女", "女性向");
        FACET_AUDIENCE.put("乙女向", "女性向");
        FACET_AUDIENCE.put("男性向", "男性向");
        FACET_AUDIENCE.put("一般向", "一般向");
        FACET_RELATION.put("BL", "BL");
        FACET_RELATION.put("耽美", "BL");
        FACET_RELATION.put("腐向", "BL");
        FACET_RELATION.put("GL", "GL");
        FACET_RELATION.put("百合", "GL");
        FACET_RELATION.put("纯爱", "纯爱");
        FACET_RELATION.put("后宫", "后宫");
        FACET_RELATION.put("无恋爱线", "无恋爱线");
        FACET_FANFIC.put("同人", "1");
        FACET_FANFIC.put("二创", "1");

        GENRE_WORDS.put("剑与魔法", List.of("剑与魔法", "西幻", "魔法", "骑士", "剑与"));
        GENRE_WORDS.put("赛博朋克", List.of("赛博朋克", "赛博", "义体", "霓虹", "黑客", "科技"));
        GENRE_WORDS.put("克苏鲁恐怖", List.of("克苏鲁", "旧神", "理智"));
        GENRE_WORDS.put("武侠仙侠", List.of("武侠", "仙侠", "江湖", "宗门", "修真", "剑修"));
        GENRE_WORDS.put("校园日常", List.of("校园", "学园", "社团"));
        GENRE_WORDS.put("异世界转生", List.of("异世界", "转生", "穿越"));
        GENRE_WORDS.put("废土末日", List.of("废土", "末日", "末世"));
        GENRE_WORDS.put("蒸汽朋克", List.of("蒸汽朋克", "飞空艇"));
        GENRE_WORDS.put("悬疑推理", List.of("悬疑", "推理", "侦探", "案件"));
        GENRE_WORDS.put("恋爱喜剧", List.of("恋爱喜剧", "恋爱", "甜"));
        GENRE_WORDS.put("历史架空", List.of("历史", "架空", "古代", "宫廷"));
        GENRE_WORDS.put("神话幻想", List.of("神话", "幻想"));
        GENRE_WORDS.put("偶像音乐", List.of("偶像", "音乐", "乐队", "歌手"));
        GENRE_WORDS.put("体育竞技", List.of("体育", "竞技", "运动"));
        GENRE_WORDS.put("职场社会", List.of("职场", "社会", "上班"));
        GENRE_WORDS.put("医疗题材", List.of("医疗", "医生", "医院"));
        GENRE_WORDS.put("学园异能", List.of("异能", "超能力", "能力者", "都市"));
        GENRE_WORDS.put("田园治愈", List.of("田园", "治愈", "乡村"));
        GENRE_WORDS.put("战争军事", List.of("战争", "军事"));
        GENRE_WORDS.put("奇幻冒险", List.of("奇幻", "冒险"));
        GENRE_WORDS.put("喜剧日常", List.of("喜剧", "搞笑"));
        GENRE_WORDS.put("战斗奇幻", List.of("战斗", "热血"));
        GENRE_WORDS.put("古代宫廷", List.of("宫廷", "后宫争斗"));
    }

    private WbSearch() {
    }

    /** 分析结果：检索词 + 识别到的 facet 约束 */
    public static final class Query {
        public final List<String> terms = new ArrayList<>();
        public final Map<String, String> facets = new LinkedHashMap<>();
    }

    /** 把用户口语问句拆成检索词 + facet 约束（对应 analyzeQuery） */
    public static Query analyzeQuery(JdbcTemplate jdbc, String text) {
        String raw = Validators.str(text);
        Query out = new Query();
        out.facets.put("audience", "");
        out.facets.put("relation", "");
        out.facets.put("fanfic", "0");
        out.facets.put("genre", "");
        out.facets.put("franchise", "");
        for (Map.Entry<String, String> e : FACET_AUDIENCE.entrySet()) if (raw.contains(e.getKey())) out.facets.put("audience", e.getValue());
        for (Map.Entry<String, String> e : FACET_RELATION.entrySet()) if (raw.contains(e.getKey())) out.facets.put("relation", e.getValue());
        for (String w : FACET_FANFIC.keySet()) if (raw.contains(w)) out.facets.put("fanfic", "1");
        for (Map.Entry<String, List<String>> e : GENRE_WORDS.entrySet()) {
            for (String w : e.getValue()) {
                if (raw.contains(w)) { out.facets.put("genre", e.getKey()); break; }
            }
        }
        // 原作名：与库里已有 franchise 做包含匹配（"败犬女主" → "败犬女主太多了"）
        try {
            for (Map<String, Object> r : jdbc.queryForList(
                    "SELECT DISTINCT json_extract(meta, '$.franchise') AS fr FROM world_books WHERE fr IS NOT NULL AND fr != ''")) {
                String fr = Validators.str(r.get("fr"));
                String shortFr = fr.replaceFirst("^我的", "");
                if (!fr.isEmpty() && (raw.contains(fr) || (shortFr.length() >= 2 && raw.contains(shortFr)))) {
                    out.facets.put("franchise", fr);
                    break;
                }
            }
        } catch (Exception e) { /* meta 不可用时忽略 */ }

        String t = raw;
        for (Map.Entry<String, List<String>> e : SYN.entrySet()) {
            if (t.contains(e.getKey())) t += " " + String.join(" ", e.getValue());
        }
        Set<String> terms = new LinkedHashSet<>();
        Matcher latin = Pattern.compile("[a-zA-Z][a-zA-Z0-9]+").matcher(t);
        while (latin.find()) terms.add(latin.group().toLowerCase());
        Matcher digits = Pattern.compile("[0-9]+").matcher(raw);
        while (digits.find()) terms.add(digits.group());
        Matcher runs = CJK_RUN.matcher(SHELL_RE.matcher(t).replaceAll(" "));
        while (runs.find()) {
            String run = runs.group();
            if (run.length() <= 5) terms.add(run);   // 含单字：交给 LIKE 通道
            for (int n = 2; n <= 3; n++) {
                for (int i = 0; i + n <= run.length(); i++) terms.add(run.substring(i, i + n));
            }
        }
        String franchise = Validators.str(out.facets.get("franchise"));
        if (!franchise.isEmpty()) terms.add(franchise);
        String genre = Validators.str(out.facets.get("genre"));
        if (!genre.isEmpty()) terms.add(genre);

        for (String x : terms) {
            if (CN_STOP.contains(x)) continue;
            if (out.terms.size() >= 40) break;
            out.terms.add(x);
        }
        return out;
    }

    /** 从上传的世界书 JSON 机械抽取元数据（零成本；AI 摘要只在客户端做） */
    public static Map<String, Object> extractMeta(String contentJson) {
        List<String> chars = new ArrayList<>();
        List<String> entryNames = new ArrayList<>();
        int entryCount = 0;
        int words = 0;
        try {
            JsonNode book = JSON.readTree(Validators.str(contentJson));
            JsonNode entries = book == null ? null : book.path("entries");
            if (entries != null && entries.isArray()) {
                entryCount = entries.size();
                for (JsonNode e : entries) {
                    String type = e.path("type").asText("");
                    String name = e.path("name").asText("").trim();
                    if (!name.isEmpty()) entryNames.add(Validators.cut(name, 40));
                    if ("角色".equals(type) && !name.isEmpty()) {
                        chars.add(Validators.cut(name.replaceFirst("^姓名[:：]\\s*", ""), 20));
                    }
                    words += countNonSpace(e.path("content").asText(""));
                }
            }
        } catch (Exception e) { /* 非法 JSON 由上传校验拦下，这里静默 */ }
        if (chars.size() > 30) chars = new ArrayList<>(chars.subList(0, 30));
        if (entryNames.size() > 60) entryNames = new ArrayList<>(entryNames.subList(0, 60));
        Map<String, Object> meta = new LinkedHashMap<>();
        meta.put("chars", chars);
        meta.put("entryNames", entryNames);
        meta.put("entryCount", entryCount);
        meta.put("words", words);
        return meta;
    }

    /** 检索文本 = 标题 + 简介 + 标签 + 分类 + 元数据（条目正文不进索引） */
    public static String buildSearchText(Map<String, Object> row, Map<String, Object> meta) {
        Map<String, Object> m = meta == null ? Map.of() : meta;
        String s = String.join(" ",
                Validators.str(row.get("title")), Validators.str(row.get("description")),
                Validators.str(row.get("tags")), Validators.str(row.get("category")),
                Validators.str(m.get("summary")), Validators.str(m.get("genre")),
                Validators.str(m.get("audience")), Validators.str(m.get("relation")),
                Validators.str(m.get("franchise")),
                joinList(m.get("chars")), joinList(m.get("entryNames")));
        return s.replaceAll("\\s+", " ").trim();
    }

    /**
     * 检索（对应 search）。参数：q / page / pageSize / sort / strict / admin / nsfw。
     * 返回 {items, total, modes, facets, terms}。
     */
    public static Map<String, Object> search(JdbcTemplate jdbc, Map<String, Object> o) {
        String q = Validators.trim(Validators.str(o.get("q")));
        int page = Math.max(1, Validators.num(o.get("page"), 1));
        int pageSize = Math.min(MAX_LIMIT, Math.max(1, Validators.num(o.get("pageSize"), 20)));
        String sort = ("hot".equals(o.get("sort")) || "new".equals(o.get("sort"))) ? String.valueOf(o.get("sort")) : "relevance";
        boolean strict = truthy(o.get("strict"));
        boolean admin = truthy(o.get("admin"));

        Query aq = q.isEmpty() ? new Query() : analyzeQuery(jdbc, q);
        List<String> terms = aq.terms;
        Map<String, String> facets = q.isEmpty() ? new LinkedHashMap<>() : aq.facets;

        List<String> where = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (!admin) where.add("admin_only = 0");
        where.add("status = 'approved'");   // 审核门：待审稿不进检索（管理员也一样）
        String nsfw = Validators.str(o.get("nsfw"));
        if ("1".equals(nsfw) || "0".equals(nsfw)) {
            int want = "1".equals(nsfw) ? 1 : 0;
            int other = want == 1 ? 0 : 1;
            where.add("(CAST(json_extract(meta, '$.nsfw') AS INTEGER) = ? OR json_extract(meta, '$.nsfw') IS NULL OR CAST(json_extract(meta, '$.nsfw') AS INTEGER) != ?)");
            args.add(want);
            args.add(other);
        }
        String baseWhere = where.isEmpty() ? "" : " WHERE " + String.join(" AND ", where);
        String adminCond = admin ? "IN (0,1)" : "= 0";

        Map<Long, Double> cand = new LinkedHashMap<>();
        Map<String, Object> modes = new LinkedHashMap<>();
        modes.put("fts", 0);
        modes.put("like", 0);
        modes.put("facet", 0);
        modes.put("browse", 0);

        if (!terms.isEmpty()) {
            for (String t : terms) {
                // 没有 FTS5：所有词都走 LIKE 通道（2 字以下权重 0.8）
                List<Map<String, Object>> rows = jdbc.queryForList(
                        "SELECT id FROM world_books WHERE search_text LIKE ? AND admin_only " + adminCond
                                + " AND status = 'approved' LIMIT ?", "%" + t + "%", CAND_LIMIT);
                if (!rows.isEmpty()) {
                    modes.put("like", ((Number) modes.get("like")).intValue() + 1);
                    addRun(cand, rows, t.length() >= 3 ? 1.0 : 0.8);
                }
            }
            List<Object[]> facetGroups = new ArrayList<>();   // {sql, val, weight}
            if (!Validators.str(facets.get("audience")).isEmpty()) {
                facetGroups.add(new Object[]{"json_extract(meta, '$.audience') = ?", facets.get("audience"), 1.8});
            }
            if (!Validators.str(facets.get("relation")).isEmpty()) {
                facetGroups.add(new Object[]{"json_extract(meta, '$.relation') = ?", facets.get("relation"), 1.8});
            }
            if (!Validators.str(facets.get("genre")).isEmpty()) {
                facetGroups.add(new Object[]{"json_extract(meta, '$.genre') = ?", facets.get("genre"), 1.6});
            }
            if (!Validators.str(facets.get("franchise")).isEmpty()) {
                facetGroups.add(new Object[]{"json_extract(meta, '$.franchise') = ?", facets.get("franchise"), 2.2});
            }
            for (Object[] g : facetGroups) {
                try {
                    List<Map<String, Object>> rows = jdbc.queryForList(
                            "SELECT id FROM world_books WHERE " + g[0] + (admin ? "" : " AND admin_only = 0")
                                    + " AND status = 'approved' LIMIT ?", g[1], CAND_LIMIT);
                    if (!rows.isEmpty()) {
                        modes.put("facet", ((Number) modes.get("facet")).intValue() + 1);
                        addRun(cand, rows, ((Number) g[2]).doubleValue());
                    }
                } catch (Exception e) { /* json_extract 不可用时忽略 */ }
            }
            if (facetGroups.size() >= 2) {
                try {
                    StringBuilder sql = new StringBuilder("SELECT id FROM world_books WHERE ");
                    List<Object> vals = new ArrayList<>();
                    for (int i = 0; i < facetGroups.size(); i++) {
                        if (i > 0) sql.append(" AND ");
                        sql.append(facetGroups.get(i)[0]);
                        vals.add(facetGroups.get(i)[1]);
                    }
                    sql.append(admin ? "" : " AND admin_only = 0").append(" AND status = 'approved' LIMIT ?");
                    vals.add(CAND_LIMIT);
                    List<Map<String, Object>> rows = jdbc.queryForList(sql.toString(), vals.toArray());
                    addRun(cand, rows, 2.5);
                } catch (Exception e) { /* ignore */ }
            }
        }

        // 「用户没输入」与「查询词被全部过滤掉」是两件事：后者必须返回空结果而不是退回全量列表
        boolean hasFacet = !Validators.str(facets.get("audience")).isEmpty()
                || !Validators.str(facets.get("relation")).isEmpty()
                || "1".equals(Validators.str(facets.get("fanfic")))
                || !Validators.str(facets.get("genre")).isEmpty()
                || !Validators.str(facets.get("franchise")).isEmpty();
        List<String> termsShown = terms.size() > 12 ? terms.subList(0, 12) : terms;
        if (cand.isEmpty()) {
            if (terms.isEmpty() && !q.isEmpty() && !hasFacet) {
                modes.put("tooShort", 1);
                return result(List.of(), 0, modes, facets, List.of());
            }
            if (terms.isEmpty()) {
                modes.put("browse", 1);
                String order = "hot".equals(sort) ? "downloads DESC, created_at DESC" : "created_at DESC";
                long total = one(jdbc, "SELECT COUNT(*) c FROM world_books" + baseWhere, args.toArray());
                List<Object> args2 = new ArrayList<>(args);
                args2.add(pageSize);
                args2.add((page - 1) * pageSize);
                List<Map<String, Object>> items = jdbc.queryForList(
                        "SELECT " + SELECT_COLS + " FROM world_books" + baseWhere + " ORDER BY " + order + " LIMIT ? OFFSET ?",
                        args2.toArray());
                List<Map<String, Object>> decorated = new ArrayList<>();
                for (Map<String, Object> r : items) decorated.add(decorate(r));
                return result(decorated, total, modes, facets, termsShown);
            }
            modes.put("browse", 1);
            return result(List.of(), 0, modes, facets, termsShown);
        }

        // 打分：RRF + 热度 + 新鲜度 + 已标注加分；strict 丢弃未标注
        List<Long> ids = new ArrayList<>(cand.keySet());
        String ph = String.join(",", ids.stream().map(x -> "?").toList());
        List<Object> args3 = new ArrayList<>(ids);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + SELECT_COLS + " FROM world_books WHERE id IN (" + ph + ")"
                        + (admin ? "" : " AND admin_only = 0") + " AND status = 'approved'", args3.toArray());

        List<Object[]> scored = new ArrayList<>();   // {row, score, meta}
        for (Map<String, Object> row : rows) {
            Map<String, Object> meta = parseMeta(Validators.str(row.get("meta")));
            double s = cand.getOrDefault(((Number) row.get("id")).longValue(), 0.0);
            s += Math.log10(1 + Validators.num(row.get("downloads"), 0)) * 0.12;
            s += (Validators.num(row.get("created_at"), 0) / 1.7e12) * 0.15;
            if (meta != null && !Validators.str(meta.get("audience")).isEmpty()) s += 0.05;
            if (!Validators.str(facets.get("audience")).isEmpty()
                    && meta != null && Validators.str(facets.get("audience")).equals(Validators.str(meta.get("audience")))) s += 0.25;
            if (!Validators.str(facets.get("relation")).isEmpty()
                    && meta != null && Validators.str(facets.get("relation")).equals(Validators.str(meta.get("relation")))) s += 0.25;
            if (strict) {
                if (!Validators.str(facets.get("audience")).isEmpty()
                        && (meta == null || !Validators.str(facets.get("audience")).equals(Validators.str(meta.get("audience"))))) continue;
                if (!Validators.str(facets.get("relation")).isEmpty()
                        && (meta == null || !Validators.str(facets.get("relation")).equals(Validators.str(meta.get("relation"))))) continue;
            }
            scored.add(new Object[]{row, s});
        }
        scored.sort((a, b) -> Double.compare((Double) b[1], (Double) a[1]));
        int total = scored.size();
        int from = (page - 1) * pageSize;
        List<Map<String, Object>> pageItems = new ArrayList<>();
        for (int i = from; i < Math.min(from + pageSize, scored.size()); i++) {
            pageItems.add(decorate((Map<String, Object>) scored.get(i)[0]));
        }
        return result(pageItems, total, modes, facets, termsShown);
    }

    /** 列表项附带解析出的元数据（键与顺序都对齐 Node 版 decorate） */
    public static Map<String, Object> decorate(Map<String, Object> row) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", row.get("id"));
        m.put("title", row.get("title"));
        m.put("description", row.get("description"));
        m.put("category", row.get("category"));
        m.put("tags", row.get("tags"));
        m.put("author_id", row.get("author_id"));
        m.put("author_name", row.get("author_name"));
        m.put("size", row.get("size"));
        m.put("downloads", row.get("downloads"));
        m.put("created_at", row.get("created_at"));
        m.put("cover", row.get("cover"));
        m.put("admin_only", row.get("admin_only"));
        m.put("meta", parseMeta(Validators.str(row.get("meta"))));
        m.put("status", row.get("status"));
        m.put("likes", row.get("likes") == null ? 0 : row.get("likes"));
        m.put("comments", row.get("comments") == null ? 0 : row.get("comments"));
        m.put("commenters", row.get("commenters") == null ? 0 : row.get("commenters"));
        return m;
    }

    static final String SELECT_COLS = "id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, meta, admin_only, likes, comments, commenters";

    // ---------------------------------------------------------------- 内部
    private static void addRun(Map<Long, Double> cand, List<Map<String, Object>> rows, double weight) {
        for (int pos = 0; pos < rows.size(); pos++) {
            long id = ((Number) rows.get(pos).get("id")).longValue();
            cand.merge(id, weight / (60 + pos + 1), Double::sum);
        }
    }

    private static Map<String, Object> result(List<Map<String, Object>> items, long total,
                                             Map<String, Object> modes, Map<String, String> facets, List<String> terms) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", items);
        out.put("total", total);
        out.put("modes", modes);
        out.put("facets", facets);
        out.put("terms", terms);
        return out;
    }

    private static long one(JdbcTemplate jdbc, String sql, Object[] args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }

    private static boolean truthy(Object o) {
        if (o == null) return false;
        if (o instanceof Boolean b) return b;
        String s = String.valueOf(o);
        return "1".equals(s) || "true".equalsIgnoreCase(s);
    }

    public static Map<String, Object> parseMeta(String metaJson) {
        if (metaJson == null || metaJson.isEmpty()) return null;
        try {
            return JSON.readValue(metaJson, Map.class);
        } catch (Exception e) {
            return null;
        }
    }

    private static String joinList(Object o) {
        if (o instanceof List<?> list) {
            List<String> parts = new ArrayList<>();
            for (Object x : list) parts.add(Validators.str(x));
            return String.join(" ", parts);
        }
        return "";
    }

    private static int countNonSpace(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isWhitespace(c) || c == '\u00a0' || c == '\u3000') continue;
            n++;
        }
        return n;
    }
}
