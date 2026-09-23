// 探针：记忆数据库「填表」链路真机复现（真实 APIHandler + 真实解析器 + 真实内置插件表）。
// 用法（密钥只走环境变量）：
//   DBAPI_KEY=xxx DBAPI_URL=https://api.commandcode.ai/provider/v1 DBAPI_MODEL=deepseek/deepseek-v4.1-flash \
//   npx vitest run --config tools/retrieval-eval/vitest.config.ts dbfill
// A 部分：按生产参数复现现状（是否成功/耗时/返回条数）。
// B 部分：参数矩阵——换 reasoning_effort / max_tokens，看模型能否产出可解析的 <Memory> 块
//        （定位"到底是端点不吃参数，还是思考吃光了 token 预算"）。
import '../../src/infra/storage';
import '../../src/domain/api';       // 挂载真实 APIHandler（fetchCompletions）
import '../../src/domain/worldbook';
import '../../src/domain/book';
import '../../src/domain/plugins';   // 内置插件（经典记忆数据库 = db-classic-tables）
import '../../src/domain/database';
import '../../src/domain/preset';
import '../../src/domain/app';
import { describe, it } from 'vitest';
import { loadCanonical } from './lib/core';
import { DatabaseManager } from '../../src/domain/database';
import { BookManager } from '../../src/domain/book';

const SMc = () => (globalThis as unknown as { StorageManager: import('../../src/infra/storage').StorageManagerClass }).StorageManager;
const anyG = globalThis as unknown as Record<string, any>;

const URL_ = process.env.DBAPI_URL || 'https://api.commandcode.ai/provider/v1';
const KEY = process.env.DBAPI_KEY || '';
const MODEL = process.env.DBAPI_MODEL || 'deepseek/deepseek-v4.1-flash';
const TXT = process.env.EVAL_TXT || 'C:/Users/a7726/Desktop/案例.txt';
const CHARS = Number(process.env.DBAPI_CHARS || 3000);

// 复刻 fillMemoryTable 的 messages（提示词/结构定义都取真实值）
function buildMessages(body: string) {
  const App = anyG.App as any;
  const schema = App._dbSchemaText();
  const fillTemplate = DatabaseManager.fillPrompt ? DatabaseManager.fillPrompt() : null;
  const prompt = (fillTemplate || App.DB_FILL_PROMPT).replace('__TABLE_DEFINITIONS__', schema);
  return [
    { role: 'system', content: App.DB_HISTORIAN_PROMPT },
    { role: 'system', content: prompt },
    { role: 'system', content: App._dbStateReference() },
    { role: 'user', content: '【最新正文】\n' + body.slice(-3000) + '\n\n请立即根据以上最新正文、世界书设定和批量追溯填表提示词执行任务，只输出<Memory>更新块。' },
  ];
}

describe('记忆数据库填表链路（真实 API）', () => {
  it('A：按生产参数跑一次填表（现状复现）', async () => {
    if (!KEY) { console.log('[dbfill] 未提供 DBAPI_KEY，跳过'); return; }
    const sm = SMc();
    sm.set('pluginEnabled:db-classic-tables', true);
    sm.set('apiConfig', { endpoint: URL_, apiKey: KEY, model: MODEL, maxContextTokens: 256000, charsPerToken: 1.4 });
    try { BookManager.createBook('探针书'); } catch (e) { /* 已有书忽略 */ }

    const canonical = loadCanonical(TXT);
    const body = canonical.slice(Math.floor(canonical.length * 0.35), Math.floor(canonical.length * 0.35) + CHARS);
    const App = anyG.App as any;
    const DB = DatabaseManager as any;
    console.log('[A] 模型', MODEL, '| 端点', URL_, '| 正文', body.length, '字');
    console.log('[A] DB 启用 =', DB.isEnabled(), '| 表 =', DB.getTables().map((t: any) => t.name).join('/'));
    const control = '<Memory>\n#角色档案\n[测试角色]|年龄：17|性别：女|当前位置：学校·教室\n#剧情摘要\n主线摘要：[第一天] 测试摘要一行\n</Memory>';
    console.log('[A] 解析器自检（标准格式）→', App._parseDBFillResult(control).length, '条');

    const t0 = Date.now();
    const n = await App.fillMemoryTable(body);
    console.log('[A] fillMemoryTable 返回', n, '条 | 耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');
  });

  it('B：参数矩阵（reasoning_effort / max_tokens 组合）', async () => {
    if (!KEY) { console.log('[dbfill] 未提供 DBAPI_KEY，跳过'); return; }
    const sm = SMc();
    sm.set('pluginEnabled:db-classic-tables', true);
    sm.set('apiConfig', { endpoint: URL_, apiKey: KEY, model: MODEL });
    try { BookManager.createBook('探针书'); } catch (e) { /* 忽略 */ }
    const App = anyG.App as any;
    const canonical = loadCanonical(TXT);
    const body = canonical.slice(Math.floor(canonical.length * 0.35), Math.floor(canonical.length * 0.35) + CHARS);
    const messages = buildMessages(body);

    const combos: { name: string; extra: Record<string, unknown>; maxTokens: number }[] = [
      { name: '生产现状 effort=none', extra: { reasoning_effort: 'none' }, maxTokens: 6000 },
      { name: 'effort=low / 6000', extra: { reasoning_effort: 'low' }, maxTokens: 6000 },
      { name: 'effort=low / 16000', extra: { reasoning_effort: 'low' }, maxTokens: 16000 },
      { name: '不带思考参数 / 6000', extra: {}, maxTokens: 6000 },
    ];
    for (const c of combos) {
      const req: any = Object.assign({ model: MODEL, messages, max_tokens: c.maxTokens, temperature: 0.3, stream: false }, c.extra);
      const t0 = Date.now();
      try {
        const r = await fetch(URL_.replace(/\/$/, '') + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
          body: JSON.stringify(req),
        });
        const txt = await r.text();
        if (!r.ok) { console.log('[B] %s → HTTP %d %s', c.name, r.status, txt.slice(0, 160)); continue; }
        let j: any = {};
        try { j = JSON.parse(txt); } catch (e) { console.log('[B] %s → 非 JSON 响应 %s', c.name, txt.slice(0, 120)); continue; }
        const ch = (j.choices && j.choices[0]) || {};
        const content = String((ch.message && ch.message.content) || '');
        const rc = String((ch.message && ch.message.reasoning_content) || '');
        const usage = j.usage || {};
        const rt = (usage.completion_tokens_details && usage.completion_tokens_details.reasoning_tokens) || 0;
        const hasMem = /<Memory>/i.test(content);
        const parsed = hasMem ? App._parseDBFillResult(content).length : 0;
        console.log('[B] %s → HTTP %d | finish=%s | 正文 %d 字 | reasoning %d 字 | usage=%s | <Memory>=%s | 解析 %d 条 | %.1fs',
          c.name, r.status, ch.finish_reason, content.length, rc.length,
          JSON.stringify({ pt: usage.prompt_tokens, ct: usage.completion_tokens, r: rt }), hasMem, parsed, (Date.now() - t0) / 1000);
        if (content) console.log('      正文开头: %s', content.slice(0, 90).replace(/\n/g, '⏎'));
        if (rc && !content) console.log('      reasoning 开头: %s', rc.slice(0, 90).replace(/\n/g, '⏎'));
      } catch (e) {
        console.log('[B] %s → 异常 %s', c.name, String((e as Error).message).slice(0, 140));
      }
    }
  });
});
