// 酒馆（SillyTavern）宏引擎 —— 纯函数，供 app.ts / chatmode.ts 在请求发出前统一展开。
//
// 为什么要有这一层（2026-09-26 查「梦鲸思客V4 思维链不稳定」时定的）：
//   旧实现在 app.ts 里用两条正则（`{{setvar::k::v}}` / `{{getvar::k}}`）做一次性替换，有三个硬伤：
//   ① **值里嵌套 `}}` 就被截断**：`{{setvar::cot:: …{{getvar::level}}… }}` 的非贪婪匹配到内层 `}}`
//      就收尾 —— 实测梦鲸那份预设的 1678 字思维链收进变量的只剩 95 字，且尾部是半截宏；
//   ② **不递归**：插进去的值里还有宏也不会再展开（嵌套 getvar 永远不展开）；
//   ③ **只认 setvar/getvar**：`{{addvar::}}`（追加）、`{{trim}}`、`{{lastUserMessage}}` 全不认，
//      预设里这些宏会以字面文本原样发给模型。
//   现在按酒馆的语义重写：按消息顺序逐条展开、宏在出现处就地求值（setvar/addvar 先执行再删除），
//   值里嵌套的宏递归展开（限深度），未知宏原样保留（酒馆里扩展宏/正则就是这么处理的）。
//
// 支持：{{//注释}} / {{trim}} / {{setvar}} {{addvar}} {{getvar}} / {{getglobalvar}} {{setglobalvar}} /
//       {{lastUserMessage}} / {{char}} / {{user}}（含 {{ user }} 与裸 user，词边界保护）/
//       {{random::A|B,C}}（含 1-5 区间）/ ${说明文字} 剥壳。
// 不支持（原样保留，交给预设正则或作者自己处理）：酒馆扩展宏（如 {{压缩相邻消息::…}}）。

export interface StMacroCtx {
  vars: Record<string, string>;
  lastUserMessage: string;
  charName: string;
  userName: string;
  /** getvar 未声明时的兜底取值（本软件＝世界书运行时变量 VariableManager） */
  lookup?: (key: string) => string;
  /** {{getglobalvar::k}} / {{setglobalvar::k::v}}（酒馆的全局变量；本软件映射到运行时变量） */
  globalGet?: (key: string) => string;
  globalSet?: (key: string, value: string) => void;
  depth?: number;
  /** 本条消息里出现过 {{trim}} → 展开后对整条 trim */
  trimFlag?: boolean;
}

export interface StMacroPassOpts {
  /** {{lastUserMessage}} 的取值（本轮作者输入；酒馆里就是最后一条用户消息） */
  lastUserMessage?: string;
  /** {{char}} 的替换值（默认「其他角色」：本软件写作场景里是主角之外的互动角色） */
  charName?: string;
  /** {{user}}/裸 user 的替换值（默认「主角」；调用方传主角名） */
  userName?: string;
  /** 世界书里真有叫 User/user 的角色 → 裸 user 不展开（那是正经角色名） */
  userIsRealName?: boolean;
  lookup?: (key: string) => string;
  globalGet?: (key: string) => string;
  globalSet?: (key: string, value: string) => void;
  /** 返回 true 的整条消息不做裸 user 替换（正文块是作者原文，英文单词 user 不是占位符） */
  skipBareUser?: (content: string) => boolean;
}

/** 递归深度上限：宏套宏（setvar 的值里再 setvar）最多展开这么多层，防自引用死循环 */
const MAX_DEPTH = 8;

/**
 * 找到与 text[open]（'{{' 的起点）配对的 '}}' 结束位置（返回结束下标 +1，即该宏的末尾之后）。
 * **按嵌套计数**——值里嵌 `{{getvar::x}}` 时不会被内层的 `}}` 提前截断（旧实现正是栽在这里）。
 */
function macroEnd(text: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < text.length - 1) {
    const two = text.slice(i, i + 2);
    if (two === '{{') { depth++; i += 2; continue; }
    if (two === '}}') {
      depth--;
      i += 2;
      if (depth <= 0) return i;
      continue;
    }
    i++;
  }
  return -1; // 未闭合：按原文保留
}

/** 名称 + 余下参数（`setvar::k::v` → name='setvar', rest='k::v'；`setvar k v` → rest='k v'） */
function splitName(raw: string): { name: string; rest: string } | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:::)?\s*([\s\S]*)$/.exec(raw);
  if (!m) return null;
  return { name: m[1].toLowerCase(), rest: m[2] || '' };
}

/** setvar/addvar 的参数：`k::v`（酒馆主形态）或 `k v`（老形态） */
function parseKeyValue(rest: string): { key: string; value: string } {
  const i = rest.indexOf('::');
  if (i >= 0) return { key: rest.slice(0, i).trim(), value: rest.slice(i + 2) };
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest.trim());
  return m ? { key: m[1], value: m[2] == null ? '' : m[2] } : { key: rest.trim(), value: '' };
}

/** {{random::A|B,C}} / {{random::1-5}}：| 与 , 都当分隔符（老实现只认 |） */
function pickRandom(rest: string): string {
  const body = rest.replace(/^::/, '').trim();
  if (!body) return '';
  const opts: string[] = [];
  body.split(/[|,]/).forEach(function (part) {
    const s = part.trim();
    if (!s) return;
    const m = /^(-?\d+)-(-?\d+)$/.exec(s);   // 数字区间
    if (m) {
      const a = parseInt(m[1], 10); const b = parseInt(m[2], 10);
      if (Math.abs(b - a) <= 200) {
        for (let v = Math.min(a, b); v <= Math.max(a, b); v++) opts.push(String(v));
        return;
      }
    }
    opts.push(s);
  });
  if (opts.length === 0) return '';
  return opts[Math.floor(Math.random() * opts.length)];
}

/** 单个宏体 → 替换文本；返回 null ＝ 不认识的宏（原样保留） */
function applyMacro(body: string, ctx: StMacroCtx): string | null {
  const depth = ctx.depth || 0;
  if (depth > MAX_DEPTH) return '';             // 嵌套太深：当空处理，防死循环
  const raw = String(body == null ? '' : body).trim();
  if (!raw) return null;
  if (raw.indexOf('//') === 0) return '';        // {{//注释}}
  if (/^trim$/i.test(raw)) { ctx.trimFlag = true; return ''; }
  const sp = splitName(raw);
  if (!sp) return null;
  const sub = function (s: string): string {
    return expandStMacroText(s, Object.assign({}, ctx, { depth: depth + 1 }));
  };
  switch (sp.name) {
    case 'setvar':
    case 'addvar': {
      const kv = parseKeyValue(sp.rest);
      if (!kv.key) return '';
      const val = sub(kv.value);                 // setvar 的值里还有宏 → 就地展开（酒馆语义）
      ctx.vars[kv.key] = (sp.name === 'addvar' ? String(ctx.vars[kv.key] || '') : '') + val;
      return '';
    }
    case 'getvar': {
      const key = sp.rest.trim();
      if (!key) return '';
      let v = '';
      if (Object.prototype.hasOwnProperty.call(ctx.vars, key)) v = String(ctx.vars[key] || '');
      else if (ctx.lookup) { try { v = String(ctx.lookup(key) || ''); } catch (e) { v = ''; } }
      return sub(v);                             // 值里还有宏 → 继续展开（旧实现漏掉这一步）
    }
    case 'setglobalvar': {
      const kv = parseKeyValue(sp.rest);
      if (kv.key && ctx.globalSet) { try { ctx.globalSet(kv.key, sub(kv.value)); } catch (e) { /* ignore */ } }
      return '';
    }
    case 'getglobalvar': {
      const key = sp.rest.trim();
      let v = '';
      if (key && ctx.globalGet) { try { v = String(ctx.globalGet(key) || ''); } catch (e) { v = ''; } }
      return sub(v);
    }
    case 'lastusermessage': return sub(ctx.lastUserMessage || '');
    case 'char': case 'charifnotgroup': return ctx.charName;
    case 'user': return ctx.userName;
    case 'random': return pickRandom(sp.rest);
    default: return null;                        // 未知宏（酒馆扩展/自定义）→ 原样保留
  }
}

/** 展开一段文本里的所有宏（导出供 `_collectSTVars` 之类只读场景复用） */
export function expandStMacroText(text: string, ctx: StMacroCtx): string {
  const src = String(text == null ? '' : text);
  if (src.indexOf('{{') < 0) return src;
  let out = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{{', i);
    if (open < 0) { out += src.slice(i); break; }
    const end = macroEnd(src, open);
    if (end < 0) { out += src.slice(i); break; }        // 未闭合：原样保留
    out += src.slice(i, open);
    const rep = applyMacro(src.slice(open + 2, end - 2), ctx);
    out += (rep === null) ? src.slice(open, end) : rep;
    i = end;
  }
  return out;
}

/** 新建一个展开上下文（vars 在同一次请求内跨消息共享，与酒馆一致） */
export function createStMacroCtx(opts: StMacroPassOpts = {}): StMacroCtx {
  return {
    vars: {},
    lastUserMessage: String(opts.lastUserMessage == null ? '' : opts.lastUserMessage),
    charName: opts.charName || '其他角色',
    userName: opts.userName || '主角',
    lookup: opts.lookup,
    globalGet: opts.globalGet,
    globalSet: opts.globalSet,
    depth: 0,
    trimFlag: false,
  };
}

/**
 * 按顺序展开一组消息里的酒馆宏（就地修改 messages[i].content）。
 * 顺序即酒馆的 prompt_order 语义：先出现的 setvar/addvar 对后面（含同一条消息的后面）生效。
 */
export function expandStMacros(messages: Array<{ content?: unknown; role?: unknown }>, opts: StMacroPassOpts = {}): void {
  const ctx = createStMacroCtx(opts);
  for (let i = 0; i < (messages || []).length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg.content !== 'string') continue;
    const before = msg.content;
    ctx.trimFlag = false;
    let t = expandStMacroText(before, ctx);
    // 单花括号 {user} / { user }：酒馆卡与预设里常见的另一种写法（老实现单独处理过），
    // 与 {{user}} 一样展开成主角名；`{{...}}` 那一轮已经处理完，这里不会误伤其它宏。
    t = t.replace(/\{\s*user\s*\}/gi, function () { return ctx.userName; });
    // ${...} 占位符 → 去掉外壳，保留内部说明文字（本软件自己的写法，酒馆没有）
    t = t.replace(/\$\{([\s\S]*?)\}/g, function (_m: string, inner: string) { return String(inner).trim(); });
    // 裸 user（独立单词）→ 主角名；username / user_name / superuser 一个字母都不动
    if (!opts.userIsRealName && !(opts.skipBareUser && opts.skipBareUser(before))) {
      t = t.replace(/(^|[^A-Za-z0-9_])(?:user)(?![A-Za-z0-9_])/gi, function (_m: string, pre: string) { return pre + ctx.userName; });
    }
    t = t.replace(/\n{3,}/g, '\n\n');
    if (ctx.trimFlag) t = t.trim();
    msg.content = t;
  }
}
