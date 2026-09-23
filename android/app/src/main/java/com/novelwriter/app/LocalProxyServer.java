package com.novelwriter.app;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Loopback HTTP proxy that runs inside the app.
 *
 * The Volcengine Ark Coding Plan endpoint returns CORS headers that do not
 * allow the Authorization request header, so the WebView's native fetch() is
 * blocked. This server listens on 127.0.0.1 and forwards requests upstream.
 *
 * CRITICAL: the upstream connection is made with a raw SSLSocket + a hand-written
 * HTTP/1.1 request, NOT HttpURLConnection/OkHttp. Those libraries buffer the
 * response body (transparent gzip / connection pooling internals), which made
 * SSE first-token time blow up from seconds to minutes. A raw SSLSocket hands
 * bytes straight to us as they arrive, so we can flush them to the WebView
 * immediately — matching native fetch streaming.
 */
public class LocalProxyServer {
    private static final String TAG = "LocalProxy";
    private static final int SO_TIMEOUT_MS = 300000;
    /** 上游默认端口（https）；URL 里带端口时以 URL 为准 */
    static final int DEFAULT_UPSTREAM_PORT = 443;
    /** 重定向最多跟随次数 */
    private static final int MAX_REDIRECTS = 3;
    /** 缺省 UA：手写请求原本不带 UA，部分网关/WAF 会因此直接拒绝 */
    static final String DEFAULT_UA = "BQBHub-Android/1.0 (OpenAI-compatible client)";

    // 跳过的请求头：hop-by-hop（逐跳语义，不能转发）
    private static final java.util.Set<String> HOP_BY_HOP = new java.util.HashSet<>(java.util.Arrays.asList(
            "host", "connection", "keep-alive", "proxy-connection", "proxy-authorization",
            "te", "trailer", "transfer-encoding", "upgrade"));
    // 自己重算/强制覆盖的头
    private static final java.util.Set<String> MANAGED = new java.util.HashSet<>(java.util.Arrays.asList(
            "content-length", "accept-encoding"));

    /**
     * 解析代理目标 "host[:port]/path"（WebView 请求行 target 形如 /api.x.com/v1/chat/completions?q=1）。
     * 返回 {host, port, path}；端口缺省 443（https 默认）。浏览器来源头由调用方另行剔除。
     */
    static String[] parseTarget(String target) {
        String hp = target.startsWith("/") ? target.substring(1) : target;
        int slash = hp.indexOf('/');
        String hostPort = slash >= 0 ? hp.substring(0, slash) : hp;
        String path = slash >= 0 ? hp.substring(slash) : "/";
        int port = DEFAULT_UPSTREAM_PORT;
        int colon = hostPort.lastIndexOf(':');
        if (colon >= 0) {
            try {
                int p = Integer.parseInt(hostPort.substring(colon + 1));
                if (p > 0 && p < 65536) { port = p; hostPort = hostPort.substring(0, colon); }
            } catch (NumberFormatException ignored) { /* 非端口（异常 host）→ 保持默认 */ }
        }
        return new String[]{hostPort, String.valueOf(port), path};
    }

    /**
     * 该请求头是否不转发给上游。
     * 浏览器来源头（Origin/Referer/Sec-*）主动剔除：把 webview 的来源暴露给上游
     * 可能触发反 CSRF / WAF 403，而聊天类端点不需要它们。
     */
    static boolean shouldSkipHeader(String name) {
        if (name == null) return true;
        String n = name.toLowerCase(java.util.Locale.ROOT);
        return HOP_BY_HOP.contains(n) || MANAGED.contains(n)
                || n.equals("origin") || n.equals("referer")
                || n.startsWith("sec-fetch-") || n.startsWith("sec-ch-");
    }

    private static boolean containsIgnoreCase(Map<String, String> m, String key) {
        for (String k : m.keySet()) { if (k.equalsIgnoreCase(key)) return true; }
        return false;
    }

    /**
     * 生成转发给上游的请求头：客户端头全量透传 − 跳过名单 + 补齐 UA / Accept / Content-Length，
     * 并强制 Accept-Encoding: identity（上游压缩会让响应体带上 Content-Encoding，链路上容易丢）。
     */
    static java.util.LinkedHashMap<String, String> buildUpstreamHeaders(Map<String, String> in, int bodyLength) {
        java.util.LinkedHashMap<String, String> out = new java.util.LinkedHashMap<>();
        for (Map.Entry<String, String> e : in.entrySet()) {
            if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
            if (shouldSkipHeader(e.getKey())) continue;
            out.put(e.getKey(), e.getValue());
        }
        if (!containsIgnoreCase(out, "User-Agent")) out.put("User-Agent", DEFAULT_UA);
        if (!containsIgnoreCase(out, "Accept")) out.put("Accept", "text/event-stream");
        if (!containsIgnoreCase(out, "Cache-Control")) out.put("Cache-Control", "no-cache");
        out.put("Accept-Encoding", "identity");
        out.put("Content-Length", String.valueOf(Math.max(0, bodyLength)));
        return out;
    }

    /**
     * 解析重定向 Location：绝对 https:// 或相对路径 → {host, port, path}；
     * 不支持的上游（http://）返回 null，交回 JS 层直连处理。
     */
    static String[] resolveRedirect(String location, String currentHost, int currentPort, String currentPath) {
        if (location == null) return null;
        String loc = location.trim();
        if (loc.isEmpty() || loc.startsWith("http://")) return null;
        if (loc.startsWith("https://")) {
            String rest = loc.substring("https://".length());
            int slash = rest.indexOf('/');
            String hp = slash >= 0 ? rest.substring(0, slash) : rest;
            String path = slash >= 0 ? rest.substring(slash) : "/";
            int port = DEFAULT_UPSTREAM_PORT;
            int colon = hp.lastIndexOf(':');
            if (colon >= 0) {
                try {
                    int p = Integer.parseInt(hp.substring(colon + 1));
                    if (p > 0 && p < 65536) { port = p; hp = hp.substring(0, colon); }
                } catch (NumberFormatException ignored) { /* keep default */ }
            }
            return new String[]{hp, String.valueOf(port), path};
        }
        if (loc.startsWith("/")) return new String[]{currentHost, String.valueOf(currentPort), loc};
        int q = currentPath.indexOf('?');
        String base = q >= 0 ? currentPath.substring(0, q) : currentPath;
        int lastSlash = base.lastIndexOf('/');
        String dir = lastSlash >= 0 ? base.substring(0, lastSlash + 1) : "/";
        return new String[]{currentHost, String.valueOf(currentPort), dir + loc};
    }


    public interface Callback {
        void onStarted(int port);
        void onError(String message);
    }

    private ServerSocket serverSocket;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private volatile int port = 0;
    private volatile boolean running = false;

    public int getPort() { return port; }

    public void start(final Callback cb) {
        pool.execute(new Runnable() {
            @Override public void run() {
                try {
                    serverSocket = new ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"));
                    port = serverSocket.getLocalPort();
                    running = true;
                    if (cb != null) cb.onStarted(port);
                    Log.i(TAG, "Proxy listening on 127.0.0.1:" + port);
                    while (running) {
                        final Socket client;
                        try {
                            client = serverSocket.accept();
                        } catch (IOException e) {
                            if (running) Log.w(TAG, "accept failed: " + e.getMessage());
                            break;
                        }
                        pool.execute(new Runnable() {
                            @Override public void run() { handleClient(client); }
                        });
                    }
                } catch (final IOException e) {
                    Log.e(TAG, "Failed to start proxy", e);
                    if (cb != null) cb.onError(e.getMessage());
                }
            }
        });
    }

    public void stop() {
        running = false;
        try { if (serverSocket != null) serverSocket.close(); } catch (IOException ignored) {}
        pool.shutdownNow();
    }

    // --- Request handling ---------------------------------------------------

    private void handleClient(Socket client) {
        try {
            client.setSoTimeout(SO_TIMEOUT_MS);
            client.setTcpNoDelay(true);
            InputStream cis = client.getInputStream();
            OutputStream cos = client.getOutputStream();

            byte[] lineBuf = readLine(cis);
            if (lineBuf == null) { safeClose(client); return; }
            String reqLine = new String(lineBuf, "UTF-8");
            String[] parts = reqLine.split(" ");
            if (parts.length < 3) { sendSimple(cos, 400, "Bad Request"); safeClose(client); return; }
            String method = parts[0];
            // target = "/ark.cn-beijing.volces.com/api/coding/v3/chat/completions"
            String target = parts[1];

            // Case-insensitive header map (WebView lowercases header names).
            Map<String, String> headers = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
            byte[] h;
            while ((h = readLine(cis)) != null && h.length > 0) {
                String hl = new String(h, "UTF-8");
                int colon = hl.indexOf(':');
                if (colon > 0) {
                    String k = hl.substring(0, colon).trim();
                    String v = hl.substring(colon + 1).trim();
                    headers.put(k, v);
                }
            }

            if ("OPTIONS".equalsIgnoreCase(method)) {
                writeCorsPreflight(cos, headers.get("Access-Control-Request-Headers"));
                safeClose(client);
                return;
            }
            boolean isPost = "POST".equalsIgnoreCase(method);
            if (!isPost && !"GET".equalsIgnoreCase(method)) {
                sendSimple(cos, 405, "Method Not Allowed");
                safeClose(client);
                return;
            }

            int contentLength = 0;
            try { contentLength = Integer.parseInt(headers.getOrDefault("Content-Length", "0")); } catch (Exception ignored) {}
            byte[] body = new byte[0];
            if (isPost && contentLength > 0) {
                body = new byte[contentLength];
                int off = 0;
                while (off < contentLength) {
                    int r = cis.read(body, off, contentLength - off);
                    if (r <= 0) break;
                    off += r;
                }
            }

            // target "/host[:port]/path" → host / port / path（端口以 URL 为准，缺省 443）
            String[] t = parseTarget(target);
            forwardOverRawTls(method, t[0], Integer.parseInt(t[1]), t[2], headers, body, cos);
        } catch (Exception e) {
            Log.w(TAG, "client handler error: " + e.getMessage());
            try { sendSimple(client.getOutputStream(), 502, "Bad Gateway: " + e.getMessage()); } catch (Exception ignored) {}
        } finally {
            safeClose(client);
        }
    }

    /**
     * Open a raw TLS socket to host:port, send the request by hand, read the
     * response status/headers, then pipe the body straight to `cos`, flushing
     * on every read. No application-layer buffering.
     * 端口以 URL 为准；3xx 跟随最多 MAX_REDIRECTS 跳；上游 Content-Encoding 原样回传
     * （让 WebView 自己解压，避免 gzip 被当 SSE 文本解析成静默空回）。
     */
    private void forwardOverRawTls(String method, String host, int port, String path,
                                   Map<String, String> inHeaders, byte[] body, OutputStream cos) throws IOException {
        String curHost = host, curPath = path;
        int curPort = port;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            SSLSocket ssl = null;
            try {
                SSLSocketFactory f = (SSLSocketFactory) SSLSocketFactory.getDefault();
                ssl = (SSLSocket) f.createSocket(curHost, curPort);
                ssl.setTcpNoDelay(true);
                ssl.setSoTimeout(SO_TIMEOUT_MS);
                ssl.startHandshake();

                OutputStream sos = ssl.getOutputStream();
                StringBuilder req = new StringBuilder();
                // IMPORTANT: use HTTP/1.1, not 1.0. The Volcengine gateway (istio-envoy)
                // buffers the entire response for HTTP/1.0 clients and only flushes
                // when the model finishes — that's why output appeared all at once.
                // HTTP/1.1 with chunked transfer is the standard SSE transport and
                // streams immediately; pipeChunkedUpstream() de-chunks it for us.
                req.append(method).append(' ').append(curPath).append(" HTTP/1.1\r\n");
                req.append("Host: ").append(curHost).append("\r\n");
                req.append("Connection: close\r\n");
                // 头全量透传 − 跳过名单（hop-by-hop / 浏览器来源头）+ 补齐 UA/Accept/Content-Length
                java.util.LinkedHashMap<String, String> fwd = buildUpstreamHeaders(inHeaders, body.length);
                for (Map.Entry<String, String> e : fwd.entrySet()) {
                    req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
                }
                req.append("\r\n");
                sos.write(req.toString().getBytes("UTF-8"));
                if (body.length > 0) sos.write(body);
                sos.flush();

                InputStream sis = ssl.getInputStream();

                // Read the upstream status line + headers.
                byte[] statusLineBytes = readLine(sis);
                if (statusLineBytes == null) {
                    sendSimple(cos, 502, "Empty response from upstream");
                    return;
                }
                String statusLine = new String(statusLineBytes, "UTF-8");
                int status = parseStatusCode(statusLine);

                Map<String, String> upHeaders = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
                byte[] uh;
                while ((uh = readLine(sis)) != null && uh.length > 0) {
                    String hl = new String(uh, "UTF-8");
                    int c = hl.indexOf(':');
                    if (c > 0) upHeaders.put(hl.substring(0, c).trim(), hl.substring(c + 1).trim());
                }

                // 3xx + Location：跟随重定向（跨 host 重建 TLS；method/body 原样重发）
                if (status >= 300 && status < 400) {
                    String[] next = resolveRedirect(upHeaders.get("Location"), curHost, curPort, curPath);
                    if (next != null && hop < MAX_REDIRECTS) {
                        Log.i(TAG, "redirect " + status + " -> " + next[0] + ":" + next[1] + next[2]);
                        curHost = next[0];
                        curPort = Integer.parseInt(next[1]);
                        curPath = next[2];
                        continue;
                    }
                    // 不跟随/超出跳数：把 3xx 原样回给 JS（交由它决定）
                    writeStatusLine(cos, status);
                    writeHeader(cos, "Content-Type", "text/plain; charset=utf-8");
                    writeHeader(cos, "Content-Length", "0");
                    writeHeader(cos, "Access-Control-Allow-Origin", "*");
                    writeHeader(cos, "Connection", "close");
                    cos.write("\r\n".getBytes("UTF-8"));
                    cos.flush();
                    return;
                }

                // Non-2xx: buffer the error body and send with Content-Length so
                // the JS side can read response.text() with the real status.
                if (status < 200 || status >= 300) {
                    ByteArrayOutputStream errBuf = new ByteArrayOutputStream();
                    byte[] ebuf = new byte[2048];
                    int en;
                    while ((en = sis.read(ebuf)) != -1) errBuf.write(ebuf, 0, en);
                    byte[] errBody = errBuf.toByteArray();
                    writeStatusLine(cos, status);
                    writeHeader(cos, "Content-Type", "application/json; charset=utf-8");
                    writeHeader(cos, "Content-Length", String.valueOf(errBody.length));
                    writeHeader(cos, "Access-Control-Allow-Origin", "*");
                    writeHeader(cos, "Connection", "close");
                    cos.write("\r\n".getBytes("UTF-8"));
                    cos.write(errBody);
                    cos.flush();
                    return;
                }

                // 2xx: stream back with HTTP/1.1 chunked transfer encoding. This is
                // the critical piece for real streaming: Chromium hands each chunk
                // to fetch's ReadableStream immediately, whereas an HTTP/1.0
                // length-less response may buffer the whole body in the WebView.
                writeStatusLine(cos, 200);
                String ct = upHeaders.get("Content-Type");
                writeHeader(cos, "Content-Type", ct != null ? ct : "text/event-stream; charset=utf-8");
                // 上游 Content-Encoding 原样回传：WebView 自己解压。缺了它，上游忽略
                // identity 返回 gzip 时压缩字节会被当 SSE 文本解析（静默空回）。
                String ce = upHeaders.get("Content-Encoding");
                if (ce != null && !ce.isEmpty()) writeHeader(cos, "Content-Encoding", ce);
                writeHeader(cos, "Cache-Control", "no-cache, no-transform");
                writeHeader(cos, "X-Accel-Buffering", "no");
                writeHeader(cos, "Access-Control-Allow-Origin", "*");
                writeHeader(cos, "Access-Control-Allow-Methods", "GET, POST, OPTIONS");
                writeHeader(cos, "Access-Control-Allow-Headers", "Authorization, Content-Type, X-Api-Key, api-key, anthropic-version, x-goog-api-key");
                writeHeader(cos, "Transfer-Encoding", "chunked");
                writeHeader(cos, "Connection", "close");
                cos.write("\r\n".getBytes("UTF-8"));
                cos.flush();

                // Pipe the upstream body through. The server may respond chunked
                // even though we asked for HTTP/1.0, so de-chunk if needed before
                // re-chunking for the WebView. Each piece of decoded data is sent
                // as one downstream chunk and flushed immediately.
                try {
                    boolean upChunked = "chunked".equalsIgnoreCase(upHeaders.get("Transfer-Encoding"));
                    if (upChunked) {
                        pipeChunkedUpstream(sis, cos);
                    } else {
                        byte[] buf = new byte[1024];
                        int n;
                        while ((n = sis.read(buf)) != -1) {
                            writeChunk(cos, buf, n);
                            cos.flush();
                        }
                    }
                } catch (IOException pipeErr) {
                    // Upstream died mid-stream (socket timeout, connection reset,
                    // SSL EOF, ...). The 200 is already on the wire, so we cannot
                    // change the HTTP status. Inject a sentinel SSE event carrying
                    // the real cause; the JS side recognizes __proxy_error__ and
                    // surfaces it as the network error message.
                    Log.w(TAG, "upstream pipe error: " + pipeErr.getMessage());
                    writeSseError(cos, pipeErr);
                    // Fall through to finally, which closes the socket normally.
                    return;
                }
                // Terminating zero-length chunk.
                cos.write("0\r\n\r\n".getBytes("UTF-8"));
                cos.flush();
                return;
            } finally {
                if (ssl != null) try { ssl.close(); } catch (IOException ignored) {}
            }
        }
    }

    /**
     * Emit one SSE data frame inside the open chunked stream that tells the JS
     * side exactly why the upstream connection died, then terminate the chunked
     * body. Best-effort: if the WebView has already gone away we just swallow.
     */
    private void writeSseError(OutputStream cos, Throwable cause) {
        try {
            String type = cause.getClass().getSimpleName();
            String msg = cause.getMessage() != null ? cause.getMessage() : type;
            // Keep it JSON-safe and on a single SSE data: line.
            String safe = msg.replace("\\", "\\\\").replace("\"", "\\\"")
                             .replace("\r", " ").replace("\n", " ");
            // Leading \n guarantees we start on a fresh SSE line even if the
            // upstream's last event had no trailing newline.
            String payload = "\ndata: {\"__proxy_error__\":true,\"type\":\""
                    + type + "\",\"message\":\"" + safe + "\"}\n\n";
            byte[] pb = payload.getBytes("UTF-8");
            writeChunk(cos, pb, pb.length);
            cos.write("0\r\n\r\n".getBytes("UTF-8"));
            cos.flush();
        } catch (IOException ignored) {
            // Client already gone; nothing more we can do.
        }
    }

    private void copyHeader(Map<String, String> in, StringBuilder req, String name) {
        String v = in.get(name);
        if (v != null && !v.isEmpty()) {
            req.append(name).append(": ").append(v).append("\r\n");
        }
    }

    static int parseStatusCode(String statusLine) {
        // "HTTP/1.1 200 OK"
        String[] toks = statusLine.split(" ");
        if (toks.length >= 2) {
            try { return Integer.parseInt(toks[1]); } catch (Exception ignored) {}
        }
        return 200;
    }

    private void writeCorsPreflight(OutputStream cos, String requestedHeaders) throws IOException {
        // 回显浏览器实际要发的头（Authorization/api-key/anthropic-version 等都能过），
        // 避免固定白名单漏掉新端点需要的头。
        String allow = (requestedHeaders != null && !requestedHeaders.isEmpty())
                ? requestedHeaders
                : "Authorization, Content-Type, X-Api-Key, api-key, anthropic-version, x-goog-api-key";
        String resp = "HTTP/1.1 204 No Content\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" +
                "Access-Control-Allow-Headers: " + allow + "\r\n" +
                "Access-Control-Max-Age: 86400\r\n" +
                "Content-Length: 0\r\n" +
                "Connection: close\r\n\r\n";
        cos.write(resp.getBytes("UTF-8"));
        cos.flush();
    }

    private void writeStatusLine(OutputStream cos, int status) throws IOException {
        String reason;
        switch (status) {
            case 200: reason = "OK"; break;
            case 400: reason = "Bad Request"; break;
            case 401: reason = "Unauthorized"; break;
            case 403: reason = "Forbidden"; break;
            case 404: reason = "Not Found"; break;
            case 429: reason = "Too Many Requests"; break;
            case 500: reason = "Internal Server Error"; break;
            default: reason = "Unknown";
        }
        cos.write(("HTTP/1.1 " + status + " " + reason + "\r\n").getBytes("UTF-8"));
    }

    private void writeHeader(OutputStream cos, String k, String v) throws IOException {
        cos.write((k + ": " + v + "\r\n").getBytes("UTF-8"));
    }

    // Write one HTTP/1.1 chunk: hex-length + CRLF + data + CRLF.
    private void writeChunk(OutputStream cos, byte[] data, int len) throws IOException {
        cos.write((Integer.toHexString(len) + "\r\n").getBytes("UTF-8"));
        cos.write(data, 0, len);
        cos.write("\r\n".getBytes("UTF-8"));
    }

    // Read an upstream chunked body, stripping the chunk framing, and re-emit
    // the raw data as downstream chunks. Reads exactly the declared number of
    // bytes per chunk so TCP segment boundaries don't corrupt the framing.
    private void pipeChunkedUpstream(InputStream sis, OutputStream cos) throws IOException {
        while (true) {
            byte[] sizeLine = readLine(sis);
            if (sizeLine == null) {
                // Clean EOF after a complete previous chunk. Some servers (we
                // set Connection: close) end the response by closing the socket
                // without sending a formal 0-length chunk — that's normal.
                break;
            }
            String sizeStr = new String(sizeLine, "UTF-8").trim();
            // Chunk extensions appear after ';' — ignore them.
            int semi = sizeStr.indexOf(';');
            if (semi >= 0) sizeStr = sizeStr.substring(0, semi).trim();
            if (sizeStr.isEmpty()) {
                // Blank line where a chunk size should be — tolerate as end.
                break;
            }
            int size;
            try { size = Integer.parseInt(sizeStr, 16); }
            catch (NumberFormatException e) {
                throw new IOException("bad chunk size line: " + sizeStr);
            }
            if (size == 0) {
                // Trailing CRLF after the final chunk (may be EOF).
                readLine(sis);
                break;
            }
            // readExactly throws on short read -> reports real truncation.
            byte[] data = readExactly(sis, size);
            writeChunk(cos, data, data.length);
            cos.flush();
            // CRLF following each chunk's data. EOF here is a clean close.
            if (readLine(sis) == null) break;
        }
    }

    // Read exactly len bytes (blocking as needed). A short read means the
    // upstream closed the connection mid-chunk — throw so the caller reports a
    // real error instead of silently emitting truncated content.
    private byte[] readExactly(InputStream is, int len) throws IOException {
        byte[] out = new byte[len];
        int off = 0;
        while (off < len) {
            int r = is.read(out, off, len - off);
            if (r <= 0) {
                throw new IOException("upstream closed mid-chunk (expected "
                        + len + " bytes, got " + off + ")");
            }
            off += r;
        }
        return out;
    }

    private void sendSimple(OutputStream cos, int status, String body) throws IOException {
        byte[] bb = body.getBytes("UTF-8");
        writeStatusLine(cos, status);
        writeHeader(cos, "Content-Type", "text/plain; charset=utf-8");
        writeHeader(cos, "Content-Length", String.valueOf(bb.length));
        writeHeader(cos, "Access-Control-Allow-Origin", "*");
        writeHeader(cos, "Connection", "close");
        cos.write("\r\n".getBytes("UTF-8"));
        cos.write(bb);
        cos.flush();
    }

    // Read until \n, stripping trailing CR. Returns null at EOF with no data.
    // Not used for high-throughput paths (just request/status/headers), so the
    // single-byte read is fine.
    private byte[] readLine(InputStream is) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(128);
        int b;
        while ((b = is.read()) != -1) {
            if (b == '\n') break;
            if (b != '\r') baos.write(b);
        }
        if (b == -1 && baos.size() == 0) return null;
        return baos.toByteArray();
    }

    private void safeClose(Socket s) {
        try { s.close(); } catch (Exception ignored) {}
    }
}
