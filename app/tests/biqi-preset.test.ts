// 比奇预设（用户 2026-10-06：「直接显示在比奇里，两个模式共用一套、可编辑」）。
// 覆盖：默认＝内置 BIQI_SYSTEM；编辑保存后请求里用它；**小说 / 对话共用一份**；清空或与默认一致→回默认；
//      恢复默认立即生效；弹层打开会回填当前生效文本。
import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import '../src/infra/storage';
import { PluginManager } from '../src/domain/plugins';
import { WorldBookManager } from '../src/domain/worldbook';
import { BiqiAgent, BIQI_SYSTEM, BIQI_PRESET_KEY } from '../src/domain/biqi';

const g = globalThis as unknown as Record<string, any>;
const SM = () => (g as any).StorageManager as { get: (k: string, d?: unknown) => any; set: (k: string, v: unknown) => void; remove: (k: string) => void };
const BOOK_ID = 'wb_biqi_preset_test';

// 迷你 DOM：比奇面板的消息区 + 预设弹层
const els: Record<string, any> = {};
function fakeClassList() {
  const s = new Set<string>();
  return { add: (c: string) => s.add(c), remove: (c: string) => s.delete(c), contains: (c: string) => s.has(c) };
}
function setupDom() {
  for (const k of Object.keys(els)) delete els[k];
  els['biqiMessages'] = { innerHTML: '', scrollTop: 0, scrollHeight: 0 };
  els['biqiPresetModal'] = { classList: fakeClassList() };
  els['biqiPresetText'] = { value: '' };
  g.document = { getElementById: (id: string) => els[id] || null };
}
function stubApi() {
  const calls: any[] = [];
  g.APIHandler = {
    fetchCompletions: (msgs: any[], _onData: any, onDone: any, _onErr: any, _opts: any) => {
      calls.push({ msgs });
      onDone('（收到）');
    }
  };
  return calls;
}
const toasts: string[] = [];

beforeAll(() => { /* biqi.ts 在 import 时就挂好了 globalThis.BiqiAgent */ });

beforeEach(() => {
  SM().remove(BIQI_PRESET_KEY);
  SM().remove('biqiHistory_' + BOOK_ID);
  WorldBookManager.saveAll([{ id: BOOK_ID, name: '测试书', entries: [] }] as never);
  WorldBookManager.setActiveId(BOOK_ID);
  PluginManager.setEnabled('biqi', true);
  setupDom();
  toasts.length = 0;
  g.App = { toast: (t: string) => { toasts.push(String(t)); }, collectRecentStoryText: () => ({ recentText: '', fullEditorText: '' }) };
  g.UIManager = { viewAvatar: () => undefined, renderAgentPage: () => undefined, openAgentPage: () => undefined };
  g.htmlEscape = (x: unknown) => String(x == null ? '' : x);
  BiqiAgent.messages = [];
  BiqiAgent._isSending = false;
  BiqiAgent._steps = [];
  BiqiAgent._status = '';
  BiqiAgent._genImages.clear();
  BiqiAgent._imgSeq = 0;
  BiqiAgent._imgGone.clear();
  BiqiAgent._drawToolsOn = false;
  BiqiAgent._hostStatus = { at: 0, ok: false, model: '', hint: '' };
  BiqiAgent._mode = 'novel';
  BiqiAgent._loadedKey = 'biqiHistory_' + BOOK_ID;
});

describe('比奇预设：默认与编辑', () => {
  it('没改过 → 用内置默认（BIQI_SYSTEM）；请求的第一条 system 就是它', async () => {
    expect(BiqiAgent._presetText()).toBe(BIQI_SYSTEM);
    const calls = stubApi();
    BiqiAgent.messages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '', _steps: [] }];
    BiqiAgent._isSending = true;
    await BiqiAgent._runLoop('你好');
    expect(calls.length).toBe(1);
    expect(String(calls[0].msgs[0].content)).toBe(BIQI_SYSTEM);
    expect(String(calls[0].msgs[0].content)).toContain('你是「比奇」');
  });

  it('编辑保存 → 请求改用自定义（人设/工作方式随用户改）；生图规则仍是软件单独注入的第二条 system', async () => {
    els['biqiPresetText'].value = '你是比奇，说话简短，只按我给的设定回答。';
    BiqiAgent.savePreset();
    expect(BiqiAgent._presetText()).toBe('你是比奇，说话简短，只按我给的设定回答。');
    expect(toasts.join('｜')).toContain('保存');
    // 弹层关掉了、存储里也落了
    expect(els['biqiPresetModal'].classList.contains('show')).toBe(false);
    expect(String(SM().get(BIQI_PRESET_KEY, ''))).toContain('说话简短');
    const calls = stubApi();
    BiqiAgent.messages = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '', _steps: [] }];
    BiqiAgent._isSending = true;
    await BiqiAgent._runLoop('你好');
    expect(String(calls[0].msgs[0].content)).toBe('你是比奇，说话简短，只按我给的设定回答。');
    expect(calls[0].msgs[1].role).toBe('system');           // 第二条仍是软件的生图/工具规则
    expect(calls[0].msgs.length).toBeGreaterThanOrEqual(3);
  });

  it('两个模式共用一份：对话模式（_mode=chat）读到的也是同一份自定义预设', async () => {
    SM().set(BIQI_PRESET_KEY, '共用的人设');
    BiqiAgent._mode = 'novel';
    expect(BiqiAgent._presetText()).toBe('共用的人设');
    BiqiAgent._mode = 'chat';
    expect(BiqiAgent._presetText()).toBe('共用的人设');
    const calls = stubApi();
    BiqiAgent.messages = [{ role: 'user', content: '演出继续' }, { role: 'assistant', content: '', _steps: [] }];
    BiqiAgent._isSending = true;
    await BiqiAgent._runLoop('演出继续');
    expect(String(calls[0].msgs[0].content)).toBe('共用的人设');
  });

  it('清空 / 与默认一致 → 视为用默认（删掉自定义，之后软件更新预设会跟着更新）', () => {
    SM().set(BIQI_PRESET_KEY, '旧的');
    els['biqiPresetText'].value = '   ';
    BiqiAgent.savePreset();
    expect(BiqiAgent._presetText()).toBe(BIQI_SYSTEM);
    expect(toasts.join('｜')).toContain('默认');

    SM().set(BIQI_PRESET_KEY, '旧的');
    els['biqiPresetText'].value = BIQI_SYSTEM;      // 与默认一字不差
    BiqiAgent.savePreset();
    expect(BiqiAgent._presetText()).toBe(BIQI_SYSTEM);
  });

  it('恢复默认：立即生效（不等保存）+ 回填默认文本到输入框', () => {
    SM().set(BIQI_PRESET_KEY, '被我改坏了');
    els['biqiPresetText'].value = '被我改坏了';
    BiqiAgent.resetPreset();
    expect(BiqiAgent._presetText()).toBe(BIQI_SYSTEM);      // 立即生效
    expect(els['biqiPresetText'].value).toBe(BIQI_SYSTEM);  // 回填（点保存可再存回去）
  });

  it('打开弹层：回填"当前生效的"那一份（自定义时是自定义，没改过是默认）', () => {
    BiqiAgent.openPresetModal();
    expect(els['biqiPresetText'].value).toBe(BIQI_SYSTEM);
    expect(els['biqiPresetModal'].classList.contains('show')).toBe(true);
    BiqiAgent.closePresetModal();
    expect(els['biqiPresetModal'].classList.contains('show')).toBe(false);
    SM().set(BIQI_PRESET_KEY, '我的版本');
    BiqiAgent.openPresetModal();
    expect(els['biqiPresetText'].value).toBe('我的版本');
  });
});
