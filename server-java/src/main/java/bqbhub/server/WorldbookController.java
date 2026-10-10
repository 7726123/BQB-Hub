package bqbhub.server;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 世界书路由（逐条对应 server/src/routes/worldbook.js）：
 * 列表 / 检索 / 上传 / 元数据补写 / 详情 / 删除 / 预览 / 下载。
 * 审核门（status）、admin_only、封面整串校验、路径安全与下载计数口径全部照抄 Node 版。
 */
@RestController
@RequestMapping("/api/worldbook")
public class WorldbookController {

    private static final Pattern CATEGORY = Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9 _-]{1,12}$");
    private static final Pattern TAG = Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9 ·_-]+$");
    private static final String COLS = "id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, meta, admin_only, likes, comments, commenters";

    private final JdbcTemplate jdbc;
    private final AppConfig cfg;
    private final AuthService auth;
    private final Limiters limiters;

    public WorldbookController(JdbcTemplate jdbc, AppConfig cfg, AuthService auth, Limiters limiters) {
        this.jdbc = jdbc;
        this.cfg = cfg;
        this.auth = auth;
        this.limiters = limiters;
    }

    // ---------------------------------------------------------------- 列表（含 q 走检索）
    @GetMapping("/list")
    public Map<String, Object> list(@RequestParam(required = false) String q,
                                    @RequestParam(required = false) String category,
                                    @RequestParam(required = false) String sort,
                                    @RequestParam(required = false) String page,
                                    @RequestParam(required = false) String pageSize,
                                    @RequestParam(required = false) String strict,
                                    @RequestParam(required = false) String nsfw,
                                    HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureReadAllowed(me, req);
        boolean admin = auth.isAdmin(req);
        String query = Validators.cut(Validators.trim(Validators.str(q)), 120);
        int pageNum = Math.max(1, Validators.num(page, 1));
        int size = Validators.num(pageSize, 20);
        if (size < 1) size = 20;
        if (size > 50) size = 50;

        if (!query.isEmpty()) {
            Map<String, Object> o = new LinkedHashMap<>();
            o.put("q", query);
            o.put("page", page);
            o.put("pageSize", size);
            o.put("sort", sort);
            o.put("strict", strict);
            o.put("nsfw", nsfw);
            o.put("admin", admin);
            Map<String, Object> r = WbSearch.search(jdbc, o);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("items", Social.withLiked(jdbc, "worldbook", castItems(r.get("items")), me.id));
            out.put("total", r.get("total"));
            out.put("page", pageNum);
            out.put("pageSize", size);
            out.put("modes", r.get("modes"));
            out.put("facets", r.get("facets"));
            return out;
        }

        String cat = Validators.trim(Validators.str(category));
        String sortKey = Validators.str(sort).isEmpty() ? "new" : Validators.str(sort);
        int offset = (pageNum - 1) * size;
        List<String> conds = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        if (!admin) conds.add("admin_only = 0");
        conds.add("status = 'approved'");   // 未过审的稿子不进公开列表（作者在「我的投稿」里看自己的）
        if (!cat.isEmpty()) {
            conds.add("category = ?");
            args.add(cat);
        }
        String whereSql = conds.isEmpty() ? "" : " WHERE " + String.join(" AND ", conds);

        if ("active".equals(sortKey)) {
            Map<Long, Long> act = Social.activeScores(jdbc, "worldbook", System.currentTimeMillis() - Social.ACTIVE_WINDOW_MS);
            Map<String, Object> out = new LinkedHashMap<>();
            if (act.isEmpty()) {
                out.put("items", List.of());
                out.put("total", 0);
                out.put("page", pageNum);
                out.put("pageSize", size);
                out.put("sort", sortKey);
                return out;
            }
            List<Long> ids = new ArrayList<>(act.keySet());
            ids.sort((a, b) -> Long.compare(act.get(b), act.get(a)));
            String ph = String.join(",", ids.stream().map(x -> "?").toList());
            List<Object> args2 = new ArrayList<>(args);
            args2.addAll(ids);
            List<Map<String, Object>> rows = jdbc.queryForList(
                    "SELECT " + COLS + " FROM world_books" + (whereSql.isEmpty() ? " WHERE " : whereSql + " AND ") + "id IN (" + ph + ")", args2.toArray());
            Map<Long, Map<String, Object>> byId = new LinkedHashMap<>();
            for (Map<String, Object> r : rows) byId.put(((Number) r.get("id")).longValue(), r);
            List<Map<String, Object>> ordered = new ArrayList<>();
            for (Long id : ids) if (byId.containsKey(id)) ordered.add(byId.get(id));
            int from = Math.min(offset, ordered.size());
            int to = Math.min(offset + size, ordered.size());
            List<Map<String, Object>> pageRows = new ArrayList<>();
            for (Map<String, Object> r : ordered.subList(from, to)) pageRows.add(WbSearch.decorate(r));
            out.put("items", Social.withLiked(jdbc, "worldbook", pageRows, me.id));
            out.put("total", ordered.size());
            out.put("page", pageNum);
            out.put("pageSize", size);
            out.put("sort", sortKey);
            return out;
        }

        String order = "hot".equals(sortKey)
                ? "(likes + " + Social.SCORE_COMMENT_WEIGHT + " * commenters) DESC, created_at DESC"
                : "created_at DESC";
        long total = one("SELECT COUNT(*) c FROM world_books" + whereSql, args.toArray());
        List<Object> args3 = new ArrayList<>(args);
        args3.add(size);
        args3.add(offset);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + COLS + " FROM world_books" + whereSql + " ORDER BY " + order + " LIMIT ? OFFSET ?", args3.toArray());
        List<Map<String, Object>> decorated = new ArrayList<>();
        for (Map<String, Object> r : rows) decorated.add(WbSearch.decorate(r));
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", Social.withLiked(jdbc, "worldbook", decorated, me.id));
        out.put("total", total);
        out.put("page", pageNum);
        out.put("pageSize", size);
        out.put("sort", sortKey);
        return out;
    }

    // ---------------------------------------------------------------- 检索
    @GetMapping("/search")
    public Map<String, Object> search(@RequestParam(required = false) String q,
                                     @RequestParam(required = false) String sort,
                                     @RequestParam(required = false) String page,
                                     @RequestParam(required = false) String pageSize,
                                     @RequestParam(required = false) String strict,
                                     @RequestParam(required = false) String nsfw,
                                     HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureReadAllowed(me, req);
        String query = Validators.cut(Validators.trim(Validators.str(q)), 200);
        if (query.isEmpty()) throw ApiError.of(400, "缺少查询词");
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("q", query);
        o.put("page", page);
        o.put("pageSize", Validators.str(pageSize).isEmpty() ? 20 : pageSize);
        o.put("sort", sort);
        o.put("strict", strict);
        o.put("nsfw", nsfw);
        o.put("admin", auth.isAdmin(req));
        return WbSearch.search(jdbc, o);
    }

    // ---------------------------------------------------------------- 上传
    @PostMapping("/upload")
    public Map<String, Object> upload(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureUploadAllowed(me);
        Map<String, Object> b = body == null ? Map.of() : body;
        String title = Validators.trim(Validators.str(b.get("title")));
        String description = Validators.cut(Validators.trim(Validators.str(b.get("description"))), 500);
        String category = Validators.trim(Validators.str(b.get("category")));
        if (category.isEmpty()) category = "综合";
        String content = Validators.str(b.get("content"));
        String tags = normalizeTags(b.get("tags"));
        Map<String, Object> meta = normalizeMeta(b.get("meta"));
        boolean wantsAdminOnly = Validators.num(b.get("adminOnly"), 0) != 0;
        if (wantsAdminOnly && !auth.isAdmin(req)) throw ApiError.of(403, "设置 adminOnly 需要管理员令牌");
        int adminOnly = wantsAdminOnly ? 1 : 0;
        String cover = Validators.str(b.get("cover"));

        if (!(title.length() >= 1 && title.length() <= 60)) throw ApiError.of(400, "标题需 1-60 字符");
        if (!CATEGORY.matcher(category).matches()) throw ApiError.of(400, "分类格式不正确");
        if (content.isEmpty() || content.length() > 2 * 1024 * 1024) throw ApiError.of(400, "世界书内容不能为空且需小于 2MB");
        try {
            new com.fasterxml.jackson.databind.ObjectMapper().readTree(content);
        } catch (Exception e) {
            throw ApiError.of(400, "文件内容不是有效的 JSON");
        }
        if (!cover.isEmpty()) {
            if (cover.length() > Media.COVER_MAX) throw ApiError.of(400, "封面图片过大（需小于 320KB）");
            if (!Media.validCover(cover)) throw ApiError.of(400, "封面格式不正确");
        } else {
            cover = "";
        }

        // 机械抽取补全元数据（角色名/条目名/条目数/字数），与客户端 AI 摘要合并
        Map<String, Object> auto = WbSearch.extractMeta(content);
        meta = mergeMeta(auto, meta);

        long now = System.currentTimeMillis();
        // 审核门：管理员自己上传直接公开（他就是审核者），其余人一律待审
        String status = auth.isAdmin(req) ? "approved" : "pending";
        long id = insertAndReturnId("INSERT INTO world_books (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, search_text, admin_only, status) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)",
                title, description, category, tags, me.id, me.username, "",
                content.getBytes(StandardCharsets.UTF_8).length, now, cover, toJson(meta), "", adminOnly, status);
        String filename = "wb_" + id + ".json";
        Path dir = cfg.uploadDir.resolve("worldbook");
        try {
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(filename), content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw ApiError.of(500, "写入文件失败");
        }
        String searchText = WbSearch.buildSearchText(rowForText(title, description, tags, category), meta);
        jdbc.update("UPDATE world_books SET filename = ?, search_text = ? WHERE id = ?", filename, searchText, id);
        // 不建 FTS 索引（Java 侧与 Node 运行时行为一致，见 WbSearch 注释）
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        out.put("status", status);
        return out;
    }

    // ---------------------------------------------------------------- 元数据补写（秒上传的后台回填）
    @PostMapping("/meta")
    public Map<String, Object> meta(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureMetaAllowed(me);
        Map<String, Object> b = body == null ? Map.of() : body;
        long id = Validators.num(b.get("id"), 0);
        Map<String, Object> row = firstRow("SELECT id, title, description, category, tags, author_id, meta FROM world_books WHERE id = ?", id);
        if (row == null) throw ApiError.of(404, "未找到该世界书");
        long authorId = ((Number) row.get("author_id")).longValue();
        if (authorId != me.id && !auth.isAdmin(req)) throw ApiError.of(403, "只能补写自己上传的世界书");
        Map<String, Object> incoming = normalizeMeta(b.get("meta"));
        if (incoming == null) throw ApiError.of(400, "元数据格式不正确");
        Map<String, Object> prev = WbSearch.parseMeta(Validators.str(row.get("meta")));
        if (prev == null) prev = new LinkedHashMap<>();
        Map<String, Object> merged = new LinkedHashMap<>();
        merged.putAll(incoming);
        // 机械抽取的结构字段不被 AI 摘要覆盖（与上传时同一口径）
        merged.put("chars", nonEmpty(prev.get("chars")) ? prev.get("chars") : incoming.getOrDefault("chars", List.of()));
        merged.put("entryNames", nonEmpty(prev.get("entryNames")) ? prev.get("entryNames") : incoming.getOrDefault("entryNames", List.of()));
        merged.put("entryCount", numOr(prev.get("entryCount"), numOr(incoming.get("entryCount"), 0)));
        merged.put("words", numOr(prev.get("words"), numOr(incoming.get("words"), 0)));
        String tags = normalizeTags(b.get("tags"));
        String useTags = tags.isEmpty() ? Validators.str(row.get("tags")) : tags;
        Map<String, Object> textRow = rowForText(Validators.str(row.get("title")), Validators.str(row.get("description")), useTags, Validators.str(row.get("category")));
        String searchText = WbSearch.buildSearchText(textRow, merged);
        jdbc.update("UPDATE world_books SET meta = ?, search_text = ?, tags = ? WHERE id = ?", toJson(merged), searchText, useTags, id);
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 详情 / 预览 / 下载 / 删除
    @GetMapping("/detail")
    public Map<String, Object> detail(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureReadAllowed(me, req);
        Map<String, Object> row = firstRow("SELECT " + COLS + ", status FROM world_books WHERE id = ?", Validators.num(id, 0));
        if (row == null) throw ApiError.of(404, "未找到该世界书");
        if (isAdminOnly(row) && !auth.isAdmin(req)) throw ApiError.of(404, "未找到该世界书");
        if (!canSee(req, me, row)) throw ApiError.of(404, "未找到该世界书");
        return Map.of("item", Social.withLiked(jdbc, "worldbook", List.of(WbSearch.decorate(row)), me.id).get(0));
    }

    @GetMapping("/preview")
    public Map<String, Object> preview(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureReadAllowed(me, req);
        Map<String, Object> row = firstRow("SELECT id, title, filename, admin_only, author_id, status FROM world_books WHERE id = ?", Validators.num(id, 0));
        Path abs = payloadOrFail(row, me, req, "未找到该世界书");
        // 预览不计下载数（助手/详情弹层里"查看全部条目"用）
        String text;
        try {
            text = Files.readString(abs, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw ApiError.of(404, "文件已丢失");
        }
        List<Object> entries = new ArrayList<>();
        try {
            var node = new com.fasterxml.jackson.databind.ObjectMapper().readTree(text);
            if (node != null && node.path("entries").isArray()) {
                for (var e : node.path("entries")) entries.add(new com.fasterxml.jackson.databind.ObjectMapper().convertValue(e, Map.class));
            }
        } catch (Exception e) {
            throw ApiError.of(500, "内容解析失败");
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("title", row.get("title"));
        out.put("entries", entries);
        return out;
    }

    @GetMapping("/download")
    public ResponseEntity<Resource> download(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        ensureReadAllowed(me, req);
        Map<String, Object> row = firstRow("SELECT id, title, filename, admin_only, author_id, status FROM world_books WHERE id = ?", Validators.num(id, 0));
        Path abs = payloadOrFail(row, me, req, "未找到该世界书");
        byte[] body;
        try {
            body = Files.readAllBytes(abs);
        } catch (IOException e) {
            throw ApiError.of(404, "文件已丢失");
        }
        jdbc.update("UPDATE world_books SET downloads = downloads + 1 WHERE id = ?", Validators.num(id, 0));
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/json; charset=utf-8")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"worldbook_" + Validators.num(id, 0) + ".json\"")
                .body(new ByteArrayResource(body));
    }

    @DeleteMapping("/delete")
    public Map<String, Object> delete(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        long wid = Validators.num(id, 0);
        Map<String, Object> row = firstRow("SELECT id, author_id, filename, admin_only FROM world_books WHERE id = ?", wid);
        if (row == null) throw ApiError.of(404, "未找到该世界书");
        boolean isOwner = ((Number) row.get("author_id")).longValue() == me.id;
        if (!isOwner && !(isAdminOnly(row) && auth.isAdmin(req))) throw ApiError.of(403, "只能删除自己上传的世界书");
        jdbc.update("DELETE FROM world_books WHERE id = ?", wid);
        if (!isOwner) ReviewLog.log(jdbc, "worldbook", wid, "delete", "", "admin");   // 管理员删他人内容 → 留痕
        Social.purgeCard(jdbc, "worldbook", wid);   // 级联清掉它的点赞与评论
        Media.removePayload(cfg, "worldbook", Validators.str(row.get("filename")), null);
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 内部
    private Path payloadOrFail(Map<String, Object> row, AuthService.User me, HttpServletRequest req, String notFoundMsg) {
        if (row == null || Validators.str(row.get("filename")).isEmpty()) throw ApiError.of(404, notFoundMsg);
        if (isAdminOnly(row) && !auth.isAdmin(req)) throw ApiError.of(404, notFoundMsg);
        if (!canSee(req, me, row)) throw ApiError.of(404, notFoundMsg);
        Path root = cfg.uploadDir.normalize();
        Path abs = root.resolve("worldbook").resolve(Validators.str(row.get("filename"))).normalize();
        if (!abs.startsWith(root)) throw ApiError.of(400, "非法路径");
        if (!Files.isRegularFile(abs)) throw ApiError.of(404, "文件已丢失");
        return abs;
    }

    /** 单行可见性：管理员全可见；其余人只可见已通过的、或自己上传的（fail closed） */
    private boolean canSee(HttpServletRequest req, AuthService.User me, Map<String, Object> row) {
        if (auth.isAdmin(req)) return true;
        if ("approved".equals(Validators.str(row.get("status")))) return true;
        Object authorId = row.get("author_id");
        return authorId instanceof Number n && n.longValue() == me.id;
    }

    private static boolean isAdminOnly(Map<String, Object> row) {
        Object v = row.get("admin_only");
        return v instanceof Number n && n.longValue() != 0;
    }

    private void ensureReadAllowed(AuthService.User me, HttpServletRequest req) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
    }

    private void ensureUploadAllowed(AuthService.User me) {
        if (!limiters.upload.allow("u" + me.id)) throw ApiError.of(429, "上传过于频繁，请稍后再试");
    }

    private void ensureMetaAllowed(AuthService.User me) {
        if (!limiters.meta.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
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

    private static Map<String, Object> rowForText(String title, String description, String tags, String category) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("title", title);
        row.put("description", description);
        row.put("tags", tags);
        row.put("category", category);
        return row;
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

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> castItems(Object o) {
        return o instanceof List<?> l ? (List<Map<String, Object>>) l : new ArrayList<>();
    }

    private String toJson(Object o) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(o);
        } catch (Exception e) {
            return "{}";
        }
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long one(String sql, Object[] args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }

    private long insertAndReturnId(String sql, Object... args) {
        var keyHolder = new org.springframework.jdbc.support.GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(sql, java.sql.Statement.RETURN_GENERATED_KEYS);
            for (int i = 0; i < args.length; i++) ps.setObject(i + 1, args[i]);
            return ps;
        }, keyHolder);
        Number key = keyHolder.getKey();
        return key == null ? 0 : key.longValue();
    }
}
