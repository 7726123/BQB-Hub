package com.novelwriter.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.LinkedHashMap;
import java.util.TreeMap;

import org.junit.Test;

/**
 * LocalProxyServer 纯函数单测：请求目标解析（端口）、头透传/跳过名单、重定向解析、状态码解析。
 * 这些是"覆盖面"的关键逻辑——不依赖 socket，可在 CI 的 JVM 单测里跑（./gradlew testDebugUnitTest）。
 */
public class LocalProxyServerTest {

    @Test
    public void parseTarget_defaultsTo443() {
        String[] t = LocalProxyServer.parseTarget("/api.deepseek.com/v1/chat/completions");
        assertEquals("api.deepseek.com", t[0]);
        assertEquals("443", t[1]);
        assertEquals("/v1/chat/completions", t[2]);
    }

    @Test
    public void parseTarget_keepsExplicitPortAndQuery() {
        // 非 443 端口的 https 端点：旧实现会把端口丢掉并固定连 443（必然失败）
        String[] t = LocalProxyServer.parseTarget("/llm.example.com:8443/v1/chat/completions?x=1");
        assertEquals("llm.example.com", t[0]);
        assertEquals("8443", t[1]);
        assertEquals("/v1/chat/completions?x=1", t[2]);
    }

    @Test
    public void parseTarget_noPathFallsBackToRoot() {
        String[] t = LocalProxyServer.parseTarget("/api.example.com");
        assertEquals("api.example.com", t[0]);
        assertEquals("443", t[1]);
        assertEquals("/", t[2]);
    }

    @Test
    public void headerSkipList_coversHopByHopAndBrowserOrigin() {
        assertTrue(LocalProxyServer.shouldSkipHeader("Host"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Connection"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Keep-Alive"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Transfer-Encoding"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Content-Length"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Accept-Encoding"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Origin"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Referer"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Sec-Fetch-Site"));
        assertTrue(LocalProxyServer.shouldSkipHeader("Sec-CH-UA"));
        // 鉴权与端点自定义头必须透传（旧实现只转发 3 个头，Azure/Google/Anthropic 全丢）
        assertFalse(LocalProxyServer.shouldSkipHeader("Authorization"));
        assertFalse(LocalProxyServer.shouldSkipHeader("api-key"));
        assertFalse(LocalProxyServer.shouldSkipHeader("X-Api-Key"));
        assertFalse(LocalProxyServer.shouldSkipHeader("anthropic-version"));
        assertFalse(LocalProxyServer.shouldSkipHeader("x-goog-api-key"));
        assertFalse(LocalProxyServer.shouldSkipHeader("Content-Type"));
    }

    @Test
    public void buildUpstreamHeaders_forwardsCustomAuthAddsDefaultsDropsOrigin() {
        TreeMap<String, String> in = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        in.put("Authorization", "Bearer k");
        in.put("api-key", "azk");
        in.put("anthropic-version", "2023-06-01");
        in.put("Content-Type", "application/json");
        in.put("Origin", "http://127.0.0.1:9");
        in.put("Sec-Fetch-Site", "cross-site");
        in.put("Content-Length", "12");

        LinkedHashMap<String, String> out = LocalProxyServer.buildUpstreamHeaders(in, 42);

        assertEquals("Bearer k", out.get("Authorization"));
        assertEquals("azk", out.get("api-key"));
        assertEquals("2023-06-01", out.get("anthropic-version"));
        assertEquals("application/json", out.get("Content-Type"));
        assertEquals("42", out.get("Content-Length")); // 以实际 body 长度重算
        assertEquals("identity", out.get("Accept-Encoding")); // 强制不压缩
        assertTrue(out.containsKey("User-Agent"));             // 补齐缺省 UA
        assertFalse(out.containsKey("Origin"));
        assertFalse(out.containsKey("Sec-Fetch-Site"));
    }

    @Test
    public void buildUpstreamHeaders_keepsClientAcceptWhenPresent() {
        TreeMap<String, String> in = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        in.put("Accept", "application/json");
        LinkedHashMap<String, String> out = LocalProxyServer.buildUpstreamHeaders(in, 0);
        assertEquals("application/json", out.get("Accept")); // GET /models 这类不该被强制成 SSE
    }

    @Test
    public void resolveRedirect_absoluteRelativeAndUnsupported() {
        String[] a = LocalProxyServer.resolveRedirect("https://api2.example.com/v1/chat", "api.example.com", 443, "/v1/chat");
        assertEquals("api2.example.com", a[0]);
        assertEquals("443", a[1]);
        assertEquals("/v1/chat", a[2]);

        String[] b = LocalProxyServer.resolveRedirect("https://api2.example.com:8443/x/y", "api.example.com", 443, "/v1/chat");
        assertEquals("api2.example.com", b[0]);
        assertEquals("8443", b[1]);
        assertEquals("/x/y", b[2]);

        String[] c = LocalProxyServer.resolveRedirect("/v2/chat", "api.example.com", 443, "/v1/chat");
        assertEquals("api.example.com", c[0]);
        assertEquals("443", c[1]);
        assertEquals("/v2/chat", c[2]);

        String[] d = LocalProxyServer.resolveRedirect("chat2?q=1", "api.example.com", 443, "/v1/chat");
        assertEquals("/v1/chat2?q=1", d[2]);

        assertNull(LocalProxyServer.resolveRedirect("http://plain.example.com/x", "h", 443, "/"));
        assertNull(LocalProxyServer.resolveRedirect(null, "h", 443, "/"));
    }

    @Test
    public void parseStatusCode_readsCodeOrFallsBack() {
        assertEquals(429, LocalProxyServer.parseStatusCode("HTTP/1.1 429 Too Many Requests"));
        assertEquals(301, LocalProxyServer.parseStatusCode("HTTP/1.1 301 Moved Permanently"));
        assertEquals(200, LocalProxyServer.parseStatusCode("garbage"));
    }
}
