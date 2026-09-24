// 流式渲染的性能契约（对话模式「卡住 + 之后一次性补字」的修复护栏）。
//
// 背景（真机报的现象）：对话模式流式输出时整个软件卡住，有时卡一会儿后突然几秒内把 2000 字全吐出来。
// 实测根因：流式绘制每 200ms 会把整屏气泡（窗口最多 120 条演出）连同头像一起重画一遍，
// 而头像存的是几百 KB 的 base64 data URL——单帧成本几乎全在"把这一长串重新塞进 DOM"上：
// 121 个气泡时 3.9KB 头像 = 7ms/帧，273KB = 161ms/帧，约 1MB = 637ms/帧（桌面 Chrome，手机更慢）。
// 单帧超过 200ms → JS 线程被占满 → 界面不动、SSE 数据排队 → 线程空出来时一次性补上。
//
// 这三条断言盯住修复不被改回去。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const src = (p: string) => fs.readFileSync(path.join(ROOT, 'app', 'src', p), 'utf8');

describe('对话模式流式渲染：不得每帧重插头像 base64', () => {
  it('气泡头像走短地址（blob:），不再原样塞 data URL', () => {
    const c = src('domain/chatmode.ts');
    expect(c.includes("from '../lib/avatarurl'")).toBe(true);
    expect(c.includes('avatarUrl(e.avatar)')).toBe(true);
    // 旧写法（原样返回 data URL）不许回归
    expect(c.includes('String(e.avatar)')).toBe(false);
  });

  it('渲染层其它头像位置同样用短地址（数据库页一次要画整表记录）', () => {
    const u = src('domain/ui.ts');
    expect(u.includes("from '../lib/avatarurl'")).toBe(true);
    const hits = u.split('avatarUrl(').length - 1;
    expect(hits).toBeGreaterThanOrEqual(3);   // 世界书条目列表 + 数据库记录详情 + 数据库记录行
    expect(u.includes('htmlEscape(e.avatar)')).toBe(false);
  });

  it('流式绘制的节流仍在（每 200ms 一次，不许变成每个 chunk 都画一遍）', () => {
    const c = src('domain/chatmode.ts');
    expect(c.includes('if (now - this._lastPaint < 200) return;')).toBe(true);
  });
});
