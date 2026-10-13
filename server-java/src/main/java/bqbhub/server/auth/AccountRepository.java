package bqbhub.server.auth;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.Statement;
import java.util.List;
import java.util.Map;

/**
 * 账号与验证码的读写（SQL 逐字来自原 AuthController）。
 * 会话（sessions 表）不在这里：那是所有领域共用的原语，留在根包 AuthService。
 */
@Repository
public class AccountRepository {

    private final JdbcTemplate jdbc;

    public AccountRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- 验证码

    long countCodesSince(String email, long since) {
        return count("SELECT COUNT(*) FROM verify_codes WHERE email = ? AND created_at > ?", email, since);
    }

    void insertCode(String email, String code, String type, long expiresAt, long now) {
        jdbc.update("INSERT INTO verify_codes (email, code, type, expires_at, created_at, used) VALUES (?, ?, ?, ?, ?, 0)",
                email, code, type, expiresAt, now);
    }

    /** 顺带清理过期记录 */
    void purgeCodesOlderThan(long cutoff) {
        jdbc.update("DELETE FROM verify_codes WHERE expires_at < ?", cutoff);
    }

    Map<String, Object> findCode(String email, String code, String type, long now) {
        return firstRow("SELECT * FROM verify_codes WHERE email = ? AND code = ? AND type = ? AND used = 0 AND expires_at > ? "
                + "ORDER BY id DESC LIMIT 1", email, code, type, now);
    }

    void markCodeUsed(long id) {
        jdbc.update("UPDATE verify_codes SET used = 1 WHERE id = ?", id);
    }

    // ---------------------------------------------------------------- 用户

    boolean emailRegistered(String email) {
        return !jdbc.queryForList("SELECT id FROM users WHERE email = ?", email).isEmpty();
    }

    Map<String, Object> userByEmail(String email) {
        return firstRow("SELECT * FROM users WHERE email = ?", email);
    }

    long insertUser(String username, String passHash, String passSalt, long now, String email) {
        var keyHolder = new GeneratedKeyHolder();
        jdbc.update(con -> {
            var ps = con.prepareStatement(
                    "INSERT INTO users (username, pass_hash, pass_salt, created_at, email) VALUES (?, ?, ?, ?, ?)",
                    Statement.RETURN_GENERATED_KEYS);
            ps.setObject(1, username);
            ps.setObject(2, passHash);
            ps.setObject(3, passSalt);
            ps.setObject(4, now);
            ps.setObject(5, email);
            return ps;
        }, keyHolder);
        Number key = keyHolder.getKey();
        return key == null ? 0 : key.longValue();
    }

    void updatePassword(long userId, String passHash, String passSalt) {
        jdbc.update("UPDATE users SET pass_hash = ?, pass_salt = ? WHERE id = ?", passHash, passSalt, userId);
    }

    void updateUsername(long userId, String nickname) {
        jdbc.update("UPDATE users SET username = ? WHERE id = ?", nickname, userId);
    }

    private Map<String, Object> firstRow(String sql, Object... args) {
        List<Map<String, Object>> rows = jdbc.queryForList(sql, args);
        return rows.isEmpty() ? null : rows.get(0);
    }

    private long count(String sql, Object... args) {
        Long v = jdbc.queryForObject(sql, Long.class, args);
        return v == null ? 0 : v;
    }
}
