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
 * 预设路由（逐条对应 server/src/routes/preset.js）：列表 / 上传 / 详情 / 删除 / 下载。
 * 与世界书同构，差别：没有 meta/search_text/admin_only，检索只在 title/description 上做 LIKE。
 * 排序口径（new / hot / active）与卡片的 likes/commenters 计数共用 Social。
 */
@RestController
@RequestMapping("/api/preset")
public class PresetController {

    private static final Pattern CATEGORY = Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9 _-]{1,12}$");
    private static final String COLS = "id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, likes, comments, commenters";

    private final JdbcTemplate jdbc;
    private final AppConfig cfg;
    private final AuthService auth;
    private final Limiters limiters;

    public PresetController(JdbcTemplate jdbc, AppConfig cfg, AuthService auth, Limiters limiters) {
        this.jdbc = jdbc;
        this.cfg = cfg;
        this.auth = auth;
        this.limiters = limiters;
    }

    @GetMapping("/list")
    public Map<String, Object> list(@RequestParam(required = false) String category,
                                    @RequestParam(required = false) String q,
                                    @RequestParam(required = false) String sort,
                                    @RequestParam(required = false) String page,
                                    @RequestParam(required = false) String pageSize,
                                    HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        String cat = Validators.trim(Validators.str(category));
        String query = Validators.cut(Validators.trim(Validators.str(q)), 60);
        String sortKey = Validators.str(sort).isEmpty() ? "new" : Validators.str(sort);
        int pageNum = Math.max(1, Validators.num(page, 1));
        int size = Validators.num(pageSize, 20);
        if (size < 1) size = 20;
        if (size > 50) size = 50;
        int offset = (pageNum - 1) * size;

        List<String> conds = new ArrayList<>();
        List<Object> args = new ArrayList<>();
        conds.add("status = 'approved'");   // 未过审的稿子不进公开列表
        if (!cat.isEmpty()) {
            conds.add("category = ?");
            args.add(cat);
        }
        if (!query.isEmpty()) {
            conds.add("(title LIKE ? OR description LIKE ?)");
            args.add("%" + query + "%");
            args.add("%" + query + "%");
        }
        String whereSql = " WHERE " + String.join(" AND ", conds);

        Map<String, Object> out = new LinkedHashMap<>();
        if ("active".equals(sortKey)) {
            Map<Long, Long> act = Social.activeScores(jdbc, "preset", System.currentTimeMillis() - Social.ACTIVE_WINDOW_MS);
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
                    "SELECT " + COLS + " FROM presets" + whereSql + " AND id IN (" + ph + ")", args2.toArray());
            Map<Long, Map<String, Object>> byId = new LinkedHashMap<>();
            for (Map<String, Object> r : rows) byId.put(((Number) r.get("id")).longValue(), r);
            List<Map<String, Object>> ordered = new ArrayList<>();
            for (Long id : ids) if (byId.containsKey(id)) ordered.add(byId.get(id));
            int from = Math.min(offset, ordered.size());
            int to = Math.min(offset + size, ordered.size());
            out.put("items", Social.withLiked(jdbc, "preset", new ArrayList<>(ordered.subList(from, to)), me.id));
            out.put("total", ordered.size());
            out.put("page", pageNum);
            out.put("pageSize", size);
            out.put("sort", sortKey);
            return out;
        }

        String order = "hot".equals(sortKey)
                ? "(likes + " + Social.SCORE_COMMENT_WEIGHT + " * commenters) DESC, created_at DESC"
                : "created_at DESC";
        long total = one("SELECT COUNT(*) c FROM presets" + whereSql, args.toArray());
        List<Object> args3 = new ArrayList<>(args);
        args3.add(size);
        args3.add(offset);
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT " + COLS + " FROM presets" + whereSql + " ORDER BY " + order + " LIMIT ? OFFSET ?", args3.toArray());
        out.put("items", Social.withLiked(jdbc, "preset", rows, me.id));
        out.put("total", total);
        out.put("page", pageNum);
        out.put("pageSize", size);
        out.put("sort", sortKey);
        return out;
    }

    @PostMapping("/upload")
    public Map<String, Object> upload(@RequestBody(required = false) Map<String, Object> body, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.upload.allow("u" + me.id)) throw ApiError.of(429, "上传过于频繁，请稍后再试");
        Map<String, Object> b = body == null ? Map.of() : body;
        String title = Validators.trim(Validators.str(b.get("title")));
        String description = Validators.cut(Validators.trim(Validators.str(b.get("description"))), 500);
        String category = Validators.trim(Validators.str(b.get("category")));
        if (category.isEmpty()) category = "综合";
        String content = Validators.str(b.get("content"));
        String cover = Validators.str(b.get("cover"));
        if (!(title.length() >= 1 && title.length() <= 60)) throw ApiError.of(400, "标题需 1-60 字符");
        if (!CATEGORY.matcher(category).matches()) throw ApiError.of(400, "分类格式不正确");
        if (content.isEmpty() || content.length() > 2 * 1024 * 1024) throw ApiError.of(400, "预设内容不能为空且需小于 2MB");
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
        long now = System.currentTimeMillis();
        String status = auth.isAdmin(req) ? "approved" : "pending";
        long id = insertAndReturnId("INSERT INTO presets (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, status) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)",
                title, description, category, "", me.id, me.username, "",
                content.getBytes(StandardCharsets.UTF_8).length, now, cover, status);
        String filename = "ps_" + id + ".json";
        try {
            Path dir = cfg.uploadDir.resolve("preset");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(filename), content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw ApiError.of(500, "写入文件失败");
        }
        jdbc.update("UPDATE presets SET filename = ? WHERE id = ?", filename, id);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        out.put("status", status);
        return out;
    }

    @GetMapping("/detail")
    public Map<String, Object> detail(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        Map<String, Object> row = firstRow("SELECT " + COLS + ", status FROM presets WHERE id = ?", Validators.num(id, 0));
        if (row == null) throw ApiError.of(404, "未找到该预设");
        if (!canSee(req, me, row)) throw ApiError.of(404, "未找到该预设");
        return Map.of("item", Social.withLiked(jdbc, "preset", List.of(row), me.id).get(0));
    }

    @DeleteMapping("/delete")
    public Map<String, Object> delete(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        long pid = Validators.num(id, 0);
        Map<String, Object> row = firstRow("SELECT id, author_id, filename FROM presets WHERE id = ?", pid);
        if (row == null) throw ApiError.of(404, "未找到该预设");
        if (((Number) row.get("author_id")).longValue() != me.id) throw ApiError.of(403, "只能删除自己上传的预设");
        jdbc.update("DELETE FROM presets WHERE id = ?", pid);
        Social.purgeCard(jdbc, "preset", pid);   // 级联清掉它的点赞与评论
        Media.removePayload(cfg, "preset", Validators.str(row.get("filename")), null);
        return Map.of("ok", true);
    }

    @GetMapping("/download")
    public ResponseEntity<Resource> download(@RequestParam(required = false) String id, HttpServletRequest req) {
        AuthService.User me = auth.requireUser(req);
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        long pid = Validators.num(id, 0);
        Map<String, Object> row = firstRow("SELECT id, title, filename, author_id, status FROM presets WHERE id = ?", pid);
        if (row == null || Validators.str(row.get("filename")).isEmpty()) throw ApiError.of(404, "未找到该预设");
        if (!canSee(req, me, row)) throw ApiError.of(404, "未找到该预设");
        Path root = cfg.uploadDir.normalize();
        Path abs = root.resolve("preset").resolve(Validators.str(row.get("filename"))).normalize();
        if (!abs.startsWith(root)) throw ApiError.of(400, "非法路径");
        if (!Files.isRegularFile(abs)) throw ApiError.of(404, "文件已丢失");
        byte[] body;
        try {
            body = Files.readAllBytes(abs);
        } catch (IOException e) {
            throw ApiError.of(404, "文件已丢失");
        }
        jdbc.update("UPDATE presets SET downloads = downloads + 1 WHERE id = ?", pid);
        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_TYPE, "application/json; charset=utf-8")
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"preset_" + pid + ".json\"")
                .body(new ByteArrayResource(body));
    }

    // ---------------------------------------------------------------- 内部
    private boolean canSee(HttpServletRequest req, AuthService.User me, Map<String, Object> row) {
        if (auth.isAdmin(req)) return true;
        if ("approved".equals(Validators.str(row.get("status")))) return true;
        Object authorId = row.get("author_id");
        return authorId instanceof Number n && n.longValue() == me.id;
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
