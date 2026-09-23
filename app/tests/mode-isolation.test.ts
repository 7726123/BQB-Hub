// 两种模式的实例隔离：比奇会话键、SettingSyncManager 的按书键都带模式后缀。
// 这是用户明确要求的"每个模式都要用独立的实例（例如比奇），互不影响"的守卫测试。
import { describe, it, expect } from 'vitest';
import '../src/infra/storage';
import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { SettingSyncManager } from '../src/domain/settingsync';
import { BiqiAgent } from '../src/domain/biqi';

function seedBook(): string {
  WBM.saveAll([]);
  const b = WBM.createBook('隔离测试书');
  WBM.saveAll(WBM.getAll());
  WBM.setActiveId(b.id);
  return b.id;
}

describe('两种模式的实例隔离', () => {
  it('SettingSyncManager：对话模式的五个按书键都带 _chat 后缀（覆盖 overlay/待裁决/日志/快照/元信息）', () => {
    const id = seedBook();
    SettingSyncManager.setMode('novel');
    expect(SettingSyncManager._bookId()).toBe(id);
    expect(SettingSyncManager._overlayKey()).toBe('settingOverlay_' + id);
    SettingSyncManager.setMode('chat');
    expect(SettingSyncManager._bookId()).toBe(id + '_chat');
    expect(SettingSyncManager._overlayKey()).toBe('settingOverlay_' + id + '_chat');
    expect(SettingSyncManager._pendingKey()).toBe('settingDeltaPending_' + id + '_chat');
    expect(SettingSyncManager._snapsKey()).toBe('settingOverlaySnaps_' + id + '_chat');
    // 两份 overlay 互不影响：对话模式写一条，小说模式读不到
    SettingSyncManager.setMode('chat');
    const chatOverlay = SettingSyncManager.getOverlay();
    chatOverlay.added.push({ id: 'x1', type: '角色', name: '对话模式临时角色', content: '只在对话模式', inject: true });
    SettingSyncManager._saveOverlay(chatOverlay);
    expect(SettingSyncManager.getOverlay().added.length).toBe(1);
    SettingSyncManager.setMode('novel');
    expect(SettingSyncManager.getOverlay().added.length).toBe(0);
    SettingSyncManager.setMode('novel');   // 还原默认，避免影响其他用例
  });

  it('比奇：会话按模式分开（小说模式一份、对话模式一份，不串台）', () => {
    const id = seedBook();
    BiqiAgent._mode = 'novel';
    expect(BiqiAgent._historyKey()).toBe('biqiHistory_' + id);
    BiqiAgent._mode = 'chat';
    expect(BiqiAgent._historyKey()).toBe('biqiHistory_' + id + '_chat');
    BiqiAgent._mode = 'novel';
  });
});
