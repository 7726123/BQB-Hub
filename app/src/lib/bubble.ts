// 对话模式气泡解析（纯函数、无依赖；对话页渲染、稳定性测试、开发者工具三方共用）
//
// 设计约束（改动前先读）：
//   ① **绝不丢字**：解析只剥离"标记"（说话人前缀、引号、星号、成对括号），内容一律保留。
//      模型写歪时宁可样式不对，也不能让用户看到的内容缺一块。
//   ② 宽容优先：忘写前缀、把动作写进引号里、台词跨行、说话人写成"薇薇"而不是"林薇"，
//      都要能出气泡。解析失败的唯一表现是"归到旁白/上一个气泡"，不是报错。
//   ③ 两种输入共用一套扫描器，只换配置：
//      - AI 输出：引号 = 语言，其余 = 淡色（bareIsSay: false，默认）
//      - 作者输入：引号 = 语言，（）内 = 淡色，裸文本 = 语言（bareIsSay: true）
//      依据是软件既有的约定（写作页「场景草稿」就是"（）=心理/动作，「」=对话"）。

export interface BubbleBlock { type: 'say' | 'act'; text: string; nlBefore?: boolean }
export interface Bubble {
  speaker: string | null;   // null = 没有明确说话人（渲染成「白」/旁白）
  known: boolean;           // 说话人是否命中当前世界书的角色名单（决定头像与简介是否可点开）
  blocks: BubbleBlock[];
}

export interface ParseOpts {
  roster?: string[];         // 角色名单（世界书「角色」条目名 + 主角名）
  bareIsSay?: boolean;       // 裸文本算语言（作者输入 true；AI 输出 false）
  defaultSpeaker?: string | null;  // 无前缀时的归属（作者输入 = 主角名；AI 输出 = null → 白）
  aliases?: Record<string, string>; // 别名 → 规范名（如 { '我': 主角名 }：第一人称视角下模型会说「我」）
}

export interface ParseReport {
  bubbles: number;
  sayChars: number;          // 台词字数（标记剥离后）
  actChars: number;          // 非语言字数
  fallbackChars: number;     // 归到「白」/上一个气泡的字数（解析质量的反向指标）
  speakers: string[];
  unknownSpeakers: string[]; // 出现但不在名单里的说话人
  notes: string[];           // 检测到的格式问题（markdown、章节标题、总结句…）
}

// ---- 说话人识别 ----

// 名字只能由中日英文字母、间隔号、连字符、撇号组成；含标点一律不算名字（
// 「她转过身，低声说：」这类行因此不会被误判成说话人）。
const NAME_SHAPE = /^[A-Za-z\u4e00-\u9fa5·．.\-'’]{1,12}$/;
const MAX_NAME_CP = 8;
// 名称末尾可剥离的称呼（用于"薇薇"匹配"林薇"这类近名，仅匹配时用，显示仍用原文）
const TITLES = ['小姐', '先生', '女士', '老师', '大人', '同学', '哥哥', '姐姐', '弟弟', '妹妹', '大叔', '阿姨', '夫人', '殿下', '君'];
// 形如名字但明显不是说话人的词（整行以"注意："开头时不至于开出假气泡）
const NAME_STOP = new Set(['注意', '提示', '备注', '说明', '规则', '格式', '示例', '例', '注', '旁白', '作者', '导演', '系统', '本章', '总结', '注音', '此时', '这时', '同时', '随后', '于是', '片刻', '接着']);
// 叙述里「XX：」不是说话人：中文人名不会含这些结构助词/副词，而模型极爱写
// `她的声音很轻：「记得。」` `他沉默了一会儿：终于开口。` 这类叙述——以前会把「她的声音很轻」
// 当成一个新角色开气泡（带首字头像），用户看到的"非常奇怪的分段"里就有它。
const NARRATION_CHARS = /[的了着是在把被很都也又还就才刚再]/;

const LINE_SPEAKER = /^[ \t]*(?:[-*•]\s*)?(?:\*\*|【)?\s*([^：:]{1,16}?)\s*(?:\*\*|】)?\s*[：:]\s?([\s\S]*)$/;
// 漂移写法（实测 10 次里出现 1 次）：模型用空格代替冒号（`白 她站在讲台前`）。
// 空格/方括号两种只认"名字能对上名单"的情况——否则中文散文里「林薇 站在门口」这种会误开气泡。
const LINE_SPEAKER_SPACE = /^[ \t]*([^\s：:【】\[\]]{1,12})[ \t]+([\s\S]*)$/;
const LINE_SPEAKER_BRACKET = /^[ \t]*[【\[]([^\s】\]]{1,12})[】\]][ \t]*([\s\S]*)$/;

// 旁白/独白的固定说话人（不是角色，渲染成「白」头像；诊断里不算"名单外说话人"）
export const NARRATOR = '白';

export function normalizeSpeakerName(raw: string): string {
  let s = String(raw || '').replace(/\s+/g, '');
  for (const t of TITLES) { if (s.length > t.length && s.endsWith(t)) s = s.slice(0, -t.length); }
  return s;
}

interface SpeakerHit { name: string; known: boolean; rest: string }

// 名字里可能出现的并列连接词（「温水与和彦」= 同一个人拆成姓与名两截）
const SPEAKER_CONJ = ['与', '和', '＆', '&'];

// 名字能对上名单（或别名/旁白）才算已知——空格/方括号写法用它把关
function resolveKnown(cand: string, roster: string[], norm: Map<string, string>, aliases: Record<string, string>): string | null {
  const norm0 = normalizeSpeakerName(cand);
  if (norm0 === NARRATOR) return NARRATOR;
  const exact = norm.get(norm0);
  if (exact) return exact;
  const alias = aliases[cand] || aliases[norm0];
  if (alias) return alias;
  // 并列写法（「温水与和彦」这类）：删掉其中**一个**连接词后正好是名单里的名字/别名 → 算同一个人。
  // 不认这一条的话，名字会被当成"名单外的新人物"另起一个头像气泡——实测用户就是这么看到
  // 「另一个角色」的（模型把主角名的姓和名用「与」并起来写）。只删一个：名字本身常含「和」
  // （温水和彦），全删就认不出来了。
  for (let i = 0; i < norm0.length; i++) {
    if (SPEAKER_CONJ.indexOf(norm0[i]) < 0) continue;
    const stripped = norm0.slice(0, i) + norm0.slice(i + 1);
    const jn = norm.get(stripped);
    if (jn) return jn;
    const ja = aliases[stripped];
    if (ja) return ja;
  }
  for (const rname of roster) {
    if (cand.length > rname.length && cand.startsWith(rname)) return rname;
  }
  return null;
}

// 行首说话人：命中名单（或名单里的名字是候选的前缀）才算"已知"；
// 形状像名字但不在名单里仍然开出气泡（known:false，渲染成首字色块），只是不能点开简介。
function matchSpeaker(line: string, roster: string[], norm: Map<string, string>, aliases: Record<string, string>): SpeakerHit | null {
  const m = LINE_SPEAKER.exec(line);
  if (m) {
    const cand = String(m[1] || '').trim();
    const rest = m[2] == null ? '' : m[2];
    if (cand && NAME_SHAPE.test(cand) && Array.from(cand).length <= MAX_NAME_CP) {
      const norm0 = normalizeSpeakerName(cand);
      if (!NAME_STOP.has(cand) && !NAME_STOP.has(norm0)) {
        const known = resolveKnown(cand, roster, norm, aliases);
        if (known) return { name: known, known: true, rest };
        // 形状像名字的未知说话人：开气泡但不认作已知角色（名单里的名字不受这条限制——
        // 只挡"明显是叙述"的候选，见 NARRATION_CHARS）
        if (Array.from(cand).length <= 6 && !NARRATION_CHARS.test(cand)) return { name: cand, known: false, rest };
      }
    }
  }
  const b = LINE_SPEAKER_BRACKET.exec(line);
  if (b) {
    const cand = String(b[1] || '').trim();
    const known = cand ? resolveKnown(cand, roster, norm, aliases) : null;
    if (known) return { name: known, known: true, rest: b[2] == null ? '' : b[2] };
  }
  const s = LINE_SPEAKER_SPACE.exec(line);
  if (s) {
    const cand = String(s[1] || '').trim();
    const known = cand ? resolveKnown(cand, roster, norm, aliases) : null;
    if (known) return { name: known, known: true, rest: s[2] == null ? '' : s[2] };
  }
  return null;
}

// ---- 行内扫描：把一段文本切成 语言 / 非语言 块（只剥标记，不丢字）----

const SAY_OPEN: Record<string, string> = { '「': '」', '『': '』', '“': '”', '"': '"', '＂': '＂' };
// 任一收尾引号都算"引号结束"（仅在严格配对的那个收尾符后面不再出现时启用）：
// 模型常把 “ 和 " 混着写（`“你怎么才来。"`），严格配对时那个 " 不被认作结束，
// 后面的（动作）与叙述会一起被吞进深色的台词块里——用户报的"不是语言的部分却用了深色字体"。
const SAY_CLOSE_ANY: Record<string, boolean> = { '」': true, '』': true, '”': true, '"': true, '＂': true };

function scanSegments(text: string, bareIsSay: boolean): BubbleBlock[] {
  const out: BubbleBlock[] = [];
  let buf = ''; let bufType: 'say' | 'act' = bareIsSay ? 'say' : 'act';
  const flush = () => {
    if (!buf) return;
    // 块文本两端收干净（首尾空白不带进块里），但**记住这块前面原文里有没有换行**：
    // 渲染层靠 nlBefore 决定要不要 <br>（段落边界来自原文，而不是"块与块之间"）。
    // 以前两端直接 trim() 把换行吃掉，渲染层再统一补 <br>——于是段落位置来自块的切分，
    // 行内动作被硬拆行、拆出来的行还会以标点开头（用户报的那两条）。
    const lead = /^\s*/.exec(buf);
    const hadNl = !!lead && lead[0].indexOf('\n') >= 0;
    const t = buf.replace(/[ \t]+/g, ' ').trim();
    if (t) {
      const last = out[out.length - 1];
      if (last && last.type === bufType) last.text += (hadNl ? '\n' : '') + t;
      else out.push({ type: bufType, text: t, nlBefore: hadNl || undefined });
    } else if (hadNl && out.length > 0) {
      out[out.length - 1].text += '\n';   // 只有换行的"空块"（原文里的空行）：保留成段落间隔
    }
    buf = '';
  };
  let mode: 'bare' | 'say' | 'act' = 'bare';
  let close = '';
  let looseQuoteClose = false;   // true = 任意收尾引号都算结束（见 SAY_CLOSE_ANY）
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (mode === 'bare') {
      const q = SAY_OPEN[ch];
      if (q) {
        flush(); mode = 'say'; close = q; bufType = 'say';
        // 严格收尾符在这段文本里不再出现 → 放宽到"任意收尾引号"（混写/漏写收尾的兜底）
        looseQuoteClose = text.indexOf(q, i + 1) < 0;
        continue;
      }
      if (ch === '（' || ch === '(') { flush(); mode = 'act'; close = ch === '（' ? '）' : ')'; bufType = 'act'; looseQuoteClose = false; continue; }
      if (ch === '*') { flush(); mode = 'act'; close = '*'; bufType = 'act'; looseQuoteClose = false; continue; }
      buf += ch;
      continue;
    }
    if (ch === close) { flush(); mode = 'bare'; bufType = bareIsSay ? 'say' : 'act'; looseQuoteClose = false; continue; }
    if (mode === 'say' && looseQuoteClose && SAY_CLOSE_ANY[ch]) { flush(); mode = 'bare'; bufType = bareIsSay ? 'say' : 'act'; looseQuoteClose = false; continue; }
    if (close === '"' && ch === '”') { flush(); mode = 'bare'; bufType = bareIsSay ? 'say' : 'act'; looseQuoteClose = false; continue; }
    buf += ch;
  }
  flush();
  return out.filter(b => b.text.length > 0);
}

// 逐行剥掉行首说话人前缀（内容原样保留）。两个用途：
//   ① 生成路径/导出：把一段演出转成连续文本（气泡 → 小说正文）；
//   ② 丢字校验的不变量：剥前缀后的字符多重集，必须与解析出的所有块拼起来完全一致。
export function stripSpeakerPrefixes(raw: string, opts: ParseOpts = {}): string {
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  const { roster, norm, aliases } = prepare(opts);
  return text.split('\n').map(line => {
    const hit = matchSpeaker(line, roster, norm, aliases);
    return hit ? hit.rest : line;
  }).join('\n');
}

// ---- 主入口 ----

const emptyReport = (): ParseReport => ({ bubbles: 0, sayChars: 0, actChars: 0, fallbackChars: 0, speakers: [], unknownSpeakers: [], notes: [] });

function prepare(opts: ParseOpts) {
  const roster = (opts.roster || []).map(s => String(s || '').trim()).filter(Boolean);
  const norm = new Map<string, string>();
  roster.forEach(n => { const k = normalizeSpeakerName(n); if (!norm.has(k)) norm.set(k, n); });
  return { roster, norm, aliases: opts.aliases || {} };
}

// 整行被一对括号包住时剥掉最外层：作者常用这种写法把一句话整体括起来当"旁白动作"
// （`（哈？…（站起来。））`）。只有当括号刚好成对包住整段、中途不提前闭合时才剥——
// `（坐下）你说吧（笑）` 这种段落中间闭合的不动。
function stripOuterParen(s: string): string {
  const t = s.trim();
  if (t.length < 2) return s;
  const open = t[0], close = t[t.length - 1];
  if (open !== '（' && open !== '(') return s;
  if (close !== '）' && close !== ')') return s;
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') { depth--; if (depth === 0 && i < t.length - 1) return s; }
  }
  return t.slice(1, -1);
}

// 解析一段模型输出 / 作者输入。永不抛错（内部异常时退化成"整段一个旁白气泡"）。
export function parseBubbles(raw: string, opts: ParseOpts = {}): Bubble[] {
  let text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  if (!text.trim()) return [];
  if (opts.bareIsSay) text = stripOuterParen(text);
  const { roster, norm, aliases } = prepare(opts);
  const def = opts.defaultSpeaker ? String(opts.defaultSpeaker) : null;
  const bareIsSay = !!opts.bareIsSay;
  const bubbles: Bubble[] = [];
  let cur: { speaker: string | null; known: boolean; text: string } | null = null;
  const flush = () => {
    if (!cur) return;
    // 气泡文本只去掉**首尾**换行（避免气泡开头/结尾多出一个空行）；内部的换行一律保留：
    // 渲染层不再在块之间插 <br>，段落边界完全由原文决定。
    const blocks = scanSegments(cur.text.replace(/^\n+|\n+$/g, ''), bareIsSay);
    if (blocks.length) bubbles.push({ speaker: cur.speaker, known: cur.known, blocks });
    cur = null;
  };
  for (const line of text.split('\n')) {
    const hit = matchSpeaker(line, roster, norm, aliases);
    if (hit) { flush(); cur = { speaker: hit.name, known: hit.known, text: hit.rest }; continue; }
    if (!cur) cur = { speaker: def, known: def ? norm.has(normalizeSpeakerName(def)) : false, text: '' };
    cur.text += (cur.text ? '\n' : '') + line;
  }
  flush();
  return bubbles.filter(b => b.speaker !== null || (b.blocks && b.blocks.length > 0));
}

// ---- 诊断（稳定性测试 / 隐藏的开发者工具用；不参与渲染）----

const NOTE_PATTERNS: Array<[RegExp, string]> = [
  [/\*\*/, 'markdown 加粗'],
  [/^\s{0,3}#{1,6}\s/m, 'markdown 标题'],
  [/^\s{0,3}[-•]\s/m, 'markdown 列表'],
  [/^\s*\d+[.、]\s/m, '序号列表'],
  [/（未完待续）|\(未完待续\)|未完待续/, '未完待续类提示'],
  [/^\s*(好的|明白|收到)[，,。]?/m, '开场确认语'],
  [/^\s*【[^】]*】\s*$/m, '整行方括号说明'],
  [/^(第[\d一二三四五六七八九十百]+[章节]|#{1,6}\s)/m, '章节标题'],
  [/(^|\n)\s*[（(]\s*(注|说明|规则)[:：]/, '括注说明'],
  [/\bOOC\b|\[OOC\]/i, 'OOC 标记'],
];

export function analyzeParse(raw: string, opts: ParseOpts = {}): ParseReport {
  const rep = emptyReport();
  const text = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  if (!text.trim()) return rep;
  const roster = (opts.roster || []).map(s => String(s || '').trim()).filter(Boolean);
  let bubbles: Bubble[] = [];
  try { bubbles = parseBubbles(text, opts); } catch (e) { rep.notes.push('解析异常：' + String((e as Error)?.message || e)); }
  rep.bubbles = bubbles.length;
  const seen = new Set<string>();
  bubbles.forEach(b => {
    let say = 0, act = 0;
    b.blocks.forEach(bl => { if (bl.type === 'say') say += bl.text.replace(/\s/g, '').length; else act += bl.text.replace(/\s/g, '').length; });
    rep.sayChars += say; rep.actChars += act;
    if (b.speaker === null) rep.fallbackChars += say + act;
    else {
      if (!seen.has(b.speaker)) { seen.add(b.speaker); rep.speakers.push(b.speaker); }
      if (!b.known && !rep.unknownSpeakers.includes(b.speaker)) rep.unknownSpeakers.push(b.speaker);
    }
  });
  // 解析兜底占比（除第一段外，全是"没前缀"的推断）——只在报错诊断里用整段无说话人段落统计
  NOTE_PATTERNS.forEach(([re, label]) => { if (re.test(text)) rep.notes.push(label); });
  // 两个"解析质量"信号：引号丢了（台词会被当非语言渲染）与格式漂移（过半内容没有说话人前缀）
  const total0 = rep.sayChars + rep.actChars;
  if (rep.bubbles >= 4 && total0 > 0 && rep.sayChars < total0 * 0.03) rep.notes.push('台词未加引号（台词会被当成非语言渲染）');
  if (total0 > 0 && rep.fallbackChars > total0 * 0.5) rep.notes.push('格式漂移（过半内容没有说话人前缀）');
  if (roster.length) {
    const norm = new Set(roster.map(normalizeSpeakerName));
    const alias = opts.aliases || {};
    // 「白」是旁白标记不是角色；别名命中的（我→主角）也不算名单外
    const stray = rep.speakers.filter(s => s !== NARRATOR && !norm.has(normalizeSpeakerName(s)) && !(s in alias));
    if (stray.length > 0) rep.notes.push('名单外说话人：' + stray.join('、'));
  }
  return rep;
}

export default { parseBubbles, analyzeParse, normalizeSpeakerName, stripSpeakerPrefixes, NARRATOR };
