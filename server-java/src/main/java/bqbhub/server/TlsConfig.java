package bqbhub.server;

import org.apache.catalina.connector.Connector;
import org.apache.tomcat.util.net.SSLHostConfig;
import org.apache.tomcat.util.net.SSLHostConfigCertificate;
import org.bouncycastle.jce.provider.BouncyCastleProvider;
import org.bouncycastle.openssl.PEMKeyPair;
import org.bouncycastle.openssl.PEMParser;
import org.bouncycastle.openssl.jcajce.JcaPEMKeyConverter;
import org.bouncycastle.asn1.pkcs.PrivateKeyInfo;
import org.springframework.boot.web.embedded.tomcat.TomcatServletWebServerFactory;
import org.springframework.boot.web.server.WebServerFactoryCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.SecureRandom;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;

/**
 * HTTPS 第二端口（逐条对应 server/src/tls.js）：
 * 自签证书直接由本进程终端 TLS（不引 nginx，保持单进程/单服务单元），与 HTTP 端口**并存**；
 * App 内置同一张自签 CA 作信任锚，所以不需要公共 CA/域名。
 *
 * 与 Node 版对齐的四个行为（契约测试 tests/tls.test.js 钉住）：
 *   1. 证书不可读 → **只跑 HTTP，绝不让启动失败**（本地/测试环境没有证书也能起来）；
 *   2. 最低 TLSv1.2（挡掉 SSLv3/TLS1.0/1.1），与 Node 的 minVersion: 'TLSv1.2' 同款；
 *   3. 两个端口共用同一个应用（请求走同一套路由与会话）；
 *   4. HTTPS 请求下 /api/app/version 返回的 apkUrl 是 https（App 走 TLS 端口下载 APK），HTTP 下仍是 http。
 *
 * 实现差异：Tomcat 只能从 keystore 文件读取证书，所以启动时把 PEM（cert + key + 可选链）
 * 转成 PKCS12 临时文件（600 权限，进程退出即删）；私钥解析用 Bouncy Castle 的 PEMParser，
 * PKCS#8（BEGIN PRIVATE KEY）与 PKCS#1（BEGIN RSA PRIVATE KEY）两种都认。
 */
@Configuration
public class TlsConfig {

    @Bean
    public WebServerFactoryCustomizer<TomcatServletWebServerFactory> tlsConnectorCustomizer(AppConfig cfg) {
        return factory -> {
            try {
                if (!Files.isReadable(cfg.tlsCertFile) || !Files.isReadable(cfg.tlsKeyFile)) {
                    System.out.println("[HTTPS] 未启用（证书不可读）: " + cfg.tlsKeyFile + " / " + cfg.tlsCertFile);
                    return;
                }
                PrivateKey key = readPrivateKey(cfg.tlsKeyFile);
                List<X509Certificate> chain = readCertChain(cfg.tlsCertFile);
                if (key == null || chain.isEmpty()) {
                    System.out.println("[HTTPS] 未启用（证书不可读）: 未能从 PEM 中解析出私钥或证书");
                    return;
                }

                char[] password = randomPassword();
                Path keystoreFile = Files.createTempFile("bqbhub-tls-", ".p12");
                KeyStore ks = KeyStore.getInstance("PKCS12");
                ks.load(null, null);
                ks.setKeyEntry("server", key, password, chain.toArray(new Certificate[0]));
                try (OutputStream out = Files.newOutputStream(keystoreFile)) {
                    ks.store(out, password);
                }
                keystoreFile.toFile().deleteOnExit();

                Connector connector = new Connector(TomcatServletWebServerFactory.DEFAULT_PROTOCOL);
                connector.setPort(cfg.tlsPort);
                connector.setSecure(true);
                connector.setScheme("https");
                connector.setProperty("SSLEnabled", "true");

                SSLHostConfig host = new SSLHostConfig();
                // 对应 Node 的 minVersion: 'TLSv1.2'：显式关掉 1.0/1.1、只留 1.2/1.3。
                // 必须带 +/- 前缀：不带前缀的条目会被 Tomcat 当成「往默认列表里再加一个」并打 WARN
                // （第一版写 "TLSv1.2,TLSv1.3" 就吃了这条告警）。
                host.setProtocols("-TLSv1.0,-TLSv1.1,+TLSv1.2,+TLSv1.3");
                host.setHonorCipherOrder(true);         // 对应 Node 的 honorCipherOrder: true
                SSLHostConfigCertificate cert = new SSLHostConfigCertificate(host, SSLHostConfigCertificate.Type.UNDEFINED);
                cert.setCertificateKeystoreFile(keystoreFile.toString());
                cert.setCertificateKeystorePassword(new String(password));
                cert.setCertificateKeystoreType("PKCS12");
                host.addCertificate(cert);
                connector.addSslHostConfig(host);

                factory.addAdditionalTomcatConnectors(connector);
                System.out.println("[HTTPS] 已启用：端口 " + cfg.tlsPort + "（证书 " + cfg.tlsCertFile + "）");
            } catch (Exception e) {
                // 与 Node 版同款兜底：TLS 起不来只降级成 HTTP，不影响进程启动
                System.out.println("[HTTPS] 未启用（证书不可读）: " + e.getClass().getSimpleName() + " " + e.getMessage());
            }
        };
    }

    /** 私钥：PKCS#8（BEGIN PRIVATE KEY）与 PKCS#1（BEGIN RSA PRIVATE KEY）都支持；加密私钥不支持（配置里没有口令位） */
    static PrivateKey readPrivateKey(Path keyFile) throws Exception {
        byte[] bytes = Files.readAllBytes(keyFile);
        JcaPEMKeyConverter converter = new JcaPEMKeyConverter().setProvider(new BouncyCastleProvider());
        try (PEMParser parser = new PEMParser(new InputStreamReader(new ByteArrayInputStream(bytes), StandardCharsets.UTF_8))) {
            Object obj;
            while ((obj = parser.readObject()) != null) {
                if (obj instanceof PEMKeyPair kp) {
                    return converter.getKeyPair(kp).getPrivate();
                }
                if (obj instanceof PrivateKeyInfo pki) {
                    return converter.getPrivateKey(pki);
                }
            }
        }
        return null;
    }

    /** 证书链：按文件里的顺序（叶子在前）取出全部 CERTIFICATE 块 */
    static List<X509Certificate> readCertChain(Path certFile) throws Exception {
        List<X509Certificate> out = new ArrayList<>();
        CertificateFactory cf = CertificateFactory.getInstance("X.509");
        try (var in = Files.newInputStream(certFile)) {
            for (Certificate c : cf.generateCertificates(in)) {
                if (c instanceof X509Certificate x) out.add(x);
            }
        }
        return out;
    }

    private static char[] randomPassword() {
        byte[] b = new byte[18];
        new SecureRandom().nextBytes(b);
        return java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(b).toCharArray();
    }
}
