package bqbhub.server.plugin;

import bqbhub.server.ApiError;
import bqbhub.server.AppConfig;
import bqbhub.server.AuthService;
import bqbhub.server.Limiters;
import bqbhub.server.Media;
import bqbhub.server.Validators;
import bqbhub.server.support.Visibility;
import com.fasterxml.jackson.databind.JsonNode;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 社区插件（逐条对应 server/src/routes/plugin.js）：列表 / 上传 / 下载 / 删除。
 * 服务器只校验结构、不执行任何内容；上传一律进审核门（管理员自己上传直接公开）。
 * 清单解析与校验在 {@link PluginManifest}，SQL 在 {@link PluginRepository}，HTTP 在 {@link PluginController}。
 */
@Service
public class PluginService {

    private final PluginRepository repo;
    private final AppConfig cfg;
    private final Limiters limiters;

    public PluginService(PluginRepository repo, AppConfig cfg, Limiters limiters) {
        this.repo = repo;
        this.cfg = cfg;
        this.limiters = limiters;
    }

    public Map<String, Object> list(AuthService.User me) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        return Map.of("items", repo.listApproved());
    }

    public Map<String, Object> upload(Map<String, Object> body, AuthService.User me, boolean admin) {
        if (!limiters.upload.allow("u" + me.id)) throw ApiError.of(429, "上传过于频繁，请稍后再试");
        boolean isZip = PluginManifest.truthy(body.get("isZip"));
        byte[] zipBytes = null;
        JsonNode manifest;

        if (isZip) {
            String raw = Validators.str(body.get("content"));
            if (!raw.matches("(?s)^data:application/zip;base64,.+$")) throw ApiError.of(400, "zip 内容格式不正确");
            String b64 = raw.substring(raw.indexOf(',') + 1);
            try {
                zipBytes = Base64.getDecoder().decode(b64);
            } catch (Exception e) {
                throw ApiError.of(400, "zip 内容格式不正确");
            }
            if (zipBytes.length > 10 * 1024 * 1024) throw ApiError.of(400, "zip 需小于 10MB");
            manifest = PluginManifest.readFromZip(zipBytes);
            if (manifest == null) throw ApiError.of(400, "zip 内缺少 plugin.json（或服务器缺少 unzip）");
        } else {
            manifest = PluginManifest.parse(Validators.str(body.get("content")));
            if (manifest == null) throw ApiError.of(400, "文件内容不是有效的 JSON");
        }

        String verr = PluginManifest.validate(manifest);
        if (verr != null) throw ApiError.of(400, verr);
        String pluginId = manifest.path("id").asText("");
        if (repo.pluginIdExists(pluginId)) {
            throw ApiError.of(400, "插件 id=" + pluginId + " 已存在，请修改 manifest 的 id 或联系作者更新");
        }
        long now = System.currentTimeMillis();
        Path pdir = cfg.uploadDir.resolve("plugin");
        long size = isZip ? zipBytes.length : Validators.str(body.get("content")).getBytes(StandardCharsets.UTF_8).length;
        String status = admin ? "approved" : "pending";
        long id = repo.insert(pluginId, manifest.path("name").asText(""),
                Validators.cut(manifest.path("description").asText(""), 500),
                manifest.path("type").asText(""), manifest.path("version").asText(""),
                me.id, me.username, isZip ? 1 : 0, size, now, status);
        String mfile = pluginId + ".json";
        try {
            Files.createDirectories(pdir);
            Files.writeString(pdir.resolve(mfile), PluginManifest.pretty(manifest), StandardCharsets.UTF_8);
            if (isZip) {
                Path zdir = pdir.resolve("files");
                Files.createDirectories(zdir);
                Files.write(zdir.resolve(pluginId + ".zip"), zipBytes);
            }
        } catch (IOException e) {
            throw ApiError.of(500, "写入文件失败");
        }
        repo.setFilename(id, mfile);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("id", id);
        out.put("plugin_id", pluginId);
        out.put("status", status);
        return out;
    }

    public Map<String, Object> download(String pluginId, AuthService.User me, boolean admin) {
        if (!limiters.read.allow("u" + me.id)) throw ApiError.of(429, "请求过于频繁，请稍后再试");
        Map<String, Object> row = repo.rowForDownload(pluginId);
        if (row == null || Validators.str(row.get("filename")).isEmpty()) throw ApiError.of(404, "未找到该插件");
        if (!Visibility.canSee(admin, me, row)) throw ApiError.of(404, "未找到该插件");
        // 注意根是 uploadDir/plugin（与 Node 版一致，不是 uploadDir）
        Path pdir = cfg.uploadDir.normalize().resolve("plugin");
        Path abs = pdir.resolve(Validators.str(row.get("filename"))).normalize();
        if (!abs.startsWith(pdir)) throw ApiError.of(400, "非法路径");
        if (!Files.isRegularFile(abs)) throw ApiError.of(404, "文件已丢失");
        repo.incrementDownloads(((Number) row.get("id")).longValue());
        JsonNode manifest;
        try {
            manifest = PluginManifest.parse(Files.readString(abs, StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw ApiError.of(500, "清单损坏");
        }
        if (manifest == null) throw ApiError.of(500, "清单损坏");
        return Map.of("manifest", PluginManifest.asMap(manifest));
    }

    public Map<String, Object> delete(String id, AuthService.User me) {
        String pluginId = Validators.str(id);
        Map<String, Object> row = repo.rowForDelete(pluginId);
        if (row == null) throw ApiError.of(404, "未找到该插件");
        if (((Number) row.get("author_id")).longValue() != me.id) throw ApiError.of(403, "只能删除自己上传的插件");
        repo.delete(pluginId);
        Media.removePayload(cfg, "plugin", Validators.str(row.get("filename")), pluginId);
        return Map.of("ok", true);
    }
}
