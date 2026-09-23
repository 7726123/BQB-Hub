// UI 可达性守卫：每个面板 tab 都必须有导航入口能到达，否则就是"用户永远看不到、代码却留着"的孤岛
// （v1.5.97.14 清掉的「变量面板」就是这一类：tab-variables 在 DOM 里，侧边栏却没有入口，
//  也没有任何 switchView('variables')——连它依赖的「变量」条目类型都早已被类型精简迁移并掉）。
// 判据与 tools/deadscan.mjs 的 ③ 一致：按 mobile.ts 的 view→tab 映射反查（settings→advanced 这种映射也算）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { tabForView } from '../src/domain/mobile';

const ROOT = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');

describe('面板 tab 可达性', () => {
  it('每个 panel-tab 都有导航入口能切过去', () => {
    const tabs = [...html.matchAll(/panel-tab"\s+id="([a-z-]+)"/g)].map((m) => m[1]);
    const views = [...html.matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]);
    expect(tabs.length).toBeGreaterThan(5);
    const reachable = new Set(views.map((v) => 'tab-' + tabForView(v)));
    const orphans = tabs.filter((t) => !reachable.has(t));
    expect(orphans, '孤岛面板（没有导航入口）: ' + orphans.join(', ')).toEqual([]);
  });

  it('反之也成立：每个导航入口都指向真实存在的 tab（或写作视图）', () => {
    const tabs = [...html.matchAll(/panel-tab"\s+id="([a-z-]+)"/g)].map((m) => m[1]);
    const views = [...html.matchAll(/data-view="([a-z-]+)"/g)].map((m) => m[1]);
    const missing = views.filter((v) => v !== 'writing' && !tabs.includes('tab-' + tabForView(v)));
    expect(missing, '导航指向了不存在的 tab: ' + missing.join(', ')).toEqual([]);
  });
});
