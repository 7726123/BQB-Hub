// 稳定前缀守卫：prompt 缓存命中率是本项目的核心设计（实测：中间 system 槽每轮大改会把
// 命中率打到 ~50%）。本测试守住两条不变量：
//   ① system 前缀的组装区不得出现时间/随机/轮次计数等易变构造；
//   ② 每轮必变的内容必须留在 user 滚动区（_userParts），不得作为 system 消息插入。
// 以及一条回归：已退休的 L2 慢变快照（slowSnap / _sessionGenCount / arcSummary）不得回归。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/archive';

const here = dirname(fileURLToPath(import.meta.url));
const APP_TS = readFileSync(resolve(here, '../src/domain/app.ts'), 'utf8');

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;
import { WorldBookManager as WBM } from '../src/domain/worldbook';
const WL = (globalThis as unknown as { Waterline: typeof import('../src/domain/archive').Waterline }).Waterline;

describe('稳定前缀守卫（prompt 缓存）', () => {
  it('消息组装区不含时间/随机/轮次等易变构造', () => {
    const start = APP_TS.indexOf('// Messages ordered for max cache');
    const end = APP_TS.indexOf("messages.push({ role: 'user'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = APP_TS.slice(start, end);
    for (const bad of ['Date.now', 'new Date', 'Math.random', 'performance.now', 'totalContinuationCount', 'randomUUID']) {
      expect(block.includes(bad), 'system 前缀组装区不应出现易变构造: ' + bad).toBe(false);
    }
  });

  it('每轮必变的内容在 user 滚动区（_userParts），不进 system', () => {
    // 归档回读 / 事实卡：每轮随正文变化，放 system 会切断前缀缓存
    // （变量状态原来也在这一档，v1.5.97.14 随"变量注入块"一起删除——条目类型已不存在）
    for (const part of ['_archiveRecall', '_factCardCtx']) {
      expect(APP_TS.includes('_userParts.push(' + part + ')'), part + ' 应进 user 滚动区').toBe(true);
    }
  });

  // v1.5.97.13：场景状态分析（每次生成后额外调一次模型、没有 UI/开关）与变量自动更新（变量条目类型早已
  // 被 migrateEntryTypes() 并入「其他」，永不触发）双双删除。这里守住"注入与写库都不要回来"。
  it('场景状态分析已删除，注入/写库不得回归', () => {
    for (const gone of ["SM().get<any>('sceneState'", "SM().set('sceneState'", '_sceneCtxText', 'async updateSceneState(', '_varCtxText', '_hasVarEntries']) {
      expect(APP_TS.includes(gone), gone + ' 已删除，不应回归').toBe(false);
    }
  });

  it('L2 慢变快照已退休：slowSnap / _sessionGenCount / arcSummary 不得回归', () => {
    for (const gone of ['slowSnap', '_sessionGenCount', 'arcSummary']) {
      expect(APP_TS.includes(gone), gone + ' 已删除，不应回归').toBe(false);
    }
  });
});

describe('窗口块冻结不变（缓存前提）', () => {
  it('同一全文重复 update：frozen/x/blockCount 逐字节不变', () => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    WBM.createBook('书1');
    const text = Array.from({ length: 400 }, (_, i) => '第' + i + '段：' + '她把窗推开，雨声涌进来。'.repeat(3)).join('\n\n');
    const w1 = WL.update(text, 8000, 12000);
    const w2 = WL.update(text, 8000, 12000);
    expect(w2.frozen).toBe(w1.frozen);
    expect(w2.x).toBe(w1.x);
    expect(w2.blockCount).toBe(w1.blockCount);
    // 窗口块必须与全文严格对齐（撤销/手改可被一致性检查发现）
    expect(text.slice(w1.x, w1.x + w1.frozen.length)).toBe(w1.frozen);
  });
});
