// 「画图主机」AI 配置技能包（2026-10-06 用户要求：放进使用助手，由助手把一份 .md 直接发给用户）。
//
// 为什么是一份 .md：用户把这份 .md 交给电脑上的 AI 编程助手（Claude Code / WorkBuddy / Cursor…），
// 那个助手照着它就能把 ComfyUI、模型、工作流、画图主机全部配好，最后打印手机要填的地址与配对 token。
// 所以这份文件必须**自包含**：主机程序（serve.mjs / comfy-workflow.mjs）与工作流 JSON 都内嵌在附录里，
// 用户不必再去别处下载任何"主机包"。
//
// 素材放在 web/skill/（随 App 一起打包、随热更新一起下发），这里只做"同源读取 + 占位符替换"：
//   web/skill/SKILL.md                     —— 正文（给 AI 助手看的执行说明书）
//   web/skill/host/serve.mjs               —— 画图主机（与 imgtest/serve.mjs 同步，改主机要一起改）
//   web/skill/host/comfy-workflow.mjs      —— 工作流解析/映射
//   web/skill/host/comfy/workflow.json     —— API 格式工作流（含 _tiers 声明）
//   web/skill/host/config.json             —— 配置模板
//   web/skill/host/启动.cmd                 —— Windows 启动脚本（CRLF）
//   web/skill/host/web/index.html          —— 8123 的说明页（可选）
//
// ⚠️ 改主机逻辑（imgtest/*.mjs）时要**同步更新 web/skill/host/** 下的副本，否则用户拿到的技能包还是旧的。
// 模型文件**不内嵌**（许可不允许再分发，且站点要求登录下载）：技能里只给 Civitai 页面链接与校验值。

/** 交给用户时的文件名（保存到手机「下载」目录用这个名字）。 */
export const SETUP_SKILL_FILE_NAME = 'BQB-Hub-画图主机配置技能.md';
export const SETUP_SKILL_MIME = 'text/markdown';

/** 素材相对 App 根目录的路径（与 web/skill/ 一一对应）。 */
export const SETUP_SKILL_PARTS: Record<string, string> = {
  '{{SERVE_MJS}}': 'skill/host/serve.mjs',
  '{{COMFY_WORKFLOW_MJS}}': 'skill/host/comfy-workflow.mjs',
  '{{WORKFLOW_JSON}}': 'skill/host/comfy/workflow.json',
  '{{CONFIG_JSON}}': 'skill/host/config.json',
  '{{LAUNCH_CMD}}': 'skill/host/启动.cmd',
  '{{WEB_INDEX}}': 'skill/host/web/index.html',
};
export const SETUP_SKILL_TEMPLATE = 'skill/SKILL.md';

/** 这份技能包的大致字节数（卡片上给用户看"多大"）。 */
export function utf8Bytes(s: unknown): number {
  const t = String(s == null ? '' : s);
  try { return new TextEncoder().encode(t).length; } catch (e) { return t.length; }
}

/** 用相对 App 根目录的地址取素材（同源，离线也能取到；热更新包里也带着）。 */
async function _getText(url: string): Promise<string> {
  const href = (() => {
    try { return new URL(url, (globalThis as any).location ? (globalThis as any).location.href : undefined).href; }
    catch (e) { return url; }
  })();
  const f: any = (globalThis as any).fetch;
  if (typeof f !== 'function') throw new Error('环境不支持 fetch');
  const r = await f(href, { cache: 'no-store' });
  if (!r || !r.ok) throw new Error(url + ' 读取失败（HTTP ' + String((r && r.status) || '?') + '）');
  return String(await r.text());
}

export interface SetupSkillResult { ok: boolean; markdown?: string; bytes?: number; error?: string }

/**
 * 拼出完整的技能 .md（正文 + 附录里的主机源码）。
 * 任何一块素材缺失都返回 ok:false（宁可让助手如实说"技能包没取到"，也不要发一份残的给用户）。
 * 注意用 split/join 替换：`String.replace` 的替换串里 `$&`、`$'` 有特殊含义，主机源码里可能正好出现。
 */
export async function buildSetupSkillMd(): Promise<SetupSkillResult> {
  try {
    let md = await _getText(SETUP_SKILL_TEMPLATE);
    for (const key of Object.keys(SETUP_SKILL_PARTS)) {
      const body = await _getText(SETUP_SKILL_PARTS[key]);
      const clean = String(body).replace(/\s+$/, '');
      md = md.split(key).join(clean);
    }
    if (md.indexOf('{{') >= 0) {
      const left = /\{\{[A-Z_]+\}\}/.exec(md);
      return { ok: false, error: '技能包里有未替换的占位符：' + String((left && left[0]) || '?') };
    }
    if (!/\n$/.test(md)) md += '\n';
    return { ok: true, markdown: md, bytes: utf8Bytes(md) };
  } catch (e) {
    return { ok: false, error: String((e && (e as Error).message) || e) };
  }
}
