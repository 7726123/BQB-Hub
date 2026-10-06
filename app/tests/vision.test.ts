// 看图能力（lib/vision）：
//  · 能力按**模型名**缓存（yes/no/unknown），判 no 要保守（4xx + 图片/视觉词）；
//  · 看图是**一次独立的子调用**（带图 + 问题 → 文字回答），主对话请求里永远没有图片字段；
//  · api 层要把 user 的 content 数组原样放行（否则图片会变成 "[object Object]"）。
import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import {
  visionState, markVision, looksLikeVisionError, lookAtImage, lookAtImageTracked,
  activeModelId, __resetVisionForTest, VISION_CAPS_KEY
} from '../src/lib/vision';
import { normalizeOutgoingMessages } from '../src/domain/api';

const g = globalThis as unknown as Record<string, any>;
const SM = () => g.StorageManager as { get: (k: string, d?: unknown) => any; set: (k: string, v: unknown) => void; remove: (k: string) => void };

beforeEach(() => {
  __resetVisionForTest();
  g.PresetManager = { getActiveAPIConfig: () => ({ endpoint: 'https://x/v1', apiKey: 'k', model: 'm-a' }) };
  delete g.APIHandler;
});

describe('vision：能力缓存', () => {
  it('默认 unknown；mark 之后按模型名分开记（换模型互不影响）', () => {
    expect(activeModelId()).toBe('m-a');
    expect(visionState()).toBe('unknown');
    markVision('yes');
    expect(visionState()).toBe('yes');
    expect(visionState('m-b')).toBe('unknown');
    markVision('no', 'm-b');
    expect(visionState('m-b')).toBe('no');
    const all = SM().get(VISION_CAPS_KEY, {});
    expect(all['m-a']).toBe('yes');
    expect(all['m-b']).toBe('no');
  });

  it('looksLikeVisionError：要 4xx + 图片/视觉词；超时 / 5xx / 空都不算', () => {
    expect(looksLikeVisionError('API 请求失败 (400): unsupported image_url')).toBe(true);
    expect(looksLikeVisionError('HTTP 415: 该模型不支持图片输入')).toBe(true);
    expect(looksLikeVisionError('API 请求失败 (500): image backend down')).toBe(false);
    expect(looksLikeVisionError('请求超时（60s）')).toBe(false);
    expect(looksLikeVisionError('')).toBe(false);
  });
});

describe('vision：看图子调用', () => {
  it('把图和问题发成 content 数组，返回文字回答；成功后能力记 yes', async () => {
    const calls: any[] = [];
    g.APIHandler = {
      fetchCompletions: (msgs: any[], _c: any, onDone: any, _e: any, opts: any) => {
        calls.push({ msgs: msgs, opts: opts });
        onDone('图里有一位黑发少女坐在窗边，手指没有明显问题。');
      }
    };
    const r = await lookAtImageTracked({ images: ['data:image/jpeg;base64,AAA'], question: '手有问题吗' });
    expect(r.ok).toBe(true);
    expect(String(r.answer)).toContain('黑发少女');
    expect(visionState()).toBe('yes');
    const content = calls[0].msgs[1].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0].type).toBe('text');
    expect(content[1].type).toBe('image_url');
    expect(String(content[1].image_url.url)).toContain('data:image/jpeg;base64,');
    expect(calls[0].msgs[0].role).toBe('system');
    expect(calls[0].opts.callLabel).toBe('vision');
    expect(calls[0].opts.tools).toBeUndefined();     // 子调用不带工具（免得它又想调工具）
  });

  it('能力类报错（400 + image）→ 记 no；超时/网络错 → 保持 unknown（下次还能试）', async () => {
    g.APIHandler = { fetchCompletions: (_m: any, _c: any, _d: any, onErr: any) => { onErr('API 请求失败 (400): unsupported content type image_url'); } };
    expect((await lookAtImageTracked({ images: ['x'], question: 'q' })).state).toBe('no');
    expect(visionState()).toBe('no');

    __resetVisionForTest();
    g.APIHandler = { fetchCompletions: (_m: any, _c: any, _d: any, onErr: any) => { onErr('请求超时（60s）'); } };
    expect((await lookAtImageTracked({ images: ['x'], question: 'q' })).state).toBe('unknown');
    expect(visionState()).toBe('unknown');
  });

  it('缺图 / 缺问题 / 接口层不可用 → 结构化失败，不抛', async () => {
    expect((await lookAtImage({ images: [], question: 'q' })).ok).toBe(false);
    expect((await lookAtImage({ images: ['x'], question: '  ' })).ok).toBe(false);
    expect((await lookAtImage({ images: ['x'], question: 'q' })).ok).toBe(false);   // 没有 APIHandler
  });

  it('最多只看两张（对比用），多的丢掉', async () => {
    let sent = 0;
    g.APIHandler = { fetchCompletions: (msgs: any[], _c: any, onDone: any) => { sent = (msgs[1].content || []).length; onDone('ok'); } };
    await lookAtImage({ images: ['a', 'b', 'c'], question: 'q' });
    expect(sent).toBe(3);   // 1 个 text + 2 张图
  });
});

describe('api：user 的 content 数组原样放行（图片才传得出去）', () => {
  it('数组保持原样；字符串照旧；非字符串非数组仍转成字符串', () => {
    const arr = [{ type: 'text', text: '看这张' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AA' } }];
    const out = normalizeOutgoingMessages([
      { role: 'user', content: arr },
      { role: 'user', content: '普通文字' },
      { role: 'user', content: null }
    ], {});
    expect(out[0].content).toBe(arr);
    expect(out[1].content).toBe('普通文字');
    expect(out[2].content).toBe('');
  });
});
