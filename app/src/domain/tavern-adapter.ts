// 酒馆世界书 JSON → 当前软件条目格式
// 纯函数：adapts Tavern-format lorebook JSON to a report of mapped/dropped/needs_user entries.
// 由写卡 agent 的 adapt_tavern_lorebook 工具调用，agent 据此决定如何落库。
// 落库本身不在这层（agent 走 upsert_entry / delete_entry / apply_character 写 draft，最后 write_to_worldbook 提交）。

export type TavernPolicy = 'conservative' | 'balanced' | 'aggressive';

// 酒馆 entry 的最小形状（其他字段一律忽略）
export interface TavernEntry {
  uid?: number;
  key?: string[];
  keysecondary?: string[];
  triggers?: string[];
  comment?: string;
  content?: string;
  constant?: boolean;
  selective?: boolean;
  selectiveLogic?: number;
  vectorized?: boolean;
  position?: number;
  order?: number;
  disable?: boolean;
  probability?: number;
  useProbability?: boolean;
  depth?: number;
  role?: number | string;
  extensions?: Record<string, any> | null;
  // 大量酒馆专属字段（不枚举）：outletName / sticky / cooldown / delay / useGroupScoring / group / groupOverride / groupWeight / scanDepth / matchPersonaDescription / matchCharacterDescription / matchCharacterPersonality / matchCharacterDepthPrompt / matchScenario / matchCreatorNotes / delayUntilRecursion / excludeRecursion / preventRecursion / ignoreBudget / caseSensitive / matchWholeWords / characterFilter / addMemo / automationId / displayIndex
  [k: string]: any;
}

export interface TavernInput {
  entries?: TavernEntry[] | Record<string, TavernEntry>;
  name?: string;
  [k: string]: any;
}

// 我们系统的条目形状（落库前）
export interface MappedEntry {
  type: '世界观' | '角色' | '其他' | '初始';
  name: string;
  content: string;
  inject: boolean;
  // 透传给 agent 便于追问
  _src?: {
    uid?: number;
    originalComment?: string;
    originalPosition?: number;
    selective?: boolean;
    constant?: boolean;
    // content 清洗信息（内部用，报告给 agent 便于向用户说明）
    contentCleaned?: boolean;
    removedPatterns?: string[];
  };
}

export type DropReason =
  | 'empty_placeholder'   // 空 content + 空 key/triggers（典型：变量块/分隔条）
  | 'macro_script'        // extensions.regex_script 或 macro_script
  | 'outlet_binding'      // outletName 存在（酒馆世界书流）
  | 'system_section'      // comment 形如 ====…====_开始 / _结束 / 变量系统
  | 'variable_block'      // content 是 $xxx = … 变量定义
  | 'meta_instruction'    // extensions.notes 含酒馆内部注入指令
  | 'numeric_system'      // 纯数值/状态系统（好感度 87、getvar 变量），无可读设定 → AI 转述不了，直接删
  | 'output_instruction'; // 给酒馆 AI 的输出指令（插画/CG 标签、JSON Patch 更新命令）——本软件无对应机制

export interface DroppedEntry {
  uid: number;
  comment: string;
  reason: DropReason;
  // 给 agent 复述给用户用：被丢的到底是什么（限长）
  preview: string;
}

export interface NeedsUserOption {
  label: string;          // 短标签
  preview: string;        // 改写后该条 entry 的最终样子（JSON/Markdown）
  recommendation: boolean;// true = agent 推荐这一项
  rationale: string;      // 一句话理由
}

// AI 转述条目：软件不支持数值/状态系统，由 AI 用大白话改写后落库（不询问用户）
export interface TransformEntry {
  uid: number;
  comment: string;
  source_excerpt: string;
  kind: 'rewrite_numeric' | 'drop_numeric';
  instruction: string;
}

export interface NeedsUserEntry {
  uid: number;
  comment: string;
  question: string;
  // 该条 entry 原文片段，便于用户在聊天里回"丢了吧"时 agent 知道指谁
  source_excerpt: string;
  options: NeedsUserOption[];
}

export interface AdaptReport {
  source_name: string;
  scanned: number;
  kept: MappedEntry[];
  dropped: DroppedEntry[];
  needs_user: NeedsUserEntry[];
  // 数值/状态系统条目：AI 转述（不询问用户）
  ai_transform: TransformEntry[];
  // 批量处理建议（needs_user 多时给出，让用户不用逐条回）
  bulk_options?: {
    all_keep_label: string;       // 全部保留为对应类型
    all_drop_label: string;       // 全部丢弃
    keep_characters_only_label: string;  // 只保留明显角色的
    n: number;
  };
  // 统计：方便 agent 给用户一句话总结
  stats: {
    dropped_silently: number;     // 不进 needs_user、纯 drop
    needs_user: number;           // 等用户拍板
    kept: number;
    ai_transform: number;         // 数值系统：AI 转述/删除
  };
  // 错误（如 JSON 解析失败）
  error?: string;
}

// 顶层入口：解析 + 分类 + 映射
export function adaptTavernLorebook(rawJson: string, policy: TavernPolicy = 'balanced'): AdaptReport {
  let parsed: TavernInput;
  try {
    parsed = JSON.parse(rawJson);
  } catch (e: any) {
    return {
      source_name: '',
      scanned: 0,
      kept: [],
      dropped: [],
      needs_user: [],
      ai_transform: [],
      stats: { dropped_silently: 0, needs_user: 0, kept: 0, ai_transform: 0 },
      error: 'JSON 解析失败：' + (e?.message || String(e)),
    };
  }
  return adaptTavernLorebookObject(parsed, policy);
}

export function adaptTavernLorebookObject(input: TavernInput, policy: TavernPolicy = 'balanced'): AdaptReport {
  const sourceName = (input && (input as any).name) || '未命名酒馆世界书';
  const entries = normalizeEntries(input?.entries);

  const kept: MappedEntry[] = [];
  const dropped: DroppedEntry[] = [];
  const needsUser: NeedsUserEntry[] = [];
  const aiTransform: TransformEntry[] = [];

  entries.forEach((e, idx) => {
    const uid = typeof e.uid === 'number' ? e.uid : idx;
    const comment = (e.comment || '').toString();
    const content = (e.content || '').toString();
    const keys = concatKeys(e);
    const hasExt = !!(e.extensions && typeof e.extensions === 'object');
    const hasScript = hasExt && !!(e.extensions!.regex_script || e.extensions!.macro_script || e.extensions!.script);
    const hasOutlet = !!(e.outletName && String(e.outletName).trim());
    const hasFilter = !!(e.characterFilter && (Array.isArray(e.characterFilter) ? e.characterFilter.length : true));
    const isPlaceholder = isEmptyPlaceholder(e, content, keys);
    const isSystemSection = isSystemSectionComment(comment);
    const isVarBlock = isVariableBlockContent(content);

    // —— 闸 1：明显占位 / 系统条 → 直接 drop（不计入 needs_user）——
    if (hasScript) {
      dropped.push(mkDrop(uid, comment, 'macro_script', excerpt(content, e)));
      return;
    }
    if (hasOutlet) {
      dropped.push(mkDrop(uid, comment, 'outlet_binding', excerpt(content, e)));
      return;
    }
    if (isSystemSection) {
      dropped.push(mkDrop(uid, comment, 'system_section', excerpt(content, e)));
      return;
    }
    if (isPlaceholder) {
      dropped.push(mkDrop(uid, comment, 'empty_placeholder', excerpt(content, e)));
      return;
    }
    if (isVarBlock) {
      dropped.push(mkDrop(uid, comment, 'variable_block', excerpt(content, e)));
      return;
    }
    if (hasExt && typeof e.extensions!.notes === 'string' && /before system|after desc|inject|@in\s/i.test(e.extensions!.notes)) {
      dropped.push(mkDrop(uid, comment, 'meta_instruction', excerpt(e.extensions!.notes, e)));
      return;
    }

    // —— 闸 1.5：给酒馆 AI 的输出指令（插画/CG 标签、JSON 更新命令）→ 直接 drop ——
    //    本软件没有插画输出/变量更新机制，这类指令式条目毫无用处。
    if (isOutputInstruction(content, comment)) {
      dropped.push(mkDrop(uid, comment, 'output_instruction', excerpt(content, e)));
      return;
    }

    // —— 闸 2：数值/状态系统（软件无法保存数值）→ 不走 needs_user ——
    //    可读设定文本够 → ai_transform（AI 大白话改写后落库）；
    //    纯宏/纯数值 → 直接 drop（numeric_system）。
    const numKind = classifyNumericSystem(content);
    if (numKind) {
      const cleanedReadable = readableAfterStrip(content);
      if (numKind === 'rewrite') {
        aiTransform.push({
          uid,
          comment,
          source_excerpt: cleanedReadable.slice(0, 400),
          kind: 'rewrite_numeric',
          instruction: '把情感/关系状态数值（好感度、信赖度、亲密度、心情、恋爱状态、受孕状态、阶段）改写成大白话描述（如「好感度 87」→「对主角好感颇深」），不保留任何状态变量引用；普通设定数据（年龄、身高、体重、生日、时薪、三围等）原样保留；改写后作为「其他」条目落库；整体是纯系统指令/无法转述成大白话的则删除。',
        });
      } else {
        dropped.push(mkDrop(uid, comment, 'numeric_system', cleanedReadable.slice(0, 200) || excerpt(content, e)));
      }
      return;
    }

    // —— 闸 3：明显正条（typical）→ 自动 keep + 映射 ——
    const isLikelyReal = isLikelyRealEntry(e, content, keys, comment);
    if (isLikelyReal) {
      kept.push(mapEntry(e, comment, content, keys));
      return;
    }

    // —— 闸 4：含糊（空 keys 但 content 写得正经 / 或 comment 与 content 主题不一致）→ needs_user ——
    needsUser.push(mkNeedsUser(e, uid, comment, content, keys));
  });

  // —— 闸 4：conservative 模式下，闸 2 的很多条也丢给 needs_user ——
  if (policy === 'conservative') {
    // 把"明显带 probability / group 行为"的也挪到 needs_user
    const moved: MappedEntry[] = [];
    kept.forEach(m => {
      const src = m._src || {};
      const hadGroupish =
        (typeof (kept.find(x => x === m) as any) === 'object') &&
        false; // 简化：保守模式直接交 needs_user，下面统一挪
      void hadGroupish;
      moved.push(m);
    });
    // 直接把"非空 keys"以外的都挪去 needs_user
    const strictKept: MappedEntry[] = [];
    moved.forEach(m => {
      // 保守：只留"comment 明确指明是角色/物品/地点"的
      const c = m._src?.originalComment || '';
      if (/^(角色|人物|物品|地点|场景|世界观|设定|组织|势力|势力|能力|技能|剧情|背景|规则)/.test(c) || /人物|角色/.test(c)) {
        strictKept.push(m);
      } else {
        needsUser.push({
          uid: m._src?.uid ?? -1,
          comment: m._src?.originalComment || '',
          question: '【保守模式】这条 content 看起来是设定但 comment 不够明确。是要保留为「' + (m.type) + '」，还是丢弃？',
          source_excerpt: m.content.slice(0, 200),
          options: [
            { label: '保留为「' + m.type + '」', preview: m.type + ' | ' + m.name + '\n' + m.content, recommendation: true, rationale: 'content 长度足够、文本通顺' },
            { label: '丢弃', preview: '（删除该条）', recommendation: false, rationale: 'comment 模糊，避免污染世界书' },
          ],
        });
      }
    });
    kept.length = 0;
    kept.push(...strictKept);
  }

  // —— 闸 5：aggressive 模式下，把带 probability 且 probability<100 的统一改成 inject=false（关闭注入）；useGroupScoring / vectorized 一律忽略 ——
  if (policy === 'aggressive') {
    kept.forEach(m => {
      // 概率低于 100 的视为可选背景，inject=false
      const e = entries.find(x => (x.uid ?? entries.indexOf(x)) === m._src?.uid);
      if (e && e.useProbability && typeof e.probability === 'number' && e.probability < 100) {
        m.inject = false;
      }
    });
  }

  return {
    source_name: sourceName,
    scanned: entries.length,
    kept,
    dropped,
    needs_user: needsUser,
    ai_transform: aiTransform,
    bulk_options: needsUser.length > 3 ? {
      all_keep_label: '全部保留为「' + (needsUser[0] ? needsUser[0].options[0].label.replace('保留为「', '').replace('」', '') : '其他') + '」',
      all_drop_label: '全部丢弃',
      keep_characters_only_label: '只保留明显角色的',
      n: needsUser.length,
    } : undefined,
    stats: {
      dropped_silently: dropped.length,
      needs_user: needsUser.length,
      kept: kept.length,
      ai_transform: aiTransform.length,
    },
  };
}

// —— 数值/状态系统判定 ——
// 酒馆常见的运行时状态引用：好感度/信赖度/亲密度数值、getvar/setvar、stat_data 变量、
// <xxx_variable> 状态容器、变量 schema 定义（type: number / check / ${...} / YYYY 格式）。
// 软件没有运行时变量，数值无法保存 → 不询问用户，
// 由 AI 转述成大白话（有可读设定时）或直接删除（纯宏/纯数值时）。
const NUMERIC_SYSTEM_RE = /(getvar|setvar|format_message_variable|stat_data|好感度\s*[:：]\s*-?\d|信赖度\s*[:：]\s*-?\d|亲密度\s*[:：]\s*-?\d|心情\s*[:：]\s*\w|<[a-z_]*variable[a-z_]*>|type:\s*number|check:|format:\s*"YYYY|\$\{[^}]+\}|associated variable|stage names overview|恋爱状态|受孕状态|执念度|五维|判定系统|数值判定)/i;

// 给酒馆 AI 的输出指令：插画/CG 标签、变量更新命令（JSON Patch）、快捷回复选项、"must output" 指令类
const OUTPUT_INSTRUCTION_RE = /(插画标签|CG触发|剧情插画输出规则|输出固定插画|插画强调|\[.*插画.*规则\]|must output the update|JSON Patch|update commands|快捷回复|回复选项|options>|生成四个|>>>|插入对应标签)/i;

function isOutputInstruction(content: string, comment: string): boolean {
  return OUTPUT_INSTRUCTION_RE.test(content || '') || OUTPUT_INSTRUCTION_RE.test(comment || '');
}

// 剥离宏/标签后剩下的可读文本（用于判断"还有没有设定内容"）
export function readableAfterStrip(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(/\{\{\s*[\w:._-]+(?:::[^}]*)?\s*\}\}/g, ' ')   // {{宏}}
    .replace(/<%\s*_?\s*[\s\S]*?_?\s*%>/g, ' ')              // <% EJS %>
    .replace(/<[a-z_]+[^>]*>[\s\S]*?<\/[a-z_]+[^>]*>/gi, ' ') // <tag>…</tag>
    .replace(/[=\-|>_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyNumericSystem(content: string): 'rewrite' | 'drop' | null {
  if (!content || !NUMERIC_SYSTEM_RE.test(content)) return null;
  // 可读文本 = 剥离宏/标签后再剥掉 schema 字段名（type:/check:/format:/rule: 等）与数字
  const readable = readableAfterStrip(content)
    .replace(/\b(type|check|format|rule|value|min|max|enum|default)\s*[:：]\s*/gi, '')
    .replace(/"[^"]*"/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return readable.length >= 20 ? 'rewrite' : 'drop';
}

// —— helpers ——

function normalizeEntries(raw: unknown): TavernEntry[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    // 酒馆导出可能把 entries 存成对象 { "0": {...}, "1": {...} }
    const keys = Object.keys(raw).sort((a, b) => {
      // 数值 key 按数值排，非数值保持字典序
      const na = /^\d+$/.test(a) ? parseInt(a, 10) : NaN;
      const nb = /^\d+$/.test(b) ? parseInt(b, 10) : NaN;
      if (!isNaN(na) && !isNaN(nb)) return na - nb;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    return keys.map(k => {
      const e = (raw as Record<string, unknown>)[k] as TavernEntry;
      // 对象 key 是酒馆的真实 uid（条目本身可能是老格式没有 uid）
      if (e && /^\d+$/.test(k)) {
        return { ...e, uid: parseInt(k, 10) } as TavernEntry;
      }
      return e;
    });
  }
  return [];
}

function concatKeys(e: TavernEntry): string[] {
  const out: string[] = [];
  if (Array.isArray(e.key)) out.push(...e.key.filter(Boolean));
  if (Array.isArray(e.keysecondary)) out.push(...e.keysecondary.filter(Boolean));
  if (Array.isArray(e.triggers)) out.push(...e.triggers.filter(Boolean));
  return Array.from(new Set(out.map(s => String(s).trim()).filter(Boolean)));
}

function isEmptyPlaceholder(e: TavernEntry, content: string, keys: string[]): boolean {
  if (content && content.trim().length > 0) return false;
  if (keys.length > 0) return false;
  // 酒馆常用 "占位条目"：空 content + 空 key + order 偏低（≤30）通常是分隔
  if (typeof e.order === 'number' && e.order <= 30) return true;
  // 关闭状态 + 空 → 占位
  if (e.disable === true) return true;
  return true;
}

function isSystemSectionComment(comment: string): boolean {
  const c = comment.trim();
  if (!c) return false;
  // ====xxx====_开始 / _结束 / 变量系统 / 正则 / 触发器 / 占位
  if (/^=+.*=+_?(开始|结束)?$/.test(c)) return true;
  // 以 ==== 开头（可能带 [mvu_plot] 后缀）也视为系统分隔条
  if (/^=+/.test(c) && /====/.test(c)) return true;
  if (/变量系统|正则|触发器|占位|^变量$|^系统$|^模板$/.test(c)) return true;
  return false;
}

function isVariableBlockContent(content: string): boolean {
  // 只有**纯**变量赋值的块才算变量块：
  // - 形如 $name = ... 的一行赋值
  // - 形如 {{setvar::...}} / {{getvar::...}} 的宏
  // - <%.*%> EJS 块
  // 不是：comment 里带 "变量"（那可能是规则/状态描述，得留着）
  if (!content) return false;
  const trimmed = content.trim();
  // 整段都是 $xxx = ...（多行也行）
  if (/^(\$[A-Za-z_][\w]*\s*=\s*.+(\r?\n)?)+$/.test(trimmed)) return true;
  if (/^\{\{\s*setvar::/.test(trimmed)) return true;
  if (/^\{\{\s*getvar::/.test(trimmed)) return true;
  if (/^<%.*%>$/.test(trimmed)) return true;
  return false;
}

function isLikelyRealEntry(e: TavernEntry, content: string, keys: string[], comment: string): boolean {
  // 闸 2 明确正条：keys 多 或 comment 带类型前缀 → 不必问用户
  if (keys.length > 0) return true;
  if (/^(角色|人物|世界观|设定|物品|地点|场景|组织|势力|能力|技能|剧情|背景|规则|初始)\s*[：:、]/.test(comment || '')) return true;
  // [InitVar] 变量初始化（mvu 开局状态）content 非空 → 当初始 keep（开局设定有价值的描述）
  if (/^\[InitVar\]/i.test(comment || '') && content && content.trim().length >= 20) return true;
  // [mvu_update] / [mvu_plot] 规则类（内容里是设定/规则文本）→ 当世界观 keep
  if (/^\[mvu_(update|plot)\]/i.test(comment || '') && content && content.trim().length >= 20 && !/<%|getvar|setvar|format_message/.test(content || '')) return true;
  // 其它：content 够长但没明确指示 → needs_user
  return false;
}

function mapEntry(e: TavernEntry, comment: string, content: string, keys: string[]): MappedEntry {
  // 类型推断：酒馆数字 type → comment 前缀 → content 关键词
  const type = inferType(comment, content, e.type);
  // 名称：comment 第一行（去掉前缀）→ 第一条 key → 截 content
  const name = inferName(comment, keys, content);
  // content 清洗：宏/模板标签只影响给酒馆看的部分，保留可读设定文本（{{user}} 保留、{{char}} 换成条目名）
  const cleaned = cleanTavernContent(content, name);
  // 注入：constant && !selective → 强制常驻（用 inject 字段即可；我们的语义里 inject=false 是关闭）
  // 注意：selective:false && constant:true 在酒馆 = 默认全部注入且不需 key → 我们用 inject=true
  // selective:false && !constant: 在酒馆 = 只要有 key 就注入 → 我们用 inject=true
  // selective:true && constant:false 且 key 空 → 酒馆不会注入；我们 inject=false
  const inject = computeInject(e, keys);

  return {
    type,
    name,
    content: cleaned.text,
    inject,
    _src: {
      uid: typeof e.uid === 'number' ? e.uid : undefined,
      originalComment: comment,
      originalPosition: e.position,
      selective: e.selective,
      constant: e.constant,
      contentCleaned: cleaned.changed,
      removedPatterns: cleaned.removed,
    },
  };
}

function inferType(comment: string, content: string, tavernType?: unknown): MappedEntry['type'] {
  const c = (comment || '').trim();
  // 0) 酒馆 V1/V2 经典数字 type（0=character 角色, 1=location, 2=event, 3=other）——
  //    我们只有 角色/世界观/初始/其他，地点事件统一「其他」
  if (typeof tavernType === 'number') {
    return tavernType === 0 ? '角色' : '其他';
  }
  // 1) 酒馆 mvu 前缀（[InitVar]/[mvu_update]/[mvu_plot]）不给类型：这些在酒馆是"开局状态/规则"，但
  //    在我们软件里「初始」=正文为空时注入一次、「世界观」=世界观分类，赋予会语义错位 → 一律「其他」，
  //    由用户/写卡 agent 之后自行归类。
  // 2) comment 前缀
  const m = c.match(/^(角色|人物|世界观|设定|物品|地点|场景|组织|势力|能力|技能|剧情|背景|规则|初始)/);
  if (m) {
    const t = m[1];
    if (t === '角色' || t === '人物') return '角色';
    if (t === '世界观' || t === '设定' || t === '背景' || t === '规则') return '世界观';
    if (t === '初始') return '初始';
    return '其他';
  }
  // 3) content 特征启发（V2/V3 无 type 字段、comment 是纯名字）：人物特征词 + 人物信号，
  //    两条件同时满足才判角色（保守，宁可漏判也不误伤世界观/地点）
  const personFeature = /性格|外貌|人设|爱好|喜欢|讨厌|梦想|职业|年龄|生日|生平|习惯|特长|声优|CV/.test(content);
  const personSignal = /她|他|本人|自称|主角|女主|男主|女生|男生|女孩|男孩|岁/.test(content);
  if (personFeature && personSignal) return '角色';
  // 4) 关键词启发
  if (/【角色】|【人物】/.test(c)) return '角色';
  if (/【世界观】|【设定】|【世界】/.test(c)) return '世界观';
  return '其他';
}

function inferName(comment: string, keys: string[], content: string): string {
  // 1) comment 去掉前缀（包括 [InitVar]/[mvu_x] 这类酒馆标签）
  const c = (comment || '').trim();
  const stripped = c
    .replace(/^\[[^\]]*\]\s*/i, '')                                    // [InitVar] / [mvu_update] 标签
    .replace(/^(角色|人物|世界观|设定|物品|地点|场景|组织|势力|能力|技能|剧情|背景|规则|初始)[：:、\s]*/, '')
    .trim();
  if (stripped) return stripped.slice(0, 40);
  // 2) 第一条 key
  if (keys.length > 0) return keys[0].slice(0, 40);
  // 3) content 首行
  const firstLine = (content || '').split(/\r?\n/).map(s => s.trim()).find(Boolean) || '';
  return firstLine.slice(0, 40) || '未命名条目';
}

function computeInject(e: TavernEntry, keys: string[]): boolean {
  // 关闭 → 不注入
  if (e.disable === true) return false;
  // selective + key 空 + 非常驻 → 不会注入
  if (e.selective && keys.length === 0 && !e.constant) return false;
  // useProbability 且 probability 极低（<5）→ 当作不注入
  if (e.useProbability && typeof e.probability === 'number' && e.probability < 5) return false;
  // 其它一律注入
  return true;
}

function mkDrop(uid: number, comment: string, reason: DropReason, preview: string): DroppedEntry {
  return { uid, comment, reason, preview: preview.slice(0, 200) };
}

function mkNeedsUser(e: TavernEntry, uid: number, comment: string, content: string, keys: string[]): NeedsUserEntry {
  const srcExcerpt = excerpt(content, e);
  const typeGuess = inferType(comment, content, e.type);
  const nameGuess = inferName(comment, keys, content);
  // preview 用清洗后落库形态（用户看到的就是最终写入的样子）
  const cleaned = cleanTavernContent(content, nameGuess);

  // 默认给三个候选
  const optKeep: NeedsUserOption = {
    label: '保留为「' + typeGuess + '」',
    preview: JSON.stringify({ type: typeGuess, name: nameGuess, content: cleaned.text }, null, 0).slice(0, 600),
    recommendation: true,
    rationale: 'content 是正经文本，按 comment 推断类型保留',
  };
  const optKeepAsCharacter: NeedsUserOption = {
    label: '改为「角色」',
    preview: JSON.stringify({ type: '角色', name: nameGuess, content: cleaned.text }, null, 0).slice(0, 600),
    recommendation: false,
    rationale: '若这条是描述一个人物（人称代词/关系描述）则归角色',
  };
  const optDrop: NeedsUserOption = {
    label: '丢弃',
    preview: '（删除该条）',
    recommendation: false,
    rationale: 'comment 与 content 不一致或 content 含酒馆残留',
  };

  const question = '这条 comment = "' + (comment || '（空）') + '"，但 ' +
    (keys.length === 0 ? '没有任何 key' : 'keys = [' + keys.join(', ') + ']') +
    '，且 content 是：' + srcExcerpt.slice(0, 80) + (content.length > 80 ? '…' : '') +
    '。要按哪种方式处理？';

  return {
    uid,
    comment,
    question,
    source_excerpt: srcExcerpt.slice(0, 400),
    options: [optKeep, optKeepAsCharacter, optDrop],
  };
}

function excerpt(content: string, e: TavernEntry): string {
  if (content && content.trim()) return content;
  if (e.extensions && typeof e.extensions === 'object') {
    const notes = e.extensions.notes;
    if (typeof notes === 'string' && notes.trim()) return notes;
  }
  return (e.comment || '').toString();
}

// —— content 清洗层 ——
// 只做"机械、可逆、明确"的清理：SillyTavern 宏 / EJS 模板标签 / 状态机标签块。
// 不清语义（规则文本里的数值/条件保留，留给 agent 与用户处理）。
export interface ContentCleanResult {
  text: string;
  removed: string[];   // 移除片段摘要（cap 8 条，给报告用）
  changed: boolean;
}

// 酒馆状态机标签白名单：成对/孤立标签整体删除（含包裹内容）
const KNOWN_STATE_TAGS = [
  'status_current_variable', 'state_bar', 'initvar', 'timer', 'system_prompt',
  'event_state', 'main', 'persona', 'message_route', 'scenario',
];

export function cleanTavernContent(raw: string, charName?: string): ContentCleanResult {
  if (!raw) return { text: '', removed: [], changed: false };
  const removed: string[] = [];
  const note = (m: string) => {
    const s = m.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (s && removed.length < 8) removed.push(s.slice(0, 60));
  };
  let text = raw;

  // 0) 宏处理：
  //    - {{char}}（酒馆"角色名"占位符）：软件没有 {{char}} 替换机制 → 替换成该条目名（charName 参数），
  //      否则会原样漏给注入的 AI 造成困惑。
  //    - {{user}}：语义占位符（主角名）→ 保留不动——软件已有把 {{user}} 换成主角名的机制，
  //      硬编码替换成"主角"会丢失动态性，删除会碎句。
  //    - 其余宏（{{getvar::…}}/{{pipe::…}} 等）→ 删除。
  text = text.replace(/\{\{\s*[\w:._-]+(?:::[^}]*)?\s*\}\}/g, (m) => {
    if (/^\{\{\s*user\s*\}\}$/i.test(m)) return m; // 保留 {{user}}
    if (/^\{\{\s*char\s*\}\}$/i.test(m)) {          // {{char}} → 条目名
      note(m);
      return charName && charName.trim() ? charName : '角色';
    }
    note(m);
    return '';
  });

  // 1) EJS 模板标签 <% ... %> / <%_ ... _%>：标签外壳删除
  //    内部若为纯控制流（if/else/for/end/var…）→ 整块删（条件对我们无用）；
  //    内部为可读文本 → 保留文本（人类规则可能藏在模板之间）。
  text = text.replace(/<%\s*_?\s*([\s\S]*?)\s*_?\s*%>/g, (_m, inner: string) => {
    const body = String(inner).trim();
    note('<% ' + body.slice(0, 40) + ' %>');
    if (/^(if|else|elseif|endif|for|end|var|const|let|each|unless|switch|case)\b/i.test(body)) return '';
    return '\n' + body + '\n';
  });

  // 3) 已知状态机标签块 <tag>…</tag> 整体删除；孤立开标签也删
  const re = new RegExp(
    '<(' + KNOWN_STATE_TAGS.join('|') + ')[^>]*>[\\s\\S]*?<\\/\\1[^>]*>|<(' + KNOWN_STATE_TAGS.join('|') + ')[^>]*>',
    'gi'
  );
  text = text.replace(re, (m) => { note(m); return ''; });

  // 4) 清理：行尾空格、3+ 连续空行压成 1、首尾空白
  text = text.replace(/[ \t]+\r?\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.trim();

  const changed = text !== raw;
  return { text, removed, changed };
}
