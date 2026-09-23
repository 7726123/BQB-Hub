// 端点地址归一化：用户经常把文档里的**完整请求地址**直接粘进「API 地址」，
// 而本软件约定填到 /v1 为止 —— 以前会拼成 .../chat/completions/chat/completions（404）。
// 这里锁住归一化规则、两个 URL 构造器、以及"请求真的只带一次接口后缀"（fetch 收到的 URL）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import '../src/infra/storage';
import '../src/domain/preset';
import '../src/domain/modelcompat';
import '../src/domain/api';
import { sanitizeEndpointUrl, chatCompletionsUrl, modelsUrl } from '../src/lib/endpoint';

// 真实 App（sanitizeEndpoint 在 app 模块里；import 时挂到 globalThis）
await import('../src/domain/app');

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
const API = (globalThis as unknown as { APIHandler: typeof import('../src/domain/api').APIHandler }).APIHandler;
const App = (globalThis as unknown as { App: { sanitizeEndpoint: (r: unknown) => string; toast: () => void; getPricingConfig: () => unknown } }).App;

// 只补测试需要的桩，不整体替换 App（否则会把被测的 sanitizeEndpoint 一起冲掉）
App.toast = () => {};
App.getPricingConfig = () => ({ input: 1, cached: 0.1, output: 2 });

function sse(frames: (object | string)[]): Response {
  const chunks = frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`);
  const enc = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(c) { chunks.forEach((x) => c.enqueue(enc.encode(x))); c.close(); }
  }), { status: 200 });
}

describe('端点归一化（sanitizeEndpointUrl）', () => {
  it('剔除不可见字符 / 空白 / 全角冒号（粘贴常见，会让 fetch 直接抛错）', () => {
    expect(sanitizeEndpointUrl(' https://api.deepseek.com/v1 ')).toBe('https://api.deepseek.com/v1');
    expect(sanitizeEndpointUrl('https：//api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(sanitizeEndpointUrl('https://api.deep\u200bseek.com/v1')).toBe('https://api.deepseek.com/v1');
    expect(sanitizeEndpointUrl('https://api.deepseek.com\n/v1')).toBe('https://api.deepseek.com/v1');
  });

  it('去掉结尾斜杠，但对正确的 /v1 基址原样保留', () => {
    expect(sanitizeEndpointUrl('https://x/v1/')).toBe('https://x/v1');
    expect(sanitizeEndpointUrl('https://x/v1')).toBe('https://x/v1');
    expect(sanitizeEndpointUrl('https://generativelanguage.googleapis.com/v1beta/openai')).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(sanitizeEndpointUrl('https://x/openai/v1')).toBe('https://x/openai/v1');
  });

  it('误粘的接口后缀退回基址（本次修复的主因）', () => {
    expect(sanitizeEndpointUrl('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1');
    expect(sanitizeEndpointUrl('https://api.deepseek.com/v1/models')).toBe('https://api.deepseek.com/v1');
    expect(sanitizeEndpointUrl('https://api.openai.com/v1/responses')).toBe('https://api.openai.com/v1');
    expect(sanitizeEndpointUrl('https://api.anthropic.com/v1/messages')).toBe('https://api.anthropic.com/v1');
    expect(sanitizeEndpointUrl('https://x/v1/completions/')).toBe('https://x/v1');
    expect(sanitizeEndpointUrl('https://x/v1/CHAT/COMPLETIONS')).toBe('https://x/v1');   // 大小写不敏感
  });

  it('Ollama 原生入口 → 它的 OpenAI 兼容基址 /v1', () => {
    expect(sanitizeEndpointUrl('http://127.0.0.1:11434/api/chat')).toBe('http://127.0.0.1:11434/v1');
    expect(sanitizeEndpointUrl('http://192.168.1.5:11434/api/tags')).toBe('http://192.168.1.5:11434/v1');
  });

  it('查询串不能丢：拼接时路径插在 ? 之前（Azure 的 ?api-version= 这类）', () => {
    expect(sanitizeEndpointUrl('https://x.openai.azure.com/openai/v1?api-version=2024-10-21')).toBe('https://x.openai.azure.com/openai/v1?api-version=2024-10-21');
    expect(chatCompletionsUrl('https://x.openai.azure.com/openai/v1?api-version=2024-10-21'))
      .toBe('https://x.openai.azure.com/openai/v1/chat/completions?api-version=2024-10-21');
  });

  it('空值 / 只填后缀的极端输入不返回空串', () => {
    expect(sanitizeEndpointUrl('')).toBe('');
    expect(sanitizeEndpointUrl(undefined)).toBe('');
    expect(sanitizeEndpointUrl('/chat/completions')).toBe('/chat/completions');   // 回退原串，不返回空
  });
});

describe('URL 构造器', () => {
  it('粘完整请求地址也只拼一次后缀', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com/v1/chat/completions')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(modelsUrl('https://api.deepseek.com/v1/models')).toBe('https://api.deepseek.com/v1/models');
    expect(chatCompletionsUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(modelsUrl('')).toBe('');
  });

  it('App.sanitizeEndpoint 与 lib 是同一套逻辑（不再各写一份）', () => {
    expect(App.sanitizeEndpoint('https://x/v1/chat/completions ')).toBe('https://x/v1');
    expect(App.sanitizeEndpoint('http://127.0.0.1:11434/api/chat')).toBe('http://127.0.0.1:11434/v1');
  });
});

describe('请求链路：粘完整地址不会拼坏（回归 v1.5.97.12）', () => {
  beforeEach(() => {
    API._apiCalls = [];
    API.abortController = null;
  });

  it('fetchCompletions：请求地址只带一次 /chat/completions', async () => {
    const calls: string[] = [];
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      return sse([{ choices: [{ delta: { content: '好' } }] }, '[DONE]']);
    });
    sm().set('apiConfig', { endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: 'k', model: 'm' });
    await API.fetchCompletions([{ role: 'user', content: 'hi' }], () => {}, () => {}, () => {});
    expect(calls[0]).toBe('https://api.deepseek.com/v1/chat/completions');
  });

  it('fetchModels：请求地址只带一次 /models', async () => {
    const calls: string[] = [];
    (globalThis as unknown as { fetch: unknown }).fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
    });
    const r = await API.fetchModels({ endpoint: ' https://api.deepseek.com/v1/models ', apiKey: 'k' });
    expect(calls[0]).toBe('https://api.deepseek.com/v1/models');
    expect(r.models).toEqual(['m1']);
  });
});

// 静态守卫：URL 拼接只允许走 lib/endpoint 的构造器，避免以后又冒出第三份手拼逻辑
describe('源码守卫：不再有手拼的 /chat/completions', () => {
  it('api.ts / app.ts 里没有裸拼接口后缀', () => {
    for (const f of ['app/src/domain/api.ts', 'app/src/domain/app.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), '..', f), 'utf8');
      expect(src.includes("'/chat/completions'"), f + ' 出现了手拼的 /chat/completions').toBe(false);
      expect(src.includes("+ '/models'"), f + ' 出现了手拼的 /models').toBe(false);
    }
  });
});
