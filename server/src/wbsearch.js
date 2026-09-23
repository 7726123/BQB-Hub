// 世界书检索（无向量、无模型）
//
// 设计依据：离线实测（app/tools 外的 cardsearch-bench2.mjs + 36 张 AI 生成世界书 / 108 条真实口吻问句）：
//   - 现状「整句 LIKE + 按时间」命中率 0%；「标题+简介短语检索」92%；「+字段(标签/原作/角色名/条目名)」94%
//   - 目标卡进 top3 只有 59-69%，加上重排窗口后 87% → 排序交给客户端 LLM，这里只负责"把对的卡放进候选"
//   - 索引条目正文几乎无收益（top3 +2pp）但索引体量翻数倍 → 只索引元数据
//   - facet（面向/关系/题材/同人）用"软过滤"：已标注的精确匹配，未标注的保留并降权（硬过滤会丢掉没标签的卡）
//
// 服务器成本：一条 FTS5 查询（毫秒级）+ 一次 LIKE 兜底；无新进程、无向量库、无内存常驻索引。
const db = require('./db');
const config = require('./config');
const visibility = require('./visibility');

const MAX_LIMIT = 50;
const CAND_LIMIT = 60;
// 运行时是否可用 FTS5（Node 22.12 的 node:sqlite 没编译 FTS5）——不可用时整条检索链降级为多路 LIKE，
// 排序/融合逻辑不变（实测：36 张卡上 LIKE 扫描 0-1ms；数千张卡量级仍可接受）
const HAS_FTS = !!db.hasFts5;

// ---------- 查询侧：问句外壳 + 别名词典 + facet 词典 ----------
const SHELL_RE = /有没有|有吗|有木有|想找|想要|想看|推荐|给我|找一下|来几张|来一个|一些|一下|那种|这类|这种|的卡|的设定集|的世界书|世界观|世界书|设定集|卡|吗|呢|了|啊|吧|，|。|？|\?|、|的|和|与|或|跟|差不多|类似|出场|登场/g;
const CN_STOP = new Set(['的', '了', '是', '有', '和', '与', '在', '我', '你', '他', '她', '它', '这', '那', '吗', '呢', '吧', '啊', '都', '也', '还', '就', '很', '要', '想', '个', '些', '把', '被', '给', '对', '到', '中', '上', '下', '不', '没']);
// 别名词典：口语词 → 检索词（把"语义匹配"变成词表匹配，向量那一环的替代品）
const SYN = {
  '剑与魔法': ['奇幻', '西幻', '魔法', '骑士', '公会', '冒险者'],
  '赛博朋克': ['赛博', '义体', '霓虹', '黑客', '公司城市'],
  '克苏鲁': ['克苏鲁', '旧神', '理智', '不可名状'],
  '武侠': ['武侠', '仙侠', '剑修', '江湖', '宗门', '修真'],
  '校园': ['校园', '学园', '社团', '青春'],
  '女性向': ['女性向', '乙女', '少女向'],
  '男性向': ['男性向'],
  '一般向': ['一般向'],
  'BL': ['BL', '耽美', '腐向'],
  'GL': ['GL', '百合'],
  '纯爱': ['纯爱', '一对一'],
  '后宫': ['后宫', '多女主', '多男主'],
  '同人': ['同人', '二创'],
};
// facet：面向 / 关系 / 是否同人（口语词 → meta 取值）
const FACET_WORDS = {
  audience: { '女性向': '女性向', '乙女': '女性向', '乙女向': '女性向', '男性向': '男性向', '一般向': '一般向' },
  relation: { 'BL': 'BL', '耽美': 'BL', '腐向': 'BL', 'GL': 'GL', '百合': 'GL', '纯爱': '纯爱', '后宫': '后宫', '无恋爱线': '无恋爱线' },
  fanfic: { '同人': 1, '二创': 1 },
};
// 题材词 → 题材枚举（多条件查询靠这个收敛：'男性向+纯爱+赛博朋克' 这类只有一个解）
const GENRE_WORDS = {
  '剑与魔法': ['剑与魔法', '西幻', '魔法', '骑士', '剑与'],
  '赛博朋克': ['赛博朋克', '赛博', '义体', '霓虹', '黑客', '科技'],
  '克苏鲁恐怖': ['克苏鲁', '旧神', '理智'],
  '武侠仙侠': ['武侠', '仙侠', '江湖', '宗门', '修真', '剑修'],
  '校园日常': ['校园', '学园', '社团'],
  '异世界转生': ['异世界', '转生', '穿越'],
  '废土末日': ['废土', '末日', '末世'],
  '蒸汽朋克': ['蒸汽朋克', '飞空艇'],
  '悬疑推理': ['悬疑', '推理', '侦探', '案件'],
  '恋爱喜剧': ['恋爱喜剧', '恋爱', '甜'],
  '历史架空': ['历史', '架空', '古代', '宫廷'],
  '神话幻想': ['神话', '幻想'],
  '偶像音乐': ['偶像', '音乐', '乐队', '歌手'],
  '体育竞技': ['体育', '竞技', '运动'],
  '职场社会': ['职场', '社会', '上班'],
  '医疗题材': ['医疗', '医生', '医院'],
  '学园异能': ['异能', '超能力', '能力者', '都市'],
  '田园治愈': ['田园', '治愈', '乡村'],
  '战争军事': ['战争', '军事'],
  '奇幻冒险': ['奇幻', '冒险'],
  '喜剧日常': ['喜剧', '搞笑'],
  '战斗奇幻': ['战斗', '热血'],
  '古代宫廷': ['宫廷', '后宫争斗'],
};

/** 把用户口语问句拆成检索词 + facet 约束 */
function analyzeQuery(text) {
  const raw = String(text || '');
  const facets = { audience: '', relation: '', fanfic: 0, genre: '', franchise: '' };
  for (const [word, val] of Object.entries(FACET_WORDS.audience)) if (raw.includes(word)) facets.audience = val;
  for (const [word, val] of Object.entries(FACET_WORDS.relation)) if (raw.includes(word)) facets.relation = val;
  for (const word of Object.keys(FACET_WORDS.fanfic)) if (raw.includes(word)) facets.fanfic = 1;
  for (const [genre, words] of Object.entries(GENRE_WORDS)) if (words.some((w) => raw.includes(w))) facets.genre = genre;
  // 原作名：与库里已有 franchise 做前缀/包含匹配（"败犬女主" → "败犬女主太多了"）
  try {
    const rows = db.prepare("SELECT DISTINCT json_extract(meta, '$.franchise') AS fr FROM world_books WHERE fr IS NOT NULL AND fr != ''").all();
    for (const r of rows) {
      const fr = String(r.fr || '');
      const short = fr.replace(/^我的/, '');
      if (fr && (raw.includes(fr) || (short.length >= 2 && raw.includes(short)))) { facets.franchise = fr; break; }
    }
  } catch (e) { /* meta 不可用时忽略 */ }

  let t = raw;
  for (const [k, vs] of Object.entries(SYN)) if (t.includes(k)) t += ' ' + vs.join(' ');
  const terms = new Set();
  (t.match(/[a-z][a-z0-9]{1,}/gi) || []).forEach((w) => terms.add(w.toLowerCase()));
  // 单个汉字 / 数字也当检索词：中文里「剑」「灰」「86」这种单字（或纯数字）是有意义的，
  // 丢弃它们会让用户单字搜索时收不到任何过滤（旧行为是无词 → 返回全量列表，看起来像搜索没生效）。
  (raw.match(/[0-9]+/g) || []).forEach((n) => terms.add(n));
  for (const run of (t.replace(SHELL_RE, ' ').match(/[一-鿿]+/g) || [])) {
    if (run.length <= 5) terms.add(run);   // 含单字：交给 LIKE 通道（trigram 索引不支持 <3 字）
    for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= run.length; i++) terms.add(run.slice(i, i + n));
  }
  if (facets.franchise) terms.add(facets.franchise);
  if (facets.genre) terms.add(facets.genre);
  return { terms: [...terms].filter((x) => !CN_STOP.has(x)).slice(0, 40), facets };
}

// ---------- 文档侧：元数据 + 检索文本 ----------
/** 从上传的世界书 JSON 里机械抽取元数据（零成本；AI 摘要只在客户端做，服务器不调模型） */
function extractMeta(contentJson) {
  const meta = { chars: [], entryNames: [], entryCount: 0, words: 0 };
  try {
    const book = JSON.parse(contentJson);
    const entries = Array.isArray(book.entries) ? book.entries : [];
    meta.entryCount = entries.length;
    let words = 0;
    for (const e of entries) {
      const type = String(e.type || '');
      const name = String(e.name || '').trim();
      if (name) meta.entryNames.push(name.slice(0, 40));
      if (type === '角色' && name) meta.chars.push(name.replace(/^姓名[:：]\s*/, '').slice(0, 20));
      words += String(e.content || '').replace(/\s/g, '').length;
    }
    meta.words = words;
    meta.chars = meta.chars.slice(0, 30);
    meta.entryNames = meta.entryNames.slice(0, 60);
  } catch (e) { /* 非法 JSON 由上传校验拦下，这里静默 */ }
  return meta;
}

/** 检索文本 = 标题 + 简介 + 标签 + 元数据（实测：条目正文不进索引） */
function buildSearchText(row, meta) {
  const m = meta || {};
  return [
    row.title || '', row.description || '', row.tags || '', row.category || '', m.summary || '',
    m.genre || '', m.audience || '', m.relation || '', m.franchise || '',
    (m.chars || []).join(' '), (m.entryNames || []).join(' '),
  ].join(' ').replace(/\s+/g, ' ').trim();
}

/** 写入/更新 FTS 索引（rowid = world_books.id） */
function upsertIndex(row) {
  try {
    db.prepare('DELETE FROM wb_fts WHERE rowid = ?').run(row.id);
    db.prepare('INSERT INTO wb_fts(rowid, search_text, title, description) VALUES(?,?,?,?)')
      .run(row.id, row.search_text || '', row.title || '', row.description || '');
  } catch (e) { console.warn('FTS 索引写入失败 id=' + row.id + ':', e.message); }
}
function removeIndex(id) { try { db.prepare('DELETE FROM wb_fts WHERE rowid = ?').run(id); } catch (e) { /* ignore */ } }

/** 全量重建索引（迁移/回填用）：把 search_text 为空的行补齐 */
function rebuildIndex() {
  let n = 0;
  const rows = db.prepare('SELECT id, title, description, category, tags, meta, search_text FROM world_books').all();
  for (const row of rows) {
    let meta = null;
    try { meta = row.meta ? JSON.parse(row.meta) : null; } catch (e) { meta = null; }
    const st = buildSearchText(row, meta);
    db.prepare('UPDATE world_books SET search_text = ? WHERE id = ?').run(st, row.id);
    upsertIndex({ id: row.id, search_text: st, title: row.title, description: row.description });
    n++;
  }
  return n;
}

// ---------- 检索 ----------
const SELECT_COLS = 'id, title, description, category, tags, author_id, author_name, size, downloads, created_at, cover, meta, admin_only, likes, comments, commenters';

/**
 * 检索世界书。
 * @param {object} o
 *   q          用户问句（口语整句即可）
 *   page/pageSize
 *   sort       relevance（默认）| hot | new
 *   strict     1 = facet 硬过滤（丢掉未标注的卡）；默认软过滤（保留未标注，降权）
 *   admin      1 = 可见 admin_only 行
 *   nsfw       '' 不限 | '1' 只要 NSFW | '0' 排除 NSFW
 * 返回 { items, total, modes: 命中通道, facets: 识别到的条件 }
 */
function search(o) {
  const q = String(o.q || '').trim();
  const page = Math.max(1, parseInt(o.page, 10) || 1);
  const pageSize = Math.min(MAX_LIMIT, Math.max(1, parseInt(o.pageSize, 10) || 20));
  const sort = ['hot', 'new'].includes(o.sort) ? o.sort : 'relevance';
  const strict = !!o.strict;
  const admin = !!o.admin;

  const { terms, facets } = q ? analyzeQuery(q) : { terms: [], facets: {} };
  const where = [], args = [];
  if (!admin) where.push('admin_only = 0');
  // 审核门：未过审的内容不进检索（管理员也一样——待审稿在审核面板里看，不进搜索结果）
  where.push(visibility.approvedSql());
  if (o.nsfw === '1' || o.nsfw === '0') {
    const want = o.nsfw === '1' ? 1 : 0;
    const other = want ? 0 : 1;
    // 未标注 nsfw 的行保留（软过滤）
    where.push("(CAST(json_extract(meta, '$.nsfw') AS INTEGER) = ? OR json_extract(meta, '$.nsfw') IS NULL OR CAST(json_extract(meta, '$.nsfw') AS INTEGER) != ?)");
    args.push(want, other);
  }
  const baseWhere = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const cand = new Map(); // id -> 命中的通道数（RRF 用）
  const modes = { fts: 0, like: 0, facet: 0, browse: 0 };
  const addRun = (ids, weight) => {
    ids.forEach((id, pos) => {
      const prev = cand.get(id) || { score: 0 };
      prev.score += weight / (60 + pos + 1);
      cand.set(id, prev);
    });
  };
  const runList = (ids, weight) => { if (ids.length) addRun(ids, weight); };

  if (terms.length) {
    // ① 短语通道：有 FTS5 时用 trigram 精确子串（≥3 字），否则整条走 LIKE；
    //    2 字词在任何情况下都用 LIKE 兜底（trigram 索引不支持 <3 字查询）
    const adminCond = admin ? 'IN (0,1)' : '= 0';
    for (const t of terms) {
      if (HAS_FTS && t.length >= 3) {
        try {
          const rows = db.prepare('SELECT rowid AS id FROM wb_fts WHERE wb_fts MATCH ? ORDER BY rank LIMIT ?').all('"' + t.replace(/"/g, '') + '"', CAND_LIMIT);
          if (rows.length) { modes.fts++; runList(rows.map((r) => r.id), 1); }
        } catch (e) { /* 非法 MATCH 表达式忽略 */ }
      } else {
        const rows = db.prepare('SELECT id FROM world_books WHERE search_text LIKE ? AND admin_only ' + adminCond + ' AND ' + visibility.approvedSql() + ' LIMIT ?').all('%' + t + '%', CAND_LIMIT);
        if (rows.length) { modes.like++; runList(rows.map((r) => r.id), t.length >= 3 ? 1 : 0.8); }
      }
    }
    // ② facet 通道：已标注的精确匹配（软过滤时未标注也进候选，但排序靠后）
    const facetGroups = [];
    if (facets.audience) facetGroups.push({ sql: "json_extract(meta, '$.audience') = ?", val: facets.audience, w: 1.8 });
    if (facets.relation) facetGroups.push({ sql: "json_extract(meta, '$.relation') = ?", val: facets.relation, w: 1.8 });
    if (facets.genre) facetGroups.push({ sql: "json_extract(meta, '$.genre') = ?", val: facets.genre, w: 1.6 });
    if (facets.franchise) facetGroups.push({ sql: "json_extract(meta, '$.franchise') = ?", val: facets.franchise, w: 2.2 });
    for (const g of facetGroups) {
      try {
        const rows = db.prepare('SELECT id FROM world_books WHERE ' + g.sql + (admin ? '' : ' AND admin_only = 0') + ' AND ' + visibility.approvedSql() + ' LIMIT ?').all(g.val, CAND_LIMIT);
        if (rows.length) { modes.facet++; runList(rows.map((r) => r.id), g.w); }
      } catch (e) { /* json_extract 不可用时忽略 */ }
    }
    // facet 全满足的卡再补一档（多条件查询通常只有一个解）
    if (facetGroups.length >= 2) {
      try {
        const sql = 'SELECT id FROM world_books WHERE ' + facetGroups.map((g) => g.sql).join(' AND ') + (admin ? '' : ' AND admin_only = 0') + ' AND ' + visibility.approvedSql() + ' LIMIT ?';
        const rows = db.prepare(sql).all(...facetGroups.map((g) => g.val), CAND_LIMIT);
        runList(rows.map((r) => r.id), 2.5);
      } catch (e) { /* ignore */ }
    }
  }

  // 「用户没输入」与「查询词被全部过滤掉」是两件事：后者（纯标点、只剩停用词）必须返回空结果，
  // 不能退回全量列表——否则用户看到列表毫无变化，会以为搜索没生效（单字中文查询踩过这个坑）。
  const hasFacet = !!(facets.audience || facets.relation || facets.fanfic || facets.genre || facets.franchise);
  if (!cand.size) {
    if (!terms.length && q && !hasFacet) {
      modes.tooShort = 1;
      return { items: [], total: 0, modes, facets, terms: [] };
    }
    // 无检索词 → 浏览模式（按热度/时间列最近的世界书）
    if (!terms.length) {
      modes.browse = 1;
      const order = sort === 'hot' ? 'downloads DESC, created_at DESC' : 'created_at DESC';
      const total = db.prepare('SELECT COUNT(*) c FROM world_books' + baseWhere).get(...args).c;
      const items = db.prepare('SELECT ' + SELECT_COLS + ' FROM world_books' + baseWhere + ' ORDER BY ' + order + ' LIMIT ? OFFSET ?')
        .all(...args, pageSize, (page - 1) * pageSize);
      return { items: items.map(decorate), total, modes, facets, terms: terms.slice(0, 12) };
    }
    // 有检索词但一个候选都没有：返回空结果 + browse 标记，调用方据此回答“没找到”。
    // 这里不能兜底给浏览列表——否则“搜不到”会变成“给你一堆不相关的卡”，也破坏 /list?q= 的过滤语义
    modes.browse = 1;
    return { items: [], total: 0, modes, facets, terms: terms.slice(0, 12) };
  }

  // 打分：RRF + 热度 + 新鲜度 + 已标注加分；strict 模式下丢未标注的
  const ids = [...cand.keys()];
  const placeholders = ids.map(() => '?').join(',');
  // 最后一道防线：无论前面哪条通道放进来的候选，这里都按审核状态与 admin_only 重查一遍
  const rows = db.prepare('SELECT ' + SELECT_COLS + ' FROM world_books WHERE id IN (' + placeholders + ')' + (admin ? '' : ' AND admin_only = 0') + ' AND ' + visibility.approvedSql()).all(...ids);
  const scored = rows.map((row) => {
    let meta = null;
    try { meta = row.meta ? JSON.parse(row.meta) : null; } catch (e) { meta = null; }
    let s = (cand.get(row.id) || {}).score;
    s += Math.log10(1 + (row.downloads || 0)) * 0.12;
    s += ((row.created_at || 0) / 1.7e12) * 0.15;
    if (meta && meta.audience) s += 0.05;            // 已标注 → 略加分（软过滤）
    if (facets.audience && meta && meta.audience === facets.audience) s += 0.25;
    if (facets.relation && meta && meta.relation === facets.relation) s += 0.25;
    if (strict) {
      if (facets.audience && (!meta || meta.audience !== facets.audience)) return null;
      if (facets.relation && (!meta || meta.relation !== facets.relation)) return null;
    }
    return { row, s, meta };
  }).filter(Boolean).sort((a, b) => b.s - a.s);

  const total = scored.length;
  const slice = scored.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize);
  return { items: slice.map((x) => decorate(x.row)), total, modes, facets, terms: terms.slice(0, 12) };
}

/** 列表项附带解析出的元数据（前端/助手可直接用 facet 显示与过滤） */
function decorate(row) {
  let meta = null;
  try { meta = row.meta ? JSON.parse(row.meta) : null; } catch (e) { meta = null; }
  return {
    id: row.id, title: row.title, description: row.description, category: row.category,
    tags: row.tags, author_id: row.author_id, author_name: row.author_name,
    size: row.size, downloads: row.downloads, created_at: row.created_at, cover: row.cover,
    admin_only: row.admin_only, meta,
    status: row.status, // 审核状态（作者在「我的投稿」/详情里显示待审、已驳回徽标；公开列表里恒为 approved）
    // 社交计数（缓存列）：卡片上显示 ♥/💬，liked 由调用方按登录用户补
    likes: row.likes || 0, comments: row.comments || 0, commenters: row.commenters || 0,
  };
}

module.exports = { analyzeQuery, extractMeta, buildSearchText, upsertIndex, removeIndex, rebuildIndex, search, decorate };
