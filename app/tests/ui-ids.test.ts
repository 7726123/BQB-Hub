// UI id 唯一性守卫：单页应用里 id 重复时 getElementById 会取到文档中靠前的那个元素，
// 从而把 A 视图的输入读成 B 视图的输入（历史 bug：社区的 `wbSearch` 读到了编辑器过滤框）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

describe('web/index.html 元素 id', () => {
  it('没有重复的 id', () => {
    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
    const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
    expect(dup, '重复 id: ' + dup.join(', ')).toEqual([]);
  });

  it('引用的本地样式表/脚本都存在', () => {
    const refs = [
      ...[...html.matchAll(/<link[^>]+href="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
    ].filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('data:'));
    const missing = refs.filter((r) => {
      const p = path.join(ROOT, 'web', r.split('?')[0]);
      return !fs.existsSync(p);
    });
    expect(missing, '引用了不存在的文件: ' + missing.join(', ')).toEqual([]);
  });
});
