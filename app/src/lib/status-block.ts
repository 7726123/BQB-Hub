// 变量回报块（<status>…</status>）的识别、解析与剥离（纯函数 + 有状态流式过滤器）。
// 产品模型（2026-09-26 用户定案）：世界书「变量」条目 = 一个条目一个变量
//   · 名称 = 变量名（面板、注入、收集全按这个名字走）
//   · 内容 = 对模型的讲解（是什么、怎么变、范围/失败条件）
//   · 注入开关 = 单独启用/停用这条变量
// 模型每轮在正文之后按**软件给定**的格式回报「变量名：值」若干行；软件把块从正文里剥掉
// （流式阶段就不上屏），值按名字收进「变量」面板。用户不写格式契约，只写变量名与讲解。
//
// 只认「启用中的变量名」：正文里出现同名但不符格式的行不会被误剥（这是本模块的安全边界）。
// 纯函数、无依赖（与 lib/delta-tag.ts 同风格）：editor 的流式过滤与 domain/statusvars 共用。

/** 认得的标签名（大小写不敏感；中文形态一并认，正文里不会自然出现这些形态） */
export const STATUS_TAGS = ['status', 'statusbar', 'state', '状态栏', '状态'];

const OPEN_SRC = '<\\s*(?:' + STATUS_TAGS.join('|') + ')(?:\\s[^>]*)?>';
const CLOSE_SRC = '<\\s*\\/\\s*(?:' + STATUS_TAGS.join('|') + ')\\s*>';
/** 开标记（非全局：exec 恒从头部搜索） */
export const STATUS_OPEN_RE = new RegExp(OPEN_SRC, 'i');
/** 闭标记（非全局） */
export const STATUS_CLOSE_RE = new RegExp(CLOSE_SRC, 'i');
/** 流式扣留窗口：任何半截标记（最长 `</statusbar>` = 12 字符）都必须落在窗口内才拼得齐 */
const TAG_HOLD_MAX = 16;

export interface StatusHit { name: string; value: string }
export interface StatusParseResult {
  /** 原文块（诊断用；兜底路径为收集到的那些行） */
  raw: string;
  /** 启用中的变量名（一律是官方名）→ 值；同名取最后一次出现，顺序按首次出现 */
  hits: StatusHit[];
  /** 剥离后的正文 */
  text: string;
}

/** 名称与值的清理：模型爱加粗/加书名号/加项目符号，统一剥掉再做名字匹配 */
function cleanName(s: string): string {
  return String(s || '').trim().replace(/^[\s*_`【\[（(]+/, '').replace(/[\s*_`】\]）)]+$/, '');
}
function cleanValue(s: string): string {
  let v = String(s == null ? '' : s).trim();
  const m = v.match(/^\*\*([\s\S]*)\*\*$/);
  if (m) v = m[1].trim();
  return v;
}
/**
 * 名字的"规范化"形态：去掉空白与各种括号后比较。
 * 模型回报时会自己改名字的写法——漏掉右括号（实测：条目「手里的现金（日元）」被写成
 * 「手里的现金（日元=48000」）、括号换半角、名字里多一个空格。这些都应该落回同一个变量，
 * 而不是变成"一个不存在的变量"。
 */
function canonName(s: string): string {
  return String(s || '').replace(/[\s（）()【】\[\]「」『』{}<>]/g, '');
}

/** 这一行是不是「名字<分隔符>值」：冒号/全角冒号，以及模型爱写错的等号（实测 手里的现金（日元=48000） */
function matchKeyLine(line: string): { name: string; value: string; loose: boolean } | null {
  // 行首允许缩进 / 项目符号 / 井号小标题；名字限 40 字内（变量名不会长）
  const m = /^[ \t]*(?:[-*•·]\s*)?(?:#{1,6}\s*)?([^\n]{1,40}?)[ \t]*([:：=＝])[ \t]?([\s\S]*)$/.exec(String(line || ''));
  if (!m) return null;
  const name = cleanName(m[1]);
  if (!name) return null;
  const sep = m[2];
  return { name: name, value: String(m[3] == null ? '' : m[3]), loose: sep === '=' || sep === '＝' };
}

/**
 * 把回报里的名字解析成"官方变量名"。三级放宽：
 *   ① 精确（去首尾括号/加粗等标记后）  ② 规范化（去掉全部空白与括号）  ③ 包含（fuzzy：一方包含另一方，至少 3 字）
 * ③ 只在标签块里启用——块外（兜底行簇）是在正文上猜，放宽会误吃散文行。两者的名字都要求唯一命中。
 */
function resolveName(cand: string, allowed: Map<string, string>, fuzzy: boolean): string | null {
  if (allowed.has(cand)) return allowed.get(cand)!;
  const c = canonName(cand);
  if (!c) return null;
  const exactCanon: string[] = [];
  for (const [key, official] of allowed) { if (canonName(key) === c) exactCanon.push(official); }
  if (exactCanon.length === 1) return exactCanon[0];
  if (!fuzzy || c.length < 3) return null;
  const contains: string[] = [];
  for (const [key, official] of allowed) {
    const k = canonName(key);
    if (k.length < 3) continue;
    if (k.indexOf(c) >= 0 || c.indexOf(k) >= 0) contains.push(official);
  }
  return contains.length === 1 ? contains[0] : null;
}

/**
 * 块内逐行解析：`名字：值` 起一条，其后到下一个名字行（或块尾）的行并入该条的值（支持多行值）。
 * 名字命中启用中的变量（精确或规范化）→ 记到 outHits，并统一记成**官方变量名**（面板/存储都按它找）；
 * 命中不了的（模型自己加的字段、散文行）一律不入库也不显示——用户明确不要「未登记」那一块。
 */
function parseBlockLines(inner: string, allowed: Map<string, string>, outHits: StatusHit[]): void {
  const lines = String(inner || '').split('\n');
  let cur: { name: string; value: string } | null = null;
  const flush = function () {
    if (!cur) return;
    const v = cleanValue(cur.value);
    if (v) outHits.push({ name: cur.name, value: v });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const hit = matchKeyLine(lines[i]);
    if (hit) {
      const official = resolveName(hit.name, allowed, true);
      if (official) {
        flush();
        cur = { name: official, value: hit.value };
        continue;
      }
      // 认不出这个键：冒号行（模型自己加的字段）整行丢掉——不能并进上一个变量的多行值，
      // 否则会把值污染成"6\n心情：不错"。但**等号行**宽一点：清单项里写「- 找到钥匙 = 已完成」
      // 也会命中"名字=值"的形状，那种要当普通文本行留在当前变量的多行值里。
      if (!hit.loose) continue;
    }
    if (cur) cur.value += '\n' + lines[i];
  }
  flush();
}

/** 同名取最后一次出现（顺序按首次出现） */
function dedupLastWins(list: StatusHit[]): StatusHit[] {
  const idx: Record<string, number> = {};
  const out: StatusHit[] = [];
  list.forEach(function (h) {
    if (idx[h.name] !== undefined) out[idx[h.name]] = h;
    else { idx[h.name] = out.length; out.push(h); }
  });
  return out;
}

/** 表头行（兜底路径里紧挨在变量行上方的标记行，如「【状态栏】」），随变量行一起剥掉 */
function isHeaderLine(line: string): boolean {
  return /^【?\s*(状态栏|状态|变量)\s*】?[：:]?$/.test(String(line || '').trim());
}

/**
 * 找出并剥离变量回报块，解析出启用中变量的值。
 * 主路径＝标签块（可多块，全剥；命中按出现顺序合并、同名取最后一次）；兜底＝文末连续的
 * 「变量名：值」行簇（模型漏写标签时仍能收上值，并把那几行从正文里去掉）。
 * 返回 null ＝ 什么都没找到（调用方原样放行，绝不动正文）。
 */
export function parseStatusBlock(text: string, names: string[]): StatusParseResult | null {
  const src = String(text == null ? '' : text);
  if (!src) return null;
  // 官方变量名 → 规范化名（比较用）；命中后一律记官方名，面板/存储/{{getvar::}} 都按它找
  const allowed = new Map<string, string>();
  (names || []).forEach(function (n) { const c = cleanName(n); if (c) allowed.set(c, String(n).trim()); });
  if (allowed.size === 0) return null;
  let out = src;
  const hits: StatusHit[] = [];
  const raws: string[] = [];
  // --- 主路径：标签块（逐个剥离；未闭合块 → 到文末） ---
  for (;;) {
    const om = STATUS_OPEN_RE.exec(out);
    if (!om) break;
    const after = out.slice(om.index + om[0].length);
    const cm = STATUS_CLOSE_RE.exec(after);
    const before = out.slice(0, om.index);
    if (cm) {
      parseBlockLines(after.slice(0, cm.index), allowed, hits);
      raws.push(out.slice(om.index, om.index + om[0].length + cm.index + cm[0].length));
      out = before + after.slice(cm.index + cm[0].length);
    } else {
      // 漏闭标记：按"块独占正文末尾"的契约剥到文末（editor 的流式过滤器同规则）
      parseBlockLines(after, allowed, hits);
      raws.push(out.slice(om.index));
      out = before;
    }
  }
  // --- 兜底：文末连续的「变量名：值」行簇（只在标签块之外剩下的文本里找） ---
  {
    const lines = out.split('\n');
    let end = lines.length - 1;
    while (end >= 0 && !lines[end].trim()) end--;
    let i = end;
    const idx: number[] = [];
    const knownAt = function (k: number) {
      const m = matchKeyLine(lines[k]);
      if (!m) return null;
      const official = resolveName(m.name, allowed, false);
      return official ? { name: official, value: m.value } : null;
    };
    while (i >= 0) {
      if (!lines[i].trim()) { i--; continue; }         // 簇内允许空行
      if (!knownAt(i)) break;
      idx.push(i);
      i--;
    }
    if (idx.length > 0) {
      // 出现顺序入列；空值不算命中（与主路径同规则）
      const fb: StatusHit[] = [];
      for (let k = idx.length - 1; k >= 0; k--) {
        const hit = knownAt(idx[k])!;
        const v = cleanValue(hit.value);
        if (v) fb.push({ name: hit.name, value: v });
      }
      let cutStart = idx[idx.length - 1];
      for (let k = cutStart - 1; k >= 0; k--) {          // 紧邻上方若有表头行，一起剥掉
        if (!lines[k].trim()) continue;
        if (isHeaderLine(lines[k])) cutStart = k;
        break;
      }
      if (fb.length > 0) {
        fb.forEach(function (h) { hits.push(h); });
        raws.push(lines.slice(cutStart, end + 1).join('\n'));
      }
      // 簇行一律从正文里去掉（值全空也去：模型已经把这块写在正文末尾了，留着只会被读者看到）。
      // raw 为空时下面会因 raws.length === 0 而返回 null —— 此时 lines 里那几行是"只有名字没有值"的
      // 半成品，原样留在正文里比误删安全，故这个分支只在真有命中时生效（见上）。
      if (fb.length > 0) out = lines.slice(0, cutStart).concat(lines.slice(end + 1)).join('\n');
    }
  }
  if (raws.length === 0) return null;
  return { raw: raws.join('\n\n').trim(), hits: dedupLastWins(hits), text: out };
}

/** 只要剥离、不要值（对话模式渲染侧等只需要"别显示出来"的场合） */
export function stripStatusBlocks(text: string, names: string[]): string {
  const r = parseStatusBlock(text, names);
  return r ? r.text : String(text == null ? '' : text);
}

export interface StatusStreamFilter {
  /** 喂入一个流式分片，返回「可以上屏」的文本（半截标记会被扣留到下一片） */
  feed(chunk: string): string;
  /** 新一轮开始前复位 */
  reset(): void;
  /** 收尾：吐出扣留的文本（未构成标记的那些字符绝不丢；未闭合块＝丢弃，收口点会再剥一次） */
  release(): string;
}

/** 末尾是否是「开标记前缀」（`<`、`<s`、`<st`… `<状态`）；是则返回该片段用于扣留 */
function partialOpenPrefix(s: string): string {
  const tail = s.slice(Math.max(0, s.length - TAG_HOLD_MAX));
  for (let k = tail.length; k > 0; k--) {
    const cand = tail.slice(tail.length - k);
    if (cand[0] !== '<') continue;
    const rest = cand.slice(1).replace(/^[ \t]+/, '').toLowerCase();
    if (rest.length > 12) continue;
    if (rest.indexOf('>') >= 0 || rest.indexOf('<') >= 0) continue;
    if (STATUS_TAGS.some(function (t) { return t.indexOf(rest) === 0; })) return cand;
  }
  return '';
}

/**
 * 流式变量块过滤器（editor 用）：把 `<status>…</status>` 挡在上屏之前。
 * 与 [SETTING_DELTA] 的过滤同思路，但补了两处它没有的容错：
 * ① 开标记可能被 chunk 劈开（`<sta` + `tus>`）→ 扣留疑似前缀，绝不吐半个标记；
 * ② 丢弃态里保留尾部窗口 → 闭标记被劈开（`</sta` + `tus>`）也能认出来（delta 那套会一路丢到底）。
 */
export function createStatusStreamFilter(): StatusStreamFilter {
  let pending = '';
  let discarding = false;
  function drain(): string {
    let out = '';
    for (;;) {
      if (discarding) {
        const cm = STATUS_CLOSE_RE.exec(pending);
        if (!cm) { pending = pending.slice(-TAG_HOLD_MAX); return out; }
        out += pending.slice(cm.index + cm[0].length);
        pending = '';
        discarding = false;
        continue;
      }
      const om = STATUS_OPEN_RE.exec(pending);
      if (om) {
        out += pending.slice(0, om.index);
        pending = pending.slice(om.index + om[0].length);
        discarding = true;
        continue;
      }
      const hold = partialOpenPrefix(pending);
      if (hold) { out += pending.slice(0, pending.length - hold.length); pending = hold; }
      else { out += pending; pending = ''; }
      return out;
    }
  }
  return {
    feed(chunk: string): string {
      pending += String(chunk == null ? '' : chunk);
      return drain();
    },
    reset(): void { pending = ''; discarding = false; },
    release(): string {
      if (discarding) { pending = ''; return ''; }
      const t = pending;
      pending = '';
      return t;
    },
  };
}
