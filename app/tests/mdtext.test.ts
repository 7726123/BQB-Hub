// **小标题** 高亮渲染（写卡 / 助手 / 比奇 共用）：
// 模型常把重点写成 **xxx**，此前在气泡里原样显示星号；现在渲染成高亮（<strong class="md-strong">）。
// 关键约定：必须在**转义之后**调用（否则插入的标签会被二次转义，或把用户/模型文本里的尖括号当标签执行）。
import { describe, it, expect } from 'vitest';
import { renderMdStrong } from '../src/lib/mdtext';

describe('renderMdStrong：**xxx** → 高亮', () => {
  it('成对的 **xxx** 变成 strong 标签', () => {
    expect(renderMdStrong('**标题**')).toBe('<strong class="md-strong">标题</strong>');
    expect(renderMdStrong('前 **重点** 后')).toBe('前 <strong class="md-strong">重点</strong> 后');
  });

  it('一行里多个、以及中英混排都处理', () => {
    expect(renderMdStrong('**一**和**二**')).toBe('<strong class="md-strong">一</strong>和<strong class="md-strong">二</strong>');
  });

  it('未闭合的 **、单个 * 原样保留', () => {
    expect(renderMdStrong('未闭合 **标题')).toBe('未闭合 **标题');
    expect(renderMdStrong('a * b * c')).toBe('a * b * c');
  });

  it('不跨行（避免把两条重点连起来）', () => {
    expect(renderMdStrong('**第一行\n第二行**')).toBe('**第一行\n第二行**');
  });

  it('空内容不处理', () => {
    expect(renderMdStrong('****')).toBe('****');
  });

  it('已转义的尖括号不会被重新当标签（防注入面）', () => {
    // 调用方先转义：**&lt;b&gt;** 里的内容应保持转义态，只是被包进 strong
    expect(renderMdStrong('**&lt;b&gt;**')).toBe('<strong class="md-strong">&lt;b&gt;</strong>');
  });
});
