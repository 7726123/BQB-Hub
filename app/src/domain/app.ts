import { SM } from '../infra/gate';
import { decodeNovelText, novelTextToEditorHtml, mergeChapterText } from '../lib/textfile';
import { htmlToPlainText } from '../lib/htmltext';
import { recallKey, recallFits } from '../lib/recallgate';
import { AdminMode } from './adminmode';
import { UsageStats, _wbKey } from '../lib/usage';
import { SettingSyncManager } from './settingsync';
import { RegexEngine, type RegexRule } from '../lib/regex';
import { BODY_MARKER, stripLeadingBodyMarker } from '../lib/think-protocol';
import { PluginManager } from './plugins';
import { WorldBookManager, selectInjectableEntries, WB_INJECT_MAX_CHARS } from './worldbook';
import { normalizeStoryWindow, storyWindowTrigger, STORY_WINDOW_DEFAULT } from '../lib/contextbudget';
import { BookManager, parseSampler, normalizeQuotes } from './book';
import { ProtagonistManager } from './protagonist';
import { CharacterManager } from './character';
import { DatabaseManager } from './database';
import { VariableManager } from '../lib/variables';
import { UpdateManager } from './update';
// 酒馆适配器：必须走模块导入。此前这里读的是 globalThis.TavernAdapter，而 tavern-adapter.ts
// 从不挂全局（单 bundle 改造后成了纯 ES 模块）→ 拿到的永远是 undefined，
// 于是「世界书 → 导入角色卡」只建了空书、一条条目都不落（卡内世界书全丢，v1.5.88 修复）。
import * as TavernAdapter from './tavern-adapter';
import { ClientLog } from './clientlog';
import { sanitizeEndpointUrl, chatCompletionsUrl } from '../lib/endpoint';
export interface AppShape {
  [k: string]: any;
  ROLLING?: any;
  isGenerating?: any;
  _lastInputText?: any;
  _dbEpoch?: any;
  _undoInputDraft?: any;
  _varSnapshot?: any;
  EDITOR_FONTS?: any;
  THEMES?: any;
  EDITOR_SIZES?: any;
  temperature?: any;
  max_tokens?: any;
  stream?: any;
  method?: any;
  headers?: any;
  importance?: any;
  chapterId?: any;
  chapterTitle?: any;
  source_cont?: any;
  DB_HISTORIAN_PROMPT?: any;
  DB_FILL_PROMPT?: any;
  isBigLTM?: any;
  MODEL_PRICING?: any;
  id?: any;
  name?: any;
  sysprompt?: any;
  version?: any;
  _pendingCharCards?: any;
  backstory?: any;
  chapters?: any;
  writingGuide?: any;
  types?: any;
}

// 管线化迁移（源码与 www/modules/app.js 逐行一致）：
// 该模块属 UI/胶水层超大文件：全库 strict 类型检查下（无 @ts-nocheck 指令），
// 接口化标注 + 拆分进行中（见 docs/single-bundle-refactor.md）。
// 尾部由 build-legacy.mjs 自动追加全局挂载（IIFE 产物内顶层声明不可见）。
// ==================== 酒馆(SillyTavern)模板语法展开 ====================
// 预设里大量使用 {{setvar::KEY::值}} / {{getvar::KEY}} / {{//注释}} / ${占位符}，
// DeepSeek 能顺着模板读，豆包等模型看不懂这些语法，导致思维链指令缺失。
// 这里在请求发出前统一展开：收集所有 setvar 声明，把 getvar 引用替换为实际值，
// 删除 setvar 声明与注释，去掉 ${...} 外壳保留内部文字。
function _collectSTVars(messages: any) {
  var vars = {} as Record<string, any>;
  for (var i = 0; i < messages.length; i++) {
    var s = messages[i].content;
    if (typeof s !== 'string') continue;
    var re = /\{\{setvar::([\s\S]*?)::([\s\S]*?)\}\}/g;
var m: any;
    while ((m = re.exec(s)) !== null) {
      var k = m[1].trim();
      if (k) vars[k] = m[2];
    }
  }
  return vars;
}

function _expandSTInMessages(messages: any) {
  var vars = _collectSTVars(messages);
  for (var i = 0; i < messages.length; i++) {
    if (typeof messages[i].content !== 'string') continue;
    var t = messages[i].content;
    // getvar 引用 → 展开为消息内 setvar 的值；未声明时回退查世界书运行时变量
    // （原生预设把变量收敛进顶层 variables 导入后，这里才能取到值）
    t = t.replace(/\{\{getvar::([\s\S]*?)\}\}/g, function (_: any, k: any) {
      var key = k.trim();
      if (vars.hasOwnProperty(key)) return vars[key] || '';
      try {
        var _gv = VariableManager.get(key);
        if (_gv !== '' && _gv !== undefined) return _gv;
      } catch(e) {}
      return '';
    });
    // setvar 声明块 → 删除（值已通过 getvar 使用）
    t = t.replace(/\{\{setvar::[\s\S]*?\}\}/g, '');
    // {{//...}} 注释 → 删除
    t = t.replace(/\{\{\/\/([\s\S]*?)\}\}/g, '');
    // {{char}} → 其他角色（酒馆的 NPC；写作场景里是主角之外的互动角色）
    t = t.replace(/\{\{char\}\}/gi, '其他角色');
    // {{user}}/{user} → 主角名（世界书条目/角色卡里的主角占位符）：写卡 agent 按规则原样保留
    // 占位符，落到具体名字只在这一层发生——换主角名后所有条目自动跟着变。
    // 只认带花括号的两种写法；裸 user 不替换（会误伤英文单词）。函数式替换：名字里含 $ 时
    // 字符串替换会把 $& 之类当替换模式。
    var _puName = '主角';
    try {
      var _pu = (App && App.getProtagonist) ? App.getProtagonist() : null;
      if (_pu && _pu.name) _puName = _pu.name;
    } catch (e) { /* App 尚未就绪时退回「主角」 */ }
    t = t.replace(/\{\{\s*user\s*\}\}/gi, function () { return _puName; });
    t = t.replace(/\{\s*user\s*\}/gi, function () { return _puName; });
    // {{random::A|B|C}} → 随机取一个选项
    t = t.replace(/\{\{random::([\s\S]*?)\}\}/gi, function (_: any, opts: any) {
      var arr = opts.split('|').map(function (s: any) { return s.trim(); }).filter(Boolean);
      return arr.length > 0 ? arr[Math.floor(Math.random() * arr.length)] : '';
    });
    // ${...} 占位符 → 去掉外壳，保留内部说明文字
    t = t.replace(/\$\{([\s\S]*?)\}/g, function (_: any, inner: any) { return inner.trim(); });
    t = t.replace(/\n{3,}/g, '\n\n');
    messages[i].content = t;
  }
}

// 未闭合思考块的归属：固定「保留在思考框」（思考不外露，也不进正文）。
// 只有思考框不渲染时才退回正文（思考强度关 / 该模型已被自愈停用）——否则内容会被静默丢弃。
function _thinkingUnclosedPolicy(): 'keep' | 'to_body' {
  try {
    if (typeof App !== 'undefined' && typeof (App as any).thinkingLevel === 'function' && (App as any).thinkingLevel() === 'off') return 'to_body';
    if (typeof App !== 'undefined' && typeof (App as any).thinkBoxDisabledForModel === 'function' && (App as any).thinkBoxDisabledForModel()) return 'to_body';
    return 'keep';
  } catch (e) { return 'keep'; }
}

// 未闭合思考的按模型计数键（endpoint|model 哈希）：用于协议自愈
function _thinkStreakKey(): string {
  try {
    const cfg = (typeof PresetManager !== 'undefined' ? PresetManager.getActiveAPIConfig() : null) as any;
    const raw = String((cfg && cfg.endpoint) || '') + '|' + String((cfg && cfg.model) || '');
    if (!raw || raw === '|') return '';
    let h = 5381;
    for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
    return 'thinkUnclosedStreak_' + Math.abs(h);
  } catch (e) { return ''; }
}

// 未闭合思考：提示 + 协议自愈。连续 2 轮未闭合 → 判定该 endpoint|model 不吃标签协议，
// 之后不再为它建思考框（思考按正文处理），并提示一次；正常一轮即清零。
function _notifyUnclosedThink(sp: any): void {
  try {
    const key = _thinkStreakKey();
    if (!key) return;
    if (sp && sp.unclosed) {
      const n = Number(SM().get<any>(key, 0)) + 1;
      SM().set(key, n);
      const offKey = key + '_off';
      if (n >= 2 && !SM().get<any>(offKey, false)) {
        SM().set(offKey, true);
        try { App.toast('该模型连续未闭合思考标签，已停止显示思考框（思考按正文处理）'); } catch (e) { /* ignore */ }
      }
      if (_thinkingUnclosedPolicy() === 'keep' && typeof EditorManager !== 'undefined' && typeof EditorManager.showUnclosedThinkNotice === 'function') {
        EditorManager.showUnclosedThinkNotice(String(sp.unclosed).replace(/\s/g, '').length);
      }
    } else {
      SM().set(key, 0);
    }
  } catch (e) { /* 提示/自愈失败不影响正文 */ }
}

// 提取所有思考块 → 合并成单一蓝框内容。解决 COT 分段输出问题：
// - 多段注释（<!-- 梳理：A --> <!-- 补充：B -->）合并成一个蓝框；
// - Claude 风格 begin/end 标记（<!-- begin_of_Subtext_think --> ... <!-- end_of_Subtext_think -->）
//   之间的"普通文本"也归入思考区（标记本身不显示）；
// - 未闭合思考块按协议边界（`【正文】`）或用户策略处理，长度不参与判定。
// 返回 { thoughts: 思考内容数组(原文, 不转义), body: 移除了思考块的正文, unclosed: 未闭合思考原文(无则 '') }
function _splitThinkingBlocks(text: any) {
  var thoughts: any[] = [];
  var bodyParts: any[] = [];
  // <think>/<thinking> 标签与 <!-- --> 注释同等对待；识别到的思考段一律剥离进 thoughts
  // （正文优先：无论是否原生推理通道，content 里出现思考标记就剥离保留——若模型真走了
  // 原生通道又在 content 重复输出，双份显示优于丢失内容；误判场景内容不丢）。
  // 标签容忍 `> ` 前空格与 thinking/think 混写（`<thinking >`/`</think >`/`<think>…</thinking>`）
  // ——流式层认得的形态完成态必须同样认得，否则完成态会把整段当未闭合处理。
  var re = /<!--([\s\S]*?)-->|<think(?:ing)?\s*>([\s\S]*?)<\/think(?:ing)?\s*>/gi;
  var last = 0, m;
  var inThink = false;
  var pending = '';
  var isEndMark = function (v: any) { return /end|结束|完毕|完成|finish|<\/think(?:ing)?\s*>/i.test(v.trim()); };
  var isBeginMark = function (v: any) { return /(?:^|\s)(?:begin|start|subtext)[\s_:-]/i.test(v.trim()); };
  var isOpening = function (s: any) {
    var t = String(s).trim();
    if (!t || t.length > 200) return false;
    return /思考|梳理|推理|复盘|想想|thought|分析一下|想一下/i.test(t);
  };
  while ((m = re.exec(text)) !== null) {
    var seg = text.slice(last, m.index);
    if (inThink) {
      if (seg) thoughts.push(seg);
    } else pending += seg;
    var isThinkTok = m[2] !== undefined;
    var inner = isThinkTok ? m[2] : m[1];
    if (inThink) {
      if (isEndMark(inner)) inThink = false;
      else thoughts.push(inner);
    } else if (isThinkTok) {
      if (isOpening(pending)) {
        thoughts.push(pending.trim());
        pending = '';
      } else if (pending) { bodyParts.push(pending); pending = ''; }
      thoughts.push(inner);
    } else if (isBeginMark(inner)) {
      if (isOpening(pending)) {
        thoughts.push(pending.trim());
        pending = '';
      } else if (pending) { bodyParts.push(pending); pending = ''; }
      inThink = true;
    } else if (isEndMark(inner)) {
    } else {
      if (isOpening(pending)) {
        thoughts.push(pending.trim());
        pending = '';
      } else if (pending) { bodyParts.push(pending); pending = ''; }
      thoughts.push(inner);
    }
    last = m.index + m[0].length;
  }
  var tail = text.slice(last);
  if (inThink) {
    if (tail) thoughts.push(tail);
  } else pending += tail;
  if (pending) {
    if (inThink) thoughts.push(pending);
    else bodyParts.push(pending);
  }
  // 未闭合思考块（模型漏闭合 / 流式截断 / 上下文被截断）：
  // ① 先按协议边界切分——`【正文】` 之前是思考、之后是正文（标记剔除）；
  // ② 无标记时按用户策略处理：keep（默认）保留进思考框，to_body 归入正文。
  // 绝不按长度判定（思维链可能上万字，长度与"是否截断"没有可分性）。
  var unclosed = '';
  var body = bodyParts.join('');
  // 协议要求正文以 `【正文】` 开头：思考块正常闭合时也要把这个标记从正文里剥掉
  body = stripLeadingBodyMarker(body);
  var um = /<!--([\s\S]*)$|<think(?:ing)?\s*>([\s\S]*)$/i.exec(body);
  if (um) {
    var inner = String(um[2] !== undefined ? um[2] : um[1] || '');
    var mi = inner.indexOf(BODY_MARKER);
    if (mi >= 0) {
      var thinkPart = inner.slice(0, mi);
      var bodyPart = stripLeadingBodyMarker(inner.slice(mi));
      if (thinkPart.trim()) thoughts.push(thinkPart.replace(/^\s+/, ''));
      body = body.slice(0, um.index) + bodyPart;
    } else {
      unclosed = inner.replace(/^\s*/, '');
      if (_thinkingUnclosedPolicy() === 'to_body') {
        body = body.slice(0, um.index) + unclosed;
      } else {
        if (unclosed.trim()) thoughts.push(unclosed);
        body = body.slice(0, um.index);
      }
    }
  }
  return { thoughts: thoughts, body: body, unclosed: unclosed };
}

function _buildThinkingHtml(thoughts: any, esc: any) {
  if (!thoughts || thoughts.length === 0) return '';
  var joined = thoughts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  // 必须闭合 </details>：未闭合会让浏览器把后续正文吞进思考框（正文"消失/进思维链"的根因）
  // 不带 open：续写结束后思维链默认折叠、点击展开（流式期间的实时框才展开）
  return '<details class="cot-thinking" contenteditable="false"><summary>思考</summary>' + esc(joined) + '\n</details>\n';
}

// ==================== 正文冻结层（非全文模式缓存优化核心）====================
// 已由 Waterline（archive.js）取代：窗口块只增不改 + 75% 触发滚动归档。
// 保留对象仅作兼容壳（旧书存储里可能残留 frozenCtx_* 数据，读取后即弃）。
const FrozenContext = {
  ROLLING: 5000, APPEND_STEP: 1500, MAX: 100000,
  _key() { return 'frozenCtx_' + (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId ? WorldBookManager.getActiveId() : 'none'); },
  get() { return SM().get<any>(this._key(), { text: '', len: 0 }); },
  update(t: any) { var s = this.get(); if (s && s.text) { try { SM().set(this._key(), { text: '', len: 0 }); } catch (e) {} } return ''; },
  clear() { SM().set(this._key(), { text: '', len: 0 }); },
};

const App: AppShape = {
  isGenerating: false,
  _lastInputText: '',  // 写作输入框上次发送的内容（撤回时恢复到输入框）
  _dbEpoch: 0,  // 撤回代际计数：**只有撤回**才 +1（回滚数据库快照时，飞行中的填表结果据此作废）。
  // 注意：不要再让"新生成"自增——填表结果描述的是已经写下的那段正文，新开一轮并不使它失效；
  // 此前生成也 +1，导致"填表还在飞的时候用户继续续写"就会把结果丢掉，而提示仍写「无更新」。
  _dbFillStatus: '',  // 最近一次填表结果：''未跑 | ok成功 | empty无更新 | failed失败 | skipped跳过 | nokey无Key | undone撤回作废（回溯填表提示语用）
  _dbFillSkipped: 0,  // 最近一次填表里"没写成"的行数（空内容/与已有重复/主键为空）
  _dbFillTruncated: false, // 最近一次填表的输出是否被截断（截断会让后面几张表整段没写）
  _undoInputDraft: '',  // 撤回时恢复到输入栏的上一轮草稿（生成开始时从场景草稿捕获）
  _varSnapshot: null,  // 生成前的世界书变量快照（撤回时整表回滚；见 _saveVarSnapshot）

  // 内置正文字体选项（仅正文编辑区生效）
  EDITOR_FONTS: [
    { key: 'system', label: '系统默认', family: '' },
    { key: 'wenkai', label: '霞鹜文楷', family: '"LXGW WenKai", sans-serif' },
    { key: 'serif', label: '思源宋体', family: '"Noto Serif SC", serif' }
  ],
  // 界面主题（替代原白天/黑夜切换，多主题可选）
  THEMES: [
    { key: 'light', label: '☀ 白天' },
    { key: 'dark', label: '🌙 黑夜' },
    { key: 'newspaper', label: '📰 青墨染' },
    { key: 'dream', label: '🌸 梦境粉' }
  ],
  // 正文字号档位（仅编辑器正文）
  EDITOR_SIZES: [
    { px: 14, label: '小 14' },
    { px: 16, label: '中 16' },
    { px: 18, label: '大 18' },
    { px: 20, label: '特大 20' }
  ],

  init() {
    Modals.init();
    if (typeof UpdateManager !== 'undefined' && UpdateManager.init) UpdateManager.init(); // 整包更新检查（非 Android 环境自动跳过）
    if (typeof AdminMode !== 'undefined' && AdminMode.syncBadge) AdminMode.syncBadge();   // 管理员模式角标（上次开启则常驻）
    // 侧边栏「管理」入口也要在启动时同步一次：此前它只在社区页渲染里同步，而那句还在
    // 「未登录就 return」之后——于是冷启动后不进社区页（或没登录社区）时入口一直藏着（表现为"没有管理栏"）。
    if (typeof CommunityChat !== 'undefined' && (CommunityChat as any).syncAdminEntry) (CommunityChat as any).syncAdminEntry();
    // 归档上下文头 + 人物事件行：滚动归档后用现有 API 生成（SM 'archiveHeadEnabled' 可关）
    if (typeof ArchiveStore !== 'undefined' && ArchiveStore.setHeadProvider) {
      ArchiveStore.initStorage(); // IndexedDB 持久化（异步加载，容量远超 localStorage）
      ArchiveStore.setHeadProvider(async function (blocks: { id: string; text: string }[]) {
        const apiConfig = App.getBackendAPIConfig ? App.getBackendAPIConfig() : undefined;
        if (!apiConfig || !(apiConfig as Record<string, unknown>).apiKey) return { heads: {}, events: [] };
        const listing = blocks.map(function (b, i) { return '【' + i + '】' + String(b.text || '').slice(0, 1200); }).join('\n\n');
        const raw = await new Promise<string | null>(function (resolve) {
          APIHandler.fetchCompletions([
            { role: 'system', content: '你是小说归档索引员。对每个片段输出两部分：\n1. heads：每片段一行检索用头部「场景｜在场人物｜发生了什么」，40字内，人物名等实体必须使用原文用词；\n2. events：每片段提取 2-5 条事件行（优先有长期记忆价值的：约定/承诺/身份揭示/关系变化/重要物件/关键地点/冲突与转折），每条包含：keys（与该事件绑定的实体名 3-6 个：人物/场所/物品/事件名，原文用词，含同义变体如全名与简称）、quote（事件在片段中的原句片段，5-15字，逐字照抄）、text（谁+做了什么+关键台词片段，30-60字），i 为片段序号。\n只输出严格 JSON：{"heads":["头1",...],"events":[{"i":0,"keys":["长坂坡","张飞","当阳桥"],"quote":"据水断桥的原句","text":"张飞在长坂坡断桥喝退追兵"}]}' },
            { role: 'user', content: listing },
          ], function () {}, function (full) { resolve(full); }, function () { resolve(null); },
            { temperature: 0.2, apiConfig: apiConfig as Record<string, unknown>, callLabel: 'archiveHead', timeout: 30000 });
        });
        if (!raw) return { heads: {}, events: [] };
        // 兼容模型把 JSON 整体字符串化的返回（"{\"heads\":[...]}"）→ 先解一层字符串
        let payload = raw.trim();
        if (payload.startsWith('"')) { try { payload = JSON.parse(payload); } catch (e) { /* 保持原样 */ } }
        const m = payload.match(/\{[\s\S]*\}/);
        if (!m) return { heads: {}, events: [] };
        let parsed: any = {};
        try { parsed = JSON.parse(m[0]); } catch (e) { return { heads: {}, events: [] }; }
        // 兼容模型把 heads 返回成整串（每行一头）而非数组
        let headsRaw: any = parsed.heads;
        if (typeof headsRaw === 'string') headsRaw = headsRaw.split(/\n+/).map(function (s: string) { return s.trim(); }).filter(Boolean);
        if (!Array.isArray(headsRaw)) headsRaw = [];
        const heads: Record<string, string> = {};
        blocks.forEach(function (b, i) { if (headsRaw[i]) heads[b.id] = String(headsRaw[i]); });
        const events = (parsed.events || []).map(function (e: any) {
          return {
            i: Number(e.i) || 0,
            keys: Array.isArray(e.keys) ? e.keys.map(String) : [],
            quote: String(e.quote || ''),
            text: String(e.text || ''),
          };
        });
        return { heads: heads, events: events };
      });
      ArchiveStore._kickHeadEnrich(); // 启动时为存量无头块补头（后台静默）
    }
    EditorManager.init(); UIManager.init(); MobileUI.init(); PresetManager.initDefaults(); BookManager.migrateFromLegacy();
    ProtagonistManager.migrateFromLegacy(); WorldBookManager.initDefaults();
    // 「开头」条目类型已废弃：存量条目一次性删除（内容备份在 removedOpeningEntriesBackup，可找回）。
    // 必须先于 migrateEntryTypes——否则旧类型迁移会把「开头」改写成「其他」，这批条目就删不掉了。
    try {
      const _openingRemoved = WorldBookManager.removeOpeningEntries();
      if (_openingRemoved > 0) App.toast('已移除 ' + _openingRemoved + ' 条「开头」条目（该类型已废弃）');
    } catch (e) { console.warn('[migrate] 开头条目清理失败:', e); }
    WorldBookManager.migrateEntryTypes(); // 条目类型精简：旧类型统一改为「其他」
    // 一次性迁移（纯文本换行修复）：修复前 getPlainText 走的分离节点 innerText 会丢 <br> 换行，
    // 存量水位线/归档是「整篇一行」的正文切出来的（块只能按字数硬切、检索单元退化成整块），
    // 与修复后的正文不再对应。清一次让它们按新正文重建（正文本身不受影响）。
    try {
      if (!SM().get<boolean>('newlineFixMigratedV1', false)) {
        if (typeof Waterline !== 'undefined') Waterline.clear();
        if (typeof ArchiveStore !== 'undefined') ArchiveStore.clear();
        if (typeof ArchiveIndex !== 'undefined') ArchiveIndex.invalidate();
        SM().set('newlineFixMigratedV1', true);
        console.log('[migrate] 纯文本换行修复：已清空水位线与归档区（按新正文重建）');
      }
    } catch (e) { console.warn('[migrate] newlineFix:', e); }
    // 默认正则：按 id 自动补齐缺失项（版本更新后被误删/清空也能自动恢复；不覆盖用户已有的自定义规则）
    var _defaultRules: RegexRule[] = [
      { id: 'regex_setvar', name: '去除 {{setvar}} 思维链', findRegex: '/\\{\\{setvar::[\\s\\S]*?\\}\\}/g', replaceString: '', timing: 'after', enabled: true, order: 0 },
      { id: 'regex_lquote', name: '左双引号→「', findRegex: '/[""]/g', replaceString: '「', timing: 'after', enabled: true, order: 1 },
      { id: 'regex_rquote', name: '右双引号→」', findRegex: '/[""]/g', replaceString: '」', timing: 'after', enabled: true, order: 2 },
      { id: 'regex_demo2', name: '示例：统一省略号', findRegex: '\\.\\.\\.+', replaceString: '……', timing: 'after', enabled: false, order: 3 },
      { id: 'regex_debagu', name: '去八股词', findRegex: '/(由于|极其|特么|踏马|引以为傲|可笑|甚至|引以为豪|死死地|无比坚定地|极度)/g', replaceString: '', timing: 'after', enabled: true, order: 4 }
    ];
    try {
      var _curRules = RegexEngine.getRules();
      var _curIds = {} as Record<string, any>;
      _curRules.forEach(function (r) { if (r.id) _curIds[r.id] = true; });
      var _missing = _defaultRules.filter(function (r) { return r.id && !_curIds[r.id]; });
      if (_missing.length > 0) {
        RegexEngine.saveRules(_curRules.concat(_missing));
        console.log('[Regex] 已补全', _missing.length, '条默认正则:', _missing.map(function (r) { return r.id; }).join(','));
      }
    } catch(e) {
      if (RegexEngine.getRules().length === 0) RegexEngine.saveRules(_defaultRules);
    }
    // 存量规则改名：去掉「去八股词」名称里的第三方来源标注（词表与行为一字未动；
    // 用户自己改过名的按原样保留，只精确匹配旧名）
    try {
      var _oldName = '去八股词（提取自MoM糖糖公司预设）';
      var _curRules2 = RegexEngine.getRules();
      var _renamed = false;
      _curRules2.forEach(function (r) { if (r.id === 'regex_debagu' && r.name === _oldName) { r.name = '去八股词'; _renamed = true; } });
      if (_renamed) { RegexEngine.saveRules(_curRules2); console.log('[Regex] 去八股词规则改名（移除第三方来源标注）'); }
    } catch (e) { /* ignore */ }
    this.renderAll(); this.loadEditorContent(); UIManager.populateAPIFields();
    this.initApiChannels(); // 多渠道供应商：迁移旧配置 + 渲染渠道下拉 + 同步当前渠道
    this.applyEditorFont(); this.applyEditorSize(); if (typeof UIManager.renderMePage === 'function') UIManager.renderMePage();
    const wg = SM().get<any>('writingGuide', '');
    if (wg) document.getElementById('writingGuide')!.value = wg;
    // v31：STM 自动提取已移除，清掉残留值
    try { SM().set('autoExtractMemory', false); SM().set('fullTextContext', false); } catch (e) {}
    // v28：自动时间功能已移除（AI 经常忘记推进），清掉残留值
    try { SM().set('autoUpdateStoryTime', false); } catch (e) {}
    const st = SM().get<any>('streamingOutput', true);
    document.getElementById('streamingOutput')!.checked = st;
    // 思维链开关 + 思考强度（AI 与生成页 / 预设与生成页，写作与写卡共用）
    this._syncThinkingUI();
    // 未闭合思考的归属已固定为「保留在思考框」（旧设置项移除，清掉存档值避免隐形生效）
    try { SM().remove('thinkingUnclosedPolicy'); } catch (e) { /* ignore */ }
    // 联网搜索已整体移除（写卡/讨论的联网开关与搜索 API 配置一起下线），清掉存档值
    try { SM().remove('searchApiConfig'); SM().remove('discussionSearchEnabled'); SM().remove('cardwriterSearchEnabled'); } catch (e) { /* ignore */ }
    // 世界书注入上限固定 10 万字（设置项已移除）：清掉存档里的旧预算值，避免遗留值造成误解
    try { SM().remove('worldbookBudget'); } catch (e) { /* ignore */ }
    // v22：智能检查开关已移除，清掉历史残留值（避免设置在后台隐形生效）；
    // 「另存为」（Web File System Access API，桌面版遗留）连同设置键一起下线
    try { SM().set('smartCheck', false); SM().remove('useSaveAs'); } catch (e) {}
    const _bm25El = document.getElementById('archiveBm25Enabled');
    if (_bm25El) { _bm25El.checked = SM().get<any>('archiveBm25Enabled', true); }
    // 回读预算（BM25 旧正文注入上限）：默认 30000 字；历史用户无存档值时给默认框值 30000
    const _budgetEl = document.getElementById('archiveRecallBudget');
    if (_budgetEl) { (_budgetEl as HTMLInputElement).value = String(SM().get<any>('archiveRecallBudget', 30000)); }
    // 正文窗口（字）：新设置项，默认 5 万字
    const _winEl = document.getElementById('storyWindowChars') as HTMLInputElement | null;
    if (_winEl) _winEl.value = String(App._storyWindowChars());
    try { if (typeof UIManager !== 'undefined' && UIManager.renderCtxBudgetHint) UIManager.renderCtxBudgetHint(); } catch (e) { /* ignore */ }

    // Max Tokens 设置项已移除（输出上限不再由用户设置，一律按端点能接受的最大值发送）：
    // 清掉存档里的旧值与一次性迁移标记，避免遗留值造成误解
    try {
      const _mcfg = SM().get<any>('apiConfig', {});
      if (_mcfg && _mcfg.maxTokens !== undefined) { delete _mcfg.maxTokens; SM().set('apiConfig', _mcfg); }
      SM().remove('_maxTokensMigrated8000');
    } catch (e) { /* ignore */ }
    // 正文窗口改为单一设置（storyWindowChars，默认 5 万字），不再由「模型上下文 tokens × 每 token
    // 字符数」推导：清掉存档里的旧字段，避免遗留值造成误解（旧值本来也不会再被读取）
    try {
      const _ccfg = SM().get<any>('apiConfig', {});
      if (_ccfg && (_ccfg.maxContextTokens !== undefined || _ccfg.charsPerToken !== undefined)) {
        delete _ccfg.maxContextTokens; delete _ccfg.charsPerToken;
        SM().set('apiConfig', _ccfg);
      }
    } catch (e) { /* ignore */ }
    // 同步所有开关的状态指示器（.sw-badge 优先；旧行是「标签 span + 尾随徽标 span」，两种都认）
    const _badgeOf = function (cb: HTMLInputElement): HTMLElement | null {
      const marked = cb.parentElement ? cb.parentElement.querySelector('.sw-badge') : null;
      if (marked) return marked as HTMLElement;
      const last = cb.parentElement ? cb.parentElement.querySelector('span:last-child') : null;
      return last && last !== cb.nextElementSibling ? last as HTMLElement : null;
    };
    document.querySelectorAll('#tab-advanced input[type="checkbox"]').forEach(function (node) {
      const cb = node as HTMLInputElement;
      const _b = _badgeOf(cb);
      if (_b) {
        _b.textContent = cb.checked ? 'ON' : 'OFF';
        _b.style.background = cb.checked ? '#10b981' : '#6b7280';
      }
      cb.addEventListener('change', function (this: HTMLInputElement) {
        const b = _badgeOf(this);
        if (b) {
          b.textContent = this.checked ? 'ON' : 'OFF';
          b.style.background = this.checked ? '#10b981' : '#6b7280';
        }
      });
    });


    const ui = SM().get<any>('uiSettings', {});
    // 主题：优先 ui.theme，兼容旧的 darkMode 字段
    document.body.dataset.theme = ui.theme || (ui.darkMode ? 'dark' : 'light');
    // 文字颜色按钮已移除，清除旧的内联 color（否则会覆盖主题色，导致白天白底白字）
    const _editorEl = document.getElementById('editor');
    if (_editorEl) { try { _editorEl.style.removeProperty('color'); } catch(e) {} }
    document.addEventListener('keydown', (e) => { if ((e.ctrlKey||e.metaKey) && e.key === 's') { e.preventDefault(); App.saveCurrentChapter(); App.toast('已保存'); } });
    UsageStats.render();
    App.toast('BQB Hub 已就绪 ✍');
  },

  getNovelData() {
    const book = BookManager.getActive();
    return book || { title: '', chapters: [{ id: 'ch_1', title: '第1章', content: '', createdAt: Date.now() }], worldSetting: '', currentChapterId: 'ch_1' };
  },
  saveNovelData(data: any) { BookManager.saveActive(data); },
  getCurrentChapter() { const d = this.getNovelData(); return d.chapters.find((c: any) => c.id === d.currentChapterId) || d.chapters[0]; },
  saveCurrentChapter() { if (App._isResetting) return; const d = this.getNovelData(); const idx = d.chapters.findIndex((c: any) => c.id === d.currentChapterId); if (idx >= 0) { d.chapters[idx].content = EditorManager.getContent(); this.saveNovelData(d); } },
  loadEditorContent() { const ch = this.getCurrentChapter(); console.log('[Editor] loadContent: chapter=' + (ch ? ch.id : 'null') + ' contentLen=' + (ch ? (ch.content||'').length : 0) + ' editorAfter=' + EditorManager.getContent().length); EditorManager.setContent(ch ? ch.content : ''); const d = this.getNovelData(); document.getElementById('titleInput')!.value = d.title || ''; },

  // 「最近正文」：从最后一个 AI 段落开头到文末；没有 AI 段落时退化为跨章上下文。
  // 续写注入与比奇的 read_story 都走这里 —— 保证「比奇看到的正文 = 续写注入的正文」。
  collectRecentStoryText(): { recentText: string; fullEditorText: string } {
    var recentText = '';
    var fullEditorText = '';
    var _aiDivs = document.querySelectorAll('#editor .ai-generated');
    if (_aiDivs.length > 0) {
      var _lastDiv = _aiDivs[_aiDivs.length - 1];
      var _lastDivText = (_lastDiv as HTMLElement).innerText || '';
      var _editorEl = document.getElementById('editor');
      var _allText = _editorEl ? (_editorEl.innerText || '') : '';
      fullEditorText = _allText;
      var _lastDivStart = _allText.indexOf(_lastDivText);
      recentText = _lastDivStart >= 0 ? _allText.slice(_lastDivStart) : _lastDivText;
    } else {
      recentText = EditorManager.getCrossChapterContext(8000);
      fullEditorText = recentText;
    }
    return { recentText: recentText, fullEditorText: fullEditorText };
  },
  setEditorFont(key: any) {
    SM().set('editorFont', key);
    this.applyEditorFont();
  },
  // 思考强度（预设与生成页，写作/写卡共用，全局持久化 SM('deepseekThinking')，兼容旧 boolean）：
  // 'auto'（默认，不干预模型）/ 'off' / 'low' / 'medium' / 'high'
  thinkingLevel(): string {
    const v = SM().get<any>('deepseekThinking', 'auto');
    if (v === true || v === 'true') return 'auto';       // 旧"开启"语义 → auto（不干预，保持原行为）
    if (v === false || v === 'false' || v === '0') return 'off'; // 旧"关闭" → off
    if (v === 'off' || v === 'low' || v === 'medium' || v === 'high') return v;
    return 'auto';
  },
  _rememberThinkLevel(lv: string) {
    if (lv !== 'off') SM().set('deepseekThinkingLast', lv);
  },
  setThinkingLevel(level: string) {
    const lv = (level === 'off' || level === 'low' || level === 'medium' || level === 'high') ? level : 'auto';
    this._rememberThinkLevel(this.thinkingLevel());
    SM().set('deepseekThinking', lv);
    this._syncThinkingUI();
    const label = lv === 'auto' ? '自动（由模型决定）' : lv === 'off' ? '关闭（不思考）' : lv + '强度思考';
    App.toast('思考强度：' + label);
  },

  // 思维链开关（AI 与生成页）：开 = 先把思考显示在蓝色思考框里、再出正文；
  // 关 = 不注入思考协议也不建思考框，等到正文才开始出字。
  // 与「思考强度」共用同一份状态（SM 'deepseekThinking'）：关 → 'off'，重开时恢复关之前的档位。
  thinkingChainEnabled(): boolean { return this.thinkingLevel() !== 'off'; },
  setThinkingChainEnabled(on: boolean) {
    if (on) {
      const last = SM().get<any>('deepseekThinkingLast', 'auto');
      const lv = (last === 'low' || last === 'medium' || last === 'high') ? last : 'auto';
      SM().set('deepseekThinking', lv);
      App.toast('思维链：开（先显示思考，再出正文）');
    } else {
      this._rememberThinkLevel(this.thinkingLevel());
      SM().set('deepseekThinking', 'off');
      App.toast('思维链：关（不显示思考，直接出正文）');
    }
    this._syncThinkingUI();
  },
  setStreamingOutput(v: boolean) {
    SM().set('streamingOutput', !!v);
    App.toast(v ? '流式输出：开（边生成边显示）' : '流式输出：关（整段生成完再显示）');
  },
  _syncThinkingUI() {
    const el = document.getElementById('deepseekThinking');
    const tag = document.getElementById('deepseekThinkingTag');
    const lv = this.thinkingLevel();
    if (el) (el as HTMLInputElement).value = lv;
    if (tag) {
      const label = lv === 'auto' ? '自动' : lv === 'off' ? '关' : lv === 'low' ? '低' : lv === 'high' ? '高' : '中';
      tag.textContent = label;
      tag.style.background = lv === 'off' ? '#ef4444' : (lv === 'auto' ? '#6b7280' : 'var(--primary)');
    }
    const tcb = document.getElementById('thinkingChainEnabled') as HTMLInputElement | null;
    if (tcb) { tcb.checked = lv !== 'off'; this._syncToggleBadge(tcb); }
    const scb = document.getElementById('streamingOutput') as HTMLInputElement | null;
    if (scb) { scb.checked = SM().get<any>('streamingOutput', true); this._syncToggleBadge(scb); }
  },
  // 开关行右侧的 ON/OFF 徽标（.sw-badge；兼容旧「标签 span + 尾随徽标」结构）
  _syncToggleBadge(cb: HTMLInputElement) {
    const marked = cb.parentElement ? cb.parentElement.querySelector('.sw-badge') : null;
    const last = cb.parentElement ? cb.parentElement.querySelector('span:last-child') : null;
    const badge = marked || (last && last !== cb.nextElementSibling ? last : null);
    if (badge) {
      (badge as HTMLElement).textContent = cb.checked ? 'ON' : 'OFF';
      (badge as HTMLElement).style.background = cb.checked ? '#10b981' : '#6b7280';
    }
  },
  // 协议自愈：该 endpoint|model 连续未闭合被判定为"不吃标签协议" → 不再建思考框
  thinkBoxDisabledForModel(): boolean {
    try {
      const k = _thinkStreakKey();
      return !!(k && SM().get<any>(k + '_off', false));
    } catch (e) { return false; }
  },

  // ==================== 多渠道供应商（渠道 = endpoint/key/model/价格，独立于预设参数） ====================
  getApiChannels(): any[] { return SM().get<any[]>('apiChannels', []) || []; },
  saveApiChannels(arr: any[]) { SM().set('apiChannels', arr); },
  getActiveChannel(): any {
    const id = SM().get<string>('activeApiChannelId', '');
    const chs = this.getApiChannels();
    return chs.find((c: any) => c.id === id) || chs[0] || null;
  },

  // 启动时初始化：旧 apiConfig（单一配置）→ 自动迁移为"默认供应商"渠道
  initApiChannels() {
    let chs = this.getApiChannels();
    if (chs.length === 0) {
      const cfg = SM().get<any>('apiConfig', {});
      if (cfg.endpoint || cfg.apiKey) {
        const host = String(cfg.endpoint || '').replace(/^https?:\/\//, '').split('/')[0] || '默认供应商';
        chs = [{
          id: 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name: host, endpoint: cfg.endpoint || '', apiKey: cfg.apiKey || '', model: cfg.model || '',
          priceInput: cfg.priceInput ?? 1, priceCached: cfg.priceCached ?? 0.1, priceOutput: cfg.priceOutput ?? 2,
          recentModels: cfg.model ? [cfg.model] : []
        }];
        this.saveApiChannels(chs);
        SM().set('activeApiChannelId', chs[0].id);
      }
    }
    this.renderChannelSelect();
    this.applyActiveChannel();
  },

  // 渲染渠道下拉（已保存渠道 + 固定"添加供应商"项）；选中已有渠道时显示删除按钮
  renderChannelSelect() {
    const sel = document.getElementById('apiChannelSelect') as HTMLSelectElement | null;
    if (!sel) return;
    const chs = this.getApiChannels();
    const cur = SM().get<string>('activeApiChannelId', '');
    sel.innerHTML = chs.map((c: any) =>
      `<option value="${c.id}" ${c.id === cur ? 'selected' : ''}>${htmlEscape(c.name || '未命名')}</option>`
    ).join('') + `<option value="__add__">＋ 添加供应商</option>`;
    const del = document.getElementById('apiChannelDelete');
    if (del) del.style.display = chs.length > 0 ? '' : 'none';
    const nameEl = document.getElementById('apiChannelName') as HTMLInputElement | null;
    const ch = this.getActiveChannel();
    if (nameEl && ch) nameEl.value = ch.name || '';
  },

  // 渠道下拉选择：已有渠道 → 切换生效；"添加供应商" → 新建空白渠道
  selectChannel() {
    const sel = document.getElementById('apiChannelSelect') as HTMLSelectElement | null;
    if (!sel) return;
    const v = sel.value;
    if (v === '__add__') { this.addChannel(); return; }
    SM().set('activeApiChannelId', v);
    this.applyActiveChannel();
  },

  // 新建渠道：空白表单供用户配置，字段修改自动保存
  addChannel() {
    const chs = this.getApiChannels();
    const ch: any = {
      id: 'ch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: '新供应商', endpoint: '', apiKey: '', model: '',
      priceInput: 1, priceCached: 0.1, priceOutput: 2, recentModels: []
    };
    chs.push(ch);
    this.saveApiChannels(chs);
    SM().set('activeApiChannelId', ch.id);
    this.renderChannelSelect();
    // 表单清空，聚焦地址输入框
    const setV = (id: string, v: any) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = v ?? ''; };
    setV('apiChannelName', ''); setV('apiEndpoint', ''); setV('apiKey', ''); setV('apiModelSelect', ''); setV('apiModelManual', '');
    setV('priceInput', ''); setV('priceCached', ''); setV('priceOutput', '');
    this.renderModelSelect('');
    const ep = document.getElementById('apiEndpoint') as HTMLInputElement | null;
    if (ep) ep.focus();
    App.toast('已新建供应商，填写地址与密钥后自动生效');
  },

  // 端点地址净化：实现见 lib/endpoint.ts（api.ts 用同一份）。除不可见字符/空白/全角冒号外，
  // 还会把误粘的接口后缀（/chat/completions、/models…）退回基址——以前只清空白，用户直接粘
  // 文档里的完整请求地址时会拼成 .../chat/completions/chat/completions → 404。
  sanitizeEndpoint(raw: any): string {
    return sanitizeEndpointUrl(raw);
  },

  // 渠道字段自动保存（地址/密钥/名称/价格等）：修改即写回渠道 + 同步 apiConfig
  saveChannelField(field: string, value: any) {
    const ch = this.getActiveChannel();
    if (!ch) return;
    ch[field] = String(value ?? '');
    if (field === 'endpoint') {
      const cleaned = this.sanitizeEndpoint(value);
      if (cleaned !== ch[field]) {
        ch[field] = cleaned;
        App.toast('已自动清理地址中的空格/全角字符');
      }
      const host = String(cleaned || '').replace(/^https?:\/\//, '').split('/')[0];
      if (host && (!ch.name || ch.name === '新供应商')) ch.name = host;
    }
    this._syncChannelToAPIConfig(ch);
    if (field === 'endpoint') {
      const epEl = document.getElementById('apiEndpoint') as HTMLInputElement | null;
      if (epEl) epEl.value = ch.endpoint || '';
    }
    const nameEl = document.getElementById('apiChannelName') as HTMLInputElement | null;
    if (nameEl && field !== 'name') nameEl.value = ch.name || '';
    this.renderChannelSelect();
    // 地址/密钥变化 → 重新检测模型列表
    if (field === 'endpoint' || field === 'apiKey') this.refreshChannelModels();
  },

  // 删除当前供应商渠道（确认后删除，切到剩余第一个）
  deleteChannel() {
    const ch = this.getActiveChannel();
    if (!ch) return;
    const nm = ch.name || '未命名';
    UIManager.showConfirm('删除供应商「' + nm + '」？该渠道的地址、密钥与价格配置将一并删除。', () => {
      const rest = this.getApiChannels().filter((c: any) => c.id !== ch.id);
      this.saveApiChannels(rest);
      if (rest.length > 0) SM().set('activeApiChannelId', rest[0].id);
      else SM().set('activeApiChannelId', '');
      this.renderChannelSelect();
      if (rest.length > 0) this.applyActiveChannel();
      else {
        const setV = (id: string, v: any) => { const el = document.getElementById(id) as HTMLInputElement | null; if (el) el.value = v ?? ''; };
        ['apiChannelName', 'apiEndpoint', 'apiKey', 'apiModelSelect', 'apiModelManual', 'priceInput', 'priceCached', 'priceOutput'].forEach((id) => setV(id, ''));
      }
      App.toast('已删除供应商');
    });
  },

  // 把当前渠道 endpoint/key/model/价格 同步进 apiConfig（其余代码零改动即生效）
  _syncChannelToAPIConfig(ch: any) {
    const cfg = SM().get<any>('apiConfig', {});
    SM().set('apiConfig', {
      ...cfg,
      endpoint: ch.endpoint || '', apiKey: ch.apiKey || '', model: ch.model || '',
      priceInput: ch.priceInput ?? 1, priceCached: ch.priceCached ?? 0.1, priceOutput: ch.priceOutput ?? 2
    });
  },

  // 切换渠道：同步 apiConfig + 填充全部表单 + 触发模型检测
  applyActiveChannel() {
    const ch = this.getActiveChannel();
    if (!ch) { UIManager.populateAPIFields(); return; }
    this._syncChannelToAPIConfig(ch);
    const setV = (id: string, v: any) => { const el = document.getElementById(id); if (el) (el as HTMLInputElement).value = v ?? ''; };
    setV('apiChannelName', ch.name || '');
    setV('apiEndpoint', ch.endpoint || '');
    setV('apiKey', ch.apiKey || '');
    setV('priceInput', ch.priceInput ?? 1);
    setV('priceCached', ch.priceCached ?? 0.1);
    setV('priceOutput', ch.priceOutput ?? 2);
    this.renderChannelSelect();
    this.renderModelSelect(ch.model || '');
    UIManager.populateAPIFields(); // 温度/上下文等参数表单
    this.refreshChannelModels();  // 自动检测模型列表
  },

  // 渲染模型下拉：渠道已检测/最近使用的模型 → 下拉；未检测到 → 显示手动输入框
  renderModelSelect(currentModel: string) {
    const sel = document.getElementById('apiModelSelect') as HTMLSelectElement | null;
    const manual = document.getElementById('apiModelManual') as HTMLInputElement | null;
    if (!sel) return;
    const ch = this.getActiveChannel();
    const models = (ch && ch.models) || [];
    const recent = (ch && ch.recentModels) || [];
    const all: string[] = [];
    [...recent, ...models].forEach((m: any) => { if (m && all.indexOf(m) < 0) all.push(m); });
    if (all.length > 0) {
      sel.innerHTML = all.map((m: string) =>
        `<option value="${htmlEscape(m)}" ${m === currentModel ? 'selected' : ''}>${htmlEscape(m)}</option>`
      ).join('');
      if (manual) { manual.style.display = 'none'; manual.value = currentModel || ''; }
      sel.style.display = '';
    } else {
      sel.innerHTML = '<option value="">（未检测到模型，请手动输入）</option>';
      sel.style.display = 'none';
      if (manual) { manual.style.display = ''; manual.value = currentModel || ''; }
    }
  },

  // 模型选择保存（下拉选择 / 手动输入共用）：写入渠道 + apiConfig
  saveChannelModel(model: string) {
    const ch = this.getActiveChannel();
    if (!ch) return;
    ch.model = model;
    const rec = ch.recentModels || [];
    if (model && rec.indexOf(model) < 0) { rec.unshift(model); if (rec.length > 8) rec.length = 8; }
    ch.recentModels = rec;
    this.saveApiChannels(this.getApiChannels());
    this._syncChannelToAPIConfig(ch);
    if (typeof this.matchModelPricing === 'function') this.matchModelPricing();
  },

  // 重新检测当前渠道的模型列表（GET /models，代理/原生回退）——区分 401（密钥无效）与
  // 不支持 /models（404/405），分别给出明确提示，不再静默"刷新没反应"
  async refreshChannelModels() {
    const ch = this.getActiveChannel();
    if (!ch || !ch.endpoint || !ch.apiKey) { App.toast('请先填写 API 地址与 Key'); return; }
    const sel = document.getElementById('apiModelSelect') as HTMLSelectElement | null;
    if (sel) sel.innerHTML = '<option value="">检测模型中…</option>';
    let models: string[] = [];
    let status = 0;
    try {
      const r = await APIHandler.fetchModels({ endpoint: ch.endpoint, apiKey: ch.apiKey });
      models = r.models || []; status = r.status || 0;
    } catch (e) { models = []; status = 0; }
    const ch2 = this.getActiveChannel();
    if (!ch2 || ch2.id !== ch.id) return; // 期间切换了渠道则丢弃
    ch2.models = models;
    this.saveApiChannels(this.getApiChannels());
    this.renderModelSelect(ch2.model || '');
    if (models.length > 0) {
      App.toast('检测到 ' + models.length + ' 个模型');
    } else if (status === 401) {
      App.toast('API Key 无效（401）：请检查密钥是否正确或已过期');
    } else if (status === 404 || status === 405) {
      App.toast('该接口不支持 /models 列表，可手动输入模型名');
    } else {
      App.toast('未能连接或未返回模型列表，可手动输入模型名');
    }
  },
  applyEditorFont() {
    const root = document.documentElement;
    const key = SM().get<any>('editorFont', 'system');
    const f = this.EDITOR_FONTS.find((x: any) => x.key === key);
    // 全局字体：body 与编辑器都引用 --font（写卡/讨论/社区消息同源）
    if (f && f.family) root.style.setProperty('--font', f.family);
    else root.style.removeProperty('--font');
    const ed = document.getElementById('editor');
    if (ed) {
      if (f && f.family) ed.style.fontFamily = f.family;
      else ed.style.removeProperty('font-family');
    }
    if (typeof UIManager !== 'undefined' && typeof UIManager.renderMePage === 'function') UIManager.renderMePage();
  },
  setEditorSize(px: any) {
    SM().set('editorFontSize', px);
    this.applyEditorSize();
  },
  applyEditorSize() {
    const px = parseInt(SM().get<any>('editorFontSize', 16), 10) || 16;
    // 全局字号：body、编辑器、写卡/讨论/社区消息统一引用 --font-size
    document.documentElement.style.setProperty('--font-size', px + 'px');
    const ed = document.getElementById('editor');
    if (ed) ed.style.removeProperty('font-size');
    if (typeof UIManager !== 'undefined' && typeof UIManager.renderMePage === 'function') UIManager.renderMePage();
  },
  renderAll() { UIManager.renderBooks(); UIManager.renderChapters(); UIManager.renderProtagonists(); UIManager.renderWorldBooks(); UIManager.renderPlugins(); UIManager!.renderPresets(); UIManager!.renderRegexRules(); UIManager!.populateSystemPromptUI(); const d = this.getNovelData(); document.getElementById('titleInput')!.value = d.title || ''; },
  // Protagonist
  getProtagonist() {
    return ProtagonistManager.getActive() || {};
  },


  updateWordCount() {
    document.getElementById('wordCount')!.textContent = EditorManager.getPlainText().replace(/\s/g, '').length;
  },

  switchChapter(chId: any) {
    this.saveCurrentChapter();
    const d = this.getNovelData();
    d.currentChapterId = chId;
    this.saveNovelData(d);
    // Agent 设定同步：切章强制结算一批（新章开头用新设定最干净）
    if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled()) {
      try { SettingSyncManager.requestChapterReview(); } catch (e) { /* ignore */ }
    }
    this.loadEditorContent();
    UIManager.renderChapters();
    if (MobileUI.isMobile) MobileUI.switchView('writing');
  },
  newChapter() { this.saveCurrentChapter(); const d = this.getNovelData(); const n = d.chapters.length + 1; const nc = { id: 'ch_' + Date.now(), title: '第' + n + '章', content: '', createdAt: Date.now() }; d.chapters.push(nc); d.currentChapterId = nc.id; this.saveNovelData(d); this.loadEditorContent(); UIManager.renderChapters(); App.toast('已创建新章节'); },
  // Book management
  newBook() { const title = prompt('请输入书名:'); if (title && title.trim()) { const _nwb = WorldBookManager.createBook(title.trim()); if (typeof BiqiAgent !== 'undefined' && BiqiAgent.reloadForBook) BiqiAgent.reloadForBook(); App.loadEditorContent(); App.renderAll(); UIManager.renderWorldBooks(); const _nb = SM().get<any>('uiSettings', {}); SM().set('uiSettings', _nb); SM().set('writingGuide', ''); App.toast('已创建新小说: ' + title.trim()); if (_nwb && _nwb.id && typeof UIManager.pickBookCover === 'function') { App.toast('可为新书选择一张封面（取消使用默认）'); UIManager.pickBookCover(_nwb.id); } } },
  renameBook() { const wb = WorldBookManager.getActive(); if (!wb) return; const name = prompt('请输入新书名:', wb.name); if (name && name.trim()) { BookManager.renameBook(name.trim()); UIManager.renderWorldBooks(); document.getElementById('titleInput')!.value = name.trim(); App.toast('书名已更新'); } },
  deleteBook() { const wbs = WorldBookManager.getAll(); if (wbs.length <= 1) { App.toast('至少保留一本书'); return; } const wb = WorldBookManager.getActive(); if (!wb) return; UIManager.showConfirm('确定删除"' + (wb.name || wb.title) + '"及其所有章节和记忆？此操作不可恢复。', () => { BookManager.deleteBook(); UIManager.renderWorldBooks(); App.toast('书已删除'); }); },

  resetBook() {
    const book = BookManager.getActive();
    if (!book) return;
    UIManager.showConfirm('确定重置"' + book.title + '"？此操作将清空：所有章节内容、登场角色、主角动态描写。书名、主角设定、世界书将保留。此操作不可恢复。', () => {
      // Suppress auto-save during reset
      clearTimeout(EditorManager.saveTimer);
      App._isResetting = true;
      // 1. Clear data via managers (each syncs to book)
      if (typeof DatabaseManager !== 'undefined') DatabaseManager.clear();
      SM().set('writingGuide', '');
      // Agent 设定同步临时层随书重置：清 overlay（临时修改/新增/停用）+ 待裁决 + 快照 + meta，原书条目保留
      if (typeof SettingSyncManager !== 'undefined') {
        try { SettingSyncManager.resetAll(); } catch (e) { /* ignore */ }
      }
      // Preserve world book synced characters
      const _activeWb = WorldBookManager.getActive();
      let _preservedChars: any[] = [];
      if (_activeWb) {
        _preservedChars = CharacterManager.getByWorldBook(_activeWb.id).filter(function (c: any) { return c.wbId; });
      }
      CharacterManager.saveAll([]);
      VariableManager.clear();
      // 2. Reset worldbook chapters（世界书=小说，直接改当前 worldbook）
      const _wbReset = WorldBookManager.getActive();
      if (_wbReset) {
        _wbReset.chapters = [{ id: 'ch_' + Date.now(), title: '第1章', content: '', createdAt: Date.now() }];
        _wbReset.currentChapterId = _wbReset.chapters[0].id;
        _wbReset.characters = [];
        _wbReset.writingGuide = '';
        WorldBookManager.saveNovelData(_wbReset);
      }
      // Restore preserved locked characters
      if (_preservedChars.length > 0) {
        const _wb2 = WorldBookManager.getActive();
        if (_wb2) {
          _wb2.characters = JSON.parse(JSON.stringify(_preservedChars));
          CharacterManager.saveAll(JSON.parse(JSON.stringify(_preservedChars)));
          WorldBookManager.saveNovelData(_wb2);
        }
        App.toast('\u5df2\u4fdd\u7559 ' + _preservedChars.length + ' \u540d\u9501\u5b9a\u89d2\u8272');
      }
      // 3. Clear editor silently (bypass onInput side effects)
      if (EditorManager.editorEl) {
        EditorManager.editorEl.innerHTML = '';
        EditorManager.highlightDialogue();
        App.updateWordCount();
      }
      // Clear writingGuide textarea
      var wgTa = document.getElementById('writingGuide');
      if (wgTa) wgTa.value = '';
      // 4. Full UI refresh from localStorage
      App.renderAll();
      if (document.getElementById('pluginFullscreen') && document.getElementById('pluginFullscreen')!.style.display === 'flex') {
        UIManager.renderDatabase();
      }
      App.toast('本书已重置');
      App._isResetting = false;
    });
  },
  deleteChapter(chId: any) { const d = this.getNovelData(); if (d.chapters.length <= 1) { App.toast('至少保留一个章节'); return; } UIManager.showConfirm('确定删除该章节？', () => { const d2 = App.getNovelData(); const idx = d2.chapters.findIndex((c: any) => c.id === chId); if (idx >= 0) { d2.chapters.splice(idx, 1); if (d2.currentChapterId === chId) d2.currentChapterId = d2.chapters[0].id; App.saveNovelData(d2); App.loadEditorContent(); UIManager.renderChapters(); App.toast('章节已删除'); } }); },

  // Core AI generation with world book support

  async generate(mode: any) {
    if (this.isGenerating) return;
    const apiConfig = PresetManager.getActiveAPIConfig();
    if (!apiConfig.apiKey) { App.toast('请先在高级设置中配置 API Key'); return; }
    this.isGenerating = true;
    console.log('[Generate] editor content length:', EditorManager.getContent().length, 'plainText length:', EditorManager.getPlainText().length);
    console.log('[Generate] START mode=' + mode);
	    // Save editor snapshot for undo
	    // （这里不再自增 _dbEpoch：新生成不该作废飞行中的填表结果，见 _dbEpoch 字段注释）
	    this._undoSnapshot = document.getElementById('editor')!.innerHTML;
	    // 记录上一轮草稿（场景草稿=底部输入/面板「扩写并续写」共用），撤回时恢复到输入栏
	    this._undoInputDraft = (document.getElementById('writingGuide') ? document.getElementById('writingGuide')!.value.trim() : '') || '';
	    // 记忆数据库快照：撤回续写时一并回滚填表写入
	    if (typeof DatabaseManager !== 'undefined') {
	      try { this._undoDBSnapshot = JSON.parse(JSON.stringify(DatabaseManager.getDB())); }
	      catch(e) { this._undoDBSnapshot = null; }
	    } else {
	      this._undoDBSnapshot = null;
	    }
	    this._saveVarSnapshot();
	    UsageStats.beginSession();
	    // 记录当前续写编号
	    this._lastContNumber = (SM().get<any>('uiSettings', {}).totalContinuationCount || 0) + 1;
    const statusEl = document.getElementById('generationStatus');
    statusEl!.innerHTML = '<span class="spinner-dark"></span> AI 正在创作中...';
    document.getElementById('btnStop')!.style.display = 'block';

    // Get system prompt — use modules if available, fall back to legacy system prompt
    let systemPrompt = '';
    let creativityLevel = 'moderate';
    const _genPreset = PresetManager.getCurrentPreset();
    // 原生推理模型检测（提前到 systemPrompt 构造前）：deepseek/opencode/kimi 等自带
    // reasoning_content 通道的模型，不需要也不应被要求输出文本思维标签
    // （<thinking>/</thinking> 或 <!-- 梳理 -->）——那是给无原生推理模型的旧式写法。
    // 两套机制叠加正是「正文进思维链 / 正文重复」的根因：模型一边走原生思考、
    // 一边又被预设逼着把思考文本输出到正文，结果把正文包进 thinking 标签或输出两遍。
    const _modelNameLower = (PresetManager.getActiveAPIConfig().model || '').toLowerCase();
    const _hasNativeReasoning = /deepseek|opencode|ark\.|v3|v4|kimi|glm|qwen|moonshot|volc|dashscope|ark\.cn-beijing/.test(_modelNameLower);
    if (_genPreset) {
      if (_genPreset.creativity) creativityLevel = _genPreset.creativity;
      if (_genPreset.promptModules && _genPreset.promptModules.some(function (m: any) { return m.enabled; })) {
        systemPrompt = _genPreset.promptModules
          .filter(function (m: any) {
            if (!m.enabled || (m.role && m.role !== 'system')) return false;
            return true;
          })
          .sort(function (a: any, b: any) { return (a.order || 0) - (b.order || 0); })
          .map(function (m: any) { return m.content; })
          .join('\n\n');
      }
    }
    if (!systemPrompt) systemPrompt = PresetManager.getActiveSystemPrompt();
    // Replace {user}/{{user}}/bare user with protagonist name
    const _genProtag = this.getProtagonist();
    const _genProtagName = (_genProtag && _genProtag.name) ? _genProtag.name : '主角';
    systemPrompt = systemPrompt.replace(/{{user}}/gi, _genProtagName).replace(/{user}/gi, _genProtagName).replace(/user/gi, _genProtagName);
    let _effectiveSP = systemPrompt;
                // 思考强度为 off 时：提示词强制禁止思考（对任何模型生效的兜底）
                if (this.thinkingLevel() === 'off') {
          _effectiveSP += '\n\n【深度思考已关闭】禁止进行任何显式思考/推理/分析过程，直接输出正文，不要输出任何思考内容、思维链或相关标签。';
        }
                if (creativityLevel === "strict") {
          _effectiveSP += '\n\n【重要】禁止出现世界书设定中不存在的有名有姓的角色和具体地点名称。所有场景和人物必须严格来自世界书设定或已出场角色。';
        } else if (creativityLevel === "moderate") {
          _effectiveSP += '\n\n【重要】允许无名的龙套角色（如上班族、路人、店员）和宽泛场景（如酒吧、街道），但禁止出现世界书不存在的有名角色和具体地名。';
        }

    const d = this.getNovelData();
    const protagonist = this.getProtagonist();
    const _charDescChars = 300;
    // ==== 统一水位线模式（全文模式已移除）：窗口 = 设定值，1.5 倍触发滚动 ====
    const _storyWin = App._storyWindowChars();
    const _wWater = _storyWin;
    const _wTrig = storyWindowTrigger(_storyWin);

    // 从最后一个 AI 段落的开头到编辑器末尾 = 完整连续上下文
    var _storyCtx = this.collectRecentStoryText();
    var recentText = _storyCtx.recentText;
    var _fullEditorText = _storyCtx.fullEditorText; // 完整编辑器文本（用于向量检索）
    // ===== 统一水位线：全书正文 = 窗口块（只增不改，≤50%预算）+ 滚动区 =====
    var _canonicalText = EditorManager.getFullNovelText(1000000); // 不截断（块拆分自带上限）
    var _win = Waterline.update(_canonicalText, _wWater, _wTrig);
    var _frozenText = _win.frozen;
    var _rollingText = _canonicalText.slice((_win.x || 0) + _win.head);
    console.log('[Waterline] 窗口', _win.blockCount, '块/', _frozenText.length, '字 | 滚动区', _rollingText.length, '字 | 归档', ArchiveStore.count(), '块');

    let userInstruction = '';
    switch (mode) {
      case 'autoContinue':
        // 叙事视角**只由预设的「视角」条目决定**（内置预设的 min_09..min_12 四条，见 preset.ts），
        // 这里不再按"有没有主角"注入视角指令。原因：App 硬编码的视角声明会与预设的视角条目
        // 同时下发，而它在 user 消息里、靠后且带【指令】标签，往往把预设盖掉 → 视角自相矛盾
        // （默认预设开「第一人称」＋未选主角时必踩）。另外用户自带的预设未必有可识别的"视角"
        // 字样，App 也无从判断该不该让位——所以干脆不表态。
        // 主角只决定 {{user}} 展开成谁、以及主角资料是否注入，与视角无关。
        // 末尾那句「收尾」是预设条目「反 AI 味」（preset.ts 的 min_20_ai_flavor）的强化：
        // 模型写长文时对 system 里禁令的服从度会随篇幅下滑，而章末升华/预告是最扎眼的 AI 味；
        // user 指令贴着生成位置，对指令遵循差的模型更管用。
        userInstruction = '请根据以上内容续写。请严格遵循世界书中各角色的设定，角色卡中的【行为铁则】高于一切其他设定。'
          + '\n收尾停在动作、对白或画面上，不要总结、升华，也不要预告后文。';
        break;
      case 'expandDraft':
        const draft = document.getElementById('writingGuide')!.value.trim();
        if (!draft) { App.toast('请先在场景草稿中输入内容'); App._endGenerating(); statusEl!.textContent = ''; return; }
        userInstruction = '请将以下场景草稿扩写为完整的轻小说段落，然后继续续写：\n\n【场景草稿】\n' + draft + '\n\n扩写规则：\n1. 括号（）中的内容 → 扩写为细腻的心理描写\n2. 「」中的对话 → 扩写为完整对话场景，添加动作、表情和氛围描写\n3. （注：...）中的内容 → 作为新增设定融入叙事，不要让角色知道这些信息\n4. 严格遵循世界书中所有角色的设定，角色卡中的【行为铁则】高于一切其他设定，不得违反角色性格、说话方式等设定\n5. 以上内容扩写完成后自然续写，无需刻意留下钩子或悬念';
        break;
    }

    // 字数限制完全交给预设条目（system prompt）控制，此处不干预输出长度

    userInstruction += '\n\n【语言要求】全程使用中文输出，专有名词（角色名、地名、作品名等）除外。不得因上下文出现外语而切换输出语言。';

    // 若系统提示词要求显性思维链（写作过程/梳理），在指令尾部追加强化。
    // user 指令位于消息末尾、紧贴生成位置，对豆包等指令遵循差的模型比写在
    // 系统提示词里更有效。
    // 原生推理通道判定：DeepSeek 系（deepseek/opencode/ark/v3/v4 等）走 API 原生
    // reasoning_content 通道（思考与正文天然分离），【不再要求它在正文里输出
    //  thinking/<!-- 梳理 --> 标签】——这正是「酒馆不炸」的原因：思考走原生通道，
    // 正文永远在 content，不存在标签漏闭合/外露/吞正文的问题。仅对没有原生推理
    // 通道的模型（豆包/Claude 等）才追加正文标签指令。
    // 预设是否要求模型先梳理（writing_process/梳理字样）再写正文
    var _thinkingRequired = /writing_process|<!--\s*梳理|梳理：/.test(_effectiveSP);
    // 无原生思考通道的模型（豆包/Claude/部分 qwen/glm 等）：思考只能写进正文文本。
    // 统一追加「思考放 <thinking> 标签」指令，把文本思考收敛到编辑器流式状态机认得的
    // 通用标记上（<thinking>…</thinking>），流式期间即被切进思考框，正文不残留——
    // 不再依赖任何预设私有起止语（吾有一梦/<!-- 梳理 --> 等）的代码特判。
    if (!_hasNativeReasoning) {
      if (_thinkingRequired) {
        // 预设要求先梳理：明确要求把梳理过程放 <thinking> 标签内、正文之前
        // 豆包指令遵循差：追加更硬措辞，明确第一个字符必须是 <
        var _hardExtra = _modelNameLower.indexOf('doubao') >= 0
          ? '\n5. 回复必须从 `<thinking>` 开始（第一个字符就是 `<`），禁止以任何普通文字或句子开头，否则本次回复无效。'
          : '';
        userInstruction += '\n\n【输出顺序·最高优先级】\n' +
          '1. 本次回复必须先从 `<thinking>` 开始的标签中，完整执行写作过程要求的全部梳理步骤（禁止省略、禁止偷懒；长度不限，但每步只写结论，不要在思考里写正文、对白或场景描写——正文只在思考结束后写一次）。\n' +
          '2. 梳理结束后，用单独一行的 `</thinking>` 闭合标签。\n' +
          '3. 闭合后另起一行，以 `【正文】` 开头（这四个字符只允许出现这一次），紧接着输出中文正文。\n' +
          '4. 严禁跳过梳理直接输出正文。' + _hardExtra +
          '\n\n【输出格式示例·严格模仿这个结构，不要照抄文字】\n' +
          '<thinking>\n' +
          '[把写作过程要求的各项梳理逐项写在这里：剧情设计、剧情推理、格式检查、世界书审查等]\n' +
          '</thinking>\n' +
          '【正文】\n' +
          '[正文从这里开始，直接从场景切入，不解释、不铺垫]';
      } else {
        // 预设未要求梳理：模型仍可能自行推理（聪明模型常如此）——约束其放标签内，正文只留正文
        userInstruction += '\n\n【思考格式要求】\n' +
          '如果你需要推理/思考（剧情走向、设定核对、语气斟酌等），请把全部思考内容放在 `<thinking>…</thinking>` 标签内、置于正文之前（长度不限，但只写结论与要点，不要在思考里写正文草稿、对白或场景描写）；`</thinking>` 单独一行闭合，之后另起一行以 `【正文】` 开头再输出正文，正文中不得出现任何思考、推理或分析内容。不需要思考时直接输出正文。';
      }
    }

    // Agent 设定同步插件（widget shell=agent）：续写同调用附带 SETTING_DELTA 提议块。
    // best-effort：模型写错格式就静默丢弃，不重试。必须早于 _probe，否则检索门控看不到新指令。
    if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled()) {
      try { userInstruction += SettingSyncManager.buildTailInstruction(); } catch (e) { /* 旁路失败忽略 */ }
    }

    userInstruction = RegexEngine.applyRules(userInstruction, 'before');

    // Build protagonist context
    let charCtx = '';
    if (protagonist.name) {
      charCtx = '## 主角设定\n';
      charCtx += `- 姓名：${protagonist.name}\n`;
      if (protagonist.gender) charCtx += `- 性别：${protagonist.gender}\n`;
      if (protagonist.age) charCtx += `- 年龄：${protagonist.age}\n`;
      if (protagonist.occupation) charCtx += `- 职业：${protagonist.occupation}\n`;
      if (protagonist.personality) charCtx += `- 性格：${protagonist.personality}\n`;
      if (protagonist.appearance) charCtx += `- 外貌：${protagonist.appearance}\n`;
      if (protagonist.abilities) charCtx += `- 能力：${protagonist.abilities}\n`;
      if (protagonist.backstory) charCtx += `- 背景：${protagonist.backstory}\n`;
      if (protagonist.catchphrase) charCtx += `- 口头禅：${protagonist.catchphrase}\n`;
    }
        // === Always-inject characters (stable prefix, cached) ===
    let _alwaysCharCtx = '';
    const _allChars = CharacterManager.getAll();
    const __wb = WorldBookManager.getActive();
    const __alwaysNames = new Set();
    if (__wb && __wb.entries) {
      __wb.entries.forEach(function (e) {
        if (e.inject !== false && e.type === '角色' && e.name) {
          __alwaysNames.add(e.name.trim());
        }
      });
    }
    const __alwaysChars = __alwaysNames.size > 0 ? _allChars.filter(function (c) { return c.wbId && c.wbId === __wb!.id && __alwaysNames.has(c.name); }) : [];
    if (__alwaysChars.length > 0) {
      _alwaysCharCtx = '\n## 常驻角色\n';
      __alwaysChars.forEach(function (c) {
        var _parts = [c.name];
        if (c.gender) _parts.push(c.gender);
        if (c.age) _parts.push(c.age + '岁');
        if (c.relation) _parts.push(c.relation);
        if (c.description) _parts.push(c.description.length > _charDescChars ? c.description.slice(0, _charDescChars) + '…' : c.description);
        _alwaysCharCtx += '- ' + _parts.join(' | ') + '\n';
      });
    }

    // Add character descriptions for chars appearing in recent text
    let extraCharCtx = '';
    const _wgText = document.getElementById('writingGuide')!.value;
    const _searchText = (recentText || '') + ' ' + (_wgText || '');
    const _mentionedChars = _allChars.filter(function (c) { return c.name && c.name.length >= 2 && _searchText.indexOf(c.name) >= 0 || (c.alias && c.alias.split(',').some(function (a: any) { return a.trim().length >= 2 && _searchText.indexOf(a.trim()) >= 0; })); });
    const _tempLockMap = new Map();
    _mentionedChars.forEach(function (c) { _tempLockMap.set(c.id, 5); });
    const _tempLockedChars = _allChars.filter(function (c) { return _tempLockMap.has(c.id); });
    const _seenIds = new Set();
    // Prevent always-inject characters from duplicating in extraCharCtx
    __alwaysChars.forEach(function (c) { _seenIds.add(c.id); });
    const _mergedChars: any[] = [];
    _tempLockedChars.concat(_mentionedChars).forEach(function (c) {
      if (!_seenIds.has(c.id)) {
        _seenIds.add(c.id);
        _mergedChars.push(c);
      }
    });
    if (_mergedChars.length > 0) {
      extraCharCtx = '\n## 登场角色\n';
      _mergedChars.forEach(function (c) {
        var _parts = [c.name];
        if (c.gender) _parts.push(c.gender);
        if (c.age) _parts.push(c.age + '岁');
        if (c.relation) _parts.push(c.relation);
        if (c.description) _parts.push(c.description.length > _charDescChars ? c.description.slice(0, _charDescChars) + '…' : c.description);
        extraCharCtx += '- ' + _parts.join(' | ') + '\n';
      });
    }

        // 世界观 = 世界书条目（type=世界观 的条目），无独立 worldSetting 字段注入
        // （旧「全局世界观设定」文本框已随写卡 agent 版移除，字段残留不再注入）

    // 世界书条目：开启注入的条目全部进入稳定前缀（关键词/常驻/条件机制已移除）
    const filteredWB = WorldBookManager.filterRelevantEntries();
    const _intensity = 'medium';
    // 稳定前缀已全量注入，动态区不再重复注入
    const _alwaysWB: any[] = [];
    const _matchedWB = filteredWB.filter(function (e: any) { return e.type !== '变量' && e.type !== '前端'; });

    // Dedup: skip role-type WB entries already covered by character descriptions
    const _coveredCharNames = new Set();
    __alwaysChars.forEach(function (c) { if (c.name) _coveredCharNames.add(c.name); });
    _mergedChars.forEach(function (c) { if (c.name) _coveredCharNames.add(c.name); });

    // Stable prefix: all injected entries (for prompt cache)
    // 直接从世界书读取注入条目，不依赖 filterRelevantEntries（避免 recentText 变化导致缓存失效）
    let _stableCtx = '';
    var _wb = WorldBookManager.getActive();
    // Agent 设定同步 / 比奇：启用任一方时读合并视图（原书 + 临时 overlay），原书零触碰
    var _wbEntries: any[] = (_wb && _wb.entries) || [];
    if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isActive()) {
      try { _wbEntries = SettingSyncManager.getEffectiveEntries(); } catch (e) { /* 回落原书 */ }
    }
    if (_wbEntries.length > 0) {
      // 注入上限固定 10 万字（不再提供用户设置项；只依赖条目 + 上限这两个稳定输入 → 稳定前缀逐字节可缓存）：
      // 条目过多时按 角色 > 世界观 > 其他 优先级取用，超出部分整体跳过并在世界书页显示占用。
      const _pick = selectInjectableEntries(_wbEntries, WB_INJECT_MAX_CHARS);
      this._lastWBInject = { chars: _pick.chars, skipped: _pick.skipped, budget: _pick.budget };
      if (_pick.skipped > 0) {
        const _noticeKey = 'wbInjectSkippedNotice_' + (WorldBookManager.getActiveId ? WorldBookManager.getActiveId() : 'none');
        if (SM().get<any>(_noticeKey, -1) !== _pick.skipped) {
          SM().set(_noticeKey, _pick.skipped);
          try { App.toast('世界书超过 10 万字上限：本轮未注入 ' + _pick.skipped + ' 条（世界书页可查看占用）'); } catch (e) { /* ignore */ }
        }
      }
      if (_pick.kept.length > 0) {
        _stableCtx += '\n## 世界书条目（必须严格遵守，不得违反）\n';
        _pick.kept.forEach(function (e: any) {
          _stableCtx += '### [' + e.type + '] ' + e.name + '\n' + (e.content || '') + '\n\n';
        });
      }
    }

    // 初始条目：仅在正文为空（尚未开始写作）时注入——说明故事开局时期、已发生/未发生什么；
    // 正文一旦有内容就不再注入（开局状态已体现在正文里）
    if (_wbEntries.length > 0) {
      var _novelForInit = this.getNovelData();
      var _bodyEmpty = !(_novelForInit.chapters || []).some(function (ch: any) {
        return (ch.content || '').replace(/<[^>]*>/g, '').trim().length > 0;
      });
      if (_bodyEmpty) {
        var _initEntries = _wbEntries.filter(function (e) { return e.type === '初始' && e.content; });
        if (_initEntries.length > 0) {
          _stableCtx += '\n## 故事初始状态\n';
          _initEntries.forEach(function (e) {
            _stableCtx += '### [' + e.type + '] ' + e.name + '\n' + e.content + '\n\n';
          });
        }
      }
    }

    // Add behavior rules summary extracted from character cards
    let _ruleSummary = '';
    if (_wbEntries.length > 0) {
      _wbEntries.forEach(function (e) {
        if (e.inject !== false && e.type === '角色' && e.content) {
          var match = e.content.match(/【行为铁则】\n([\s\S]*?)(?=\n【|$)/);
          if (match && match[1].trim()) {
            _ruleSummary += '[' + e.name + ']\n' + match[1].trim() + '\n';
          }
        }
      });
    }
    if (_ruleSummary) {
      _stableCtx += '## 角色行为约束\n' + _ruleSummary + '\n';
    }

    // Variable suffix: keyword-matched entries (capped), story memories
    let _variableCtx = '';
    if (_matchedWB.length > 0) {
      const _isHighOrExtreme = String(_intensity) === 'high' || String(_intensity) === 'extreme';
      const _wbMaxEntries = _isHighOrExtreme ? 20 : String(_intensity) === 'low' ? 10 : 15;
      const _wbMaxEntryChars = _isHighOrExtreme ? 200 : String(_intensity) === 'low' ? 120 : 150;
      _variableCtx += '\n## 世界书条目（以下设定必须严格遵守，不得违反）\n';
      const _cappedMatched = _isHighOrExtreme ? _matchedWB : _matchedWB.slice(0, _wbMaxEntries);
      _cappedMatched.forEach((e: any) => {
        // Skip if entry content already appears in recentText (dedup)
        if (e.content && e.content.length > 50) {
          var lines = e.content.split('\n').filter(function (s: any) { return s.trim().length > 5; });
          if (lines.length > 0) {
            var matched = lines.filter(function (s: any) { return recentText.indexOf(s.trim()) >= 0; }).length;
            if (matched / lines.length > 0.6) return;
          }
        }
        _variableCtx += '### [' + e.type + '] ' + e.name + '\n' + e.content + '\n\n';
      });
      if (_matchedWB.length > _wbMaxEntries && !_isHighOrExtreme) {
        _variableCtx += '… 等 ' + _matchedWB.length + ' 条相关设定（已省略 ' + (_matchedWB.length - _wbMaxEntries) + ' 条）\n\n';
      }
    }

    // === 记忆体系（v31：STM/LTM 事件记忆已移除，记忆职责并入记忆数据库）===
    // 归档区原文回读：查询 = 滚动区尾部的实体/罕见词短查询；BM25 以 ~800 字子块为
    // 检索单元（小块判别力强），命中子块相邻合并成片段后按字符预算填充注入。
    var _archiveRecall = '';
    var _genTrace: any = null;   // 管理员模式留档：本轮召回内容（上报见 _uploadAdminTrace）
    if (typeof ArchiveStore !== 'undefined' && ArchiveStore.initStorage) await ArchiveStore.initStorage();
    if (ArchiveStore.count() > 0) {
      try {
        var _recallTail = (_rollingText || recentText || '').slice(-2000);
        // 检索信号源：窗口尾部 + 用户指令（意图）+ 稀有实体键 + 窗口分带（新→旧优先级递减）
        var _probe = String(_rollingText || '') + '\n' + String(recentText || '') + '\n' + String(userInstruction || '');
        var _rareKeys = (typeof ArchiveStore !== 'undefined' && ArchiveStore.rareKeysIn) ? ArchiveStore.rareKeysIn(_probe) : [];
        // dict 通道 = 稀有事件键 ∪ 世界书实体（条目名+关键词+语料验证别名，最高质量实体源）
        // ∪ 学习词典（实体全名）：让「雨宫彩乃（高中）」这类实体全名进查询
        var _dictUnion: string[] = (_rareKeys || []).slice();
        try {
          if (typeof ArchiveStore !== 'undefined' && ArchiveStore.wbQueryTerms) {
            ArchiveStore.wbQueryTerms().forEach(function (w: string) { if (_dictUnion.indexOf(w) < 0) _dictUnion.push(w); });
          }
        } catch (e) { /* 忽略 */ }
        if (typeof ArchiveStore !== 'undefined' && ArchiveStore.dictWords) {
          ArchiveStore.dictWords().forEach(function (w: string) { if (_dictUnion.indexOf(w) < 0) _dictUnion.push(w); });
        }
        // 分带（新→旧）：优先以「最近一次续写」为单位（.ai-generated 块，叙事节拍），
        // 无代信息时回退窗口 2000 字切片
        var _recentParts: string[] = [];
        try {
          var _aiDivs = document.querySelectorAll('#editor .ai-generated');
          for (var _di = _aiDivs.length - 1; _di >= 0 && _recentParts.length < 8; _di--) {
            var _dt = String((_aiDivs[_di] as HTMLElement).innerText || '').trim();
            if (_dt.length >= 80) _recentParts.push(_dt);
          }
        } catch (e) { /* 忽略 */ }
        if (_recentParts.length === 0) {
          var _rsrc = String(recentText || '');
          for (var _ri = _rsrc.length; _ri > 0; _ri -= 2000) _recentParts.push(_rsrc.slice(Math.max(0, _ri - 2000), _ri));
        }
        // 查询改造：整段正文 → 实体/罕见词短查询（实测长查询被泛化词稀释，短查询 hit@3 提升约 3 倍）
        if (typeof ArchiveIndex !== 'undefined') ArchiveIndex.ensureFresh();
        var _recallQuery = (typeof MemoryQueryBuilder !== 'undefined' && typeof ArchiveIndex !== 'undefined')
          ? MemoryQueryBuilder.build(_recentParts[0] || _recallTail, {
              getDf: ArchiveIndex.getDf.bind(ArchiveIndex), dfCap: ArchiveIndex.suggestDfCap(),
              dict: (_dictUnion.length ? _dictUnion : undefined),
              instruction: String(userInstruction || ''),
              getCount: (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.termCount) ? ArchiveIndex.termCount.bind(ArchiveIndex) : undefined,
              recentParts: _recentParts.slice(1),
              n: (typeof ArchiveIndex.childCount === 'function') ? ArchiveIndex.childCount() : 0,
            })
          : (_recentParts[0] || _recallTail);
        var _recallCands: any[] = [];
        if (SM().get<any>('archiveBm25Enabled', true) && typeof ArchiveIndex !== 'undefined') {
          ArchiveIndex.ensureFresh();
          // 候选深度 24→48：强相关门槛过滤后仍要能把预算填满（24 条最多 ~19k 字，填不满 30k 预算）
          _recallCands = _recallCands.concat(ArchiveIndex.search(_recallQuery, 48));
        }
        // 点名锚（"点名必达"通道）：指令里点名的词条（引号词条 ∪ 词典实体 ∪ 高频点名锚）。
        // 单独检索并前置注入——否则会被窗口上下文词（一次 40+ 个）淹没。
        // 实测（唯一金标题集）：点名唯一专名题 72%→98%，带引号的点名 9%→95%。
        var _namedTerms: string[] = [];
        try {
          if (typeof MemoryQueryBuilder !== 'undefined' && MemoryQueryBuilder.namedTerms && String(userInstruction || '')) {
            _namedTerms = MemoryQueryBuilder.namedTerms(String(userInstruction || ''), ArchiveIndex.getDf.bind(ArchiveIndex), ArchiveIndex.termCount.bind(ArchiveIndex), (typeof ArchiveIndex.childCount === 'function') ? ArchiveIndex.childCount() : 0);
          }
        } catch (e) { /* 忽略 */ }
        // 强相关门槛（宁缺毋滥）：与当前正文共享 ≥2 个判别词的回读段才保留，
        // 否则整轮不注入——实测约 8 成召回是弱相关/无关正文（带偏隐患）
        if (typeof MemoryQueryBuilder !== 'undefined' && typeof ArchiveIndex !== 'undefined') {
          // 门槛词表：指令优先占名额，窗口分带（新→旧）补足；df 上限与查询窗口通道
          // 同步收紧（≤6）——叙事常用词混进门控会让噪声块凭 ≥2 命中混过强相关门槛
          var _gDfCap = Math.max(3, Math.min(ArchiveIndex.suggestDfCap(), 6));
          var _gTerms = (typeof MemoryQueryBuilder.rareTermsMulti === 'function')
            ? MemoryQueryBuilder.rareTermsMulti([String(userInstruction || '')].concat(_recentParts), ArchiveIndex.getDf.bind(ArchiveIndex), _gDfCap, 12, ArchiveIndex.termCount.bind(ArchiveIndex))
            : MemoryQueryBuilder.rareBigrams(_recallTail, ArchiveIndex.getDf.bind(ArchiveIndex), 12, _gDfCap);
          // 指令点名锚（df 超限的高频词，如角色名）：与查询通道同款保底进门控——
          // 否则通篇是该角色的块会因判别词不含它而被 ≥2 命中门槛滤掉
          try {
            if (typeof MemoryQueryBuilder.namedAnchors === 'function' && userInstruction) {
              MemoryQueryBuilder.namedAnchors(String(userInstruction), ArchiveIndex.getDf.bind(ArchiveIndex), 2, ArchiveIndex.termCount.bind(ArchiveIndex))
                .forEach(function (w: string) { if (_gTerms.indexOf(w) < 0) _gTerms.push(w); });
            }
          } catch (e) { /* 忽略 */ }
          // 世界书实体若在当前正文出现，直接进门控词表（高精度命中信号）
          try {
            if (typeof ArchiveStore !== 'undefined' && ArchiveStore.wbQueryTerms) {
              ArchiveStore.wbQueryTerms().forEach(function (w: string) {
                if (_probe.indexOf(w) >= 0 && _gTerms.indexOf(w) < 0) _gTerms.push(w);
              });
            }
          } catch (e) { /* 忽略 */ }
          // 点名锚进门控词表：entKeys 命中 → 阈值降到 1，避免点名词条相关候选被门槛滤掉
          _namedTerms.forEach(function (w: string) { if (w.length >= 2 && _gTerms.indexOf(w) < 0) _gTerms.push(w); });
          if (_gTerms.length >= 2) {
            // 指令点名/稳定在场/世界书命中的实体：只要候选与其共享 ≥1 个判别词即放行
            // （阈值 2 对实体用例太严——窗口尾部场景词占满门槛，指令点名词进不去，
            // 导致「点名角色 → 检索到 gold 却被门槛滤掉」的门控误杀）
            const entKeys = _gTerms.filter(function (w: string) {
              return w.length >= 2
                && (_dictUnion.indexOf(w) >= 0 || String(userInstruction || '').indexOf(w) >= 0);
            });
            const thr = entKeys.length ? 1 : 2;
            _recallCands = _recallCands.filter(function (c: any) {
              return MemoryQueryBuilder.countTermHits(String(c.text || ''), _gTerms) >= thr;
            });
          }
        }
        // 实体直收：查询中 df∈[0.3N,0.97N] 的词典实体（小鞠/艾莉莎/政近）idf 低、
        // BM25 分数天花板低排不进 top48——直收按 tf 排序取前 2 块，直接进注入。
        // 该通道是词典唯一被实测有效的用途（点名高频实体找"最密一幕"：关掉它段命中
        // 74.2%→54.8%，p=0.03）。限额与 df 窗口都不要放宽：topK 3 + df 0.15N 的
        // 实测反而把段命中拉到 64.5%（byId 取各实体最大 tf，多实体混排会互相顶掉
        // 对方的最密块）。历史注意：早期限制 4→2 是因为旧版直收块跨轮 87% 重复——
        // 该问题源于当时没有 df 下限门控，与条数无关，现由 _topDfQuery 负责。
        var _picked: any[] = [];
        var _pickedBids: string[] = [];
        var _seenRecall = {} as Record<string, any>;
        var _usedChars = 0;
        // 回读预算（三条通道共用）：点名锚/直收也必须过闸门——它们的片段可能远大于预算
        // （整块正文时单条可达 8k 字），无条件塞入会挤掉「按分数填充」通道（见 lib/recallgate.ts）
        var _budget = Number(SM().get('archiveRecallBudget', 30000)) || 30000;
        // ① 点名锚（最高优先）：点名词条单独检索，结果前置注入（最多 6 条，且不得超预算，
        //    剩下的预算留给"与当前剧情相关"的窗口回读）
        if (_namedTerms.length > 0 && typeof ArchiveIndex !== 'undefined' && ArchiveIndex.search) {
          try {
            ArchiveIndex.search(_namedTerms.join(' '), 6).forEach(function (x: any) {
              const text = String(x.text || '');
              if (!text) return;
              const key = recallKey(text);
              if (!key || _seenRecall[key]) return;
              if (!recallFits(_usedChars, text.length, _budget, _picked.length)) return;
              _seenRecall[key] = 1;
              _picked.push('【旧正文】' + text);
              if (x.blockId) _pickedBids.push(String(x.blockId));
              _usedChars += text.length;
            });
          } catch (e) { /* 忽略 */ }
        }
        // ② 实体直收（同片段只注入一次；同样受预算闸门约束）
        if (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.searchDirect) {
          try {
            ArchiveIndex.searchDirect(_recallQuery, 2).forEach(function (x: any) {
              const text = String(x.text || '');
              if (!text) return;
              const key = recallKey(text);
              if (key && _seenRecall[key]) return;
              if (!recallFits(_usedChars, text.length, _budget, _picked.length)) return;
              if (key) _seenRecall[key] = 1;
              _picked.push('【旧正文】' + text);
              if (x.blockId) _pickedBids.push(String(x.blockId));
              _usedChars += text.length;
            });
          } catch (e) { /* 忽略 */ }
        }
        var _spans = (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.mergeSpans) ? ArchiveIndex.mergeSpans(_recallCands) : _recallCands;
        _spans.sort(function (a: any, b: any) { return (b.score || 0) - (a.score || 0); });
        // 预算填充（按分数序填满为止）：强相关门槛已在候选层完成过滤，这里不再做分位裁剪。
        // 原「15 百分位 + top2 保底」实测只用掉 ~26% 预算（平均注入 7.9k/30k 字），
        // 且注入头部跨轮 87% 重复——召回被排序截断拖低；去掉后同语料同预算段命中 +10 个点。
        for (var _si = 0; _si < _spans.length; _si++) {
          var sp = _spans[_si];
          var key = recallKey(String(sp.text || ''));
          if (!key || _seenRecall[key]) continue;
          var _segLen = String(sp.text || '').length;
          if (!recallFits(_usedChars, _segLen, _budget, _picked.length)) continue;
          _seenRecall[key] = 1;
          _picked.push('【旧正文】' + String(sp.text || ''));
          if (sp.blockId) _pickedBids.push(String(sp.blockId));
          _usedChars += _segLen;
          if (_usedChars >= _budget) break;
        }
        // 稀有实体键控：窗口命中低频实体 → 拉取事件行（摘要+quote 定位的原文片段）。
        // 高频实体（主角名）被键频门控抑制。_probe/_rareKeys 已在查询构建前算好。
        var _recallParts: string[] = [];
        if (_picked.length > 0) _recallParts.push('## 归档原文回读（与当前剧情相关的旧正文片段，原样引用）\n' + _picked.join('\n\n'));
        var _evRows = (typeof ArchiveStore !== 'undefined' && ArchiveStore.recallEvents)
          ? ArchiveStore.recallEvents(_probe, { limit: 5, excludeBlockIds: _pickedBids, strongText: String(userInstruction || '') })
          : [];
        if (_evRows.length > 0) {
          _recallParts.push('## 相关旧事（按稀有实体召回）\n' + _evRows.map(function (e: any) {
            return '【旧事·' + (e.keys || []).join('/') + '】' + String(e.text || '') + (e.span ? '\n「' + e.span + '」' : '');
          }).join('\n'));
        }
        if (_recallParts.length > 0) _archiveRecall = _recallParts.join('\n\n');
        try {
          const _g2 = App as unknown as { _lastMemTrace?: { archive?: string[] } };
          if (_g2._lastMemTrace) _g2._lastMemTrace.archive = _picked.slice(0, 6).map(function (t: string) { return t.slice(0, 40); });
        } catch (e) { /* 忽略 */ }
        // 管理员模式留档：本轮注入的旧正文片段（含在原文中的位置，便于判相关性）
        _genTrace = {
          mode: String(mode || ''),
          windowChars: String(_frozenText || '').length + String(_rollingText || '').length,
          budget: Number(_budget) || 0,
          archiveBlocks: (typeof ArchiveStore !== 'undefined' && ArchiveStore.count) ? ArchiveStore.count() : 0,
          recallChars: _usedChars || 0,
          candidates: _recallCands.length,
          pieces: _picked.slice(0, 40).map(function (t: string) {
            const raw = String(t).replace(/^【旧正文】/, '');
            const at = String(_canonicalText || '').indexOf(raw.slice(0, 30));
            return { head: raw.replace(/\s+/g, ' ').slice(0, 120), chars: raw.length, pos: at };
          }),
        };
      } catch (e) { console.warn('[Archive] 回读失败:', e); }
    }
    // 3) 事实卡实体激活：窗口内出现的实体（词典匹配）→ 按主键/别名拉数据库记录（替换全库 dump）
    var _factCardCtx = '';
    if (typeof DatabaseManager !== 'undefined' && DatabaseManager.isEnabled()) {
      try {
        var _probeText = (_rollingText || '') + '\n' + (recentText || '');
        var _entities = (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.matchEntities) ? ArchiveIndex.matchEntities(_probeText) : [];
        if (_entities.length > 0) {
          var _factLines = App._pullFactCards(_entities.slice(0, 12));
          if (_factLines) _factCardCtx = '## 相关档案（人物/物品/设定当前状态，必须与正文一致）\n' + _factLines;
        }
      } catch (e) { console.warn('[Archive] 事实卡激活失败:', e); }
    }
    if (_genTrace) { _genTrace.factCards = !!_factCardCtx; _genTrace.instruction = String(userInstruction || ''); App._lastGenTrace = _genTrace; }

    // Messages ordered for max cache: stable prefix first, variable suffix last
    const messages = [
      { role: 'system', content: _effectiveSP },
    ];
    if (_stableCtx) messages.push({ role: 'system', content: _stableCtx });
    if (charCtx) messages.push({ role: 'system', content: charCtx });
    if (_alwaysCharCtx) messages.push({ role: 'system', content: _alwaysCharCtx });

    // ===== 统一模式三层结构（全文模式已移除）=====
    // L0 绝对稳定前缀（上方已推）→ L1 正文窗口块 → L3 归档回读/事实卡 → user 滚动区
    if (_frozenText) {
      messages.push({ role: 'system', content: '## 已完成的正文（历史部分，保证剧情、人物、细节连贯的事实依据）\n' + _frozenText });
    }

    // L3a/L3b 归档回读与事实卡：每轮随正文重检索而大改，若作为 system 消息会切断前缀缓存
    // （网关命中到第一条变化消息为止，其后全部 miss）。实测：中间 system 槽每轮大改会把
    // 缓存率打到 ~50%。因此收进 user 滚动区开头（每轮必变内容全部后置，system 前缀纯稳定）。
    // 变量/场景已按此原则处理；此处把回读资料也归位。滚动区组装见 _userParts。

    // 缓存诊断：与上轮快照逐条对比，计算 system 前缀命中长度（命中越多缓存越省）
    var _prevCache = SM().get<any>('_cacheDebug2', null);
    var _curSnap = messages.map(function (m, i: any) {
      var s = m.content;
      return { i: i, len: s.length, head: s.slice(0, 50), tail: s.slice(-30) };
    });
    if (_prevCache) {
      var _hitChars = 0, _ci;
      for (_ci = 0; _ci < Math.min(_curSnap.length, _prevCache.length); _ci++) {
        var cur = _curSnap[_ci], prev = _prevCache[_ci];
        if (cur.len === prev.len && cur.head === prev.head && cur.tail === prev.tail) _hitChars += cur.len;
        else break;
      }
      var _totChars = _curSnap.reduce(function (s, m: any) { return s + m.len; }, 0);
      console.log('[Cache2] system 前缀命中 ≈ ' + _hitChars + ' 字 / ' + _totChars + ' 字 (' + (_totChars ? Math.round(_hitChars / _totChars * 100) : 100) + '%)');
      for (_ci = 0; _ci < _curSnap.length; _ci++) {
        if (_ci < _prevCache.length && !(_curSnap[_ci].len === _prevCache[_ci].len && _curSnap[_ci].head === _prevCache[_ci].head && _curSnap[_ci].tail === _prevCache[_ci].tail)) {
          console.log('[Cache2] 首个变化消息: msg' + _ci + ' "' + _curSnap[_ci].head.slice(0, 24) + '..."');
          break;
        }
      }
    } else {
      console.log('[Cache2] 首次运行，保存快照');
    }
    SM().set('_cacheDebug2', _curSnap);

    var _userParts: any[] = [];
    // 回读资料（每轮随正文变化 → 放 user 区开头，system 前缀保持纯稳定以最大化缓存命中）
    if (_archiveRecall) _userParts.push(_archiveRecall);
    if (_factCardCtx) _userParts.push(_factCardCtx);
    if (extraCharCtx) _userParts.push(extraCharCtx);
    if (_variableCtx) _userParts.push(_variableCtx);
    // 角色状态摘要
    if (typeof CharacterManager !== 'undefined') {
      var _charStates = CharacterManager.getStatesSummary();
      if (_charStates.length > 0) {
        _userParts.push('## 角色当前状态\n' + _charStates.join('\n'));
      }
    }
    // Agent 设定同步：待裁决覆盖指令进 rolling 区（本来就不命中缓存，多带一份零损失）
    if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled()) {
      try {
        var _ssDeltaCtx = SettingSyncManager.buildCoverageText();
        if (_ssDeltaCtx) {
          _userParts.push(_ssDeltaCtx);
        } else {
          // 无待裁决时附补交提醒：防上轮引入新设定但漏报（下轮提示补交）
          var _ssReminder = SettingSyncManager.buildReminderText();
          if (_ssReminder) _userParts.push(_ssReminder);
        }
      } catch (e) { /* 旁路失败忽略 */ }
    }
    // 构建上下文：滚动区正文 + 指令（归档回读/档案已作为 user 区开头注入，见 _userParts）
    var _contextParts: any[] = [];
    // 滚动区 = 窗口块之后的正文尾部（与窗口无缝衔接，共同构成完整近期上下文）
    _contextParts.push('【上下文】\n' + (_rollingText || recentText || '(空白)'));
    _contextParts.push('【指令】\n' + userInstruction);
    _userParts.push(_contextParts.join('\n\n'));
    messages.push({ role: 'user', content: _userParts.join('\n\n') });
    // 展开预设里的酒馆模板语法（setvar/getvar/{{//}}/${...}），让豆包等模型看到完整指令
    _expandSTInMessages(messages);
    EditorManager._thinkingRequired = _thinkingRequired && !_hasNativeReasoning;
    // 已生成的文字落盘（「停止」与「连接中断」共用）：
    // 断线（切后台被系统掐掉连接等）不该让用户白等一场——已经看到的正文必须留在编辑器里，
    // 之后再点「续写」就是接着往下写。处理流程与「停止生成」完全一致（含设定同步块 / 思考块）。
    const _flushPartial = (reasoningText: any) => {
      var _escAb = function (t: any) { return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); };
      var _genAb = String(generated || '');
      if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled() && SettingSyncManager.hasDeltaMarker(_genAb)) { try { var _ssOpsAb = SettingSyncManager.parseDeltaBlock(_genAb); if (_ssOpsAb && _ssOpsAb.length > 0) SettingSyncManager.addPending(_ssOpsAb); } catch (e) {} _genAb = SettingSyncManager.stripDeltaBlock(_genAb); }
      var _spAb = _splitThinkingBlocks(RegexEngine.applyRules(_genAb, 'after'));
      var _thAb = (reasoningText && String(reasoningText).trim()) ? [reasoningText].concat(_spAb.thoughts) : _spAb.thoughts;
      var _pa = _buildThinkingHtml(_thAb, _escAb) + _spAb.body.replace(/\n{3,}/g,'\n\n').replace(/(?<!\n)\n(?!\n)/g,'\n\n');
      if (_streaming) EditorManager.finishStreaming(_pa); else EditorManager.insertAtCursor(_pa);
      _notifyUnclosedThink(_spAb);
    };
    let generated = ''; const _streaming = document.getElementById('streamingOutput')!.checked; if (_streaming) EditorManager.startStreaming();
    await APIHandler.fetchCompletions(messages,
      (chunk) => { generated += chunk; if (_streaming) EditorManager.appendStreaming(chunk); statusEl!.textContent = '生成中... ' + generated.replace(/\s/g, '').length + ' 字'; },
      (fullContent, aborted: any, reasoning: any) => {
        if (aborted) { App._endGenerating(); statusEl!.textContent = '已停止生成'; if (generated) _flushPartial(reasoning); else if (_streaming) EditorManager.cancelStreaming(); UsageStats.endSession(generated ? generated.replace(/\s/g, '').length : 0); return; }
        if (fullContent || (reasoning && reasoning.trim())) {
          let _preProcessed = String(fullContent || '');
          const _parsedVars = VariableManager.parseVarBlock(_preProcessed); if (_parsedVars && Object.keys(_parsedVars).length > 0) { VariableManager.setBatch(_parsedVars); _preProcessed = _preProcessed.replace(/\[VAR\][\s\S]*?\[\/VAR\]/g, '').trim(); } // Agent 设定同步：剥离 SETTING_DELTA 块 → 解析入库待裁决（best-effort，失败静默丢弃）；必须在 finishStreaming/saveCurrentChapter 之前，防止污染正文/归档
          if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled() && SettingSyncManager.hasDeltaMarker(_preProcessed)) { try { var _ssOps = SettingSyncManager.parseDeltaBlock(_preProcessed); if (_ssOps && _ssOps.length > 0) { SettingSyncManager.addPending(_ssOps); try { App.toast('发现 ' + _ssOps.length + ' 条设定提议（待二审）'); } catch (e2) {} } } catch (e) {} _preProcessed = SettingSyncManager.stripDeltaBlock(_preProcessed); try { SettingSyncManager.noteDeltaResult(1); } catch (e3) {} } else if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled()) { try { SettingSyncManager.noteDeltaResult(0); } catch (e4) {} } const stripped = _preProcessed.replace(/^#{1,3}\s+.*(\n|$)/gm, '').trim(); var _esc2 = function (s: any) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }; var _split = _splitThinkingBlocks(RegexEngine.applyRules(stripped, 'after')); var _streamSplit = _splitThinkingBlocks(generated || ''); // 诊断留档：原始输出 + 各阶段长度（正文丢失时可一键定位）
          App._lastRawGenerate = String(fullContent || '');
          console.log('[Split] raw=' + String(fullContent || '').length + ' stripped=' + stripped.length + ' body=' + _split.body.length + ' thoughts=' + _split.thoughts.length + '[Split] unclosed?', !!_split.unclosed); var _allThoughts: any[] = []; var _seenThoughts = {} as Record<string, any>; var _addThoughts = function (arr: any) { (arr || []).forEach(function (v: any) { var clean = String(v || '').trim(); if (!clean) return; var key = clean.replace(/\s+/g, ' ').slice(0, 80); if (!_seenThoughts[key]) { _seenThoughts[key] = true; _allThoughts.push(clean); } }); }; _addThoughts(reasoning && reasoning.trim() ? [reasoning] : []); _addThoughts(_streamSplit.thoughts); _addThoughts(_split.thoughts); var _body = (function (t) {var n=0;return normalizeQuotes(t.replace(/——/g,function () {return++n<=3?'——':'—'}));})(_split.body).replace(/<details\b([^>]*)>[\s\S]*?<\/details>/gi, function (m, attrs: any) { return /class\s*=\s*["'][^"']*cot-thinking/i.test(attrs) ? m : ''; }).replace(/<Anti-Omniscience>[\s\S]*?<\/Anti-Omniscience>/gi,'').replace(/<\/?(bginfor|catsay|CEstuff|CE[A-Za-z]*|subtext|radio|url|end)[^>]*>/gi,'').replace(/\n{3,}/g,'\n\n').replace(/(?<!\n)\n(?!\n)/g,'\n\n').trim(); const _deepThinkOn = App.thinkingLevel() !== 'off'; // 思考强度：仅 off 时结束端不渲染思维链（流式思考框已由 editor 隐藏，替换后纯正文）
                  const processed = (_deepThinkOn ? _buildThinkingHtml(_allThoughts, _esc2) : '') + _body; if (_streaming) EditorManager.finishStreaming(processed); else EditorManager.insertAtCursor(processed); _notifyUnclosedThink(_split); App.saveCurrentChapter(); App._uploadAdminTrace(_body); console.log('[Generate] Content saved. Editor length:', EditorManager.getContent().replace(/<[^>]*>/g, '').length, 'chars'); statusEl!.textContent = '生成完成！'; const _rawLen = String(fullContent || '').replace(/\s/g, '').length; const _wordCount = processed.replace(/\s/g, '').length; console.log('[Token] 原始输出:', _rawLen, '字符 | 处理后:', _wordCount, '字符 | API tokens:', (APIHandler._apiCalls.filter(c=>c.label==='generate').slice(-1)[0]?.completionTokens || '?')); UsageStats.endSession(_wordCount); (async () => {
            // 记忆数据库填表：每次生成后额外调用一次 API（fire-and-forget，不阻塞）
            if (typeof DatabaseManager !== 'undefined' && DatabaseManager.isEnabled()) {
              App.fillMemoryTable((recentText || '') + '\n\n' + processed).then(function (n: any) {
                if (n > 0 && document.getElementById('pluginFullscreen') && document.getElementById('pluginFullscreen')!.style.display === 'flex') {
                  UIManager.renderDBRecords();
                }
              }).catch(function (e: any) { console.warn('[DB] fill failed:', e); });
            }
            // 角色状态提取（规则提取，不调用API）
            if (processed && processed.length > 50 && typeof CharacterManager !== 'undefined') {
              var _charUpdates = CharacterManager.extractStateFromText(processed);
              if (Object.keys(_charUpdates).length > 0) {
                CharacterManager.batchUpdateState(_charUpdates);
                console.log('[CharState] updated:', Object.keys(_charUpdates));
              }
            }
            // Agent 设定同步：轮数计数 + 攒批触发二审（fire-and-forget，单轮最多一次短调用）
            if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled()) {
              try {
                var _ssTrigger = SettingSyncManager.bumpRound();
                if (_ssTrigger) App.reviewSettingDelta(_ssTrigger, (recentText || '') + '\n\n' + processed);
                else if (typeof UIManager !== 'undefined' && UIManager.refreshAgentBadge) { try { UIManager.refreshAgentBadge(); } catch (e2) {} }
              } catch (e) { console.warn('[SettingSync] trigger failed:', e); }
            }
            App._bumpContinuationCount(); App._endGenerating(); })().catch(function (e) { console.warn('[Generate] 续写后置处理异常:', e); App._endGenerating(); }); } else { statusEl!.textContent = '未收到有效回复'; UsageStats.endSession(0); App._endGenerating(); }
      },
      (error) => {
        App._endGenerating(); UsageStats.endSession(0);
        const _kept = String(generated || '').replace(/\s/g, '').length;
        if (_kept >= 20) {
          // 连接被掐断（切后台 / 锁屏最常见）：把已经生成的正文留住，别让这一场白跑
          _flushPartial(''); App.saveCurrentChapter();
          statusEl!.textContent = '连接中断（已保留 ' + _kept + ' 字）';
          App.toast('连接中断：已保留已生成的 ' + _kept + ' 字，再点「续写」可接着往下写');
        } else {
          if (_streaming) EditorManager.cancelStreaming();
          statusEl!.textContent = '错误: ' + error;
          App.toast('生成失败: ' + error);
        }
      },
      {
        temperature: creativityLevel === 'strict' ? 0.7 : undefined,
        callLabel: 'generate',
        // 深度思考思维链实时进写作端思考框（reasoning_content 流式；关闭开关时不显示）
        onReasoning: (rc: string) => { if (_streaming) EditorManager.appendReasoning(rc); }
      }
    );
  },

  stopGeneration() { APIHandler.abort(); App._endGenerating(); UsageStats.endSession(0); },

  // 生成轮次收尾（**幂等**）：isGenerating 是 generate() 的防重入锁，任何一个出口漏复位，
  // 之后每次点「发送」都会在 generate() 开头静默 return —— 正文不生成、连错误提示都没有，
  // 只能重启 App（v1.5.90 用户报告的「按发送完全没反应」就是这个卡死）。所有出口统一走这里。
  _endGenerating() {
    App.isGenerating = false;
    const btnStop = document.getElementById('btnStop');
    if (btnStop) btnStop.style.display = 'none';
  },

  // ===== Agent 设定同步：攒批二审（fire-and-forget，低温短调用，默认拒绝的苛刻法官） =====
  async reviewSettingDelta(trigger: string, recentText: string) {
    try {
      if (typeof SettingSyncManager === 'undefined' || !SettingSyncManager.isEnabled()) return;
      const cfg = SettingSyncManager.getConfig();
      const pending = SettingSyncManager.getPending();
      if (pending.length === 0) return;
      SettingSyncManager.recordReviewAttempt();
      const apiConfig = PresetManager.getActiveAPIConfig();
      if (!apiConfig || !apiConfig.apiKey) { console.warn('[SettingSync] 无 API 配置，二审跳过'); return; }
      // 二审是结构化裁决，不需要创作思考——强制思考 off（避免 muse/deepseek 等长思考模型
      // 吃光输出额度导致 length 截断、裁决 JSON 出不来；也省 token）。
      // 输出额度不写死：走 api.ts 的默认最大值，端点上限由降级阶梯学习。
      const reviewApiConfig = { ...apiConfig, deepseekThinking: 'off' as const };
      // 二审上下文与正文续写对齐（裁决需要同等信息判断重复/矛盾/归属）：
      // 法官规则 + 世界书全量（合并视图）+ 主角 + 常驻角色 + 角色状态 + 待裁决明细 + 最近正文
      const _ssReviewParts: any[] = [];
      try {
        // 世界书全量条目（含临时 overlay 生效结果）——判断「新增是否重复/与哪条冲突」的完整底稿
        if (typeof SettingSyncManager !== 'undefined') {
          const _eff = SettingSyncManager.getEffectiveEntries();
          const _inj = (_eff || []).filter(function (e: any) { return e.inject !== false && e.type !== '变量' && e.type !== '前端' && e.type !== '初始'; });
          if (_inj.length > 0) {
            let _wbTxt = '## 当前世界书条目全量（裁决时逐条比对：重复/矛盾/归属）\n';
            _inj.forEach(function (e: any) { _wbTxt += '### [' + e.type + '] ' + e.name + '\n' + (e.content || '') + '\n\n'; });
            _ssReviewParts.push(_wbTxt);
          }
        }
        // 主角
        const _prota = this.getProtagonist();
        if (_prota && _prota.name) {
          let _pc = '## 主角设定\n- 姓名：' + _prota.name;
          if (_prota.gender) _pc += '\n- 性别：' + _prota.gender;
          if (_prota.age) _pc += '\n- 年龄：' + _prota.age;
          if (_prota.occupation) _pc += '\n- 职业：' + _prota.occupation;
          if (_prota.personality) _pc += '\n- 性格：' + _prota.personality;
          if (_prota.appearance) _pc += '\n- 外貌：' + _prota.appearance;
          if (_prota.abilities) _pc += '\n- 能力：' + _prota.abilities;
          _ssReviewParts.push(_pc);
        }
        // 常驻角色（世界书角色条目对应的角色卡）简述
        if (typeof CharacterManager !== 'undefined' && typeof CharacterManager.getAll === 'function') {
          const _wbId = WorldBookManager.getActiveId();
          const _cmAny = CharacterManager as any;
          const _wbChars = _cmAny.getByWorldBook ? _cmAny.getByWorldBook(_wbId) : [];
          const _always = (_wbChars || []).filter(function (c: any) { return c && c.name; }).slice(0, 12);
          if (_always.length > 0) {
            let _ac = '## 登场角色\n';
            _always.forEach(function (c: any) {
              const _parts = [c.name];
              if (c.gender) _parts.push(c.gender);
              if (c.age) _parts.push(c.age + '岁');
              if (c.relation) _parts.push(c.relation);
              if (c.description) _parts.push(String(c.description).slice(0, 150));
              _ac += '- ' + _parts.join(' | ') + '\n';
            });
            _ssReviewParts.push(_ac);
          }
          // 角色当前状态摘要
          try {
            const _st = _cmAny.getStatesSummary();
            if (_st && _st.length > 0) _ssReviewParts.push('## 角色当前状态\n' + _st.join('\n'));
          } catch (e) { /* ignore */ }
        }
      } catch (e) { /* 任一上下文失败不阻塞裁决 */ }
      const _ssUserText = SettingSyncManager.buildReviewUserText(recentText);
      const _ssCtxJoined = _ssReviewParts.length > 0 ? _ssReviewParts.join('\n\n') + '\n\n' : '';
      const reviewMsgs = [
        { role: 'system', content: cfg.reviewSystem },
      ];
      if (_ssCtxJoined) reviewMsgs.push({ role: 'system', content: _ssCtxJoined });
      reviewMsgs.push({ role: 'user', content: _ssUserText });
      const result: any = await new Promise(function (resolve) {
        APIHandler.fetchCompletions(reviewMsgs,
          function () {},
          function (full) { resolve(full); },
          function (err) { console.warn('[SettingSync] review failed:', err); resolve(null); },
          { temperature: 0.2, apiConfig: reviewApiConfig, callLabel: 'settingDeltaReview', timeout: 60000 }
        );
      });
      if (!result) { console.warn('[SettingSync] 二审无返回，本轮放弃（待裁决保留）'); return; }
      const decisions = SettingSyncManager.parseReviewResult(result);
      if (!decisions) {
        // 解析失败（模型输出带解释/fence/被截断）：保留待裁决不清空，避免整批提议被误丢，
        // 下轮自动触发或手动结算会再试一次
        console.warn('[SettingSync] 二审输出非 JSON，本轮放弃（待裁决保留，下次再试）');
        return;
      }
      const r = SettingSyncManager.applyApproved(decisions);
      console.log('[SettingSync] 二审落盘(' + trigger + ')：采纳 ' + r.accepted + ' / 拒绝 ' + r.rejected);
      // 每批仅一次索引失效（窗口期内零打扰，保 prompt caching）
      try { if (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.invalidate) ArchiveIndex.invalidate(); } catch (e) {}
      try { App.toast('设定同步：采纳 ' + r.accepted + ' 条' + (r.rejected > 0 ? '、拒绝 ' + r.rejected + ' 条' : '')); } catch (e) {}
      try { if (typeof UIManager !== 'undefined' && UIManager.renderAgentPage) UIManager.renderAgentPage(); } catch (e) {}
      try { if (typeof UIManager !== 'undefined' && UIManager.refreshAgentBadge) UIManager.refreshAgentBadge(); } catch (e) {}
    } catch (e) { console.warn('[SettingSync] review error:', e); }
  },

  // 手动"立即结算"（Agent 页按钮）—— 防抖：二审进行中不重复触发
  reviewSettingDeltaNow() {
    if ((this as any)._ssReviewing) { App.toast('正在二审中，请稍候'); return; }
    if (typeof SettingSyncManager === 'undefined' || !SettingSyncManager.isEnabled()) { App.toast('请先安装并开启 Agent 设定同步插件'); return; }
    if (SettingSyncManager.getPending().length === 0) { App.toast('暂无待裁决提议'); return; }
    (this as any)._ssReviewing = true;
    const self = this;
    // 手动结算同样带正文上下文（与续写后自动触发一致）——二审法官需要看到正文依据
    // 才能判断 quote 是否成立；空正文会让模型因「证据不足」倾向拒绝。
    let _ctx = '';
    try {
      if (typeof EditorManager !== 'undefined' && EditorManager.getRecentStoryText) {
        _ctx = EditorManager.getRecentStoryText() || '';
      }
    } catch (e) { /* 取不到正文就空着 */ }
    this.reviewSettingDelta('manual', _ctx).finally(function () { (self as any)._ssReviewing = false; });
  },

  // 变量自动更新（App._checkAndUpdateVars）与场景状态分析（App.updateSceneState）已于
  // v1.5.97.13 删除，原因见交接文档 §13.17：
  // ① 变量条目类型早已被 migrateEntryTypes() 统一并入「其他」→ 变量恒为空，那条自动更新永不触发；
  // ② 场景状态是"每次生成后额外调一次模型"、却没有 UI/开关的隐形调用，作用已被「记忆」插件的数据库覆盖。
  // 正文里 [VAR] 块的剥离、{{getvar::}} 宏展开与撤回用的变量快照都保留（兼容导入卡，见 generate()）。

  // F12 console: call App.getTokenUsage() to see token usage stats
  getTokenUsage() {
    const calls = APIHandler._apiCalls;
    if (calls.length === 0) { console.log('暂无 API 调用记录'); return; }
    const groups = {} as Record<string, any>;
    calls.forEach(c => {
      if (!groups[c.label]) groups[c.label] = { count: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
      groups[c.label].count++;
      groups[c.label].promptTokens += c.promptTokens;
      groups[c.label].cachedTokens += c.cachedTokens;
      groups[c.label].completionTokens += c.completionTokens;
      groups[c.label].cost += c.cost;
    });
    const allLabels = Object.keys(groups);
    // Split frontend vs backend
    const frontendLabels = ['generate'];
    const backendLabels = allLabels.filter(l => l !== 'generate');
    const total = { count: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    const frontend = { count: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    const backend = { count: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
    const rows = allLabels.map(label => {
      const g = groups[label];
      const isFrontend = label === 'generate';
      const t = isFrontend ? frontend : backend;
      t.count += g.count; t.promptTokens += g.promptTokens; t.cachedTokens += g.cachedTokens; t.completionTokens += g.completionTokens; t.cost += g.cost;
      total.count += g.count; total.promptTokens += g.promptTokens; total.cachedTokens += g.cachedTokens; total.completionTokens += g.completionTokens; total.cost += g.cost;
      const hitRate = g.promptTokens > 0 ? (g.cachedTokens / g.promptTokens * 100).toFixed(1) : '-';
      return { '调用类型': label, '次数': g.count, '输入tokens': g.promptTokens, '缓存命中': g.cachedTokens, '命中率': hitRate + '%', '输出tokens': g.completionTokens, '费用(¥)': g.cost.toFixed(4) };
    });
    // Add subtotal rows
    const fHR = frontend.promptTokens > 0 ? (frontend.cachedTokens / frontend.promptTokens * 100).toFixed(1) : '-';
    const bHR = backend.promptTokens > 0 ? (backend.cachedTokens / backend.promptTokens * 100).toFixed(1) : '-';
    rows.push({ '调用类型': '── 续写（前台）──', '次数': frontend.count, '输入tokens': frontend.promptTokens, '缓存命中': frontend.cachedTokens, '命中率': fHR + '%', '输出tokens': frontend.completionTokens, '费用(¥)': frontend.cost.toFixed(4) });
    rows.push({ '调用类型': '── 后台任务 ──', '次数': backend.count, '输入tokens': backend.promptTokens, '缓存命中': backend.cachedTokens, '命中率': bHR + '%', '输出tokens': backend.completionTokens, '费用(¥)': backend.cost.toFixed(4) });
    const totalHitRate = total.promptTokens > 0 ? (total.cachedTokens / total.promptTokens * 100).toFixed(1) : '-';
    rows.push({ '调用类型': '=== 合计 ===', '次数': total.count, '输入tokens': total.promptTokens, '缓存命中': total.cachedTokens, '命中率': totalHitRate + '%', '输出tokens': total.completionTokens, '费用(¥)': total.cost.toFixed(4) });
    console.table(rows, ['调用类型', '次数', '输入tokens', '缓存命中', '命中率', '输出tokens', '费用(¥)']);
    console.log('定价参考: 输入命中 ¥0.2/1M | 输入未命中 ¥1/1M | 输出 ¥2/1M');
  },

  // F12 console: call App.debugCache() after consecutive generate() calls to see which prompt sections changed
  debugCache() {
    const statusEl = document.getElementById('generationStatus');
    const _ctxChars = 4000;
    const _charDescChars = 300;
    const recentText = EditorManager.getCrossChapterContext(_ctxChars);
    const systemPrompt = PresetManager.getActiveSystemPrompt();

    const d = this.getNovelData();
    const protagonist = this.getProtagonist();
    // Rebuild _stableCtx（直接从世界书读取，与 generate() 一致；世界观=世界书条目，无 worldSetting 注入）
    let _stableCtx = '';
    var _dbgWb = WorldBookManager.getActive();
    var _dbgEntries: any[] = (_dbgWb && _dbgWb.entries) || [];
    if (typeof SettingSyncManager !== 'undefined' && SettingSyncManager.isEnabled()) {
      try { _dbgEntries = SettingSyncManager.getEffectiveEntries(); } catch (e) { /* 回落原书 */ }
    }
    if (_dbgEntries.length > 0) {
      var _dbgAlways = _dbgEntries.filter(function (e) { return e.inject !== false && e.type !== '变量' && e.type !== '前端' && e.type !== '初始'; });
      if (_dbgAlways.length > 0) {
        _stableCtx += '\n## 世界书条目（必须严格遵守，不得违反）\n';
        _dbgAlways.forEach(function (e) { _stableCtx += '### [' + e.type + '] ' + e.name + '\n' + e.content + '\n\n'; });
      }
    }
    // Rebuild charCtx
    let charCtx = '';
    if (protagonist && protagonist.name) {
      charCtx = '\n## 主角设定\n';
      ['name','gender','age','occupation','personality','appearance','abilities','backstory','catchphrase'].forEach(function (k) {
        if (protagonist[k]) {
          var label = ({name:'姓名',gender:'性别',age:'年龄',occupation:'职业',personality:'性格',appearance:'外貌',abilities:'能力',backstory:'背景',catchphrase:'口头禅'})[k] || k;
          charCtx += '- ' + label + '：' + (protagonist as Record<string, any>)[k] + '\n';
        }
      });
    }
    // Rebuild _alwaysCharCtx
    let _alwaysCharCtx = '';
    const _allChars = JSON.parse(JSON.stringify(CharacterManager.getAll()));
    const __wb = WorldBookManager.getActive();
    const __alwaysNames = new Set();
    if (__wb && __wb.entries) {
      __wb.entries.forEach(function (e) {
        if (e.inject !== false && e.type === '角色' && e.name) { __alwaysNames.add(e.name.trim()); }
      });
    }
    const __alwaysChars = __alwaysNames.size > 0 ? _allChars.filter(function (c: any) { return c.wbId && c.wbId === __wb!.id && __alwaysNames.has(c.name); }) : [];
    if (__alwaysChars.length > 0) {
      _alwaysCharCtx = '\n## 常驻角色\n';
      __alwaysChars.forEach(function (c: any) {
        var _parts = [c.name];
        if (c.gender) _parts.push(c.gender);
        if (c.age) _parts.push(c.age + '岁');
        if (c.relation) _parts.push(c.relation);
        if (c.description) _parts.push(c.description.length > _charDescChars ? c.description.slice(0, _charDescChars) + '…' : c.description);
        _alwaysCharCtx += '- ' + _parts.join(' | ') + '\n';
      });
    }
    // Build stable messages
    const stableMsgs = [
      { label: 'systemPrompt', content: systemPrompt },
    ];
    if (_stableCtx) stableMsgs.push({ label: '_stableCtx', content: _stableCtx });
    if (charCtx) stableMsgs.push({ label: 'charCtx', content: charCtx });
    if (_alwaysCharCtx) stableMsgs.push({ label: '_alwaysCharCtx', content: _alwaysCharCtx });
    // Compute fingerprints
    function fp(s: any) { return s.length + ':' + (s.length > 10 ? s.slice(0,10) : s) + '|' + (s.length > 10 ? s.slice(-10) : s); }
    const now = stableMsgs.map(function (m) { return { label: m.label, chars: m.content.length, fp: fp(m.content) }; });
    // Compare with previous
    var prevRaw = SM().get<any>('_debugCachePrev', null);
    var prev = prevRaw ? JSON.parse(prevRaw) : null;
    console.log('=== 缓存前缀诊断 ===');
    console.log('格式: 长度:前10字|后10字');
    console.log('');
    var allSame = true;
    var rows = now.map(function (n) {
      if (prev) {
        var p = prev.find(function (x: any) { return x.label === n.label; });
        if (p) {
          var changed = p.fp !== n.fp;
          if (changed) allSame = false;
          return { '消息': n.label, '字符数': n.chars, '指纹(现)': n.fp, '指纹(前)': p.fp, '变化': changed ? '⚠️ 已变化' : '✓ 相同' };
        }
      }
      return { '消息': n.label, '字符数': n.chars, '指纹(现)': n.fp, '指纹(前)': '(首次)', '变化': '(首次)' };
    });
    console.table(rows, ['消息', '字符数', '指纹(现)', '指纹(前)', '变化']);
    // Save current for next comparison
    SM().set('_debugCachePrev', JSON.stringify(now));
    if (prev && allSame) {
      console.log('✓ 所有稳定段均未变化，缓存前缀应命中');
    } else if (prev) {
      console.log('⚠️ 有稳定段发生变化，缓存前缀已失效');
    } else {
      console.log('已保存首次快照，请再执行一次 generate() 后重新调用 debugCache() 对比');
    }
    // Show cache stats for generate calls
    var genCalls = APIHandler._apiCalls.filter(function (c) { return c.label === 'generate'; });
    if (genCalls.length >= 2) {
      var last2 = genCalls.slice(-2);
      var rate = (last2[0] as any).promptTokens > 0 ? ((last2[0] as any).cachedTokens / (last2[0] as any).promptTokens * 100).toFixed(1) : '-';
      console.log('最近 generate 调用: ' + last2[0].promptTokens + ' prompt, ' + last2[0].cachedTokens + ' 缓存 (' + rate + '%)');
    }
    var otherCalls = APIHandler._apiCalls.filter(function (c) { return c.label !== 'generate'; });
    if (otherCalls.length > 0) {
      var otherLabels = {} as Record<string, any>;
      otherCalls.forEach(function (c) { if (!otherLabels[c.label]) otherLabels[c.label] = 0; otherLabels[c.label]++; });
      var labelStr = Object.keys(otherLabels).map(function (l) { return l + ' x' + otherLabels[l]; }).join(', ');
      console.log('其他 API 调用 (' + otherCalls.length + ' 次): ' + labelStr + ' — 这些调用使用不同的 prompt，不计入 generate 缓存');
    }
  },

  // 写作页底部输入框：留空=自动续写(autoContinue)；有内容=扩写并续写(expandDraft)
  // QQ 式输入框：发送后高度回到一行
  resetChatInput(ta: any) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.scrollTop = 0;
  },

  sendFromWritingInput() {
    const input = document.getElementById('writingInput');
    if (!input) return;
    const text = (input.value || '').trim();
    // 保存本次输入（撤回时恢复到输入框）——空输入也要覆盖，撤回只恢复最后一次发送的内容
    this._lastInputText = input.value;
    // generate() 是 async：启动阶段同步抛错（配置/依赖异常）会变成未处理的 rejection，
    // 而 isGenerating 已经被置 true → 之后每次点发送都静默无反应。这里兜住并给出可见反馈。
    const _start = (mode: string) => {
      const p: any = App.generate(mode);
      if (p && typeof p.catch === 'function') {
        p.catch(function (e: any) {
          console.warn('[Generate] 启动失败:', e);
          App._endGenerating();
          App.toast('生成启动失败: ' + ((e && e.message) ? e.message : e));
        });
      }
    };
    // 内容作为场景草稿临时写入 writingGuide（生成用），但不进正文
    if (text) {
      const wg = document.getElementById('writingGuide');
      if (wg) { wg.value = text; SM().set('writingGuide', text); BookManager.saveActive({ writingGuide: text }); }
      input.value = '';
      this.resetChatInput(input);
      _start('expandDraft');
    } else {
      // 空输入=纯自动续写：清掉上一轮残留的场景草稿，避免旧草稿被带进本次生成
      var _wg0 = document.getElementById('writingGuide');
      if (_wg0) _wg0.value = '';
      SM().set('writingGuide', '');
      try { BookManager.saveActive({ writingGuide: '' }); } catch(e) {}
      _start('autoContinue');
    }
  },

  // 世界书变量快照：生成前存一份、撤回时整表回滚。
  // 生成过程可能改写变量（正文里的 [VAR] 块、Agent 设定同步），撤回正文时这些改动必须一起回滚，
  // 否则变量会留着「未来」的值。
  // ⚠️ 这两个方法在 v1.5.90 清理死代码时**被连带删掉**（调用点留着、实现没了）：generate() 第一步
  // 就调 _saveVarSnapshot → 抛 TypeError → 整个发送链路失效（用户看到的只是「点发送没反应」），
  // 撤回按钮同理。v1.5.92 依据 v1.5.89 的打包产物原样恢复，并补了 try/catch 与 wbId 归属。
  _saveVarSnapshot() {
    try {
      const wbId = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId) ? WorldBookManager.getActiveId() : '';
      if (!wbId) { this._varSnapshot = null; return; }
      const all = SM().get<any>(VariableManager._key, {}) || {};
      this._varSnapshot = { wbId: wbId, vars: JSON.parse(JSON.stringify(all[wbId] || {})) };
    } catch (e) { this._varSnapshot = null; }
  },

  _restoreVarSnapshot() {
    const snap = this._varSnapshot;
    this._varSnapshot = null;
    if (!snap || !snap.wbId) return;
    try {
      const all = SM().get<any>(VariableManager._key, {}) || {};
      // 生成前该世界书没有变量 → 整条删掉，避免回滚后残留本轮新加的键
      if (Object.keys(snap.vars || {}).length === 0) delete all[snap.wbId];
      else all[snap.wbId] = snap.vars;
      SM().set(VariableManager._key, all);
    } catch (e) { /* 回滚失败不影响撤回主流程 */ }
  },

  undoLastGeneration() {
    if (this._undoSnapshot === undefined || this._undoSnapshot === null) { App.toast('没有可撤回的续写内容'); return; }
    // 使正在异步执行的记忆提取/时间更新/填表写入失效，避免它们覆盖已恢复的快照
    this._dbEpoch = (this._dbEpoch || 0) + 1;

    // 记录撤回前的续写轮次，用于清理原文向量
    var _undoTurnNum = this._lastContNumber || 0;

    // 从快照恢复记忆数据库（撤回续写时回滚填表写入）
    if (this._undoDBSnapshot && typeof DatabaseManager !== 'undefined') {
      DatabaseManager.saveDB(this._undoDBSnapshot);
      this._undoDBSnapshot = null;
      if (document.getElementById('pluginFullscreen') && document.getElementById('pluginFullscreen')!.style.display === 'flex') {
        UIManager.renderDatabase();
      }
    }

    // 回退续写计数
    if (_undoTurnNum > 0) {
      var _uiSnap = SM().get<any>('uiSettings', {});
      if ((_uiSnap.totalContinuationCount || 0) > 0) {
        _uiSnap.totalContinuationCount--;
        SM().set('uiSettings', _uiSnap);
      }
    }

    // 恢复变量
    this._restoreVarSnapshot();

    // 恢复编辑器
    const editor = document.getElementById('editor');
    editor!.innerHTML = this._undoSnapshot;
    this._undoSnapshot = null;
    // 撤回后把上次发送的输入内容恢复到写作输入框，方便修改/补充后重新发送
    const _wInput = document.getElementById('writingInput');
    const _draft = this._lastInputText || this._undoInputDraft || '';
    if (_wInput && _draft) { _wInput.value = _draft; _wInput.focus(); }
    this._lastInputText = '';
    this._undoInputDraft = '';
    // 清理上一轮的场景草稿（writingGuide），避免旧草稿残留影响后续生成
    var _wgTa = document.getElementById('writingGuide');
    if (_wgTa) _wgTa.value = '';
    SM().set('writingGuide', '');
    try { BookManager.saveActive({ writingGuide: '' }); } catch(e) {}

    if (typeof EditorManager.highlightDialogue === 'function') EditorManager.highlightDialogue();
    App.saveCurrentChapter();
    App.updateWordCount();
    App.toast('已撤回上次续写及变量');
  },

  async updateCharacterDescriptions() {
    const wb = WorldBookManager.getActive();
    const chars = CharacterManager.getByWorldBook(wb ? wb.id : null);
    if (chars.length === 0) return;
    const recentText = EditorManager.getCrossChapterContext(2500);
    // Only update characters that appeared in recent text
    const activeChars = chars.filter((c: any) => {
      const escaped = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(escaped).test(recentText);
    });
    if (activeChars.length === 0) return;
    const charInfo = activeChars.map((c: any) =>
      c.name + ' | ' + (c.gender || '未知') + ' | ' + (c.age || '未知') + '岁 | 关系:' + (c.relation || '无') + ' | ' + (c.description || '无介绍')
    ).join('\n');
    const messages = [
      { role: 'system', content: '你是一位专业的小说角色设定更新专家。根据最新小说内容，更新在最新内容中有新表现的角色详细介绍。输出格式（每个角色一行）：\n角色名 | 更新后的详细介绍\n\n规则：\n1. 保留角色基本信息，融入最新内容中的新表现、性格展现、关系变化\n2. 详细介绍要连贯完整，包含外貌特征、性格特点、与主角的关系、近期重要变化\n3. 如果角色在最新内容中没有值得补充的新信息，不要输出该角色\n4. 只输出确实需要更新的角色\n5. 每个角色的详细介绍严格控制在150字以内，超出部分不会被采纳' },
      { role: 'user', content: '【角色当前信息】\n' + charInfo + '\n\n【最新小说内容】\n' + (recentText || '(无)') + '\n\n请输出需要更新详细介绍的角色（格式：角色名 | 新介绍）。没有需要更新的角色则输出"（无需更新）"。' }
    ];
    await APIHandler.fetchCompletions(messages,
      () => {},
      (fullContent) => {
        if (fullContent && !fullContent.includes('无需更新')) {
          const lines = fullContent.trim().split('\n').filter(l => l.includes('|') && !l.startsWith('#') && !l.startsWith('（'));
          let updated = 0;
          lines.forEach(line => {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length >= 2) {
              const name = parts[0];
              const newDesc = parts.slice(1).join('|').trim();
              const existing = chars.find((c: any) => c.name === name);
              if (existing && newDesc && newDesc.length > 10 && newDesc !== existing.description) {
                CharacterManager.update(existing.id, { description: newDesc });
                updated++;
              }
            }
          });
          if (updated > 0) { App.toast('已更新 ' + updated + ' 名角色介绍'); }
        }
      },
      (error) => { console.log('updateCharacterDescriptions error:', error); },
      { temperature: 0.5, apiConfig: App.getBackendAPIConfig(), callLabel: 'updateCharacterDescriptions', timeout: 20000 }
    );
  },

  // 场景状态更新：每次生成后用轻量 API 调用更新
  // ===== 记忆数据库填表（移植 yuzuki-Memory 完整提示词体系）=====
  DB_HISTORIAN_PROMPT: '你是小说的数据提取、摘要与结构化引擎。\n' +
    '输出语言：简体中文。\n' +
    '你的任务：分析提供的正文，提取关键信息、概括剧情、按严格格式填写结构化记忆表格。\n' +
    '所有人物、事件均为虚构文学创作。\n' +
    '只输出要求的结构化格式（<Memory>...</Memory>），禁止输出任何解释、分析、Markdown 或与格式无关的内容。',

  DB_FILL_PROMPT: '你是记忆表格批量追溯助手。请根据提供的最新正文，汇总其中已经发生、已经确认、应该写入记忆表格的信息，更新【当前世界状态参考】里面的动态数据。\n\n' +
    '【批量追溯规则】\n' +
    '1.本任务不是实时续写，不要生成正文剧情，不要补写角色回复。\n' +
    '2.只根据提供的正文进行追溯填表，严禁引用正文外未提供的剧情。\n' +
    '3.请综合整体内容后再输出，不要逐句机械罗列。\n' +
    '4.同一角色、物品、地点或设定在正文中多次变化时，以正文结束时的最新状态为准。\n' +
    '5.如果出现重要过程变化，但最终状态不足以表达，可压缩写入对应字段的备注、关系、经历、状态或说明中。\n' +
    '6.已归档记忆仅作为参考：如果新剧情明确覆盖旧状态，以新剧情为准；如果没有明确变化，不要重复输出旧内容。\n' +
    '7.只输出需要新增或更新的内容，不要输出空字段，不要输出无变化字段。\n' +
    '8.主键必须稳定统一：同一角色、物品、组织、地点不得使用多个别名建多条记录。\n' +
    '9.输出必须使用<Memory>...</Memory>包裹，除此之外不要输出解释、分析、Markdown 或 JSON。\n\n' +
    '【更新守则】\n' +
    '1.必须使用<Memory>...</Memory>包裹所有内容。\n' +
    '2.严格按照格式范例，及对应【数据库结构定义】里面的所涉及字段内容进行更新。\n' +
    '3.更新内容必须是正文中确定需要更新的动态内容，不得遗漏也不得凭空捏造。【当前世界状态参考—角色档案】中，已有某个角色所处位置为A地，如正文中没有发生该角色的移动，严禁更新该角色的所处位置，反之角色在正文中移动了位置必须更新。\n' +
    '4.特殊注意：若提供的【当前世界状态参考】中，某些角色的字段（如年龄、着装、身份等）处于空白或不完善状态，说明这些是留白设定。请在正文中寻找自然出现的已确认信息，并在更新区中提取并完善这些字段；没有依据时不得强行补全。\n' +
    '5.主键名字必须使用[]包裹。不需要更新的字段严禁写入任何内容，只写需要更新的，空白的不需要更新的字段请直接省略。\n\n' +
    '【数据库结构定义】\n' +
    '__TABLE_DEFINITIONS__\n\n' +
    '【格式范例】\n' +
    '【范例使用限制】以下内容只说明字段顺序与分隔符格式，里面的角色、物品、组织、地点、日期都不是剧情事实。严禁把范例中的任何占位内容直接写入记忆表格；必须替换为当前剧情或已提供设定中明确存在的信息。没有依据时，整行不要输出。\n' +
    '<Memory>\n' +
    '#角色档案\n' +
    '[角色全名]|年龄：具体年龄|性别：性别|身份：当前社会身份/职业身份|性格：性格关键词|当前位置：城市·区域·建筑·内部位置·姿态|周围角色：同场角色A、同场角色B|生理：当前生理状态|人际关系：{目标角色}：〔关系〕 · 〔情感〕|着装：衣物/随身物|待办事项：〔1〕日期时间·事项(优先级);〔2〕日期时间·事项(优先级)|约定：日期角色A与角色B约定具体事项\n' +
    '#物品追踪\n' +
    '[物品稳定名称]|物品描述：外观/用途/剧情意义|物品位置：当前位置|持有者：持有者姓名|状态：完好/损坏/丢失|备注：剧情依据\n' +
    '#世界设定\n' +
    '[设定词条名]|类型：组织/地点/规则/事件|详细说明：已确认设定内容|影响范围：影响到的人物、区域或剧情范围\n' +
    '</Memory>\n\n' +
    '【字段更新规则】\n' +
    '你务必严格遵守以下字段更新规则：\n' +
    '#角色档案\n' +
    '[角色名]：必须输出角色全名，严格按原名更新，严禁同一个角色使用不同别名。姓名主键：新增角色时必须使用唯一且最完整的全名。已有角色名若包含"|"，各段都是同一角色的等价姓名，第一段是主姓名；使用其中任一完整姓名更新时都视为同一角色，严禁拆成多条档案。格式锁定：注意中外文译名的标点符号，包含间隔号的必须保留（如 A·B 不能写成 AB）。去重原则：在输出前校验该角色是否已有档案。若已存在，优先使用档案中的第一段主姓名，也允许使用"|"分隔的任一已登记姓名；禁止因名字的微小差异（如多字少字、标点不同）把同一角色判定为多个角色。\n' +
    '[基础资料]：当角色档案中不存在该角色而需要新增角色时，必须同时填写年龄、性别、性格、身份等基础资料；若发现旧角色档案缺少年龄、性别、性格、身份等基础资料，必须在本次更新中补全，严禁这些基础字段为空。\n' +
    '[年龄]：如该角色有档案则根据档案填写，如无，则根据剧情推算一个确定的年龄，严禁写"19左右"这种大概推算。\n' +
    '[性别]：必须为每个角色填写确切的性别字段，男/女即可，若设定属于其他特殊故事背景，可在性别后用括号备注。\n' +
    '[身份]：仅显示当前的社会身份/职业身份（如xx公司秘书），如角色身份变更必须在当前剧情正文下进行更新。\n' +
    '[性格]：若角色卡或【当前世界状态参考—角色档案】中已经存在基础设定，请勿重复添加或随意变更，留空即可，此处只针对没有设定好的角色的性格关键词，可根据剧情或角色的首次出场给定3-5组性格关键词。\n' +
    '[当前位置]：城市·区域·建筑·内部位置·相对身体姿态(如躺在床上/背对站立)；若地点未知强制赋予符合故事背景的虚构具体名，严禁使用模糊词（如A市）。\n' +
    '[周围角色]：反映当前角色所在物理环境的人员变动，填入同一场景下其他角色的姓名（多人用逗号隔开），绝对禁止将正在更新的档案主角包含在内。\n' +
    '[生理]：身体状态（如：醉酒/发烧/受伤部位/疲劳程度/特殊生理状态）。\n' +
    '[人际关系]：{目标角色A}：2字描述(优先私密) · 〔2字情感〕；必须严格为2个汉字。优先判定私密关系（如：恋人、情妇、暗恋），若无私密关系则填社会关系（如：学长、上司、宿敌），内在情感表示当前对其的内心真实动态（如：关心、警惕、算计、利用、敷衍），并用〔〕包裹。必须根据最新剧情的发展，实时改变关系和情感词。\n' +
    '[着装]：严格符合人设身份与季节场景。脱衣/洗澡/睡觉时自动移除更新对应衣物。\n' +
    '[待办事项]：必须是独立的社会、职业、家族事务，严禁生成对主角的打算、微观动作或未来剧情剧透。基础显示必须维持2-4条。待办事项必须在剧情中展现处理的具体过程和进展。每天凌晨刷新，当天规划一整天日程。前日未完成事项在当日继承。\n' +
    '[约定]：双方约束，只更新其中一人的约定字段即可，避免重复写入。约定内容必须是双方明确达成共识的约定/承诺或誓言，严禁重复记录不同时间下相同的约定内容。\n\n' +
    '#物品追踪\n' +
    '[物品名称/昵称/主键]：只能填写物品本身的稳定名称，或剧情明确赋予且不会随状态变化的固定昵称。用于区分不同实体的固定型号、材质、颜色或专名可以保留。名称纯净：严禁把会随剧情变化的完整度、外观、污染、内容物、位置、归属等状态或描述拼进名称，例如"完好的宝物""破损的宝物""沾血的匕首""空的保温杯"都是错误主键。字段归位：完好、损坏、丢失、被盗等写入[状态]；血迹、污渍、破旧外观、装载内容等细节写入[物品描述]或[备注]，不得借此改名。去重原则：新增前必须先按物品本体核对【当前世界状态参考】。若是同一件物品，必须沿用已有主键并只更新对应字段；严禁因状态或描述变化新增记录。只有剧情明确出现另一件独立实体，且存在稳定区分名称时，才可新增。\n' +
    '仅记录具有唯一性、剧情关键性的道具(神器、钥匙、信物、礼物)。严禁记录消耗品或环境杂物。物品流转时，必须更新其[持有者]和[当前位置]。物品的名称请严格唯一，不得同一个物品使用不同别名；物品的状态更新必须基于剧情明确描述，严禁无依据的状态变更，且状态表示需用简短的词语，如完好/损坏/丢失/被盗等，禁止使用模糊词（如可能丢失、好像坏了）。\n\n' +
    '#世界设定\n' +
    '仅记录基础设定/过往剧情/已经记录的设定外的，完全不存在的全新概念。类型名如:政治 / 组织 / 势力 / 阵营; 自然 / 地理 / 环境 / 现象；历史 / 事件 / 战争 / 传说；物品 / 资源 / 矿物 / 道具；其他。\n\n' +
    '#剧情摘要\n' +
    '主线摘要：[日期] 涉及主角的核心行动与关键剧情归入主线；客观概括（谁、何时、何地、做了什么），严禁心理分析、抽象定性，只记录客观行为与对话核心，禁止主观评论。时间轴对齐：必须从正文中提取具体的日期和时间段；若无明确时间，需根据上下文推断合理的相对时间，保持时间线连贯。\n' +
    '支线摘要：[日期] 仅涉及配角行动、背景事件的归入支线；同样只记录客观行为，谁在场必须记录，防止幽灵角色。',

  // ===== 正文窗口（字）：单一设置，取代旧的「上下文 tokens × 字/token × 50%」 =====
  _storyWindowChars() {
    try {
      const v = normalizeStoryWindow(SM().get<any>('storyWindowChars', STORY_WINDOW_DEFAULT));
      console.log('[Waterline] 正文窗口', v, '字（', storyWindowTrigger(v), '字触发归档）');
      return v;
    } catch (e) { return STORY_WINDOW_DEFAULT; }
  },
  // 记忆页那一栏的写入入口：夹取范围 → 存 → 回填输入框 → 刷新估算提示
  setStoryWindow(v: any) {
    const n = normalizeStoryWindow(v);
    try { SM().set('storyWindowChars', n); } catch (e) { /* ignore */ }
    const el = document.getElementById('storyWindowChars') as HTMLInputElement | null;
    if (el) el.value = String(n);
    try { if (typeof UIManager !== 'undefined' && UIManager.renderCtxBudgetHint) UIManager.renderCtxBudgetHint(); } catch (e) { /* ignore */ }
    return n;
  },

  // 事实卡拉取：窗口命中实体 → 数据库对应记录（按主键/别名含任一实体），截断后成行
  /** 管理员模式：把本轮（指令 / 记忆召回 / 续写）上报到服务器留档；未开启或失败静默 */
  _uploadAdminTrace(bodyText: any) {
    try {
      if (typeof AdminMode === 'undefined' || !AdminMode.isOn()) return;
      const t = (App._lastGenTrace || {}) as Record<string, any>;
      App._traceRound = (App._traceRound || 0) + 1;
      let model = '';
      try { model = String((SM().get<any>('apiConfig', {}) || {}).model || ''); } catch (e) { /* 忽略 */ }
      AdminMode.sendTrace({
        book: String(App.getNovelData().title || ''),
        round: App._traceRound,
        model: model,
        windowChars: Number(t.windowChars) || 0,
        budget: Number(t.budget) || 0,
        instruction: String(t.instruction || ''),
        continuation: String(bodyText || '').replace(/<[^>]*>/g, '').slice(0, 20000),
        recall: {
          pieces: Array.isArray(t.pieces) ? t.pieces : [],
          chars: Number(t.recallChars) || 0,
          candidates: Number(t.candidates) || 0,
          blocks: Number(t.archiveBlocks) || 0,
          factCards: !!t.factCards,
          mode: String(t.mode || ''),
        },
      });
    } catch (e) { /* 上报失败不影响写作 */ }
  },
  _pullFactCards(entities: any) {
    var lines: any[] = [];
    var seenPk = {} as Record<string, any>;
    var self = this;
    DatabaseManager.getTables().forEach(function (t) {
      if (!t || !DatabaseManager.getRecords) return;
      var pk = DatabaseManager._primaryColumn(t);
      (DatabaseManager.getRecords(t.id) || []).slice(0, 60).forEach(function (r) {
        var pkVal = String(r.values[pk] || '').trim();
        if (!pkVal || seenPk[pkVal]) return;
        var parts = pkVal.split('|').map(function (s) { return s.trim(); });
        var hit = parts.some(function (p) { return entities.indexOf(p) >= 0; });
        if (!hit && pk === '设定名') {
          hit = entities.some(function (e: any) { return String(r.values['详细说明'] || '').indexOf(e) >= 0; });
        }
        if (!hit) return;
        seenPk[pkVal] = 1;
        var segs: any[] = [];
        (t as any).columns.forEach(function (col: any) {
          var colName = col.replace(/^[#*]/, '');
          if (colName === pk) return;
          var v = r.values[colName];
          if (v && String(v).trim()) segs.push(colName + '：' + String(v).trim().split('\n')[0].slice(0, 120));
        });
        if (segs.length) lines.push('[' + pkVal.replace('|', '|') + ']|' + segs.join('|'));
      });
    });
    return lines.length ? lines.join('\n') : '';
  },

  // 数据库表结构描述（对齐柚月 buildDatabaseSchemaText）
  _dbSchemaText() {
    var lines: any[] = [];
    DatabaseManager.getTables().forEach(function (t) {
      if (t.id === 'plot_summary') {
        lines.push('#剧情摘要：包含 #主线摘要：摘要名称，日期，摘要内容；#支线摘要：日期，摘要内容');
        return;
      }
      var fields = (t as any).columns.map(function (c: any, i: any) {
        var col = c.replace(/^[#*]/, '');
        if (i === 0) {
          return t.id === 'character_profile'
            ? col + '(主键；值含"|"时各姓名均指同一角色，第一段为主姓名)'
            : col + '(主键)';
        }
        return col;
      }).join(', ');
      lines.push('#' + (t as any).name + '：包含 ' + fields);
    });
    return lines.join('\n');
  },

  // 世界书设定参考（填表时给模型角色/世界观基础设定，让它正确填角色档案静态字段）
  // 过滤变量/前端类型；内容完整注入，不截断（截断会破坏设定完整性）
  _dbWorldbookRef() {
    var wb = WorldBookManager.getActive();
    if (!wb || !wb.entries) return '';
    var lines = ['【世界书设定】（以下为角色/世界观基础设定，填写角色档案时请参考其中的性格、身份、年龄等静态信息；动态信息以【最新正文】为准）'];
    var count = 0;
    wb.entries.forEach(function (e) {
      if (count >= 100) return;
      if (e.type === '变量' || e.type === '前端') return;
      var c = e.content || '';
      if (!c.trim()) return;
      lines.push('[' + (e.type || '其他') + '] ' + (e.name || '未命名') + '：' + c.trim());
      count++;
    });
    return lines.length > 1 ? lines.join('\n') : '';
  },

  // 当前世界状态参考（对齐柚月 tablesToReferenceText 格式）
  _dbStateReference() {
    var db = DatabaseManager.getDB();
    var lines: any[] = [];
    db.tables.forEach(function (t: any) {
      lines.push('【当前世界状态参考—' + t.name + '】');
      var recs = db.records[t.id] || [];
      if (recs.length === 0) { lines.push('（当前暂无数据）'); lines.push(''); return; }
      var pk = DatabaseManager._primaryColumn(t);
      recs.forEach(function (r: any) {
        var segs: any[] = [];
        t.columns.forEach(function (col: any) {
          var colName = col.replace(/^[#*]/, '');
          if (colName === pk) return;
          var v = r.values[colName];
          if (v && String(v).trim()) segs.push(colName + '：' + String(v).trim());
        });
        lines.push('[' + ((r.values[pk] || '?') + '').trim() + ']' + (segs.length ? '|' + segs.join('|') : ''));
      });
      lines.push('');
    });
    return lines.join('\n');
  },

  async fillMemoryTable(newText: any) {
    // 只认「撤回代际」：撤回会回滚数据库快照，飞行中的结果必须作废；新生成不作废（见 _dbEpoch 注释）
    var _undoEpoch = App._dbEpoch || 0;
    var _t0 = Date.now();
    var _lastTruncated = false; // 输出是否被 max_tokens 截断（截断会让后面几张表整段没写，是关键线索）
    var _elapsed = function () { return Math.round((Date.now() - _t0) / 100) / 10 + 's'; };
    App._dbFillStatus = '';
    App._dbFillSkipped = 0;
    App._dbFillTruncated = false;
    try {
      if (typeof DatabaseManager === 'undefined' || !DatabaseManager.isEnabled()) return 0;
      // 正文太短（不足 50 字）不值得花一次填表调用，直接跳过
      if (String(newText || '').trim().length < 50) { App._dbFillStatus = 'skipped'; return 0; }
      var apiConfig = DatabaseManager.getApiConfig() || PresetManager.getActiveAPIConfig();
      // 没有 key 单列一个状态：此前与"正文太少"共用 'skipped'，提示语说成"正文太少"是错的
      if (!apiConfig || !apiConfig.apiKey) {
        App._dbFillStatus = 'nokey';
        ClientLog.note('数据库填表', '未配置可用的 API Key（自动填表会一直什么都不做）');
        return 0;
      }
      // 填表是结构化提取，不需要创作思考——强制思考 off（避免 muse 等思考模型长思考
      // 吃光 maxTokens 导致截断、填不出有效块；也省 token）
      apiConfig = { ...apiConfig, deepseekThinking: 'off' };
      var schema = this._dbSchemaText();
      // 数据库插件可覆盖填表提示词（data.fillPrompt），否则用通用模板
      var fillTemplate = (typeof DatabaseManager !== 'undefined' && DatabaseManager.fillPrompt) ? DatabaseManager.fillPrompt() : null;
      var prompt = (fillTemplate || this.DB_FILL_PROMPT).replace('__TABLE_DEFINITIONS__', schema);
      var stateRef = this._dbStateReference();
      var wbRef = this._dbWorldbookRef();
      // 稳定前缀在前（史官→世界书→提示词），最大化缓存命中；
      // 变化的【当前世界状态参考】和【最新正文】放最后（每轮必变，命中不了但很小）
      var messages = [
        { role: 'system', content: this.DB_HISTORIAN_PROMPT },
      ];
      if (wbRef) messages.push({ role: 'system', content: wbRef });
      messages.push({ role: 'system', content: prompt });
      messages.push({ role: 'system', content: stateRef });
      messages.push({ role: 'user', content: '【最新正文】\n' + (newText || '').slice(-3000) + '\n\n请立即根据以上最新正文、世界书设定和批量追溯填表提示词执行任务，只输出<Memory>更新块。' });
      // 失败自动重试一次（借鉴 yuzuki task-runner 的重试思路，简化为单次）。
      // 输出不设上限（一律按端点能接受的最大值发送）：实测思考关不掉的端点
      // （commandcode+deepseek-v4.1-flash 只认 reasoning_effort low..max）在 6000/16000 档
      // 会被思考吃光（正文 0 字、finish_reason=length），放开后一次就能产出完整更新块；
      // 耗时上限由 timeout 兜（120s）。
      var doFetch = function () {
        return new Promise(function (resolve) {
          var _truncated = false;
          APIHandler.fetchCompletions(messages,
            function () {},
            function (full) { _lastTruncated = _truncated; resolve(full == null ? null : { text: String(full), truncated: _truncated }); },
            function (err) { console.warn('[DB] fill failed:', err); resolve(null); },
            {
              temperature: 0.3, apiConfig: apiConfig, callLabel: 'fillMemoryTable', timeout: 120000,
              onFinishReason: function (fr: any) { if (fr === 'length') _truncated = true; }
            }
          );
        });
      };
      // 一次尝试 = 请求 + 解析：只要拿到可解析的更新块就算成功。
      // 被截断（finish_reason=length）不再一律当失败——截断只丢最后半行，已解析出的行照常入库；
      // 一点都解析不出来（例如思考把预算吃光、正文 0 字）才算失败，交给上层重试。
      var attempt = async function () {
        var res: any = await doFetch();
        if (!res || !String(res.text || '').trim()) return null;
        var parsedRows = App._parseDBFillResult(res.text);
        if (!parsedRows || parsedRows.length === 0) {
          console.warn('[DB] fill 输出无可解析更新块（truncated=' + !!res.truncated + '）');
          return null;
        }
        if (res.truncated) console.warn('[DB] fill 输出被截断，按已解析的', parsedRows.length, '条入库');
        console.log('[DB] raw output:', String(res.text).slice(0, 800));
        return parsedRows;
      };
      var parsed = await attempt();
      if (!parsed) {
        await new Promise(function (r) { setTimeout(r, 2500); });
        if (_undoEpoch !== (App._dbEpoch || 0)) { console.warn('[DB] fill 期间发生撤回，丢弃重试'); App._dbFillStatus = 'undone'; return 0; }
        console.warn('[DB] fill 首次失败，重试一次');
        parsed = await attempt();
      }
      if (!parsed) {
        console.warn('[DB] fill 重试仍失败，本轮放弃');
        App._dbFillStatus = 'failed';
        ClientLog.note('数据库填表', '两次尝试都未拿到可解析更新块' + (_lastTruncated ? '（输出被截断）' : '') + '，耗时 ' + _elapsed());
        return 0;
      }
      console.log('[DB] parsed:', JSON.stringify(parsed).slice(0, 400));
      if (_undoEpoch !== (App._dbEpoch || 0)) {
        console.warn('[DB] fill 期间发生撤回，丢弃本轮填表结果');
        App._dbFillStatus = 'undone';
        ClientLog.note('数据库填表', '结果因撤回作废：解析 ' + parsed.length + ' 行，耗时 ' + _elapsed());
        return 0;
      }
      var n = App._applyDBFillResult(parsed);
      App._dbFillTruncated = _lastTruncated;
      console.log('[DB] fill applied:', n, 'updates | skipped:', App._dbFillSkipped, '| truncated:', _lastTruncated);
      App._dbFillStatus = n > 0 ? 'ok' : 'empty';
      // 只在"没写成"或"输出被截断"时上报诊断（成功且完整就不打扰）：只带状态与计数，不带正文
      if (n === 0 || _lastTruncated) {
        ClientLog.note('数据库填表', '解析 ' + parsed.length + ' 行 → 写入 ' + n + ' 行 / 未写入 ' + (App._dbFillSkipped || 0) + ' 行'
          + (_lastTruncated ? '（输出被截断，可能只写了一半）' : '') + '，耗时 ' + _elapsed());
      }
      return n;
    } catch (e) {
      console.warn('[DB] fill error:', e);
      App._dbFillStatus = 'failed';
      ClientLog.note('数据库填表', '异常失败：' + ((e && (e as Error).message) || e) + '，耗时 ' + _elapsed());
      return 0;
    }
  },

  // 手动"立即填表"（数据库页按钮）—— 防抖：上一轮还没结束时不重复触发
  async fillMemoryTableNow() {
    if (this._dbFilling) { App.toast('正在回溯填表中，请稍候'); return; }
    if (typeof DatabaseManager === 'undefined' || !DatabaseManager.isEnabled()) {
      App.toast('请先在插件区开启数据库');
      return;
    }
    this._dbFilling = true;
    try {
      App.toast('正在回溯填表...');
      var recentText = EditorManager.getCrossChapterContext(3000);
      var n = await this.fillMemoryTable(recentText);
      // 失败与"无更新"必须分开说：失败时模型连一个更新块都没吐出来（此前一律显示"无更新"，
      // 看起来像"点了没用"）。另外三种情况此前都伪装成"无更新"，现在逐一说明真实原因。
      var st = App._dbFillStatus;
      if (st === 'failed') App.toast('回溯填表失败：模型未返回可解析的更新块（已记入诊断，可稍后重试）');
      else if (st === 'skipped') App.toast('回溯填表已跳过：当前章节正文太少');
      else if (st === 'nokey') App.toast('回溯填表已跳过：没有可用的 API Key（请在高级设置配置主 API，或在数据库页指定填表 API）');
      else if (st === 'undone') App.toast('回溯填表结果已作废：期间发生了撤回，请重试');
      else if (n > 0) App.toast('回溯完成：更新 ' + n + ' 条' + (App._dbFillTruncated ? '（模型输出被截断，可能只写了一半，可再点一次补齐）' : ''));
      else if (App._dbFillSkipped > 0) App.toast('回溯完成（无更新）：识别到 ' + App._dbFillSkipped + ' 行但没写进去（空内容/与已有内容重复/主键为空）');
      else App.toast('回溯完成（无更新）');
      if (document.getElementById('pluginFullscreen') && document.getElementById('pluginFullscreen')!.style.display === 'flex') {
        UIManager.renderDBRecords();
      }
    } finally {
      this._dbFilling = false;
    }
  },

  // 解析 AI 填表输出：按 #表名 分节，[主键]|字段：值 行
  _parseDBFillResult(text: any) {
    var result: any[] = [];
    var cur: any = null;
    // 剧情摘要的「待收内容」缓冲：模型常写成
    //   主线摘要：
    //   [3月5日] 林晚去了城东。
    // 冒号后为空、内容换行写在后面。此前这行被解析成 text=''，写库函数因空文本什么都没写，
    // 却仍被计为一次「更新」——用户看到提示说更新了，库里只有那条永远存在的空白摘要，
    // 且因为计数 > 0 连诊断都不上报（2026-09-22 用户报的「只有一个未命名空摘要」）。
    var flushPlot = function () {
      if (cur && cur.kind === 'plot' && cur.plotCol && cur.plotBuf && cur.plotBuf.length > 0) {
        result.push({ tableId: 'plot_summary', plotCol: cur.plotCol, text: cur.plotBuf.join(' ').trim() });
      }
      if (cur && cur.kind === 'plot') { cur.plotCol = null; cur.plotBuf = []; }
    };
    // 剥离 <Memory> 包裹标签（柚月输出格式）
    text = String(text || '').replace(/<\/?[Mm]emory\s*>/g, '');
    var lines = String(text || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      // 表名标题：兼容模型爱写的 markdown 二级标题（## 角色档案）。此前只认单个 #，
      // 于是整段被静默丢弃 → 一次填表白跑（两轮尝试后提示"失败"，用户只看到"没更新"）。
      // 只放宽到 1~2 个 #：### 之类的小标题不重置当前表，避免把后续行误判成新表的行。
      var header = line.match(/^#{1,2}(?!#)[ \t]*(.+)$/);
      if (header) {
        var name = header[1].trim();
        if (cur && cur.kind === 'plot' && (name === '主线摘要' || name === '支线摘要')) { flushPlot(); cur.plotCol = name; continue; }
        if (name === '剧情摘要') { flushPlot(); cur = { kind: 'plot' }; continue; }
        var table = DatabaseManager.getTables().find(function (t) { return (t as any).name === name; });
        // 模糊表名匹配：模型常把「物品追踪」简写成「物品」、「角色档案」简写成「角色」等，
        // 精确匹配失败时按包含关系兜底，避免整节更新被静默丢弃
        if (!table) table = DatabaseManager.getTables().find(function (t) { return (t as any).name.indexOf(name) >= 0 || name.indexOf((t as any).name) >= 0; });
        flushPlot(); // 切表前先把待收的摘要落地，否则这段摘要会连带丢失
        if (table) { cur = { kind: 'table', tableId: table.id }; continue; }
        cur = null; continue;
      }
      if (!cur) continue;
      if (cur.kind === 'plot') {
        // 兼容剧情摘要的三种写法：
        // A. 主线摘要：[日期] 内容
        // B. 主线摘要：\n[日期] 内容（内容换行写在后面——老版会把这段丢成空文本）
        // C. ##主线摘要 表头 + [标题]|日期：xxx|摘要内容：xxx
        var pm = line.match(/^(主线摘要|支线摘要)\s*[:：]\s*([\s\S]*)$/);
        if (pm) {
          flushPlot();
          var _t = pm[2].trim();
          if (_t) result.push({ tableId: 'plot_summary', plotCol: pm[1], text: _t });
          else cur.plotCol = pm[1]; // 冒号后为空 → 收后续行
          continue;
        }
        var pmh = line.match(/^#+#?\s*(主线摘要|支线摘要)\s*$/);
        if (pmh) { flushPlot(); cur.plotCol = pmh[1]; continue; }
        var pmr = line.match(/^\[([^\]]+)\]\|日期\s*[:：]\s*([^|]*?)\|摘要内容\s*[:：]\s*([\s\S]*)$/);
        if (pmr) {
          var _col = cur.plotCol || '主线摘要';
          flushPlot();
          var date = pmr[2].trim();
          var _txt = ((date ? '[' + date + '] ' : '') + pmr[3].trim()).trim();
          if (_txt) result.push({ tableId: 'plot_summary', plotCol: _col, text: _txt });
          continue;
        }
        // 结构外的普通行：正等着收内容就补进去（多行会拼成一条）
        if (cur.plotCol) { if (!cur.plotBuf) cur.plotBuf = []; cur.plotBuf.push(line); continue; }
        continue;
      }
      var m2 = line.match(/^\[([^\]]+)\](?:\|([\s\S]*))?$/);
      if (!m2) continue;
      var table2 = DatabaseManager.getTable(cur.tableId);
      if (!table2) continue;
      var pk = DatabaseManager._primaryColumn(table2);
      var values = {} as Record<string, any>;
      values[pk] = m2[1].trim();
      if (m2[2]) {
        m2[2].split('|').forEach(function (seg) {
          var segT = seg.trim();
          if (!segT) return;
          var idx = segT.indexOf('：');
          var key = idx > 0 ? segT.slice(0, idx).trim() : '';
          var val = idx > 0 ? segT.slice(idx + 1).trim() : segT;
          if (key) values[key] = val;
        });
      }
      result.push({ tableId: cur.tableId, values: values });
    }
    flushPlot(); // 文件末尾还挂着的待收摘要（内容写在最后几行）也要落地
    return result;
  },

  // 过滤"未提及/无/未知"等占位词字段，避免写入数据库
  _cleanDBPlaceholders(values: any) {
    var skip = ['未提及', '无', '未知', '不详', '暂无', 'n/a', 'N/A'];
    var out = {} as Record<string, any>;
    for (var k in values) {
      if (!Object.prototype.hasOwnProperty.call(values, k)) continue;
      var v = String(values[k] || '').trim();
      if (!v) continue;
      if (skip.indexOf(v) >= 0) continue;
      out[k] = v;
    }
    return out;
  },

  _applyDBFillResult(result: any) {
    var n = 0;
    var skipped = 0; // 没写成的行：空内容 / 与已有内容完全重复 / 主键为空
    var self = this;
    var _plotText = function (col: any) {
      var recs = (DatabaseManager.getDB().records || {}).plot_summary || [];
      return recs.length ? String((recs[0].values || {})[col] || '') : '';
    };
    (result || []).forEach(function (item: any) {
      if (item.tableId === 'plot_summary' && item.plotCol) {
        var txt = String(item.text || '').trim();
        if (!txt) { skipped++; return; } // 空摘要行：以前照样 n++，于是"更新了"却是空的
        // 追加是幂等的（完全重复的行不会写入）→ 用写入前后文本是否变化判断这次是否真的写了
        var before = _plotText(item.plotCol);
        DatabaseManager.appendPlotLine(item.plotCol, txt);
        if (_plotText(item.plotCol) !== before) n++; else skipped++;
        return;
      }
      if (!item.values) { skipped++; return; }
      // 主键为空（模型吐了 [未知]/[无] 之类占位行，或被占位词过滤掉）→ upsertRecord 拒收。
      // 这类行单独计数：否则"解析出 N 行却 0 更新"在界面上只剩一句「无更新」，根本查不出原因。
      var rec = DatabaseManager.upsertRecord(item.tableId, self._cleanDBPlaceholders(item.values));
      if (rec) n++; else skipped++;
    });
    this._dbFillSkipped = skipped;
    return n;
  },

  async extractCharacters() {
    const statusEl = document.getElementById('generationStatus');
    const prevText = statusEl ? statusEl.textContent : '';
    try {
    if (statusEl) statusEl.textContent = 'AI 正在分析登场角色...';
    const recentText = EditorManager.getCrossChapterContext(5000);
    const wb = WorldBookManager.getActive();
    const existingChars = CharacterManager.getByWorldBook(wb ? wb.id : null);
    // Split existing characters into complete and incomplete
    const isIncomplete = (c: any) => !c.description || c.description.startsWith('（') || !c.gender || c.gender === '其他' || !c.age || !c.relation;
    const incompleteChars = existingChars.filter((c: any) => isIncomplete(c));
    const completeChars = existingChars.filter((c: any) => !isIncomplete(c));
    let existingStr = completeChars.length > 0 ? completeChars.map((c: any) => c.name).join('、') : '';
    let incompleteStr = '';
    if (incompleteChars.length > 0) {
      incompleteStr = incompleteChars.map((c: any) => '- ' + c.name + '（待完善：' + [c.gender || '性别未知', c.age ? c.age + '岁' : '年龄未知', c.relation || '关系未知', c.description || '无介绍'].filter(Boolean).join('，') + '）').join('\n');
    }
    const protag = App.getProtagonist();
    const protagName = (protag && protag.name) ? protag.name : '主角';
    const protagGender = (protag && protag.gender) ? protag.gender : '';
    const messages = [
      { role: 'system', content: '你是一位专业的小说角色提取专家。从小说中提取已登场的有名角色（排除主角' + protagName + '），每个角色一行：\n角色名 | 性别 | 年龄 | 关系 | 详细介绍\n\n- 性别：男/女/其他 | 年龄：从文+世界观推断 | 关系：与主角的关系，逗号分隔最多3个\n- 详细介绍（150字内）：综合文中表现（外貌、性格、与主角关系）\n- 所有出现名字的角色都应提取，已有角色名单中的不要重复\n- 待完善角色务必输出完整信息（性别/年龄/关系/介绍）\n\n【重要】每个角色的详细介绍严格控制在150汉字以内，超出部分视为无效且不会被保存。' },
      { role: 'user', content: '【主角】' + protagName + ' (' + protagGender + ')\n\n' + (completeChars.length > 0 ? '【已有角色（勿重复）】' + existingStr + '\n\n' : '') + (incompleteChars.length > 0 ? '【待完善】\n' + incompleteStr + '\n\n' : '') + '【小说内容】\n' + (recentText || '(无)') + '\n\n请提取新登场角色并补充待完善角色信息。' }
    ];
    await APIHandler.fetchCompletions(messages,
      () => {},
      (fullContent) => {
        if (fullContent) {
          const text = fullContent.trim();

          let added = 0, updated = 0;

          // Parse character lines — any line with | that isn't a SENTIMENT line
          const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('（') && !l.trim().startsWith('[SENTIMENT]') && !l.trim().startsWith('===') && l.includes('|'));
          const isValidName = (n: any) => n && n.length >= 2 && !['角色名','姓名','名称','未知','无','角色'].includes(n) && !/^[a-z]+$/.test(n) && n !== '女性' && n !== '男性';
          const _sanitizeName = (n: any) => { const s = n.replace(/[\u200B-\u200D\uFEFF\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u2028\u2029\u202A-\u202F\u2060-\u2064\u2066-\u206F\u3000]/g,'').trim(); return s.length >= 2 ? s : null; };
          const _createdNames = new Set();
          lines.forEach(line => {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length >= 3 && isValidName(parts[0])) {
              const name = _sanitizeName(parts[0]);
              if (!name) return;
              if (name === protagName || name === 'user' || name === 'User' || name === '{user}' || name === '{User}' || name === '{{user}}' || name === '{{User}}') return;
              if (_createdNames.has(name)) return;
              _createdNames.add(name);
              // Skip if user previously deleted this sync character
              var _dKey2 = '_deletedSyncChars_' + wb!.id;
              var _dList2 = SM().get<any>(_dKey2, []);
              if (_dList2.indexOf(name) >= 0) return;
              const gender = parts[1] || '其他';
              const age = parts[2] || '';
              const relation = (parts[3] && parts[3] !== '-1' && parts[3] !== '无') ? parts[3] : '';
              const descStart = 4;
              let description = parts.length > descStart ? parts.slice(descStart).join('|').trim() : '';
              const existing = existingChars.find((c: any) => c.name === name);
              if (existing) {
                const updates = {} as Record<string, any>;
                const needsCompletion = !existing.description || existing.description.startsWith('（') || !existing.gender || existing.gender === '其他' || !existing.age || !existing.relation;
                if (needsCompletion) {
                  // Fill in all missing or placeholder fields
                  if (gender && gender !== '其他' && (!existing.gender || existing.gender === '其他')) updates.gender = gender;
                  if (age && !existing.age) updates.age = age;
                  if (relation && !existing.relation) updates.relation = relation;
                  if (description && !description.startsWith('（') && (!existing.description || existing.description.startsWith('（'))) updates.description = description;
                } else {
                  if (description && description.length > (existing.description || '').length) updates.description = description;
                  if (relation && relation !== existing.relation) updates.relation = relation;
                }
                if (Object.keys(updates).length > 0) {
                  CharacterManager.update(existing.id, updates);
                  updated++;
                }
              } else {
                CharacterManager.create({ name, gender, age, relation, description });
                added++;
              }
            }
          });

          const msgs: any[] = [];
          if (added > 0) msgs.push('新增 ' + added + ' 名角色');
          if (updated > 0) msgs.push('更新 ' + updated + ' 名角色');
          statusEl!.textContent = prevText || (msgs.length > 0 ? msgs.join('，') : '未发现新角色');
        }
      },
      (error) => { statusEl!.textContent = '角色提取失败: ' + error; },
      { temperature: 0.3, apiConfig: App.getBackendAPIConfig(), callLabel: 'extractCharacters', timeout: 20000 }
    );
    } catch(e) { statusEl!.textContent = '角色提取出错: ' + (e as any).message; console.error('extractCharacters:', e); }
  },

  async syncCharactersFromWorldBook() {
    const wb = WorldBookManager.getActive();
    if (!wb) { App.toast('请先选择一个世界书'); return; }
    const apiConfig = PresetManager.getActiveAPIConfig();
    if (!apiConfig.apiKey) { App.toast('请先在 API 配置中配置 API Key'); return; }
    const charEntries = wb.entries.filter(e => e.type === '角色');
    if (charEntries.length === 0) { App.toast('世界书中没有找到角色条目'); return; }
    const statusEl = document.getElementById('generationStatus');
    const prevText = statusEl!.textContent;
    statusEl!.textContent = '正在同步世界书角色...';
    // Dedup: same name entries get merged content
    const _nameGroups = {} as Record<string, string[]>;
    charEntries.forEach(function (e) {
      if (!_nameGroups[String(e.name)]) _nameGroups[String(e.name)] = [] as string[];
      (_nameGroups[String(e.name)] as string[]).push((e.content || '').slice(0, 200));
    });
    const charList = Object.entries(_nameGroups).map(function (kv) {
      return kv[0] + ' | ' + kv[1].join('；').slice(0, 500);
    }).join('\n');
    const messages = [
      { role: 'system', content: '提取以下世界书条目中的角色信息，每行输出一个角色：\n角色名 | 性别(男/女/其他) | 年龄 | 与主角关系 | 简介\n\n规则：\n- 同名条目自动合并\n- 简介控制在50字以内\n- 只输出纯文本格式，不要任何额外说明' },
      { role: 'user', content: '【角色条目】\n' + charList + '\n\n请提取以上角色信息。' }
    ];
    await APIHandler.fetchCompletions(messages,
      () => {},
      (fullContent) => {
        if (fullContent) {
          const text = fullContent.trim();
          const lines = text.split('\n').filter(l => l.trim() && l.includes('|') && !l.startsWith('#'));
          let added = 0, updated = 0;
          const _syncProtag = App.getProtagonist();
          const _syncProtagName = (_syncProtag && _syncProtag.name) || '';
          const _syncProtagGender = (_syncProtag && _syncProtag.gender) || '';
          const createdNames = new Set();
          lines.forEach(line => {
            const parts = line.split('|').map(p => p.trim());
            if (parts.length < 3) return;
            const name = parts[0];
            if (!name || name.length < 1 || name === _syncProtagName || ['user','User','{user}','{User}','{{user}}','{{User}}'].includes(name) || createdNames.has(name)) return;
            createdNames.add(name);
            const gender = parts[1] || '其他';
            const age = parts[2] || '';
            const relation = (parts[3] && parts[3] !== '-1' && parts[3] !== '无') ? parts[3] : '';
            const descStart = 4;
            let description = parts.length > descStart ? parts.slice(descStart).join('|').trim() : '';
            if (!description) description = (charEntries.find(e => e.name === name) || {}).content || '';
            const existing = CharacterManager.getByWorldBook(wb.id).find((c: any) => c.name === name);
            if (existing) {
              const updates = {} as Record<string, any>;
              if (description && description.length > (existing.description || '').length) updates.description = description;
              if (gender && gender !== '其他' && existing.gender !== gender) updates.gender = gender;
              if (age && !existing.age) updates.age = age;
              if (relation && !existing.relation) updates.relation = relation;
              if (Object.keys(updates).length > 0) { CharacterManager.update(existing.id, updates); updated++; }
            } else {
              CharacterManager.create({ name, gender, age, relation, description });
              added++;
            }
          });
          const msgs: any[] = [];
          if (added > 0) msgs.push('新增 ' + added + ' 名角色');
          if (updated > 0) msgs.push('更新 ' + updated + ' 名角色');
          statusEl!.textContent = msgs.length > 0 ? msgs.join('，') : '角色已是最新';
          if (msgs.length > 0) App.toast(msgs.join('，'));
        }
      },
      (error) => { statusEl!.textContent = '同步失败: ' + error; App.toast('角色同步失败'); },
      { temperature: 0.3, apiConfig: PresetManager.getActiveAPIConfig(), callLabel: 'syncCharacters' }
    );
  },

  // 参数表单保存：endpoint/key/model/价格 由【供应商渠道】管理（selectChannel/saveChannelField 同步），
  // 此处只负责温度等采样参数（避免多渠道模式下手动改表单被旧逻辑冲掉渠道字段）。
  // 正文窗口是写作侧设置（记忆页），不在这里写。
  saveAPIConfig() {
    const existing = SM().get<any>('apiConfig', {});
    const val = (id: string, fb: number) => { const el = document.getElementById(id) as HTMLInputElement | null; const v = el ? parseFloat(el.value) : NaN; return isNaN(v) ? fb : v; };
    SM().set('apiConfig', {
      ...existing, // Preserve ST advanced fields not in the form
      temperature: val('apiTemperature', 0.9),
      topP: val('apiTopP', 0.95),
      presencePenalty: val('apiPresencePenalty', 0.4),
      frequencyPenalty: val('apiFrequencyPenalty', 0.3)
      // endpoint / apiKey / model / 价格 不在此写 —— 渠道模式由渠道同步，避免多源冲突
    });
    // 同步回当前渠道的对象字段之外：参数属于全局，渠道只存 endpoint/key/model/价格
    App.toast('API 参数已保存');
  },


  // ④ 透明面板：展开/收起「本轮注入了什么记忆」
  _lastMemTrace: null as { memory: string[]; archive: string[]; time: number } | null,
  /** 管理员模式留档：本轮生成上下文（指令 / 召回片段 / 窗口与预算） */
  _lastGenTrace: null as Record<string, unknown> | null,
  _traceRound: 0,
  toggleMemTrace() {
    const bar = document.getElementById('memTraceBar');
    const detail = document.getElementById('memTraceDetail');
    if (!bar || !detail) return;
    if (!bar.style.display || bar.style.display === 'none') {
      bar.style.display = '';
      this.renderMemTrace();
    } else {
      bar.style.display = 'none';
    }
  },
  renderMemTrace() {
    const s = document.getElementById('memTraceSummary');
    const d = document.getElementById('memTraceDetail');
    if (!s || !d) return;
    const t = (this as unknown as { _lastMemTrace?: { memory: string[]; archive: string[]; time: number } })._lastMemTrace;
    if (!t) { d.innerHTML = '<div>（尚未生成过，写一段就会记录）</div>'; return; }
    s.textContent = (t.memory.length + t.archive.length) + ' 条';
    const esc = function (x: string) { return String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;'); };
    const lines = (t.memory || []).map(function (m) { return '<div>🧠 记忆：' + esc(m) + '</div>'; })
      .concat((t.archive || []).map(function (a) { return '<div>📖 回读：' + esc(a) + '</div>'; }));
    d.innerHTML = lines.join('') || '<div>（本轮无注入）</div>';
  },

  getBackendAPIConfig() {
    var cfg: any = null;
    const presetId = PresetManager.getCurrentPresetId();
    if (presetId) {
      const preset = PresetManager.getPresets().find(p => p.id === presetId);
      if (preset && preset.backendApiConfig && preset.backendApiConfig.endpoint && preset.backendApiConfig.apiKey) {
        cfg = preset.backendApiConfig;
      }
    }
    if (!cfg) {
      const backend = SM().get<any>('backendApiConfig', {});
      if (backend.endpoint && backend.apiKey) cfg = backend;
    }
    if (!cfg) return null;
    // 纯 embedding 模型不能用于聊天，回退到主 API
    var modelName = (cfg.model || '').toLowerCase();
    if (modelName.indexOf('embedding') >= 0) return null;
    return cfg;
  },

  getPricingConfig() {
    const cfg = SM().get<any>('apiConfig', {});
    return {
      input: (cfg.priceInput ?? 1) / 1000000,    // 每百万tokens → 每token
      cached: (cfg.priceCached ?? 0.1) / 1000000,
      output: (cfg.priceOutput ?? 2) / 1000000
    };
  },

  MODEL_PRICING: {
    // DeepSeek (2026最新，人民币/百万tokens)
    'deepseek-chat':           { input: 1, cached: 0.02, output: 2 },
    'deepseek-v4-flash':       { input: 1, cached: 0.02, output: 2 },
    'deepseek-v4-pro':         { input: 3, cached: 0.025, output: 6 },
    'deepseek-reasoner':       { input: 1, cached: 0.02, output: 2 },
    'deepseek-r1':             { input: 1, cached: 0.02, output: 2 },
    // OpenAI (美元→人民币 ≈7.2)
    'gpt-5.5':                 { input: 36, cached: 3.6, output: 216 },
    'gpt-5.4':                 { input: 18, cached: 1.8, output: 108 },
    'gpt-5.4-mini':            { input: 5.4, cached: 0.54, output: 32.4 },
    'gpt-4o':                  { input: 18, cached: 9, output: 72 },
    'gpt-4o-mini':             { input: 10.8, cached: 5.4, output: 43.2 },
    'o1':                      { input: 144, cached: 72, output: 432 },
    'o1-mini':                 { input: 43.2, cached: 21.6, output: 172.8 },
    'o3-mini':                 { input: 21.6, cached: 10.8, output: 86.4 },
    // Claude (美元→人民币 ≈7.2)
    'claude-opus-4':           { input: 108, cached: 10.8, output: 540 },
    'claude-opus-4.8':         { input: 36, cached: 3.6, output: 180 },
    'claude-sonnet-4':         { input: 21.6, cached: 2.16, output: 108 },
    'claude-sonnet-4.6':       { input: 21.6, cached: 2.16, output: 108 },
    'claude-haiku-4.5':        { input: 7.2, cached: 0.72, output: 36 },
    // 通义 (人民币/百万tokens)
    'qwen-max':                { input: 2, cached: 0.5, output: 6 },
    'qwen-plus':               { input: 0.8, cached: 0.2, output: 2 },
    'qwen-turbo':              { input: 0.3, cached: 0.06, output: 0.6 },
    // Kimi / Moonshot (美元→人民币 ≈7.2，官方 CN 价)
    'kimi-k2-0711-preview':    { input: 4.3, cached: 1.08, output: 18 },
    'kimi-k2-0905-preview':    { input: 4.3, cached: 1.08, output: 18 },
    'kimi-k2-thinking':        { input: 4.3, cached: 1.08, output: 18 },
    'kimi-k2-thinking-turbo':  { input: 8.3, cached: 1.08, output: 57.6 },
    'kimi-k2-turbo-preview':   { input: 17.3, cached: 4.32, output: 72 },
    'kimi-k2.5':               { input: 4.3, cached: 0.72, output: 21.6 },
    'kimi-k2.6':               { input: 6.8, cached: 1.15, output: 28.8 },
    'kimi-k2.7-code':          { input: 6.8, cached: 1.37, output: 28.8 },
    'kimi-k2.7-code-highspeed':{ input: 13.7, cached: 2.74, output: 57.6 },
    'kimi-k3':                 { input: 21.6, cached: 2.16, output: 108 },
    'kimi-for-coding':         { input: 6.8, cached: 1.37, output: 28.8 },
    'kimi-for-coding-highspeed':{ input: 13.7, cached: 2.74, output: 57.6 },
    // MiniMax (美元→人民币 ≈7.2)
    'minimax-m2.7':            { input: 2.2, cached: 0.43, output: 8.6 },
    'minimax-m2.7-highspeed':  { input: 4.3, cached: 0.43, output: 17.3 },
    'minimax-m3':              { input: 2.2, cached: 0.43, output: 8.6 },
    // 小米MiMo (人民币/百万tokens)
    'mimo-v2.5-pro':           { input: 3, cached: 0.025, output: 6 },
    'mimo-v2.5':               { input: 1, cached: 0.02, output: 2 },
    'mimo-v2-pro':             { input: 3, cached: 0.025, output: 6 },
    'mimo-v2-flash':           { input: 1, cached: 0.02, output: 2 },
    'mimo-auto':               { input: 1, cached: 0.02, output: 2 },
    // 火山方舟 豆包（人民币/百万tokens；coding 包月套餐不计 token 费，以下为按量参考价，可自行修改）
    'doubao-seed-2-1-pro':    { input: 4.5, cached: 0.9, output: 9 },
    'doubao-seed-2-1-turbo':  { input: 0.8, cached: 0.16, output: 2 },
    'doubao-seed-1-6':        { input: 0.8, cached: 0.16, output: 2 },
    'doubao-1-5-pro':         { input: 1.5, cached: 0.3, output: 4 },
    'doubao-1-5-lite':        { input: 0.3, cached: 0.06, output: 0.6 },
  },

  // 定价匹配：先精确匹配，再按模型 ID 前缀匹配（支持 doubao-seed-2-1-turbo-260628 这类带日期后缀的 ID）
  resolveModelPricing(model: any) {
    if (!model) return null;
    const m = model.trim().toLowerCase();
    if (this.MODEL_PRICING[m]) return this.MODEL_PRICING[m];
    // 按 key 长度从长到短，找一个是当前模型前缀的
    const keys = Object.keys(this.MODEL_PRICING).sort(function (a, b: any) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      if (m.indexOf(keys[i]) === 0) return this.MODEL_PRICING[keys[i]];
    }
    return null;
  },

  matchModelPricing() {
    // 1.5.12 模型输入改为下拉（apiModelSelect / apiModelManual），旧 apiModel 输入框已删除
    const ch = this.getActiveChannel();
    const model = (document.getElementById('apiModelSelect') as HTMLInputElement | null)?.value
      || (document.getElementById('apiModelManual') as HTMLInputElement | null)?.value
      || (ch && ch.model) || '';
    if (!model) return;
    const pricing = this.resolveModelPricing(model);
    if (pricing) {
      document.getElementById('priceInput')!.value = pricing.input;
      document.getElementById('priceCached')!.value = pricing.cached;
      document.getElementById('priceOutput')!.value = pricing.output;
    }
  },

  applyModelPricing() {
    const ch = this.getActiveChannel();
    const model = ((document.getElementById('apiModelSelect') as HTMLInputElement | null)?.value
      || (document.getElementById('apiModelManual') as HTMLInputElement | null)?.value
      || (ch && ch.model) || '').trim();
    if (!model) { App.toast('请先输入模型名称'); return; }
    const pricing = this.resolveModelPricing(model);
    if (pricing) {
      document.getElementById('priceInput')!.value = pricing.input;
      document.getElementById('priceCached')!.value = pricing.cached;
      document.getElementById('priceOutput')!.value = pricing.output;
      App.toast('已应用模型默认价格: ' + model);
    } else {
      App.toast('未找到模型"' + model + '"的内置价格，请手动配置');
    }
  },

  // Preset import
  importPresets() { document.getElementById('fileImportPresets')!.click(); },
  async handleImportPresets(event: any) {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { App.toast('文件过大，请选择小于 10MB 的文件'); event.target.value = ''; return; }
    try {
      const text = await file.text();
      let data;
      try { data = JSON.parse(text); } catch (e) { App.toast('预设文件格式错误，请检查文件内容'); event.target.value = ''; return; }
      // Use filename (without extension) as preset name
      const fileName = file.name.replace(/\.json$/i, '').replace(/[_\-\s]+/g, ' ').trim() || '导入预设';
      let importedCount = 0;

      const importOne = (p: any, baseName: any) => {
        const presets = PresetManager.getPresets();
        const cfg = p.apiConfig ? { ...p.apiConfig } : parseSampler(p);
        // Auto-suffix for duplicate names
        let finalName = baseName; let n = 1;
        while (presets.find(ep => ep.name === finalName)) { n++; finalName = baseName + ' (' + n + ')'; }
        const newId = 'preset_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
        const _newPreset = { id: newId, name: finalName, systemPromptId: p.systemPromptId || null, isDefault: false, createdAt: Date.now() };
        // 原生预设格式：预设自带文本正则（regexScripts）跟随预设，切换预设时自动生效
        if (p._stRegexRules && p._stRegexRules.length > 0) (_newPreset as any).regexScripts = p._stRegexRules;
        if (p.promptModules && Array.isArray(p.promptModules) && p.promptModules.length > 0) {
          // 原样带进预设，但补齐每个模块的 id/name/order——
          // 编辑/开关/拖拽都依赖 m.id，缺 id 会导致预设编辑列表"空"（点编辑无效）
          (_newPreset as any).promptModules = (p as any).promptModules.map(function (m: any, i: any) {
            return {
              id: m.id || ('mod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '_' + i),
              name: m.name || (m.content ? String(m.content).split('\n')[0].trim().slice(0, 40) : '') || ('提示项 ' + (i + 1)),
              content: m.content || '',
              enabled: m.enabled !== false,
              role: m.role || 'system',
              order: m.order != null ? m.order : i
            };
          });
        } else if (cfg.prompts && Array.isArray(cfg.prompts) && cfg.prompts.length > 0) {
          // Convert SillyTavern-style prompts to our module format
          (_newPreset as any).promptModules = cfg.prompts
            .filter(function (m: any) { return m.content && m.content.trim(); })
            .map(function (m: any, i: any) {
              return {
                id: 'mod_' + Date.now() + '_' + Math.random().toString(36).slice(2,6) + '_' + i,
                name: m.name || (m.content ? m.content.split('\n')[0].trim().slice(0,40) : '') || ('提示项 '+(i+1)),
                content: m.content,
                enabled: m.enabled !== false,
                role: m.role || 'system',
                order: m.injection_order != null ? m.injection_order : i
              };
            });
        }
        presets.push(_newPreset);
        PresetManager.savePresets(presets);
        return { id: newId, name: finalName };
      };

      const importSP = (sp: any) => {
        if (!sp || !sp.content) return null;
        const prompts = PresetManager.getSystemPrompts();
        const dup = prompts.find((p: any) => p.name === sp.name && p.content === sp.content);
        if (dup) return dup.id;
        const newId = 'sp_' + Date.now() + '_' + Math.random().toString(36).slice(2,6);
        prompts.push({ id: newId, name: sp.name || '导入提示词', content: sp.content });
        PresetManager.saveSystemPrompts(prompts);
        return newId;
      };

      let lastResult: any = null;

      // Case 1: Our own export (allPresets)
      if (data.allPresets && Array.isArray(data.allPresets) && data.allPresets.length > 0) {
        if (data.allSystemPrompts && Array.isArray(data.allSystemPrompts)) data.allSystemPrompts.forEach((sp: any) => importSP(sp));
        data.allPresets.forEach((p: any) => { lastResult = importOne(p, p.name || fileName); importedCount++; });
      }
      // Case 2: ST Master Import {preset:{...}, sysprompt:{...}}
      else if (data.preset && typeof data.preset === 'object' && (data.preset.temp !== undefined || data.preset.temperature !== undefined || data.preset.top_p !== undefined)) {
        const spId = data.sysprompt ? importSP(data.sysprompt) : null;
        lastResult = importOne({ ...data.preset, systemPromptId: spId }, data.preset.name || data.sysprompt?.name || fileName);
        importedCount = 1;
      }
      // Case 3: Raw ST sampler params at top level
      else if (data.temp !== undefined || data.temperature !== undefined || data.top_p !== undefined) {
        const spId = data.sysprompt ? importSP(data.sysprompt) : null;
        lastResult = importOne({ ...data, systemPromptId: spId }, data.sysprompt?.name || data.name || fileName);
        importedCount = 1;
      }
      // Case 4: Lone system prompt
      else if (data.content && typeof data.content === 'string' && data.content.length > 20) {
        const spId = importSP(data);
        if (spId) { PresetManager.setCurrentSystemPromptId(spId); PresetManager.applySystemPrompt(spId); App.toast('成功导入提示词: ' + (data.name || fileName)); }
        event.target.value = ''; return;
      }
      // Case 5: Array
      else if (Array.isArray(data)) {
        data.forEach(p => { lastResult = importOne(p, p.name || fileName); importedCount++; });
      }
      // Case 6 (原生优先): 原生预设格式（本软件自己的格式，见 docs/预设格式说明.md）
      // 识别特征：顶层含 promptModules / variables / regexScripts。放在 Generic 之前，
      // 避免带 name 的原生预设被 Generic 分支抢先处理导致 variables/regexScripts 不生效。
      else if ((data.promptModules && Array.isArray(data.promptModules)) || data.variables || data.regexScripts) {
        // 预设附带变量 → 合并进当前世界书变量（仅当变量不存在时写入，不覆盖已有值）
        var _varsCnt = 0;
        if (data.variables && typeof data.variables === 'object') {
          Object.entries(data.variables).forEach(function (pair) {
            if (VariableManager.get(pair[0]) === '') { VariableManager.set(pair[0], String(pair[1])); _varsCnt++; }
          });
        }
        // 预设自带文本正则 → 跟随预设（regexScripts）
        var _nativeRegex = (data.regexScripts && Array.isArray(data.regexScripts))
          ? data.regexScripts.map(function (r: any, i: any) {
              return {
                id: r.id || ('native_' + Date.now() + '_' + i),
                name: r.name || '原生正则',
                findRegex: r.findRegex || '',
                replaceString: r.replaceString || '',
                timing: r.timing || 'after',
                enabled: r.enabled !== false,
                order: i
              };
            })
          : [];
        lastResult = importOne({ ...data, _stRegexRules: _nativeRegex }, data.name || fileName);
        importedCount = 1;
        var _nativeParts: any[] = [];
        if (data.promptModules && data.promptModules.length > 0) _nativeParts.push(data.promptModules.length + ' 个模块');
        if (_varsCnt > 0) _nativeParts.push(_varsCnt + ' 个变量');
        if (_nativeRegex.length > 0) _nativeParts.push(_nativeRegex.length + ' 条正则');
        if (_nativeParts.length > 0) App.toast('原生预设导入成功（' + _nativeParts.join('、') + '）');
      }
      // Case 7: Generic object
      else if (data.name || data.apiConfig) {
        lastResult = importOne(data, data.name || fileName); importedCount = 1;
      }
      else { App.toast('无法识别的预设文件格式'); event.target.value = ''; return; }

      // Switch to the last imported preset
      if (lastResult) {
        PresetManager.setCurrentPresetId(lastResult.id);
        PresetManager.applyPreset(lastResult.id);
      }
      UIManager!.renderPresets(); UIManager!.populateSystemPromptUI(); UIManager.populateAPIFields();
      const promptCount = lastResult ? (PresetManager.getPresets().find(p => p.id === lastResult.id)?.apiConfig?.prompts?.length || 0) : 0;
      const moduleCount = lastResult ? (PresetManager.getPresets().find(p => p.id === lastResult.id)?.promptModules?.length || 0) : 0;
      var _importParts: any[] = [];
      if (promptCount > 0) _importParts.push(promptCount + ' 个提示项');
      if (moduleCount > 0) _importParts.push(moduleCount + ' 个模块');
      App.toast('成功导入预设：' + (lastResult ? lastResult.name : importedCount + '个') + (_importParts.length > 0 ? '，包含 ' + _importParts.join('、') : ''));
    } catch(e) { App.toast('文件解析失败: ' + (e as any).message); }
    event.target.value = '';
  },

  // Preset export (full ST format)
  async exportPresets() {
    const presets = PresetManager.getPresets();
    const sysPrompts = PresetManager.getSystemPrompts();
    const currentId = PresetManager.getCurrentPresetId();
    const currentPreset = presets.find(p => p.id === currentId) || presets[0];
    if (!currentPreset) { App.toast('没有可导出的预设'); return; }
    const sp = sysPrompts.find((p: any) => p.id === (currentPreset.systemPromptId || PresetManager.getCurrentSystemPromptId()));
    const exportData = {
      name: currentPreset.name,
      promptModules: currentPreset.promptModules || [],
      sysprompt: sp ? { name: sp.name, content: sp.content } : {}
    };
    const saved = await this.downloadFile(currentPreset.name + '.json', JSON.stringify(exportData, null, 2), 'application/json');
    var _exportParts: any[] = [];
      if (exportData.promptModules.length > 0) _exportParts.push(exportData.promptModules.length + ' 个模块');
      App.toast('成功导出预设: ' + currentPreset.name + (_exportParts.length > 0 ? '，包含 ' + _exportParts.join('、') : '') + (saved ? ' → ' + saved : ''));
  },

  // Edit current preset
  editPreset() {
    const currentId = PresetManager.getCurrentPresetId();
    if (!currentId) { App.toast('请先选择一个预设'); return; }
    UIManager.showPresetEditModal(currentId);
  },

  deletePreset() {
    const currentId = PresetManager.getCurrentPresetId();
    const presets = PresetManager.getPresets();
    const preset = presets.find(p => p.id === currentId);
    if (!preset) return;
    if (preset.isDefault) { App.toast('默认预设不可删除'); return; }
    UIManager.showConfirm('确定删除预设"' + preset.name + '"?', () => {
      const ps = PresetManager.getPresets().filter(p => p.id !== currentId);
      if (ps.length === 0) { App.toast('至少保留一个预设'); return; }
      PresetManager.savePresets(ps);
      PresetManager.setCurrentPresetId(ps[0].id);
      PresetManager.applyPreset(ps[0].id);
      UIManager!.renderPresets();
      App.toast('预设已删除');
    });
  },

  // SysPrompt import/export
  importSysPrompts() { document.getElementById('fileImportSysPrompts')!.click(); },
  async handleImportSysPrompts(event: any) {
    const file = event.target.files[0]; if (!file) return;
    try {
      const text = await file.text(); const data = JSON.parse(text);
      const prompts = PresetManager.getSystemPrompts();
      const items = Array.isArray(data) ? data : [data];
      items.forEach(sp => {
        if (!sp.name && !sp.content) return;
        prompts.push({ id: 'sp_' + Date.now() + '_' + Math.random().toString(36).slice(2,6), name: sp.name || '导入提示词', content: sp.content || '' });
      });
      PresetManager.saveSystemPrompts(prompts); UIManager!.populateSystemPromptUI(); App.toast('系统提示词导入成功');
    } catch(e) { App.toast('文件解析失败'); }
    event.target.value = '';
  },
  async exportSysPrompts() { const saved = await this.downloadFile('系统提示词.json', JSON.stringify(PresetManager.getSystemPrompts(), null, 2), 'application/json'); App.toast('系统提示词已导出' + (saved ? ' → ' + saved : '')); },

  // Regex import/export
  importRegexRules() { document.getElementById('fileImportRegex')!.click(); },
  async handleImportRegex(event: any) {
    const file = event.target.files[0]; if (!file) return;
    try {
      const text = await file.text(); let data = JSON.parse(text);
      if (!Array.isArray(data)) data = [data];
      const rules = RegexEngine.getRules();
      data.forEach((r: any, i: any) => {
        rules.push({ id: 'regex_' + Date.now() + '_' + i, name: r.name || r.scriptName || '导入规则', findRegex: r.findRegex || '', replaceString: r.replaceString || '', timing: r.timing || (r.affectsAIOutput ? 'after' : 'before'), enabled: r.disabled === true ? false : (r.enabled !== false), order: rules.length });
      });
      RegexEngine.saveRules(rules); UIManager!.renderRegexRules(); App.toast('正则规则导入成功（' + data.length + ' 条）');
    } catch(e) { App.toast('文件解析失败'); }
    event.target.value = '';
  },
  async exportRegexRules() {
    const rules = RegexEngine.getRules();
    const data = rules.map(r => ({ name: r.name, findRegex: r.findRegex, replaceString: r.replaceString, affectsUserInput: r.timing === 'before', affectsAIOutput: r.timing === 'after', affectsSlashCommands: false, affectsWorldInfo: false, affectsReasoning: false, disabled: !r.enabled, runOnEdit: false, macroSubstitution: 'none' }));
    const saved = await this.downloadFile('正则规则.json', JSON.stringify(data, null, 2), 'application/json'); App.toast('正则规则已导出' + (saved ? ' → ' + saved : ''));
  },

  // Config package export (world books + prompts + regex + API)
  async exportConfigPackage() {
    const pkg = {
      version: 1, exportedAt: new Date().toISOString(),
      worldBooks: WorldBookManager.getAll(),
      systemPrompts: PresetManager.getSystemPrompts(),
      presets: PresetManager.getPresets(),
      regexRules: RegexEngine.getRules(),
      apiConfig: SM().get<any>('apiConfig', {})
    };
    const saved = await this.downloadFile('BQB Hub 配置包_' + new Date().toISOString().slice(0,10) + '.json', JSON.stringify(pkg, null, 2), 'application/json');
    App.toast('配置包已导出（世界书+提示词+预设+正则+API）' + (saved ? ' → ' + saved : ''));
  },

  async handleImportConfigPackage(event: any) {
    const file = event.target.files[0]; if (!file) return;
    try {
      const text = await file.text(); const pkg = JSON.parse(text);
      if (!pkg.worldBooks && !pkg.systemPrompts && !pkg.regexRules) { App.toast('无效的配置包文件'); return; }
      let msg: any[] = [];
      if (pkg.worldBooks && Array.isArray(pkg.worldBooks)) { WorldBookManager.saveAll(pkg.worldBooks); msg.push(pkg.worldBooks.length + '本世界书'); }
      if (pkg.systemPrompts && Array.isArray(pkg.systemPrompts)) { PresetManager.saveSystemPrompts(pkg.systemPrompts); msg.push(pkg.systemPrompts.length + '个提示词'); }
      if (pkg.presets && Array.isArray(pkg.presets)) { PresetManager.savePresets(pkg.presets); msg.push(pkg.presets.length + '个预设'); }
      if (pkg.regexRules && Array.isArray(pkg.regexRules)) { RegexEngine.saveRules(pkg.regexRules); msg.push(pkg.regexRules.length + '条正则'); }
      if (pkg.apiConfig) { SM().set('apiConfig', pkg.apiConfig); msg.push('API配置'); }
      App.renderAll(); UIManager.populateAPIFields(); App.toast('配置包导入成功: ' + msg.join('、'));
    } catch(e) { App.toast('文件解析失败: ' + (e as any).message); }
    event.target.value = '';
  },

  // World Book standalone export/import
  async exportWorldBook(bookId: any) {
    const wb = bookId ? WorldBookManager.getAll().find(w => w.id === bookId) : WorldBookManager.getActive();
    if (!wb) { App.toast('请先选择一个世界书'); return; }
    // Ensure all entries have the inject flag for export
    const clone = JSON.parse(JSON.stringify(wb));
    clone.entries.forEach((e: any) => {
      if (e.inject === undefined) e.inject = true;
    });
    const saved = await this.downloadFile(wb.name + '.json', JSON.stringify(clone, null, 2), 'application/json');
    App.toast('世界书"' + wb.name + '"已导出' + (saved ? ' → ' + saved : ''));
  },
  // 正文导入（写作页工具条按钮）：支持 UTF-8 / GBK 的 .txt，追加进当前章节
  importNovelText() { document.getElementById('fileImportNovelText')!.click(); },
  handleImportNovelText(event: any) {
    const file = event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';   // 允许连续选同一个文件
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      let text = '';
      try {
        text = decodeNovelText((e!.target as any).result);
      } catch (err) {
        App.toast('读取失败：' + String((err as Error).message || err).slice(0, 60));
        return;
      }
      if (!text.trim()) { App.toast('文件是空的'); return; }
      const cur = (EditorManager.getPlainText() || '').trim();
      const apply = () => {
        const merged = mergeChapterText(EditorManager.getPlainText() || '', text);
        EditorManager.setContent(novelTextToEditorHtml(merged));   // setContent 内部会更新字数
        App.saveCurrentChapter();
        App.renderAll?.();
        App.toast('已导入正文 ' + text.replace(/\s/g, '').length + ' 字' + (cur ? '（追加到当前章节末尾）' : ''));
        console.log('[Import] 正文导入：%d 字 → 章节共 %d 字', text.length, merged.length);
      };
      if (cur) {
        UIManager.showConfirm('当前章节已有 ' + EditorManager.getPlainText().replace(/\s/g, '').length
          + ' 字，导入的 ' + text.replace(/\s/g, '').length + ' 字会追加到末尾。继续？', apply);
      } else {
        apply();
      }
    };
    reader.onerror = () => App.toast('读取文件失败');
    reader.readAsArrayBuffer(file);
  },
  importWorldBook() { document.getElementById('fileImportWorldBook')!.click(); },
  handleImportWorldBook(event: any) {
    const file = event.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = JSON.parse(String((e!.target as any).result));
        if (!wb.name || !wb.entries) { App.toast('无效的世界书文件'); return; }
        const existing = WorldBookManager.getAll().find(b => b.id === wb.id || b.name === wb.name);
        if (existing) {
          UIManager.showConfirm('世界书"' + wb.name + '"已存在，是否覆盖？', () => {
            wb.id = existing.id;
            const all = WorldBookManager.getAll();
            const idx = all.findIndex(b => b.id === existing.id);
            if (idx >= 0) { all[idx] = wb; WorldBookManager.saveAll(all); }
            UIManager.renderWorldBooks();
            UIManager!.renderWBEntries();
            App.toast('世界书"' + wb.name + '"已覆盖');
            // 覆盖的是当前书则刷新编辑器（避免正文停留在旧内容）
            if (WorldBookManager.getActiveId() === existing.id) { App.loadEditorContent(); App.renderAll(); }
          });
        } else {
          wb.id = 'wb_' + Date.now();
          wb.createdAt = Date.now();
          const all = WorldBookManager.getAll();
          all.push(wb);
          WorldBookManager.saveAll(all);
          WorldBookManager.setActiveId(wb.id);
          UIManager.renderWorldBooks();
          UIManager!.renderWBEntries();
          // 切到新书：必须刷新编辑器与界面，否则正文停留在上一本书（用户会看到"新书里是旧书正文"）
          App.loadEditorContent();
          App.renderAll();
          App.toast('世界书"' + wb.name + '"已导入');
          // 导入后顺势选封面（JSON 里带 cover 会原样带入；取消则保留）
          if (!wb.cover && typeof UIManager.pickBookCover === 'function') {
            App.toast('可为此书选择一张封面（取消使用默认）');
            UIManager.pickBookCover(wb.id);
          }
        }
      } catch(ex) { App.toast('文件解析失败: ' + (ex as any).message); }
    };
    reader.readAsText(file);
    event.target.value = '';
  },

  // ==================== PNG Character Card Import ====================
  _pendingCharCards: [],

  importCharacterCard() { document.getElementById('fileImportCharCard')!.click(); },

  async handleImportCharCard(event: any) {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length === 0) return;
    const statusEl = document.getElementById('charCardStatus');
    const previewEl = document.getElementById('charCardPreview');
    previewEl!.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">正在解析 ' + files.length + ' 个PNG文件...</div>';
    statusEl!.textContent = '';
    UIManager!.showModal('modalCharCardImport');

    const results: any[] = [];
    for (const file of files) {
      try {
        const card = await this._parsePNGCharCard(file);
        if (card) {
          const cleaned = this._stripSillyTavernFields(card);
          // 提取 PNG 图像本体（缩略后作为导入世界书的封面）
          let imgDataUrl = '';
          try { imgDataUrl = await this._readFileAsDataURL(file); } catch (e) { /* 图像可选 */ }
          results.push({ fileName: (file as any).name, card: cleaned, raw: card, imgDataUrl });
        } else {
          results.push({ fileName: (file as any).name, error: '未识别为角色卡（无JSON数据）' });
        }
      } catch (e) {
        results.push({ fileName: (file as any).name, error: (e as any).message });
      }
    }

    this._pendingCharCards = results.filter(r => r.card);
    const errors = results.filter(r => r.error);

    let html = '';
    this._pendingCharCards.forEach((r: any, i: any) => {
      const c = r.card;
      const fields: any[] = [];
      if (c.name) fields.push('名称: ' + c.name);
      if (c.description) fields.push('描述: ' + c.description.slice(0, 80) + '…');
      if (c.personality) fields.push('性格: ' + c.personality.slice(0, 60) + '…');
      if (c.scenario) fields.push('场景: ' + c.scenario.slice(0, 60) + '…');
      // 世界书（character_book）走酒馆适配器统计，预览直接告诉用户会导入什么
      const wbStats = this._computeCharBookStats(r.raw);
      if (wbStats) {
        fields.push('📚 世界书: ' + wbStats.kept + ' 保留 / ' + wbStats.rewrite + ' 数值系统 / ' + wbStats.needs + ' 存疑保留 / ' + wbStats.drop + ' 丢弃');
      }
      const fieldSummary = fields.join('<br>');
      html += '<div style="margin-bottom:8px;padding:6px;border:1px solid var(--border);border-radius:4px;"><b>#' + (i + 1) + ' ' + r.fileName + '</b><br><span style="font-size:12px;">' + fieldSummary + '</span></div>';
    });
    if (errors.length > 0) {
      html += '<div style="color:var(--danger);font-size:12px;margin-top:8px;">跳过 ' + errors.length + ' 个: ' + errors.map(e => e.fileName).join(', ') + '</div>';
    }

    previewEl!.innerHTML = html;
    document.getElementById('btnCharCardConfirm')!.disabled = this._pendingCharCards.length === 0;
    statusEl!.textContent = this._pendingCharCards.length + ' 张有效卡，将创建新世界书并导入';
  },

  // 组装要留存的酒馆原始数据（挂到 book.tavernSource，供写卡的改造流程读取）
  // 只留适配需要的字段：卡面核心字段 + character_book 条目（去掉 avatar/extensions/regex 等大而无用的部分）
  _buildTavernSource(cards: any[]): any {
    const FIELDS = ['id', 'comment', 'keys', 'secondary_keys', 'content', 'enabled', 'constant', 'selective', 'insertion_order', 'position', 'use_regex'];
    const pick = (book: any, withContent: boolean) => {
      const list = Array.isArray(book && book.entries) ? book.entries
        : (book && book.entries && typeof book.entries === 'object' ? Object.keys(book.entries).map((k) => book.entries[k]) : []);
      return list.map((e: any) => {
        const out: any = {};
        FIELDS.forEach((k) => {
          if (!withContent && k === 'content') return;
          if (e && e[k] !== undefined) out[k] = e[k];
        });
        return out;
      });
    };
    const build = (withContent: boolean) => ({
      importedAt: Date.now(),
      cards: cards.map((c: any) => {
        const raw = c.raw || c.card || {};
        const book = raw.character_book;
        return {
          fileName: c.fileName || '',
          name: raw.name || (c.card && c.card.name) || '',
          spec: raw.spec || raw.spec_version || '',
          character_book: book ? { name: book.name || '', entries: pick(book, withContent) } : null,
          card: c.card || null,
        };
      }),
    });
    let src = build(true);
    try {
      // 超大卡（条目正文极多）不整份留档：只留标题/关键词，改造时让 Agent 逐条问用户
      if (JSON.stringify(src).length > 2.5 * 1024 * 1024) {
        src = build(false);
        (src as any).truncated = true;
      }
    } catch (e) { /* 序列化异常就按原样返回 */ }
    return src;
  },

  // 用酒馆适配器统计 character_book（不落库，只用于预览/toast）
  // 入参可以是整张卡，也可以是 character_book 本身（历史 bug：调用处传了整张卡，
  // 于是 `book.entries` 恒为 undefined，预览里那行「📚 世界书: N 保留…」永远不显示）
  _computeCharBookStats(input: any): any {
    const book = (input && input.character_book) ? input.character_book : input;
    if (!book || !book.entries) return null;
    try {
      const rep = TavernAdapter.adaptTavernLorebookObject({ name: (book && book.name) || '', entries: book.entries }, 'balanced');
      return {
        kept: rep.stats.kept,
        rewrite: rep.stats.ai_transform,
        needs: rep.stats.needs_user,
        drop: rep.stats.dropped_silently,
      };
    } catch (e) { return null; }
  },

  // 读文件为 dataURL（PNG 卡面提取用）
  _readFileAsDataURL(file: any): Promise<string> {
    return new Promise((resolve) => {
      try {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => resolve('');
        reader.readAsDataURL(file);
      } catch (e) { resolve(''); }
    });
  },

  // 图片等比例缩放到 maxW 宽，转 JPEG 0.85（PNG 卡面 → 世界书封面，控制体积）
  _resizeImageDataUrl(dataUrl: string, maxW = 400): Promise<string> {
    return new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const w = Math.min(maxW, img.width);
            const h = Math.max(1, Math.round(img.height * (w / img.width)));
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            const ctx = cv.getContext('2d');
            if (!ctx) { resolve(''); return; }
            ctx.drawImage(img, 0, 0, w, h);
            resolve(cv.toDataURL('image/jpeg', 0.85));
          } catch (e) { resolve(''); }
        };
        img.onerror = () => resolve('');
        img.src = dataUrl;
      } catch (e) { resolve(''); }
    });
  },

  // 用酒馆适配器把 character_book 分类后写入世界书（批量导入，不逐条询问）
  _importTavernBook(wbId: string, book: any): { count: number; transform: number } {
    const out = { count: 0, transform: 0 };
    try {
      const rep = TavernAdapter.adaptTavernLorebookObject({ name: (book && book.name) || '', entries: book.entries }, 'balanced');
      const entriesArr = this._tavernEntriesToArray(book.entries);
      const findEntry = (uid: number) => entriesArr.find((e: any) => (e && e.uid) === uid) || entriesArr[uid] || null;
      const fullContent = (src: any) => src ? String(src.content || src.comment || '') : '';

      // 1) kept：按类型/名称/清洗后内容直接落库
      rep.kept.forEach((m: any) => {
        WorldBookManager.addEntry(wbId, { type: m.type, name: m.name, content: m.content, inject: m.inject !== false });
        out.count++;
      });
      // 2) ai_transform.rewrite：数值系统，导入保留文本（清洗后），后续可到写卡转述
      rep.ai_transform.forEach((t: any) => {
        if (t.kind !== 'rewrite_numeric') return;
        const raw = findEntry(t.uid);
        let content = raw ? fullContent(raw) : '';
        content = TavernAdapter.cleanTavernContent(content).text || t.source_excerpt;
        if (!content) return;
        WorldBookManager.addEntry(wbId, { type: '其他', name: t.comment || ('数值系统条目' + (t.uid + 1)), content, inject: true });
        out.count++; out.transform++;
      });
      // 3) needs_user：内容正经设定但无 key/前缀 → 保守保留为「其他」（批量导入不逐条询问）
      rep.needs_user.forEach((n: any) => {
        const raw = findEntry(n.uid);
        const content = raw ? TavernAdapter.cleanTavernContent(fullContent(raw)).text : n.source_excerpt;
        if (!content) return;
        WorldBookManager.addEntry(wbId, { type: '其他', name: n.comment || ('存疑条目' + (n.uid + 1)), content, inject: true });
        out.count++;
      });
      // 4) dropped：垃圾直接跳过
      return out;
    } catch (e) { return out; }
  },

  _tavernEntriesToArray(entries: any): any[] {
    if (Array.isArray(entries)) return entries;
    if (entries && typeof entries === 'object') return Object.keys(entries).map(k => entries[k]);
    return [];
  },

  _parsePNGCharCard(file: any) {
    return new Promise((resolve, reject: any) => {
      const reader = new FileReader();
      reader.onload = function () {
        try {
          const bytes = new Uint8Array(reader.result as ArrayBuffer);
          // Verify PNG signature
          if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
            reject(new Error('不是有效的PNG文件')); return;
          }
          // Helper to extract text from tEXt/iTXt chunk data
          const tryExtractChar = (chunkData: any) => {
            // Find null terminator of keyword
            let nullIdx = -1;
            for (let i = 0; i < chunkData.length; i++) {
              if (chunkData[i] === 0) { nullIdx = i; break; }
            }
            if (nullIdx < 0) return null;
            const keyword = new TextDecoder('latin1').decode(chunkData.slice(0, nullIdx));
            if (keyword !== 'chara' && keyword !== 'ccv3') return null;
            // Skip past keyword and any iTXt extra fields (compression flag + lang + translated keyword)
            let dataStart = nullIdx + 1;
            // iTXt has: compression flag(1) + method(1) + language(null-term) + translated-keyword(null-term)
            let skipFields = 0;
            for (let i = dataStart + 2; i < chunkData.length && skipFields < 2; i++) {
              if (chunkData[i] === 0) skipFields++;
              if (skipFields === 2) { dataStart = i + 1; break; }
            }
            // iTXt with 0 compression fields — dataStart may need reset
            if (dataStart < nullIdx + 2) dataStart = nullIdx + 1;
            const rawBytes = chunkData.slice(dataStart);
            // Try 1: base64 decode
            try {
              const latin1 = new TextDecoder('latin1').decode(rawBytes);
              const binary = atob(latin1.replace(/\s/g, ''));
              const utf8Bytes = new Uint8Array(binary.length);
              for (let i = 0; i < binary.length; i++) utf8Bytes[i] = binary.charCodeAt(i);
              const decoded = JSON.parse(new TextDecoder().decode(utf8Bytes));
              const result = decoded.data || decoded;
              // character_book may be at outer level (some tools/store formats)
              if (decoded.data && decoded.character_book && !result.character_book) {
                result.character_book = decoded.character_book;
              }
              return result;
            } catch {}
            // Try 2: raw UTF-8 JSON (some tools store unencoded JSON)
            try {
              const decoded = JSON.parse(new TextDecoder('utf-8').decode(rawBytes));
              return decoded.data || decoded;
            } catch {}
            return null;
          };
          let pos = 8; // Skip PNG signature
          while (pos < bytes.length) {
            const length = (bytes[pos] << 24) | (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
            pos += 4;
            const type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
            pos += 4;
            const data = bytes.slice(pos, pos + length);
            pos += length + 4; // Skip data + CRC
            if (type === 'tEXt' || type === 'iTXt') {
              const result = tryExtractChar(data);
              if (result) { resolve(result); return; }
            }
            if (type === 'IEND') break;
          }
          resolve(null); // No character card chunk found
        } catch (e) { reject(e); }
      };
      reader.onerror = function () { reject(new Error('文件读取失败')); };
      reader.readAsArrayBuffer(file);
    });
  },

  _stripSillyTavernFields(card: any) {
    const cleaned = {} as Record<string, any>;
    // Keep: core character info
    if (card.name) cleaned.name = card.name;
    if (card.description) cleaned.description = card.description;
    if (card.personality) cleaned.personality = card.personality;
    if (card.scenario) cleaned.scenario = card.scenario;
    if (card.first_mes) cleaned.first_mes = card.first_mes;
    if (card.mes_example) cleaned.mes_example = card.mes_example;
    if (card.system_prompt) cleaned.system_prompt = card.system_prompt;

    // Placeholder replacement
    const charName = cleaned.name || '';
    const protag = App.getProtagonist();
    const userName = (protag && protag.name) ? protag.name : '主角';
    const fields = ['description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt'];
    fields.forEach(f => {
      if (cleaned[f]) {
        cleaned[f] = cleaned[f].replace(/\{\{char\}\}/gi, charName).replace(/\{\{user\}\}/gi, userName);
      }
    });

    return cleaned;
  },

  _parseStructuredCard(firstMes: any) {
    // Directly parse <initvar> and <state_bar> from SillyTavern cards
    // Returns array of {type, name, content} or null if no structured data found
    const entries: any[] = [];

    // Parse <initvar> blocks (character/setting profiles)
    const initvarRegex = /<initvar>([\s\S]*?)<\/initvar>/g;
    let ivMatch;
    while ((ivMatch = initvarRegex.exec(firstMes)) !== null) {
      const block = ivMatch[1];
      const lines = block.split('\n');
      const cleaned: any[] = [];
      let name = '';
      for (let line of lines) {
        line = line.trim();
        if (!line) continue;
        if (line.startsWith('$') || line === '}' || line.startsWith('}')) continue;
        if (line === '文件信息:' || line === '文件信息' || line === '场景变量:' || line === '场景变量') continue;
        // Extract character name from various field names used in cards
        if (!name) {
          const nMatch = line.match(/^(?:角色名|姓名|角色名称|角色昵称|昵称)[：:]\s*(.+)/);
          if (nMatch) name = nMatch[1].trim();
        }
        cleaned.push(line);
      }
      // Fallback: use first non-tech section header as name
      if (!name) {
        for (const line of cleaned) {
          const hMatch = line.match(/^(\S+)[：:]/);
          if (hMatch && !['角色类型','基础信息','外貌性格','场景变量','文件信息','外表性格','场景'].includes(hMatch[1])) {
            name = hMatch[1];
            break;
          }
        }
      }
      if (name && cleaned.length > 1) {
        entries.push({ type: '角色', name, content: cleaned.join('\n') });
      }
    }

    // Parse <state_bar> JSON for additional structured data
    const sbMatch = firstMes.match(/<state_bar>([\s\S]*?)<\/state_bar>/);
    if (sbMatch) {
      try {
        const data = JSON.parse(sbMatch[1]);
        if (data.char_name && data.char_persona) {
          // Only add if we don't already have this character
          if (!entries.some(e => e.name === data.char_name)) {
            entries.push({ type: '角色', name: data.char_name, content: data.char_persona });
          }
        }
        if (data.world) {
          entries.push({ type: '地点', name: '世界观设定', content: data.world });
        }
      } catch (e) { /* state_bar JSON parse failed */ }
    }

    return entries.length > 0 ? entries : null;
  },

  async processCharCards() {
    const cards = this._pendingCharCards;
    if (cards.length === 0) { App.toast('没有可处理的角色卡'); return; }
    const statusEl = document.getElementById('charCardStatus');
    const btn = document.getElementById('btnCharCardConfirm');
    btn!.disabled = true; statusEl!.textContent = '正在解析角色卡...';
    // Create a new world book for imported cards
    const firstName = (cards[0].card && cards[0].card.name) || cards[0].fileName || '角色卡';
    const wbName = cards.length > 1 ? firstName + ' 等' + cards.length + '张' : firstName;
    const wb = WorldBookManager.createBook(wbName);
    // 留存原始酒馆数据：写卡里「把酒馆卡改造成适配卡」要靠它（Agent 通过 read_current_book_json 读到）
    try {
      const src = App._buildTavernSource(cards);
      if (src) WorldBookManager.setTavernSource(wb.id, src);
    } catch (e) { /* 留存失败不影响导入 */ }
    // 用第一张 PNG 的卡面作为导入世界书的封面
    if (cards[0].imgDataUrl) {
      try {
        const cover = await this._resizeImageDataUrl(cards[0].imgDataUrl);
        if (cover) WorldBookManager.setCover(wb.id, cover);
      } catch (e) { /* 封面可选 */ }
    }

    let added = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i].card;
      const raw = cards[i].raw || c;
      statusEl!.textContent = '正在解析 #' + (i + 1) + '/' + cards.length + ' ' + (c.name || '');

      // Fast path 1: character_book（酒馆世界书）→ 走酒馆适配器分类落库
      if (raw.character_book && raw.character_book.entries) {
        statusEl!.textContent = '正在适配世界书条目...';
        const wbImported = this._importTavernBook(wb.id, raw.character_book);
        added += wbImported.count;
        if (wbImported.transform > 0) {
          App.toast('卡内世界书含 ' + wbImported.transform + ' 条数值系统（好感度等），已保留文本，可到写卡让 AI 转述');
        }
        continue;
      }

      // Fast path 2: Parse <initvar> and <state_bar> from first_mes
      statusEl!.textContent = '尝试解析 initvar 结构化数据...';
      const parsed = App._parseStructuredCard(c.first_mes || '');
      if (parsed && parsed.length > 0) {
        parsed.forEach((entry: any) => {
          WorldBookManager.addEntry(wb.id, Object.assign({}, entry));
          added++;
          if (entry.type === '角色' && entry.name) {
            if (!CharacterManager.getByWorldBook(wb.id).find((ch: any) => ch.name === entry.name)) {
              CharacterManager.create({ name: entry.name, gender: '其他', age: '', relation: '', description: entry.content.substring(0, 500) });
            }
          }
        });
        continue; // Skip AI fallback for this card
      }

      // Fallback: AI extraction using raw card JSON (full data, no truncation)
      statusEl!.textContent = 'AI 正在分析 #' + (i + 1) + '/' + cards.length + ' ' + (c.name || '') + '...';
      const systemPrompt = PresetManager.getActiveSystemPrompt();
      const relevant = {} as Record<string, any>;
      ['name','description','personality','scenario','first_mes','mes_example','system_prompt','alternate_greetings','creator_notes'].forEach(k => {
        if (raw[k]) relevant[k] = raw[k];
      });
      const cardText = JSON.stringify(relevant, null, 2);
      const sysMsg = '你正在将一张 SillyTavern 角色卡转换为世界书条目。\n\n' +
        '有效字段说明：\n' +
        '- name: 角色名\n' +
        '- description: 角色描述（外貌、背景等）\n' +
        '- personality: 性格\n' +
        '- scenario: 初始场景/世界观\n' +
        '- first_mes: 开场白（含剧情和设定信息）\n' +
        '- mes_example: 对话示例\n' +
        '- system_prompt: 系统提示（行为规范、写作风格）\n' +
        '- alternate_greetings: 备用开场白\n' +
        '- creator_notes: 作者备注\n\n' +
        '请完整扫描以上所有字段，找出所有角色、地点、事件、物品、规则等设定信息。\n\n' +
        '输出格式（一行一条，必须包含 | 分隔符）：\n' +
        '类型 | 名称 | 内容 | 关键词\n\n' +
        '类型可选：角色、事件、设定、地点、规则、物品、关系、其他\n\n' +
        '要求：\n' +
        '1. 每个条目内容 30-150 字\n' +
        '2. 不要遗漏重要设定\n' +
        '3. 不要输出解释，只输出条目，不要编号\n' +
        '4. 关键词用逗号分隔，角色名必须作为关键词之一\n' +
        '5. 角色类型条目的关键词必须以角色名开头';
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'system', content: sysMsg },
        { role: 'user', content: '【世界书】' + wb.name + '\n\n' + cardText + '\n\n请解析并输出世界书条目：' }
      ];

      await new Promise((resolve) => {
        APIHandler.fetchCompletions(messages,
          (chunk) => { /* streaming not shown for extraction */ },
          (fullContent) => {
            if (fullContent) {
              const lines = fullContent.trim().split('\n');
              lines.forEach(line => {
                // Strip leading numbers (e.g. "1. ", "1、", "(1) ")
                let clean = line.trim().replace(/^[\d]+[.、\))\s]+/, '').trim();
                if (!clean.includes('|')) return;
                const match = clean.match(/^(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.*))?$/);
                if (match) {
                  const type = match[1].trim();
                  const name = match[2].trim();
                  const content = match[3].trim();
                  if (name && content && ['角色','事件','地点','规则','物品','关系','其他'].includes(type)) {
                    WorldBookManager.addEntry(wb.id, { type, name, content });
                    added++;
                  }
                }
              });
              // Register character in CharacterManager
              const charName = (raw.name || c.name || '').trim();
              if (charName && !CharacterManager.getByWorldBook(wb.id).find((ch: any) => ch.name === charName)) {
                CharacterManager.create({ name: charName, gender: '其他', age: '', relation: '', description: '(来自酒馆角色卡)' });
              }
            }
            resolve(undefined as any);
          },
          (err) => {
            statusEl!.textContent = 'AI 提取失败: ' + (err || '未知错误');
            console.error('Char card AI extraction error:', err);
            resolve(undefined as any);
          },
          { temperature: 0.3 }
        );
      });
    }

    UIManager!.closeModal('modalCharCardImport');
    WorldBookManager.setActiveId(wb.id);
    if (typeof BiqiAgent !== 'undefined' && BiqiAgent.reloadForBook) BiqiAgent.reloadForBook();
    UIManager.renderWorldBooks();
    UIManager!.renderWBEntries();
    // 切到新书：刷新编辑器与界面（避免正文停留在上一本书）
    App.loadEditorContent();
    App.renderAll();
    App.toast('已创建 ' + added + ' 条世界书条目（来自 ' + cards.length + ' 张角色卡）');
    this._pendingCharCards = [];
    // 角色卡导入后顺势选封面（取消使用默认）
    if (typeof UIManager.pickBookCover === 'function') {
      App.toast('可为此书选择一张封面（取消使用默认）');
      UIManager.pickBookCover(wb.id);
    }
  },

  // JSON backup
  async exportJSON() {
    this.saveCurrentChapter(); BookManager.syncToBook();
    const backup = {
      version: 6, exportedAt: new Date().toISOString(),
      books: BookManager.getAll(),
      activeBookId: BookManager.getActiveId(),
      protagonists: ProtagonistManager!.getAll(),
      worldBooks: WorldBookManager.getAll(),
      apiConfig: SM().get<any>('apiConfig', {}), presets: PresetManager.getPresets(),
      systemPrompts: PresetManager.getSystemPrompts(), regexRules: RegexEngine.getRules(),
      currentPresetId: PresetManager.getCurrentPresetId(), currentSysPromptId: PresetManager.getCurrentSystemPromptId(),
      uiSettings: SM().get<any>('uiSettings', {}),
      streamingOutput: SM().get<any>('streamingOutput', true)
    };
    const saved = await this.downloadFile('BQB Hub 备份_' + new Date().toISOString().slice(0,10) + '.json', JSON.stringify(backup, null, 2), 'application/json');
    App.toast('JSON 备份导出完成 (v6)' + (saved ? ' → ' + saved : ''));
  },

  async handleImportJSON(event: any) {
    const file = event.target.files[0]; if (!file) return;
    try {
      const text = await file.text(); const backup = JSON.parse(text);
      if (!backup.version && !backup.novelData && !backup.books) { App.toast('无效的备份文件'); return; }

      // v1-v4 migration: convert old single protagonist to new array format
      let protagonists = backup.protagonists || [];
      let activeProtagonistId = backup.activeProtagonistId || null;
      if (protagonists.length === 0 && backup.protagonist && backup.protagonist.name) {
        const migrated = { ...backup.protagonist, id: 'protag_' + Date.now() + '_mig', createdAt: Date.now() };
        protagonists = [migrated];
        activeProtagonistId = migrated.id;
      }
      if (protagonists.length === 0 && backup.characters && Array.isArray(backup.characters) && backup.characters.length > 0) {
        const c = backup.characters[0];
        const migrated = {
          id: 'protag_' + Date.now() + '_mig', name: c.name || '', gender: '', age: '', occupation: '',
          appearance: c.appearance || '', personality: c.personality || '',
          backstory: c.backstory || '', abilities: '', catchphrase: c.catchphrase || '',
          createdAt: Date.now()
        };
        protagonists = [migrated];
        activeProtagonistId = migrated.id;
      }

      const worldBooks = backup.worldBooks || [];

      // v5-v6 migration: handle books
      let books = backup.books || [];
      let activeBookId = backup.activeBookId || null;
      if (books.length === 0 && backup.novelData) {
        // v5 backup: single novelData, convert to books array
        books = [{
          id: 'book_default',
          title: backup.novelData.title || '未命名小说',
          chapters: backup.novelData.chapters || [{ id: 'ch_1', title: '第1章', content: '', createdAt: Date.now() }],
          currentChapterId: backup.novelData.currentChapterId || 'ch_1',
          worldSetting: backup.novelData.worldSetting || '',
          activeProtagonistId: activeProtagonistId,
          activeWorldBookId: backup.activeWorldBookId || null,
          writingGuide: '',
          createdAt: Date.now()
        }];
        activeBookId = 'book_default';
      }

      UIManager.showConfirm('导入备份将覆盖当前所有数据，确认继续？', () => {
        if (books.length > 0) {
          BookManager.saveAll(books);
          BookManager.setActiveId(activeBookId || books[0].id);
        }
        BookManager.syncFromBook();
        SM().remove('novelData');
        if (protagonists.length > 0) {
          ProtagonistManager.saveAll(protagonists);
          ProtagonistManager.setActiveId(activeProtagonistId);
        }
        SM().remove('protagonist');
        if (worldBooks.length > 0) WorldBookManager.saveAll(worldBooks);
        if (backup.apiConfig) SM().set('apiConfig', backup.apiConfig);
        if (backup.presets) PresetManager.savePresets(backup.presets);
        if (backup.systemPrompts) PresetManager.saveSystemPrompts(backup.systemPrompts);
        if (backup.regexRules) RegexEngine.saveRules(backup.regexRules);
        if (backup.currentPresetId) PresetManager.setCurrentPresetId(backup.currentPresetId);
        if (backup.currentSysPromptId) PresetManager.setCurrentSystemPromptId(backup.currentSysPromptId);
        if (backup.uiSettings) SM().set('uiSettings', backup.uiSettings);
	        if (backup.streamingOutput != null) { SM().set('streamingOutput', backup.streamingOutput); document.getElementById('streamingOutput')!.checked = backup.streamingOutput; }
        App.renderAll(); App.loadEditorContent(); UIManager.populateAPIFields(); App.toast('备份恢复成功！');
      });
    } catch(e) { App.toast('文件解析失败: ' + (e as any).message); }
    event.target.value = '';
  },

  // Export TXT
  async exportTXT() {
    this.saveCurrentChapter(); const d = this.getNovelData();
    let text = (d.title || '未命名小说') + '\n\n' + '='.repeat(40) + '\n\n';
    // Active protagonist
    const p = ProtagonistManager.getActive();
    if (p && p.name) {
      text += '【主角】\n- 姓名：' + p.name + '\n';
      if (p.gender) text += '- 性别：' + p.gender + '\n';
      if (p.age) text += '- 年龄：' + p.age + '\n';
      if (p.occupation) text += '- 职业：' + p.occupation + '\n';
      if (p.personality) text += '- 性格：' + p.personality + '\n';
      if (p.appearance) text += '- 外貌：' + p.appearance + '\n';
      if (p.catchphrase) text += '- 口头禅：' + p.catchphrase + '\n';
      if (p.abilities) text += '- 能力：' + p.abilities + '\n';
      if (p.backstory) text += '- 背景：' + p.backstory + '\n';
      text += '\n' + '='.repeat(40) + '\n\n';
    }
    // Worldbook entries
    const wb = WorldBookManager.getActive();
    if (wb && wb.entries && wb.entries.length > 0) {
      text += '【世界书：' + wb.name + '】\n';
      wb.entries.forEach(e => {
        text += '\n[' + e.type + '] ' + e.name + '\n' + e.content + '\n';
      });
      text += '\n' + '='.repeat(40) + '\n\n';
    }
    (d.chapters||[]).forEach((ch: any) => { const _html = (EditorManager.stripThinking ? EditorManager.stripThinking(ch.content||'') : (ch.content||'')); text += '## ' + (ch.title||'未命名') + '\n\n' + htmlToPlainText(_html) + '\n\n'; });
    const saved = await this.downloadFile((d.title||'小说') + '.txt', text, 'text/plain'); App.toast('TXT 导出完成' + (saved ? ' → ' + saved : ''));
  },

  // Theme
  setTheme(key: any) {
    if (!this.THEMES.some(function (t: any) { return t.key === key; })) key = 'light';
    const ui = SM().get<any>('uiSettings', {});
    ui.theme = key;
    delete ui.darkMode; // 迁移旧字段
    SM().set('uiSettings', ui);
    document.body.dataset.theme = key;
    if (typeof UIManager.renderMePage === 'function') UIManager.renderMePage();
    // 清除编辑器旧的内联文字颜色，让文字跟随主题
    const _ed = document.getElementById('editor'); if (_ed) { try { _ed.style.removeProperty('color'); } catch(e) {} }
  },

  _bumpContinuationCount() {
    const ui = SM().get<any>('uiSettings', {});
    ui.totalContinuationCount = (ui.totalContinuationCount || 0) + 1;
    SM().set('uiSettings', ui);
  },

  // Utility
  async downloadFile(filename: any, content: any, mimeType: any) {
    // 原生 Android：优先弹分享面板（可发 QQ/微信/保存到文件），失败再存"下载"文件夹
    if (window.HttpBridge && (typeof window.HttpBridge.shareFile === 'function' || typeof window.HttpBridge.saveFile === 'function')) {
      try {
        if (typeof window.HttpBridge.shareFile === 'function') {
          const sr = JSON.parse(window.HttpBridge.shareFile(filename, content, mimeType || 'text/plain'));
          if (sr.ok) return '分享面板已打开';
        }
        const r = JSON.parse(window.HttpBridge.saveFile(filename, content, mimeType || 'application/octet-stream'));
        if (r.ok) return r.path;
        throw new Error(r.error || 'save failed');
      } catch(e) {
        // 原生失败：兜底复制到剪贴板
        try {
          const ta = document.createElement('textarea');
          ta.value = content; document.body!.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          return '内容已复制到剪贴板（文件保存失败）';
        } catch(e2) { return ''; }
      }
    }
    const blob = new Blob([content], { type: mimeType + ';charset=utf-8' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body!.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    return '';
  },
  toast(message: any) { const el = document.getElementById('toast'); el!.textContent = message; el!.classList.add('show'); clearTimeout(el!._timeout); el!._timeout = setTimeout(() => el!.classList.remove('show'), 2500); }
};

document.addEventListener('DOMContentLoaded', () => {
  void (async () => {
    try { await _storageInit; } catch (e) { console.warn('[Init] 存储就绪等待异常:', e); }
    App.init();
    if (typeof BiqiAgent !== 'undefined' && BiqiAgent.init) BiqiAgent.init();
    if (typeof UsageAssistant !== 'undefined' && UsageAssistant.init) {
      UsageAssistant.init();
      UsageAssistant.renderMessages();
    }
  })();
  // QQ 式输入框自动增高（.chat-input-area 内的 textarea：初高 1 行，最多 5 行，超出滚动且始终显示最后一行）
  document.addEventListener('input', function (e) {
    var ta = e.target;
    if (ta!.tagName === 'TEXTAREA' && ta!.closest('.chat-input-area')) {
      ta!.style.height = 'auto';
      var max = parseInt(getComputedStyle(ta as HTMLElement).maxHeight) || 100;
      ta!.style.height = Math.min(ta!.scrollHeight, max) + 'px';
      // 超出上限滚动时，输入过程始终显示最后一行
      if (ta!.scrollHeight > ta!.clientHeight + 1) ta!.scrollTop = ta!.scrollHeight;
    }
  });
  // v1.5.75 起移除：启动时自动导入第三方酒馆预设 TGbreak.json（开源合规，文件已下架）。
  // 存量用户设备里已导入的那份仍在其本地 storage，功能不受影响。
});


// ---- build-legacy 构建管线生成的全局挂载 ----
const __pl = globalThis as any;
__pl._collectSTVars = _collectSTVars;
__pl._expandSTInMessages = _expandSTInMessages;
__pl._splitThinkingBlocks = _splitThinkingBlocks;
__pl._buildThinkingHtml = _buildThinkingHtml;
__pl.FrozenContext = FrozenContext;
__pl.App = App;
