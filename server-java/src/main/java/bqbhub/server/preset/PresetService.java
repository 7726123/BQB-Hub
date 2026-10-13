package bqbhub.server.preset;

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
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 预设（逐条对应 server/src/routes/preset.js）：列表 / 上传 / 详情 / 删除 / 下载。
 * 与世界书同构，差别：没有 meta/search_text/admin_only，检索只在 title/description 上做 LIKE；
 * 排序口径（new / hot / active）与计数装饰在 {@link PresetRepository}。
 *
 * 业务规则都在这里：审核门（非管理员上传 → pending）、封面整串校验、文件落盘位置、
 * 删除顺序（先删库 → 清点赞评论 → 删载荷）。HTTP 在 PresetController。
 */
@Service
public class PresetService {

    private static final Pattern CATEGORY = Pattern.compile("^[\\u4e00-\\u9fa5A-Za-z0-9 _-]{1,12}$");

    /** 下载响应需要的东西（Controller 负责拼 ResponseEntity 的头） */
    public record Payload(byte[] bytes, long id) {
    }

    private final PresetRepository repo;
    private final AppConfig cfg;
    private final Limiters limiters;

    public PresetService(PresetRepository repo, AppConfig cfg, Limiters limiters) {
        this.repo = repo;
        this.cfg = cfg;
        this.limiters = limiters;
    }

    public Map<String, Object> list(String category, String q, String sort, String page, String pageSize, long meId) {
        if (!limiters.read.allow("u" + meId)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        String cat = Validators.trim(Validators.str(category));
        String query = Validators.cut(Validators.trim(Validators.str(q)), 60);
        String sortKey = Validators.str(sort).isEmpty() ? "new" : Validators.str(sort);
        int pageNum = Math.max(1, Validators.num(page, 1));
        int size = Validators.num(pageSize, 20);
        if (size < 1) size = 20;
        if (size > 50) size = 50;
        int offset = (pageNum - 1) * size;

        PresetRepository.Page p = repo.list(cat, query, sortKey, size, offset, meId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("items", p.items());
        out.put("total", p.total());
        out.put("page", pageNum);
        out.put("pageSize", size);
        out.put("sort", sortKey);
        return out;
    }

    public Map<String, Object> upload(Map<String, Object> body, AuthService.User me, boolean admin) {
        if (!limiters.upload.allow("u" + me.id)) throw ApiError.of(429, "上传过于频繁，请稍后再试");
        String title = Validators.trim(Validators.str(body.get("title")));
        String description = Validators.cut(Validators.trim(Validators.str(body.get("description"))), 500);
        String category = Validators.trim(Validators.str(body.get("category")));
        if (category.isEmpty()) category = "综合";
        String content = Validators.str(body.get("content"));
        String cover = Validators.str(body.get("cover"));
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
        String status = admin ? "approved" : "pending";
        // 先插入拿 id（filename 留空）→ 写文件 → 回填 filename：与 Node 版同序，写文件失败会留下 filename='' 的行
        long id = repo.insert(title, description, category, me.id, me.username,
                content.getBytes(StandardCharsets.UTF_8).length, now, cover, status);
        String filename = "ps_" + id + ".json";
        try {
            Path dir = cfg.uploadDir.resolve("preset");
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(filename), content, StandardCharsets.UTF_8);
        } catch (IOException e) {
            throw ApiError.of(500, "写入文件失败");
        }
        repo.setFilename(id, filename);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        out.put("status", status);
        return out;
    }

    public Map<String, Object> detail(String id, AuthService.User me, boolean admin) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        Map<String, Object> row = repo.rowForDetail(Validators.num(id, 0));
        if (row == null) throw ApiError.of(404, "未找到该预设");
        if (!Visibility.canSee(admin, me, row)) throw ApiError.of(404, "未找到该预设");
        return Map.of("item", repo.decorate(row, me.id));
    }

    public Map<String, Object> delete(String id, AuthService.User me) {
        long pid = Validators.num(id, 0);
        Map<String, Object> row = repo.rowForDelete(pid);
        if (row == null) throw ApiError.of(404, "未找到该预设");
        if (((Number) row.get("author_id")).longValue() != me.id) throw ApiError.of(403, "只能删除自己上传的预设");
        repo.delete(pid);
        repo.purgeSocial(pid);
        Media.removePayload(cfg, "preset", Validators.str(row.get("filename")), null);
        return Map.of("ok", true);
    }

    public Payload download(String id, AuthService.User me, boolean admin) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        long pid = Validators.num(id, 0);
        Map<String, Object> row = repo.rowForDownload(pid);
        if (row == null || Validators.str(row.get("filename")).isEmpty()) throw ApiError.of(404, "未找到该预设");
        if (!Visibility.canSee(admin, me, row)) throw ApiError.of(404, "未找到该预设");
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
        repo.incrementDownloads(pid);
        return new Payload(body, pid);
    }
}
