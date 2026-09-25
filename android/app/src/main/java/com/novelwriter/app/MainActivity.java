package com.novelwriter.app;

import android.os.Bundle;
import android.view.ActionMode;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private LocalProxyServer proxyServer;
    // 网页端按需开关：手指落在写卡消息区时置 true（那一处的长按只要应用自己的浮条，
    // 不要系统的「复制/全选」菜单）；落在网页输入框等其它地方时置 false（粘贴菜单要留着）。
    private volatile boolean suppressSelectionMenu = false;

    /**
     * 原生能力探针（给网页端做特性检测 + 按需屏蔽系统选区菜单）。
     * canSelectText()：本 APK 支持"保留选区、屏蔽系统菜单" → 网页端可以放开文本选择
     * （长按选中整条后拖手柄选一段，复制走应用自己的浮条）。老 APK 没有这个对象，
     * 网页端会保持"消息区不可选"，避免系统复制菜单和应用浮条一起冒出来。
     * setSuppressSystemMenu(on)：网页端按触摸位置实时开关（见 cardwriter.ts init）。
     */
    public class NativeFeatures {
        @JavascriptInterface
        public boolean canSelectText() { return true; }

        @JavascriptInterface
        public void setSuppressSystemMenu(boolean on) { suppressSelectionMenu = on; }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(UpdateCheckerPlugin.class); // 整包更新插件
        registerPlugin(HotBundlePlugin.class);     // 网页包热更新（验签 / 回退 / 换资源目录）
        super.onCreate(savedInstanceState);
        // === 原始版本的逻辑，保持不变 ===
        getBridge().getWebView().addJavascriptInterface(
            new HttpBridge(getApplicationContext()), "HttpBridge");

        // === 仅追加：coding plan 适配用的本地代理 ===
        final WebView wv = getBridge().getWebView();
        // 允许 fetch http://127.0.0.1（相对 capacitor 的 https origin 属于混合内容）
        wv.getSettings().setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // 原生能力探针（见 NativeFeatures）：网页端据此决定"消息区是否可选中"、以及何时屏蔽系统菜单
        wv.addJavascriptInterface(new NativeFeatures(), "NativeFeatures");

        proxyServer = new LocalProxyServer();
        proxyServer.start(new LocalProxyServer.Callback() {
            @Override public void onStarted(final int port) {
                wv.post(new Runnable() {
                    @Override public void run() {
                        // 同时写入 localStorage：页面内 reload（非 Activity 重建）不会重新走
                        // onCreate，注入的 window.__PROXY_PORT__ 会丢，导致 API 请求绕过本地
                        // 代理直连——遇到方舟 coding 这类 CORS 不放行 Authorization 的端点
                        // 就会报「网络错误」。onCreate 每次都会覆盖为最新端口，不会留下死端口。
                        wv.evaluateJavascript(
                            "window.__PROXY_PORT__=" + port + ";"
                            + "try{localStorage.setItem('__proxyPort',String(" + port + "));}catch(e){}", null);
                    }
                });
            }
            @Override public void onError(String message) {}
        });
    }

    // 屏蔽系统选区菜单（那条「复制/全选/搜索」浮动工具条）：只在网页端要求时（suppressSelectionMenu）
    // 返回 null = 不创建 ActionMode → 选区与两头手柄保留，复制/全选交给应用自己的浮条
    // （写卡页长按 → 复制/删除/多选；拖动可改范围）。网页输入框上的长按不受影响（那时网页端会把开关关掉）。
    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback) {
        if (shouldSuppressSelectionMenu()) return null;
        return super.onWindowStartingActionMode(callback);
    }

    @Override
    public ActionMode onWindowStartingActionMode(ActionMode.Callback callback, int type) {
        if (shouldSuppressSelectionMenu()) return null;
        return super.onWindowStartingActionMode(callback, type);
    }

    private boolean shouldSuppressSelectionMenu() {
        if (!suppressSelectionMenu) return false;
        View focus = getCurrentFocus();
        return focus instanceof WebView;   // 只压 WebView 里的网页选区
    }

    @Override
    public void onDestroy() {
        if (proxyServer != null) proxyServer.stop();
        super.onDestroy();
    }
}
