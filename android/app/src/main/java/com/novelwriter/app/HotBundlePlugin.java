package com.novelwriter.app;

import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;

/**
 * 网页包热更新插件。
 *
 * 机制（全部依赖 Capacitor 既有能力，不修改 Capacitor 源码）：
 *   - 客户端把整站资源换到一个目录：Bridge.loadWebView() 启动时会读
 *     SharedPreferences("CapWebViewSettings").serverBasePath，存在且目录有效就从该目录加载
 *     （同 origin，localStorage/世界书/密钥全部保持不变）。
 *   - 本插件的 load() 在 registerAllPlugins() 阶段执行，早于 loadWebView() 读 pref，
 *     因此「上一次没启动成功 → 回退」必须放在这里（时机由 Capacitor 构造顺序保证）。
 *   - 下载/校验/解包完成后只写 pref，**下次冷启动才生效**——绝不在用户写作中途换页面。
 *
 * 安全边界（K 的信任来源只有两处，别处一律不可信）：
 *   - payload（规范化文本，含每个文件的 sha256、包序号、minNative、zip 哈希）
 *   - sig（RSA-SHA256 签名，公钥硬编码在下方 PUBLIC_KEY_B64，私钥离线保管）
 *   验签、序号递增、minNative 检查全部在 native 侧完成：这段代码不可能被网络攻击者替换。
 */
@CapacitorPlugin(name = "HotBundle")
public class HotBundlePlugin extends Plugin {

    private static final String TAG = "HotBundle";

    /** 签名公钥（SPKI/DER 的 base64）。由 scripts/hot-bundle.mjs keygen 生成并打印；改它等于换信任根。 */
    private static final String PUBLIC_KEY_B64 =
        "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAs4aK3tt2N61rX2o9IvVC/rRX+7CONDGUx/D9eh9dCjItyySwR1EXCi2JGS9Y9yYi35xARhwGsxL0EJ2+Vt8bg8JJk/2XJvW4F5uhOoColawsVC/iGZo/Y04Us6Sc6ZwDkxckrphQYLPTsGKMdTL9SIwqGvlwQ3iYfnLmrRS7OUT/t1CYR9AEKBXQZ0g/FWLW0XUDtwcKBdxzDJkxeJzSFmTVJQ77Dgd5ZgedM9vsx1pCvv4A0FzoQgx5Z3KDYrrZE9UtmfG3iVZBuHGqCZGrh8JuqXRxa364ak+cC5TISso5Uq61/k0X+PwT4gFiigxT4nOfRLQTrf5D4po8d7brrwIDAQAB";

    /** 与 Capacitor WebView 插件共用同一个 prefs 文件与键（Capacitor 从这里读资源目录）。 */
    private static final String PREFS = "CapWebViewSettings";
    private static final String K_BASE_PATH = "serverBasePath";
    private static final String K_PENDING = "hotPending";   // 已安装、尚未确认成功的包版本
    private static final String K_VERSION = "hotVersion";   // 正在运行的热包版本（空 = 跑 APK 内置资源）
    private static final String K_CODE = "hotCode";         // 运行中热包的序号（拒绝降级用）
    private static final String K_BOOTS = "hotBoots";       // 未确认情况下的启动次数
    private static final String K_BLOCKED = "hotBlocked";   // 已回退过的版本（不再自动重装，避免反复回退）
    private static final String K_ROLLBACK = "hotRollback"; // 待上报给用户的回退事件（读一次即清）

    /** 新包启动后多久没等到 confirm 就判失败（冷启动慢的机器留足余量）。 */
    private static final int CONFIRM_TIMEOUT_MS = 25000;

    private static Handler sWatchdog;

    // ===== 生命期：回退判定（必须早于 Capacitor 读取 serverBasePath）=====

    @Override
    public void load() {
        try {
            rollbackIfUnconfirmed();
            armWatchdog();
        } catch (Throwable t) {
            Log.w(TAG, "load 阶段异常（忽略，不影响启动）", t);
        }
    }

    /**
     * 启动前判定：上一次「已安装未确认」的包如果这次仍然没被确认，就回退到 APK 内置资源。
     * 注意本方法在 loadWebView() 之前执行，所以清掉 serverBasePath 后 Capacitor 会直接
     * 加载内置资源——不需要额外 reload。
     */
    private void rollbackIfUnconfirmed() {
        SharedPreferences sp = prefs();
        String pending = sp.getString(K_PENDING, "");
        String base = sp.getString(K_BASE_PATH, "");
        String version = sp.getString(K_VERSION, "");
        SharedPreferences.Editor ed = sp.edit();
        boolean changed = false;

        boolean runningPending = !pending.isEmpty() && hotDir(pending).getAbsolutePath().equals(base);
        if (runningPending) {
            int boots = sp.getInt(K_BOOTS, 0);
            if (boots >= 1) {
                // 上一个启动周期到这一包也没能确认 → 判定它起不来，回退
                Log.w(TAG, "包 " + pending + " 连续两次未确认，回退到内置资源");
                ed.remove(K_BASE_PATH).remove(K_PENDING).remove(K_VERSION)
                  .putInt(K_BOOTS, 0)
                  .putString(K_ROLLBACK, pending)
                  .putString(K_BLOCKED, pending);
                changed = true;
            } else {
                ed.putInt(K_BOOTS, 1);
                changed = true;
            }
        } else {
            // 跑的不是「待确认的那一包」：清掉过期状态
            if (!pending.isEmpty()) { ed.remove(K_PENDING); changed = true; }
            // 装了新 APK 时 Capacitor 的 isNewBinary() 会把 serverBasePath 清空 → 此刻跑的是内置资源，
            // 热包版本记录必须归零，否则拒绝降级会把合法的包挡在门外。
            if (!version.isEmpty() && !hotDir(version).getAbsolutePath().equals(base)) {
                ed.remove(K_VERSION).remove(K_CODE);
                changed = true;
            }
        }
        if (changed) ed.apply();
    }

    /** 新包启动后若迟迟不 confirm（JS 没跑起来 = 白屏/崩溃），当次会话内直接回退并重载。 */
    private void armWatchdog() {
        final String pending = prefs().getString(K_PENDING, "");
        if (pending.isEmpty()) return;
        final Bridge bridge = getBridge();
        if (bridge == null) return;
        if (sWatchdog != null) sWatchdog.removeCallbacksAndMessages(null);
        final Handler h = new Handler(Looper.getMainLooper());
        sWatchdog = h;
        h.postDelayed(new Runnable() {
            @Override
            public void run() {
                try {
                    SharedPreferences sp = prefs();
                    if (!pending.equals(sp.getString(K_PENDING, ""))) return; // 已确认，正常
                    Log.w(TAG, "包 " + pending + " 启动超时未确认，回退");
                    sp.edit().remove(K_BASE_PATH).remove(K_PENDING).remove(K_VERSION)
                      .putInt(K_BOOTS, 0)
                      .putString(K_ROLLBACK, pending)
                      .putString(K_BLOCKED, pending).apply();
                    bridge.setServerAssetPath(Bridge.DEFAULT_WEB_ASSET_DIR); // 立即重载为内置资源
                } catch (Throwable t) {
                    Log.w(TAG, "回退失败", t);
                }
            }
        }, CONFIRM_TIMEOUT_MS);
    }

    /**
     * 前端在启动早期调用：确认当前热包能正常跑起来（本函数能被调用到，就说明它的 JS 起来了）。
     *
     * 注意这里除了「pref 指向 pending」还要核对**实际加载的目录**：万一 Capacitor 没采纳
     * serverBasePath（版本/系统差异），页面其实是从内置资源加载的——若此时照样确认，就会把一个
     * 根本没在运行的包标记为已确认，此后永远跑内置资源却显示热包版本号，回退机制也被绕过。
     * 核对实际目录后，这种情况会保持 pending → 看门狗/下次启动回退，并把该版本拉黑（有日志可查）。
     */
    @PluginMethod
    public void confirm(PluginCall call) {
        try {
            SharedPreferences sp = prefs();
            String pending = sp.getString(K_PENDING, "");
            String version = call.getString("version", pending);
            String served = servedPath();
            boolean servingPending = served == null
                ? hotDir(pending).getAbsolutePath().equals(sp.getString(K_BASE_PATH, ""))
                : served.equals(hotDir(pending).getAbsolutePath());
            boolean ok = !pending.isEmpty() && pending.equals(version) && servingPending;
            JSObject ret = new JSObject();
            ret.put("ok", ok);
            ret.put("serving", served == null ? "" : served);
            if (ok) {
                sp.edit().putString(K_VERSION, pending).putInt(K_BOOTS, 0).remove(K_PENDING).apply();
                if (sWatchdog != null) { sWatchdog.removeCallbacksAndMessages(null); sWatchdog = null; }
                // 确认成功后清掉更早的热包目录（保留当前这一个）
                pruneOldDirs(hotDir(pending));
            } else if (!pending.isEmpty()) {
                Log.w(TAG, "confirm 被拒：pending=" + pending + " serving=" + served);
            }
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    /**
     * 就地生效（APK 158 起）：把资源目录切到「已安装待生效」的那一版并重载页面，不必退出再打开。
     *
     * 为什么放在原生而不是让前端调 WebView 插件的 setServerBasePath：
     *   ① 目录只有原生算得准——当前跑 APK 内置资源时前端拿不到 filesDir，那条路只能提示"下次启动生效"；
     *   ② 切完必须 arm 看门狗：就地切换不走 Activity 启动路径，不 arm 的话新包起不来这一次会话没人回退
     *      （要等下一次冷启动 25 秒后才自愈）。
     * 安全性与冷启动完全一致：新包的 JS 仍要过 confirm，看门狗照常生效，失败自动回退并拉黑该版本。
     */
    @PluginMethod
    public void applyPending(PluginCall call) {
        try {
            SharedPreferences sp = prefs();
            String pending = sp.getString(K_PENDING, "");
            if (pending.isEmpty()) { call.reject("没有待生效的网页包"); return; }
            File dir = hotDir(pending);
            if (!new File(dir, "index.html").isFile()) { call.reject("待生效目录不完整，已忽略"); return; }
            Bridge b = getBridge();
            if (b == null) { call.reject("Bridge 未就绪"); return; }
            Log.d(TAG, "就地生效：切到 " + dir.getAbsolutePath());
            b.setServerBasePath(dir.getAbsolutePath());   // hostFiles + webView.loadUrl(appUrl)
            armWatchdog();                                 // 本次会话内也要能回退（见方法注释①）
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("version", pending);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    /** 前端启动时读一次状态：active = 正在运行的热包版本（空 = 内置资源）。 */
    @PluginMethod
    public void getState(PluginCall call) {
        try {
            SharedPreferences sp = prefs();
            String version = sp.getString(K_VERSION, "");
            String served = servedPath();
            String effective = served != null ? served : sp.getString(K_BASE_PATH, "");
            boolean onHot = !version.isEmpty() && hotDir(version).getAbsolutePath().equals(effective);
            JSObject ret = new JSObject();
            ret.put("active", onHot ? version : "");
            ret.put("pending", sp.getString(K_PENDING, ""));
            ret.put("code", onHot ? sp.getInt(K_CODE, 0) : 0);
            ret.put("blocked", sp.getString(K_BLOCKED, ""));
            ret.put("nativeCode", nativeVersionCode());
            // 实际加载的目录（排查用）：'public' = 内置资源；热包时为绝对路径
            ret.put("serving", served == null ? "" : served);
            ret.put("isAsset", served == null || !served.startsWith(hotRoot().getAbsolutePath()));
            // 回退事件读一次即清：前端负责把它展示给用户
            String rolled = sp.getString(K_ROLLBACK, "");
            if (!rolled.isEmpty()) { sp.edit().remove(K_ROLLBACK).apply(); ret.put("rolledBack", rolled); }
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    /** 手动清除回退黑名单（用户明确要重试某版本时用）。 */
    @PluginMethod
    public void clearBlocked(PluginCall call) {
        try {
            prefs().edit().remove(K_BLOCKED).apply();
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Throwable t) {
            call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
        }
    }

    // ===== 安装（下载 → 验签 → 解包 → 校验 → 原子替换 → 只写 pref，下次启动生效）=====

    @PluginMethod
    public void install(final PluginCall call) {
        final String serverBase = call.getString("serverBase", "");
        final String payloadB64 = call.getString("payload", "");
        final String sigB64 = call.getString("sig", "");
        if (serverBase.isEmpty() || payloadB64.isEmpty() || sigB64.isEmpty()) {
            call.reject("参数不完整");
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    JSObject ret = doInstall(serverBase, payloadB64, sigB64);
                    call.resolve(ret);
                } catch (HotBundleCore.BundleError e) {
                    call.reject("包校验失败：" + e.getMessage()); // 可疑内容 → 明确失败，不落盘
                } catch (Throwable t) {
                    call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
                }
            }
        }).start();
    }

    private JSObject doInstall(String serverBase, String payloadB64, String sigB64) throws Exception {
        byte[] payload = HotBundleCore.base64Decode(payloadB64);
        byte[] sig = HotBundleCore.base64Decode(sigB64);
        byte[] pub = HotBundleCore.base64Decode(PUBLIC_KEY_B64);

        // ① 验签：签名覆盖 payload 全部字节；此后只用 payload 里的值，HTTP 响应的其它字段一概不采信
        HotBundleCore.verifySignature(pub, payload, sig);

        List<HotBundleCore.FileEntry> files = new ArrayList<>();
        HotBundleCore.Meta meta = HotBundleCore.parsePayload(payload, files);
        if (files.isEmpty()) throw new HotBundleCore.BundleError("包内没有文件清单");

        // ② 版本门槛：不能要求比本机更新的原生能力；序号必须严格递增（拒绝降级重放）
        int nativeCode = nativeVersionCode();
        if (meta.minNative > nativeCode) {
            throw new HotBundleCore.BundleError("此包需要更新的 APK（" + meta.minNative + " > " + nativeCode + "）");
        }
        SharedPreferences sp = prefs();
        String served = servedPath();
        String base = served != null ? served : sp.getString(K_BASE_PATH, "");
        String running = sp.getString(K_VERSION, "");
        boolean onHot = !running.isEmpty() && hotDir(running).getAbsolutePath().equals(base);
        int activeCode = onHot ? sp.getInt(K_CODE, 0) : 0;
        if (meta.code <= activeCode) {
            throw new HotBundleCore.BundleError("不比当前版本新（" + meta.code + " ≤ " + activeCode + "）");
        }
        if (meta.v.equals(sp.getString(K_BLOCKED, ""))) {
            throw new HotBundleCore.BundleError("该版本曾启动失败，已跳过（可在设置里重试）");
        }

        // ③ 下载：URL 由「JS 给的服务器地址 + 验签后 payload 里的 zip 名」拼成——真正的完整性
        //    保证不是 URL 而是下面的 zip 哈希（与签名里的一致才解包），URL 被换也只会下载到废包。
        File dlDir = new File(getContext().getCacheDir(), "hot-bundle");
        HotBundleCore.deleteRecursive(dlDir);
        if (!dlDir.mkdirs() && !dlDir.isDirectory()) throw new IOException("无法建立下载目录");
        File zip = new File(dlDir, meta.zip);
        String url = trimSlash(serverBase) + "/web-bundle/" + java.net.URLEncoder.encode(meta.zip, "UTF-8");
        download(url, zip, HotBundleCore.MAX_ZIP_BYTES);
        String zipHash = HotBundleCore.sha256Hex(zip);
        if (!zipHash.equals(meta.zipSha256)) throw new HotBundleCore.BundleError("zip 哈希不符");

        // ④ 解包到临时目录（同名旧目录先清掉），再逐文件校验
        File hotRoot = hotRoot();
        if (!hotRoot.isDirectory() && !hotRoot.mkdirs()) throw new IOException("无法建立热包目录");
        File tmp = new File(getContext().getFilesDir(), "hot-tmp-" + meta.v);
        HotBundleCore.deleteRecursive(tmp);
        if (!tmp.mkdirs()) throw new IOException("无法建立临时目录");
        try {
            HotBundleCore.extractZip(zip, tmp);
            HotBundleCore.verifyTree(tmp, files);
            // ⑤ 与 APK 内置资源逐字节相同的文件（字体、version.json）不进包，这里从资源补齐
            int seeded = HotBundleCore.seedMissing(tmp, new AssetSource());
            HotBundleCore.requireIndex(tmp);
            Log.d(TAG, "解包完成：" + files.size() + " 个文件 + 资源补齐 " + seeded + " 个");

            // ⑥ 原子替换：同名目标先删，再 rename（同一文件系统内 rename 是原子的）
            File target = hotDir(meta.v);
            HotBundleCore.deleteRecursive(target);
            if (!tmp.renameTo(target)) throw new IOException("替换热包目录失败");
            pruneOldDirs(target, onHot ? hotDir(running) : null);

            // ⑦ 只写 pref：本次会话不动（用户可能正在写作），下次冷启动生效
            sp.edit()
              .putString(K_BASE_PATH, target.getAbsolutePath())
              .putString(K_PENDING, meta.v)
              .putInt(K_CODE, (int) meta.code)
              .putInt(K_BOOTS, 0)
              .apply();
            HotBundleCore.deleteRecursive(dlDir);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("version", meta.v);
            ret.put("code", meta.code);
            ret.put("files", files.size());
            ret.put("seeded", seeded);
            ret.put("useState", "nextLaunch");
            return ret;
        } catch (Throwable t) {
            HotBundleCore.deleteRecursive(tmp);
            throw t;
        }
    }

    /** 下载到文件并强制上限；不做重试（失败下次启动会再试）。 */
    private void download(String url, File target, long maxBytes) throws IOException, HotBundleCore.BundleError {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("User-Agent", "BQBHub-Android/1.0 (web-bundle)");
            conn.setInstanceFollowRedirects(true);
            conn.connect();
            int code = conn.getResponseCode();
            if (code != 200) throw new IOException("HTTP " + code);
            long declared = conn.getContentLengthLong();
            if (declared > maxBytes) throw new HotBundleCore.BundleError("包过大（" + declared + " 字节）");
            long total = 0;
            try (InputStream in = new BufferedInputStream(conn.getInputStream());
                 BufferedOutputStream os = new BufferedOutputStream(new FileOutputStream(target))) {
                byte[] buf = new byte[65536];
                int n;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > maxBytes) throw new HotBundleCore.BundleError("包超过上限");
                    os.write(buf, 0, n);
                }
            }
            if (total == 0) throw new IOException("空响应");
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    // ===== 路径与工具 =====

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, android.content.Context.MODE_PRIVATE);
    }

    private static String trimSlash(String s) {
        String out = s == null ? "" : s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        return out;
    }

    private File hotRoot() { return new File(getContext().getFilesDir(), "hot"); }

    private File hotDir(String version) { return new File(hotRoot(), version); }

    /**
     * 当前**实际**在加载的目录（Capacitor 的 localServer 视角）：'public' = APK 内置资源；
     * 热包生效时为 filesDir/hot/&lt;版本&gt; 的绝对路径。拿不到时返回 null（调用方退回按 pref 判断）。
     */
    private String servedPath() {
        try {
            Bridge b = getBridge();
            if (b == null) return null;
            String p = b.getServerBasePath();
            return (p == null || p.isEmpty()) ? null : p;
        } catch (Throwable t) {
            return null;
        }
    }

    private int nativeVersionCode() {
        try {
            PackageInfo pi = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            return (int) PackageInfoCompat.getLongVersionCode(pi);
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 删除热包目录下除 keep 之外的版本目录（安装/确认成功后调用，控制磁盘占用）。 */
    private void pruneOldDirs(File... keeps) {
        try {
            File[] kids = hotRoot().listFiles();
            if (kids != null) {
                for (File k : kids) {
                    if (!k.isDirectory()) continue;
                    boolean keepIt = false;
                    for (File keep : keeps) {
                        if (keep != null && k.getAbsolutePath().equals(keep.getAbsolutePath())) keepIt = true;
                    }
                    if (!keepIt) HotBundleCore.deleteRecursive(k);
                }
            }
            // 顺带清掉可能残留的临时目录
            File[] stale = getContext().getFilesDir().listFiles();
            if (stale != null) {
                for (File f : stale) {
                    if (f.isDirectory() && f.getName().startsWith("hot-tmp-")) HotBundleCore.deleteRecursive(f);
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "清理旧热包失败", t);
        }
    }

    /** APK 内置网页资源（assets/public）作为补齐来源。 */
    private final class AssetSource implements HotBundleCore.Source {
        private static final String ASSET_ROOT = Bridge.DEFAULT_WEB_ASSET_DIR; // "public"

        @Override
        public List<String> list() throws IOException {
            List<String> out = new ArrayList<>();
            walk(ASSET_ROOT, out);
            return out;
        }

        private void walk(String dir, List<String> out) throws IOException {
            String[] kids = getContext().getAssets().list(dir);
            if (kids == null) return;
            for (String k : kids) {
                String rel = dir + "/" + k;
                String[] sub = getContext().getAssets().list(rel);
                if (sub != null && sub.length > 0) walk(rel, out);
                else out.add(rel.substring(ASSET_ROOT.length() + 1));
            }
        }

        @Override
        public InputStream open(String rel) throws IOException {
            return getContext().getAssets().open(ASSET_ROOT + "/" + rel);
        }
    }
}
