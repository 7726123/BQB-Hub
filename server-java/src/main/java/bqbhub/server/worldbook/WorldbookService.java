package bqbhub.server.worldbook;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Media;
import bqbhub.server.Validators;
import bqbhub.server.support.Visibility;
import org.springframework.stereotype.Service;

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
 * 世界书（逐条对应 server/src/routes/worldbook.js）：
 * 列表 / 检索 / 上传 / 元数据补写 / 详情 / 删除 / 预览 / 下载。
 *
 * 审核门（status）、admin_only、封面整串校验、路径安全与下载计数口径全部照抄 Node 版：
 *   - 列表/检索只出 status='approved'（admin_only 行只给管理员）；
 *   - 单行可见性 = 管理员全可见 / 已过审 / 作者本人（{@link Visibility#canSee}）；
 *   - 载荷路径必须落在 uploadDir 内（越界 → 400 非法路径，文件丢了 → 404）。
 * SQL 在 {@link WorldbookRepository}，HTTP 在 {@link WorldbookController}。
 */
@Service
public class WorldbookService {

    private static final Pattern CATEGORY = Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9 _-]{1,12}$");

    /** 下载响应需要的东西（Controller 负责拼 ResponseEntity 的头） */
    public record Payload(byte[] bytes, long id) {
    }

    private final WorldbookRepository repo;
    private final AppConfig cfg;
    private final Limiters limiters;

    public WorldbookService(WorldbookRepository repo, AppConfig cfg, Limiters limiters) {
        this.repo = repo;
        this.cfg = cfg;
        this.limiters = limiters;
    }

    // ---------------------------------------------------------------- 列表 / 检索

    public Map<String, Object> list(String category, String q, String sort, String page, String pageSize,
                                    String strict, String nsfw, AuthService.User me, boolean admin) {
        ensureReadAllowed(me);
        String query = Validators.cut(Validators.trim(Validators.str(q)), 120);
        int pageNum = Math.max(1, Validators.num(page, 1));
        int size = Validators.num(pageSize, 20);
        if (size < 1) size = 20;
        if (size > 50) size = 50;

        if (!query.isEmpty()) {
            return repo.searchList(query, sort, strict, nsfw, admin, page, pageNum, size, me.id);
        }
        String cat = Validators.trim(Validators.str(category));
        String sortKey = Validators.str(sort).isEmpty() ? "new" : Validators.str(sort);
        return repo.list(cat, sortKey, pageNum, size, me.id, admin);
    }

    public Map<String, Object> search(String q, String sort, String page, String pageSize,
                                      String strict, String nsfw, AuthService.User me, boolean admin) {
        ensureReadAllowed(me);
        String query = Validators.cut(Validators.trim(Validators.str(q)), 200);
        if (query.isEmpty()) throw ApiError.of(400, "缺少查询词");
        Map<String, Object> o = new LinkedHashMap<>();
        o.put("q", query);
        o.put("page", page);
        o.put("pageSize", Validators.str(pageSize).isEmpty() ? 20 : pageSize);
        o.put("sort", sort);
        o.put("strict", strict);
        o.put("nsfw", nsfw);
        o.put("admin", admin);
        return repo.rawSearch(o);
    }

    // ---------------------------------------------------------------- 上传

    public Map<String, Object> upload(Map<String, Object> body, AuthService.User me, boolean admin) {
        ensureUploadAllowed(me);
        String title = Validators.trim(Validators.str(body.get("title")));
        String description = Validators.cut(Validators.trim(Validators.str(body.get("description"))), 500);
        String category = Validators.trim(Validators.str(body.get("category")));
        if (category.isEmpty()) category = "综合";
        String content = Validators.str(body.get("content"));
        String tags = WorldbookMeta.normalizeTags(body.get("tags"));
        Map<String, Object> meta = WorldbookMeta.normalizeMeta(body.get("meta"));
        boolean wantsAdminOnly = Validators.num(body.get("adminOnly"), 0) != 0;
        if (wantsAdminOnly && !admin) throw ApiError.of(403, "设置 adminOnly 需要管理员令牌");
        int adminOnly = wantsAdminOnly ? 1 : 0;
        String cover = Validators.str(body.get("cover"));

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
        meta = WorldbookMeta.mergeMeta(auto, meta);

        long now = System.currentTimeMillis();
        // 审核门：管理员自己上传直接公开（他就是审核者），其余人一律待审
        String status = admin ? "approved" : "pending";
        long id = repo.insert(title, description, category, tags, me.id, me.username,
                content.getBytes(StandardCharsets.UTF_8).length, now, cover, WorldbookMeta.toJson(meta), adminOnly, status);
        String filename = "wb_" + id + ".json";
        Path dir = cfg.uploadDir.resolve("worldbook");
        try {
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(filename), content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw ApiError.of(500, "写入文件失败");
        }
        String searchText = WbSearch.buildSearchText(WorldbookMeta.rowForText(title, description, tags, category), meta);
        repo.setFilenameAndSearchText(id, filename, searchText);
        // 不建 FTS 索引（Java 侧与 Node 运行时行为一致，见 WbSearch 注释）
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        out.put("status", status);
        return out;
    }

    // ---------------------------------------------------------------- 元数据补写（秒上传的后台回填）

    public Map<String, Object> meta(Map<String, Object> body, AuthService.User me, boolean admin) {
        ensureMetaAllowed(me);
        long id = Validators.num(body.get("id"), 0);
        Map<String, Object> row = repo.rowForMeta(id);
        if (row == null) throw ApiError.of(404, "未找到该世界书");
        long authorId = ((Number) row.get("author_id")).longValue();
        if (authorId != me.id && !admin) throw ApiError.of(403, "只能补写自己上传的世界书");
        Map<String, Object> incoming = WorldbookMeta.normalizeMeta(body.get("meta"));
        if (incoming == null) throw ApiError.of(400, "元数据格式不正确");
        Map<String, Object> prev = WbSearch.parseMeta(Validators.str(row.get("meta")));
        if (prev == null) prev = new LinkedHashMap<>();
        Map<String, Object> merged = WorldbookMeta.mergeForBackfill(prev, incoming);
        String tags = WorldbookMeta.normalizeTags(body.get("tags"));
        String useTags = tags.isEmpty() ? Validators.str(row.get("tags")) : tags;
        Map<String, Object> textRow = WorldbookMeta.rowForText(Validators.str(row.get("title")), Validators.str(row.get("description")), useTags, Validators.str(row.get("category")));
        String searchText = WbSearch.buildSearchText(textRow, merged);
        repo.updateMetaAndSearchText(id, WorldbookMeta.toJson(merged), searchText, useTags);
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 详情 / 预览 / 下载 / 删除

    public Map<String, Object> detail(String id, AuthService.User me, boolean admin) {
        ensureReadAllowed(me);
        Map<String, Object> row = repo.rowForDetail(Validators.num(id, 0));
        if (row == null) throw ApiError.of(404, "未找到该世界书");
        if (Visibility.isAdminOnly(row) && !admin) throw ApiError.of(404, "未找到该世界书");
        if (!Visibility.canSee(admin, me, row)) throw ApiError.of(404, "未找到该世界书");
        return Map.of("item", repo.decorateAndLike(row, me.id));
    }

    public Map<String, Object> preview(String id, AuthService.User me, boolean admin) {
        ensureReadAllowed(me);
        Map<String, Object> row = repo.rowForPayload(Validators.num(id, 0));
        Path abs = payloadOrFail(row, me, admin, "未找到该世界书");
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

    public Payload download(String id, AuthService.User me, boolean admin) {
        ensureReadAllowed(me);
        Map<String, Object> row = repo.rowForPayload(Validators.num(id, 0));
        Path abs = payloadOrFail(row, me, admin, "未找到该世界书");
        byte[] body;
        try {
            body = Files.readAllBytes(abs);
        } catch (IOException e) {
            throw ApiError.of(404, "文件已丢失");
        }
        long wid = Validators.num(id, 0);
        repo.incrementDownloads(wid);
        return new Payload(body, wid);
    }

    public Map<String, Object> delete(String id, AuthService.User me, boolean admin) {
        long wid = Validators.num(id, 0);
        Map<String, Object> row = repo.rowForDelete(wid);
        if (row == null) throw ApiError.of(404, "未找到该世界书");
        boolean isOwner = ((Number) row.get("author_id")).longValue() == me.id;
        if (!isOwner && !(Visibility.isAdminOnly(row) && admin)) throw ApiError.of(403, "只能删除自己上传的世界书");
        repo.delete(wid);
        if (!isOwner) repo.logAdminDelete(wid);   // 管理员删他人内容 → 留痕
        repo.purgeSocial(wid);
        Media.removePayload(cfg, "worldbook", Validators.str(row.get("filename")), null);
        return Map.of("ok", true);
    }

    // ---------------------------------------------------------------- 内部

    private Path payloadOrFail(Map<String, Object> row, AuthService.User me, boolean admin, String notFoundMsg) {
        if (row == null || Validators.str(row.get("filename")).isEmpty()) throw ApiError.of(404, notFoundMsg);
        if (Visibility.isAdminOnly(row) && !admin) throw ApiError.of(404, notFoundMsg);
        if (!Visibility.canSee(admin, me, row)) throw ApiError.of(404, notFoundMsg);
        Path root = cfg.uploadDir.normalize();
        Path abs = root.resolve("worldbook").resolve(Validators.str(row.get("filename"))).normalize();
        if (!abs.startsWith(root)) throw ApiError.of(400, "非法路径");
        if (!Files.isRegularFile(abs)) throw ApiError.of(404, "文件已丢失");
        return abs;
    }

    private void ensureReadAllowed(AuthService.User me) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
    }

    private void ensureUploadAllowed(AuthService.User me) {
        if (!limiters.upload.allow("u" + me.id)) throw ApiError.of(429, "上传过于频繁，请稍后再试");
    }

    private void ensureMetaAllowed(AuthService.User me) {
        if (!limiters.meta.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
    }
}
