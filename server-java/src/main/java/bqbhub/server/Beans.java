package bqbhub.server;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;

/**
 * 数据源与 JdbcTemplate 的装配：都指向 {@link Db} 里自建的那个（路径来自环境变量 DATA_DIR）。
 * 这样一来 Boot 的 DataSource 自动配置会因为「已有 Bean」而退让，不用在 YAML 里重复配库。
 */
@Configuration
public class Beans {

    @Bean
    public DataSource dataSource(Db db) {
        return db.dataSource();
    }

    @Bean
    public JdbcTemplate jdbcTemplate(Db db) {
        return db.jdbc;
    }
}
