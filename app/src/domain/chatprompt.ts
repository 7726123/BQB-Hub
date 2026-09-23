// 对话模式的提示词块（与 lib/bubble.ts 的解析器成对：改格式块必须同步改解析器/测试）。
// 刻意不做成用户可编辑的预设模块——格式块被改坏，整个模式的渲染就废了。
// 注入位置：预设模块之后、世界书之前（稳定前缀区；只在设置变化时变，不影响 prompt 缓存命中）。

export const CHAT_BLOCK_VERSION = 1;

export interface ChatBlockOpts {
  roster: string[];        // 角色名单（世界书「角色」条目名 + 主角名）
  protagonist?: string;    // 主角名（可为空）
  lengthWords?: number | string;  // 预设「字数」模块要求的字数（只写数字，避免与模块正文重复注入）
}

// 角色名单：世界书「角色」条目名 + 主角名（去重、保持书内顺序）
export function chatRoster(entries: Array<{ type?: string; name?: string }> | null | undefined, protagonistName?: string): string[] {
  const out: string[] = [];
  const push = (n: string) => { const s = String(n || '').trim(); if (s && out.indexOf(s) < 0) out.push(s); };
  (entries || []).forEach(e => { if (e && e.type === '角色') push(e.name || ''); });
  push(protagonistName || '');
  return out;
}

// 注：文案里的 {{}} 是给调用方做替换的占位符，不是模板引擎。
export function chatFormatBlock(o: ChatBlockOpts): string {
  const roster = (o.roster || []).filter(Boolean);
  const nameList = roster.length > 0 ? roster.join('、') : '（当前世界书还没有角色条目，用到谁就写谁的名字）';
  const prot = String(o.protagonist || '').trim();
  // 长度完全由预设决定：预设写了字数就按它（并在用户消息末尾重申一次，实测能明显提高命中率）；
  // 预设没写字数就**不注入任何数字**，只要求把场面演完、别一句就收（用户要求：字数不要由软件定）。
  const n = Number(o.lengthWords);
  const hasLen = Number.isFinite(n) && n > 0;
  const lenSection = hasLen
    ? `【长度（硬要求，优先于"把场面收住"）】
- 本次输出约 ${n} 字：写到字数再收尾，中途不要提前把场面收住。
- 同一个气泡里可以有不止一句话：连续几句台词、台词加动作，都放在一个气泡里。
- 字数不够就继续往下演（下一句话、下一个动作），不要用总结、复述、大段心理独白注水。`
    : `【长度】
- 篇幅按预设要求；预设没有规定时，把这个场面自然演完：不要一句就收，也不用废话凑数。`;

  return `# 对话演出（本模式唯一的输出格式）

这个模式把故事演成一段聊天记录：读者看到的是一条条气泡，一条气泡 = 某个角色在某个瞬间说的话和做的事。

【格式】
1. 每个气泡另起一行，行首写「说话人：」。说话人只能从这份名单里取：${nameList}
   叙述、环境、没有明确说话人的独白，说话人写「白」。
2. 台词一律用「」包住。
3. 动作、表情、语气、心理、环境描写直接写，不加任何符号；和台词写在同一行或紧邻几行都可以。
4. 一个气泡里可以既有台词又有描写，顺序按实际发生的样子来。
5. 不写章节标题、不写序号、不用 markdown（\`**加粗**\`、#、- 列表都不写）、不写「（未完待续）」这类提示。
6. 不解释、不总结、不预告后文，不在结尾点评自己刚写的内容。

【这一轮怎么演】
- 一轮要演出**多个来回**：你来我往至少三轮，再停在有推进的地方；不要一问一答就收，字数没写够更不要提前收尾。
${prot ? '- 主角（' + prot + '）由你照常演：可以说、可以做、可以有心理活动——作者只给方向，具体怎么写是你的活儿。' : '- 主角由你照常演：可以说、可以做、可以有心理活动——作者只给方向，具体怎么写是你的活儿。'}
- 作者偶尔会以第一人称发来一句台词或一个动作，那是**已经发生**的事：接着往下演，不要复述同一句话，也不要把它当成新的要求去解释。

【白尽量少，主角写厚】
- 白只用在画面、环境、群像这些归不到任何角色身上的地方；能落到某个角色身上的，不要给白。整轮白不超过 2～3 条。
- 第一人称的所见、所感、所想（"我把练习册合上""我盯着那道折痕"）都是主角本人的，写进主角自己的气泡里。
- 主角的气泡要写厚：一句台词可以带两三句心理或动作，不要只说一句就换人。
- 别人的心理只写从表情、动作、语气上看得出来的部分，不写全知判断。

${lenSection}`;
}

export default { chatFormatBlock, chatRoster, CHAT_BLOCK_VERSION };
