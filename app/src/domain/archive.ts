// ArchiveStore + Waterline：水位线滚动窗口 + 归档区（迁移自 www/modules/archive.js）。
// 原文窗口：全书正文前 N 块只增不改（≤ 预算 50%，prompt 缓存逐轮命中）；
// 达到触发线时最旧块滚入归档区（原文保留、可检索回读，丢失的只是 prompt 常驻身份）。
import { SM } from '../infra/gate';
import { BM25Stopwords, BM25_FN_CHARS } from '../lib/bm25';
import { WorldBookManager } from './worldbook';

interface ArchiveBlockL { id: string; text: string; ts?: number; head?: string }
// 事件行：稀有实体键控取回的存储单元。keys = 绑定实体（人物/场所/物品/事件名，原文用词）；
// quote = 事件在块中的逐字原句片段（定位用）。键频门控保证高频实体（如主角名）不触发注入。
interface CharEvent { keys: string[]; quote: string; text: string; blockId: string; ts: number }
interface ArchiveState { blocks: ArchiveBlockL[]; dict: string[]; dictVer: number; events?: CharEvent[]; keyFreq?: Record<string, number>; totalChars?: number }
interface WindowBlock { id: string; text: string }

// 词典词实体性：学「名字」不学「句法」——含虚字/指代/语气单字（的表情/这家伙/为什么）
// 的组合一律不算实体。真名几乎不含这些字。
// 内含停用 2 字组合的也丢，但末位豁免：「月之木学姊」「甘夏老师」的称谓后缀
// 不应导致全名被丢。整词是停用词（知道/什么）仍然直接拒。
function dictWordOk(w: string): boolean {
  if (BM25Stopwords.has(w)) return false;
  for (let i = 0; i < w.length; i++) {
    if (BM25_FN_CHARS.indexOf(w[i]) >= 0) return false;
  }
  for (let i = 0; i < w.length - 1; i++) {
    if (i === w.length - 2) continue; // 末位豁免（称谓后缀）
    if (BM25Stopwords.has(w.slice(i, i + 2))) return false;
  }
  return true;
}

// 2 字专名的末字黑名单：叙事常用词的收尾字（今天/之后/刚才/个人/视线/笑容…），
// 真 2 字名（小鞠/胡桃/柠檬/佳树）几乎不以外来尾字收束
const DICT2_SUFFIX = '天后才会人此意劲头容神露线影生光景色体物话声爱';

export const ArchiveStore = {
  _headProvider: null as ((blocks: { id: string; text: string }[]) => Promise<{ heads: Record<string, string>; events: { i: number; keys: string[]; quote: string; text: string }[] }>) | null,
  _enrichRunning: false,
  // IndexedDB 持久化（归档文本可达几十万字，超出 localStorage 舒适区）：
  // 启动时异步加载全部书的归档态到内存 Map，之后 get/_save 走内存 + 防抖写 IDB；
  // IDB 不可用时整体回落到原 localStorage 行为（测试环境/旧 WebView）。
  _idbOn: false,
  _idbDb: null as any,
  _idbReady: null as Promise<void> | null,
  _memByBook: null as Record<string, ArchiveState> | null,
  _saveTimer: null as ReturnType<typeof setTimeout> | null,
  _aliasCache: null as { sig: string; map: Record<string, string[]> } | null,

  initStorage(): Promise<void> {
    if (this._idbReady) return this._idbReady;
    const self = this;
    this._idbReady = (async function () {
      let db: any = null;
      try {
        const g = globalThis as any;
        if (!g.indexedDB) throw new Error('no idb');
        db = await new Promise(function (resolve, reject) {
          const open = g.indexedDB.open('novel-archive', 1);
          open.onupgradeneeded = function () { try { open.result.createObjectStore('states'); } catch (e) { /* 忽略 */ } };
          open.onsuccess = function () { resolve(open.result); };
          open.onerror = function () { reject(open.error || new Error('idb open failed')); };
        });
        const all = await new Promise<any>(function (resolve, reject) {
          const tx = db.transaction('states', 'readonly');
          const rq = tx.objectStore('states').getAll();
          rq.onsuccess = function () { resolve(rq.result || []); };
          rq.onerror = function () { reject(rq.error); };
        });
        const map: Record<string, ArchiveState> = {};
        (all || []).forEach(function (rec: any) { if (rec && rec.bookId && rec.state) map[rec.bookId] = rec.state; });
        self._memByBook = map;
        self._idbDb = db;
        self._idbOn = true;
      } catch (e) {
        self._idbOn = false; // 回落 localStorage（原行为）
      }
      // 迁移：localStorage 里的旧归档（含各书）一次性搬进 IDB，并释放本地配额
      if (self._idbOn) {
        try {
          const g2 = globalThis as { localStorage?: Storage };
          const ls = g2.localStorage;
          if (ls) {
            for (let i = ls.length - 1; i >= 0; i--) {
              const k = ls.key(i);
              if (!k || k.indexOf('lnw_archive_') !== 0) continue;
              const bookId = k.slice('lnw_archive_'.length);
              if (self._memByBook![bookId]) { ls.removeItem(k); continue; }
              try {
                const v = JSON.parse(ls.getItem(k) || 'null');
                if (v && v.blocks) {
                  self._memByBook![bookId] = v;
                  await new Promise(function (resolve: (v: void) => void, reject: (e: any) => void) {
                    const tx = self._idbDb.transaction('states', 'readwrite');
                    tx.objectStore('states').put({ bookId: bookId, state: v }, bookId);
                    tx.oncomplete = function () { resolve(); };
                    tx.onerror = function () { reject(tx.error); };
                  });
                  ls.removeItem(k);
                }
              } catch (e2) { /* 单书迁移失败不阻塞 */ }
            }
          }
        } catch (e) { /* 迁移失败不阻塞 */ }
      }
      // 存量词典清洗迁移：老用户持久化词典里已存有句法碎片（的表情/为什么…）
      try {
        const mapC = self._memByBook;
        if (mapC) { for (const bid in mapC) self._cleanDict(mapC[bid]); }
      } catch (e) { /* 清洗失败不阻塞 */ }
    })();
    return this._idbReady;
  },

  _bookId(): string {
    return (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId) ? (WorldBookManager.getActiveId() || 'none') : 'none';
  },
  _key(): string { return 'archive_' + this._bookId(); },
  get(): ArchiveState {
    if (this._idbOn && this._memByBook) {
      const id = this._bookId();
      if (!this._memByBook[id]) this._memByBook[id] = { blocks: [], dict: [], dictVer: 0 };
      return this._memByBook[id];
    }
    return SM().get<ArchiveState>(this._key(), { blocks: [], dict: [], dictVer: 0 }) ?? { blocks: [], dict: [], dictVer: 0 };
  },
  _save(s: ArchiveState): void {
    if (this._idbOn && this._memByBook) {
      this._memByBook[this._bookId()] = s;
      if (!this._saveTimer) {
        this._saveTimer = setTimeout(() => {
          this._saveTimer = null;
          try {
            const db = this._idbDb;
            if (!db) return;
            const tx = db.transaction('states', 'readwrite');
            const os = tx.objectStore('states');
            const map = this._memByBook || {};
            for (const bookId in map) os.put({ bookId: bookId, state: map[bookId] }, bookId);
          } catch (e) { /* 忽略 */ }
        }, 1500);
      }
      return;
    }
    SM().set(this._key(), s);
  },

  count(): number { return this.get().blocks.length; },

  // 注册头部/事件生成器（app 启动时注入，走现有 API 基建）；传 null 关闭
  setHeadProvider(fn: ((blocks: { id: string; text: string }[]) => Promise<{ heads: Record<string, string>; events: { i: number; keys: string[]; quote: string; text: string }[] }>) | null): void {
    this._headProvider = fn;
  },

  _keyCap(): number { const s = this.get(); return Math.max(10, Math.round((s.totalChars || 0) / 4000)); },

  // 归档后异步补头（fire-and-forget）：给缺头的块生成「场景｜在场人物｜事件」检索头。
  // 头只进索引文本，不改原文；生成失败下次滚动自动重试。
  _kickHeadEnrich(): void {
    if (this._enrichRunning || !this._headProvider) return;
    try { if (SM().get<boolean>('archiveHeadEnabled', true) === false) return; } catch (e) { /* 设置不可读则默认开 */ }
    const todo = this.get().blocks.filter(function (b) { return !b.head; });
    if (todo.length === 0) return;
    this._enrichRunning = true;
    const self = this;
    (async function () {
      const BATCH = 4;
      for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        const res = await self._headProvider!(batch.map(function (b) { return { id: b.id, text: b.text }; }));
        const s2 = self.get();
        let changed = false;
        const heads = (res && res.heads) || {};
        Object.keys(heads).forEach(function (id) {
          const b = s2.blocks.find(function (x) { return x.id === id; });
          if (b && !b.head && heads[id]) { b.head = String(heads[id]).slice(0, 120); changed = true; }
        });
        // 事件行：稀有实体键控的数据源（与头部同一次调用产出，零额外调用）
        const evs = (res && res.events) || [];
        const newEvents: CharEvent[] = [];
        evs.forEach(function (e) {
          const b = batch[e && e.i];
          if (!b || !e.text || !Array.isArray(e.keys)) return;
          const keys = e.keys.filter(function (k) { return typeof k === 'string' && k.length >= 2 && k.length <= 8; }).slice(0, 4);
          if (!keys.length) return;
          newEvents.push({ keys: keys, quote: String(e.quote || '').slice(0, 30), text: String(e.text).slice(0, 120), blockId: b.id, ts: Date.now() });
        });
        if (newEvents.length) {
          s2.events = (s2.events || []).concat(newEvents);
          if (s2.events.length > 400) s2.events = s2.events.slice(-400);
          // 键频统计：逐块累加（每块只富集一次 → 总和即全书频次），供召回时门控高频实体
          s2.keyFreq = s2.keyFreq || {};
          newEvents.forEach(function (ev) {
            const bt = (s2.blocks.find(function (x) { return x.id === ev.blockId; }) || { text: '' }).text;
            ev.keys.forEach(function (k) { s2.keyFreq![k] = (s2.keyFreq![k] || 0) + (bt.split(k).length - 1); });
          });
          changed = true;
        }
        if (changed) {
          s2.totalChars = (s2.totalChars || 0) + batch.reduce(function (sum, b) { return sum + b.text.length; }, 0);
          self._save(s2);
          if (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.invalidate) ArchiveIndex.invalidate();
        }
      }
      console.log('[Archive] 上下文头/事件补齐完成，累计头', self.get().blocks.filter(function (b) { return !!b.head; }).length, '/', self.get().blocks.length, '，事件行', (self.get().events || []).length);
    })().catch(function (e) { console.warn('[Archive] 头部生成失败（下次滚动重试）:', e); })
      .finally(function () { self._enrichRunning = false; });
  },

  addEvents(entries: { keys: string[]; quote?: string; text: string; blockId: string }[]): void {
    if (!entries || !entries.length) return;
    const s = this.get();
    s.events = (s.events || []).concat(entries.map(function (e) {
      return { keys: e.keys, quote: String(e.quote || '').slice(0, 30), text: String(e.text).slice(0, 120), blockId: e.blockId, ts: Date.now() };
    }));
    if (s.events.length > 400) s.events = s.events.slice(-400);
    this._save(s);
  },

  // 实体别名表：世界书条目名（剥括号、含关键词字段）→ 语料中验证过的简称/变体。
  // 例：条目「雨宫彩乃（高中）」→ 彩乃（原文以简称出现时，键控触发也能对上）。
  // 纯本地统计验证（归档文本出现 ≥2 次），零 API。签名变化才重算。
  aliasMap(): Record<string, string[]> {
    let wb: any = null;
    try { wb = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActive) ? WorldBookManager.getActive() : null; } catch (e) { wb = null; }
    const names: string[] = [];
    ((wb && wb.entries) || []).forEach(function (e: any) {
      if (!e || !e.name) return;
      names.push(String(e.name));
      String(e.keywords || '').split(/[,，;；]/).forEach(function (k: string) {
        const kk = k.trim();
        if (kk.length >= 2 && kk.length <= 8) names.push(kk);
      });
    });
    const blocks = this.get().blocks;
    const sig = names.join('|') + ':' + blocks.length + ':' + (blocks.length ? blocks[0].text.length : 0);
    if (this._aliasCache && this._aliasCache.sig === sig) return this._aliasCache.map;
    const corpus = blocks.map(function (b) { return b.text; }).join('\n');
    const map: Record<string, string[]> = {};
    names.forEach(function (full) {
      const base = full.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
      if (base.length < 2 || base.length > 8) return;
      const cands: string[] = [];
      if (base.length >= 3) { cands.push(base.slice(0, 2)); cands.push(base.slice(-2)); }
      if (base.length >= 4) cands.push(base.slice(-3));
      const ok = cands.filter(function (c) {
        if (c === base) return false;
        return corpus.split(c).length - 1 >= 2;
      });
      if (ok.length) map[base] = ok;
    });
    this._aliasCache = { sig: sig, map: map };
    return map;
  },

  // 查询词典通道的世界书实体：条目名（剥括号）+ 关键词直接进（用户手写的最高质量
  // 实体源，此前只用于键控层、事件行未归档时对 BM25 零贡献），aliasMap 再补语料
  // 验证过的简称/变体（彩乃 ↔ 雨宫彩乃（高中））。上限 200 防极端大世界书撑爆查询。
  wbQueryTerms(): string[] {
    const out: string[] = [];
    const push = function (w: string) {
      if (w && w.length >= 2 && out.indexOf(w) < 0) out.push(w);
    };
    try {
      const wb = (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActive) ? WorldBookManager.getActive() : null;
      ((wb && wb.entries) || []).forEach(function (e: any) {
        if (!e || !e.name) return;
        const base = String(e.name).replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '').trim();
        if (base.length >= 2 && base.length <= 12) push(base);
        String(e.keywords || '').split(/[,，;；]/).forEach(function (k: string) {
          const kk = k.trim();
          if (kk.length >= 2 && kk.length <= 8) push(kk);
        });
      });
    } catch (e) { /* 忽略 */ }
    const am = this.aliasMap();
    for (const k in am) {
      push(k);
      (am[k] || []).forEach(function (a: string) { push(a); });
    }
    return out.slice(0, 200);
  },

  // 稀有实体键控取回（分层）：指令点名的实体不受键频限制（摘要+quote 原文全量）；
  // 稀有键（键频 ≤ 门控）同全量；仅窗口触发的高频实体（主角名）只给摘要行（限量防刷屏）。
  // keys 匹配支持别名展开（彩乃 ↔ 雨宫彩乃（高中），由世界书条目名 + 语料频次验证生成）。
  recallEvents(text: string, opts?: { limit?: number; excludeBlockIds?: string[]; strongText?: string }): { keys: string[]; text: string; blockId: string; span: string; strong: boolean }[] {
    const s = this.get();
    const t = String(text || '');
    if (!t) return [];
    const ex = new Set((opts && opts.excludeBlockIds) || []);
    const strong = String((opts && opts.strongText) || '');
    const cap = this._keyCap();
    const kf = s.keyFreq || {};
    const amap = this.aliasMap();
    const scored = (s.events || []).flatMap(function (e) {
      if (e.blockId && ex.has(e.blockId)) return [];
      const effKeys: string[] = [];
      (e.keys || []).forEach(function (k) {
        effKeys.push(k);
        (amap[k] || []).forEach(function (a: string) { if (effKeys.indexOf(a) < 0) effKeys.push(a); });
      });
      const firing = effKeys.filter(function (k) {
        if (!k || k.length < 2 || kf[k] === undefined) return false;
        if (t.indexOf(k) < 0) return false;
        return (strong && strong.indexOf(k) >= 0) || kf[k] <= cap;
      });
      if (!firing.length) return [];
      const isStrong = !!strong && firing.some(function (k) { return strong.indexOf(k) >= 0; });
      const minF = Math.min.apply(null, firing.map(function (k) { return kf[k] === undefined ? 1 : kf[k]; }));
      return [{ e: e, firing: firing, minF: minF, isStrong: isStrong }];
    });
    scored.sort(function (a, b) { return (b.isStrong ? 1 : 0) - (a.isStrong ? 1 : 0) || a.minF - b.minF; });
    const limit = (opts && opts.limit) || 5;
    return scored.slice(0, limit).map(function (x) {
      const b = s.blocks.find(function (bk) { return bk.id === x.e.blockId; });
      let span = '';
      if (b && x.e.quote && (x.isStrong || x.minF <= cap)) {
        const pos = b.text.indexOf(x.e.quote);
        if (pos >= 0) span = b.text.slice(Math.max(0, pos - 300), Math.min(b.text.length, pos + x.e.quote.length + 300));
      }
      return { keys: x.firing, text: x.e.text, blockId: x.e.blockId, span: span, strong: x.isStrong };
    });
  },

  // 窗口文本中出现的稀有键（供查询侧 dict 加成：把实体名喂给 BM25 查询）
  rareKeysIn(text: string): string[] {
    const s = this.get();
    const t = String(text || '');
    const cap = this._keyCap();
    const kf = s.keyFreq || {};
    const out: string[] = [];
    Object.keys(kf).forEach(function (k) {
      if (k.length >= 2 && kf[k] <= cap && t.indexOf(k) >= 0 && out.indexOf(k) < 0) out.push(k);
    });
    return out;
  },

  // 滚动时归档一批块；对新增文本跑高频 n-gram，自动增补检索词典
  addBlocks(texts: string[], maxBlocks?: number): void {
    const s = this.get();
    texts.forEach(function (t) {
      s.blocks.push({ id: 'ab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), text: t, ts: Date.now() });
    });
    if (maxBlocks && s.blocks.length > maxBlocks) s.blocks = s.blocks.slice(-maxBlocks);
    if (this._learnDictionary(s, texts.join('\n'))) s.dictVer++;
    this._save(s);
    this._kickHeadEnrich();
  },

  clear(): void { SM().set(this._key(), { blocks: [], dict: [], dictVer: 0 }); },

  allBlocks(): ArchiveBlockL[] { return this.get().blocks; },
  dictWords(): string[] { return this.get().dict; },

  // 高频 n-gram（3~6 字）自动进词表——补「临时名词」盲区，零手动。
  // 实体性过滤见 dictWordOk；出现门槛随语料规模浮动（下限 4）——固定 ≥8 在短归档下
  // 会让真名过不了线，超长归档下垃圾组合反而更容易刷满。
  _learnDictionary(s: ArchiveState, joined: string): boolean {
    // 剔除「」对白后只学叙述文本：对白套语（谢谢你/没关系）不再混入检索词典
    const text = String(joined || '').replace(/「[^」]*」/g, ' ');
    const cn = text.replace(/[^\u4e00-\u9fff]/g, '');
    if (cn.length < 60) return false;
    const cnt: Record<string, number> = {};
    const cntFull2: Record<string, number> = {};
    const cntNar2: Record<string, number> = {};
    let i: number, n: number;
    for (n = 3; n <= 6; n++) {
      for (i = 0; i + n <= cn.length; i++) {
        const g = cn.slice(i, i + n);
        cnt[g] = (cnt[g] || 0) + 1;
      }
    }
    // 2 字专名单算：人名主要出现在对白里，叙述剥离会漏掉主要信号——
    // 全文计数必须从原始 joined 取（text 已剥离对白），门槛加倍 +
    // 「叙述中至少出现 5 次」验证（挡掉只活在对白里的套语：谢谢/拜托/抱歉；
    // 真实人名叙述计数实测 16~420，下限 5 很安全）
    const full = String(joined || '').replace(/[^\u4e00-\u9fff]/g, '');
    for (i = 0; i + 2 <= full.length; i++) {
      const g = full.slice(i, i + 2);
      cntFull2[g] = (cntFull2[g] || 0) + 1;
    }
    for (i = 0; i + 2 <= cn.length; i++) {
      const g = cn.slice(i, i + 2);
      cntNar2[g] = (cntNar2[g] || 0) + 1;
    }
    const minCnt = Math.max(4, Math.round(cn.length / 4000));
    const minCnt2 = Math.max(16, minCnt * 2);
    const before = s.dict.length;
    // 候选按长度降序：短 n-gram 若只是长实体的切分副产品（被已保留的长词包含、
    // 出现次数不超过它——见八奈/奈见杏 ← 八奈见杏菜，话说回 ← 话说回来）则不学；
    // 真短名（八奈见）因独立出现次数更多而保留。计数基准统一用叙述文本（含 2 字）。
    const countOf = (w: string) => (w.length >= 3 ? cnt[w] : cntNar2[w]) || 0;
    const cands = Object.keys(cnt).concat(Object.keys(cntFull2)).filter(function (w) {
      if (s.dict.indexOf(w) >= 0 || !dictWordOk(w)) return false;
      if (w.length === 2 && DICT2_SUFFIX.indexOf(w[1]) >= 0) return false;
      return w.length >= 3 ? cnt[w] >= minCnt : (cntFull2[w] >= minCnt2 && cntNar2[w] >= 5);
    });
    cands.sort(function (a, b) { return b.length - a.length; });
    const kept: string[] = [];
    for (const w of cands) {
      let sub = false;
      for (const v of kept) {
        if (v.indexOf(w) >= 0 && countOf(v) >= countOf(w)) { sub = true; break; }
      }
      if (!sub) kept.push(w);
    }
    kept.forEach(function (w) {
      s.dict.push(w);
      if (s.dict.length > 8000) s.dict = s.dict.slice(-8000);
    });
    return s.dict.length > before;
  },

  // 存量词典一次性清洗：旧版学习器把「的表情/为什么/这家伙」这类句法碎片学进了
  // 持久化词典，按新过滤规则清洗（有变化才 bump dictVer 触发索引重建）
  _cleanDict(s: ArchiveState): boolean {
    if (!s || !s.dict || !s.dict.length) return false;
    const cleaned = s.dict.filter(dictWordOk);
    if (cleaned.length === s.dict.length) return false;
    s.dict = cleaned;
    s.dictVer = (s.dictVer || 0) + 1;
    this._save(s);
    return true;
  },
};

interface WindowState { blocks: WindowBlock[]; x: number }

// 窗口块管理：正文切定长块（段落对齐）；窗口 = 前 N 块；append-only；
// 超触发线后从最旧块开始滚入归档，滚到 ≤ 水位线。
export const Waterline = {
  ROLLING: 5000,      // 滚动区（窗口之后、user 之前，固定保留原文）
  BLOCK_SIZE: 8000,   // 单块目标字符数
  // 不足则不追加（减少中间态）。这个值是**缓存的关键旋钮**（2026-09-25 实测，见 tools/cache-probe.mjs）：
  // 每吐一个新块，prompt 里「窗口」这段就在正文中间插入一段新文字 → 公共前缀断在插入处，
  // 其后的一切（回读块/滚动区/尾部小块）本轮全部按 miss 计费。1500 时几乎每次续写（1500~2500 字）
  // 都吐块，等于**每轮**都在中间插一刀；调到 ~4000（约 2 倍单次输出）后多数轮次窗口字节不变，
  // 整个 prompt 变成「只在末尾追加」→ 命中率才有机会上来。
  // 代价：窗口右缘跟进变慢，滚动区最长可到 ROLLING + MIN_APPEND；信息不丢（最新正文始终在滚动区里）。
  MIN_APPEND: 4000,

  _bookId(): string {
    return (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActiveId) ? (WorldBookManager.getActiveId() || 'none') : 'none';
  },
  _key(): string { return 'wline_' + this._bookId(); },
  get(): WindowState { return SM().get<WindowState>(this._key(), { blocks: [], x: 0 }) ?? { blocks: [], x: 0 }; },
  _save(s: WindowState): void { SM().set(this._key(), s); },

  _head(s: WindowState): number {
    let sum = 0;
    s.blocks.forEach(function (b) { sum += b.text.length; });
    return sum; // 块是 canonical 的精确连续子串（无人工分隔符），首部即总长
  },

  // 严格按偏移切块（不删任何字符），保证 块拼接 == canonical 的子串
  _splitBlocks(canonical: string, from: number, to: number): string[] {
    const out: string[] = [];
    let rest = canonical.slice(from, to);
    while (rest.length > this.BLOCK_SIZE) {
      let cut = this.BLOCK_SIZE;
      const nl = rest.indexOf('\n\n', cut);
      if (nl > cut && nl < cut + 600) cut = nl + 2;
      else { const nl2 = rest.lastIndexOf('\n', cut + 600); if (nl2 > 400) cut = nl2; }
      out.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest.length) out.push(rest);
    return out;
  },

  // 每轮生成前调用：维护「尾部锚定」窗口块并将最旧块分批滚入归档。
  // 窗口 = canonical[x .. x+head]，x 只在滚动时右移（仅滚动轮缓存失效一次）。
  // canonical 必须与上一轮相同来源（getFullNovelText 不截断）。
  update(canonical: string, waterChars: number, triggerChars: number): { frozen: string; head: number; blockCount: number; rolled: number; x: number } {
    canonical = String(canonical || '');
    const s = this.get();
    let changed = false;

    // 一致性：窗口内容（无分隔符拼接）必须等于 canonical[x .. x+head]
    let head = this._head(s);
    const joinedNow = s.blocks.map(function (b) { return b.text; }).join('');
    if (s.blocks.length > 0) {
      if (s.x + head > canonical.length || canonical.slice(s.x, s.x + head) !== joinedNow) {
        console.warn('[Waterline] 窗口与正文不一致（撤回/手改），重建');
        s.blocks = [];
        s.x = Math.max(0, canonical.length - this.ROLLING - waterChars);
        head = 0;
        changed = true;
      }
    } else if (s.x > canonical.length) {
      s.x = Math.max(0, canonical.length - this.ROLLING - waterChars);
      changed = true;
    }

    // 追加：窗口右边缘跟进到「正文末尾 - ROLLING」
    const rightLimit = Math.max(s.x + head, canonical.length - this.ROLLING);
    const newTextLen = rightLimit - (s.x + head);
    if (newTextLen >= this.MIN_APPEND) {
      const newBlocks = this._splitBlocks(canonical, s.x + head, rightLimit);
      newBlocks.forEach(function (b) {
        s.blocks.push({ id: 'wb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), text: b });
      });
      changed = true;
    }

    // 滚动（分批，仅超触发线才发生）：从最旧块开始入归档，直到窗口 ≤ 水位线
    const rolled: string[] = [];
    if (this._head(s) > triggerChars) {
      while (this._head(s) > waterChars && s.blocks.length > 1) {
        const rm = s.blocks.shift()!;
        rolled.push(rm.text);
        s.x += rm.text.length;
      }
    }
    if (rolled.length > 0) {
      ArchiveStore.addBlocks(rolled, 900);
      console.log('[Waterline] 滚动归档', rolled.length, '块（', rolled.reduce(function (a, b) { return a + b.length; }, 0), '字）→ 窗口左移 x=', s.x, '，归档累计', ArchiveStore.count(), '块');
    }
    if (changed || rolled.length) this._save(s);
    return {
      frozen: s.blocks.map(function (b) { return b.text; }).join('\n\n'),
      head: this._head(s),
      blockCount: s.blocks.length,
      rolled: rolled.length,
      x: s.x,
    };
  },

  clear(): void { SM().set(this._key(), { blocks: [], x: 0 }); },
};

const g = globalThis as unknown as { ArchiveStore: typeof ArchiveStore; Waterline: typeof Waterline };
g.ArchiveStore = ArchiveStore;
g.Waterline = Waterline;