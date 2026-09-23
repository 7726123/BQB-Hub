// ArchiveIndex：归档区索引（停用词 + 词典 trie 最长匹配 + 别名桥接 + 增量重建）。
// MemoryQueryBuilder：查询构造（实体词 + 罕见 bigram 短查询 + 判别词门控）。
// 迁移自 www/modules/bm25.js；外部管理器（DatabaseManager/WorldBookManager/
// ProtagonistManager/ArchiveStore）走裸标识符 + typeof 守卫（旧脚本顶层 const
// 不挂 globalThis 属性，裸标识符才能命中，详见 variables.ts 头注）。
// 注：原 BM25 主检索（TF-IDF/时间衰减/重要度）已随 STM 记忆检索退役移除，
// 仅保留 BM25.tokenize 供 QueryBuilder 分词复用。
import { WorldBookManager } from '../domain/worldbook';
import { ProtagonistManager } from '../domain/protagonist';
import { DatabaseManager } from '../domain/database';

interface ArchiveBlock { id: string; text: string; head?: string }
// 子块：BM25 的实际检索单元（块按段落边界切成 ~_childSize 字），
// start/end 是块内偏移，供 mergeSpans 从原块精确截取连续片段。
// head = 块的检索用上下文头（场景｜在场人物｜事件），只进索引文本、不进注入文本。
interface ArchiveChild { id: string; blockId: string; cIdx: number; start: number; end: number; text: string; head?: string }


export const BM25 = {
  /** 中文 bigram + 单字、英文单词分词 */
  tokenize(text: string): string[] {
    if (!text) return [];
    const lower = text.toLowerCase();
    const tokens: string[] = [];
    const enWords = lower.match(/[a-z0-9]+/g);
    if (enWords) tokens.push(...enWords);
    const cnChars = lower.match(/[一-鿿]/g);
    if (cnChars) {
      for (let i = 0; i < cnChars.length - 1; i++) {
        tokens.push(cnChars[i] + cnChars[i + 1]);
      }
      cnChars.forEach(function (c) { tokens.push(c); });
    }
    return tokens;
  }
};

// ==================== ArchiveIndex（归档区 BM25，v31）====================
interface Trie { _end?: boolean; [key: string]: Trie | boolean | undefined }

// 虚字/指代/语气单字（实体名几乎不含这些字）：n-gram 词典学习的实体性过滤用——
// 「的表情/为什么/这家伙」这类高频句法组合曾整批学进词典污染检索。
// 我/不/著/起/过：叙事动词短语与指代组合（我不/站起身/看著）的主干字。
// 注意：近/最/扭/遇/家 是叙事碎片主干，但也是真实体名末字（政近/最上/比企遇/家…
// ——「政近」就死于把「近」加入 FN_CHARS）。实体性过滤只看「首字/虚字中缀」，
// 末字必须豁免（称谓后缀同理）；碎片过滤（rareBigrams 等）另用词级停用表。
export const BM25_FN_CHARS = '的了着著是在这那他她它你我也啊吗呢吧呀哦喔么嘛什很就还都被把让给和与或但而及因所到对不起过个己际比';

export const BM25Stopwords = new Set([
  '我','你','他','她','它','我们','你们','他们','它们','自己','这','那','什么','怎么','哪个','这个','那个','哪些','这些','那些','谁','如何','为何','这种','那样','这样','这么','那么','那种',
  '的','了','着','过','得','地','啊','呀','吧','呢','哦','吗','哈','嗯','哎','咦','诶','咯','么','之','乎','亦','已',
  '和','并','以','而','及','与','或','在','把','被','让','对','到','上','下','中','里','将','因','因为','所以','如果','虽然','可是','但是','然而','就是','还是','但','却','因此','于是','不过','然后','接着','及至','以及','不论','无论','只有','只要','即使','哪怕','否则','不然','既然','由于','从而','此外','另外','同时',
  '就','都','才','又','也','会','能','不','没有','甚至','居然','仅','只','还有','时候','突然','十分','非常','有些','有点','一点','一下','一直','终于','已经','曾经','正在','再次','常常','偶尔','总是','立刻','马上','渐渐','逐渐','缓缓','几乎','大约','大概','确实','实在','真的','根本','完全','彻底','分别','各自','互相','纷纷','一起','一同','顿时','瞬间','忽然','猛然',
  '是','有','去','来','用','知道','觉得','感觉','开始','准备','继续','成为','变得','出现','离开','回到','来到','走向','听到','看到','说着','说道','想到','想起','感到','显得','仿佛','似乎','好像','也许','可能','其实','不禁','忍不住','微微','轻轻','静静','默默','喃喃','低低','淡淡','冷冷','狠狠',
  '个','段','些','种','丝','极其','一个','一些','一种','一丝','一段','一眼','一步','一声','一路','一夜','一时',
  // 词级叙事常用词：永远不可能是实体锚，却因 df 中低频会混进罕见 bigram 通道稀释实体信号
  // （时间/学生/看向/小说这类词 df 5~9，小语料下恰好落在 dfCap 窗口内）
  '时间','学生','意思','明明','小说','轻小','一面','看向','表情','语气','样子','家伙','平常','原本','身旁','句话','同意',
  // 称谓/泛指人称：出现极频繁且永远指不到具体实体（具体人物走词典/世界书通道）
  '老师','同学','先生','小姐','学姐','学妹','学姊','前辈','少女','少年',
  // 中频叙事副词/代词（3 字词，词典学习会学进来、stableEntities 里 cover=3 排最前）：
  // idf 1.1~1.4 只有真实体名一半，占实体名额 + ×2 权重纯属浪费
  '应该','可以','之前','原来','话说','时候','一下','起来','已经','现在','然后','觉得','知道','没有','这个','那个','自己','这样','那样','什么','怎么','也是','反正','接着','随后','于是','不过','因为','所以','如果','虽然','但是','然而','其实','当然','可能','大概','似乎','好像','终于','开始','继续','立刻','马上','渐渐','突然','忽然','顿时','瞬间','最后','结果','事情','问题','关系','感觉','想法','反应','样子','心情','声音','目光','视线','笑容','身影','脚步','气氛','走廊','教室','校舍','学校','社团','活动','回家','回去','进来','出去','站在','坐着','看着','听到','说道','心想','不禁','有点','一点','一些','一直','一定','一样','一起','一边','一面','一个','一种','一段','一句','一声','一眼','一步',
  '。','，','、','；','：','？','！','…','——','「','」','『','』','（','）',
]);

export const ArchiveIndex = {
  _sig: '',
  _blocks: [] as ArchiveBlock[],
  _children: [] as ArchiveChild[],
  _blkCache: {} as Record<string, { sig: string; items: { child: ArchiveChild; toks: string[] }[] }>,
  _trieSeq: 0,
  _lastTrieHash: -1,
  _hashStr(s: string): number { let h = 5381; for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; } return Math.abs(h); },
  _childSize: 800,
  _trie: null as Trie | null,
  /** 直收/别名用的实体 trie：精确实体源（世界书/DB 主键/主角名）优先，无建档则全量 */
  _directTrie: null as Trie | null,
  /** 实体统计缓存（df + 各子块 tf）：打分分词不用词表，实体没有倒排表 → 现场扫 + 缓存 */
  _entStats: {} as Record<string, { df: number; post: Record<string, number> }>,
  _alias: {} as Record<string, string[]>,
  _tokens: {} as Record<string, string[]>,
  _inv: {} as Record<string, Record<string, number>>,
  _df: {} as Record<string, number>,
  _dl: {} as Record<string, number>,
  _N: 0,
  _avgDl: 1,
  _byIdCache: null as Record<string, ArchiveChild> | null,

  /** 词典/别名源：数据库主键别名 + 世界书条目 + 主角名（typeof 守卫，未加载时跳过） */
  _extraDict(): { words: string[]; alias: Record<string, string[]> } {
    const words: string[] = [];
    const alias: Record<string, string[]> = {};
    try {
      if (typeof DatabaseManager !== 'undefined') {
        DatabaseManager.getTables().forEach(function (t) {
          const pk = DatabaseManager._primaryColumn(t);
          (DatabaseManager.getRecords(t.id) || []).forEach(function (r) {
            const v = String((r.values as Record<string, unknown>)[pk] || '');
            if (!v) return;
            const parts = v.split('|').map(function (x) { return x.trim(); }).filter(Boolean);
            if (!parts.length) return;
            parts.forEach(function (p) { if (p.length >= 2) words.push(p); });
            if (parts.length > 1) {
              parts.forEach(function (p) {
                alias[p] = (alias[p] || []);
                parts.forEach(function (q) { if (q !== p) alias[p].push(q); });
              });
            }
          });
        });
      }
      if (typeof WorldBookManager !== 'undefined' && WorldBookManager.getActive) {
        const wb = WorldBookManager.getActive();
        ((wb && wb.entries) || []).forEach(function (e) {
          if (e.name && e.name.length >= 2 && e.name.length <= 12) words.push(e.name);
          String(e.keywords || '').split(/[,，;；]/).forEach(function (k) {
            const kk = k.trim();
            if (kk.length >= 2 && kk.length <= 12) words.push(kk);
          });
        });
      }
      if (typeof ProtagonistManager !== 'undefined' && ProtagonistManager.getAll) {
        ProtagonistManager.getAll().forEach(function (p) {
          if (p.name && p.name.length >= 2) words.push(p.name);
        });
      }
    } catch (e) { console.warn('[Archive] extraDict:', e); }
    return { words: words, alias: alias };
  },

  /** 签名变化才整建（滚动/词表学习/DB/世设变化时） */
  ensureFresh(): void {
    if (typeof ArchiveStore === 'undefined') return;
    const s = ArchiveStore.get();
    const extra = this._extraDict();
    const headCount = s.blocks.filter(function (b) { return !!b.head; }).length;
    const sig = s.blocks.length + ':' + headCount + ':' + s.dict.length + ':' + s.dictVer + ':' + extra.words.length;
    if (this._sig === sig) return;
    console.log('[Archive] 重建索引：', s.blocks.length, '块 / 领域词', extra.words.length, '学习词', s.dict.length);
    this._build(s.blocks.slice(), s.dict.slice(), extra.words, extra.alias);
    this._sig = sig;
  },

  _buildTrie(words: string[]): Trie {
    const trie: Trie = {};
    words.forEach(function (w) {
      let node = trie;
      for (let i = 0; i < w.length; i++) {
        const c = w[i];
        if (!node[c]) node[c] = {};
        node = node[c] as Trie;
      }
      node._end = true;
    });
    return trie;
  },

  /** 索引粒度配置：childSize = 子块目标字数（默认 800）。
   *  设为极大值时每块退化为单子块（≈旧版整块索引，供 A/B 对比）。 */
  configure(opts?: { childSize?: number }): void {
    if (opts && opts.childSize && opts.childSize > 0) this._childSize = opts.childSize;
  },

  childCount(): number { return this._children.length; },

  /** 子块语料下的判别词 df 上限：检索单元比旧版大块多一个量级，窗口按单元数等比放大 */
  suggestDfCap(): number {
    return Math.min(200, Math.max(12, Math.round(this._children.length * 0.05)));
  },

  /** 块 → 子块：按段落（\n）边界累计到 _childSize 字；尾部过小段并入前一块防碎片。
   *  块内无换行则整块单子块。start/end 保留块内偏移（精确回切用）。 */
  _splitChildren(b: ArchiveBlock): ArchiveChild[] {
    const size = this._childSize;
    const text = b.text;
    const paras: { start: number; end: number }[] = [];
    let i = 0;
    while (i < text.length) {
      let nl = text.indexOf('\n', i);
      if (nl < 0) nl = text.length;
      if (text.slice(i, nl).trim().length > 0) paras.push({ start: i, end: nl });
      i = nl + 1;
    }
    if (paras.length === 0) {
      return text.trim() ? [{ id: b.id + '#0', blockId: b.id, cIdx: 0, start: 0, end: text.length, text: text, head: b.head }] : [];
    }
    const out: ArchiveChild[] = [];
    let s = -1, e = -1, len = 0, cIdx = 0;
    const flush = () => {
      if (s >= 0) {
        out.push({ id: b.id + '#' + cIdx, blockId: b.id, cIdx: cIdx, start: s, end: e, text: text.slice(s, e), head: b.head });
        cIdx++;
      }
      s = -1; e = -1; len = 0;
    };
    paras.forEach(function (p) {
      if (s < 0) s = p.start;
      if (len > 0 && len + (p.end - p.start) > size) flush();
      if (s < 0) s = p.start;
      e = p.end;
      len += (p.end - p.start) + 1;
    });
    flush();
    if (out.length >= 2) {
      const last = out[out.length - 1];
      if (last.text.length < 250) {
        const prev = out[out.length - 2];
        prev.end = last.end;
        prev.text = text.slice(prev.start, prev.end);
        out.pop();
      }
    }
    return out;
  },

  /** 相邻子块合并为连续片段（同块内 cIdx 连续），片段文本按偏移从原块精确截取，得分取成员最高 */
  mergeSpans(cands: { id: string; score: number }[]): { id: string; blockId: string; text: string; score: number; chars: number; start: number; end: number }[] {
    const byId: Record<string, ArchiveChild> = {};
    this._children.forEach(function (c) { byId[c.id] = c; });
    const blocksById: Record<string, ArchiveBlock> = {};
    this._blocks.forEach(function (b) { blocksById[b.id] = b; });
    const scoreById: Record<string, number> = {};
    cands.forEach(function (c) { scoreById[c.id] = c.score || 0; });
    const picked = cands
      .map(function (c) { return byId[c.id]; })
      .filter(Boolean)
      .sort(function (a, b) { return a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : a.cIdx - b.cIdx; });
    const groups: ArchiveChild[][] = [];
    // 合并长度上限（~2.5 个子块）：连排弱命中会拼出超长稀片段挤占注入预算，
    // 超过上限即断开另起片段
    const maxSpan = this._childSize * 2.5;
    picked.forEach(function (c) {
      const cur = groups[groups.length - 1];
      const curLen = cur ? cur[cur.length - 1].end - cur[0].start : 0;
      if (cur && curLen + (c.end - c.start) <= maxSpan
        && cur[cur.length - 1].blockId === c.blockId && c.cIdx === cur[cur.length - 1].cIdx + 1) cur.push(c);
      else groups.push([c]);
    });
    return groups.map(function (g) {
      const b = blocksById[g[0].blockId];
      const start = g[0].start, end = g[g.length - 1].end;
      const text = b ? b.text.slice(start, end) : g.map(function (x) { return x.text; }).join('\n');
      const score = Math.max.apply(null, g.map(function (x) { return scoreById[x.id] || 0; }));
      return { id: g[0].id, blockId: g[0].blockId, text: text, score: score, chars: text.length, start: start, end: end };
    });
  },

  _build(blocks: ArchiveBlock[], learned: string[], domain: string[], aliasMap: Record<string, string[]>): void {
    this._blocks = blocks;
    this._alias = aliasMap || {};
    this._tokens = {};
    this._inv = {};
    this._df = {};
    this._dl = {};
    this._byIdCache = null; // 索引重建后旧子块缓存失效（直收/别名查块必须走新 _children）
    // 词典清洗（v32）：自动学习词分三类处理——
    //  ① 领域词（世界书/DB 实体）本身永不丢；
    //  ② 学习词含领域词子串：去掉子串后的「剩余部分」若全是虚字/停用（的八奈见/八奈见的）
    //     → 碎片丢弃；剩余含实义字（八奈见杏菜 的「杏菜」）→ 合法扩展全名，保留。
    //     —— 不误杀真名：真名扩展永远含实义成分，碎片永远是「实体±纯虚字」。
    //  ③ 词首/词中含虚字单字（的表情）→ 丢弃；词尾豁免（真名收尾字：的了/之）；
    //     内含停用 2 字组合（为什么/说着）→ 丢弃；末位豁免（称谓后缀「学姊」）。
    const domainSet: Record<string, number> = {};
    domain.forEach(function (w) { if (w.length >= 2) domainSet[w] = 1; });
    const isFillerRest = function (rest: string) {
      if (!rest) return true;
      for (let k = 0; k < rest.length; k++) {
        const c = rest[k];
        if (BM25_FN_CHARS.indexOf(c) < 0 && !BM25Stopwords.has(c)) return false;
      }
      return true;
    };
    const cleanLearned: string[] = [];
    learned.forEach(function (w) {
      // ① 领域词本身永不丢
      if (domainSet[w]) { cleanLearned.push(w); return; }
      let bad = false;
      // ② 含领域词子串 → 剩余部分全虚字（的八奈见）碎片丢弃；含实义（八奈见杏菜）全名扩展保留
      for (const d in domainSet) {
        const pos = w.indexOf(d);
        if (pos < 0) continue;
        const rest = w.slice(0, pos) + w.slice(pos + d.length);
        if (!rest.length) continue;
        if (isFillerRest(rest)) { bad = true; break; }
      }
      if (!bad) {
        // ③ 词首/词中含虚字单字（的表情/八奈见的）丢弃——词尾豁免（真名收尾字）
        for (let i = 0; i < w.length - 1; i++) {
          if (BM25_FN_CHARS.indexOf(w[i]) >= 0) { bad = true; break; }
        }
      }
      if (!bad) {
        // ③ 内含停用 2 字组合（为什么/说着）丢弃；末位豁免（称谓后缀）
        for (let i = 0; i < w.length - 1; i++) {
          if (i === w.length - 2) continue;
          if (BM25Stopwords.has(w.slice(i, i + 2))) { bad = true; break; }
        }
      }
      if (!bad) {
        // ④ 学习词互相包含吸收（无领域词时）：长词 = 短词 + 纯虚字/停用 → 碎片丢弃
        //    （英梨梨的←英梨梨）；长词含实义 → 全名扩展保留（八奈见杏菜←八奈见）。
        //    与 ② 同判据（isFillerRest），只是来源换成已清洗的学习词。
        for (let j = 0; j < cleanLearned.length && !bad; j++) {
          const other = cleanLearned[j];
          if (other === w || w.length <= other.length) continue;
          const pos = w.indexOf(other);
          if (pos < 0) continue;
          const rest = w.slice(0, pos) + w.slice(pos + other.length);
          if (!rest.length) continue;
          if (isFillerRest(rest)) { bad = true; break; }
        }
      }
      if (!bad) cleanLearned.push(w);
    });
    // 注意：清洗后为空就是空——不退回未清洗的 learned（旧实现的兜底会把刚被丢弃的
    // 句法碎片「的表情/为什么」重新塞回 trie）。打分不依赖 trie，空表只意味着关掉
    // 实体识别/直收，不影响检索本身。
    const trieWords = domain.concat(cleanLearned);
    this._trie = this._buildTrie(trieWords);
    // 直收/键控用的实体 trie：优先「精确实体源」（世界书条目 + 数据库主键 + 主角名，
    // 即 domain），没有建档时才退回全量词表。实测（5 语料 4 场景）：实体源混入
    // 自动学习词会把「点名高频实体找最密一幕」从 28.0% 拉到 23.8%——学习词里
    // 混着高频框架词，会在直收的 byId（取各实体最大 tf）里互相顶掉对方的块。
    this._directTrie = this._buildTrie(domain.length ? domain : trieWords);
    // 子块切分（带缓存：未变更的块跳过重新切分/分词——长篇归档的重建热点），
    // BM25 以子块为检索单元（小块判别力更强，注入时可经 mergeSpans 合并回片段）
    const self = this;
    // 分词器版本 + trie 内容签名：v34 分词仍会用 trie 认整词（整词 + 词内 bigram 双写），
    // 所以词典增删必须让块缓存失效（世界书改一条 → 整词边界变 → 旧分词过期）。
    const trieSig = 'v34:' + this._hashStr(trieWords.join('|')) + ':' + trieWords.length;
    this._entStats = {};
    this._children = [];
    blocks.forEach(function (b) {
      const sig = b.id + '|' + b.text.length + '|' + (b.head || '').length + '|' + self._childSize + '|' + trieSig;
      let entry = self._blkCache[b.id];
      if (!entry || entry.sig !== sig) {
        const items: { child: ArchiveChild; toks: string[] }[] = [];
        self._splitChildren(b).forEach(function (ch) {
          items.push({ child: ch, toks: self.tokenize((ch.head ? ch.head + '\n' : '') + ch.text) });
        });
        entry = { sig: sig, items: items };
        self._blkCache[b.id] = entry;
      }
      entry.items.forEach(function (it) { self._children.push(it.child); });
    });
    this._tokens = {};
    let totalLen = 0;
    blocks.forEach(function (b) {
      const entry = self._blkCache[b.id];
      if (!entry) return;
      entry.items.forEach(function (it) {
        const toks = it.toks;
        self._tokens[it.child.id] = toks;
        self._dl[it.child.id] = toks.length;
        totalLen += toks.length;
        const tf: Record<string, number> = {};
        toks.forEach(function (t) { tf[t] = (tf[t] || 0) + 1; });
        const seen: Record<string, number> = {};
        toks.forEach(function (t) {
          if (seen[t]) return;
          seen[t] = 1;
          if (!self._inv[t]) self._inv[t] = {};
          self._inv[t][it.child.id] = tf[t];
          self._df[t] = (self._df[t] || 0) + 1;
        });
      });
    });
    this._N = this._children.length;
    this._avgDl = this._N ? totalLen / this._N : 1;
    // 缓存清理：只保留当前在册块
    const alive: typeof this._blkCache = {};
    blocks.forEach(function (b) { if (self._blkCache[b.id]) alive[b.id] = self._blkCache[b.id]; });
    this._blkCache = alive;
  },

  /** 打分分词：中文 bigram + 单字（过滤停用词）+ 英文词。
   *  **不做词典整词匹配**——v34 起词典只负责实体识别（matchEntities）、
   *  实体直收（searchDirect）与别名/查询实体展开，不再影响打分。
   *
   *  消融实测（10 语料 6 场景，逐题配对）：
   *   · 旧实现「整词吞掉词内 bigram」会让被召回实体**周围的其他词典词**变得过于锐利
   *     （词级 df 骤降 → idf 升高），稀释目标实体：退回纯 bigram 后「点名/提及高频
   *     实体 → 找回其最密一幕」段命中 72.5%→90.2%（10胜1负，p=0.012），
   *     「正文里提到旧专名 → 召回该专名首次出现的旧段落」77.1%（无线索时 27.6%）。
   *   · 代价：唯一低频专名（全书只出现一次）在**裸 BM25** 路径上变弱
   *     （独立题集 bm25_qb 78.6%→60.7%，p=0.013）；但生产链路含「点名必达」前置
   *     通道，实际影响不显著（96.4%→92.9%，56 题里差 2 题，p=0.5）。
   *   · 试过「整词 + 词内 bigram 双写」折中：无效且更差（bm25_qb 37.5%），已弃。 */
  tokenize(text: string): string[] {
    if (!text) return [];
    const toks: string[] = [];
    let i = 0;
    const len = text.length;
    while (i < len) {
      const c = text[i];
      if (/[\u4e00-\u9fff]/.test(c)) {
        const cnChar = /[\u4e00-\u9fff]/.test(text[i + 1] || '') ? text[i] + text[i + 1] : null;
        if (cnChar && !BM25Stopwords.has(cnChar)) toks.push(cnChar);
        const single = c;
        if (!BM25Stopwords.has(single)) toks.push(single);
        i++;
        continue;
      }
      if (/[a-z0-9]/i.test(c)) {
        const m = text.slice(i).match(/^[a-z0-9]+/i);
        if (m) { toks.push(m[0].toLowerCase()); i += m[0].length; continue; }
      }
      i++;
    }
    return toks;
  },

  /** 命中词典词（事实卡激活用）：正文里出现过的词典词（去重） */
  matchEntities(text: string): string[] {
    if (!text) return [];
    this.ensureFresh();
    return this._entitiesIn(text, this._trie);
  },

  /** 在文本里抽出 trie 中的词（最长匹配、去重）——事实卡激活与实体直收共用 */
  _entitiesIn(text: string, trie: Trie | null): string[] {
    const out: string[] = [];
    if (!text || !trie) return out;
    let i = 0;
    const len = text.length;
    while (i < len) {
      if (/[\u4e00-\u9fff]/.test(text[i])) {
        let node = trie;
        let best = -1;
        for (let j = i; j < len && j < i + 12; j++) {
          if (!node[text[j]]) break;
          node = node[text[j]] as Trie;
          if (node._end) best = j;
        }
        if (best >= i) { out.push(text.slice(i, best + 1)); i = best + 1; continue; }
      }
      i++;
    }
    const seen: Record<string, number> = {};
    return out.filter(function (w) { if (seen[w]) return false; seen[w] = 1; return true; });
  },

  /** 查询分词 + 别名双向展开。
   *  打分分词是纯 bigram，词典整词（藏书塔/霞之丘）不会成为 token——因此别名
   *  展开必须走 trie 扫描拿「查询里出现的词典整词」（v34 前依赖 token 命中，
   *  改分词后那条路会静默失效，数据库主键别名 藏书塔|书塔 就断了）。 */
  _queryTokens(query: string): string[] {
    this.ensureFresh();
    const base = this.tokenize(query);
    const alias = this._alias;
    const extra = base.slice();
    const push = function (w: string) { if (w && extra.indexOf(w) < 0) extra.push(w); };
    this._entitiesIn(String(query || ''), this._trie).forEach(function (w) {
      push(w);
      (alias[w] || []).forEach(push);
    });
    base.forEach(function (t) {
      if (alias[t]) alias[t].forEach(push);
    });
    return extra;
  },

  /** 子块 id → 子块（topDf 直收复用） */
  _byChildId(id: string): ArchiveChild | undefined {
    if (!this._byIdCache) {
      this._byIdCache = {};
      const cache = this._byIdCache;
      this._children.forEach(function (c) { cache[c.id] = c; });
    }
    return this._byIdCache[id];
  },

  _idf(t: string): number {
    const df = this._df[t] || 0;
    const N = this._N || 1;
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  },

  /** L2 单字可计分：非虚字（的/了/我/什…）才兜底，虚字单字无检索价值 */
  _singleOk(ch: string): boolean {
    return !!ch && ch.length === 1 && BM25Stopwords.has(ch) === false && BM25_FN_CHARS.indexOf(ch) < 0;
  },

  /** 实体统计（直收用）：df = 含该实体的子块数；post = 子块 id → 出现次数。
   *  打分分词是 bigram，实体没有倒排表 → 现场扫子块文本统计，按实体缓存
   *  （同一批常驻角色会跨轮反复命中，缓存后每次查询只扫新实体）。 */
  _entityStats(w: string): { df: number; post: Record<string, number> } | null {
    if (!w || w.length < 2) return null;
    const cached = this._entStats[w];
    if (cached) return cached;
    const post: Record<string, number> = {};
    let df = 0;
    for (const c of this._children) {
      const n = c.text.split(w).length - 1;
      if (n > 0) { post[c.id] = n; df++; }
    }
    const st = { df: df, post: post };
    this._entStats[w] = st;
    return st;
  },

  /** 实体直收：查询里出现的**精确实体**（世界书/数据库主键/主角名）中 df 高的那些
   *  （用户点名/稳定在场的常驻角色）idf 低、分数天花板低，靠 BM25 分数排不进候选
   *  ——直接按 tf 排序收录。
   *  条件：N ≥ 20（小语料下 BM25 分数本就区分良好，无需直收）、df ∈ [0.3N, 0.97N]
   *  ——覆盖主角/女主/常驻配角（小鞠 df 72/175=0.41、艾莉莎 65/70、政近 61/70）。
   *  df≈N（全书唯一场景词，如小语料里的 藏书塔）不是人名，走分数排序。
   *  df 下限**不能放宽**：实测放宽到 0.15N（并把 topK 提到 3）后，中频词挤进
   *  合格集合，而下面 byId 取的是"所有合格实体的最大 tf"，被点名实体的最密块
   *  会被别人的密集块顶掉——点名高频实体找"最密一幕"段命中 74.2%→64.5%。
   *  返回带 tf 标记的结果，供上层直接注入（不混 BM25 分数链）。 */
  _topDfQuery(queryText: string, N: number): string[] {
    if (N < 20) return [];
    const words = this._entitiesIn(String(queryText || ''), this._directTrie);
    const self = this;
    return words.filter(function (w: string) {
      if (w.length < 2) return false;
      const st = self._entityStats(w);
      if (!st) return false;
      return st.df >= N * 0.3 && st.df <= N * 0.97;
    });
  },

  /** 实体直收检索：按 tf 排序取前 topK 个子块（供 app.ts 直接注入，
   *  不参与 BM25 分数竞争）。返回 {id, blockId, text, score, cIdx}。
   *  ① topDf 取「最小名」：查询里 政近/政近露出/政近一 是重叠词典词，只留最小词；
   *  ② 每块 score = 单个 topDf 实体 tf 的最大值——查询常含多个稳定实体
   *  （政近+艾莉），跨实体相加会让「同时出现两人的块」虚高，名场面应按
   *  「该实体最密集」排（B2 政近×13 胜过 B6 政近×11+艾莉×N）。 */
  searchDirect(query: string, topK = 4): { id: string; blockId: string; text: string; score: number; cIdx: number }[] {
    this.ensureFresh();
    if (!String(query || '') || !this._directTrie) return [];
    const topDfAll = this._topDfQuery(query, this._N || 1);
    if (!topDfAll.length) return [];
    const topDf = topDfAll.filter(function (t) {
      return !topDfAll.some(function (u) { return u !== t && u.indexOf(t) >= 0 && u.length > t.length; });
    });
    const byId: Record<string, number> = {};
    const self = this;
    topDf.forEach(function (t) {
      const st = self._entityStats(t);
      if (!st) return;
      for (const id in st.post) {
        const tf = st.post[id];
        byId[id] = Math.max(byId[id] || 0, tf); // 取单个实体 tf 最大值，不跨实体相加
      }
    });
    const arr = Object.keys(byId).sort(function (a, b) { return byId[b] - byId[a]; }).slice(0, topK);
    return arr.map((id: string) => {
      const c = this._byChildId(id);
      return { id: id, blockId: c ? c.blockId : '', text: c ? c.text : '', score: byId[id], cIdx: c ? c.cIdx : 0 };
    });
  },

  search(query: string, topK?: number): { id: string; text: string; score: number }[] {
    this.ensureFresh();
    const qTokens = this._queryTokens(query || '');
    if (qTokens.length === 0) return [];
    const scores: Record<string, number> = {};
    const self = this;
    // 两遍打分：多字词先行；单字兜底——所在子块没有任何 ≥2 字词命中时才计分
    // （防与自己拆出的 bigram 重复计分）。非虚字单字（霞/雪）保留——它们是
    // 角色的单字简称；不再因「块内已有含该字的词典整词」而丢弃（消融实测：
    // 该门控在无指令场景压低召回，去掉后段命中 21.2%→25.0%）。
    const multi = qTokens.filter(function (t) { return t.length >= 2; });
    const singles = qTokens.filter(function (t) { return t.length === 1 && self._singleOk(t); });
    const pass = function (toks: string[], onlyEmpty: boolean) {
      toks.forEach(function (qt) {
        const post = self._inv[qt];
        if (!post) return;
        const idf = self._idf(qt);
        // 权重：普通词 1、单字 0.25。词典词不再享有 1.5× 加成——消融实测（5 语料
        // 4 场景）该加成在无指令场景为负、其余场景零效应；实体精度由「直收」通道
        // 负责，不靠打分倍率。
        const w = qt.length >= 2 ? 1 : 0.25;
        for (const id in post) {
          if (onlyEmpty && scores[id] !== undefined) continue; // 已有多字词命中 → 单字不计
          const tf = post[id];
          const dl = self._dl[id] || 1;
          const num = tf * (1.5 + 1);
          const den = tf + 1.5 * (1 - 0.75 + 0.75 * dl / (self._avgDl || 1));
          scores[id] = (scores[id] || 0) + w * idf * num / den;
        }
      });
    };
    pass(multi, false);
    pass(singles, true);
    const arr: { id: string; score: number }[] = [];
    for (const id in scores) arr.push({ id: id, score: scores[id] });
    arr.sort(function (a, b) { return b.score - a.score; });
    const byId: Record<string, ArchiveChild> = {};
    this._children.forEach(function (c) { byId[c.id] = c; });
    return arr.slice(0, topK || 5).map(function (r) {
      const c = byId[r.id];
      return { id: r.id, blockId: c ? c.blockId : '', text: c ? c.text : '', score: r.score, cIdx: c ? c.cIdx : 0 };
    });
  },

  invalidate(): void { this._sig = ''; },

  /** 调试/透明化用：与 search 完全相同的打分路径，但返回逐查询词的贡献分解
   *  （贡献 = idf × BM25 饱和项；idf 由该词在全部子块中的 df 稀有度决定） */
  searchDebug(query: string, topK?: number): { id: string; blockId: string; text: string; score: number; cIdx: number; terms: { token: string; tf: number; idf: number; contrib: number }[] }[] {
    this.ensureFresh();
    const qTokens = this._queryTokens(query || '');
    if (qTokens.length === 0) return [];
    const scores: Record<string, number> = {};
    const contrib: Record<string, { token: string; tf: number; idf: number; contrib: number }[]> = {};
    const self = this;
    // 与 search 同款两遍打分：单字只兜底（所在子块无 ≥2 字词命中才计分）
    const multi = qTokens.filter(function (t) { return t.length >= 2; });
    const singles = qTokens.filter(function (t) { return t.length === 1 && self._singleOk(t); });
    const pass = function (toks: string[], onlyEmpty: boolean) {
      toks.forEach(function (qt) {
        const post = self._inv[qt];
        if (!post) return;
        const idf = self._idf(qt);
        const w = qt.length >= 2 ? 1 : 0.25; // 同 search：词典词不再加成
        for (const id in post) {
          if (onlyEmpty && scores[id] !== undefined) continue;
          const tf = post[id];
          const dl = self._dl[id] || 1;
          const c = w * idf * (tf * (1.5 + 1)) / (tf + 1.5 * (1 - 0.75 + 0.75 * dl / (self._avgDl || 1)));
          scores[id] = (scores[id] || 0) + c;
          (contrib[id] = contrib[id] || []).push({ token: qt, tf: tf, idf: idf, contrib: c });
        }
      });
    };
    pass(multi, false);
    pass(singles, true);
    const arr: { id: string; score: number }[] = [];
    for (const id in scores) arr.push({ id: id, score: scores[id] });
    arr.sort(function (a, b) { return b.score - a.score; });
    const byId: Record<string, ArchiveChild> = {};
    this._children.forEach(function (c) { byId[c.id] = c; });
    return arr.slice(0, topK || 5).map(function (r) {
      const c = byId[r.id];
      const terms = (contrib[r.id] || []).sort(function (a, b) { return b.contrib - a.contrib; });
      return { id: r.id, blockId: c ? c.blockId : '', text: c ? c.text : '', score: r.score, cIdx: c ? c.cIdx : 0, terms: terms };
    });
  },

  /** 词在全部子块中的出现总次数（指令判别词排序用：出现越多=书中越重要的实体） */
  termCount(t: string): number {
    const post = this._inv[t];
    if (!post) return 0;
    let n = 0;
    for (const id in post) n += post[id];
    return n;
  },

  /** 最近一次 _build 的词频（df）：供 MemoryQueryBuilder 挑罕见词 */
  getDf(t: string): number { return this._df[t] || 0; }
};

// ==================== MemoryQueryBuilder（记忆检索专用查询生成器） ====================
// 实测数据驱动（261 块小说语料）：
//   · 整段 recentText 作查询：泛化 bigram 稀释，hit@3≈0.12，挖词不退；
//   · 判别性词（实体+罕见 bigram）+ 尾窗散文：含词 hit@3 0.08（尾窗是污染源）；
//   · 只留判别性词（无尾窗）：含词 hit@3 0.29 / hit@5 0.47 / hit@10 0.68。
// 结论：查询 = 实体词（词典最长匹配）+ 罕见 bigram（df 2..12 升序取前 N），不要原文窗。
export const MemoryQueryBuilder = {
  _buildTrie(words: string[]): Trie {
    const trie: Trie = {};
    words.forEach(function (w) {
      let node = trie;
      for (let i = 0; i < w.length; i++) {
        const c = w[i];
        if (!node[c]) node[c] = {};
        node = node[c] as Trie;
      }
      node._end = true;
    });
    return trie;
  },

  /** 词典最长匹配抽实体；dict 缺省时优先用 BM25 学习词表，其次 ArchiveIndex 领域词表 */
  extractEntities(text: string, dict?: string[]): string[] {
    if (!text) return [];
    let words = dict;
    if (!words) {
      try {
        if (typeof ArchiveIndex !== 'undefined') {
          words = ArchiveIndex._extraDict().words;
        }
      } catch (e) { /* 忽略 */ }
    }
    if (!words || words.length === 0) return [];
    const trie = this._buildTrie(words);
    const out: string[] = [];
    let i = 0;
    const len = text.length;
    while (i < len) {
      if (/[\u4e00-\u9fff]/.test(text[i])) {
        let node = trie;
        let best = -1;
        for (let j = i; j < len && j < i + 12; j++) {
          if (!node[text[j]]) break;
          node = node[text[j]] as Trie;
          if (node._end) best = j;
        }
        if (best >= i) { out.push(text.slice(i, best + 1)); i = best + 1; continue; }
      }
      i++;
    }
    const seen: Record<string, number> = {};
    return out.filter(function (w: string) { if (seen[w]) return false; seen[w] = 1; return true; });
  },

  /** 用户名点词条：识别所有常见包裹符号（「」『』“”‘’（）()【】〔〕［］[]｛｝{}〈〉《》<>），
   *  与用户习惯无关——不管点名写在哪种符号里都能被当"点名"对待。
   *  只认"短词条"（2~10 字、内部无标点）＝疑似点名/专名，取原词 + 其 bigram（索引 token 粒度）；
   *  整句旁白式长跨度不进查询（它们从不被剥掉，交给 rareBigrams/namedAnchors 常规通道即可，
   *  硬塞进来只会用旁白词挤占查询）。
   *  背景：rareBigrams/rareTermsMulti/rareSingles/namedAnchors 会把「」内文本当对白套语剥掉，
   *  本通道是唯一保留点名的通道（实测带引号点名 72%→9%，修复后 95%+）。 */
  bracketedTerms(text: string): string[] {
    const out: string[] = [];
    const src = String(text || '');
    const re = /[「『“‘（(【〔［\[｛{〈《＜<]([^」』”’）)】〕］\]｝}〉》＞>]{1,60})[」』”’）)】〕］\]｝}〉》＞>]/g;
    const push = function (w: string) { if (w && w.length >= 2 && out.indexOf(w) < 0) out.push(w); };
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const raw = m[1].trim();
      if (!raw || raw.length > 10) continue;                      // 长跨度 = 旁白，不按点名处理
      if (/[\s，。！？、；：,.!?;:—…]/.test(raw)) continue;          // 内含标点 = 不是词条
      push(raw);
      BM25.tokenize(raw).forEach(function (t: string) {
        if (t.length >= 2 && !BM25Stopwords.has(t) && out.indexOf(t) < 0) out.push(t);
      });
    }
    return out;
  },

  /** 向后兼容别名（原「」引号通道；现在等同于 bracketedTerms） */
  quotedTerms(text: string): string[] {
    return this.bracketedTerms(text);
  },

  /** 指令点名词条（"点名必达"专用通道的查询词）：符号包裹词条 ∪ 指令里的罕见词 ∪ 高频点名锚。
   *  三个来源各自覆盖一类"点名"：
   *   ① 包裹词条——用户亲手点的名（「」内文本会被 rareBigrams 系列当对白套语剥掉，这里是唯一保留通道）；
   *   ② 罕见词 df ≤ max(3, 5%N)——未登录专名（道具/地名）的唯一来源，词典学不到它们；
   *   ③ 高频锚 df > 8——用户直呼已知名字（主角名）。
   *  刻意不含"指令里的词典实体"：词典里混着框架词（角色/往事/下去），会把专用通道变成噪声通道
   *  （实测混入后 67.2% vs 纯罕见词 98.3%）。 */
  namedTerms(instruction: string, getDf?: (t: string) => number, getCount?: (t: string) => number, n?: number): string[] {
    const self = this;
    const out: string[] = [];
    const push = function (w: string) { if (w && w.length >= 2 && out.indexOf(w) < 0) out.push(w); };
    const rareCap = Math.max(3, Math.min(6, Math.round((n || 0) * 0.05) || 6));
    self.bracketedTerms(String(instruction || '')).forEach(push);
    if (instruction && getDf) {
      try { self.rareBigrams(instruction, getDf, 3, rareCap).forEach(push); } catch (e) { /* 忽略 */ }
      try { self.namedAnchors(instruction, getDf, 2, getCount).forEach(push); } catch (e) { /* 忽略 */ }
    }
    return out;
  },

  /** 非虚字单字召回：指令/窗口里的 CJK 单字，只要不是停用词、不是虚字（的/了/我/
   *  什…），就有可能是特定角色的简称（霞/雪/兰）——单字被 rareBigrams 的结构性
   *  2 字门槛挡在查询外，是「说霞却查不到霞之丘」的根源。df≥1（归档里确实存在）才收。 */
  rareSingles(text: string, getDf: (t: string) => number, maxRare = 4): string[] {
    if (!text) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    const src = String(text).replace(/「[^」]*」/g, ' ').replace(/[^\u4e00-\u9fff]/g, '');
    for (const c of src) {
      if (c.length !== 1 || seen.has(c)) continue;
      // 位置敏感虚字过滤：词尾虚字豁免（真名收尾字：的了/之）；词首/词中虚字仍排除
      // （「了」单字名场景极少，靠 df≥1 + 后续 trie 整词覆盖兜底，不额外硬拦）
      if (BM25Stopwords.has(c)) continue;
      seen.add(c);
      const d = getDf(c);
      if (d >= 1) out.push(c);
    }
    return out.slice(0, maxRare);
  },

  /** 罕见 bigram：df 1..dfCap 且非停用，按 df 升序取前 maxRare 个。
   *  含停用单字或虚字单字的 bigram（「及的」「了个」这类连接碎片）直接排除——
   *  它们 df 低纯粹因为碎片化，语义上无价值；df=1（只存在于一段旧文）是最强的
   *  「窗口↔旧文」独有锚点，必须纳入；df=0（归档中完全不存在）才排除。 */
  rareBigrams(text: string, getDf: (t: string) => number, maxRare = 8, dfCap = 12): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    // 剔除「」对白后取样：对白套语（谢谢你/没关系）不进判别词表
    BM25.tokenize(String(text || '').replace(/「[^」]*」/g, ' ')).forEach(function (t) {
      if (t.length !== 2 || BM25Stopwords.has(t) || seen.has(t)) return;
      if (BM25Stopwords.has(t[0]) || BM25Stopwords.has(t[1])) return; // 含停用单字的碎片
      if (BM25_FN_CHARS.indexOf(t[0]) >= 0 || BM25_FN_CHARS.indexOf(t[1]) >= 0) return; // 含虚字的碎片（己先/际出/比刚）
      seen.add(t);
      const d = getDf(t);
      if (d >= 1 && d <= dfCap) out.push(t);
    });
    out.sort(function (a, b) { return getDf(a) - getDf(b); });
    return out.slice(0, maxRare);
  },

  /** 指令点名锚：用户亲手打出的高频词（角色名等）。常规指令词限 df≤8；
   *  df 超限但 termCount 最高的 1~2 个保底入选——idf 低只说明「不挑剔块」，
   *  不意味着该从查询里消失；配额化后它们占独立名额，不会挤占别人。
   *  含虚字单字的 bigram（别扭/相遇/最近）直接排除——它们是叙事动词/副词碎片，
   *  不是实体名，进查询只会稀释意图。
   *  注意：收集范围不是 rareBigrams 的 bigram——3 字实体（英梨梨）的 bigram
   *  （英梨/梨梨）在索引里被 trie 整词吞掉、df=0，必须从原文分词找「实体整词」；
   *  2 字实体（胡桃）df 正常走 rareBigrams 即可。 */
  namedAnchors(instruction: string, getDf: (t: string) => number, cap = 2, getCount?: (t: string) => number): string[] {
    if (!instruction) return [];
    // ① 3 字以上：指令原文按词典 trie 分词，取 df>8 的整词（英梨梨/胡桃妹妹）
    //    ——若 ArchiveIndex 就绪可用其 tokenize，否则回退普通 bigram
    const trieToks: string[] = [];
    try {
      if (typeof ArchiveIndex !== 'undefined' && ArchiveIndex.ensureFresh && ArchiveIndex.tokenize) {
        ArchiveIndex.ensureFresh();
        const t = ArchiveIndex.tokenize(String(instruction).replace(/「[^」]*」/g, ' '));
        t.forEach(function (w) { if (w.length >= 2 && trieToks.indexOf(w) < 0) trieToks.push(w); });
      }
    } catch (e) { /* 回退 bigram */ }
    const tokPool = trieToks.length ? trieToks : this.rareBigrams(instruction, getDf, 999, 1e9);
    return tokPool
      .filter(function (t) {
        if (getDf(t) <= 8) return false;
        if (BM25_FN_CHARS.indexOf(t[0]) >= 0 || BM25_FN_CHARS.indexOf(t[1]) >= 0) return false;
        return true;
      })
      .sort(function (a, b) { return (getCount ? getCount(b) : 0) - (getCount ? getCount(a) : 0); })
      .slice(0, cap);
  },

  /** 子串出现次数（覆盖带数/带内频率统计用） */
  countOcc(text: string, w: string): number {
    if (!text || !w) return 0;
    let n = 0, i = 0;
    while ((i = text.indexOf(w, i)) >= 0) { n++; i += w.length; }
    return n;
  },

  /** 当前场景稳定实体：最近 3 带中出现在 ≥2 带的词典实体。
   *  无实体指令时的核心召回源——用户不点名时，「当前剧情的主角团」靠这里进查询。
   *  排序：覆盖带数 → 带内总次数 → df 升序（同覆盖下更稀有的优先）→ 词长。
   *  过滤只有 df ≥ 0.9N 的近似虚词（可以/朋友这类每块都有的无判别力词）——
   *  不做「低频/中频」下限：角色名的 df 区间与叙事词重叠，硬切下限会误伤
   *  低频角色（柠檬 df 20/176），且会随语料规模漂移。低频词靠 df 升序自然沉底。 */
  stableEntities(recentText: string, recentParts: string[], dict: string[], getDf: (t: string) => number, n?: number): string[] {
    const bands = [recentText].concat(recentParts || []).slice(0, 3).filter(Boolean);
    if (!bands.length || !dict || !dict.length) return [];
    const ubq = n ? n * 0.9 : Infinity;
    const self = this;
    const cands: Record<string, { cover: number; tf: number; df: number }> = {};
    bands.forEach(function (b) {
      const seen = new Set<string>();
      self.extractEntities(b, dict).forEach(function (w) {
        const e = (cands[w] = cands[w] || { cover: 0, tf: 0, df: getDf(w) });
        if (!seen.has(w)) { e.cover++; seen.add(w); }
        e.tf += self.countOcc(b, w);
      });
    });
    const out: string[] = [];
    Object.keys(cands).forEach(function (w) {
      const e = cands[w];
      if (e.df >= ubq || e.cover < 2) return;
      out.push(w);
    });
    out.sort(function (a, b) {
      const ea = cands[a], eb = cands[b];
      return eb.cover - ea.cover || eb.tf - ea.tf || ea.df - eb.df || b.length - a.length;
    });
    return out;
  },

  /** L3 单字→全名桥接：指令里的非虚字单字（霞）若是指典中某个实体的首字
   *  （霞之丘诗羽），把该实体全名一起加进查询——说「霞」= 想说霞之丘诗羽。
   *  只认首字（昵称 = 姓/名的首字模式），避免「雪」误射成含雪的组合词。
   *  边界过滤：实体首/末字若是单字停用词或虚字（霞之/之丘/可以 这类学习碎片）
   *  则丢弃——碎片会以「前缀匹配」混进来污染桥接。每字上限 3 个、全名优先。 */
  expandSingles(singles: string[], dict: string[]): string[] {
    if (!singles || !singles.length || !dict || !dict.length) return [];
    const out: string[] = [];
    const edgeOk = function (w: string) {
      const first = w[0];
      const last = w[w.length - 1];
      if (BM25Stopwords.has(first) || BM25_FN_CHARS.indexOf(first) >= 0) return false;
      if (BM25Stopwords.has(last) || BM25_FN_CHARS.indexOf(last) >= 0) return false;
      return true;
    };
    singles.forEach(function (c) {
      if (!c || c.length !== 1) return;
      const matches = dict.filter(function (w) {
        return w.length >= 2 && w.length <= 12 && w[0] === c && edgeOk(w);
      });
      matches.sort(function (a, b) { return b.length - a.length; });
      matches.slice(0, 3).forEach(function (w) { if (out.indexOf(w) < 0) out.push(w); });
    });
    return out;
  },

  /** 组装短查询：实体词典 + 指令判别词 + 窗口罕见词。
   *  指令是意图信号，单独成列：其 df≥1 的 bigram 按「书中出现总次数」降序保底入选
   *  （胡桃这类实体排最前，可怜这类一次性词沉底——解决并列时按位置取样的偏差），
   *  再以窗口罕见词（df 升序）补足。 */
  build(recentText: string, opts?: { dict?: string[]; getDf?: (t: string) => number; maxRare?: number; maxLen?: number; dfCap?: number; instruction?: string; getCount?: (t: string) => number; recentParts?: string[]; n?: number }): string {
    if (!recentText && !opts?.instruction) return '';
    const maxRare = opts?.maxRare ?? 8;
    const maxLen = opts?.maxLen ?? 160;
    const getDf = opts?.getDf || function () { return 0; };
    const getCount = opts?.getCount || null;
    const dfCap = opts?.dfCap ?? 12;
      // 实体通道：跨带稳定实体（当前场景主角团）领衔 → 指令点名 → 最新带 df-asc
      // （band0 前 6 + df 最高保底）→ band1 前 4。全局上限 12。
      // 稳定实体（覆盖 ≥2 带）是无指令时「最近上下文」的核心召回源，查询里再重复
      // 一次 = ×2 权重（稳定在场 = 隐式意图，等价于用户点名）。
      // df ≥ 0.9N 的近似虚词（可以/朋友）只对窗口来源过滤，指令点名/稳定实体不受影响；
      // band0 来源同样不滤（主角名八奈见全书高频 df 接近 N，滤掉会把当前场景主角
      // 挡在查询外——高频只说明「不挑剔块」，不说明「回忆时不重要」）。
      const ENT_CAP = 12;
    const nChildren = opts?.n || 0;
    const entSeen = new Set<string>();
    const entities: string[] = [];
    const pushEnts = (words: string[], skipUbiquitous: boolean, rareK: number, guaranteeTopDf: boolean) => {
      if (!words || !words.length) return;
      let list = words;
      if (skipUbiquitous && nChildren) list = words.filter(function (w) { return getDf(w) < nChildren * 0.9; });
      const ranked = list.slice().sort(function (a, b) {
        const da = getDf(a);
        const db = getDf(b);
        return da - db || b.length - a.length;
      });
      const take = ranked.slice(0, rareK);
      if (guaranteeTopDf && ranked.length > take.length) take.push(ranked[ranked.length - 1]);
      for (const w of take) {
        if (entities.length >= ENT_CAP) return;
        if (entSeen.has(w)) continue;
        entSeen.add(w);
        entities.push(w);
      }
    };
    // 指令点名词 = 两类保底锚（去重后重复追加到查询末尾 = 打分 ×2）：
    // ① 指令中出现的词典实体（extractEntities 视角，覆盖 3 字以上的多字名——
    //    它们的 bigram 在索引里被 trie 整词吞掉、df=0，rareBigrams 视角看不到）；
    // ② rareBigrams 视角 df>8 的高频 2 字词（主角名/高频角色名）
    // ③ 引号内的点名词条：最高优先级，排在最前（不被 160 字截断砍掉、也不被窗口实体挤走）
    const quoted = this.quotedTerms(opts?.instruction || '');
    quoted.forEach(function (w) { if (entities.length < ENT_CAP && !entSeen.has(w)) { entSeen.add(w); entities.push(w); } });
    let instEnts: string[] = [];
    let stableEnts: string[] = [];
    if (opts?.dict && opts.dict.length) {
      stableEnts = this.stableEntities(recentText, opts.recentParts || [], opts.dict, getDf, opts?.n);
      stableEnts.forEach(function (w) { if (entities.length < ENT_CAP && !entSeen.has(w)) { entSeen.add(w); entities.push(w); } });
      if (opts.instruction) {
        instEnts = this.extractEntities(opts.instruction, opts.dict);
        pushEnts(instEnts, false, ENT_CAP, false);
      }
      if (recentText) pushEnts(this.extractEntities(recentText, opts.dict), false, 6, true);
      const p1 = (opts.recentParts && opts.recentParts[0]) || '';
      if (p1) pushEnts(this.extractEntities(p1, opts.dict), true, 4, false);
    }
    // 指令通道：df≤8 常规判别词 5 个 + 指令点名锚（df 超限的高频词，保底 2 个）
    const instTerms = opts?.instruction
      ? this.rareBigrams(opts.instruction, getDf, 999, dfCap)
          .filter(function (t) { return getDf(t) <= 8; })
          .sort(function (a, b) { return (getCount ? getCount(b) : 0) - (getCount ? getCount(a) : 0); })
          .slice(0, 5)
      : [];
    // L1 单字召回：指令/窗口里的非虚字 CJK 单字（霞/雪）保底进查询——
    // 否则 rareBigrams 的 2 字结构门槛把单字简称系统性挡在查询外
    const instSingles = this.rareSingles(opts?.instruction || '', getDf, 4);
    const tailSingles = this.rareSingles(recentText || '', getDf, 2);
    // L3 单字→全名桥接：指令单字（霞）expand 成首字匹配的实体全名（霞之丘诗羽）——
    // 单字自身受 L2 兜底限制（块有整词命中时不加分），全名是真正的命中手段
    const bridgeEnts = (opts?.dict && opts.dict.length) ? this.expandSingles(instSingles, opts.dict) : [];
    const anchors = this.namedAnchors(opts?.instruction || '', getDf, 2, getCount || undefined);
    instEnts.forEach(function (w) { if (anchors.indexOf(w) < 0) anchors.push(w); });
    // 窗口通道 df 上限收紧：dfCap 全额下（小语料 dfCap≈子块数一半）叙事常用词
    // （时间/学生/看向 df 7~9）会大量混进查询稀释实体信号——窗口锚只取「真稀有」的词。
    const winDfCap = Math.max(3, Math.min(dfCap, 6));
    const rare = opts?.recentParts
      ? this.rareTermsMulti([recentText].concat(opts.recentParts), getDf, winDfCap, maxRare, opts?.getCount)
      : this.rareBigrams(recentText, getDf, maxRare, winDfCap);
    const seen = new Set<string>();
    const all = entities.concat(anchors, instSingles, bridgeEnts, tailSingles, instTerms, rare).filter(function (t) {
      if (!t || seen.has(t)) return false;
      seen.add(t);
      return true;
    });
    // 指令通道词与点名锚都在查询中出现两次 = 打分 ×2：指令是显式意图，
    // 应压过窗口背景词（否则窗口尾部高 tf 的偶然稀有碎片会盖掉用户点名的内容）。
    // 稳定实体同理 ×2（隐式意图）。桥接全名（霞→霞之丘诗羽）也 ×2。
    // dup 内部必须去重：同一词可能同时是 指令锚+稳定实体+桥接全名（小鞠），
    // 不去重会 ×3 甚至 ×4 膨胀，把查询阈值顶高、挤压其它实体块。
    const stableX = stableEnts.filter(function (t) { return seen.has(t) && anchors.indexOf(t) < 0 && bridgeEnts.indexOf(t) < 0; });
    const dup: string[] = [];
    [quoted, anchors, instTerms, stableX, bridgeEnts].forEach(function (arr) {
      (arr || []).forEach(function (t) {
        if (t && seen.has(t) && dup.indexOf(t) < 0) dup.push(t);
      });
    });
    // 世界书实体 ×2 权重：用户显式标注的领域实体（八奈见/小鞠）不受「全书高频 → idf 低」
    // 惩罚——idf 低只说明「不挑剔块」，不说明「回忆时不重要」。已进查询的世界书实体
    // 追加一次 = 打分 ×2（隐式意图，等价用户点名）；高频主角的查询贡献从 tf×idf 的低值
    // 抬到显式意图级别，单锚（家庭餐厅）+ 主角（八奈见）即可跨过评分门槛。
    // 判定来源是「近期上下文（recentText+recentParts+指令）里出现的世界书实体」——
    // 指令「她」没有八奈见字面，但最近续写里八奈见在场 = 用户正在写她 = 隐式意图。
    // 只对「已经进查询的实体」补 ×2，不无差别给世界书全量加权（世界书所有角色都在
    // 词典，全量 ×2 会把「路过」块也带虚高）。
    let wbX = 0;
    if (opts?.dict && opts.dict.length) {
      const wbPresent = this.extractEntities([recentText].concat(opts.recentParts || []).concat(String(opts.instruction || '')).join(' '), opts.dict)
        .filter(function (t) { return opts.dict!.indexOf(t) >= 0; });
      wbX = wbPresent.filter(function (t) { return seen.has(t) && dup.indexOf(t) < 0; }).length;
      // 世界书实体在查询里但还没 ×2 → 补进 dup；已 ×2（指令锚/稳定实体）不重复
      wbPresent.forEach(function (t) {
        if (t && seen.has(t) && dup.indexOf(t) < 0) dup.push(t);
      });
    }
    const q = all.concat(dup).join(' ');
    return q.length > maxLen ? q.slice(0, maxLen) : q;
  },

  /** 与文本共享的判别词命中数（强相关门槛用） */
  countTermHits(text: string, terms: string[]): number {
    let n = 0;
    for (const t of terms) { if (text.indexOf(t) >= 0) n++; }
    return n;
  },

  /** 多来源判别词：按 parts 优先级顺序收集罕见 bigram（df 1..dfCap），
   *  前面的来源（如用户指令）优先占用名额——避免长窗口把指令锚点挤出词表。
   *  同 rareBigrams：含停用单字的碎片排除。 */
  rareTermsMulti(parts: string[], getDf: (t: string) => number, dfCap: number, cap: number, getCount?: (t: string) => number): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    parts.forEach(function (p) {
      if (!p) return;
      const partTerms: string[] = [];
      // 同 rareBigrams：剔除「」对白后取样；虚字单字碎片（己先/际出/比刚）排除
      BM25.tokenize(String(p || '').replace(/「[^」]*」/g, ' ')).forEach(function (t) {
        if (t.length !== 2 || BM25Stopwords.has(t) || seen.has(t)) return;
        if (BM25Stopwords.has(t[0]) || BM25Stopwords.has(t[1])) return; // 含停用单字的碎片
        if (BM25_FN_CHARS.indexOf(t[0]) >= 0 || BM25_FN_CHARS.indexOf(t[1]) >= 0) return; // 含虚字的碎片
        seen.add(t);
        const d = getDf(t);
        if (d >= 1 && d <= dfCap) partTerms.push(t);
      });
      // 部内按「书中出现总次数」降序：人名/地名/术语等高频实词浮顶，碎片沉底
      if (getCount) partTerms.sort(function (a, b) { return getCount(b) - getCount(a); });
      partTerms.forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
    });
    return out.slice(0, cap);
  }
};

const g = globalThis as unknown as {
  BM25: typeof BM25;
  BM25Stopwords: Set<string>;
  ArchiveIndex: typeof ArchiveIndex;
  MemoryQueryBuilder: typeof MemoryQueryBuilder;
};
g.BM25 = BM25;
g.BM25Stopwords = BM25Stopwords;
g.ArchiveIndex = ArchiveIndex;
g.MemoryQueryBuilder = MemoryQueryBuilder;