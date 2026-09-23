// 指令生成客户端：commandcode provider（OpenAI 兼容 /chat/completions）+ 磁盘缓存。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../.cache');

export const CC_BASE = process.env.CC_BASE || 'https://api.commandcode.ai/provider/v1';
export const CC_MODEL = process.env.CC_MODEL || 'deepseek/deepseek-v4.1-flash';
const CC_KEY = process.env.CC_KEY || '';

export const llmStats = { calls: 0, cacheHits: 0, retries: 0, empty: 0 };

function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }

let cache: Record<string, any> | null = null;
let dirty = false;
function cachePath(): string { return path.join(CACHE_DIR, 'instr-gen-' + CC_MODEL.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json'); }
function loadCache(): Record<string, any> {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(cachePath(), 'utf8')); } catch (e) { cache = {}; }
  return cache!;
}

/** 调一次 chat，返回解析出的 JSON（要求模型只输出 JSON；失败时从 reasoning 里兜底抽取） */
export async function chatJSON(system: string, user: string, opts?: { temperature?: number; maxTokens?: number }): Promise<any> {
  const c = loadCache();
  const key = sha1(CC_MODEL + '\u0001' + system + '\u0001' + user);
  if (c[key]) { llmStats.cacheHits++; return c[key]; }
  // 推理模型会先"想"很久：token 预算给小了 content 会空（finish=length）→ 逐次加倍重试
  let maxTokens = opts?.maxTokens ?? 2500;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = {
      model: CC_MODEL,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: opts?.temperature ?? 0.95,
      max_tokens: maxTokens,
    };
    try {
      const res = await fetch(CC_BASE + '/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + CC_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 160));
      const j: any = await res.json();
      llmStats.calls++;
      const finish = j?.choices?.[0]?.finish_reason;
      if (finish === 'length') maxTokens = Math.min(12000, maxTokens * 2);
      const msg = j?.choices?.[0]?.message || {};
      const text = String(msg.content || '');
      const candidate = text || String(msg.reasoning || '');
      if (process.env.CC_DEBUG === '1') {
        console.log('[llm-dbg] finish=', j?.choices?.[0]?.finish_reason, '| content=', JSON.stringify(text.slice(0, 300)), '| reasoning=', JSON.stringify(String(msg.reasoning || '').slice(0, 300)), '| keys=', Object.keys(msg).join(','));
      }
      const parsed = extractJSON(candidate);
      if (parsed) { c[key] = parsed; dirty = true; fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(cachePath(), JSON.stringify(c)); return parsed; }
      llmStats.empty++;
      throw new Error('未解析出 JSON');
    } catch (e: any) {
      llmStats.retries++;
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, [1200, 4000][attempt]));
    }
  }
  return null;
}

function extractJSON(s: string): any | null {
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const src = fence ? fence[1] : s;
  const start = src.indexOf('{');
  if (start < 0) return null;
  for (let end = src.lastIndexOf('}'); end > start; end = src.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(src.slice(start, end + 1)); } catch (e) { /* 继续缩 */ }
  }
  return null;
}
