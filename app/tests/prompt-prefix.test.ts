// 前缀缓存守卫：prompt 缓存命中率是本项目的核心设计（2026-09-25 实测见 tools/cache-probe.mjs）。
// 命中长度 = 与上一轮请求的**最长公共前缀**，所以装配顺序有硬约束：
//   ① 极稳的块放最前（预设 / 原书世界书 / 主角 / 常驻角色）；
//   ② 只追加的块居中（归档回读 epoch 块、正文「窗口+滚动区」合并段）——变化只赔追加的那一小段；
//   ③ 每轮原地重写的块全部放最后（临时世界书 overlay / 登场角色 / 相关档案 / 本轮补充回读 / 指令），
//      且必须排在正文之后：排在正文前面的话，每轮正文追加都会把它们一起打成 miss。
// 组装区还不得出现时间/随机/轮次计数等易变构造。
// 另有两条回归：已退休的 L2 慢变快照（slowSnap / _sessionGenCount / arcSummary）、
// 以及已删的场景状态/变量注入块不得回归。
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
    const start = APP_TS.indexOf('// ===== 消息装配：按「变化越晚越靠后」排布');
    const end = APP_TS.indexOf("messages.push({ role: 'user'", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const block = APP_TS.slice(start, end);
    for (const bad of ['Date.now', 'new Date', 'Math.random', 'performance.now', 'totalContinuationCount', 'randomUUID']) {
      expect(block.includes(bad), 'system 前缀组装区不应出现易变构造: ' + bad).toBe(false);
    }
  });

  it('装配顺序：稳定 → 只追加 → 每轮重写（越靠后越易变）', () => {
    const start = APP_TS.indexOf('// ===== 消息装配：按「变化越晚越靠后」排布');
    const end = APP_TS.indexOf("messages.push({ role: 'user'", start);
    const block = APP_TS.slice(start, end);
    const at = (needle: string) => {
      const i = block.indexOf(needle);
      expect(i, needle + ' 应出现在装配区').toBeGreaterThan(0);
      return i;
    };
    // 只追加区（epoch 回读块、正文合并段）在前；每轮重写的块（overlay/登场角色/档案/本轮补充）在后
    const epoch = at("_archiveRecall) messages.push({ role: 'system'");
    const body = at('var _bodyText');
    const bodyPush = at("content: '## 正文（历史 + 最新进度");
    const overlay = at('if (_overlayCtx) _userParts.push(_overlayCtx)');
    const extra = at('if (extraCharCtx) _userParts.push(extraCharCtx)');
    const fact = at('if (_factCardCtx) _userParts.push(_factCardCtx)');
    const fresh = at('if (_recallFresh) _userParts.push(_recallFresh)');
    const instr = at("_userParts.push('【指令】'");
    expect(epoch).toBeLessThan(body);
    expect(body).toBeLessThan(bodyPush);
    expect(bodyPush).toBeLessThan(overlay);
    expect(overlay).toBeLessThan(extra);
    expect(extra).toBeLessThan(fact);
    expect(fact).toBeLessThan(fresh);
    expect(fresh).toBeLessThan(instr);
  });

  it('世界书按「临时修订」分流：原书进稳定前缀，改过/新增的进 user 区尾部', () => {
    expect(APP_TS.includes('SettingSyncManager.entryStatus(e.id)')).toBe(true);
    expect(APP_TS.includes('_origEntries : _overlayEntries')).toBe(true);   // 分流到稳定前缀 / user 区尾部
    // 旧的「_variableCtx 变量区」（把同一批世界书条目再注入一遍）不得回归
    expect(APP_TS.includes('_variableCtx +=')).toBe(false);   // 只查代码形态，注释里的历史说明不算
    expect(APP_TS.includes("## 世界书条目（以下设定必须严格遵守")).toBe(false);
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

  // 二轮整改（2026-09-25）：正文块之间不再插人工分隔符，prompt 里的正文 = 正文原文的一段后缀。
  // 这是"跟新块不破缓存"的前提——旧写法 join('\n\n') 会在新块末尾插一个分隔符，把之后的滚动区
  // 整段打成 miss（真机实测那一轮 81%）。
  it('正文块逐字节等于正文原文（不插分隔符）', () => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    WBM.createBook('书1');
    const text = Array.from({ length: 300 }, (_, i) => '第' + i + '段：' + '屋檐下的水还在滴。'.repeat(4)).join('\n\n');
    const w = WL.update(text, 8000, 12000);
    // app.ts 里的正文 = frozen + 之后的滚动区 → 必须正好等于 text.slice(x)
    const body = w.frozen + text.slice(w.x + w.head);
    expect(body).toBe(text.slice(w.x));
    expect(body.length).toBe(text.length - w.x);
  });

  it('跟一个新块：上一轮的正文是新正文的前缀（纯追加，零字节损失）', () => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    WBM.createBook('书1');
    const base = Array.from({ length: 300 }, (_, i) => '段' + i + '：' + '她把伞收起来。'.repeat(4)).join('\n\n');
    const w1 = WL.update(base, 8000, 30000);
    const body1 = w1.frozen + base.slice(w1.x + w1.head);
    const text2 = base + '\n\n' + '新写的正文。'.repeat(Math.ceil(WL.MIN_APPEND / 3));
    const w2 = WL.update(text2, 8000, 30000);
    const body2 = w2.frozen + text2.slice(w2.x + w2.head);
    expect(w2.blockCount).toBeGreaterThan(w1.blockCount);   // 确实吐了新块
    expect(w2.x).toBe(w1.x);                                // 没有滚动
    expect(body2.startsWith(body1)).toBe(true);             // 上一轮正文是新正文的前缀 → 缓存全命中
  });

  // 二轮整改：窗口内改一处只重切改动点之后的块（旧实现整窗重建 → 正文第一个字节就变 → 只剩 43%）
  it('窗口内改一处：x 不动、改动点之前的块原样保留，只赔改动点之后', () => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    WBM.createBook('书1');
    const base = '甲'.repeat(3000) + '\n\n' + '乙'.repeat(3000) + '\n\n' + '丙'.repeat(6000) + '\n\n' + '丁'.repeat(6000);
    const w1 = WL.update(base, 12000, 20000);
    const body1 = w1.frozen + base.slice(w1.x + w1.head);
    const editAt = w1.x + Math.floor(w1.head * 0.4);            // 改动点落在窗口中部
    const edited = base.slice(0, editAt) + '【改】' + base.slice(editAt);
    const w2 = WL.update(edited, 12000, 20000);
    expect(w2.x).toBe(w1.x);                                    // 没有重新锚定（旧实现 x 会变）
    const body2 = w2.frozen + edited.slice(w2.x + w2.head);
    let same = 0;
    const n = Math.min(body1.length, body2.length);
    while (same < n && body1.charCodeAt(same) === body2.charCodeAt(same)) same++;
    expect(same).toBe(editAt - w1.x);                           // 公共前缀 = 改动点之前那一段
    expect(edited.slice(w2.x, w2.x + w2.frozen.length)).toBe(w2.frozen);   // 窗口仍与正文严格对齐
  });
});
