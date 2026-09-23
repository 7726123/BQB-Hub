import { describe, it, expect, beforeEach } from 'vitest';
import '../src/infra/storage';
import '../src/domain/worldbook';
import '../src/domain/book';
import '../src/domain/character';
import { parseSampler, normalizeQuotes } from '../src/domain/book';

type SM = import('../src/infra/storage').StorageManagerClass;
const sm = () => (globalThis as unknown as { StorageManager: SM }).StorageManager;

(globalThis as unknown as Record<string, unknown>).App = { toast: () => {}, loadEditorContent: () => {} };

import { WorldBookManager as WBM } from '../src/domain/worldbook';
import { BookManager as BM } from '../src/domain/book';

describe('BookManager 同步', () => {
  beforeEach(() => {
    sm().remove('worldBooks'); sm().remove('activeWorldBookId');
    sm().set('characters', []);
  });

  it('syncToBook：把当前角色/写作指引写进当前书', () => {
    WBM.createBook('书A');
    sm().set('characters', [{ id: 'c1', name: '主角' }]);
    sm().set('writingGuide', '下一场景：教室');
    BM.syncToBook();
    const book = WBM.getNovelData();
    expect(book?.characters).toHaveLength(1);
    expect(book?.writingGuide).toBe('下一场景：教室');
  });

  it('syncFromBook：从目标书恢复角色/写作指引（不串书）', () => {
    WBM.createBook('书B');
    WBM.saveNovelData({ characters: [{ id: 'c9', name: '乙' }], writingGuide: 'B的指引' } as never);
    sm().set('characters', [{ id: 'c1', name: '甲' }]);
    sm().set('writingGuide', 'A的指引');
    BM.syncFromBook();
    expect((sm().get<{ name: string }[]>('characters', []) || []).map(c => c.name)).toEqual(['乙']);
    expect(sm().get('writingGuide', '')).toBe('B的指引');
  });

  it('switchBook：先同步当前书，再从目标书恢复', () => {
    WBM.createBook('书1');
    const b2 = WBM.createBook('书2');
    WBM.setActiveId(WBM.getAll()[0].id);
    sm().set('characters', [{ id: 'c1', name: '甲的记录' }]);
    BM.switchBook(b2.id);
    expect(WBM.getActiveId()).toBe(b2.id);
    // 书1 保留了同步进去的角色
    expect(WBM.getAll()[0].characters).toHaveLength(1);
    // 切到书2 后本地角色被书2（空）还原
    expect((sm().get<unknown[]>('characters', []) || [])).toHaveLength(0);
  });
});

describe('parseSampler 字段归一化', () => {
  it('snake_case 与 camelCase 多来源兼容', () => {
    const out = parseSampler({
      apiUrl: 'https://x/v1', modelName: 'm1', temp: 0.5,
      max_tokens: 999, top_p: 0.8, presence_penalty: 0.2,
      repetition_penalty: 1.1, rep_pen: 9, // 前者优先
      stream_openai: false,
      prompts: [{ name: 'a', content: 'b', enabled: true }]
    });
    expect(out.endpoint).toBe('https://x/v1');
    expect(out.model).toBe('m1');
    expect(out.temperature).toBe(0.5);
    expect(out.maxTokens).toBe(999);
    expect(out.topP).toBe(0.8);
    expect(out.presencePenalty).toBe(0.2);
    expect(out.repetitionPenalty).toBe(1.1); // ?? 链前者优先
    expect(out.streamOpenai).toBe(false);
    expect((out.prompts as unknown[])).toHaveLength(1);
  });
  it('缺省值兜底', () => {
    const out = parseSampler({});
    expect(out.temperature).toBe(0.8);
    expect(out.maxTokens).toBe(2048);
    expect(out.openaiMaxContext).toBe(2000000);
    expect(out.prompts).toEqual([]);
  });
});

describe('normalizeQuotes 引号归一化', () => {
  it('弯引号统一为「」', () => {
    expect(normalizeQuotes('他说“你好”')).toBe('他说「你好」');
  });
  it('段内多余引号删除、开闭交替', () => {
    expect(normalizeQuotes('「_a_」「「_b_」')).toBe('「_a_」「_b_」');
    expect(normalizeQuotes('孤立的」引号')).toBe('孤立的引号');
  });
  it('段独立配对：上一段的多余引号不影响下一段', () => {
    const text = '段一有个落单的「\n\n段二正常「配对」';
    // 原行为：段尾未闭合的「保留（只删段内多余的第二个「）；下一段配对不受影响
    expect(normalizeQuotes(text)).toBe('段一有个落单的「\n\n段二正常「配对」');
  });
  it('注释块整段逐字保留（引号替换与配对都不进注释；v1.5.90 起）', () => {
    // 旧行为：注释保护放在引号替换之后，注释里的 " “ ” « » 会被改写（本条测试曾断言
    // `<!-- 思考 」引用」 保留 -->`）。与属性测试「注释逐字保真」矛盾 → 修正为注释先保护。
    const text = '<!-- 思考 "引用" 保留 -->正文「好」';
    const out = normalizeQuotes(text);
    expect(out).toContain('<!-- 思考 "引用" 保留 -->');
    expect(out).toContain('「好」');
    // 注释外的引号照旧处理（" 前非标点 → 定向为 」→ 段内无「 → 配对删除）
    expect(normalizeQuotes('<!-- a -->他说"走吧。')).toBe('<!-- a -->他说走吧。');
    expect(normalizeQuotes('<!-- a -->他说：「走吧」')).toBe('<!-- a -->他说：「走吧」');
  });
  it('残留英文双引号按上下文定向', () => {
    // " 前非标点 → 定向为 」；段内无「 → 第 4 步配对删除（原行为）
    expect(normalizeQuotes('他说"走吧。')).toBe('他说走吧。');
    expect(normalizeQuotes('他说："走吧"')).toBe('他说：「走吧」');
  });
});
