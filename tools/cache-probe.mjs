// 缓存命中试验台：用真实端点量「小说模式 prompt 装配」的前缀缓存命中率。
//
// 为什么需要它：这几轮的缓存优化（召回钉住 / 消息顺序 / 窗口边界）光看代码推不出收益，
// 必须用真实端点看 usage 里的 cached_tokens。本脚本复刻 app.ts 的消息装配（稳定 system 段 →
// 窗口正文 → user 滚动区[召回 + 世界书重复 + 角色状态 + 滚动区 + 指令]），定长 prompt，
// 只改「召回块的排序/钉住策略」，逐轮打印 cached / prompt_tokens。
//
// 用法（key 只走环境变量，不落盘、不打印）：
//   CHAT_TEST_KEY=<key> node tools/cache-probe.mjs
//   可选：CE=<endpoint>（默认火山方舟 coding 端点）CM=<model>（默认 deepseek-v4-1-flash-260910）
//   可选：--turns=4 每变体轮数（默认 3）、--salt=12345 固定语料（默认每次运行换盐=冷启动）
//
// 已实测结论（2026-09-25，方舟 coding + deepseek-v4-1-flash-260910，prompt≈10.1k tokens，看第 2/3 轮）：
//   V1 现状（召回按 BM25 分数倒序、置于 user 最前）         46.9% / 46.9%  ← 每轮都只剩 system 前缀
//   V2 只把召回改成稳定序（按块位置升序），仍置于 user 最前  50.7% / 54.5%  ← 排序本身只值 4~8 点
//   V3 召回稳定序 + 稳定块（世界书重复/角色状态）前置        57.0% / 40.6%  ← 噪声大，见下
//   V4 召回块「钉住」= 上一轮列表原序保留、新命中追加在尾部  62.7% / 66.3%  ← 钉住才是大头（+16~20 点）
//   V5 钉住 + 稳定块前置（推荐形态）                         71.8% / 74.6%
//   V6 上限参考：召回集合与顺序全冻结                       98.9% / 98.9%  ← 端点缓存可用、记账可信
// 为什么这样：命中长度 = 与上一轮请求的最长公共前缀，所以①每轮必变的内容必须排在最后，
// ②「召回集合漂移」比「顺序漂移」致命得多——首条一变，整块及之后全部 miss。
// 这也是要「钉住（只追加）」而不是「排序」的原因：排序只在集合重叠时略显效，钉住让整块变成前缀。
// 注意变体之间会互相预热（同字节能被下一个变体复用），看同一变体各轮的走势最可靠。

const ENDPOINT = process.env.CE || 'https://ark.cn-beijing.volces.com/api/coding/v3/chat/completions';
const MODEL = process.env.CM || 'deepseek-v4-1-flash-260910';
const KEY = process.env.CHAT_TEST_KEY;
if (!KEY) { console.error('需要 CHAT_TEST_KEY 环境变量（只读环境变量，不要写进文件）'); process.exit(1); }
const TURNS = Number((process.argv.find((a) => a.startsWith('--turns=')) || '').split('=')[1]) || 3;
// 每次运行换一次盐：语料字节全变 → 不会复用上一次运行留在端点上的缓存（否则第二次跑全是 99%）。
// 想复现上一次的字节（例如对比改动前后）就显式 --salt=<同一个数>。
const SALT = Number((process.argv.find((a) => a.startsWith('--salt=')) || '').split('=')[1]) || (Date.now() % 100000);

// ---------- 确定性中文语料（同种子 → 同字节，方便跨轮/跨次比对） ----------
const NAMES = ['林薇', '沈舟', '苏晚', '陆离', '顾青', '白露'];
const VERBS = ['推开', '合上', '攥紧', '松开', '绕过', '举起'];
const OBJS = ['走廊尽头的门', '窗台上那盏灯', '牛皮纸袋', '灰蓝色的信纸', '生锈的钥匙'];
const TAILS = ['她没有回头。', '空气里有一股潮气。', '钟声在楼下响了两下。', '雨水顺着屋檐往下淌。'];
function mk(seed, n) {
  let s = (seed * 7919 + SALT) & 0x7fffffff; const out = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (out.join('').length < n) {
    out.push(`${NAMES[Math.floor(rnd() * NAMES.length)]}${VERBS[Math.floor(rnd() * VERBS.length)]}${OBJS[Math.floor(rnd() * OBJS.length)]}，${TAILS[Math.floor(rnd() * TAILS.length)]}`);
  }
  return out.join('\n');
}
const SYS = [
  { role: 'system', content: '你是轻小说写作助手。\n【铁则】不总结、不升华、不预告。\n' + mk(11, 1200) },
  { role: 'system', content: '## 世界书条目（必须严格遵守）\n' + mk(22, 2600) },
  { role: 'system', content: '## 已完成的正文（历史部分）\n' + mk(7, 2600) },
];
const ROLLING = '【上下文】\n' + mk(9, 2600);
const VARCTX = '\n## 世界书条目（以下设定必须严格遵守，不得违反）\n' + mk(22, 1400); // 与 SYS[1] 同源：模拟 app 里被重复注入的世界书
const PIECES = Array.from({ length: 24 }, (_, i) => ({ pos: i, text: mk(1000 + i * 7, 500) }));
// 每轮召回集合：相邻轮 2/3 重叠，模拟真实漂移
const SETS = [[2, 5, 9, 12, 15, 18], [3, 5, 9, 12, 16, 19], [4, 6, 9, 12, 16, 20], [6, 8, 9, 12, 16, 21]];

function userMsg(turn, state, { pin, front, ceiling, stable }) {
  const cur = SETS[Math.min(turn, SETS.length - 1)].map((p) => PIECES.find((x) => x.pos === p));
  let ordered;
  if (ceiling) {
    ordered = SETS[0].map((p) => PIECES.find((x) => x.pos === p)); // 集合与顺序全冻结
  } else if (pin) {
    ordered = state.pinned.concat(cur.filter((p) => state.pinned.indexOf(p) < 0)); // 只追加
    state.pinned = ordered;
  } else if (stable) {
    ordered = cur.slice().sort((a, b) => a.pos - b.pos); // 稳定序：按块在正文里的位置升序
  } else {
    const rank = (p) => ((p * 2654435761 + turn * 40503 * (p + 3)) % 997);
    ordered = cur.slice().sort((a, b) => rank(b.pos) - rank(a.pos)); // 模拟 BM25 分数倒序：每轮顺序都变
  }
  const recall = '## 归档原文回读（与当前剧情相关的旧正文片段，原样引用）\n' + ordered.map((p) => '【旧正文】' + p.text).join('\n\n');
  const states = '## 角色当前状态\n林薇：疲惫';
  const parts = front
    ? [VARCTX, states, recall, ROLLING, '【指令】\n请根据以上内容续写。第' + turn + '轮。']
    : [recall, VARCTX, states, ROLLING, '【指令】\n请根据以上内容续写。第' + turn + '轮。'];
  return { role: 'user', content: parts.join('\n\n') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(msgs) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
    body: JSON.stringify({ model: MODEL, messages: msgs, max_tokens: 4, temperature: 0.8, stream: false }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + JSON.stringify(j).slice(0, 200));
  const u = j.usage || {};
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || u.prompt_cache_hit_tokens || 0;
  return { prompt: u.prompt_tokens || 0, cached };
}

const MODES = [
  ['V1 现状：召回按分数倒序 + 置于 user 最前', { pin: false, front: false }],
  ['V2 召回改稳定序（仍置于 user 最前）', { pin: false, front: false, stable: true }],
  ['V3 召回稳定序 + 稳定块前置', { pin: false, front: true, stable: true }],
  ['V4 召回钉住（只追加）+ 置于最前', { pin: true, front: false }],
  ['V5 召回钉住 + 稳定块前置（推荐）', { pin: true, front: true }],
  ['V6 上限参考：召回全冻结', { ceiling: true, front: false }],
];
const rows = [];
for (const [name, opt] of MODES) {
  const state = { pinned: [] };
  for (let turn = 0; turn < TURNS; turn++) {
    try { rows.push({ name, turn, ...(await call(SYS.concat([userMsg(turn, state, opt)]))) }); }
    catch (e) { console.log(name, '失败：', String(e).slice(0, 140)); break; }
    await sleep(300);
  }
}
console.log(`\n=== 缓存命中（cached / prompt_tokens）@ ${MODEL} ===`);
for (const [name] of MODES) {
  const rs = rows.filter((r) => r.name === name);
  if (!rs.length) continue;
  console.log(name);
  rs.forEach((r) => console.log(`   第${r.turn + 1}轮  ${String(r.cached).padStart(5)} / ${String(r.prompt).padStart(5)} = ${(r.cached / r.prompt * 100).toFixed(1)}%`));
}
console.log('\n注：变体之间会互相「预热」缓存（前一个变体留下的同前缀会被复用），');
console.log('    所以要看同一变体各轮之间的走势，以及 V6 上限（≈99%）作为记账可信度基准。');
