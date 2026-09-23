// 把 AI 生成的测试世界书批量入库为「仅管理员可见」的社区数据（admin_only=1）
//
// 用法（在服务器上执行）：
//   node tools/seed-testcards.js [cards目录] [--replace]
//     cards目录 默认 tools/testcards（由本地打包上传到服务器后执行）
//     --replace 先删掉旧的测试数据（author_name = 测试数据集）再导入
//
// 只写数据库与 uploads/worldbook 文件，不需要用户口令、不走 HTTP 上传接口。
const fs = require('node:fs');
const path = require('node:path');
const db = require('../src/db');
const wbsearch = require('../src/wbsearch');
const config = require('../src/config');

const AUTHOR_NAME = '测试数据集';
const args = process.argv.slice(2);
const cardsDir = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'testcards'));
const replace = args.includes('--replace');

if (!fs.existsSync(cardsDir)) {
  console.error('找不到目录：' + cardsDir);
  process.exit(1);
}

// 归属用户：取库里第一个用户（没有则用 0，author_name 才是展示名）
let authorId = 0;
try { const u = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get(); if (u) authorId = u.id; } catch (e) { /* 表为空 */ }

if (replace) {
  const olds = db.prepare('SELECT id, filename FROM world_books WHERE author_name = ?').all(AUTHOR_NAME);
  for (const o of olds) {
    db.prepare('DELETE FROM world_books WHERE id = ?').run(o.id);
    wbsearch.removeIndex(o.id);
    if (o.filename) { try { fs.unlinkSync(path.join(config.UPLOAD_DIR, 'worldbook', o.filename)); } catch (e) {} }
  }
  console.log('已删除旧测试数据 ' + olds.length + ' 条');
}

const files = fs.readdirSync(cardsDir).filter((f) => f.endsWith('.json'));
const uploadDir = path.join(config.UPLOAD_DIR, 'worldbook');
fs.mkdirSync(uploadDir, { recursive: true });
const insert = db.prepare('INSERT INTO world_books (title, description, category, tags, author_id, author_name, filename, size, downloads, created_at, cover, meta, search_text, admin_only) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, 1)');
let added = 0, skipped = 0;
for (const f of files) {
  let book;
  try { book = JSON.parse(fs.readFileSync(path.join(cardsDir, f), 'utf8')); } catch (e) { console.warn('跳过（JSON 坏）: ' + f); continue; }
  const title = String(book.title || book.name || f).slice(0, 60);
  const exists = db.prepare('SELECT id FROM world_books WHERE title = ? AND author_name = ?').get(title, AUTHOR_NAME);
  if (exists && !replace) { skipped++; continue; }
  const content = JSON.stringify({ name: book.name || title, title, entries: book.entries || [] });
  const spec = book.spec || {};
  const auto = wbsearch.extractMeta(content);
  const meta = {
    genre: String(spec.genre || '').slice(0, 12),
    audience: String(spec.audience || book.audience || '').slice(0, 8),
    relation: String(spec.relation || book.relation || '').slice(0, 8),
    franchise: String(book.franchise || '').slice(0, 40),
    nsfw: !!(spec.nsfw != null ? spec.nsfw : book.nsfw),
    chars: auto.chars, entryNames: auto.entryNames, entryCount: auto.entryCount, words: auto.words,
    summaryBy: 'seed',
  };
  const tags = (Array.isArray(book.tags) ? book.tags : []).map((t) => String(t).slice(0, 12)).slice(0, 12).join(',');
  const desc = String(book.description || '').slice(0, 500);
  const now = Date.now() - added * 1000; // 保持稳定顺序，避免全部同一时间戳
  const info = insert.run(title, desc, '综合', tags, authorId, AUTHOR_NAME, '', Buffer.byteLength(content), now, '', JSON.stringify(meta), '');
  const id = Number(info.lastInsertRowid);
  const filename = 'wb_' + id + '.json';
  fs.writeFileSync(path.join(uploadDir, filename), content, 'utf8');
  const searchText = wbsearch.buildSearchText({ title, description: desc, tags, category: '综合' }, meta);
  db.prepare('UPDATE world_books SET filename = ?, search_text = ? WHERE id = ?').run(filename, searchText, id);
  wbsearch.upsertIndex({ id, title, description: desc, search_text: searchText });
  added++;
}
console.log('入库完成：新增 ' + added + ' 条 / 跳过已存在 ' + skipped + ' 条（作者名「' + AUTHOR_NAME + '」，admin_only=1）');
const total = db.prepare('SELECT COUNT(*) c FROM world_books WHERE admin_only = 1').get().c;
console.log('库内 admin_only 世界书共 ' + total + ' 条');

// 自检：用几条真实问句跑一遍检索（admin=1，即管理员模式口径）
const probes = ['有没有剑与魔法的世界观', '有没有女性向的世界书', '有没有败犬女主的同人', '想要男性向纯爱的赛博朋克卡', '大世界书，异世界转生'];
for (const q of probes) {
  const r = wbsearch.search({ q, admin: 1, pageSize: 5 });
  console.log('\n[自检] ' + q + '  → 命中 ' + r.total + ' 条 | 通道 ' + JSON.stringify(r.modes) + ' | 识别条件 ' + JSON.stringify(r.facets));
  r.items.forEach((it, i) => console.log('   ' + (i + 1) + '. ' + it.title + '  (' + (it.meta ? it.meta.genre + '/' + it.meta.audience + '/' + (it.meta.relation || '-') : '-') + ', ' + (it.meta ? it.meta.entryCount : '?') + ' 条)'));
}
