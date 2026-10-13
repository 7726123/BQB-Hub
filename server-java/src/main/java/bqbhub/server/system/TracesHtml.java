package bqbhub.server.system;

import bqbhub.server.Validators;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.util.List;
import java.util.Map;

/**
 * 留档的 HTML 视图（原 SystemController.tracesHtml 整段搬移，输出逐字不变）：
 * 给服务器上直接看 `?format=html` 的人用，所有插值都走 escapeHtml。
 */
final class TracesHtml {

    private static final ObjectMapper JSON = new ObjectMapper();

    private TracesHtml() {
    }

    static String render(List<Map<String, Object>> rows) {
        StringBuilder sb = new StringBuilder();
        sb.append("<!doctype html><meta charset=\"utf-8\"><title>管理员模式留档</title>")
                .append("<body style=\"font-family:-apple-system,Microsoft YaHei,sans-serif;max-width:920px;margin:20px auto;padding:0 14px\">")
                .append("<h2>管理员模式留档（最近 ").append(rows.size()).append(" 条）</h2>")
                .append("<p style=\"color:#666;font-size:13px\">读取/清空需 adminKey；写入由 App 在管理员模式下自动完成。")
                .append("加 <code>&amp;format=json</code> 可取原始 JSON。</p>");
        for (Map<String, Object> r : rows) {
            StringBuilder pieces = new StringBuilder();
            int recallCount = 0;
            long recallChars = 0;
            Object candidates = null;
            try {
                JsonNode recall = JSON.readTree(Validators.str(r.get("recall_json")));
                JsonNode arr = recall.path("pieces");
                recallCount = arr.isArray() ? arr.size() : 0;
                recallChars = recall.path("chars").asLong(0);
                candidates = recall.hasNonNull("candidates") ? recall.get("candidates").asLong() : null;
                int i = 0;
                for (JsonNode p : arr) {
                    i++;
                    pieces.append("<li><b>[").append(i).append("]</b> ")
                            .append(escapeHtml(Validators.cut(p.path("head").asText(""), 120)))
                            .append(" … <span style=\"color:#888\">(").append(p.path("chars").asLong(0)).append(" 字")
                            .append(p.path("src").asText("").isEmpty() ? "" : "｜" + escapeHtml(p.path("src").asText("")))
                            .append(")</span></li>");
                }
            } catch (Exception e) { /* recall 解析失败就按空处理 */ }
            sb.append("<section style=\"border:1px solid #ddd;border-radius:8px;padding:10px 14px;margin:12px 0\">")
                    .append("<div style=\"color:#666;font-size:13px\">#").append(r.get("id")).append(" · ")
                    .append(new java.util.Date(((Number) r.get("ts")).longValue()).toString())
                    .append(" · 书：").append(escapeHtml(Validators.str(r.get("book"))))
                    .append(" · 第 ").append(r.get("round")).append(" 轮 · 模型 ").append(escapeHtml(Validators.str(r.get("model"))))
                    .append(" · 窗口 ").append(r.get("window_chars")).append(" 字 · 回读预算 ").append(r.get("budget")).append(" 字</div>")
                    .append("<div style=\"margin:6px 0\"><b>指令：</b>")
                    .append(escapeHtml(Validators.str(r.get("instruction"))).isEmpty() ? "<i>（无）</i>" : escapeHtml(Validators.str(r.get("instruction"))))
                    .append("</div>")
                    .append("<div style=\"margin:6px 0\"><b>记忆召回（").append(recallCount).append(" 段 / ").append(recallChars).append(" 字")
                    .append(candidates == null ? "" : "，候选 " + candidates).append("）：</b><ul style=\"margin:4px 0 4px 18px;padding:0\">")
                    .append(pieces.length() == 0 ? "<li><i>无</i></li>" : pieces).append("</ul></div>")
                    .append("<details><summary style=\"cursor:pointer\"><b>续写正文</b></summary><pre style=\"white-space:pre-wrap;font-family:inherit\">")
                    .append(escapeHtml(Validators.str(r.get("continuation")))).append("</pre></details></section>");
        }
        if (rows.isEmpty()) sb.append("<p><i>暂无数据</i></p>");
        return sb.append("</body>").toString();
    }

    private static String escapeHtml(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        for (char c : s.toCharArray()) {
            switch (c) {
                case '&' -> sb.append("&amp;");
                case '<' -> sb.append("&lt;");
                case '>' -> sb.append("&gt;");
                case '"' -> sb.append("&quot;");
                default -> sb.append(c);
            }
        }
        return sb.toString();
    }
}
