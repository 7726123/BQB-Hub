// SiliconFlow 客户端：embedding / rerank，带磁盘缓存 + 重试 + 调用计数。
// key 只从环境变量 SILICONFLOW_KEY 读（不落盘、不进代码）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(HERE, '../.cache');

export const API_BASE = process.env.SILICONFLOW_BASE || 'https://api.siliconflow.cn/v1';
export const EMB_MODEL = process.env.EMB_MODEL || 'BAAI/bge-m3';
export const RR_MODEL = process.env.RR_MODEL || 'BAAI/bge-reranker-v2-m3';

const KEY = process.env.SILICONFLOW_KEY || '';

export const apiStats = { embedCalls: 0, rerankCalls: 0, cacheHits: 0, retries: 0, errors: 0 };

function sha1(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex');
}

function loadCache<T>(name: string): Record<string, T> {
  try {
    const p = path.join(CACHE_DIR, name);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { /* 缓存损坏则重建 */ }
  return {};
}
function saveCache(name: string, data: unknown): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(data));
}

const EMB_CACHE_FILE = 'emb-' + EMB_MODEL.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
const RR_CACHE_FILE = 'rerank-' + RR_MODEL.replace(/[^a-zA-Z0-9._-]/g, '_') + '.json';
let embCache: Record<string, number[]> | null = null;
let rrCache: Record<string, number> | null = null;
let embDirty = false;
let rrDirty = false;

async function postJSON(url: string, body: unknown, timeoutMs = 120000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = await res.text();
    let j: any = null;
    try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
    if (!res.ok) {
      const err: any = new Error('HTTP ' + res.status + ' ' + (j && j.message ? j.message : txt.slice(0, 200)));
      err.status = res.status;
      throw err;
    }
    return j;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: any = null;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (e: any) {
      last = e;
      apiStats.errors++;
      const retriable = !e.status || e.status === 429 || e.status >= 500;
      if (!retriable) throw e;
      apiStats.retries++;
      const wait = [1000, 3000, 8000, 15000][Math.min(i, 3)];
      console.log('[api] ' + label + ' 失败（' + (e.message || e) + '），' + wait + 'ms 后重试');
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw last;
}

/** 批量 embedding：命中缓存的不发请求；返回与输入等长的向量数组 */
export async function embedTexts(texts: string[], batchSize = 16): Promise<number[][]> {
  if (!embCache) embCache = loadCache<number[]>(EMB_CACHE_FILE);
  const out: (number[] | null)[] = texts.map(t => embCache![EMB_MODEL + '\u0001' + sha1(t)] ?? null);
  const todo: number[] = [];
  out.forEach((v, i) => { if (!v) todo.push(i); else apiStats.cacheHits++; });
  for (let i = 0; i < todo.length; i += batchSize) {
    const idxs = todo.slice(i, i + batchSize);
    const inputs = idxs.map(k => texts[k]);
    const j = await withRetry('embed', () => postJSON(API_BASE + '/embeddings', {
      model: EMB_MODEL, input: inputs, encoding_format: 'float',
    }));
    apiStats.embedCalls++;
    const data = (j && j.data) || [];
    if (data.length !== inputs.length) throw new Error('embedding 返回条数不匹配: ' + data.length + ' != ' + inputs.length);
    idxs.forEach((k, n) => {
      const vec = data[n].embedding as number[];
      out[k] = vec;
      embCache![EMB_MODEL + '\u0001' + sha1(texts[k])] = vec;
      embDirty = true;
    });
    if ((i / batchSize) % 10 === 0) console.log('[api] embed 进度 ' + Math.min(i + batchSize, todo.length) + '/' + todo.length);
  }
  if (embDirty) { saveCache(EMB_CACHE_FILE, embCache); embDirty = false; }
  return out as number[][];
}

/** 单查询对多文档 rerank：返回与 docs 对齐的分数（缺失为 -Infinity） */
export async function rerankScores(query: string, docs: string[], topN?: number): Promise<number[]> {
  if (!rrCache) rrCache = loadCache<number>(RR_CACHE_FILE);
  const keys = docs.map(d => RR_MODEL + '\u0001' + sha1(query) + '\u0001' + sha1(d));
  const scores: number[] = keys.map(k => (k in rrCache! ? rrCache![k] : NaN));
  const missing = keys.map((k, i) => (isNaN(scores[i]) ? i : -1)).filter(i => i >= 0);
  if (missing.length > 0) {
    const j = await withRetry('rerank', () => postJSON(API_BASE + '/rerank', {
      model: RR_MODEL, query, documents: docs, top_n: topN ?? docs.length, return_documents: false,
    }));
    apiStats.rerankCalls++;
    const results = (j && j.results) || [];
    results.forEach((r: any) => {
      const i = Number(r.index);
      if (i >= 0 && i < keys.length) { scores[i] = Number(r.relevance_score); rrCache![keys[i]] = scores[i]; rrDirty = true; }
    });
  } else {
    apiStats.cacheHits += docs.length;
  }
  if (rrDirty) { saveCache(RR_CACHE_FILE, rrCache); rrDirty = false; }
  return scores;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export function flushApiStats(label: string): void {
  console.log('[' + label + '] API: embed ' + apiStats.embedCalls + ' 次 / rerank ' + apiStats.rerankCalls + ' 次 / 缓存命中 ' + apiStats.cacheHits + ' / 重试 ' + apiStats.retries + ' / 错误 ' + apiStats.errors);
}
