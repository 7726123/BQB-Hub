package bqbhub.server;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

import java.nio.file.Files;

/**
 * 数据层：SQLite（xerial sqlite-jdbc + Hikari）；建表与结构迁移在 {@link SchemaMigrations}。
 * 逐条对应 server/src/db.js —— 表名/列名/默认值/迁移顺序保持一致，
 * 因为契约测试的夹具会**直读同一个库文件**（见 server/tests/CONTRACT.md 第二节）。
 *
 * 并发口径（交接文档 §13.161 的「真坑 ①」）：
 *   Node 版是单连接同步、天然串行，从没见过 SQLITE_BUSY；Java 多线程 + 连接池会撞写锁。
 *   这里的做法：WAL + busy_timeout=5000 + transaction_mode=IMMEDIATE（URL 参数交给驱动），
 *   连接池默认 4（可用 DB_POOL_SIZE 调；单写者场景设 1 即复刻 Node 语义）。
 *   多语句写事务（反馈插入+裁剪）走同一连接，见 FeedbackController 的 TransactionTemplate。
 */
@Component
public class Db {

    public final JdbcTemplate jdbc;
    private final HikariDataSource ds;

    public Db(AppConfig cfg) throws Exception {
        Files.createDirectories(cfg.dataDir);
        Files.createDirectories(cfg.uploadDir);
        Files.createDirectories(cfg.apkDir);
        Files.createDirectories(cfg.webBundleDir);

        HikariConfig hc = new HikariConfig();
        hc.setJdbcUrl("jdbc:sqlite:" + cfg.dataDir.resolve("chat.db").toString()
                + "?journal_mode=WAL&busy_timeout=5000&synchronous=NORMAL&transaction_mode=IMMEDIATE");
        hc.setPoolName("sqlite");
        hc.setMaximumPoolSize(intEnv("DB_POOL_SIZE", 4));
        hc.setAutoCommit(true);
        this.ds = new HikariDataSource(hc);
        this.jdbc = new JdbcTemplate(ds);
        new SchemaMigrations(this.jdbc).run();
    }

    private static int intEnv(String k, int dflt) {
        try {
            String v = System.getenv(k);
            return (v == null || v.isEmpty()) ? dflt : Integer.parseInt(v.trim());
        } catch (NumberFormatException e) {
            return dflt;
        }
    }

    /** 关池（测试/优雅停机用） */
    public void close() {
        try { ds.close(); } catch (Exception e) { /* ignore */ }
    }

    /**
     * 暴露数据源：让 Spring 的自动配置（DataSource / JdbcTemplate / 事务管理器）看到我们自建的这一个，
     * 从而**不再**去读 spring.datasource.url（我们不用 YAML 配库，路径来自环境变量）。
     */
    public javax.sql.DataSource dataSource() {
        return ds;
    }
}
