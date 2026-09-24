// 已下线功能的回归护栏（v1.5.82）：社区聊天 / 输出上限设置项 / 世界书注入预算设置项都不许复活。
// 这些删除面广且跨端（App + 服务端 + HTML），编译期抓不到，用字符串断言钉住。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..'); // app/.. = 仓库根
const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const src = (p: string) => fs.readFileSync(path.join(ROOT, 'app', 'src', p), 'utf8');
const server = (p: string) => fs.readFileSync(path.join(ROOT, 'server', 'src', p), 'utf8');

describe('社区聊天整体下线', () => {
  it('社区页无聊天 Tab / 频道条 / 消息容器 / 输入框', () => {
    for (const s of ['commViewChat', 'channelBar', 'channelChatMessages', 'communityInput', 'cchTitle', '>聊天<']) {
      expect(html.includes(s), s).toBe(false);
    }
  });
  it('App 端不再引用聊天接口与 WebSocket', () => {
    const c = src('domain/community.ts');
    for (const s of ['/api/chat', '/api/channels', 'WebSocket', 'wss://', 'enterChannel', 'sendMessage(']) {
      expect(c.includes(s), s).toBe(false);
    }
  });
  it('服务端不再挂载聊天路由与 WS 模块，表结构也不再创建', () => {
    const a = server('app.js');
    expect(a.includes('/api/chat')).toBe(false);
    expect(a.includes('routes/chat')).toBe(false);
    expect(a.includes('/api/channels')).toBe(false);
    for (const f of ['ws.js', 'presence.js', 'routes/chat.js', 'routes/channels.js']) {
      expect(fs.existsSync(path.join(ROOT, 'server', 'src', f)), f).toBe(false);
    }
    // 建表已移除，只留一次性的 DROP（老库启动即清理数据）
    expect(server('db.js').includes('CREATE TABLE IF NOT EXISTS messages')).toBe(false);
    expect(server('db.js').includes('DROP TABLE IF EXISTS messages')).toBe(true);
  });
});

describe('输出上限不再由用户设置', () => {
  it('高级设置里没有 Max Tokens 字段', () => {
    expect(html.includes('apiMaxTokens')).toBe(false);
    expect(html.includes('Max Tokens')).toBe(false);
  });
  it('api.ts 不再读 apiConfig.maxTokens，改由 DEFAULT_MAX_TOKENS + 端点上限档案决定', () => {
    const a = src('domain/api.ts');
    expect(a.includes('apiConfig.maxTokens')).toBe(false);
    expect(a.includes('DEFAULT_MAX_TOKENS')).toBe(true);
    expect(a.includes('maxTokensCap')).toBe(true);
  });
});

describe('世界书注入上限固定 10 万字', () => {
  it('设置页不再有预算输入框，注入点用常量', () => {
    expect(html.includes('worldbookBudget')).toBe(false);
    const app = src('domain/app.ts');
    expect(app.includes("get<any>('worldbookBudget'")).toBe(false); // 不再读取
    expect(app.includes('WB_INJECT_MAX_CHARS')).toBe(true);
    // 存档里只允许一处一次性清理（删掉历史值），不得再有第二次引用
    expect(app.split('worldbookBudget').length - 1).toBe(1);
  });
});

describe('正文窗口改为单一设置（字）', () => {
  it('API 参数区不再有「最大上下文 tokens / 每 token 字符数」', () => {
    expect(html.includes('maxContextTokens')).toBe(false);
    expect(html.includes('charsPerToken')).toBe(false);
    const app = src('domain/app.ts');
    expect(app.includes('_contextBudgetChars')).toBe(false);
    expect(app.includes('apiConfig.maxContextTokens')).toBe(false);
  });
  it('记忆页有正文窗口输入框与注入量估算提示，写入走 App.setStoryWindow', () => {
    expect(html.includes('id="storyWindowChars"')).toBe(true);
    expect(html.includes('id="ctxBudgetHint"')).toBe(true);
    expect(html.includes('App.setStoryWindow(this.value)')).toBe(true);
    const app = src('domain/app.ts');
    expect(app.includes('storyWindowTrigger')).toBe(true);
    expect(app.includes('_storyWindowChars')).toBe(true);
    expect(src('domain/ui.ts').includes('renderCtxBudgetHint')).toBe(true);
  });
});

describe('管理员模式不再压缩正文窗口（与普通用户同用设置值）', () => {
  it('adminmode 无窗口覆盖 API，也不清归档/水位线', () => {
    const am = src('domain/adminmode.ts');
    for (const s of ['waterOverride', 'ADMIN_VISIBLE_CHARS', 'ArchiveStore', 'Waterline', 'ArchiveIndex']) {
      expect(am.includes(s), s).toBe(false);
    }
  });
  it('生成链路只按设置算窗口，没有管理员分支', () => {
    const app = src('domain/app.ts');
    expect(app.includes('_admWin')).toBe(false);
    expect(app.includes('AdminMode.waterOverride')).toBe(false);
    expect(app.includes('const _wWater = _storyWin')).toBe(true);
  });
});

describe('悬浮球（option-ball）整体下线', () => {
  it('页面里不再有悬浮球 DOM / 样式', () => {
    for (const s of ['optionBall', 'optionBallFab', 'optionBallPanel', 'ob-opt', 'regenOptionBall']) {
      expect(html.includes(s), 'index.html: ' + s).toBe(false);
    }
  });
  it('App 端不再引用 option-ball 模块与开关', () => {
    const a = src('domain/app.ts');
    for (const s of ['optionBall', 'parseOptionBall', 'optionBallConfig', 'toggleNsfwOptionBall']) {
      expect(a.includes(s), 'app.ts: ' + s).toBe(false);
    }
    expect(fs.existsSync(path.join(ROOT, 'app', 'src', 'domain', 'optionball.ts'))).toBe(false);
  });
});

// 「Agent 设定同步」插件整体下线（2026-09-25，用户要求：只留比奇）。
// 删的面很广（清单 + app 的 delta 钩子 + 二审链路 + 设置页那块），编译期抓不到，用字符串钉住。
describe('Agent 设定同步已删除（临时世界书只由比奇维护）', () => {
  it('插件清单里没有它，只剩数据库模板与比奇', () => {
    const p = src('domain/plugins.ts');
    expect(p.includes('agent-setting-sync')).toBe(false);
    expect(p.includes("'db-classic-tables'")).toBe(true);
    expect(p.includes("'biqi'")).toBe(true);
  });

  it('自动链路（delta 解析/攒批二审/提醒）不再存在', () => {
    const s = src('domain/settingsync.ts');
    for (const gone of ['parseDeltaBlock', 'stripDeltaBlock', 'hasDeltaMarker', 'buildTailInstruction',
      'buildCoverageText', 'buildReminderText', 'noteDeltaResult', 'bumpRound', 'requestChapterReview',
      'shouldTriggerReview', 'buildReviewUserText', 'parseReviewResult', 'getConfig(', 'DEFAULT_REVIEW_SYSTEM',
      'ENGINE_HARD_RULES', 'DEFAULT_TAIL_INSTRUCTION']) {
      expect(s.includes(gone), gone + ' 已删除，不应回归').toBe(false);
    }
    const a = src('domain/app.ts');
    expect(a.includes('reviewSettingDelta(')).toBe(false);   // 注：注释里提到名字不算（防止把说明当代码）
    expect(a.includes('SettingSyncManager.buildTailInstruction')).toBe(false);
  });

  it('保留下来的部分仍在：overlay 存储 / applyApproved / 落盘策略（比奇要用）', () => {
    const s = src('domain/settingsync.ts');
    for (const kept of ['getEffectiveEntries', 'entryStatus', 'applyApproved', 'addPending', 'removePending',
      'findOriginalByTarget', 'mergeEntryContent', 'DEFAULT_TOGGLES', 'isEnabled', 'setMode']) {
      expect(s.includes(kept), kept + ' 应保留（比奇依赖）').toBe(true);
    }
    // 编辑器流式仍要丢弃历史预设/世界书里可能残留的 SETTING_DELTA 块（防御性保留）
    expect(src('domain/editor.ts').includes('SETTING_DELTA')).toBe(true);
  });

  it('临时世界书页不再有「立即结算」按钮', () => {
    expect(html.includes('agentSettleBtn')).toBe(false);
    expect(src('domain/ui.ts').includes('reviewSettingDeltaNow')).toBe(false);
  });
});
