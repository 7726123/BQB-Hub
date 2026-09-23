package com.novelwriter.app;

import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.webkit.JavascriptInterface;
import androidx.core.content.FileProvider;
import org.json.JSONObject;
import java.io.*;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Iterator;

public class HttpBridge {
    private final Context context;

    public HttpBridge(Context context) {
        this.context = context;
    }

    @JavascriptInterface
    public String post(String urlStr, String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL(urlStr);
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(30000);
            conn.setReadTimeout(120000);
            conn.setDoOutput(true);

            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject headers = new JSONObject(headersJson);
                Iterator<String> keys = headers.keys();
                while (keys.hasNext()) {
                    String key = keys.next();
                    conn.setRequestProperty(key, headers.getString(key));
                }
            }

            if (body != null) {
                OutputStream os = conn.getOutputStream();
                os.write(body.getBytes("UTF-8"));
                os.flush();
                os.close();
            }

            int status = conn.getResponseCode();
            InputStream is = (status >= 200 && status < 300) ? conn.getInputStream() : conn.getErrorStream();
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, "UTF-8"));
            StringBuilder response = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                response.append(line).append("\n");
            }
            reader.close();

            JSONObject result = new JSONObject();
            result.put("status", status);
            result.put("body", response.toString().trim());
            return result.toString();
        } catch (Exception e) {
            try {
                JSONObject err = new JSONObject();
                err.put("status", 0);
                err.put("body", "{\"error\":{\"message\":\"" + e.getMessage() + "\",\"type\":\"network_error\"}}");
                return err.toString();
            } catch (Exception ex) {
                return "{\"status\":0,\"body\":\"{\\\"error\\\":{\\\"message\\\":\\\"" + e.getMessage() + "\\\"}}\"}";
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    @JavascriptInterface
    public String saveFile(String filename, String content, String mimeType) {
        try {
            String safeName = filename == null ? "" : filename.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (safeName.isEmpty()) safeName = "export.json";
            byte[] data = content.getBytes("UTF-8");
            String mime = (mimeType == null || mimeType.isEmpty()) ? "application/octet-stream" : mimeType;

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // Android 10+：通过 MediaStore 存到系统"下载"文件夹，无需任何权限
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, safeName);
                values.put(MediaStore.Downloads.MIME_TYPE, mime);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                ContentResolver resolver = context.getContentResolver();
                Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                if (uri == null) throw new IOException("MediaStore insert failed");
                OutputStream os = resolver.openOutputStream(uri);
                os.write(data);
                os.flush();
                os.close();
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                resolver.update(uri, values, null, null);
                return new JSONObject().put("ok", true).put("path", "下载/" + safeName).toString();
            } else {
                // 旧系统：写应用外部目录（无需权限），返回完整路径
                File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dir == null) dir = new File(context.getFilesDir(), "downloads");
                if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed");
                File f = new File(dir, safeName);
                FileOutputStream fos = new FileOutputStream(f);
                fos.write(data);
                fos.flush();
                fos.close();
                return new JSONObject().put("ok", true).put("path", f.getAbsolutePath()).toString();
            }
        } catch (Exception e) {
            try {
                return new JSONObject().put("ok", false).put("error", String.valueOf(e.getMessage())).toString();
            } catch (Exception ex) {
                return "{\"ok\":false,\"error\":\"unknown\"}";
            }
        }
    }

    @JavascriptInterface
    public String shareFile(String filename, String content, String mimeType) {
        try {
            String safeName = filename == null ? "" : filename.replaceAll("[\\\\/:*?\"<>|]", "_");
            if (safeName.isEmpty()) safeName = "share.json";
            String mime = (mimeType == null || mimeType.isEmpty()) ? "text/plain" : mimeType;
            byte[] data = content.getBytes("UTF-8");

            File dir = context.getCacheDir();
            if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed");
            File file = new File(dir, safeName);
            FileOutputStream fos = new FileOutputStream(file);
            fos.write(data);
            fos.flush();
            fos.close();

            final Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            final String shareMime = mime;
            final Intent inner = new Intent(Intent.ACTION_SEND);
            inner.setType(shareMime);
            inner.putExtra(Intent.EXTRA_STREAM, uri);
            inner.setClipData(ClipData.newRawUri(null, uri));
            inner.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            // @JavascriptInterface 跑在后台线程，startActivity 必须在主线程
            Handler main = new Handler(Looper.getMainLooper());
            main.post(new Runnable() {
                @Override public void run() {
                    try {
                        Intent chooser = Intent.createChooser(inner, "分享到");
                        chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        context.startActivity(chooser);
                    } catch (Exception e) { /* 无可用分享目标时静默 */ }
                }
            });
            return new JSONObject().put("ok", true).toString();
        } catch (Exception e) {
            try {
                return new JSONObject().put("ok", false).put("error", String.valueOf(e.getMessage())).toString();
            } catch (Exception ex) {
                return "{\"ok\":false,\"error\":\"unknown\"}";
            }
        }
    }
}
