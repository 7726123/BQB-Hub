// 酒馆宏引擎（lib/stmacros.ts）：
// 换轨原因（2026-09-26 查「梦鲸思客V4 思维链不稳定」）：旧实现在 app.ts 里用两条正则做一次性替换——
//   ① setvar 值里嵌套 `}}` 会提前收尾（实测 1678 字的思维链只剩 95 字，尾部还是半截宏）；
//   ② 不递归（插进去的值里还有宏也不再展开）；
//   ③ 只认 setvar/getvar，`{{addvar}}`（8 处）/`{{trim}}`/`{{lastUserMessage}}` 字面残留发给模型。
// 这里逐条钉住新语义。
import { describe, it, expect } from 'vitest';
import { expandStMacros, expandStMacroText, createStMacroCtx, type StMacroCtx } from '../src/lib/stmacros';

function run(messages: string[], opts: Parameters<typeof expandStMacros>[1] = {}): string[] {
  const msgs = messages.map((c) => ({ role: 'system', content: c }));
  expandStMacros(msgs, opts);
  return msgs.map((m) => m.content);
}

describe('stmacros 基础宏', () => {
  it('setvar 声明被删掉、getvar 取到值；跨消息共享（按顺序生效）', () => {
    const [a, b] = run(['{{setvar::x::值一}}正文', '{{getvar::x}} 续']);
    expect(a).toBe('正文');
    expect(b).toBe('值一 续');
  });

  it('顺序语义：getvar 出现在 setvar 之前 → 空（与酒馆 prompt_order 一致，不预扫描全文）', () => {
    const [a, b] = run(['{{getvar::x}} 前', '{{setvar::x::后}}']);
    expect(a).toBe(' 前');
    expect(b).toBe('');
  });

  it('addvar 追加到同名变量（次要文风/禁词/协议那种写法），消费端拿到"基值+追加"', () => {
    const [a, b, c] = run([
      '{{setvar::wen::基}}',
      '{{addvar::wen:: ＋追}}',
      '文风：{{getvar::wen}}',
    ]);
    expect(a).toBe('');
    expect(b).toBe('');
    expect(c).toBe('文风：基 ＋追');
  });

  it('setvar 的值里嵌套 getvar → 完整取值 + 递归展开（梦鲸思维链只有 95 字的根因）', () => {
    const cot = '{{setvar::cot::【思维模式要求】\n规则：{{getvar::level}}\n步骤：\n一、检设定\n二、辨视角\n终、定乾坤}}';
    const out = run(['{{setvar::level::- 思考强度：low}}', cot, '{{getvar::cot}}']);
    expect(out[0]).toBe('');
    expect(out[1]).toBe('');       // 值内嵌套的 getvar 在 setvar 那一刻就展开掉了
    expect(out[2]).toContain('规则：- 思考强度：low');
    expect(out[2]).toContain('终、定乾坤');            // 后半截没有被 `}}` 截断
    expect(out[2]).not.toContain('{{getvar');          // 不再有半截宏残留
    expect(out[2]).not.toContain('}}');
  });

  it('三层嵌套（cot → level → 基础值）也能展开', () => {
    const out = run([
      '{{setvar::base::3500 token}}',
      '{{setvar::level::预算 {{getvar::base}}}}',
      '{{setvar::cot::要求：{{getvar::level}}}}',
      '{{getvar::cot}}',
    ]);
    expect(out[3]).toBe('要求：预算 3500 token');
  });

  it('未声明变量 → 走 lookup 兜底（世界书运行时变量），再没有就空', () => {
    const out = run(['{{getvar::sleep_var_missing}}'], { lookup: (k) => (k === 'sleep_var_missing' ? '世界书里的值' : '') });
    expect(out[0]).toBe('世界书里的值');
    const out2 = run(['[{{getvar::nothing}}]']);
    expect(out2[0]).toBe('[]');
  });

  it('{{trim}} 删掉自己并 trim 整条消息', () => {
    const out = run(['\n\n  {{trim}} 内容  \n\n']);
    expect(out[0]).toBe('内容');
  });

  it('{{lastUserMessage}} 用调用方传的本轮输入填充（预设里 <dreamer_input> 那格）', () => {
    const out = run(['<dreamer_input>\n{{lastUserMessage}}\n</dreamer_input>'], { lastUserMessage: '往前走一步' });
    expect(out[0]).toBe('<dreamer_input>\n往前走一步\n</dreamer_input>');
  });

  it('未闭合的宏与未知扩展宏原样保留（酒馆里扩展宏就是这么交给扩展/正则的）', () => {
    const out = run(['<dream_dx_setting>\n{{压缩相邻消息::lora_constant}}\n</dream_dx_setting>']);
    expect(out[0]).toContain('{{压缩相邻消息::lora_constant}}');
    const out2 = run(['{{setvar::x::1']);   // 未闭合
    expect(out2[0]).toBe('{{setvar::x::1');
  });

  it('{{//注释}} 删除；{{random::A|B,C}} 取其一；${说明} 剥壳', () => {
    const out = run(['{{//注释内容}}正文${这里写说明}']);
    expect(out[0]).toBe('正文这里写说明');
    const picked = run(['{{random::甲|乙}}'])[0];
    expect(['甲', '乙']).toContain(picked);
  });

  it('{{char}}/{{charIfNotGroup}}/{{user}}/裸 user 与词边界（username/user_name 不动），正文块豁免裸 user', () => {
    const out = run(['{{char}} 对 {{user}} 说：user 走了，username 没走；{{charIfNotGroup}}也在。'], { userName: '陆离' });
    expect(out[0]).toBe('其他角色 对 陆离 说：陆离 走了，username 没走；其他角色也在。');
    const out2 = run(['## 正文（历史 + 最新进度；最后一段就是接着往下写的位置）\nthe user opened the door.'], { skipBareUser: (c) => c.indexOf('## 正文（历史 + 最新进度') === 0 });
    expect(out2[0]).toContain('the user opened the door.');
  });

  it('userIsRealName：书里真有叫 user 的角色 → 裸 user 不换（{{user}} 照换）', () => {
    const out = run(['user 与 {{user}} 是同桌'], { userIsRealName: true, userName: '陆离' });
    expect(out[0]).toBe('user 与 陆离 是同桌');
  });

  it('自引用不死循环（setvar 值里 getvar 自己）：深度封顶后收敛', () => {
    const out = run(['{{setvar::x::{{getvar::x}}a}}', '{{getvar::x}}']);
    expect(typeof out[1]).toBe('string');
  });

  it('getglobalvar/setglobalvar 走回调（本软件映射到运行时变量）', () => {
    const store: Record<string, string> = { g1: '全局值' };
    const out = run(['{{setglobalvar::g2::写入}}|{{getglobalvar::g1}}|{{getglobalvar::g2}}'], {
      globalGet: (k) => store[k] || '',
      globalSet: (k, v) => { store[k] = v; },
    });
    expect(out[0]).toBe('|全局值|写入');
    expect(store.g2).toBe('写入');
  });
});

describe('stmacros 梦鲸思客V4 真实片段回归', () => {
  // 与预设里「变量初始化 / Deepseek官方 / V4.1flash 放空大脑 / 默认思维链 / 写作模式」同构的最小复刻：
  // 变量初始化（含默认值 + {{trim}}）→ 渠道适配 → 思考强度 → 思维链（值里嵌 3 个 getvar）→ 消费端。
  const INIT = '{{setvar::sleep_var_thinking_flag::}}\n'
    + '{{setvar::sleep_var_thinking_level::思考强度：2000 token}}\n'
    + '{{setvar::sleep_dream_protocol::DREAM_PLOT_OUTPUT}}\n'
    + '{{setvar::sleep_var_thought_of_chain::}}\n{{trim}}';
  const CHANNEL = '{{setvar::sleep_var_thinking_flag::<｜begin▁of▁thinking｜>}}';
  const LEVEL = '{{setvar::sleep_var_thinking_level::- 思考强度：low\n- 只允许根据思考步骤进行思考，不进行发散性思考。}}';
  const COT = '{{setvar::sleep_var_thought_of_chain::\n【思维模式要求】\n<thought_of_chain>\n规则：\n  {{getvar::sleep_var_thinking_level}}\n'
    + '- 逐字以"{{getvar::sleep_var_thinking_flag}}吾有一梦，今方始筑："开始。\n'
    + '- 当前协议：{{getvar::sleep_dream_protocol}}\n'
    + '终、定乾坤：输出"前尘已定，梦境将演。"\n</thought_of_chain>\n}}';
  const CONSUMER = '【最新输入】\n<dreamer_input>\n{{lastUserMessage}}\n</dreamer_input>\n\n【写作要求】\n{{getvar::sleep_var_wenfeng}}\n{{getvar::sleep_var_ban_word}}\n\n{{getvar::sleep_var_thought_of_chain}}';

  it('思维链完整下发：三处嵌套 getvar 全部展开、半截宏与残留 }} 归零', () => {
    const outs = run(
      ['{{setvar::sleep_var_wenfeng::文风：白话}}', INIT, CHANNEL, LEVEL, COT,
        '{{addvar::sleep_var_ban_word:: - 禁止破折号。}}', '{{addvar::sleep_var_wenfeng:: ＋信息差压制}}', CONSUMER],
      { lastUserMessage: '她推开门。' },
    );
    const consumer = outs[outs.length - 1];
    expect(outs.slice(0, 7)).toEqual(['', '', '', '', '', '', '']);   // 声明类块全部就地执行并清空
    // 消费端：文风拼接 + 禁词追加 + 思维链（含渠道 flag / 思考强度 / 协议）
    expect(consumer).toContain('文风：白话 ＋信息差压制');
    expect(consumer).toContain('- 禁止破折号。');
    expect(consumer).toContain('她推开门。');
    expect(consumer).toContain('逐字以"<｜begin▁of▁thinking｜>吾有一梦，今方始筑："开始。');
    expect(consumer).toContain('- 思考强度：low');
    expect(consumer).toContain('当前协议：DREAM_PLOT_OUTPUT');
    expect(consumer).toContain('前尘已定，梦境将演。');
    expect(consumer).not.toContain('{{getvar');
    expect(consumer).not.toContain('{{setvar');
    expect(consumer).not.toContain('{{addvar');
  });

  it('旧实现的两个硬伤都复现不了：思维链不再被内层 }} 截断、addvar 不再字面残留', () => {
    const outs = run([INIT, LEVEL, COT, CONSUMER], { lastUserMessage: 'x' });
    const consumer = outs[outs.length - 1];
    const i = consumer.indexOf('【思维模式要求】');
    const seg = consumer.slice(i);
    expect(seg).toContain('- 思考强度：low');        // 紧跟在第一个内层 getvar 之后 → 旧实现在这里就断了
    expect(seg).toContain('吾有一梦，今方始筑');      // 再往后的 flag 行
    expect(seg).toContain('当前协议：DREAM_PLOT_OUTPUT');
    expect(seg).toContain('前尘已定，梦境将演。');     // 最后一行仍在 → 没被截断
    expect(seg).not.toContain('{{getvar');
  });
});

describe('stmacros 直接调用（供 _collectSTVars 复用）', () => {
  it('expandStMacroText 不修改 ctx.depth，可安全复用同一 ctx 连续展开', () => {
    const ctx: StMacroCtx = createStMacroCtx({});
    expect(expandStMacroText('{{setvar::a::1}}', ctx)).toBe('');
    expect(expandStMacroText('{{getvar::a}}', ctx)).toBe('1');
    expect(ctx.vars.a).toBe('1');
  });
});
