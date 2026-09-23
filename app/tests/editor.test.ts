import { describe, it, expect } from 'vitest';
import { EditorManager, htmlEscape } from '../src/domain/editor';

describe('EditorManager 纯函数', () => {
  it('stripThinking 移除思考块（保留其余内容）', () => {
    const html = '<p>正文开头</p><details class="cot-thinking" contenteditable="false"><summary>思考</summary>秘密推理</details><p>正文结尾</p>';
    const out = EditorManager.stripThinking(html);
    expect(out).not.toContain('cot-thinking');
    expect(out).not.toContain('秘密推理');
    expect(out).toContain('正文开头');
    expect(out).toContain('正文结尾');
    expect(EditorManager.stripThinking('')).toBe('');
  });

  it('_renderThinking：闭注释折叠、未闭合显示思考中光标、内容转义', () => {
    const closed = EditorManager._renderThinking('<!-- 推理过程 -->', false);
    expect(closed).toContain('<details class="cot-thinking"');
    expect(closed).toContain('<summary>思考</summary>');
    expect(closed).not.toContain('▍');

    const open = EditorManager._renderThinking('<!-- 推理进行中', true);
    expect(open).toContain('open');
    expect(open).toContain('思考中…');
    expect(open).toContain('▍');

    const esc = EditorManager._renderThinking('<!-- <b>&amp;</b> -->', false);
    expect(esc).toContain('&lt;b&gt;&amp;amp;&lt;/b&gt;'); // 内容被转义而非当作 HTML
  });

  it('htmlEscape 全量转义', () => {
    expect(htmlEscape('<a href="x">&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
    expect(htmlEscape(123)).toBe('123');
  });
});