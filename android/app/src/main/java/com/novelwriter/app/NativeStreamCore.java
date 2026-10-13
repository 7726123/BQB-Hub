package com.novelwriter.app;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URL;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * 原生流式取数核心（B 方案）：**不依赖任何 Android API**（只用 java.net / java.util / javax.net.ssl），
 * 所以本机 javac 就能编译、配一个本地 SSE 服务器就能端到端验"是不是真的边收边给"（见 tmp/diag 脚本）。
 *
 * 为什么手写 HTTP/1.1 而不是用 HttpURLConnection/OkHttp：那两个会把响应体**整段缓冲**（透明 gzip、
 * 连接池内务），实测 SSE 首字从秒级变到分钟级——LocalProxyServer 当年就是踩了这个坑才手写裸 TLS 的，
 * 这里沿用同一套手法：`HTTP/1.1` + `Connection: close` + `Accept-Encoding: identity`，chunked 自己解包，
 * 每收到一段就立刻交给 Sink（不攒）。
 *
 * 与 LocalProxyServer 的关系：那边是"本地 HTTP 代理"——WebView 直接请求它，它再逐块转发，还要替
 * 浏览器做 CORS 预检、把体重新打成 chunked；这边没有浏览器这一层，**解包后的字节直接交给调用方**
 * （插件再批量推给 JS）。所以这里复制了它的一小段头过滤 / 读行 / 解包逻辑，并且**刻意不引用它**
 * （一旦 import 到 android.* 就没法在本机编译实测了）。两处逻辑若将来要改，记得一起看。
 */
public final class NativeStreamCore {

    private static final int MAX_REDIRECTS = 3;
    private static final String DEFAULT_UA = "BQBHub-Android/1.0 (OpenAI-compatible client)";

    /** 解包后的数据去向：onHead → onData* → onDone / onError（onError 之后不再有任何回调）。 */
    public interface Sink {
        /** 响应头到手（**含非 2xx**：非 2xx 时调用方自己决定要不要体）。 */
        void onHead(int status, Map<String, String> headers);
        void onData(byte[] buf, int len) throws IOException;
        void onDone();
        void onError(String message);
    }

    /** 取消句柄：close 掉 socket 就够（读线程会以 IOException 退出，回调 onError("已取消")）。 */
    public static final class StreamHandle {
        private final AtomicBoolean cancelled = new AtomicBoolean(false);
        private volatile Socket sock;
        void attach(Socket s) { this.sock = s; }
        public boolean isCancelled() { return cancelled.get(); }
        public void cancel() {
            cancelled.set(true);
            Socket s = sock;
            if (s != null) { try { s.close(); } catch (IOException ignored) { /* 关不掉也没别的办法 */ } }
        }
    }

    // 跳过的请求头：hop-by-hop（逐跳语义，不能转发）+ 浏览器来源头（暴露来源可能触发 WAF）
    private static final java.util.Set<String> SKIP = new java.util.HashSet<>(java.util.Arrays.asList(
            "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization",
            "te", "trailer", "transfer-encoding", "upgrade",
            "content-length", "accept-encoding"));
    // 自己补的头
    private static final String[] MANAGED = { "user-agent", "accept", "cache-control" };

    private NativeStreamCore() { }

    /** URL 拆解结果（http/https 都支持：schema 决定用裸 socket 还是 TLS）。 */
    static final class Target {
        final String scheme, host, path;
        final int port;
        Target(String scheme, String host, int port, String path) {
            this.scheme = scheme; this.host = host; this.port = port; this.path = path;
        }
    }

    /** 解析 "https://host[:port]/path?q=1" / "http://…"；只认这两种 scheme，其它返回 null。 */
    static Target parseUrl(String raw) {
        String s = String.valueOf(raw == null ? "" : raw).trim();
        String scheme;
        if (s.regionMatches(true, 0, "https://", 0, 8)) scheme = "https";
        else if (s.regionMatches(true, 0, "http://", 0, 7)) scheme = "http";
        else return null;
        String rest = s.substring(scheme.length() + 3);
        int slash = rest.indexOf('/');
        String hostPort = slash >= 0 ? rest.substring(0, slash) : rest;
        String path = slash >= 0 ? rest.substring(slash) : "/";
        if (hostPort.isEmpty()) return null;
        int port = "https".equals(scheme) ? 443 : 80;
        int colon = hostPort.lastIndexOf(':');
        if (colon > 0 && colon < hostPort.length() - 1) {
            try {
                int p = Integer.parseInt(hostPort.substring(colon + 1));
                if (p > 0 && p < 65536) { port = p; hostPort = hostPort.substring(0, colon); }
            } catch (NumberFormatException ignored) { /* 非端口（IPv6 之类）→ 保持默认 */ }
        }
        if (hostPort.isEmpty()) return null;
        return new Target(scheme, hostPort, port, path);
    }

    /** 生成上游请求头：客户端头全量透传 − 跳过名单 + 补齐 UA/Accept/Content-Length（与代理同一套口径）。 */
    static LinkedHashMap<String, String> buildHeaders(Map<String, String> in, int bodyLength) {
        LinkedHashMap<String, String> out = new LinkedHashMap<>();
        if (in != null) {
            for (Map.Entry<String, String> e : in.entrySet()) {
                String k = e.getKey(), v = e.getValue();
                if (k == null || v == null || v.isEmpty()) continue;
                String n = k.toLowerCase(Locale.ROOT);
                if (SKIP.contains(n) || n.equals("origin") || n.equals("referer")
                        || n.startsWith("sec-fetch-") || n.startsWith("sec-ch-")) continue;
                out.put(k, v);
            }
        }
        for (String m : MANAGED) {
            boolean has = false;
            for (String k : out.keySet()) if (k.equalsIgnoreCase(m)) { has = true; break; }
            if (!has) {
                if (m.equals("user-agent")) out.put("User-Agent", DEFAULT_UA);
                else if (m.equals("accept")) out.put("Accept", "text/event-stream");
                else out.put("Cache-Control", "no-cache");
            }
        }
        out.put("Accept-Encoding", "identity");   // 别让上游压缩：解压要另写一套，而且 SSE 压缩会毁掉实时性
        out.put("Content-Length", String.valueOf(Math.max(0, bodyLength)));
        return out;
    }

    /**
     * 发一次流式请求：内部起一条线程，头到手 → onHead，之后每解包出一段就 onData，结束 onDone。
     * 失败（连不上 / TLS / 头超时 / 读中断）→ onError（**取消**也走 onError，文案"已取消"）。
     * 同步返回取消句柄（调用方随时可关）。
     */
    public static StreamHandle start(final String rawUrl, final Map<String, String> headers, final byte[] body,
                                     final int connectTimeoutMs, final int headTimeoutMs, final Sink sink) {
        final StreamHandle handle = new StreamHandle();
        Thread t = new Thread(new Runnable() {
            @Override public void run() { runOnce(rawUrl, headers, body, connectTimeoutMs, headTimeoutMs, handle, sink); }
        }, "NativeStream");
        t.setDaemon(true);
        t.start();
        return handle;
    }

    private static void runOnce(String rawUrl, Map<String, String> headers, byte[] body,
                                int connectTimeoutMs, int headTimeoutMs, StreamHandle handle, Sink sink) {
        Target t0 = parseUrl(rawUrl);
        if (t0 == null) { sink.onError("URL 不合法（只支持 http/https）：" + rawUrl); return; }
        String curHost = t0.host, curPath = t0.path;
        int curPort = t0.port;
        boolean https = "https".equals(t0.scheme);
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            Socket sk = null;
            try {
                sk = https ? openTls(curHost, curPort, connectTimeoutMs) : openPlain(curHost, curPort, connectTimeoutMs);
                handle.attach(sk);
                if (handle.isCancelled()) throw new IOException("已取消");

                // —— 发请求（HTTP/1.1 + Connection: close；TLS 时 SNI 由 JDK 依 host 自动带上）——
                OutputStream os = sk.getOutputStream();
                StringBuilder req = new StringBuilder();
                req.append("POST ").append(curPath).append(" HTTP/1.1\r\n");
                req.append("Host: ").append(curHost).append("\r\n");
                req.append("Connection: close\r\n");
                LinkedHashMap<String, String> fwd = buildHeaders(headers, body == null ? 0 : body.length);
                for (Map.Entry<String, String> e : fwd.entrySet()) {
                    req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
                }
                req.append("\r\n");
                os.write(req.toString().getBytes("UTF-8"));
                if (body != null && body.length > 0) os.write(body);
                os.flush();

                InputStream is = sk.getInputStream();
                sk.setSoTimeout(headTimeoutMs);          // 头阶段超时（连上到状态行）
                byte[] statusLineBytes = readLine(is);
                if (statusLineBytes == null) throw new IOException("上游没有回任何响应");
                String statusLine = new String(statusLineBytes, "UTF-8");
                int status = parseStatusCode(statusLine);
                Map<String, String> up = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
                byte[] hb;
                while ((hb = readLine(is)) != null && hb.length > 0) {
                    String hl = new String(hb, "UTF-8");
                    int c = hl.indexOf(':');
                    if (c > 0) up.put(hl.substring(0, c).trim(), hl.substring(c + 1).trim());
                }

                // 3xx：同 scheme 跟随最多 3 跳（跨 host 重建连接；method/body 原样重发）
                if (status >= 300 && status < 400 && hop < MAX_REDIRECTS) {
                    String loc = up.get("Location");
                    Target nx = loc == null ? null : parseUrl(absolutize(loc, t0.scheme, curHost, curPort));
                    if (nx != null && nx.scheme.equals(t0.scheme)) {
                        curHost = nx.host; curPort = nx.port; curPath = nx.path;
                        closeQuietly(sk);
                        continue;
                    }
                }

                sink.onHead(status, up);

                // —— 读体：chunked 自己解包 / Content-Length 读满 / 其余读到 EOF ——
                sk.setSoTimeout(0);                       // 体阶段不设读超时：思考型模型可以静默几十秒
                String te = up.get("Transfer-Encoding");
                String cl = up.get("Content-Length");
                if (te != null && te.toLowerCase(Locale.ROOT).contains("chunked")) {
                    readChunked(is, handle, sink);
                } else if (cl != null && cl.trim().length() > 0) {
                    int n;
                    try { n = Integer.parseInt(cl.trim()); } catch (NumberFormatException e) { n = -1; }
                    if (n >= 0) {
                        byte[] buf = new byte[8192];
                        int left = n;
                        while (left > 0) {
                            int r = is.read(buf, 0, Math.min(buf.length, left));
                            if (r <= 0) throw new IOException("上游提前关闭（还差 " + left + " 字节）");
                            left -= r;
                            sink.onData(buf, r);
                            if (handle.isCancelled()) throw new IOException("已取消");
                        }
                    } else {
                        pump(is, handle, sink);
                    }
                } else {
                    pump(is, handle, sink);
                }
                sink.onDone();
                return;
            } catch (IOException e) {
                if (handle.isCancelled()) { sink.onError("已取消"); return; }
                sink.onError(describe(e));
                return;
            } catch (Throwable e) {
                sink.onError(e.getClass().getSimpleName() + ": " + e.getMessage());
                return;
            } finally {
                closeQuietly(sk);
            }
        }
        sink.onError("重定向次数过多（>" + MAX_REDIRECTS + "）");
    }

    /** 把 3xx 的 Location 补成绝对 URL（支持 http(s)://… 与 /path 两种写法）。 */
    static String absolutize(String loc, String scheme, String curHost, int curPort) {
        String s = String.valueOf(loc == null ? "" : loc).trim();
        if (s.isEmpty()) return "";
        if (s.regionMatches(true, 0, "http://", 0, 7) || s.regionMatches(true, 0, "https://", 0, 8)) return s;
        int dflt = "https".equals(scheme) ? 443 : 80;
        String authority = curHost + (curPort == dflt ? "" : (":" + curPort));
        return scheme + "://" + authority + (s.startsWith("/") ? s : ("/" + s));
    }

    private static Socket openPlain(String host, int port, int connectTimeoutMs) throws IOException {        Socket s = new Socket();
        s.connect(new InetSocketAddress(host, port), connectTimeoutMs);
        s.setTcpNoDelay(true);
        return s;
    }

    private static Socket openTls(String host, int port, int connectTimeoutMs) throws IOException {
        Socket plain = openPlain(host, port, connectTimeoutMs);
        SSLSocketFactory f = (SSLSocketFactory) SSLSocketFactory.getDefault();
        SSLSocket ssl = (SSLSocket) f.createSocket(plain, host, port, true);
        ssl.setTcpNoDelay(true);
        // 证书链 + 主机名校验交给系统默认（与 WebView fetch / CapacitorHttp 同一口径；
        // LocalProxyServer 那套没做主机名校验，这里是新代码、按更严的来）。
        try {
            javax.net.ssl.SSLParameters p = ssl.getSSLParameters();
            p.setEndpointIdentificationAlgorithm("HTTPS");
            ssl.setSSLParameters(p);
        } catch (Throwable ignored) { /* 个别实现不支持就退回默认 */ }
        ssl.startHandshake();
        return ssl;
    }

    /** 无长度/非 chunked：读到 EOF（Connection: close 就是结束信号）。 */
    private static void pump(InputStream is, StreamHandle handle, Sink sink) throws IOException {
        byte[] buf = new byte[8192];
        int n;
        while ((n = is.read(buf)) != -1) {
            if (n > 0) sink.onData(buf, n);
            if (handle.isCancelled()) throw new IOException("已取消");
        }
    }

    /** 解包 chunked 体：每次解出一段就立刻交给 Sink（读满声明的长度，避免 TCP 分段把帧切坏）。 */
    private static void readChunked(InputStream is, StreamHandle handle, Sink sink) throws IOException {
        while (true) {
            byte[] sizeLine = readLine(is);
            if (sizeLine == null) break;                     // 上游直接关连接收尾（Connection: close 下常见）
            String sizeStr = new String(sizeLine, "UTF-8").trim();
            int semi = sizeStr.indexOf(';');                 // chunk 扩展忽略
            if (semi >= 0) sizeStr = sizeStr.substring(0, semi).trim();
            if (sizeStr.isEmpty()) break;
            int size;
            try { size = Integer.parseInt(sizeStr, 16); }
            catch (NumberFormatException e) { throw new IOException("chunk 长度不合法：" + sizeStr); }
            if (size == 0) { readLine(is); break; }          // 末尾 0 块 + 收尾 CRLF
            byte[] data = readExactly(is, size);
            sink.onData(data, data.length);
            if (handle.isCancelled()) throw new IOException("已取消");
            if (readLine(is) == null) break;                 // 每个 chunk 数据后的 CRLF
        }
    }

    private static byte[] readExactly(InputStream is, int len) throws IOException {
        byte[] out = new byte[len];
        int off = 0;
        while (off < len) {
            int r = is.read(out, off, len - off);
            if (r <= 0) throw new IOException("上游在块中途关闭（需要 " + len + " 字节，实到 " + off + "）");
            off += r;
        }
        return out;
    }

    /** 读一行（去掉尾部 CR）；EOF 且无内容返回 null。 */
    private static byte[] readLine(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(128);
        int b;
        while ((b = is.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') baos.write(b);
        }
        if (b == -1 && baos.size() == 0) return null;
        return baos.toByteArray();
    }

    private static int parseStatusCode(String statusLine) {
        String[] toks = String.valueOf(statusLine).split(" ");
        if (toks.length >= 2) {
            try { return Integer.parseInt(toks[1]); } catch (Exception ignored) { /* 保持 200 */ }
        }
        return 200;
    }

    private static String describe(IOException e) {
        String m = e.getMessage();
        String s = (m == null || m.isEmpty()) ? e.getClass().getSimpleName() : m;
        return e.getClass().getSimpleName() + ": " + s;
    }

    private static void closeQuietly(Socket s) {
        if (s == null) return;
        try { s.close(); } catch (IOException ignored) { /* ignore */ }
    }
}
