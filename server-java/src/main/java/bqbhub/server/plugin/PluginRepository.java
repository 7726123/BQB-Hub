package bqbhub.server.plugin;

import bqbhub.server.Validators;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.Statement;
import java.util.List;
import java.util.Map;

/** 插件表的读写（SQL 逐字来自原 PluginController）；清单解析/校验与文件落盘在 {@link PluginService}。 */
@Repository
public class PluginRepository {

    static final String LIST_COLS = "id, plugin_id, title, description, plugin_type, plugin_version, author_id, author_name, downloads, created_at";

    private final JdbcTemplate jdbc;

    public PluginRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    List<Map<String, Object>> listApproved() {
        return jdbc.queryForList("SELECT " + LIST_COLS
                + " FROM plugins WHERE status = 'approved' ORDER BY created_at DESC LIMIT 200");
    }

    boolean pluginIdExists(String pluginId) {
        return !jdbc.queryForList("SELECT id FROM plugins WHERE plugin_id = ?", pluginId).isEmpty();
    }

    Map<String, Object> rowForDownload(String pluginId) {
        return firstRow("SELECT id, plugin_id, filename, author_id, status FROM plugins WHERE plugin_id = ?", Validators.str(pluginId));
    }

    Map<String, Object> rowForDelete(String pluginId) {
        return firstRow("SELECT id, author_id, filename FROM plugins WHERE plugin_id = ?", pluginId);
    }

    long insert(String pluginId, String title, String description, String type, String version,
                long authorId, String authorName, int isZip, long size, long now, String status) {
        var keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(
                    "INSERT INTO plugins (plugin_id, title, description, plugin_type, plugin_version, author_id, author_name, filename, is_zip, size, downloads, created_at, status) "
                            + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setObject(1, pluginId);
            ps.setObject(2, title);
            ps.setObject(3, description);
            ps.setObject(4, type);
            ps.setObject(5, version);
            ps.setObject(6, authorId);
            ps.setObject(7, authorName);
            ps.setObject(8, "");
            ps.setObject(9, isZip);
            ps.setObject(10, size);
            ps.setObject(11, now);
            ps.setObject(12, status);
            return ps;
        }, keyHolder);
        Number key = keyHolder.getKey();
        return key == null ? 0 : key.longValue();
    }

    void setFilename(long id, String filename) {
        jdbc.update("UPDATE plugins SET filename = ? WHERE id = ?", filename, id);
    }

    void incrementDownloads(long id) {
        jdbc.update("UPDATE plugins SET downloads = downloads + 1 WHERE id = ?", id);
    }

    void delete(String pluginId) {
        jdbc.update("DELETE FROM plugins WHERE plugin_id = ?", pluginId);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }
}
