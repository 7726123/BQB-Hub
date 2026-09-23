// 端点地址归一化（纯函数，api.ts 与 app.ts 共用）。
//
// 背景：用户经常把文档里的**完整请求地址**直接粘进「API 地址」——各家样例多是
// `https://host/v1/chat/completions`，甚至有 Ollama 的 `http://host:11434/api/chat`；
// 而本软件约定填到 `/v1` 为止，拼接时会变成 `.../chat/completions/chat/completions` → 404。
// 这里统一兜住，规则按"确定无害"取舍：
//   1) 剔除不可见字符 / 空白 / 全角冒号——粘贴常见，会让 fetch 直接抛 Failed to parse URL；
//   2) 去掉结尾多余斜杠；
//   3) 把误粘的接口后缀退回基址：/chat/completions、/completions、/models、/responses、/messages；
//   4) Ollama 原生入口（/api/chat、/api/tags 等）→ 换成它的 OpenAI 兼容基址 /v1；
//   5) 查询串（如 Azure 的 ?api-version=）先摘出来，路径处理后原样接回，且拼接时插在 ? 之前。
//
// 刻意**不**做：给空路径自动补 /v1（自建网关把服务挂在根路径的场景会被误伤，
// 那类用户填的就是完整基址）。也不动 /v1beta/openai 这类正确基址。
const _INVISIBLE = /[\u200b-\u200d\u2060\ufeff]/g;
const _SUFFIXES = ['/chat/completions', '/completions', '/models', '/responses', '/messages'];
const _OLLAMA_NATIVE = /\/api\/(chat|tags|generate|embeddings|show|ps)$/i;

export function sanitizeEndpointUrl(raw: unknown): string {
  const s = String(raw ?? '')
    .replace(_INVISIBLE, '')
    .replace(/\s+/g, '')
    .replace(/：/g, ':');
  if (!s) return '';
  const qi = s.search(/[?#]/);
  const head = qi < 0 ? s : s.slice(0, qi);
  const tail = qi < 0 ? '' : s.slice(qi);
  let path = head.replace(/\/+$/, '');
  if (_OLLAMA_NATIVE.test(path)) {
    path = path.replace(/\/api\/[^/]+$/i, '/v1');
  } else {
    const lower = path.toLowerCase();
    for (const suf of _SUFFIXES) {
      if (lower.endsWith(suf)) { path = path.slice(0, path.length - suf.length); break; }
    }
    path = path.replace(/\/+$/, '');
  }
  return (path || head) + tail;   // 极端情况（用户只填了 "/chat/completions"）回退原串，不返回空
}

// 在基址后拼接口路径：查询串永远留在末尾（`...?api-version=1` 不能被拼坏）
function _joinPath(base: string, suffix: string): string {
  if (!base) return '';
  const qi = base.search(/[?#]/);
  if (qi < 0) return base.replace(/\/+$/, '') + suffix;
  return base.slice(0, qi).replace(/\/+$/, '') + suffix + base.slice(qi);
}

export function chatCompletionsUrl(endpoint: unknown): string {
  return _joinPath(sanitizeEndpointUrl(endpoint), '/chat/completions');
}

export function modelsUrl(endpoint: unknown): string {
  return _joinPath(sanitizeEndpointUrl(endpoint), '/models');
}
