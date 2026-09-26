#!/usr/bin/env node
// README 截图自动更新（docs/screenshots/*.jpg）。
//
// 干什么：无头 Chromium 加载 web/ 构建产物 → 用应用自身的公开 API 灌入演示数据 →
//         逐个视图截图 → 覆盖 docs/screenshots/。不需要模拟器、不需要真机、不需要联网。
//
// 为什么是浏览器而不是模拟器：截图里没有一处原生外壳，全是 WebView 内容；而 web/ 自带
//   字体（web/assets/fonts），视口对齐到 452x960 @DPR2 即与真机 904x1920 同规格。
//
// 幂等性（这套东西的价值所在）：演示数据固定 + 时钟冻结 → UI 没改则输出字节相同，
//   git status 干净。UI 改了才出 diff。所以「README 图片落后于版本」不会再发生，
//   而每次发版你只需要看一眼 diff 决定要不要提交。
//
// 用法：
//   node scripts/readme-shots.mjs                 # 全部 5 张
//   node scripts/readme-shots.mjs --only 04-usage # 只重拍一张（调布局时用）
//   node scripts/readme-shots.mjs --headed        # 开真窗口看它怎么点（排查用）
//   node scripts/readme-shots.mjs --allow-stale   # 允许用旧的 main.js 出图（不推荐）
//
// ⚠️ 必须在 `cd app && npm run sync:legacy` 之后运行：它截的是 web/modules/main.js，
//    源码改了没重新构建的话，截出来是旧界面（本脚本会自己检测过期并拒绝运行）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  BOOKS, CARDWRITER_DIALOG, ASSISTANT_DIALOG, USAGE_RECORDS, FROZEN_NOW, THEME,
} from './readme-shots.data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'web');
const SRC_DIR = path.join(ROOT, 'app', 'src');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const REVIEW_PAGE = path.join(OUT_DIR, '_review.html');
const README = path.join(ROOT, 'README.md');

// 452x960 @DPR2 = 904x1920，与历史截图一致；改动会让 README 表格里的 240px 展示宽度变形
const CSS_W = 452;
const CSS_H = 960;
const DPR = 2;
const JPEG_QUALITY = 88;

const SHOTS = [
  { name: '01-worldbook', view: 'world', caption: '世界书书架', desc: '世界书：书架式管理，条目分世界观 / 角色 / 初始 / 其他' },
  { name: '02-cardwriter', view: 'cardwriter', caption: '写卡 Agent', desc: '和它讨论，它直接改世界书（思考过程可展开，不进正文）' },
  { name: '03-assistant', view: 'usageassist', caption: '使用助手', desc: '内置客服，也讲清酒馆卡怎么导入与改造' },
  { name: '04-usage', view: 'usage', caption: '用量统计', desc: '每轮的字数、费用、缓存命中与输出速度都记着' },
  { name: '05-nav', view: 'writing', drawer: true, caption: '功能一览', desc: '写作 / 记忆 / 世界书 / 写卡 / 社区 / 反馈' },
];

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

const argv = process.argv.slice(2);
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const HEADED = argv.includes('--headed');
const ALLOW_STALE = argv.includes('--allow-stale');
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------- 前置检查

/** 构建产物是否比源码旧。这条检查是防「改了源码没跑 sync:legacy 就出图」——
 *  该失误在真机复核里已经发生过两次（见 docs/开发流程说明），出图这边同样会中。 */
function assertBundleFresh() {
  const bundle = path.join(WEB_DIR, 'modules', 'main.js');
  if (!fs.existsSync(bundle)) {
    fail(`找不到 ${path.relative(ROOT, bundle)}，请先构建：cd app && npm run sync:legacy`);
  }
  const bundleTime = fs.statSync(bundle).mtimeMs;
  let newest = 0;
  let newestFile = '';
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(ts|css|html)$/.test(e.name)) continue;
      const t = fs.statSync(p).mtimeMs;
      if (t > newest) { newest = t; newestFile = p; }
    }
  };
  walk(SRC_DIR);
  for (const extra of [path.join(WEB_DIR, 'index.html')]) {
    if (fs.existsSync(extra)) {
      const t = fs.statSync(extra).mtimeMs;
      if (t > newest) { newest = t; newestFile = extra; }
    }
  }
  if (newest > bundleTime + 1000) {
    const msg = `构建产物比源码旧：\n  main.js       ${new Date(bundleTime).toLocaleString()}\n  ${path.relative(ROOT, newestFile).padEnd(20)}${new Date(newest).toLocaleString()}\n\n请先跑： cd app && npm run sync:legacy\n（确要用旧产物出图：加 --allow-stale）`;
    if (!ALLOW_STALE) fail(msg);
    log('⚠️  ' + msg.split('\n')[0] + '（已用 --allow-stale 跳过）');
  }
}

function fail(msg) {
  console.error('\n✗ ' + msg + '\n');
  process.exit(1);
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

// ---------------------------------------------------------------- 数据准备

/** 用量记录：把 data 里的相对分钟数换算成绝对时间戳，并按 label 组装 byLabel。 */
function buildUsageRecords() {
  const base = new Date(FROZEN_NOW).getTime();
  return USAGE_RECORDS.map((r) => {
    const t = base - r.minutesAgo * 60000;
    return {
      id: 'sess_' + t,
      time: t,
      duration: r.duration,
      apiCalls: r.apiCalls,
      promptTokens: r.promptTokens,
      cachedTokens: r.cachedTokens,
      completionTokens: r.completionTokens,
      hitRate: r.promptTokens > 0 ? ((r.cachedTokens / r.promptTokens) * 100).toFixed(1) : '0.0',
      cost: r.cost,
      wordCount: r.wordCount,
      byLabel: {
        [r.label]: {
          count: r.apiCalls, promptTokens: r.promptTokens,
          cachedTokens: r.cachedTokens, completionTokens: r.completionTokens,
        },
      },
      noUsage: 0,
    };
  });
}

// ---------------------------------------------------------------- 静态服务

function serve() {
  const resolvedWeb = path.resolve(WEB_DIR);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(String(req.url || '/').split('?')[0]);
    if (p === '/') p = '/index.html';
    const fp = path.resolve(path.join(WEB_DIR, p));
    if (!fp.startsWith(resolvedWeb)) { res.writeHead(403).end(); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ---------------------------------------------------------------- 主流程

async function main() {
  assertBundleFresh();
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { server, port } = await serve();
  const origin = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ headless: !HEADED });
  const context = await browser.newContext({
    viewport: { width: CSS_W, height: CSS_H },
    // mobile-device 形态判定读的是 screen.*（见 index.html 尾部脚本），必须一起设
    screen: { width: CSS_W, height: CSS_H },
    deviceScaleFactor: DPR,
    isMobile: true,
    hasTouch: true,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });

  // 在任何页面脚本之前落地：主题 + 冻结时钟 + 不依赖运行时的存储种子。
  // StorageManager.init() 会把所有 lnw_* 键自动迁移进 IndexedDB，故只需写一次 localStorage。
  await context.addInitScript((seed) => {
    try {
      for (const [k, v] of Object.entries(seed.storage)) localStorage.setItem(k, v);
      // 时钟冻结：只影响 Date.now()/new Date()，不影响 setTimeout 等原生定时器，
      // 所以启动画面、bundle 注入这些依赖定时器的流程照常走。
      const fixed = seed.now;
      const RealDate = Date;
      // @ts-ignore
      window.Date = class extends RealDate {
        constructor(...args) { super(...(args.length ? args : [fixed])); }
        static now() { return fixed; }
      };
    } catch (e) { /* localStorage 不可用就退化为默认主题/实时时钟 */ }
  }, {
    now: new Date(FROZEN_NOW).getTime(),
    storage: {
      lnw_uiSettings: JSON.stringify({ theme: THEME }),
      lnw_usageHistory: JSON.stringify(buildUsageRecords()),
      // 使用助手的历史键是「JSON 字符串」再套一层（assistant.ts 存的就是 stringify 后的结果）
      lnw_usageAssistantHistory: JSON.stringify(JSON.stringify(ASSISTANT_DIALOG)),
    },
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console: ' + m.text().slice(0, 200));
  });

  // 断网：一是离线可跑，二是绝不能把截图过程的报错写进线上 client_logs / 用量接口。
  await page.route('**/*', (route) => (
    route.request().url().startsWith(origin) ? route.continue() : route.abort()
  ));

  await page.goto(`${origin}/index.html`, { waitUntil: 'load', timeout: 40000 });
  // 启动画面被 App 收起（或 12 秒兜底回收）即认为 bundle 已接管
  await page.waitForFunction(() => !document.getElementById('bootSplash'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(900);

  const booted = await page.evaluate(() => ({
    mobileUI: typeof window.MobileUI?.switchView === 'function',
    worldBookManager: typeof window.WorldBookManager?.createBook === 'function',
    cardWriter: typeof window.CardWriterChat?._key === 'function',
    usageStats: typeof window.UsageStats?.render === 'function',
  }));
  const missing = Object.entries(booted).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) fail(`应用未正常启动，缺少全局对象：${missing.join(', ')}。请看 --headed 输出的控制台报错。`);

  // ---- 灌演示数据（走应用自己的公开 API，不手写存储 schema）----
  const seeded = await page.evaluate((data) => {
    const WBM = window.WorldBookManager;

    const ids = [];
    for (const spec of data.books) {
      const book = WBM.createBook(spec.name);
      ids.push(book.id);
      for (const [type, name, content] of spec.entries) WBM.addEntry(book.id, { type, name, content });
    }
    // 清掉首次启动自动建的「默认世界书」——留下会在截图里多出一张 0 条目的卡。
    // 必须放在建完自己的书之后：一本都不剩时 initDefaults 会再建一本。
    const keep = new Set(data.books.map((b) => b.name));
    for (const b of WBM.getAll()) {
      if (!keep.has(b.name)) { try { WBM.deleteBook(b.id); } catch (e) { /* ignore */ } }
    }

    const all = WBM.getAll();
    const first = all.find((b) => b.name === data.books[0].name);
    if (first?.chapters?.length && data.books[0].chapter) {
      first.chapters[0].title = data.books[0].chapter.title;
      first.chapters[0].content = data.books[0].chapter.content;
    }
    WBM.saveAll(all);
    WBM.setActiveId(first ? first.id : ids[0]);

    // 写卡对话：键名含目标书 id，必须在建完书、设完 activeId 之后再写
    let cwKey = null;
    try {
      cwKey = window.CardWriterChat._key();
      window.StorageManager.set(cwKey, data.cardwriterDialog);
    } catch (e) { /* 键解析失败时下面会报出来 */ }

    return { cwKey, bookNames: WBM.getAll().map((b) => b.name), activeId: WBM.getActiveId() };
  }, { books: BOOKS, cardwriterDialog: CARDWRITER_DIALOG });

  // 重新加载：各面板（写卡 / 使用助手 / 用量…）都是启动时把存储读进内存再渲染的，
  // 启动后再写存储不会让它们回头重读。刷一次让完整状态在首次渲染时就位——
  // 比去追每个模块各自的重渲染钩子稳得多（那些钩子不是公开 API，改了不会通知你）。
  await page.reload({ waitUntil: 'load', timeout: 40000 });
  await page.waitForFunction(() => !document.getElementById('bootSplash'), null, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(900);

  const verify = await page.evaluate(() => {
    const WBM = window.WorldBookManager;
    const cw = window.CardWriterChat;
    let cwKey = null;
    let cwCount = 0;
    try {
      cwKey = cw._key();
      cwCount = (window.StorageManager.get(cwKey, []) || []).length;
      cw._load();   // 把存储里的对话读进内存并渲染（面板此时已存在）
    } catch (e) { /* ignore */ }
    return {
      bookNames: WBM.getAll().map((b) => b.name),
      entryCounts: WBM.getAll().map((b) => (b.entries || []).length),
      activeId: WBM.getActiveId(),
      targetId: (() => { try { return cw._getTargetId(); } catch (e) { return null; } })(),
      cwKey,
      cwCount,
      editorLen: (() => { const e = document.getElementById('editor'); return e ? e.textContent.trim().length : 0; })(),
      usageCount: (window.UsageStats.getHistory() || []).length,
      assistantCount: (() => {
        try { return (window.UsageAssistant.messages || []).length; } catch (e) { return -1; }
      })(),
    };
  });

  const problems = [];
  if (verify.bookNames.length !== BOOKS.length) {
    problems.push(`世界书 ${verify.bookNames.length} 本，期望 ${BOOKS.length}：${verify.bookNames.join(' / ')}`);
  }
  if (!verify.activeId || verify.targetId !== verify.activeId) {
    problems.push(`写卡目标书未指向当前书（activeId=${verify.activeId} targetId=${verify.targetId}）`);
  }
  if (verify.cwCount !== CARDWRITER_DIALOG.length) {
    problems.push(`写卡对话 ${verify.cwCount} 条，期望 ${CARDWRITER_DIALOG.length}（key=${verify.cwKey}）`);
  }
  if (verify.assistantCount !== ASSISTANT_DIALOG.length) {
    problems.push(`使用助手历史 ${verify.assistantCount} 条，期望 ${ASSISTANT_DIALOG.length}`);
  }
  if (verify.usageCount !== USAGE_RECORDS.length) {
    problems.push(`用量记录 ${verify.usageCount} 条，期望 ${USAGE_RECORDS.length}`);
  }
  if (problems.length) {
    log('⚠️  演示数据未完全就位（出的图可能是空的）：');
    for (const p of problems) log('    · ' + p);
  }

  // ---- 逐张出图 ----
  const results = [];
  const before = new Map();
  for (const s of SHOTS) {
    const file = path.join(OUT_DIR, `${s.name}.jpg`);
    before.set(s.name, fs.existsSync(file) ? sha(fs.readFileSync(file)) : null);
  }

  for (const s of SHOTS) {
    if (ONLY && s.name !== ONLY) continue;
    const file = path.join(OUT_DIR, `${s.name}.jpg`);

    await page.evaluate((shot) => {
      // 切换前先掐掉瞬时提示（toast）：启动完成、模型探测这类提示会挂在底部，
      // 历史上 05-nav 就误拍进过一个「检测到 80 个模型」。
      document.querySelectorAll('#toast,.toast').forEach((el) => {
        el.classList.remove('show');
        el.style.display = 'none';
      });
      window.MobileUI.switchView(shot.view);
      if (shot.drawer) window.MobileUI.toggleDrawer();
    }, s);
    // 视图切换后会触发各自的渲染（记忆预算、反馈计数、设置页异步刷新等），多等两拍
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      document.querySelectorAll('#toast,.toast').forEach((el) => {
        el.classList.remove('show');
        el.style.display = 'none';
      });
    });
    await page.waitForTimeout(120);

    // 空画面断言：渲染没跑起来时（选择器变了 / 数据没灌进去）要报错，而不是静静存一张白图
    const sanity = await page.evaluate(() => {
      const panel = document.getElementById('panel');
      const area = document.getElementById('editor-area');
      const target = panel && getComputedStyle(panel).display !== 'none' ? panel : area;
      if (!target) return { ok: false, why: 'panel/editor-area 都不存在' };
      const text = (target.textContent || '').replace(/\s/g, '');
      return { ok: text.length > 80, why: text.length > 80 ? '' : `可见区文字仅 ${text.length} 字，疑似未渲染`, textLen: text.length };
    });

    await page.screenshot({ path: file, type: 'jpeg', quality: JPEG_QUALITY });
    await page.evaluate(() => window.MobileUI?.closeDrawer());

    const size = fs.statSync(file).size;
    const after = sha(fs.readFileSync(file));
    results.push({
      ...s, file, size, sanity,
      status: before.get(s.name) === null ? '新增' : (before.get(s.name) === after ? '未变' : '已更新'),
    });
    log(`  ${sanity.ok ? '✓' : '✗'} ${s.name.padEnd(14)} ${String(Math.round(size / 1024)).padStart(4)}KB  ${results.at(-1).status}${sanity.ok ? '' : '  ⚠️ ' + sanity.why}`);
  }

  // ---- README 一致性核对（只报告，不改文案）----
  const readmeIssues = checkReadme();

  // ---- 审查页 ----
  writeReviewPage(results, readmeIssues, verify);

  // ---- 汇总 ----
  log('');
  for (const r of results) {
    if (!r.sanity.ok) pageErrors.push(`${r.name}: ${r.sanity.why}`);
  }
  if (readmeIssues.length) {
    log('README 需要人工确认：');
    for (const i of readmeIssues) log('  · ' + i);
    log('');
  }
  const changed = results.filter((r) => r.status !== '未变');
  log(changed.length
    ? `共 ${results.length} 张，变动 ${changed.length} 张。审查页：${path.relative(ROOT, REVIEW_PAGE)}`
    : `共 ${results.length} 张，全部与磁盘上一致（UI 无变化）。`);

  if (pageErrors.length) {
    log('\n⚠️  运行期报错（截图过程不得有 JS 异常）：');
    for (const e of pageErrors.slice(0, 10)) log('  · ' + e);
  }

  await browser.close();
  server.close();
  process.exit(pageErrors.length ? 1 : 0);
}

/** 核对 README 是否仍按预期引用这 5 张图。只报告——文案是编辑决策，不自动改写。 */
function checkReadme() {
  const issues = [];
  if (!fs.existsSync(README)) return ['README.md 不存在'];
  const md = fs.readFileSync(README, 'utf8');
  for (const s of SHOTS) {
    const rel = `docs/screenshots/${s.name}.jpg`;
    if (!md.includes(rel)) { issues.push(`README 未引用 ${rel}`); continue; }
    const line = md.split('\n').find((l) => l.includes(rel)) || '';
    const alt = (line.match(/alt="([^"]*)"/) || [])[1];
    if (alt && alt !== s.caption) {
      issues.push(`${s.name}: README 的 alt=「${alt}」与本脚本 caption=「${s.caption}」不一致`);
    }
    const w = (line.match(/width="(\d+)"/) || [])[1];
    if (w && w !== '240') issues.push(`${s.name}: README 里宽度是 ${w}，历史值为 240（改过会让表格变形）`);
  }
  for (const m of md.matchAll(/docs\/screenshots\/([\w.-]+\.jpg)/g)) {
    if (!SHOTS.some((s) => `${s.name}.jpg` === m[1])) issues.push(`README 引用了本脚本不生成的图：${m[1]}`);
  }
  return issues;
}

/** 审查页：按 README 里的实际尺寸（240px）和全尺寸并排，用来一眼确认"这图能看"。 */
function writeReviewPage(results, readmeIssues, verify) {
  const rows = results.map((r) => `
    <section>
      <h2>${r.name} <span class="st st-${r.status === '未变' ? 'same' : 'chg'}">${r.status}</span></h2>
      <p class="cap"><b>${r.caption}</b>：${r.desc}</p>
      <div class="pair">
        <figure><img src="${r.name}.jpg" width="240"><figcaption>README 里的实际大小（240px）</figcaption></figure>
        <figure><img src="${r.name}.jpg" style="width:340px"><figcaption>放大（${r.sanity.textLen ?? '?'} 字）· ${Math.round(r.size / 1024)}KB</figcaption></figure>
      </div>
    </section>`).join('');
  const meta = `
    <p class="meta">世界书 ${verify.bookNames.length} 本（条目 ${verify.entryCounts.join(' / ')}） · 写卡对话 ${verify.cwCount} 条 · 使用助手 ${verify.assistantCount} 条 · 用量记录 ${verify.usageCount} 条 · 编辑器正文 ${verify.editorLen} 字</p>`;
  const warn = readmeIssues.length
    ? `<div class="warn"><b>README 需人工确认</b><ul>${readmeIssues.map((i) => `<li>${i}</li>`).join('')}</ul></div>`
    : '';
  fs.writeFileSync(REVIEW_PAGE, `<!DOCTYPE html><meta charset="utf-8"><title>README 截图审查</title>
<style>
 body{font:14px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:24px;background:#f6f7f9;color:#1f2430}
 h1{font-size:20px;margin:0 0 4px} .meta{color:#4a5468;margin:0 0 20px}
 section{background:#fff;border:1px solid #e3e7ef;border-radius:10px;padding:16px 18px;margin-bottom:16px}
 h2{font-size:15px;margin:0 0 6px} .cap{color:#4a5468;margin:0 0 12px}
 .st{font-size:12px;font-weight:400;padding:1px 8px;border-radius:20px;margin-left:6px}
 .st-same{background:#eef0f4;color:#4a5468} .st-chg{background:#eaf0fc;color:#2f5fc9}
 .pair{display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
 figure{margin:0} figcaption{color:#98a2b3;font-size:12px;margin-top:6px}
 img{border:1px solid #e3e7ef;border-radius:8px;display:block}
 .warn{background:#fff4f2;border:1px solid #f2c9c2;border-radius:10px;padding:12px 16px;margin-bottom:16px}
 .warn ul{margin:6px 0 0;padding-left:20px}
</style>
<h1>README 截图审查</h1>${meta}${warn}${rows}`);
}

main().catch((e) => { console.error('\n✗ 运行失败：', e); process.exit(1); });
