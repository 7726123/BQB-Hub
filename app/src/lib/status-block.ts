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
  /** 原文块（诊断/面板「原文」用；兜底路径为收集到的那些行） */
  raw: string;
  /** 启用中的变量名 → 值；同名取最后一次出现，顺序按首次出现 */
  hits: StatusHit[];
  /** 块里出现、但书里没有同名条目的键（改名/停用后的残留、模型自己加的字段）——不丢，面板单独列出 */
  extra: StatusHit[];
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
/** 「未登记」键的形状要求（比启用中的名字严得多：正文里带冒号的散文行别被当成野变量收进来） */
const EXTRA_NAME_RE = /^[\w\u4e00-\u9fa5\-+#·]{1,16}$/;

/** 这一行是不是「名字：值」（通用形状；是否启用中的变量名由调用方判定） */
function matchKeyLine(line: string): { name: string; value: string } | null {
  // 行首允许缩进 / 项目符号 / 井号小标题；名字限 40 字内（变量名不会长）
  const m = /^[ \t]*(?:[-*•·]\s*)?(?:#{1,6}\s*)?([^\n]{1,40}?)[ \t]*[:：][ \t]?([\s\S]*)$/.exec(String(line || ''));
  if (!m) return null;
  const name = cleanName(m[1]);
  if (!name) return null;
  return { name: name, value: String(m[2] == null ? '' : m[2]) };
}

/**
 * 块内逐行解析：`名字：值` 起一条，其后到下一个名字行（或块尾）的行并入该条的值（支持多行值）。
 * name 命中 allowed → hits；否则 → extra（照更严的形状收，见 EXTRA_NAME_RE）。
 */
function parseBlockLines(inner: string, allowed: Set<string>, outHits: StatusHit[], outExtra: StatusHit[]): void {
  const lines = String(inner || '').split('\n');
  let cur: { name: string; value: string; known: boolean } | null = null;
  const flush = function () {
    if (!cur) return;
    const v = cleanValue(cur.value);
    if (v) (cur.known ? outHits : outExtra).push({ name: cur.name, value: v });
    cur = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const hit = matchKeyLine(lines[i]);
    if (hit) {
      const known = allowed.has(hit.name);
      // 未登记的键：名字要像"变量名"，值也不能是句子（散文行的特征是句末标点）
      const plausibleExtra = !known && EXTRA_NAME_RE.test(hit.name) && !/[。！？!?]\s*$/.test(cleanValue(hit.value));
      if (known || plausibleExtra) {
        flush();
        cur = { name: hit.name, value: hit.value, known: known };
        continue;
      }
      // 既不是启用中的变量、也不像未登记键（像散文行）→ 当普通文本行，并入当前条目
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
  const allowed = new Set<string>();
  (names || []).forEach(function (n) { const c = cleanName(n); if (c) allowed.add(c); });
  if (allowed.size === 0) return null;
  let out = src;
  const hits: StatusHit[] = [];
  const extra: StatusHit[] = [];
  const raws: string[] = [];
  // --- 主路径：标签块（逐个剥离；未闭合块 → 到文末） ---
  for (;;) {
    const om = STATUS_OPEN_RE.exec(out);
    if (!om) break;
    const after = out.slice(om.index + om[0].length);
    const cm = STATUS_CLOSE_RE.exec(after);
    const before = out.slice(0, om.index);
    if (cm) {
      parseBlockLines(after.slice(0, cm.index), allowed, hits, extra);
      raws.push(out.slice(om.index, om.index + om[0].length + cm.index + cm[0].length));
      out = before + after.slice(cm.index + cm[0].length);
    } else {
      // 漏闭标记：按"块独占正文末尾"的契约剥到文末（editor 的流式过滤器同规则）
      parseBlockLines(after, allowed, hits, extra);
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
      return (m && allowed.has(m.name)) ? m : null;
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
  return { raw: raws.join('\n\n').trim(), hits: dedupLastWins(hits), extra: dedupLastWins(extra), text: out };
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
