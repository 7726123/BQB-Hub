package bqbhub.server;

import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;

/**
 * 内存滑动窗限流（逐条对应 server/src/ratelimit.js）。
 * 单实例部署足够；多实例要换共享存储（Redis）——与 Node 版注释同款口径。
 * 阈值全部集中在 {@link Limiters}，这里只管算法；键格式（前缀 + id/ip）也与 Node 版保持一致，
 * 便于两边比对行为。
 */
public final class RateLimiter {

    private final long windowMs;
    private final int max;
    private final Map<String, ArrayDeque<Long>> buckets = new HashMap<>();

    public RateLimiter(long windowMs, int max) {
        this.windowMs = windowMs;
        this.max = max;
    }

    public synchronized boolean allow(String key) {
        long now = System.currentTimeMillis();
        ArrayDeque<Long> q = buckets.computeIfAbsent(key == null ? "" : key, k -> new ArrayDeque<>());
        while (!q.isEmpty() && now - q.peekFirst() >= windowMs) q.pollFirst();
        if (q.size() >= max) return false;
        q.addLast(now);
        return true;
    }

    public synchronized void reset(String key) {
        buckets.remove(key == null ? "" : key);
    }

    public synchronized void clear() {
        buckets.clear();
    }

    public synchronized int size() {
        return buckets.size();
    }

    /** 回收空桶（Node 版由 startSweeper 定时调用；Java 版按需调用，见 README） */
    public synchronized void sweep() {
        long now = System.currentTimeMillis();
        Iterator<Map.Entry<String, ArrayDeque<Long>>> it = buckets.entrySet().iterator();
        while (it.hasNext()) {
            ArrayDeque<Long> q = it.next().getValue();
            if (q.isEmpty() || now - q.peekLast() >= windowMs) it.remove();
        }
    }

    public long windowMs() {
        return windowMs;
    }

    public int max() {
        return max;
    }
}
