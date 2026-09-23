// 上传世界书时的「检索元数据」生成：一次轻量 LLM 调用产出规范化简介 + 标签 + facet。
//
// 为什么需要：用户自己填的简介是写给人看的（常常只写剧情感受，不含题材/面向），
// 而助手找卡依赖这些词。实测（cardsearch-bench2）：把题材/面向/关系规范化写进可检索文本，
// 面向类问法（"有没有女性向的"）命中率从 40% 提升到 90%。
//
// 设计要点：
// - 输入只带「条目名 + 角色名 + 世界观摘要」，不带全文 → 一次调用几百 token，成本落在上传者自己的 key 上
// - 输出严格 JSON，解析失败/超时一律返回 null（上传照常进行，服务器还有机械抽取兜底）
// - 纯字符串处理，不依赖 DOM → 可单测

export interface WbMeta {
  summary: string;    // 规范化简介（面向检索：题材 + 面向 + 关系 + 主要角色 + 世界观关键词）
  genre: string;
  audience: string;   // 男性向 | 女性向 | 一般向
  relation: string;   // 纯爱 | BL | GL | 后宫 | 无恋爱线
  franchise: string;  // 同人原作名，原创留空
  nsfw: boolean;
  tags: string[];
}

const MAX_ENTRY_NAMES = 40;
const MAX_CHARS = 20;

/** 从世界书对象里抽出喂给模型的精简摘要（条目名 + 角色名 + 少量世界观正文） */
export function summarizeBookForMeta(book: any): string {
  const entries = Array.isArray(book && book.entries) ? book.entries : [];
  const byType: Record<string, number> = {};
  const names: string[] = [];
  const chars: string[] = [];
  const worldview: string[] = [];
  for (const e of entries) {
    const type = String((e && e.type) || '其他');
    byType[type] = (byType[type] || 0) + 1;
    const name = String((e && e.name) || '').trim();
    if (name) names.push(type + '·' + name.replace(/^姓名[:：]s*/, ''));
    if (type === '角色' && name) chars.push(name.replace(/^姓名[:：]\s*/, ''));
    if (type === '世界观' && worldview.length < 4) {
      worldview.push(name + '：' + String((e && e.content) || '').replace(/\s+/g, ' ').slice(0, 80));
    }
  }
  const words = entries.reduce((s: number, e: any) => s + String((e && e.content) || '').replace(/\s/g, '').length, 0);
  return [
    '条目类型统计：' + Object.entries(byType).map(([k, v]) => k + ' ' + v + ' 条').join('，'),
    '正文字数：约 ' + words + ' 字',
    '角色名：' + chars.slice(0, MAX_CHARS).join('、'),
    '条目标题：' + names.slice(0, MAX_ENTRY_NAMES).join('、'),
    worldview.length ? '世界观摘要：\n- ' + worldview.join('\n- ') : '',
  ].filter(Boolean).join('\n');
}

/** 生成提示词（system + user 两条） */
export function buildWbMetaPrompt(title: string, desc: string, book: any): { system: string; user: string } {
  const system = [
    '你是世界书检索元数据生成器。读一份世界书的标题、作者简介与结构摘要，输出用于「站内检索与推荐」的结构化标签。',
    '严格只输出一个 JSON 对象，不要解释文字、不要 markdown 围栏。字段：',
    '{',
    '  "summary": "80-140 字的规范化简介：必须写清【题材】【面向读者】【关系取向】【主要角色名】【世界观关键词】【篇幅】，语言平实、便于检索；不要剧透结局，不要抒情",',
    '  "genre": "题材，两到六字，如 校园日常/剑与魔法/赛博朋克/克苏鲁恐怖/武侠仙侠/异世界转生/恋爱喜剧/悬疑推理/废土末日/历史架空",',
    '  "audience": "男性向 或 女性向 或 一般向（三选一；BL/乙女/女性主角恋爱线通常为女性向）",',
    '  "relation": "纯爱 或 BL 或 GL 或 后宫 或 无恋爱线（五选一）",',
    '  "franchise": "如果是同人，填原作名；原创填空字符串",',
    '  "nsfw": true 或 false（是否含成人向内容；只填布尔值，不要写任何露骨描述）",',
    '  "tags": ["6-10 个检索标签：题材、世界观元素、受众、关系、篇幅感、原作名等"]',
    '}',
    '规则：只依据给定信息推断，不确定就选更中性的选项（面向=一般向，关系=无恋爱线）；不要编造不存在的角色或作品名。',
  ].join('\n');
  const user = [
    '标题：' + String(title || '').slice(0, 60),
    '作者填写的简介：' + (String(desc || '').trim() || '（未填写）'),
    '结构摘要：',
    summarizeBookForMeta(book),
  ].join('\n');
  return { system, user };
}

/** 解析模型输出（容错：剥围栏、取第一个 JSON 对象、裁字段、校验枚举） */
export function parseWbMeta(text: string): WbMeta | null {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let candidate = raw.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = candidate.indexOf('{');
  if (start < 0) return null;
  for (let end = candidate.length; end > start; end--) {
    try {
      const o = JSON.parse(candidate.slice(start, end));
      if (!o || typeof o !== 'object') continue;
      const str = (v: unknown, n: number) => String(v == null ? '' : v).trim().slice(0, n);
      const aud = str(o.audience, 8);
      const rel = str(o.relation, 8);
      const tags = Array.isArray(o.tags)
        ? o.tags.map((t: unknown) => str(t, 12)).filter(Boolean).slice(0, 12)
        : [];
      const summary = str(o.summary, 200);
      if (!summary && !tags.length) continue;
      return {
        summary,
        genre: str(o.genre, 12),
        audience: ['男性向', '女性向', '一般向'].includes(aud) ? aud : '一般向',
        relation: ['纯爱', 'BL', 'GL', '后宫', '无恋爱线'].includes(rel) ? rel : '无恋爱线',
        franchise: str(o.franchise, 40),
        nsfw: o.nsfw === true,
        tags,
      };
    } catch (e) { /* 继续缩短右边界 */ }
  }
  return null;
}
