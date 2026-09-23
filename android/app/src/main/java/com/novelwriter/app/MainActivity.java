package com.novelwriter.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private LocalProxyServer proxyServer;

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

    @Override
    public void onDestroy() {
        if (proxyServer != null) proxyServer.stop();
        super.onDestroy();
    }
}
