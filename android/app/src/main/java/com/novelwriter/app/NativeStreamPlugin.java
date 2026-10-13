package com.novelwriter.app;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 原生流式取数插件（B 方案）：把 NativeStreamCore 的字节流按事件推给网页。
 *
 * JS 侧（见 app/src/lib/nativestream.ts）：
 *   NativeStream.open({ url, headers, body, connectTimeoutMs?, headTimeoutMs? })
 *     → resolve { id, status }（**响应头到手**就回来；非 2xx 也算成功返回，由 JS 决定怎么处理）
 *     → reject(msg)（连不上 / TLS / 头超时）
 *   事件：chunk { id, b64 }（解包后的原始字节，base64）→ done { id } / error { id, message }
 *   NativeStream.close({ id })  取消（用户点「暂停」/ 切走都走它）
 *
 * 为什么要批量推：SSE 一帧可能只有几十字节，逐帧过桥（JSON + JS eval）开销大。这里按
 * "攒够 4KB / 最多等 20ms / 第一段立刻推"三条规则合并；第一段立刻推是为了保住首字延迟。
 * 事件必须在**主线程**发（子线程直接 notifyListeners 会丢中途事件——UpdateCheckerPlugin 踩过）。
 */
@CapacitorPlugin(name = "NativeStream")
public class NativeStreamPlugin extends Plugin {

    private static final String TAG = "NativeStream";
    private static final int BATCH_BYTES = 4096;
    private static final int BATCH_MS = 20;
    private static final int DEFAULT_CONNECT_MS = 15000;
    private static final int DEFAULT_HEAD_MS = 90000;

    /** 一次会话：core 的句柄 + 攒批缓冲。pending/flushScheduled 都在 sess 锁里访问。 */
    private static final class Session {
        NativeStreamCore.StreamHandle handle;
        final Object lock = new Object();
        final ByteArrayOutputStream pending = new ByteArrayOutputStream(8192);
        boolean flushedAnything = false;   // 还没推过任何一段 → 下一段立刻推（首字）
        boolean flushScheduled = false;
        volatile boolean finished = false;
    }

    private final ConcurrentHashMap<String, Session> sessions = new ConcurrentHashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());

    @PluginMethod
    public void open(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("url required"); return; }
        final String bodyStr = call.getString("body", "");
        Integer ci = call.getInt("connectTimeoutMs");
        Integer hi = call.getInt("headTimeoutMs");
        final int connectMs = (ci != null && ci > 0) ? ci : DEFAULT_CONNECT_MS;
        final int headMs = (hi != null && hi > 0) ? hi : DEFAULT_HEAD_MS;
        final Map<String, String> headers = new HashMap<>();
        JSObject hs = call.getObject("headers");
        if (hs != null) {
            Iterator<String> it = hs.keys();
            while (it.hasNext()) {
                String k = it.next();
                Object v = hs.opt(k);
                if (k != null && v != null) headers.put(k, String.valueOf(v));
            }
        }

        final String id = UUID.randomUUID().toString();
        final Session sess = new Session();
        sessions.put(id, sess);
        // headDelivered：resolve 只发一次；头之前的失败改成直接 reject（否则 JS 那个 open() promise
        // 永远挂着——它还没有 id，收不到 error 事件）。
        final AtomicBoolean headDelivered = new AtomicBoolean(false);
        final byte[] body = bodyStr == null ? new byte[0] : bodyStr.getBytes(java.nio.charset.StandardCharsets.UTF_8);

        sess.handle = NativeStreamCore.start(url, headers, body, connectMs, headMs, new NativeStreamCore.Sink() {
            @Override public void onHead(final int status, Map<String, String> respHeaders) {
                if (headDelivered.compareAndSet(false, true)) {
                    final JSObject ret = new JSObject();
                    ret.put("id", id);
                    ret.put("status", status);
                    main.post(new Runnable() {
                        @Override public void run() { call.resolve(ret); }
                    });
                }
            }

            @Override public void onData(byte[] buf, int len) {
                byte[] out = null;
                synchronized (sess.lock) {
                    if (sess.finished) return;
                    sess.pending.write(buf, 0, len);
                    if (!sess.flushedAnything || sess.pending.size() >= BATCH_BYTES) {
                        out = takePending(sess);
                        sess.flushedAnything = true;
                    } else if (!sess.flushScheduled) {
                        sess.flushScheduled = true;
                        main.postDelayed(new Runnable() {
                            @Override public void run() {
                                byte[] b = null;
                                synchronized (sess.lock) {
                                    sess.flushScheduled = false;
                                    if (sess.pending.size() > 0) { b = takePending(sess); sess.flushedAnything = true; }
                                }
                                if (b != null) emit(id, b);
                            }
                        }, BATCH_MS);
                    }
                }
                if (out != null) emit(id, out);
            }

            @Override public void onDone() {
                flushAndFinish(id, sess, null);
            }

            @Override public void onError(String message) {
                if (headDelivered.compareAndSet(false, true)) {
                    // 头都没拿到（连不上 / TLS / 头超时 / 取消）→ 让 JS 直接 reject，走老通道
                    final String msg = message;
                    sessions.remove(id);
                    main.post(new Runnable() {
                        @Override public void run() { call.reject(msg); }
                    });
                    return;
                }
                flushAndFinish(id, sess, message);
            }
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        String id = call.getString("id");
        Session sess = id == null ? null : sessions.remove(id);
        if (sess != null && sess.handle != null) {
            try { sess.handle.cancel(); } catch (Throwable ignored) { /* 取消失败也不影响 */ }
        }
        call.resolve();
    }

    /** 收尾：把余下的攒批推完，再发 done / error（错误时若还没 resolve 就 reject，让 JS 直接回退老通道）。 */
    private void flushAndFinish(final String id, final Session sess, final String error) {
        byte[] tail = null;
        synchronized (sess.lock) {
            if (sess.finished) return;
            sess.finished = true;
            if (sess.pending.size() > 0) tail = takePending(sess);
        }
        if (tail != null) emit(id, tail);
        sessions.remove(id);
        main.post(new Runnable() {
            @Override public void run() {
                JSObject d = new JSObject();
                d.put("id", id);
                if (error != null) { d.put("message", error); notifyListeners("error", d); }
                else notifyListeners("done", d);
            }
        });
    }

    private static byte[] takePending(Session sess) {
        byte[] out = sess.pending.toByteArray();
        sess.pending.reset();
        return out;
    }

    /** 主线程发一段时间片（base64 + 会话 id）。webView 已销毁时 notifyListeners 会抛，静默吞掉即可。 */
    private void emit(final String id, final byte[] bytes) {
        if (bytes == null || bytes.length == 0) return;
        main.post(new Runnable() {
            @Override public void run() {
                try {
                    JSObject e = new JSObject();
                    e.put("id", id);
                    e.put("b64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    notifyListeners("chunk", e);
                } catch (Throwable t) {
                    Log.w(TAG, "emit failed: " + t.getMessage());
                }
            }
        });
    }

    /** Activity 销毁：把所有在飞的连接掐掉（否则线程和 socket 会挂到进程结束）。 */
    @Override
    public void handleOnDestroy() {
        for (Map.Entry<String, Session> e : sessions.entrySet()) {
            Session s = e.getValue();
            if (s != null && s.handle != null) {
                try { s.handle.cancel(); } catch (Throwable ignored) { /* ignore */ }
            }
        }
        sessions.clear();
        super.handleOnDestroy();
    }
}
