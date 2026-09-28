// 真实模式的提示词与契约（纯文本 + 结构化块解析，全部可单测）。
// 两条调用、两张契约：
//   · 公共调用（场记）：只看公共数据 → <场记>（时间/地点/在场/公共事件/旁白/纪要/接话），
//     作者这句是悄悄话时再加 可感 / 壳 两行；
//   · 角色调用（本轮唯一说话人）：只看该角色可感的材料 → 旁白/动作/台词 + <内心>（可选），
//     私下说话时自己声明 <私下 只说给="…"> 并给一行 <壳>。
// 解析只读"它按合同写出来的结构化块"，不是猜语义（用户明确否掉了本地正则判断）。
import type { RealRecord, RealScene, RealShell, RealSliceItem } from './realstate';

export interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

/** 一个在场角色给公共调用看的公开人设（截断到一句话） */
function personaOneLine(content: string, max = 60): string {
  const s = String(content || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

export const PUBLIC_SYSTEM =
  '你是这场多人剧情的「场记」。你只看公共信息（场景、纪要、最近发生的事、作者的输入），负责四件事，' +
  '**不要写任何角色的台词、动作或内心**：\n' +
  '1. 维护公共事实：时间、地点、在场名单（谁进场、谁离场）、大家都看得到的新动静。' +
  '**没有新事实就写「无」**——不要为了凑内容去描写光线、声音、天气这类没有变化的东西；' +
  '**公共事件和旁白都不是每轮必填：多数轮次应该只有对话**（公共事件=无、旁白留空）；' +
  '**不要复述角色刚说过的话或刚做过的动作**（软件已经记进去了），也不要原样重复作者的旁白；' +
  '**开场（在场还空着）由你定**：自己定时间、地点、先在场的人，从名单里挑，不要问作者要设定；\n' +
  '2. 维护纪要：把刚发生的事并进「剧情纪要」（≤300 字，只写客观发生了什么；' +
  '**悄悄话的内容一律不许写进纪要和公共事件**——只写「两人低声交谈了一会儿」这类外部现象）；\n' +
  '3. 判定可感范围：作者这一条如果是悄悄话（只对某个人说），给出「可感」名单和「壳」' +
  '（其他人看到的样子，一句话，**不许泄漏内容**）；不是悄悄话就不写这两行；\n' +
  '4. 选人：**优先让角色开口**——场合里有人就该有人说话，从「角色名单」里挑 0 或 1 个此刻最该接话的角色' +
  '（名单里有谁就只能选谁）；只有确实没人可说（纯粹的时间流逝、场景转换）才写「旁白」，**不要连着两轮都写旁白**。\n\n' +
  '只输出下面这一块，不要任何解释或其它文字：\n' +
  '<场记>\n时间：\n地点：\n在场：（顿号分隔）\n' +
  '公共事件：（0–2 条，**没有新事实就写「无」**；只写任何在场者都能看到/听到的**新**动静）\n' +
  '旁白：（**多数轮次留空**——只在场景/时间变了、或确实需要交代一句环境时才写，≤2 句；没有就不写这一行）\n' +
  '纪要：（一句话，把刚发生的事并进纪要）\n接话：（在场角色名，或「旁白」）\n' +
  '可感：（可选，只有这件事的悄悄话才写：只有谁能听到，顿号分隔）\n' +
  '壳：（可选，写「可感」时一起写：其他人看到的样子，一句话，不泄漏内容）\n' +
  '</场记>';

export const ROLE_SYSTEM =
  '你只扮演一个人，别的人由别的轮次负责。你**只知道**下面给你的材料；材料里没有写的事，你就是不知道——' +
  '不要用"常识"或"剧情需要"替自己补，也不要提别人的内心。你可以误会、可以记错（这很正常、很真实），' +
  '但不能凭空知道你没法知道的事。不要替别人说话、不要替别人做决定、不要描写别人的内心。';

/** 场记的思考纪律：作为**最后一条** system 消息钉在生成点前（实测 low 档也能写到一两千字思考） */
export const PUBLIC_THINK_DISCIPLINE =
  '【思考纪律】只做一遍判断：谁在场 → 有没有新事实 → 该谁接话，然后直接给 <场记> 块。' +
  '不要复述场景、不要预写旁白草稿、不要在两种结论之间来回改；**思考几十个字就够**' +
  '（一旦开始想"要不要再确认一下"就是在浪费长度）。';

export interface PublicCtx {
  scene: RealScene;
  summary: string;
  recent: string;
  input: string;
  /** empty = 作者没发言（推进）；line = 作者以扮演者身份说的话；narration = 作者旁白推进；direct = 作者指定谁接话 */
  inputKind: 'empty' | 'line' | 'narration' | 'direct';
  roster: { name: string; persona: string }[];
  /** 作者正在扮演的角色：选人时要排除 TA（软件不能替作者说话） */
  player?: string;
  /** 上一轮只有旁白、没人说话 → 提示场记这一轮让角色开口（别一直推进不对话） */
  lastWasNarration?: boolean;
}

export function buildPublicMessages(ctx: PublicCtx): Msg[] {
  const sc = ctx.scene || { time: '', place: '', present: [] };
  // 顺序按"缓存能命中的共同前缀"排：很少变的名单在最前，append-only 的最近发生在中间，
  // 每轮都变的纪要/场景和最末的作者输入放最后（前缀一变，后面的缓存就全废）。
  const lines: string[] = [];
  lines.push('## 角色名单（选人只能从这里挑；在场由你维护）');
  (ctx.roster || []).forEach(function (r) {
    lines.push('- ' + r.name + (r.persona ? '：' + r.persona : ''));
  });
  if (ctx.player) {
    lines.push('（作者正在扮演「' + ctx.player + '」——接话不要填 TA：TA 的言行由作者自己写。）');
  }
  lines.push('## 最近发生（按时间先后，越靠后越近）');
  lines.push(String(ctx.recent || '').trim() || '（还没有发生什么）');
  lines.push('## 剧情纪要');
  lines.push(String(ctx.summary || '').trim() || '（还没有）');
  lines.push('## 当前场景');
  lines.push('时间：' + (sc.time || '（未设定）') + '｜地点：' + (sc.place || '（未设定）'));
  lines.push('在场：' + ((sc.present && sc.present.length) ? sc.present.join('、') : '（还没定——由你定开场：从上面的名单里挑此刻在场的人）'));
  lines.push('## 作者这一次的输入');
  if (ctx.lastWasNarration) {
    lines.push('（上一轮只有旁白推进、没有人说话：这一轮请让某个角色开口——除非确实没人可说）');
  }
  if (ctx.inputKind === 'empty' || !String(ctx.input || '').trim()) {
    lines.push('（作者没有发言：请推进剧情——让时间流逝、环境变化，或让某个角色主动做点什么）');
  } else if (ctx.inputKind === 'narration') {
    lines.push('（作者以「旁白」推进剧情，这是客观发生的事实，所有人都看得到）：' + ctx.input);
  } else if (ctx.inputKind === 'direct') {
    lines.push('（作者指定接话人）：' + ctx.input);
  } else {
    lines.push('（作者以扮演者的身份说了下面这句；若这是只说给某人的悄悄话，请给出可感与壳）：' + ctx.input);
  }
  return [{ role: 'system', content: PUBLIC_SYSTEM + '\n\n' + PUBLIC_THINK_DISCIPLINE }, { role: 'user', content: lines.join('\n') }];
}

export interface RoleCtx {
  name: string;
  persona: string;
  initial: string;
  memory: string;
  /** 在场者人人一致的经过（公开记录剥内心 + 私下记录的壳）—— 排在最前，跨角色共用同一段前缀 */
  shared: string;
  /** 只有他知道的（他被点名听到的私下记录） */
  extra: string;
  scene: RealScene;
  others: { name: string; persona: string }[];
}

/** 顺序按"缓存命中的共同前缀"排：固定契约（system）→ 共同经历 → 他的私有 → 易变的场景/在场 */
export function buildRoleMessages(ctx: RoleCtx): Msg[] {
  const sc = ctx.scene || { time: '', place: '', present: [] };
  const rules: string[] = [];
  rules.push('## 输出要求（固定契约，每轮都一样）');
  rules.push('- 环境没变化就**不用写旁白**（多数轮次直接进动作/台词）；只在场景或时间变了、或有值得注意的动静时写 0–2 句，每行以「旁白：」开头——只写任何在场的人都观察得到的东西，不要写别人的内心；');
  rules.push('- 动作、神态、心理**直接写，不加括号也不加主语**：写成「把书包放下，瞥了眼窗外」这样；'
    + '**不要写「（我…）」也不要加「（）」**，更不要写自己的名字（「悠真…」同样不要）。'
    + '说出口的话一律用「」包住（含「嗯。」这类单字）；引号内该用「我」照常用。不要写「名：」这种说话人前缀（软件知道你是谁）。');
  rules.push('- 只有你自己知道的心理活动放进 <内心>…</内心>（读者看得到，戏里别的人看不到）：**尽量写一句**——多数轮次都有值得记的心里话；确实没有就不写；');
  rules.push('- 如果这一轮你是低声/私下对某人说话（旁人听不到），第一行单独写 <私下 只说给="对方名字">，再给一行 <壳>其他人看到的样子</壳>（一句话，不要泄漏内容）；');
  rules.push('- **这一轮只写你自己的言行**：别人的台词、动作、心里话都不要写（哪怕他们在场、哪怕是预设要求的"群像演出/每个角色都开口"——这条优先于预设）。');
  const user: string[] = [];
  user.push('## 共同经历（在场的人都经历过，按时间先后；你不在场的时候对你是空白的）');
  user.push(String(ctx.shared || '').trim() || '（还没有值得记住的事）');
  if (String(ctx.extra || '').trim()) {
    user.push('## 只有你知道的（别人没听到/没看到）');
    user.push(String(ctx.extra).trim());
  }
  user.push('## 你是谁（公开人设）');
  user.push(String(ctx.persona || '').trim() || '（世界书里还没写这个人）');
  if (String(ctx.initial || '').trim()) {
    user.push('## 你的初始记忆（只有你知道）');
    user.push(String(ctx.initial).trim());
  }
  if (String(ctx.memory || '').trim()) {
    user.push('## 你记得的往事（你自己的印象，可能不准）');
    user.push(String(ctx.memory).trim());
  }
  user.push('## 当前场景（每轮可能在变）');
  user.push('时间：' + (sc.time || '（未设定）') + '｜地点：' + (sc.place || '（未设定）') + '｜在场：' + ((sc.present || []).join('、') || '（空）'));
  if ((ctx.others || []).length) {
    user.push('## 在场的人（你能看到的）');
    ctx.others.forEach(function (o) { user.push('- ' + o.name + (o.persona ? '：' + o.persona : '')); });
  }
  return [{ role: 'system', content: ROLE_SYSTEM + '\n\n' + rules.join('\n') }, { role: 'user', content: user.join('\n') }];
}

/** 该角色的视角切片 → 注入文本（【谁】…；降级的壳标成「只看到/听到」） */
export function formatSlice(items: RealSliceItem[]): string {
  if (!items || !items.length) return '';
  return items.map(function (it) {
    const who = it.degraded ? '只看到/听到' : (it.speaker || '旁白');
    return '【' + who + '】' + String(it.text || '').replace(/\n/g, '\n    ');
  }).join('\n');
}

/**
 * 公共调用看的"最近发生"：**私下记录的原文不进这里**（只说给某人听的话，公共侧只该知道"发生过这么一回事"）
 * ——不是悄悄话的记录照原样给。这是"物理隔离"在公共侧的那一半。
 */
export function formatPublicRecent(log: RealRecord[], limit = 40): string {
  const rows = (log || []).slice(-limit);
  return rows.map(function (r) {
    const who = r.kind === 'scene' ? '旁白' : (r.speaker || '旁白');
    const priv = Array.isArray(r.heard) && r.heard.length > 0;
    const text = priv
      ? (shellTextOf(r.shell) || '（低声说了些什么）')
      : String(r.raw || '').replace(/<\s*内心\s*>[\s\S]*?<\s*\/\s*内心\s*>/gi, '').replace(/\s+/g, ' ').slice(0, 200);
    return '【' + who + '】' + text;
  }).join('\n');
}

function shellTextOf(shell?: RealShell): string {
  if (!shell) return '';
  return [shell.see, shell.hear].filter(Boolean).join(' ').trim();
}

// ---------- 结构化块解析 ----------

/** 取出所有 <tag>…</tag> 的内容，并返回去掉这些块之后的正文 */
export function extractBlocks(raw: string, tag: string): { blocks: string[]; rest: string } {
  const s = String(raw == null ? '' : raw);
  const re = new RegExp('<\\s*' + tag + '\\s*>([\\s\\S]*?)<\\s*\\/\\s*' + tag + '\\s*>', 'gi');
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) blocks.push(m[1]);
  const rest = s.replace(new RegExp('<\\s*' + tag + '\\s*>[\\s\\S]*?<\\s*\\/\\s*' + tag + '\\s*>', 'gi'), '');
  return { blocks: blocks, rest: rest };
}

/** 从"名称：值"行读一个字段（支持「- 」或缩进的续行） */
export function readField(block: string, names: string[]): string {
  const lines = String(block || '').split('\n');
  const head = new RegExp('^\\s*[-*•]?\\s*[（(]?\\s*(?:' + names.join('|') + ')\\s*[）)]?\\s*[:：]\\s*([\\s\\S]*)$');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(head);
    if (!m) continue;
    const parts: string[] = [];
    if (String(m[1] || '').trim()) parts.push(String(m[1]).trim());
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim()) break;
      if (head.test(l)) break;
      if (!/^\s*[-*•\u00b7]/.test(l)) break;   // 只认「- 」或缩进的续行，避免把下一个字段吞进来
      parts.push(l.replace(/^\s*[-*•\u00b7]\s*/, '').trim());
    }
    return parts.join('\n').trim();
  }
  return '';
}

/** 「甲、乙，丙 丁」→ ['甲','乙','丙','丁'] */
export function splitNames(s: string): string[] {
  const out: string[] = [];
  String(s || '').split(/[、,，;；\/\s]+/).forEach(function (x) {
    const v = String(x || '').replace(/^[（(]|[）)]$/g, '').trim();
    if (v && v !== '无' && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

export interface PublicReply {
  time?: string; place?: string; present?: string[]; events?: string; narration?: string;
  summary?: string; next?: string; heard?: string[]; shell?: RealShell;
}

const PUBLIC_LABELS = ['时间', '地点', '在场', '公共事件', '旁白', '纪要', '接话', '可感', '壳'];

/**
 * 读场记那一块。**容错优先**（用户实测"场记经常不按合同回"）：模型不一定规矩地写 `<场记>…</场记>`，
 * 所以依次认：`<场记 属性>` / 全角＜＞ / 【场记】…【/场记】 / 干脆没有容器（整段按字段标签读，
 * 至少要认出 2 个字段才认账，免得把闲聊当账本）。
 */
function readPublicBlock(raw: string): string {
  const text = String(raw == null ? '' : raw).replace(/＜/g, '<').replace(/＞/g, '>');
  const t1 = text.match(/<\s*场记[^>]*>([\s\S]*?)<\s*\/\s*场记\s*>/i);
  if (t1 && t1[1].trim()) return t1[1];
  const t2 = text.match(/【\s*场记\s*】([\s\S]*?)【\s*\/\s*场记\s*】/);
  if (t2 && t2[1].trim()) return t2[1];
  const t3 = text.match(/\[\s*场记\s*\]([\s\S]*?)\[\s*\/\s*场记\s*\]/);
  if (t3 && t3[1].trim()) return t3[1];
  const hits = PUBLIC_LABELS.filter(function (k) {
    return new RegExp('^\\s*[-*•]?\\s*[（(]?\\s*' + k + '\\s*[）)]?\\s*[:：]', 'm').test(text);
  });
  return hits.length >= 2 ? text : '';
}

export function parsePublicReply(raw: string): PublicReply | null {
  const block = readPublicBlock(raw);
  if (!block || !block.trim()) return null;
  const out: PublicReply = {};
  const time = readField(block, ['时间']); if (time) out.time = time;
  const place = readField(block, ['地点']); if (place) out.place = place;
  const present = readField(block, ['在场']); if (present) out.present = splitNames(present);
  const events = readField(block, ['公共事件']);
  if (events && !/^[（(]?\s*无\s*[）)]?$/.test(events)) out.events = events;
  const narration = readField(block, ['旁白']); if (narration) out.narration = narration;
  const summary = readField(block, ['纪要']); if (summary) out.summary = summary;
  const next = readField(block, ['接话', '下一步', '下一个']);
  if (next) out.next = next.replace(/^[「『"']|[」』"']$/g, '').trim();
  const heard = readField(block, ['可感', '可感知', '只有谁']);
  if (heard) out.heard = splitNames(heard);
  const shell = readField(block, ['壳']);
  if (shell) out.shell = { hear: shell };
  return out;
}

/** 压缩回忆（远期记忆）的契约：一次只处理一个角色 */
export const MEMORY_SYSTEM =
  '你在帮一个角色整理"自己的记忆"。你只处理这一个角色的材料，不要替别人想、不要引入材料里没有的事。' +
  '把给你的旧回忆与后来的经过合并成一段第一人称的回忆：**≤250 字**，只留对以后有用的——' +
  '人、关系、你在意的事、答应过的事、没弄明白的事。丢掉流水账、场景描写和已经不重要的小事。' +
  '只输出这一段回忆本身：不要标题、不要分点、不要解释、不要引号。';

export interface MemoryCtx { name: string; oldMemory: string; recent: string }

export function buildMemoryMessages(ctx: MemoryCtx): Msg[] {
  const lines: string[] = [];
  lines.push('## 你是谁');
  lines.push(String(ctx.name || ''));
  lines.push('## 你原来记得的（你自己的印象，可能不准）');
  lines.push(String(ctx.oldMemory || '').trim() || '（还什么都记不清）');
  lines.push('## 后来你又经历的（按时间先后）');
  lines.push(String(ctx.recent || '').trim());
  lines.push('把上面两部分合并成一段 ≤250 字的第一人称回忆，从现在开始第一人称写。');
  return [{ role: 'system', content: MEMORY_SYSTEM }, { role: 'user', content: lines.join('\n') }];
}

/** 压缩结果的清洗：去掉模型爱加的代码块围栏与包裹引号（不裁字） */
export function cleanMemory(raw: string): string {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  s = s.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim();
  return s;
}

export interface RoleReply { text: string; heard?: string[]; shell?: RealShell }

/** 角色回复：剥掉 <私下>/<壳>（标记与元数据），<内心> 留在正文里（渲染层负责显示） */
export function parseRoleReply(raw: string, speaker: string): RoleReply {
  let s = String(raw == null ? '' : raw).replace(/\r\n?/g, '\n');
  let heard: string[] | undefined;
  const priv = s.match(/<\s*私下[^>]*>/i);
  if (priv) {
    const m = String(priv[0] || '').match(/只说给\s*[=:：]\s*["'「]?([^"'」>]*)/);
    const names = m ? splitNames(m[1]) : [];
    if (names.length) heard = names.indexOf(speaker) >= 0 ? names : names.concat([speaker]);
  }
  const shellB = extractBlocks(s, '壳');
  s = shellB.rest;
  const shell: RealShell | undefined = shellB.blocks.length && shellB.blocks[0].trim()
    ? { hear: shellB.blocks[0].trim() } : undefined;
  s = s.replace(/<\s*私下[^>]*>/gi, '').trim();
  return { text: s, heard: heard, shell: shell };
}
