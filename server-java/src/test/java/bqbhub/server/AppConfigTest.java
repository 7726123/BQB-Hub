package bqbhub.server;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * 配置中心：环境变量 + config.json（文件值优先）。
 * 优先级与 Node 版一致是**契约**（线上靠 config.json 下发 systemKey/adminKey/SMTP），
 * 这里把它钉住；同时验证入参 map 的测试通道与 System.getenv 行为一致。
 */
class AppConfigTest {

    @TempDir
    Path tmp;

    @Test
    void 默认值与环境变量() {
        AppConfig c = new AppConfig(Map.of(
                "PORT", "9999",
                "TLS_PORT", "18443",
                "UPLOAD_DIR", tmp.resolve("up").toString(),
                "DATA_DIR", tmp.resolve("data").toString(),
                "CONFIG_FILE", tmp.resolve("nope.json").toString()));
        assertEquals(9999, c.port);
        assertEquals(18443, c.tlsPort);
        assertEquals(tmp.resolve("up"), c.uploadDir);
        assertEquals(tmp.resolve("data"), c.dataDir);
        assertEquals("", c.adminKey);
        assertEquals("", c.adminPasswordHash);
        assertEquals("", c.systemKey);
        assertTrue(c.systemInstallIds.isEmpty());
        assertFalse(c.regionBlock);
        assertFalse(c.smtp.configured());
        assertEquals(AppConfig.APP_NAME, "novel-writer-community");
    }

    @Test
    void 非法端口回落默认值() {
        AppConfig c = new AppConfig(Map.of("PORT", "abc", "TLS_PORT", "  ", "CONFIG_FILE", tmp.resolve("nope.json").toString()));
        assertEquals(8899, c.port);
        assertEquals(80, c.tlsPort);
    }

    @Test
    void 配置文件覆盖环境变量() throws Exception {
        Path file = tmp.resolve("config.json");
        Files.writeString(file, """
                {
                  "regionBlock": true,
                  "adminKey": "from-file",
                  "systemKey": "sys-from-file",
                  "systemInstallIds": ["dev-1", "dev-2", " "],
                  "smtp": { "host": "smtp.example.com", "port": 2525, "secure": false, "user": "u", "pass": "p", "from": "f@example.com" }
                }
                """, StandardCharsets.UTF_8);

        AppConfig c = new AppConfig(Map.of(
                "ADMIN_KEY", "from-env",
                "SYSTEM_KEY", "sys-from-env",
                "CONFIG_FILE", file.toString()));
        assertEquals("from-file", c.adminKey);
        assertEquals("sys-from-file", c.systemKey);
        assertEquals(List.of("dev-1", "dev-2"), c.systemInstallIds);   // 空白项被丢掉
        assertTrue(c.regionBlock);
        assertTrue(c.smtp.configured());
        assertEquals("smtp.example.com", c.smtp.host);
        assertEquals(2525, c.smtp.port);
        assertFalse(c.smtp.secure);
        assertEquals("f@example.com", c.smtp.from);
    }

    @Test
    void 配置文件损坏时静默用环境变量() throws Exception {
        Path file = tmp.resolve("broken.json");
        Files.writeString(file, "{ not json", StandardCharsets.UTF_8);
        AppConfig c = new AppConfig(Map.of("ADMIN_KEY", "from-env", "CONFIG_FILE", file.toString()));
        assertEquals("from-env", c.adminKey);
        assertFalse(c.regionBlock);
    }
}
