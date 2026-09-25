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
//   ④ 两条"漂移兜底"（2026-09-24 按真机反馈加的，见各自注释）：
//      - 整段没有引号的角色气泡（模型忘写引号）→ 逐句分色，台词不再被当成淡色；
//      - 没写说话人前缀的整行 → 另起一条旁白，不再粘进上一个角色的气泡尾部。
//   ⑤ 引号里的内容不一定是台词（2026-09-25 用户："很多时候引号内部并不一定是对话内容"）：
//      书名/歌名/标语/被强调的词/黑板上写的字，以及**被叙述包着的引述**（`她「哦」了一声`）都属于旁白。
//      判定见 _demoteQuotedTerms，只改分色不改字（丢字不变量不受影响）。
//   ⑥ 说话与非说话分段（2026-09-25 用户："说话的内容和非说话的内容要分段，不要直接连着"）：
//      相邻的台词块与非语言块之间在渲染上另起一行（para 标记）；换行前把下一块开头的标点
//      收进上一块，新行不以标点开头（1.5.97.36 用户报过"标点成为一行的第一个"）。

export interface BubbleBlock { type: 'say' | 'act'; text: string; nlBefore?: boolean; para?: boolean }
export interface Bubble {
  speaker: string | null;   // null = 没有明确说话人（渲染成「白」/旁白）
  known: boolean;           // 说话人是否命中当前世界书的角色名单（决定头像与简介是否可点开）
  blocks: BubbleBlock[];
}

export interface ParseOpts {
  roster?: string[];         // 角色名单（世界书「角色」条目名 + 主角名）
  bareIsSay?: boolean;       // 裸文本算语言（作者输入 true；AI 输出 false）
  defaultSpeaker?: string | null;  // 无前缀时的归属（作者输入 = 主角名；AI 输出 = null → 白）
  aliases?: Record<string, string>; // 别名 → 规范名（如 { '我': 主角名, 'user': 主角名 }：第一人称的「我」、卡片里的 user 占位符都是主角本人）
  narrator?: string;         // 第一人称叙述者（主角）的名字：它的气泡里"我…"的长动作句按叙述着色（见 looksLikeSpeech）
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

// 名字对照表（归一化名 → 名单里的显示名）。**纯拉丁名字**再登记一份小写键：模型把 user / Alice
// 写成 User / ALICE 也要能落到同一个人（2026-09-25 用户反馈：卡片常用 user 当主角占位符，而主角名
// 完全自定义）。中文名没有大小写，行为不变。先登记的优先，不被后来的同键覆盖。
function addNameKey(map: Map<string, string>, name: string, display: string) {
  const k = normalizeSpeakerName(name);
  if (!k) return;
  if (!map.has(k)) map.set(k, display);
  if (/[A-Za-z]/.test(k) && !/[\u4e00-\u9fa5]/.test(k)) {
    const lk = k.toLowerCase();
    if (!map.has(lk)) map.set(lk, display);
  }
}

// 查名字（原样 → 去大小写），查不到返回 null
function lookupName(map: Map<string, string>, cand: string): string | null {
  const k = normalizeSpeakerName(cand);
  if (!k) return null;
  const hit = map.get(k);
  if (hit) return hit;
  const lk = k.toLowerCase();
  return lk === k ? null : (map.get(lk) || null);
}

interface SpeakerHit { name: string; known: boolean; rest: string }

// 名字里可能出现的并列连接词（「温水与和彦」= 同一个人拆成姓与名两截）
const SPEAKER_CONJ = ['与', '和', '＆', '&'];

// 名字能对上名单（或别名/旁白）才算已知——空格/方括号写法用它把关
function resolveKnown(cand: string, roster: string[], norm: Map<string, string>, aliases: Map<string, string>): string | null {
  const norm0 = normalizeSpeakerName(cand);
  if (norm0 === NARRATOR) return NARRATOR;
  const exact = lookupName(norm, cand);
  if (exact) return exact;
  const alias = lookupName(aliases, cand);
  if (alias) return alias;
  // 并列写法（「温水与和彦」这类）：删掉其中**一个**连接词后正好是名单里的名字/别名 → 算同一个人。
  // 不认这一条的话，名字会被当成"名单外的新人物"另起一个头像气泡——实测用户就是这么看到
  // 「另一个角色」的（模型把主角名的姓和名用「与」并起来写）。只删一个：名字本身常含「和」
  // （温水和彦），全删就认不出来了。
  for (let i = 0; i < norm0.length; i++) {
    if (SPEAKER_CONJ.indexOf(norm0[i]) < 0) continue;
    const stripped = norm0.slice(0, i) + norm0.slice(i + 1);
    const jn = lookupName(norm, stripped);
    if (jn) return jn;
    const ja = lookupName(aliases, stripped);
    if (ja) return ja;
  }
  for (const rname of roster) {
    if (cand.length > rname.length && cand.startsWith(rname)) return rname;
  }
  return null;
}

// 行首说话人：命中名单（或名单里的名字是候选的前缀）才算"已知"；
// 形状像名字但不在名单里仍然开出气泡（known:false，渲染成首字色块），只是不能点开简介。
function matchSpeaker(line: string, roster: string[], norm: Map<string, string>, aliases: Map<string, string>): SpeakerHit | null {
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

interface ScanBlock extends BubbleBlock { fromBare?: boolean }

// 扫描器状态机：把一段文本切成 语言 / 非语言 段（只剥标记，不丢字）。
//   blocks = 段列表（fromBare = 这段来自"裸文本"还是引号/（）/* 里，漂移分色要用）；
//   open   = 末尾落在引号/（）/* 里（这一段的标记还没闭合）——判断"下一行是不是同一句话的续行"用它。
function _scanRaw(text: string, bareIsSay: boolean): { blocks: ScanBlock[]; open: boolean } {
  const out: ScanBlock[] = [];
  let buf = ''; let bufType: 'say' | 'act' = bareIsSay ? 'say' : 'act';
  let fromBare = true;
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
      // 相邻同类型块合并，但**来源不同不并**：裸文本与（）/* 的动作分开留着，
      // 漂移分色只动裸文本那一块，不会把（）里的动作一起染色。
      if (last && last.type === bufType && !!last.fromBare === fromBare) {
        last.text += (hadNl ? '\n' : '') + t;
      } else out.push({ type: bufType, text: t, nlBefore: hadNl || undefined, fromBare: fromBare || undefined });
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
        flush(); mode = 'say'; close = q; bufType = 'say'; fromBare = false;
        // 严格收尾符在这段文本里不再出现 → 放宽到"任意收尾引号"（混写/漏写收尾的兜底）
        looseQuoteClose = text.indexOf(q, i + 1) < 0;
        continue;
      }
      if (ch === '（' || ch === '(') { flush(); mode = 'act'; close = ch === '（' ? '）' : ')'; bufType = 'act'; fromBare = false; looseQuoteClose = false; continue; }
      if (ch === '*') { flush(); mode = 'act'; close = '*'; bufType = 'act'; fromBare = false; looseQuoteClose = false; continue; }
      buf += ch;
      continue;
    }
    if (ch === close) { flush(); mode = 'bare'; bufType = bareIsSay ? 'say' : 'act'; fromBare = true; looseQuoteClose = false; continue; }
    if (mode === 'say' && looseQuoteClose && SAY_CLOSE_ANY[ch]) { flush(); mode = 'bare'; bufType = bareIsSay ? 'say' : 'act'; fromBare = true; looseQuoteClose = false; continue; }
    if (close === '"' && ch === '”') { flush(); mode = 'bare'; bufType = bareIsSay ? 'say' : 'act'; fromBare = true; looseQuoteClose = false; continue; }
    buf += ch;
  }
  flush();
  return { blocks: out.filter(b => b.text.length > 0), open: mode !== 'bare' };
}

function scanSegments(text: string, bareIsSay: boolean): BubbleBlock[] {
  return _scanRaw(text, bareIsSay).blocks;
}

// ---- 漂移兜底 ①：整段没有引号的角色气泡 → 逐句分色 ----
// 背景（真机反馈："对话内容却是淡色"）：模型偶尔整篇不写引号（实测约 1/10，见
// fixtures/chat-output-space.txt：`林薇 我替人送的。`）。AI 输出的默认规则是"非引号=淡色"，
// 于是台词全变成了旁白色。这里改成：默认按台词（深色）上色，只有明显的第三人称叙述/场景句
// 仍按旁白（淡色）。**只在整段一个引号都没有时启用**——正常格式里的行内叙述
// （`「林叶。」她没回头。`）不受影响，仍按淡色。
const NARR_HEAD = /^(?:他|她|它|祂|他们|她们|它们|祂们|那人|这人|教室|走廊|窗外|门外|门口|外面|屋里|房里|街上|路上|远处|四周|周围|空气|灯光|天色|阳光|月光|声音|人群|后排|前排|台上|台下|桌上|地面|墙角|楼下|楼上|气氛|场面|然后|接着|于是|随后|跟着|随即)/;
const SPEECH_MARK = /[我你您咱]|[？！…]|[吧吗呢啊哦呀嘛](?:[。！？…]|$)/;
// 第一人称的"身体动作/操作"叙述（drift 输出里主角的动作常写成 `我把信封翻过来。` `我抬头。`）：
// 处置式（把…）与明确的肢体动作词 → 当叙述。只要句子里有第二人称/疑问/语气词/祈使词就不降级——
// 那是说话（`你把信给我。` `别把这事说出去。`）。把台词判成淡色是用户报过的更严重的错，宁可漏判。
const ACT_GUARD = /[你您咱]|[？！…～]|[吧吗呢啊哦呀嘛啦嘞]|别|请|喂|嗯|谢谢|对不[起住]/;
const ACT_POSSESS = /把[^，。！？…]{1,14}/;
const ACT_BODY = /(?:抬|低|回|点|摇|转)(?:起|下|过|了|着)?(?:了|一下)?(?:头|身|脸|眼)|伸出手|伸手|抬手|收回|掏出|塞回|塞进|捂住?|按住|拍|敲|踢|踩|拎|抱起?|搂|牵|背起|戴上|脱下|解开|系上|打开|关上|收起|翻开|翻到|合上|放下|拿起|抓起|捏住|推开|拉开|走进|走出|回到|停住|愣住|皱眉|叹气|抬眼|垂下|看向|盯着|瞥|站(?:着|在|起)|坐(?:着|在|下)|躺(?:着|在)|靠(?:着|在)|蹲(?:着|下)|(?:看|扫|望|瞄|瞟)了?(?:一眼|一下|两眼|几眼)/;
// "指示代词主语 + 状态"的叙述句（`那一眼没什么表情。` `这声音很轻。`）——真机反馈里这类被当成了台词；
// 要求同时出现状态标记（没什么/没有/很/…），比单看"那/这"开头安全（`那我先走了。` 仍是说话）。
const NARR_DEMON = /^(?:那|这)(?:一|个|种|副|张|声|下|眼|脸|阵|丝|抹|道|片|只|双|口|句|次|回|条|把|点|番)[^，。！？…]{0,12}(?:没什么|没有|不是|不像|很|挺|太|有点|显得|透着|带着)/;
// 程度补语句（`答得太快。` `走得比谁都快。`）是叙述，不是说话
const NARR_DEGREE = /^[^，。！？…]{1,6}[得地](?:太|很|挺|有点|比|像|更|极|非常|特别)/;
// 说话/心理类动词收尾过：句子里有它们，"我…"多半是在说话（`我其实早就知道这件事了。`）
const SAY_VERB_ANY = /(?:说|问|答|道|想|知道|觉得|认为|明白|记得|忘|希望|打算|愿意|喜欢|讨厌|抱歉|对不[起住]|谢谢|懂)/;

// 拟声/短音 + "了一声"（`哦了一声。` `应了一声。`）必定是叙述（谁发出了什么声音），不是台词
const NARR_UTTER = /^[^，。！？…]{0,3}(?:了一声)/;
// 「注意：」「提示：」这类括注说明：是旁白，不该开气泡、也不该粘在角色气泡里（要另起旁白行）
const NOTE_HEAD = /^(?:注意|提示|备注|说明|规则|格式|示例|注)[：:]/;

// narratorBubble = 这个气泡的说话人是**第一人称叙述者本人**（主角）。
// 漂移输出（模型整轮不写引号）里，一个气泡里常常是"台词 + 第一人称/第三人称叙述"混排，
// 所以逐句判成三态：'say'（明确是说话）/ 'act'（明确是叙述）/ 'amb'（看不出）——
// 拿不准的交给 speechifyAct 按"就近归属"（同气泡里最近的有标签句子）或长度处理。
// 判错的代价是双向的：叙述染深色（用户 2026-09-25 连着报过三次）与台词染淡（1.5.98.1 报过），
// 所以这里只在**有明确线索**时下结论，其余一律 amb。
const INTERROG = /(?:什么|怎么|为什么|为啥|谁|哪|几|多少|是不是|好不好|行不行|对不对|吗|呢)/;
// 疑问词要先排除"不定代词"用法：`像被什么东西勒过` `什么都没说` `什么时候都行` 都不是提问
function hasInterrogative(s: string): boolean {
  const t = s
    .replace(/(?:像|好像|似乎|仿佛|像是)[^，。！？…]{0,4}什么/g, '')
    .replace(/没(?:什么|啥)/g, '')
    .replace(/什么[^，。！？…]{0,4}(?:都|也)/g, '');
  return INTERROG.test(t);
}
const IMPERATIVE_HEAD = /(?:^|[，。；：！？…\s])(?:请|快|喂|嗯|谢谢|对不[起住])/;
// 祈使/否定祈使（`别拆。` `灯别全关，值日的留下。`）：先把"别的/告别/特别/区别…"这类构词剔掉，
// 再看还有没有"别"——不然 `她把别的东西收起来。` 会被当成说话
function hasImperative(s: string): boolean {
  const t = s.replace(/(?:告别|分别|特别|差别|识别|辨别|性别|个别|离别|道别|类别|级别|区别|别致|别墅|别人|别的|别处|别扭|别说|别针|别具|别管)/g, '');
  return t.indexOf('别') >= 0 || IMPERATIVE_HEAD.test(t);
}

function classifySentence(sentence: string, narratorBubble = false): 'say' | 'act' | 'amb' {
  const s = sentence.trim();
  if (!s) return 'amb';
  // ---- 明确是叙述 ----
  if (NARR_HEAD.test(s)) return 'act';
  if (NARR_UTTER.test(s)) return 'act';
  if (NOTE_HEAD.test(s)) return 'act';          // 注意：/提示：这类括注说明本身不是说话
  // 「她哦了一声」里的「哦」是拟声不是语气词：判"有没有口语标记"之前先把它剔掉，
  // 否则 `我点头。她哦了一声。` 会被 哦 挡住叙事判定、整句染成台词
  const gc = s.replace(/[哦嗯啊诶欸噢唔喔]{1,2}了一声/g, '');
  if (!ACT_GUARD.test(gc) && (NARR_DEMON.test(s) || NARR_DEGREE.test(s))) return 'act';
  if (!ACT_GUARD.test(gc) && (ACT_POSSESS.test(s) || ACT_BODY.test(s))) return 'act';
  if (narratorBubble && s.indexOf('我') >= 0 && Array.from(s).length >= 12
    && !/[你您]|[？！…～]/.test(gc) && !/[吧吗呢啊哦呀嘛啦嘞](?:[。！？…]|$)/.test(s)
    && !SAY_VERB_ANY.test(s)) return 'act';
  // ---- 明确是台词 ----
  if (SPEECH_MARK.test(s)) return 'say';        // 我/你/您/咱、？！…、句末语气词
  if (/[你您]/.test(gc)) return 'say';
  if (hasInterrogative(s)) return 'say';        // 疑问词（模型经常忘打问号）
  if (hasImperative(s)) return 'say';
  if (!SPEECH_MARK.test(s) && s.length >= 18) return 'act';   // 没有口语标记的长句 → 当叙述
  return 'amb';
}

function looksLikeSpeech(sentence: string, narratorBubble = false): boolean {
  return classifySentence(sentence, narratorBubble) === 'say';
}

// 按句号类标点与换行切句（标点留在句里，保证"绝不丢字"）
function splitSentences(text: string): Array<{ text: string; nlBefore?: boolean }> {
  const out: Array<{ text: string; nlBefore?: boolean }> = [];
  let buf = ''; let nl = false;
  const push = () => { const t = buf.trim(); if (t) out.push({ text: t, nlBefore: nl || undefined }); buf = ''; nl = false; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') { push(); nl = true; continue; }
    buf += ch;
    if ('。！？…；!?;'.indexOf(ch) >= 0) {
      while (i + 1 < text.length && '。！？…；!?;'.indexOf(text[i + 1]) >= 0) { buf += text[i + 1]; i++; }   // 连续标点（……）归本句
      push();
    }
  }
  push();
  return out;
}

function speechifyAct(text: string, nlBefore?: boolean, narratorBubble = false, answering = false, roundQuoted = false): BubbleBlock[] {
  const out: BubbleBlock[] = [];
  // 先接"折行"：换行后上一句还没有句末标点（`我点头。她\n哦\n了一声。`），说明模型只是把一句
  // 折成了几行——碎片（≤3 字且没有句末标点）也一并接回，否则「哦」会被当成一句短台词染深色
  // （用户 2026-09-25 反馈：`哦` 是别人说的话被叙述引述，却被深色 + 分段）。
  const parts: Array<{ text: string; nlBefore?: boolean }> = [];
  splitSentences(text).forEach(p => {
    const prev = parts[parts.length - 1];
    const prevEnds = prev ? /[。！？…；!?;]$/.test(prev.text) : false;
    const frag = !/[。！？…；!?;]$/.test(p.text) && Array.from(p.text).length <= 3;
    if (prev && (!prevEnds || frag)) prev.text += p.text;
    else parts.push({ text: p.text, nlBefore: p.nlBefore });
  });
  // 句级分类 + 归属：拿不准（amb）的句子按三条线索定——
  //   ① 很短（≤6 字）→ 短回复（`不行。` `楼梯口。` `器材室门口。`），算台词；
  //   ② 这句是在回答上一气泡的提问 → 算台词；
  //   ③ 其余看**整轮有没有引号**：模型这一轮里对白都带引号、只有旁白忘了写「白：」时，
  //      没引号的句子按叙述（`门被带上了一半。`）；整轮一个引号都没有（真漂移）时按台词
  //      （`我替人送的。`——1.5.98.1 用户报过"对话内容却是淡色"，漂移时宁可保台词色）。
  const cls = parts.map(p => classifySentence(p.text, narratorBubble));
  parts.forEach((p, i) => {
    let type: 'say' | 'act';
    if (cls[i] !== 'amb') type = cls[i] as 'say' | 'act';
    else if (Array.from(p.text.trim()).length <= 6 || answering) type = 'say';
    else type = roundQuoted ? 'act' : 'say';
    const last = out[out.length - 1];
    const nl = i === 0 ? nlBefore : p.nlBefore;
    if (last && last.type === type) last.text += (nl ? '\n' : '') + p.text;
    else out.push({ type, text: p.text, nlBefore: nl || undefined });
  });
  return out;
}

// ---- 引号里的内容不一定是台词（2026-09-25：用户「很多时候引号内部并不一定是对话内容」）----
// 书名/歌名/标语/被强调的词/黑板上写的字/牌子上写的字也用引号，它们属于旁白，不该染成台词色：
//   `白：她把「就一次」说得很重`   `她哼起了「四季」的调子`   `最后一个"叶"的捺拖得很长`
//   `牌子上写着「禁止入内」`       `班里顿时「安静」了下来`
// 判定为"引用"（→ 并入旁白淡色）要**同时**满足下面这些条件（宁可漏判也不误判——把台词判成
// 旁白正是 1.5.98.1 用户报过的错"对话内容却是淡色"，那更严重）：
//   ① 引号内没有句末标点；② 不长（≤8 字）；
//   ③ 没有第一/第二人称与语气词（「我知道了」「你好吗」是在说话）；
//   ④ 引号前面是"书写/命名"类词（写着/叫做/题为…），**或者**同一行里它前后都接着叙述（嵌在句中）；
//   ⑤ 引号前面不是"说"类动词或冒号（`她说「等一下」` 是在说话，不是引用）。
const TERM_MAX_CP = 8;
const TERM_PUNCT = /[。！？…!?～~]/;
const TERM_PERSON = /[我你您咱]/;
const TERM_PARTICLE = /[吧吗呢啊哦呀嘛啦嘞]/;
const TERM_INTERJECTION = /^(?:嗯+|哦+|噢+|啊+|诶+|欸+|喂+|哈+|嘿+|哼+|呀+|哎呀|哎哟|唔+|喔+|唉+)$/;
// "说"类动词收尾（后面跟的引号是台词）
const SAY_LEAD = /(?:说|道|问|答|喊|叫|嚷|吼|唱|念|骂|嘟囔|咕哝|低语|开口|回答|反问|追问|补充|重复|自语|心说|心想|暗想|默念)$/;
// 收尾是「道」但不是"说话"的词（知道/味道/街道…）——不参与上面的判定
const NOT_SAY_DAO = /(?:知道|味道|街道|难道|一道|大道|走道|通道|地道|门道|厚道)$/;
// "书写/命名"类词收尾（后面跟的引号是引用：标牌上的字、书名、叫法）
const WRITE_LEAD = /(?:写着|写下|写了|写道|写在|刻着|印着|贴着|挂着|标着|画着|绣着|记着|登着|题为|叫做|名叫|称为|俗称|字样)$/;

function _isQuotedTerm(text: string, leadAct: string, hasActAfter: boolean, embedded: boolean, followAct: string): boolean {
  const t = String(text || '').replace(/\s+/g, '');
  if (!t || Array.from(t).length > TERM_MAX_CP) return false;
  if (TERM_PUNCT.test(t)) return false;
  const lead = String(leadAct || '').replace(/\s+/g, '');
  if (lead) {
    if (WRITE_LEAD.test(lead)) return true;                              // 标牌/书名/叫法 → 引用
    if (/[：:]$/.test(lead)) return false;                               // 冒号引导 → 台词
    if (SAY_LEAD.test(lead) && !NOT_SAY_DAO.test(lead)) return false;    // 「她说「等一下」」→ 台词
  }
  // 引号后面紧跟"了一声"（模型把 `她「哦」了一声` 折成几行写）——被引述的一声，不是台词
  if (/^[，,]?\s*了一声/.test(String(followAct || ''))) return true;
  // 嵌在叙述句子中间（同一行前后都接着叙述）→ 引述：`我点头。她「哦」了一声。` `他回了句「知道」，挂了电话。`
  // 这一条**不看人称与语气词**——「哦」「嗯」「我先走了」这类被叙述包着的引述也该是淡色
  // （用户 2026-09-25 反馈：`她「哦」了一声` 的「哦」被当成台词深色 + 分段了）。
  // 例外：引号内容以句中标点收尾（`「我先走了，」她挥了挥手。`——那是模型在写真对白）仍按台词。
  if (embedded) return !/[，、；：,;:]$/.test(t);
  if (TERM_PERSON.test(t) || TERM_PARTICLE.test(t) || TERM_INTERJECTION.test(t)) return false;
  return !!lead && hasActAfter;                                          // 嵌在叙述句子中间 → 引用
}

// 把"引用"的台词块降级成旁白块（只改类型，一个字不动）。相邻的引用块会与前后旁白块合并。
function _demoteQuotedTerms(blocks: ScanBlock[]): ScanBlock[] {
  const out: ScanBlock[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    // 只有"引号包出来的台词块"参与判定：裸文本（fromBare）与（）/* 造成的块不动；
    // 引号内容里本来就有换行的（多行台词）也不动
    if (b.type !== 'say' || b.fromBare || b.text.indexOf('\n') >= 0) { out.push(b); continue; }
    const prev = out[out.length - 1];
    const next = blocks[i + 1];
    const leadSameLine = !!prev && !b.nlBefore && prev.text.indexOf('\n') < 0;
    const nextSameLine = !!next && !next.nlBefore && next.text.indexOf('\n') < 0;
    const embedded = leadSameLine && nextSameLine;
    if (_isQuotedTerm(b.text, leadSameLine && prev ? prev.text : '', nextSameLine, embedded, next ? next.text : '')) {
      out.push({ type: 'act', text: b.text, nlBefore: b.nlBefore, fromBare: b.fromBare });
    } else out.push(b);
  }
  return out;
}

// ---- 引号一直没闭合时，被吞进台词块的后续行多半是叙述 ----
// 模型漏写收尾引号（`林薇：「你先别问。\n她把手插回口袋。`），后面所有内容都会算进深色台词块
// ——用户报的"非对话内容也用了深色"里就有它。只把尾部**明确是叙述**的行拆出来（第三人称/
// 场景开头、且没有口语标记），多行台词（模型只忘了最后那个」）不受影响：上一行以句末标点
// 结束时本来就不该再往下接台词。
const NARR_TAIL = /^(?:他|她|它|祂|他们|她们|它们|祂们|教室|走廊|窗外|门外|门口|外面|屋里|房里|街上|路上|远处|四周|周围|空气|灯光|天色|阳光|月光|声音|人群|桌上|地面|墙角|楼下|楼上|气氛|场面|然后|接着|于是|随后)/;
const TAIL_SPEECH = /[我你您咱]|[？！…～]|[吧吗呢啊哦呀嘛](?:[。！？…]|$)/;

function _unswallowNarration(blocks: ScanBlock[], open: boolean): ScanBlock[] {
  if (!open || blocks.length === 0) return blocks;
  const out = blocks.slice();
  for (let guard = 0; guard < 20; guard++) {
    const last = out[out.length - 1];
    if (!last || last.type !== 'say' || last.fromBare) break;
    const cut = last.text.lastIndexOf('\n');
    if (cut < 0) break;
    const head = last.text.slice(0, cut);
    const tail = last.text.slice(cut + 1).trim();
    if (!/[。！？…」』”"]\s*$/.test(head)) break;          // 上一行没说完整 → 台词跨行，不动
    if (!tail || !NARR_TAIL.test(tail) || TAIL_SPEECH.test(tail)) break;
    last.text = head.replace(/\s+$/, '');
    out.push({ type: 'act', text: tail, nlBefore: true, fromBare: true });
  }
  return out;
}

// ---- 说话与非说话分段（2026-09-25 用户："说话的内容和非说话的内容要分段，不要直接连着"）----
// 台词块与非语言块相邻时，在非语言那一块前面另起一行（para）。以前两者直接连排——同一行里颜色
// 突然从深变淡，看着像染色出错。换行前把下一块开头的标点收进上一块（`「好」，她转身走了。` 不能让
// 「，」成为新行的第一个字——那是 1.5.97.36 用户报过的"标点成为一行的第一个"）。
const LEAD_PUNCT = /^[，。、；：！？…～,.!?;:）)\]】」』”"'’]+/;

function _segmentByType(blocks: BubbleBlock[]): BubbleBlock[] {
  const out: BubbleBlock[] = [];
  blocks.forEach(b => {
    const cur: BubbleBlock = { type: b.type, text: b.text };
    if (b.nlBefore) cur.nlBefore = true;
    if (b.para) cur.para = true;
    const prev = out[out.length - 1];
    if (prev && prev.type === cur.type) {
      prev.text += (cur.nlBefore ? '\n' : '') + cur.text;
      return;
    }
    if (prev && !cur.nlBefore) {
      const m = LEAD_PUNCT.exec(cur.text);
      if (m) { prev.text += m[0]; cur.text = cur.text.slice(m[0].length); }
      if (!cur.text) return;              // 只剩标点：并进上一块，不留空行
      cur.para = true;                    // 说话 / 非说话 → 分段
    }
    out.push(cur);
  });
  return out;
}

// ---- 漂移兜底 ②：没写说话人前缀的整行 → 另起旁白 ----
// 以前这类行一律并进上一个气泡，于是"模型忘写「白：」的环境/群像描写"被算在上一个角色头上
// （用户报的"旁白被放到上一个角色说的话的尾部"）。现在：只有确实属于上一个角色的续行才并，
// 其余另起一条旁白（淡色行，不带头像）。
function _splitToNarration(cur: { speaker: string | null; text: string }, line: string, bareIsSay: boolean): boolean {
  if (bareIsSay) return false;                                          // 作者输入按用户规则（裸文本=台词），不改
  if (cur.speaker === null || cur.speaker === NARRATOR) return false;    // 上一个就是旁白：继续并进去
  if (_scanRaw(cur.text, false).open) return false;                      // 台词/动作还没闭合（跨行）→ 必须延续
  const t = line.trim();
  if (!t) return false;
  if (/^(?:他|她|它|祂|他们|她们|它们|祂们)/.test(t)) return false;        // 紧接的「她/他…」多半是这个角色自己的动作
  if (cur.speaker && t.indexOf(cur.speaker) === 0) return false;         // 直接写角色名开头
  // 以引号开头的行是**台词**：模型常把「说话人：」单独写一行、后面每句台词一行且不带前缀
  // （`陈亦：` / `「我爸在楼下等着。」`）——这一行留在上一个说话人的气泡里，不能另起旁白行。
  // 真机实测（2026-09-25 commandcode 生成）：不认这一条时，一半台词会被拆进旁白行——
  // 没名字、没头像、按旁白样式显示（读者看不出是谁说的）。
  if (/^[「『“‘"]/.test(t)) return false;
  // 上一句还没写完（结尾不是句末标点）→ 这是折行，不是新的一条旁白：
  // 否则 `我点头。她` + `哦` + `了一声。` 会被拆成两半（用户 2026-09-25 反馈的"分段"）。
  // 收尾引号只在它前面已经有句末标点时才算句末（`「你来了。」` 算，`「哦」` 不算——那是引述的一声）。
  const tail = cur.text.replace(/\s+$/, '');
  const endsSentence = /[。！？…；!?;]$/.test(tail) || /[。！？…；!?;][」』”"]$/.test(tail);
  if (!endsSentence) return false;
  // 极短且没有句末标点的行同样是碎片（上一句已经收尾时也并回去）
  if (Array.from(t).length <= 3 && !/[。！？…；!?;]$/.test(t)) return false;
  if (/^[（(][\s\S]*[）)]$/.test(t)) return false;                       // （动作）
  if (/^\*[^*][\s\S]*\*$/.test(t)) return false;                        // *动作*
  // 只有**明确是叙述**的行才另起旁白：台词（疑问句、短回复）和拿不准的留在当前说话人气泡里，
  // 否则模型把「说话人：」写一行、后续不带前缀的台词也会被拆进旁白行
  return classifySentence(t, false) === 'act';
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
  roster.forEach(n => addNameKey(norm, n, n));
  // 别名（我/主角/user → 主角名）：同样登记小写键，模型写 User 也能落到同一个人
  const aliases = new Map<string, string>();
  const al = opts.aliases || {};
  Object.keys(al).forEach(k => { const t = String(al[k] || ''); if (t) addNameKey(aliases, k, t); });
  return { roster, norm, aliases };
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
    const body = cur.text.replace(/^\n+|\n+$/g, '');
    const scanned = _scanRaw(body, bareIsSay);
    // 引号里的内容不一定是台词（书名/标语/被强调的词…）+ 引号漏收尾时把尾部叙述拆出来：
    // 作者输入（bareIsSay）不做这两步——作者写引号就是台词，（）里的引号也不会成为台词块。
    const src: ScanBlock[] = bareIsSay
      ? scanned.blocks
      : _unswallowNarration(_demoteQuotedTerms(scanned.blocks), scanned.open);
    // 整轮里有没有**中文引号**（模型这一轮是否按格式给对白加引号）。只认「」『』“”：
    // 半角 " 常出现在正常叙述里（`最后一个"叶"的捺`），拿它当信号会把整轮判反。
    const roundQuoted = /[「」『』“”]/.test(text);
    // 漂移兜底①（**只在整轮一个引号都没有时**才用）：模型完全没按格式给对白加引号，只能逐句按内容猜台词。
    // 2026-09-25 用户要求「说话内容用「」、其他正常，然后按引号解析」+ 真机测算：整轮有引号时一律按引号
    // 分色（引号=台词、没引号=叙述）；否则"整条没有引号的叙述气泡"（主角第一人称叙述常常如此）会被
    // 内容启发式染深——实测 3 轮 362 句里有 64 句（≈18%）叙述被误染成台词色，这就是"分得不清楚"。
    const speechify = !bareIsSay && !!cur.speaker && cur.speaker !== NARRATOR
      && !roundQuoted;
    // 这个气泡的说话人就是第一人称叙述者（主角）吗？——决定"我…"的长句按叙述还是台词着色
    const narrBubble = !!opts.narrator && cur.speaker === opts.narrator;
    // 这条气泡是在回答上一个气泡的提问吗？（上一气泡是别人说的、末尾一句带疑问）
    // 漂移输出里"短回答"和"短叙述"形状一样，只有上下文能分开：提问后的短句按台词着色。
    let answering = false;
    const prevB = bubbles[bubbles.length - 1];
    if (prevB && prevB.speaker !== cur.speaker) {
      const ptxt = prevB.blocks.map(x => x.text).join('').trim();
      const lastSent = ptxt.split(/[。！？…\n]/).filter(s => s.trim()).pop() || '';
      answering = /[？?]/.test(ptxt) || hasInterrogative(lastSent);
    }
    const blocks: BubbleBlock[] = [];
    src.forEach(b => {
      const parts: BubbleBlock[] = (speechify && b.type === 'act' && b.fromBare)
        ? speechifyAct(b.text, b.nlBefore, narrBubble, answering, roundQuoted)
        : [{ type: b.type, text: b.text, nlBefore: b.nlBefore }];
      parts.forEach(p => {
        const last = blocks[blocks.length - 1];
        // 还原扫描器的"相邻同类型合并"（分色切出来之后仍要保持块数不膨胀）。
        // nlBefore 只记"这一块开头有没有换行"，合并进来的部分用文本里的 '\n' 表达（渲染层 nl2br）。
        if (last && last.type === p.type) last.text += (p.nlBefore ? '\n' : '') + p.text;
        else blocks.push({ type: p.type, text: p.text, nlBefore: p.nlBefore });
      });
    });
    // 说话与非说话分段（para）：台词块与非语言块之间另起一行，标点不收进行首
    const final = _segmentByType(blocks);
    if (final.length) bubbles.push({ speaker: cur.speaker, known: cur.known, blocks: final });
    cur = null;
  };
  for (const line of text.split('\n')) {
    const hit = matchSpeaker(line, roster, norm, aliases);
    if (hit) { flush(); cur = { speaker: hit.name, known: hit.known, text: hit.rest }; continue; }
    if (!cur) {
      cur = { speaker: def, known: def ? !!lookupName(norm, def) : false, text: '' };
    } else if (_splitToNarration(cur, line, bareIsSay)) {
      // 漂移兜底②：模型忘写前缀的旁白另起一条，不再粘进上一个角色的气泡尾部
      flush();
      cur = { speaker: null, known: false, text: '' };
    }
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
  // "台词没加引号"用**原文直接扫一遍**判定（引号里的字数占比）——不能看解析结果：
  // 现在裸文本的角色气泡会把台词兜底染成 say，从结果反推就永远看不到这个信号了。
  let quotedChars = 0, rawChars = 0;
  try {
    _scanRaw(text, false).blocks.forEach(bl => {
      const n = bl.text.replace(/\s/g, '').length;
      rawChars += n;
      if (bl.type === 'say' && !bl.fromBare) quotedChars += n;
    });
  } catch (e) { /* 诊断失败不影响其它信号 */ }
  if (rep.bubbles >= 4 && total0 > 0 && rawChars > 0 && quotedChars < rawChars * 0.03) {
    rep.notes.push('台词未加引号（已按内容自动分色，可能不完全准）');
  }
  if (total0 > 0 && rep.fallbackChars > total0 * 0.5) rep.notes.push('格式漂移（过半内容没有说话人前缀）');
  if (roster.length) {
    const { norm, aliases } = prepare(opts);
    // 「白」是旁白标记不是角色；别名命中的（我→主角）也不算名单外
    const stray = rep.speakers.filter(s => s !== NARRATOR && !lookupName(norm, s) && !lookupName(aliases, s));
    if (stray.length > 0) rep.notes.push('名单外说话人：' + stray.join('、'));
  }
  return rep;
}

export default { parseBubbles, analyzeParse, normalizeSpeakerName, stripSpeakerPrefixes, NARRATOR };
