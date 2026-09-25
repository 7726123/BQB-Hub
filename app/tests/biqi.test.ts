// 比奇插件：写入走临时世界书 overlay（原书零触碰）、立即生效（临时世界书现在只由比奇维护）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import '../src/infra/storage';
import { PluginManager } from '../src/domain/plugins';
import { SettingSyncManager } from '../src/domain/settingsync';
import { WorldBookManager } from '../src/domain/worldbook';
import { BiqiAgent } from '../src/domain/biqi';

const SM = () => (globalThis as unknown as { StorageManager: import('../src/infra/storage').StorageManagerClass }).StorageManager;
const g = globalThis as unknown as Record<string, any>;

const BOOK_ID = 'wb_biqi_test';
const origEntry = { id: 'e1', type: '角色', name: '苏黎', content: '性别：女\n年龄：十九', inject: true };

// 用真实 WorldBookManager 造书（storage 落盘）：overlay/注入走的是真实读取路径，
// 不能桩掉全局——settingsync/biqi 走的是 ES import 的模块引用
function seedBook() {
  WorldBookManager.saveAll([{ id: BOOK_ID, name: '测试书', title: '测试书', entries: [{ ...origEntry }] }] as never);
  WorldBookManager.setActiveId(BOOK_ID);
}

beforeEach(() => {
  for (const k of ['worldBooks', 'activeWorldBookId', 'pluginEnabled:biqi', 'pluginEnabled:agent-setting-sync', 'biqiHistory_' + BOOK_ID,
    'settingOverlay_' + BOOK_ID, 'settingDeltaPending_' + BOOK_ID, 'settingOverlaySnaps_' + BOOK_ID,
    'settingDeltaLog_' + BOOK_ID, 'settingDeltaMeta_' + BOOK_ID]) SM().remove(k);
  seedBook();
  g.App = { toast: () => undefined, collectRecentStoryText: () => ({ recentText: '正文片段：她在雨里站了很久。', fullEditorText: '' }) };
  g.UIManager = { renderAgentPage: () => undefined, openAgentPage: () => undefined };
});

describe('比奇：临时世界书写入', () => {
  it('新增条目：进 overlay.added 立即生效，原书 entries 不变', () => {
    PluginManager.setEnabled('biqi', true);
    const r = BiqiAgent._applyOp('add', '灰港', '概况：终年落灰的港口城市。', '剧情需要一座港口');
    expect(r.ok).toBe(true);
    const eff = SettingSyncManager.getEffectiveEntries();
    expect(eff.map(e => e.name)).toEqual(['苏黎', '灰港']);
    // 原书零触碰
    expect(WorldBookManager.getActive()!.entries.map((e: any) => e.name)).toEqual(['苏黎']);
    expect(SettingSyncManager.entryStatus(eff[1].id)).toBe('added');
  });

  it('新增同名条目：并入已有条目而不是重复建条', () => {
    PluginSyncEnable();
    BiqiAgent._applyOp('add', '苏黎', '性别：女\n年龄：十九\n背景：灰港的向导。', '补背景');
    const eff = SettingSyncManager.getEffectiveEntries();
    expect(eff.filter(e => e.name === '苏黎')).toHaveLength(1);
    expect(eff[0].content).toContain('灰港的向导');
  });

  it('修改原书条目：写进 overlay.modified，原书内容保持原样', () => {
    PluginSyncEnable();
    const r = BiqiAgent._applyOp('mod', '苏黎', '性别：女\n年龄：二十', '过生日了');
    expect(r.ok).toBe(true);
    expect(SettingSyncManager.getEffectiveEntries()[0].content).toContain('二十');
    expect(WorldBookManager.getActive()!.entries[0].content).toContain('十九');
    expect(SettingSyncManager.entryStatus('e1')).toBe('modified');
  });

  it('删除（停用）原书条目：进 overlay.disabled，从生效列表消失但原书还在', () => {
    PluginSyncEnable();
    const r = BiqiAgent._applyOp('del', '苏黎', '', '角色已退场');
    expect(r.ok).toBe(true);
    expect(SettingSyncManager.getEffectiveEntries()).toHaveLength(0);
    expect(WorldBookManager.getActive()!.entries).toHaveLength(1);
    expect(SettingSyncManager.getOverlay().disabled).toContain('e1');
  });

  it('改不存在的条目：拒绝并给出可执行的提示，不留脏数据', () => {
    PluginSyncEnable();
    const r = BiqiAgent._applyOp('mod', '没有这个条目', '内容', '');
    expect(r.ok).toBe(false);
    expect(r.text).toContain('add_entry');
    expect(SettingSyncManager.getEffectiveEntries().map(e => e.name)).toEqual(['苏黎']);
    expect(SettingSyncManager.getPending()).toHaveLength(0); // 失败不留待裁决
  });

  it('写入自带快照：回滚上一批能撤回比奇的改动', () => {
    PluginSyncEnable();
    BiqiAgent._applyOp('add', '灰港', '概况：终年落灰。', '');
    expect(SettingSyncManager.getEffectiveEntries()).toHaveLength(2);
    expect(SettingSyncManager.rollback()).toBe(true);
    expect(SettingSyncManager.getEffectiveEntries().map(e => e.name)).toEqual(['苏黎']);
  });

  it('比奇开启时临时世界书参与注入（isActive / isEnabled 现在同一个门：比奇开关）', () => {
    expect(SettingSyncManager.isActive()).toBe(false);
    PluginManager.setEnabled('biqi', true);
    expect(SettingSyncManager.isActive()).toBe(true);
    expect(SettingSyncManager.isEnabled()).toBe(true);
    PluginManager.setEnabled('biqi', false);
    expect(SettingSyncManager.isActive()).toBe(false);
  });
});

describe('比奇：读取工具与开关', () => {
  it('read_worldbook 返回生效条目并标注临时层来源', () => {
    PluginSyncEnable();
    BiqiAgent._applyOp('add', '灰港', '概况：终年落灰。', '');
    const j = JSON.parse(BiqiAgent.readWorldbook());
    expect(j.ok).toBe(true);
    expect(j.total).toBe(2);
    expect(j.entries[0].status).toBe('orig');
    expect(j.entries[1].status).toBe('added');
    expect(j.entries[1].tag).toContain('临时新增');
  });

  it('read_story 走与续写同一个正文来源（App.collectRecentStoryText）', () => {
    const spy = vi.fn(() => ({ recentText: '正文片段：她在雨里站了很久。', fullEditorText: '' }));
    g.App.collectRecentStoryText = spy;
    const j = JSON.parse(BiqiAgent.readStory());
    expect(spy).toHaveBeenCalled();
    expect(j.text).toContain('她在雨里站了很久');
    expect(j.note).toContain('同源');
  });

  it('未开启插件时 open/send 被拦住（按钮也不显示）', () => {
    BiqiAgent._open = false;
    const toast = vi.fn();
    g.App.toast = toast;
    g.document = { getElementById: () => null };
    BiqiAgent.open();
    expect(toast).toHaveBeenCalled();
    expect(BiqiAgent._open).toBe(false);
  });

  it('对话按书隔离：历史键带书 ID', () => {
    expect(BiqiAgent._historyKey()).toBe('biqiHistory_' + BOOK_ID);
  });

  // 用户 2026-09-25（对话模式龙套/新角色追问的连带修复）：比奇新增人物若不传 type，
  // 条目是「其他」——对话模式的名单只收「角色」，那些人物就进不了名单、头像也挂不上。
  it('add_entry 的工具描述要求"人物一律用角色"类型（默认其他会把角色挡在名单外）', () => {
    const tools = BiqiAgent._tools() as any[];
    const add = tools.map((t: any) => t && t.function).find((f: any) => f && f.name === 'add_entry');
    expect(add).toBeTruthy();
    expect(String(add.parameters.properties.type.description)).toContain('人物/角色一律用「角色」');
    expect(String(add.parameters.properties.type.description)).toContain('进不了名单');
  });

  it('换书切会话：旧书对话存回旧键，新书读自己的（不串台）', () => {
    PluginSyncEnable();
    BiqiAgent.messages = [{ role: 'user', content: 'A 书的问题' }];
    BiqiAgent._loadedKey = 'biqiHistory_' + BOOK_ID;
    // 切到另一本书
    WorldBookManager.saveAll([
      { id: BOOK_ID, name: '测试书', entries: [{ ...origEntry }] },
      { id: 'wb_other', name: '另一本', entries: [] },
    ] as never);
    WorldBookManager.setActiveId('wb_other');
    BiqiAgent.reloadForBook();
    expect(BiqiAgent.messages).toEqual([]);                       // 新书没有对话
    expect(SM().get('biqiHistory_' + BOOK_ID, [])).toEqual([{ role: 'user', content: 'A 书的问题' }]); // 旧书那份存回去了
    // 在新书里聊两句，再切回来
    BiqiAgent.messages = [{ role: 'user', content: 'B 书的问题' }];
    WorldBookManager.setActiveId(BOOK_ID);
    BiqiAgent.reloadForBook();
    expect(BiqiAgent.messages.map(m => m.content)).toEqual(['A 书的问题']);
    expect(SM().get('biqiHistory_wb_other', [])).toEqual([{ role: 'user', content: 'B 书的问题' }]);
  });

  it('read_worldbook 会说明「初始」条目只在正文为空时注入一次', () => {
    PluginSyncEnable();
    WorldBookManager.saveAll([{ id: BOOK_ID, name: '测试书', entries: [
      { ...origEntry },
      { id: 'e2', type: '初始', name: '开局设定', content: '故事从灰港的雨夜开始。', inject: true },
    ] }] as never);
    WorldBookManager.setActiveId(BOOK_ID);
    g.App.collectRecentStoryText = () => ({ recentText: '正文已经写了两千字。', fullEditorText: '' });
    const j = JSON.parse(BiqiAgent.readWorldbook());
    expect(j.initialEntries).toContain('开局设定');
    expect(j.initialInjected).toBe(false);
    expect(j.initialNote).toContain('时间线错误');   // 明确告诉它别当成时间线错误
    // 正文为空时 → 会注入
    g.App.collectRecentStoryText = () => ({ recentText: '   ', fullEditorText: '' });
    const j2 = JSON.parse(BiqiAgent.readWorldbook());
    expect(j2.initialInjected).toBe(true);
  });
});

// 测试内开启比奇的简写
function PluginSyncEnable() { PluginManager.setEnabled('biqi', true); }
