package com.novelwriter.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 应用整包更新插件。
 * JS 侧通过 window.Capacitor.Plugins.UpdateChecker 调用：
 *   canRequestInstall()  → 是否已获得"安装未知来源应用"权限
 *   openInstallSettings() → 跳到系统设置开启该权限
 *   download({url})       → 后台下载 APK（进度事件 downloadProgress），完成后拉起系统安装器
 */
@CapacitorPlugin(name = "UpdateChecker")
public class UpdateCheckerPlugin extends Plugin {

    private static final String FILE_PROVIDER = ".fileprovider";
    private static final String APK_NAME = "novel-writer-update.apk";
    private static final String TAG = "UpdateCheckerPlugin";
    // 进度通道：下载线程只更新 volatile 字段；主线程 Handler 每 200ms 节流上报
    //（此前子线程直接 notifyListeners 的中途事件丢失，改为标准主线程路由）
    private volatile long progReceived = 0;
    private volatile long progTotal = -1;
    private long lastReported = -1;
    private Handler progHandler = null;
    private Runnable progPoller = null;

    @PluginMethod
    public void canRequestInstall(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ret.put("granted", getContext().getPackageManager().canRequestPackageInstalls());
            } else {
                ret.put("granted", true); // Android 8.0 以下无此限制
            }
        } catch (Throwable t) {
            ret.put("granted", true); // 查询失败时按已授权处理，让流程继续
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Throwable t) {
            // 部分国产 ROM 无此入口，忽略
        }
        call.resolve();
    }

    @PluginMethod
    public void download(PluginCall call) {
        final String url = call.getString("url");
        if (url == null || url.isEmpty()) { call.reject("url required"); return; }

        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                try {
                    // 下载到内部缓存目录：FileProvider 的 cache-path 在所有 API 级别都可分享，
                    // 不踩 Android 11+ 对 Android/data 的访问限制（getExternalFilesDir 是知名坑）
                    File dir = new File(getContext().getCacheDir(), "apk-download");
                    if (!dir.exists()) dir.mkdirs();
                    File[] olds = dir.listFiles();
                    if (olds != null) {
                        for (File f : olds) {
                            if (f.getName().endsWith(".apk")) f.delete();
                        }
                    }
                    File target = new File(dir, APK_NAME);

                    URL u = new URL(url);
                    conn = (HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    conn.setRequestProperty("User-Agent", "novel-writer-updater");
                    conn.connect();
                    int code = conn.getResponseCode();
                    if (code != 200) { call.reject("HTTP " + code); return; }

                    long total = conn.getContentLengthLong();
                    Log.d(TAG, "download start, total=" + total);
                    progTotal = total;
                    lastReported = -1;
                    startProgressPoller();

                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(target);
                    byte[] buf = new byte[16384];
                    long done = 0;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        out.write(buf, 0, n);
                        done += n;
                        progReceived = done; // 子线程只更新 volatile；上报由主线程 poller 节流完成
                    }
                    out.flush(); out.close(); in.close();
                    conn.disconnect();
                    stopProgressPoller();

                    // 结束帧：主线程补发 100%（确保 JS 一定见到完成态）
                    final long finalDone = done;
                    new Handler(Looper.getMainLooper()).post(new Runnable() {
                        @Override
                        public void run() {
                            JSObject data = progressObject(finalDone, finalDone);
                            notifyListeners("downloadProgress", data);
                        }
                    });
                    Log.d(TAG, "download done, bytes=" + finalDone);
                    if (!installApk(target)) {
                        call.reject("无法打开安装界面，请到文件管理器手动安装");
                        return;
                    }
                    JSObject ret = new JSObject();
                    ret.put("ok", true);
                    ret.put("path", target.getAbsolutePath());
                    call.resolve(ret);
                } catch (Throwable t) {
                    // 捕获所有异常/错误（含 FileProvider、线程问题），一律走 reject 而不是让进程崩掉
                    stopProgressPoller();
                    call.reject(t.getMessage() == null ? t.toString() : t.getMessage());
                }
            }
        }).start();
    }

    private JSObject progressObject(long received, long total) {
        JSObject data = new JSObject();
        data.put("received", received);
        data.put("total", total);
        return data;
    }

    // 主线程节流上报：每 200ms 检查 volatile 进度，有变化才 notify（标准主线程路由）
    private void startProgressPoller() {
        if (progHandler != null) return;
        progHandler = new Handler(Looper.getMainLooper());
        progPoller = new Runnable() {
            @Override
            public void run() {
                long r = progReceived;
                if (r != lastReported) {
                    lastReported = r;
                    notifyListeners("downloadProgress", progressObject(r, progTotal));
                    Log.d(TAG, "notify " + r + "/" + progTotal);
                }
                if (progHandler != null) progHandler.postDelayed(this, 200);
            }
        };
        progHandler.post(progPoller);
    }

    private void stopProgressPoller() {
        if (progHandler != null) {
            progHandler.removeCallbacks(progPoller);
            progHandler = null;
            progPoller = null;
        }
    }

    private boolean installApk(File apk) {
        try {
            Uri uri = FileProvider.getUriForFile(getContext(),
                    getContext().getPackageName() + FILE_PROVIDER, apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            return true;
        } catch (ActivityNotFoundException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }
}