package bqbhub.server;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * BQB Hub 社区服务端（Java 版）。
 *
 * 换栈原则（见 server/tests/CONTRACT.md 与交接文档 §13.161）：
 *   只换语言、不换数据库 —— SQLite 保留，117 条 SQL 逐条直译；
 *   环境变量、HTTP 接口、状态码、限流阈值、口令派生格式全部与 Node 版一致，
 *   于是 server/tests 的契约套件可以原样验收本实现。
 */
@SpringBootApplication
public class ServerApplication {
    public static void main(String[] args) {
        SpringApplication.run(ServerApplication.class, args);
    }
}
