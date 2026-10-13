package bqbhub.server;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * 单测用的临时 SQLite 工具。
 * 不启动 Spring 上下文：AppConfig 读的是**进程环境**（JUnit 里改不了），而被测类只需要一个 JdbcTemplate。
 * JDBC URL 与生产 {@link Db} 完全一致（WAL + busy_timeout + IMMEDIATE），库文件放在 @TempDir 下。
 */
public final class TestDb {

    private TestDb() {
    }

    public static DataSource dataSource(Path dbFile) {
        DriverManagerDataSource ds = new DriverManagerDataSource();
        ds.setDriverClassName("org.sqlite.JDBC");
        ds.setUrl("jdbc:sqlite:" + dbFile.toAbsolutePath()
                + "?journal_mode=WAL&busy_timeout=5000&synchronous=NORMAL&transaction_mode=IMMEDIATE");
        return ds;
    }

    public static JdbcTemplate open(Path dbFile) {
        return new JdbcTemplate(dataSource(dbFile));
    }

    /** 表存在时返回列名集合；表不存在返回空集（PRAGMA table_info 不报错） */
    public static Set<String> columns(JdbcTemplate j, String table) {
        Set<String> out = new HashSet<>();
        for (Map<String, Object> row : j.queryForList("PRAGMA table_info(" + table + ")")) {
            Object name = row.get("name");
            if (name != null) out.add(String.valueOf(name));
        }
        return out;
    }
}
