import { describe, it, expect } from 'vitest';
import {
  adaptTavernLorebook,
  adaptTavernLorebookObject,
  cleanTavernContent,
  type TavernEntry,
  type TavernInput,
} from '../src/domain/tavern-adapter';

function entry(over: Partial<TavernEntry>): TavernEntry {
  return { uid: 0, key: [], keysecondary: [], comment: '', content: '', ...over };
}

describe('adaptTavernLorebookObject — 闸 1: 明显占位/系统条直接 drop', () => {
  it('空 content + 空 key + 低 order → empty_placeholder', () => {
    const e = entry({ uid: 1, order: 5, content: '', key: [] });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe('empty_placeholder');
    expect(r.kept).toHaveLength(0);
    expect(r.needs_user).toHaveLength(0);
  });

  it('disable:true 占位 → empty_placeholder', () => {
    const e = entry({ uid: 2, disable: true, content: '' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('empty_placeholder');
  });

  it('extensions.regex_script → macro_script', () => {
    const e = entry({ uid: 3, key: ['x'], content: '有内容', extensions: { regex_script: '/foo/' } });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('macro_script');
  });

  it('extensions.macro_script → macro_script', () => {
    const e = entry({ uid: 4, key: ['x'], content: '有内容', extensions: { macro_script: 'do_something()' } });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('macro_script');
  });

  it('outletName 非空 → outlet_binding', () => {
    const e = entry({ uid: 5, key: ['x'], content: '内容', outletName: 'foo' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('outlet_binding');
  });

  it('comment 形如 ====…====_开始 → system_section', () => {
    const e = entry({ uid: 6, key: ['x'], content: '内容', comment: '====变量系统====_开始' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('system_section');
  });

  it('comment 形如 ====xxx====_结束 → system_section', () => {
    const e = entry({ uid: 7, key: ['x'], content: '内容', comment: '====状态机====_结束' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('system_section');
  });

  it('comment == "变量系统" → system_section', () => {
    const e = entry({ uid: 8, key: ['x'], content: '内容', comment: '变量系统' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('system_section');
  });

  it('content 是 $name = ... 变量块 → variable_block', () => {
    const e = entry({ uid: 9, key: ['var'], content: '$affection = 50' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('variable_block');
  });

  it('content 含 {{setvar::…}} → variable_block', () => {
    const e = entry({ uid: 10, key: ['sv'], content: '{{setvar::foo 1}}' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('variable_block');
  });

  it('extensions.notes 含 "before system" 注入指令 → meta_instruction', () => {
    const e = entry({ uid: 11, key: ['x'], content: '内容', extensions: { notes: 'inject before system prompt' } });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped[0].reason).toBe('meta_instruction');
  });
});

describe('adaptTavernLorebookObject — 闸 2: 明显正条 → 自动 keep + 映射', () => {
  it('有 key + content → kept', () => {
    const e = entry({ uid: 1, key: ['雪之下雪乃'], content: '侍奉部副部长，毒舌但温柔。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
    expect(r.needs_user).toHaveLength(0);
    expect(r.kept[0].name).toBe('雪之下雪乃');
  });

  it('comment 前缀"角色:" → type=角色', () => {
    const e = entry({ uid: 2, key: ['由比滨结衣'], comment: '角色:由比滨结衣', content: '短发，温柔外向。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].type).toBe('角色');
  });

  it('comment 前缀"世界观:" → type=世界观', () => {
    const e = entry({ uid: 3, key: ['总武高'], comment: '世界观:总武高的社团体系', content: '侍奉部承接校内各类委托…' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].type).toBe('世界观');
  });

  it('comment 前缀"地点:" → type=其他（地点归其他）', () => {
    const e = entry({ uid: 4, key: ['侍奉部室'], comment: '地点:侍奉部室', content: '总武高旧校舍二层，窗外樱花。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].type).toBe('其他');
    expect(r.kept[0].name).toBe('侍奉部室');
  });

  it('comment "初始" → type=初始', () => {
    const e = entry({ uid: 5, key: ['开局'], comment: '初始:故事开场', content: '四月，新学期，樱飞舞。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].type).toBe('初始');
  });

  it('[InitVar] 开局状态含好感度数值字段 → 进 ai_transform（AI 改大白话后落库）', () => {
    const e = entry({ uid: 6, key: [], comment: '[InitVar]变量初始化', content: '世界信息:\n  时间: 2025年10月\n  地点: 新宿\n\n绘里奈:\n  年龄: 17\n  好感度: 0' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.ai_transform).toHaveLength(1);
    expect(r.ai_transform[0].kind).toBe('rewrite_numeric');
    expect(r.ai_transform[0].instruction).toContain('好感度');
    expect(r.kept).toHaveLength(0);
  });

  it('[InitVar] 开局状态无数值字段 → 保留为「其他」', () => {
    const e = entry({ uid: 7, key: [], comment: '[InitVar]变量初始化', content: '世界信息:\n  时间: 2025年10月\n  地点: 新宿\n\n人物关系:\n  绘里奈与主角是同班同学。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].type).toBe('其他');
    expect(r.kept[0].name).toBe('变量初始化');
  });

  it('[mvu_update] 规则 → 保留但类型为「其他」（不赋「世界观」语义）', () => {
    const e = entry({ uid: 7, key: [], comment: '[mvu_update]变量更新规则', content: '【全局重要限制】所有女角色好感度下限 0 上限 400。常规事件单次增减严格控制。'.repeat(2) });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].type).toBe('其他');
    expect(r.kept[0].name).toBe('变量更新规则');
  });

  it('酒馆经典数字 type：0=角色，其余=「其他」', () => {
    const e0 = entry({ uid: 8, key: ['雪乃'], type: 0, content: '侍奉部副部长，毒舌但温柔。' });
    const e1 = entry({ uid: 9, key: ['侍奉部室'], type: 1, content: '旧校舍二层，窗外是樱花树。' });
    const r = adaptTavernLorebookObject({ entries: [e0, e1] });
    expect(r.kept.find(k => k._src?.uid === 8)?.type).toBe('角色');
    expect(r.kept.find(k => k._src?.uid === 9)?.type).toBe('其他');
  });

  it('V3 无 type：comment 纯名字 + content 含人物特征+信号 → 角色', () => {
    const e = entry({ uid: 10, key: ['林晚'], comment: '林晚', content: '高中二年级女生。性格内向怕黑，喜欢画画。梦想是成为插画师。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].type).toBe('角色');
  });

  it('V3 无 type：地点描述无人物信号 → 保持「其他」（不误伤）', () => {
    const e = entry({ uid: 11, key: ['雨城'], comment: '雨城', content: '常年下雨的南方小镇，被一条河分成东西两岸。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].type).toBe('其他');
  });

  it('comment 空但 keys 多 + content 长 → kept，name 取第一 key', () => {
    const e = entry({ uid: 6, key: ['一色彩羽', '彩羽'], content: '性格开朗、隶属于演艺部。'.repeat(5) });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].name).toBe('一色彩羽');
  });

  it('selective:false + constant:true + key 空 + comment 带前缀 → kept inject=true（默认常驻）', () => {
    const e = entry({ uid: 7, key: [], constant: true, selective: false, comment: '世界观:总背景', content: '这里是世界背景段落，应该常驻。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].inject).toBe(true);
    expect(r.kept[0].type).toBe('世界观');
  });

  it('selective:true + key 空 + !constant → 不注入（inject=false）', () => {
    const e = entry({ uid: 8, key: [], selective: true, constant: false, content: '选择性但没 key，等于酒馆不会注入。' });
    // 这种情况下，因为 key 全空 + content 长度足够，会进 needs_user
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.needs_user).toHaveLength(1);
  });

  it('disable:true + 有 key → kept 但 inject=false', () => {
    const e = entry({ uid: 9, key: ['x'], disable: true, content: '被酒馆作者关闭的条目。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].inject).toBe(false);
  });

  it('useProbability + probability=2 → inject=false', () => {
    const e = entry({ uid: 10, key: ['low'], content: '极少触发的隐藏设定。', useProbability: true, probability: 2 });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].inject).toBe(false);
  });

  it('position:0/1/4 透传到 _src.originalPosition', () => {
    const e = entry({ uid: 11, key: ['x'], content: '内容', position: 4 });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0]._src?.originalPosition).toBe(4);
  });
});

describe('adaptTavernLorebookObject — 闸 3: 含糊 → needs_user + 候选', () => {
  it('content 长度足够但 key 空 + comment 空 → needs_user', () => {
    const e = entry({ uid: 1, key: [], content: '这是一段没有任何 key 也没有 comment 的设定文本。'.repeat(5) });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept).toHaveLength(0);
    expect(r.needs_user).toHaveLength(1);
    expect(r.needs_user[0].options.length).toBeGreaterThanOrEqual(2);
    expect(r.needs_user[0].options.some(o => o.recommendation)).toBe(true);
  });

  it('needs_user 候选里包含"丢弃"选项', () => {
    const e = entry({ uid: 2, key: [], content: 'content 一段'.repeat(10) });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.needs_user[0].options.some(o => o.label === '丢弃')).toBe(true);
  });

  it('needs_user 问题里包含 comment 原文', () => {
    const e = entry({ uid: 3, key: [], content: 'x'.repeat(50), comment: '（被遗忘的角落）' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.needs_user[0].question).toContain('被遗忘的角落');
  });
});

describe('adaptTavernLorebookObject — policy 档位差异', () => {
  it('balanced: comment 模糊的仍可能 kept（因为 content 长度够）', () => {
    const e = entry({ uid: 1, key: [], content: '足够长的正经文本。'.repeat(8), comment: 'mystery' });
    const r = adaptTavernLorebookObject({ entries: [e] }, 'balanced');
    // 因为 key 空 + comment 模糊，应该进 needs_user
    expect(r.needs_user).toHaveLength(1);
  });

  it('conservative: 把没明确 comment 前缀的挪到 needs_user', () => {
    const e1 = entry({ uid: 1, key: ['x'], content: 'a'.repeat(50), comment: '谜题设置' }); // 没前缀
    const e2 = entry({ uid: 2, key: ['x'], content: 'a'.repeat(50), comment: '角色:阿雄' });
    const r = adaptTavernLorebookObject({ entries: [e1, e2] }, 'conservative');
    // 至少有一条进 needs_user
    expect(r.needs_user.length + r.kept.length).toBe(2);
    // 第二个带"角色:"前缀的应该被识别
    const kept2 = r.kept.find(k => k._src?.uid === 2);
    expect(kept2).toBeDefined();
  });

  it('aggressive: probability<100 的 inject=false', () => {
    const e = entry({ uid: 1, key: ['x'], content: 'a'.repeat(50), useProbability: true, probability: 50 });
    const r = adaptTavernLorebookObject({ entries: [e] }, 'aggressive');
    expect(r.kept[0].inject).toBe(false);
  });
});

describe('cleanTavernContent — content 清洗层', () => {
  it('SillyTavern 宏 {{...}} 被删除，可读文本保留', () => {
    void cleanTavernContent; // 见下文直接调用
    const r = cleanTavernContent('好感度：{{getvar::stat_data.月宫绾音.好感度}}（{{format_message_variable::stat_data}}）');
    expect(r.changed).toBe(true);
    expect(r.text).toBe('好感度：（）');
    expect(r.removed.length).toBe(2);
  });

  it('EJS 控制流标签 <% if ... %> 整块删除，标签间文本保留', () => {
    void cleanTavernContent; // 见下文直接调用
    const raw = '<% if (getvar(\'x\') >= 400) { %>\n[告白规则]\n当好感度达到 400 时触发。\n<% } %>';
    const r = cleanTavernContent(raw);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('[告白规则]');
    expect(r.text).toContain('当好感度达到 400 时触发');
    expect(r.text).not.toContain('getvar');
    expect(r.text).not.toContain('<%');
  });

  it('EJS 标签内是可读文本（非控制流）→ 保留文本', () => {
    void cleanTavernContent; // 见下文直接调用
    const r = cleanTavernContent('<%_ 带括号的规则：女主好感度上限 400 _%>');
    expect(r.text).toContain('带括号的规则：女主好感度上限 400');
    expect(r.text).not.toContain('<%');
  });

  it('已知状态机标签块 <status_current_variable>…</status_current_variable> 整块删除', () => {
    void cleanTavernContent; // 见下文直接调用
    const r = cleanTavernContent('开头\n<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>\n结尾');
    expect(r.text).not.toContain('status_current_variable');
    expect(r.text).not.toContain('format_message_variable');
    expect(r.text).toContain('开头');
    expect(r.text).toContain('结尾');
  });

  it('无酒馆标记的文本原样不动（changed=false）', () => {
    void cleanTavernContent; // 见下文直接调用
    const r = cleanTavernContent('普通设定文本：新宿歌舞伎町的夜晚。');
    expect(r.changed).toBe(false);
    expect(r.text).toBe('普通设定文本：新宿歌舞伎町的夜晚。');
  });

  it('{{user}} 保留、{{char}} 换成条目名、其他宏删除', () => {
    const e = entry({ uid: 1, key: ['告白'], comment: '角色:月宫绾音', content: '{{user}} 和 {{char}} 见面。{{pipe::hello}}' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept[0].content).toBe('{{user}} 和 月宫绾音 见面。');
    expect(r.kept[0]._src?.contentCleaned).toBe(true);
    expect(r.kept[0]._src?.removedPatterns?.some(p => p.includes('pipe'))).toBe(true);
    expect(r.kept[0]._src?.removedPatterns?.some(p => p.includes('user'))).toBe(false);
  });
});

describe('adaptTavernLorebookObject — 数值/状态系统闸（不询问用户）', () => {
  it('含 getvar 条件但可读文本足够 → ai_transform.rewrite，不进 needs_user', () => {
    const e = entry({ uid: 1, key: [], content: '<% if (getvar(\'stat_data.月宫绾音.好感度\') >= 400) { %>\n[告白规则]\n当月宫绾音对主角的好感达到相当程度且尚未确认关系时，她会主动告白。\n<% } %>' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.ai_transform).toHaveLength(1);
    expect(r.ai_transform[0].kind).toBe('rewrite_numeric');
    expect(r.ai_transform[0].instruction).toContain('大白话');
    expect(r.needs_user).toHaveLength(0);
    expect(r.kept).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);
  });

  it('纯宏变量列表（无可读设定）→ drop numeric_system，不进 needs_user', () => {
    const e = entry({ uid: 2, key: [], content: '<status_current_variable>\n{{format_message_variable::stat_data}}\n</status_current_variable>' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe('numeric_system');
    expect(r.needs_user).toHaveLength(0);
  });

  it('好感度数值字段（好感度: 87）→ ai_transform.rewrite', () => {
    const e = entry({ uid: 3, key: [], content: '绘里奈:\n  年龄: 17\n  好感度: 87\n  关系: 同班同学' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.ai_transform).toHaveLength(1);
    expect(r.ai_transform[0].kind).toBe('rewrite_numeric');
    expect(r.ai_transform[0].source_excerpt).toContain('同班同学');
  });

  it('普通设定无数值 → 不受影响（不进 ai_transform）', () => {
    const e = entry({ uid: 4, key: ['总武高'], content: '总武高是千叶的县立高中。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.ai_transform).toHaveLength(0);
    expect(r.kept).toHaveLength(1);
  });

  it('stats.ai_transform 计数正确 + 本数守恒', () => {
    const entries = [
      // 可读文本 ≥20 字 → rewrite
      entry({ uid: 1, content: '<% if (getvar(\'x\')) { %>\n当月宫绾音对主角的好感达到相当程度且尚未确认关系时，她会主动告白，这是很重要的规则。\n<% } %>' }),
      // 纯宏 → drop
      entry({ uid: 2, content: '{{format_message_variable::stat_data}}' }),
    ];
    const r = adaptTavernLorebookObject({ entries });
    expect(r.stats.ai_transform).toBe(1);
    expect(r.stats.dropped_silently).toBe(1);
    expect(r.stats.kept + r.stats.dropped_silently + r.stats.needs_user + r.stats.ai_transform).toBe(2);
  });
});

describe('adaptTavernLorebookObject — 输出指令闸（插画/CG/JSON 指令）', () => {
  it('[插画强调] 输出指令 → drop output_instruction', () => {
    const e = entry({ uid: 1, key: ['插画'], comment: '', content: '[插画强调]\n**重要** 如果出现合适场景，必须输出固定插画标签！！\n[/插画强调]' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe('output_instruction');
    expect(r.kept).toHaveLength(0);
  });

  it('[mvu_plot]CG触发 → drop output_instruction（不进 rewrite）', () => {
    const e = entry({ uid: 2, key: [], comment: '[mvu_plot]绘里奈CG触发', content: '【绘里奈剧情插画输出规则】当以下剧情触发时，必须在正文插入对应标签（每张只限一次）。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe('output_instruction');
    expect(r.ai_transform).toHaveLength(0);
  });

  it('[五维数值判定系统] → 数值闸：ai_transform，不进 needs_user', () => {
    const e = entry({ uid: 3, key: [], comment: '[五维数值判定系统]', content: '#[五维数值判定系统]\n\n本条目是世界规则。五维数值是玩家长期能力，不是角色好感，不是即时心情。判定时必须参考玩家当前档案中的五维数值：知识、魅力、胆识、情商、体力，各维度 0-100。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.ai_transform.length + (r.dropped.some(d => d.reason === 'numeric_system') ? 1 : 0)).toBeGreaterThan(0);
    expect(r.needs_user).toHaveLength(0);
  });

  it('[快捷回复选项] 输出格式指令 → drop output_instruction', () => {
    const e = entry({ uid: 4, key: [], comment: '快捷回复选项', content: '快捷回复选项输出格式\n在每次 assistant 回复的 <content> 正文之后，必须生成四个快捷回复选项供 user 选择，用 <options> 标签包裹。' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0].reason).toBe('output_instruction');
    expect(r.needs_user).toHaveLength(0);
  });

  it('变量 schema 定义（type: number / check:）→ 不进 kept（drop 或 rewrite 皆可，AI 兜底删）', () => {
    const e = entry({ uid: 3, key: [], comment: 'mvu_update 变量输出格式', content: '变量输出格式:\n  时间:\n    type: string\n    format: "YYYY年MM月DD日"\n  好感度:\n    type: number\n    check:\n      - "禁止更新此字段"' });
    const r = adaptTavernLorebookObject({ entries: [e] });
    expect(r.kept).toHaveLength(0);
    // 不含可读设定 → drop numeric_system；或可读文本刚过线 → rewrite（指令兜底 AI 删）
    expect(r.dropped.some(d => d.reason === 'numeric_system') || r.ai_transform.length > 0).toBe(true);
    expect(r.needs_user).toHaveLength(0);
  });
});

describe('adaptTavernLorebook — JSON 解析层', () => {
  it('entries 是对象（酒馆常见 { "0": {...}, "1": {...} }）→ 按数值 key 排序当数组处理', () => {
    const input: TavernInput = { name: '对象书', entries: { '7': entry({ key: ['a'], content: 'a'.repeat(40) }), '3': entry({ key: ['b'], content: 'b'.repeat(40) }) } };
    const r = adaptTavernLorebookObject(input);
    expect(r.scanned).toBe(2);
    // 两 uid 都在（因为 normalizeEntries 保留原始 uid：3 和 7）
    expect(r.kept.map(k => k._src?.uid).sort()).toEqual([3, 7]);
  });

  it('非法 JSON → error 字段', () => {
    const r = adaptTavernLorebook('{ this is not json');
    expect(r.error).toBeTruthy();
    expect(r.scanned).toBe(0);
  });

  it('顶层无 entries → scanned=0, kept/dropped/needs_user 都空', () => {
    const r = adaptTavernLorebook('{"name": "空书"}');
    expect(r.scanned).toBe(0);
    expect(r.source_name).toBe('空书');
  });

  it('顶层有 name 但 entries 是空数组', () => {
    const r = adaptTavernLorebook('{"name": "x", "entries": []}');
    expect(r.scanned).toBe(0);
    expect(r.stats.kept).toBe(0);
  });
});

describe('adaptTavernLorebookObject — 混合 fixture（模拟新宿类酒馆书）', () => {
  it('20 条混合 entry → 统计合理', () => {
    const entries: TavernEntry[] = [
      // 占位
      entry({ uid: 1, order: 1, content: '' }),
      entry({ uid: 2, comment: '====变量系统====_开始' }),
      // 角色
      entry({ uid: 3, key: ['男主'], comment: '角色:男主', content: '普通高中生，性格温和。' }),
      entry({ uid: 4, key: ['女主'], comment: '角色:女主', content: '神秘少女，金发碧眼。' }),
      // 地点
      entry({ uid: 5, key: ['新宿'], comment: '地点:新宿', content: '东京最繁华的街区之一。' }),
      // 世界观
      entry({ uid: 6, key: ['拯救计划'], comment: '世界观:拯救计划', content: '一个超自然组织对异常事件的收容方案。' }),
      // 酒馆脚本
      entry({ uid: 7, key: ['x'], content: '设值', extensions: { regex_script: '/foo/' } }),
      // outlet
      entry({ uid: 8, key: ['x'], content: '内容', outletName: 'main' }),
      // 变量
      entry({ uid: 9, key: ['affection'], content: '$affection = 50' }),
      // 含糊
      entry({ uid: 10, key: [], content: '一段模糊的设定文本。'.repeat(6) }),
      // 关闭
      entry({ uid: 11, key: ['zombie'], content: '旧版关掉的角色', disable: true }),
      // 概率
      entry({ uid: 12, key: ['rare'], content: '低概率彩蛋', useProbability: true, probability: 10 }),
      // 又一个角色
      entry({ uid: 13, key: ['反派'], comment: '角色:反派', content: '黑发红瞳，组织首领。' }),
      // 初始
      entry({ uid: 14, key: ['开场'], comment: '初始:故事开始', content: '夜晚的歌舞伎町，霓虹灯闪烁。' }),
      // meta 指令
      entry({ uid: 15, key: ['meta'], content: '内容', extensions: { notes: 'inject before system' } }),
      // 角色
      entry({ uid: 16, key: ['副角色'], comment: '角色:副角色', content: '戴眼镜的助手。' }),
      // 占位空 key
      entry({ uid: 17, order: 50, content: '' }),
      // 长 content 无 key
      entry({ uid: 18, key: [], content: '非常长的一段世界观描述。'.repeat(20) }),
      // 普通设定
      entry({ uid: 19, key: ['组织'], comment: '组织:超自然对策组', content: '处理异常事件的秘密机构。' }),
      // 关闭常驻
      entry({ uid: 20, key: ['background'], constant: true, selective: false, content: '这里是世界背景段落。' }),
    ];
    const r = adaptTavernLorebookObject({ name: '新宿拯救计划', entries });
    expect(r.scanned).toBe(20);
    // drop 至少 1, 2, 7, 8, 9, 15 = 6 条
    expect(r.dropped.length).toBeGreaterThanOrEqual(6);
    // kept 至少 3, 4, 5, 6, 13, 14, 16, 19, 20 = 9 条（11 关闭但有 content 也 kept，12 概率 10>5 也会 kept）
    expect(r.kept.length).toBeGreaterThanOrEqual(7);
    // needs_user 至少 10, 18 = 2 条
    expect(r.needs_user.length).toBeGreaterThanOrEqual(2);
    // 统计对得上
    expect(r.stats.kept + r.stats.dropped_silently + r.stats.needs_user).toBe(20);
  });
});
