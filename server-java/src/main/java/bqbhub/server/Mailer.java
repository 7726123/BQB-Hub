package bqbhub.server;

import jakarta.mail.Authenticator;
import jakarta.mail.Message;
import jakarta.mail.PasswordAuthentication;
import jakarta.mail.Session;
import jakarta.mail.Transport;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import org.springframework.stereotype.Component;

import java.util.Properties;

/**
 * 发信（对应 server/src/mailer.js）：配置来自 config.json 的 smtp 段。
 * 未配置时抛 {@link NotConfigured}，路由据此回 500 + 与 Node 版同样的文案。
 * 超时都设了 8 秒：不配 SMTP 的部署（本地/测试）不应该被发信卡住请求。
 */
@Component
public class Mailer {

    /** 对应 mailer.js 的 SMTP_NOT_CONFIGURED */
    public static class NotConfigured extends RuntimeException {
        public NotConfigured() {
            super("SMTP_NOT_CONFIGURED");
        }
    }

    private final AppConfig cfg;

    public Mailer(AppConfig cfg) {
        this.cfg = cfg;
    }

    public void send(String to, String subject, String text) {
        if (!cfg.smtp.configured()) throw new NotConfigured();
        try {
            Properties p = new Properties();
            p.put("mail.smtp.host", cfg.smtp.host);
            p.put("mail.smtp.port", String.valueOf(cfg.smtp.port));
            p.put("mail.smtp.connectiontimeout", "8000");
            p.put("mail.smtp.timeout", "8000");
            p.put("mail.smtp.writetimeout", "8000");
            boolean auth = cfg.smtp.user != null && !cfg.smtp.user.isEmpty();
            p.put("mail.smtp.auth", String.valueOf(auth));
            if (cfg.smtp.secure) {
                p.put("mail.smtp.ssl.enable", "true");   // 465：隐式 TLS（nodemailer 的 secure:true 同款）
            } else {
                p.put("mail.smtp.starttls.enable", "true");
            }
            Session session = Session.getInstance(p, auth ? new Authenticator() {
                @Override
                protected PasswordAuthentication getPasswordAuthentication() {
                    return new PasswordAuthentication(cfg.smtp.user, cfg.smtp.pass);
                }
            } : null);
            MimeMessage msg = new MimeMessage(session);
            String from = (cfg.smtp.from != null && !cfg.smtp.from.isEmpty()) ? cfg.smtp.from : cfg.smtp.user;
            msg.setFrom(new InternetAddress(from));
            msg.setRecipients(Message.RecipientType.TO, InternetAddress.parse(to));
            msg.setSubject(subject, "UTF-8");
            msg.setText(text, "UTF-8");
            Transport.send(msg);
        } catch (Exception e) {
            throw new RuntimeException("邮件发送失败: " + e.getMessage(), e);
        }
    }
}
