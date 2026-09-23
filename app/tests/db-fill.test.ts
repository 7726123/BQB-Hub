// DB 填表链路：fillMemoryTable 的 early-return 判断 + fetchCompletions 调用 + 结果解析
// 用户场景：主 API 模式（DB 独立配置为空 → 用主 API），SiliconFlow 渠道可用
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/infra/storage';
import '../src/domain/app';
import '../src/domain/database';

const anyG = globalThis as unknown as Record<string, unknown>;
type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;

const DB = () => DBM as any;
const App = () => (globalThis as unknown as { App: any }).App;

// P3-B：fill 链路经 import 使用真实 DatabaseManager（全局桩失效）→ 覆写其方法
import { DatabaseManager as DBM } from '../src/domain/database';
// 真实实现快照 + 还原：桩必须在每个用例后还原，否则会漏进后面的 describe。
// 曾经的"截断容错"用例（第二个 describe）就跑在被污染的桩上：getTables 恒 []、getDB 每次返回
// 空对象、saveDB 空操作 → 其实一行都没写进去，却因为 _applyDBFillResult 无条件 n++ 而"通过"。
// 2026-09-22 改成"只统计真实写入"后暴露，故在此还原。
const REAL_DB: Record<string, any> = {
  isEnabled: (DBM as any).isEnabled, getSettings: (DBM as any).getSettings, getApiConfig: (DBM as any).getApiConfig,
  getTables: (DBM as any).getTables, getDB: (DBM as any).getDB, saveDB: (DBM as any).saveDB, setEnabled: (DBM as any).setEnabled,
};
function restoreRealDB() { Object.keys(REAL_DB).forEach((k) => { (DBM as any)[k] = REAL_DB[k]; }); }
function makeDBStub(enabled: boolean, settings: any) {
  const d = DBM as unknown as Record<string, any>;
  d.isEnabled = () => enabled;
  d.getSettings = () => settings;
  d.getApiConfig = () => (settings.mode === 'custom' && settings.endpoint && settings.apiKey
    ? { endpoint: settings.endpoint, apiKey: settings.apiKey, model: settings.model } : null);
  d.getTables = () => [];
  d.getDB = () => ({ tables: [], records: {} });
  d.saveDB = () => {};
  d.setEnabled = () => {};
}

beforeEach(() => {
  restoreRealDB(); // 先还原上一个用例可能留下的桩
  sm().set('apiConfig', { endpoint: 'https://api.siliconflow.cn/v1', apiKey: 'sk-test-fake-key-local-only', model: 'deepseek-ai/DeepSeek-V4-Flash' });
  makeDBStub(true, { mode: 'main', endpoint: '', apiKey: '', model: '' });
  // fillMemoryTable 内部 _dbWorldbookRef 会读 WorldBookManager（真实 App 全局存在，测试需桩）
  anyG.WorldBookManager = {
    getActiveId: () => 'wb1', getAll: () => [], getActive: () => null,
    saveAll: () => {}, getActiveWorldBook: () => null, isEnabled: () => false,
  };
  anyG.PresetManager = { getActiveAPIConfig: () => sm().get<any>('apiConfig', {}) };
});

describe('fillMemoryTable 主 API 模式', () => {
  it('主 API 模式（DB 独立配置空）→ getApiConfig 为 null → 回退主 API 配置', () => {
    const g = DB().getApiConfig();
    expect(g).toBeNull();
    const main = sm().get<any>('apiConfig', {});
    expect(main.apiKey).toContain('sk-');
    expect(main.endpoint).toContain('siliconflow');
  });

  it('未启用 DB → fillMemoryTable 直接返回 0（不调 API）', async () => {
    makeDBStub(false, { mode: 'main' });
    const called = vi.fn();
    (globalThis as unknown as { APIHandler: any }).APIHandler = { fetchCompletions: called };
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(0);
    expect(called).not.toHaveBeenCalled();
  });

  it('正文不足 50 字 → 返回 0 不调 API', async () => {
    const called = vi.fn();
    (globalThis as unknown as { APIHandler: any }).APIHandler = { fetchCompletions: called };
    const n = await App().fillMemoryTable('太短');
    expect(n).toBe(0);
    expect(called).not.toHaveBeenCalled();
  });

  it('无 apiKey（主 API 未配置）→ 返回 0 不调 API（静默）', async () => {
    sm().set('apiConfig', { endpoint: 'https://api.siliconflow.cn/v1', apiKey: '', model: '' });
    const called = vi.fn();
    (globalThis as unknown as { APIHandler: any }).APIHandler = { fetchCompletions: called };
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(0);
    expect(called).not.toHaveBeenCalled();
  });

  it('有 key → 调用 fetchCompletions（回传 <Memory> 块 → 成功返回更新数）', async () => {
    let callArgs: any = null;
    (globalThis as unknown as { APIHandler: any }).APIHandler = {
      fetchCompletions: (msg: any, oc: any, onDone: any, oe: any, overrides: any) => {
        callArgs = { overrides };
        // 模拟模型返回 <Memory> 更新块
        setTimeout(() => onDone('<Memory>{"table":"角色","changes":[{"姓名":"林晚","状态":"已修炼"}]}</Memory>'), 0);
      },
    };
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(0); // 解析：无可应用表（stub 无表）→ 0，但已成功调用了 API
    expect(callArgs).not.toBeNull();
    expect(callArgs.overrides.apiConfig.apiKey).toContain('sk-');
    // 输出不设上限：不传 maxTokens，走 api.ts 的默认最大值（端点上限由降级阶梯学习）
    expect(callArgs.overrides.maxTokens).toBeUndefined();
    expect(callArgs.overrides.temperature).toBe(0.3);
  });
});

// 思考型模型（思考关不掉）会把 token 预算吃光 → finish_reason=length。
// 生产要求：只要回传里存在可解析的更新块就照常入库（截断只影响最后半行），全空才算失败。
describe('fillMemoryTable 截断容错（length 不再一刀切当失败）', () => {
  const anyG2 = globalThis as unknown as Record<string, any>;

  beforeEach(() => {
    restoreRealDB(); // 第二个 describe 要用真实表结构：必须先清掉上一个 describe 的桩
    sm().set('apiConfig', { endpoint: 'https://api.commandcode.ai/provider/v1', apiKey: 'sk-test-fake-key-local-only', model: 'deepseek/deepseek-v4.1-flash' });
    // 用真实 DatabaseManager（不 stub）：表结构来自内置「经典记忆数据库」
    sm().set('pluginEnabled:db-classic-tables', true);
    anyG2.WorldBookManager = {
      getActiveId: () => 'wb1', getAll: () => [], getActive: () => null,
      saveAll: () => {}, getActiveWorldBook: () => null, isEnabled: () => false,
    };
    anyG2.PresetManager = { getActiveAPIConfig: () => sm().get<any>('apiConfig', {}) };
  });

  it('被截断但含完整更新块 → 正常解析入库（返回 > 0）', async () => {
    const truncated = '<Memory>\n#角色档案\n[温水佳树]|年龄：14|性别：女|当前位置：家中·二楼房间\n#剧情摘要\n主线摘要：[8月22日] 佳树想采访八奈见被支回房间\n#物品追踪\n[录音笔]|状态：完好|持有者：温水佳树\n#世界设';
    (globalThis as unknown as { APIHandler: any }).APIHandler = {
      fetchCompletions: (msg: any, oc: any, onDone: any, oe: any, overrides: any) => {
        overrides.onFinishReason('length');
        setTimeout(() => onDone(truncated), 0);
      },
    };
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBeGreaterThan(0);
    expect(App()._dbFillStatus).toBe('ok');
  });

  it('全空/无法解析 → 重试一次后判定失败（不再谎报"无更新"）', async () => {
    let calls = 0;
    (globalThis as unknown as { APIHandler: any }).APIHandler = {
      fetchCompletions: (msg: any, oc: any, onDone: any, oe: any, overrides: any) => {
        calls++;
        overrides.onFinishReason('length');
        setTimeout(() => onDone('思考了一大堆但没有任何结构化更新'), 0);
      },
    };
    const n = await App().fillMemoryTable('正文内容'.repeat(30));
    expect(n).toBe(0);
    expect(calls).toBe(2);                       // 首次 + 重试各一次
    expect(App()._dbFillStatus).toBe('failed');
  });
});
