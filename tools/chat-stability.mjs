// 对话模式「格式稳定性」本地测试（用户要求：先在本地跑完，发版后再由用户实测）。
//
// 做法：用**真实的**格式块（app/src/domain/chatprompt.ts）与**真实的**解析器（app/src/lib/bubble.ts），
// 加上从预设源码里抽出的真实模块文本（视角 / 反 AI 味 / 字数），组一份接近线上形态的提示词，
// 对同一场景跑多个变体 × 两个字数档位，用解析器量化"模型输出能不能稳定变成气泡"。
//
// 用法（API key 只从环境变量读，不写进任何文件、不打印）：
//   CHAT_TEST_KEY=... node tools/chat-stability.mjs --lengths 1000,2500 --variants v1,v2 --runs 1
//   CHAT_TEST_KEY=... node tools/chat-stability.mjs --dry          # 只打印组好的提示词，不调 API
// 产物：原始输出落在 workspace 的 .zcode/chat-stability/ 下（不进仓库），供人工挑选做成测试 fixture。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const ROOT = 'C:/Users/a7726/BQB Hub';
const OUT_DIR = 'C:/Users/a7726/.zcode/workspace/default/.zcode/chat-stability';
const TMP_DIR = path.join(OUT_DIR, 'build');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const hasFlag = (name) => argv.includes('--' + name);
const DRY = hasFlag('dry');
const LENGTHS = String(arg('lengths', '1000,2500')).split(',').map(s => s.trim()).filter(Boolean);
const VARIANTS = String(arg('variants', 'v1,v2')).split(',').map(s => s.trim()).filter(Boolean);
const RUNS = Number(arg('runs', '1')) || 1;
const SUFFIX = String(arg('suffix', ''));
const EXTRA_BODY = (() => { try { return JSON.parse(String(arg('body', '{}'))); } catch (e) { return {}; } })();
const BASE = process.env.CHAT_TEST_BASE || 'https://api.commandcode.ai/provider/v1';
const MODEL = process.env.CHAT_TEST_MODEL || 'deepseek/deepseek-v4.1-flash';
const KEY = process.env.CHAT_TEST_KEY || '';

// ---- 1) 用 esbuild 把真实的解析器 / 格式块打成一个 ESM 包再 import（TS 直跑不了）----
async function loadReal() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const require = createRequire(path.join(ROOT, 'app', 'package.json'));
  const esbuild = require('esbuild');
  const entry = path.join(TMP_DIR, 'entry.ts');
  const fwd = (p) => p.replace(/\\/g, '/');
  fs.writeFileSync(entry, [
    `export { parseBubbles, analyzeParse } from '${fwd(path.join(ROOT, 'app/src/lib/bubble'))}';`,
    `export { chatFormatBlock } from '${fwd(path.join(ROOT, 'app/src/domain/chatprompt'))}';`,
  ].join('\n'), 'utf8');
  const out = path.join(TMP_DIR, 'bundle.mjs');
  await esbuild.build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' });
  return import(pathToFileURL(out).href + '?t=' + Date.now());
}

// ---- 2) 从预设源码里抽真实模块文本（不 import preset.ts：它链到 storage，Node 里没有 DOM）----
function presetModule(id) {
  const src = fs.readFileSync(path.join(ROOT, 'app/src/domain/preset.ts'), 'utf8');
  const i = src.indexOf(`id: '${id}'`);
  if (i < 0) throw new Error('预设模块找不到: ' + id);
  const c = src.indexOf('content: `', i);
  if (c < 0) throw new Error('模块没有 content 模板串: ' + id);
  const start = c + 'content: `'.length;
  const end = src.indexOf('`', start);
  return src.slice(start, end);
}

const POV = presetModule('min_09_pov_1');
const ANTI_AI = presetModule('min_20_ai_flavor');
const CTRL = presetModule('min_14_ctrl_free');
const COT = presetModule('min_18_cot_full');
const LEN_MODULE = { '1000': presetModule('min_15_len_1000'), '2500': presetModule('min_17_len_2500') };

// ---- 3) 测试用的世界书与场景（短、可控：三个角色 + 一个主角）----
const ENTRIES = [
  { type: '角色', name: '林薇', content: '高三（2）班学生，学生会副会长。说话直接、不绕弯子，讨厌被同情。怕黑，晚上不敢一个人走空教室走廊。对陈亦的态度比对别人软一点，但从不承认。' },
  { type: '角色', name: '陈亦', content: '高三（2）班学生，主角的同桌。话少，被人搭话常常只回一两个字。会弹吉他，午休偶尔去天台。最近一个月放学后总是先走。' },
  { type: '角色', name: '苏老师', content: '高三（2）班班主任，三十多岁，嘴上严厉，遇到学生真出事时先护学生。习惯用"我们班"开头说话。' },
  { type: '世界观', name: '学校与天台', content: '临江市第三中学，教学楼五层，天台平时锁着，只有体育器材室旁边那扇门没锁。十月，傍晚六点半开始天黑。' },
];
const PROTAGONIST = '林叶';
const ROSTER = ENTRIES.filter(e => e.type === '角色').map(e => e.name).concat([PROTAGONIST]);
const SCENE = [
  '【当前场景】放学后的教室，只剩几个人。林薇把一封信放在林叶桌上，信封上写着林叶的名字，字迹不是她的。',
  '【这一轮要演的】演到林薇说出她为什么替别人送这封信（她其实不愿意，但答应了别人），停在林叶还没回答的地方。',
  '【人物状态】林薇今天没背书包来教室，是空手进来的；陈亦的座位已经空了。',
].join('\n');

const worldbookBlock = '# 世界书\n' + ENTRIES.map(e => `【${e.type}】${e.name}\n${e.content}`).join('\n\n');

const FEWSHOT = `# 格式示例（只学格式，不要照抄内容）

林薇：「你怎么才来。」
*她把信往桌上一推，指尖在信封上停了一下。*
林叶：「路上被苏老师叫住了。」
白：*窗外最后一点天光落在空着的后排座位上。*
林薇：「那你现在看吧，看完告诉我。」
*她转过身，背对着他。*`;

// 说明："白尽量少/主角写厚"这条规则 2026-09-24 已固化进 chatprompt.ts 的格式块（实测：白 64.3%→7.3% 字数、主角气泡 7.4%→41.4%），这里不再重复注入。

function buildSystem(real, variant, length) {
  // 模块顺序照预设的 order（反 AI 味 8 → 视角 9 → 主控权 14 → 字数 15）
  const parts = [ANTI_AI, POV];
  if (variant === 'v3' || variant === 'v4') parts.push(CTRL);
  if (variant === 'v4') parts.push(COT);
  parts.push(LEN_MODULE[length]);
  parts.push(worldbookBlock);
  const fmt = real.chatFormatBlock({ roster: ROSTER, protagonist: PROTAGONIST, lengthWords: length });
  if (variant === 'v1') parts.push(fmt);
  else parts.push(fmt + '\n\n' + FEWSHOT);
  return parts.join('\n\n');
}

// ---- 4) 调 API ----
async function callApi(system, user) {
  const t0 = Date.now();
  const res = await fetch(BASE.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify(Object.assign({ model: MODEL, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0.8, max_tokens: 12000, stream: false }, EXTRA_BODY)),
  });
  const ms = Date.now() - t0;
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + text.slice(0, 400));
  const j = JSON.parse(text);
  const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
  return { content: String(msg.content || ''), reasoning: String(msg.reasoning || ''), usage: j.usage || {}, ms, finish: (j.choices && j.choices[0] && j.choices[0].finish_reason) || '' };
}

const pad = (s, n) => { const str = String(s); let w = 0; for (const ch of str) w += /[\u4e00-\u9fa5\uff00-\uffef]/.test(ch) ? 2 : 1; return str + ' '.repeat(Math.max(0, n - w)); };

(async () => {
  const real = await loadReal();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // --reparse：只对已存档的真实输出重跑解析（改解析器后用，不花 API 钱）
  if (hasFlag('reparse')) {
    const files = fs.readdirSync(OUT_DIR).filter(f => /\.txt$/.test(f)).sort();
    console.log('重解析 ' + files.length + ' 个存档输出（名单 ' + ROSTER.join('/') + '）\n');
    for (const f of files) {
      const raw = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
      const rep = real.analyzeParse(raw, { roster: ROSTER, defaultSpeaker: null, aliases: { '我': PROTAGONIST } });
      const chars = rep.sayChars + rep.actChars;
      const tag = f.replace(/^[\dT-]+/, '').replace(/\.txt$/, '');
      console.log(pad(tag, 14) + `字数=${chars} 气泡=${rep.bubbles} 台词=${rep.sayChars} 非语言=${rep.actChars} 兜底=${rep.fallbackChars}` + (rep.notes.length ? '  问题: ' + rep.notes.join('、') : ''));
    }
    return;
  }
  // --stats：按说话人拆解（气泡数 / 字数 / 台词 vs 非语言 / 气泡长度分布 / 旁白占比）
  if (hasFlag('stats')) {
    const match = String(arg('match', ''));
    const files = fs.readdirSync(OUT_DIR).filter(f => /\.txt$/.test(f) && f.includes(match)).sort();
    const agg = new Map();
    const hist = [0, 0, 0, 0, 0];   // ≤10 / 11-20 / 21-40 / 41-80 / >80 字
    let totB = 0, totSay = 0, totAct = 0, narrB = 0, narrC = 0, totC = 0;
    for (const f of files) {
      const raw = fs.readFileSync(path.join(OUT_DIR, f), 'utf8');
      if (!raw.trim()) continue;
      const bubbles = real.parseBubbles(raw, { roster: ROSTER, defaultSpeaker: null, aliases: { '我': PROTAGONIST } });
      bubbles.forEach(b => {
        const say = b.blocks.filter(x => x.type === 'say').reduce((n, x) => n + x.text.length, 0);
        const act = b.blocks.filter(x => x.type === 'act').reduce((n, x) => n + x.text.length, 0);
        const c = say + act;
        const key = b.speaker === null ? '(无前缀→白)' : b.speaker;
        const cur = agg.get(key) || { b: 0, say: 0, act: 0 };
        cur.b++; cur.say += say; cur.act += act; agg.set(key, cur);
        totB++; totSay += say; totAct += act; totC += c;
        if (b.speaker === null || b.speaker === '白') { narrB++; narrC += c; }
        hist[c <= 10 ? 0 : c <= 20 ? 1 : c <= 40 ? 2 : c <= 80 ? 3 : 4]++;
      });
    }
    console.log('文件 ' + files.length + ' 个（match=' + (match || '全部') + '）；气泡 ' + totB + ' 个、合计 ' + totC + ' 字、平均 ' + (totB ? (totC / totB).toFixed(1) : 0) + ' 字/气泡\n');
    console.log(pad('说话人', 14) + pad('气泡', 6) + pad('气泡占比', 10) + pad('字数', 8) + pad('字数占比', 10) + pad('台词', 8) + '非语言');
    [...agg.entries()].sort((a, b) => (b[1].say + b[1].act) - (a[1].say + a[1].act)).forEach(([k, v]) => {
      const c = v.say + v.act;
      console.log(pad(k, 14) + pad(v.b, 6) + pad((v.b / totB * 100).toFixed(1) + '%', 10) + pad(c, 8) + pad((c / totC * 100).toFixed(1) + '%', 10) + pad(v.say, 8) + v.act);
    });
    console.log('\n旁白（白 + 无前缀）：' + narrB + ' 个气泡（' + (narrB / totB * 100).toFixed(1) + '%）、' + narrC + ' 字（' + (narrC / totC * 100).toFixed(1) + '%）');
    console.log('台词:非语言 = ' + totSay + ':' + totAct + '（非语言占 ' + (totAct / (totSay + totAct) * 100).toFixed(1) + '%）');
    console.log('气泡长度分布（字）：≤10=' + hist[0] + '  11-20=' + hist[1] + '  21-40=' + hist[2] + '  41-80=' + hist[3] + '  >80=' + hist[4]);
    return;
  }
  if (DRY) {
    for (const v of VARIANTS) for (const len of LENGTHS) {
      console.log('\n===== ' + v + ' / ' + len + ' 字 =====\n');
      console.log(buildSystem(real, v, len));
      console.log('\n----- user -----\n' + SCENE);
    }
    return;
  }
  if (!KEY) { console.error('缺少 CHAT_TEST_KEY 环境变量'); process.exit(2); }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rows = [];
  for (const v of VARIANTS) for (const len of LENGTHS) for (let r = 1; r <= RUNS; r++) {
    const system = buildSystem(real, v, len);
    const userMsg = SCENE + (SUFFIX ? '\n' + SUFFIX : '');
    let out;
    try { out = await callApi(system, userMsg); }
    catch (e) { console.log(pad(v + '/' + len + ' #' + r, 16) + '请求失败: ' + e.message); continue; }
    const rep = real.analyzeParse(out.content, { roster: ROSTER, defaultSpeaker: null, aliases: { '我': PROTAGONIST } });
    const chars = rep.sayChars + rep.actChars;
    const file = path.join(OUT_DIR, `${stamp}-${v}-${len}-${r}.txt`);
    fs.writeFileSync(file, out.content, 'utf8');
    rows.push({ v, len, r, chars, target: Number(len), bubbles: rep.bubbles, say: rep.sayChars, act: rep.actChars, fall: rep.fallbackChars, notes: rep.notes, unk: rep.unknownSpeakers, ms: out.ms, usage: out.usage, reasoning: out.reasoning.length, file });
    console.log(pad(`${v}/${len}#${r}`, 14) + `字数=${chars}(目标 ${len}) 气泡=${rep.bubbles} 台词=${rep.sayChars} 非语言=${rep.actChars} 兜底=${rep.fallbackChars} 未知说话人=${rep.unknownSpeakers.length ? rep.unknownSpeakers.join('/') : '无'} 耗时=${(out.ms / 1000).toFixed(1)}s 思考=${out.reasoning.length}字 finish=${out.finish}`);
    if (rep.notes.length) console.log('    问题: ' + rep.notes.join('、'));
  }
  fs.writeFileSync(path.join(OUT_DIR, stamp + '-summary.json'), JSON.stringify(rows, null, 2), 'utf8');
  console.log('\n产物目录: ' + OUT_DIR);
})().catch(e => { console.error('失败:', e); process.exit(1); });
