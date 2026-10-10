package bqbhub.server;

import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 内存限流器注册表：阈值逐条对应 Node 版（app.js / routes/auth.js / routes/system.js /
 * routes/feedback.js / limits.js / proxy.js）。**阈值本身属于接口契约**（CONTRACT.md 第三节），
 * 改这里就等于改契约，改前先跑 server/tests。
 */
@Component
public class Limiters {

    // app.js：认证接口整体按 IP（120/分钟，兜住 /me 轮询）
    public final RateLimiter authIp = new RateLimiter(60_000, 120);

    // routes/auth.js
    public final RateLimiter login = new RateLimiter(10 * 60_000L, 10);       // IP+账号 10 次/10 分钟
    public final RateLimiter codeGuess = new RateLimiter(10 * 60_000L, 10);   // 同一邮箱/用途 10 次/10 分钟
    public final RateLimiter sendCode = new RateLimiter(60 * 60_000L, 10);    // 同一 IP 10 次/小时
    public final RateLimiter register = new RateLimiter(60 * 60_000L, 5);     // 同一 IP 5 次/小时

    // routes/system.js
    public final RateLimiter adminVerify = new RateLimiter(60_000, 8);        // 管理员口令 8 次/分钟/IP
    public final RateLimiter ping = new RateLimiter(60 * 60_000L, 240);       // 启动/心跳上报
    public final RateLimiter miss = new RateLimiter(60 * 60_000L, 30);        // 使用助手漏答
    public final RateLimiter clientLogs = new RateLimiter(60 * 60_000L, 20);  // 客户端错误上报
    public final RateLimiter trace = new RateLimiter(60_000, 60);             // 管理员留档写入

    // routes/feedback.js
    public final RateLimiter fbDevice = new RateLimiter(60_000, 2);           // 用户可见：2 条/分钟/设备
    public final RateLimiter fbIp = new RateLimiter(60 * 60_000L, 20);        // 兜底：20 条/小时/IP
    public final RateLimiter fbAdmin = new RateLimiter(60_000, 120);          // 管理端 120 次/分钟/IP

    // limits.js（按账号键控；review 按 IP）
    public final RateLimiter read = new RateLimiter(60_000, 120);             // 列表/检索/详情/下载
    public final RateLimiter upload = new RateLimiter(60 * 60_000L, 30);      // 上传 30 次/小时/账号
    public final RateLimiter meta = new RateLimiter(60 * 60_000L, 120);       // 元数据补写
    public final RateLimiter review = new RateLimiter(60_000, 120);           // 审核队列/管理端

    // routes/proxy.js
    public final RateLimiter proxy = new RateLimiter(60_000, 60);

    public List<RateLimiter> all() {
        return List.of(authIp, login, codeGuess, sendCode, register, adminVerify, ping, miss,
                clientLogs, trace, fbDevice, fbIp, fbAdmin, read, upload, meta, review, proxy);
    }

    public void sweepAll() {
        all().forEach(RateLimiter::sweep);
    }
}
