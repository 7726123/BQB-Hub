// 上传时生成检索元数据（纯函数）单测：提示词内容、模型输出容错解析
import { describe, it, expect } from 'vitest';
import { buildWbMetaPrompt, parseWbMeta, summarizeBookForMeta } from '../src/lib/wbmeta';

const book = {
  entries: [
    { type: '世界观', name: '世界背景', content: '三百年前天空裂开一道缝隙，落下星烬……'.repeat(6) },
    { type: '世界观', name: '力量体系', content: '星烬与铭刻。'.repeat(10) },
    { type: '角色', name: '亚瑟', content: '姓名：亚瑟。性别：男。' },
    { type: '角色', name: '姓名：凛', content: '姓名：凛。性别：女。' },
    { type: '初始', name: '开局', content: '故事开始时……' },
  ],
};

describe('summarizeBookForMeta', () => {
  it('抽出类型统计 / 角色名（去掉「姓名：」前缀）/ 条目名 / 世界观摘要', () => {
    const t = summarizeBookForMeta(book);
    expect(t).toContain('世界观 2 条');
    expect(t).toContain('角色 2 条');
    expect(t).toContain('亚瑟');
    expect(t).toContain('凛');
    expect(t).not.toContain('姓名：凛、');   // 前缀已清洗
    expect(t).toContain('世界背景');
    expect(t).toContain('正文字数');
  });

  it('空/异常输入不抛错', () => {
    expect(summarizeBookForMeta(null)).toContain('条目类型统计');
    expect(summarizeBookForMeta({ entries: 'x' })).toContain('条目类型统计');
  });
});

describe('buildWbMetaPrompt', () => {
  it('system 说明 JSON 契约与枚举，user 带标题/简介/结构摘要', () => {
    const p = buildWbMetaPrompt('天伤裂土', '作者自己写的简介', book);
    expect(p.system).toContain('"summary"');
    expect(p.system).toContain('男性向 或 女性向 或 一般向');
    expect(p.system).toContain('纯爱 或 BL 或 GL 或 后宫 或 无恋爱线');
    expect(p.user).toContain('标题：天伤裂土');
    expect(p.user).toContain('作者自己写的简介');
    expect(p.user).toContain('结构摘要');
  });

  it('简介为空时标注未填写（不编造）', () => {
    const p = buildWbMetaPrompt('T', '', book);
    expect(p.user).toContain('（未填写）');
  });
});

describe('parseWbMeta', () => {
  it('解析标准 JSON', () => {
    const m = parseWbMeta('{"summary":"剑与魔法题材","genre":"剑与魔法","audience":"男性向","relation":"无恋爱线","franchise":"","nsfw":false,"tags":["剑与魔法","男性向"]}');
    expect(m).not.toBeNull();
    expect(m!.genre).toBe('剑与魔法');
    expect(m!.tags).toEqual(['剑与魔法', '男性向']);
  });

  it('容错：markdown 围栏 / 前后废话 / 尾随逗号之外的多余文本', () => {
    const m = parseWbMeta('好的，结果如下：\n```json\n{"summary":"校园日常","genre":"校园日常","audience":"女性向","relation":"纯爱","franchise":"","nsfw":false,"tags":["校园"]}\n```\n希望有帮助');
    expect(m).not.toBeNull();
    expect(m!.genre).toBe('校园日常');
    expect(m!.audience).toBe('女性向');
  });

  it('枚举非法 → 落到中性值（一般向 / 无恋爱线）', () => {
    const m = parseWbMeta('{"summary":"x","audience":"男频","relation":"搞基","tags":["a"]}');
    expect(m!.audience).toBe('一般向');
    expect(m!.relation).toBe('无恋爱线');
  });

  it('tags 超长/超量被裁剪，nsfw 只认 true', () => {
    const long = '标'.repeat(30);
    const many = Array.from({ length: 20 }, (_, i) => 'tag' + i);
    const m = parseWbMeta(JSON.stringify({ summary: 'x', tags: [long, ...many], nsfw: 'yes' }));
    expect(m!.tags.length).toBeLessThanOrEqual(12);
    expect(m!.tags[0].length).toBeLessThanOrEqual(12);
    expect(m!.nsfw).toBe(false);
  });

  it('空内容 / 非 JSON / 无有效字段 → null（上传走机械兜底）', () => {
    expect(parseWbMeta('')).toBeNull();
    expect(parseWbMeta('抱歉我不能')).toBeNull();
    expect(parseWbMeta('{"foo":1}')).toBeNull();
  });
});
