// RegexEngine：正则规则引擎（时序 before/after，支持 /pattern/flags 写法与 {{match}} 占位）。
// 迁移自 www/modules/regex.js；挂 window 全局供未迁移模块使用。
// StorageManager 经 SM() gate 访问（lib.dom 同名类型冲突，见 infra/gate.ts）。

import { SM } from '../infra/gate';
export interface RegexRule {
  id?: string;
  name: string;
  enabled: boolean;
  timing: 'before' | 'after';
  order: number;
  findRegex: string;
  replaceString: string;
}

function buildRegex(pattern: string): RegExp {
  const m = pattern.match(/^\/(.*)\/([gimsuy]*)$/);
  return m ? new RegExp(m[1], m[2] || 'g') : new RegExp(pattern, 'g');
}

export const RegexEngine = {
  getRules(): RegexRule[] {
    return SM().get<RegexRule[]>('regexRules', []) ?? [];
  },

  saveRules(rules: RegexRule[]): void {
    rules.forEach((r, i) => { r.order = i; });
    SM().set('regexRules', rules);
  },

  applyRules(text: string, timing: string): string {
    const rules = this.getRules()
      .filter((r) => r.enabled && r.timing === timing)
      .sort((a, b) => a.order - b.order);
    let result = text;
    for (const rule of rules) {
      try {
        const re = buildRegex(rule.findRegex);
        // 注意：替换串里的 {{match}} 需转成 $& 记号（$$& 表示字面 $&），
        // 原实现写成 '$&' 会被外层 replace 展开成 '{{match}}' 本身，占位符永不生效——已修。
        result = result.replace(re, rule.replaceString.replace(/\{\{match\}\}/g, '$$&'));
      } catch (e) { console.warn('Regex error:', rule.name, (e as Error).message); }
    }
    return result;
  },

  testRule(findRegex: string, replaceString: string, testText: string): string {
    try {
      const re = buildRegex(findRegex);
      return testText.replace(re, replaceString.replace(/\{\{match\}\}/g, '$$&'));
    } catch (e) { return '正则错误: ' + (e as Error).message; }
  }
};

export default RegexEngine;
// 挂载已移除（单 bundle 改造 P3-A）：消费方（app/ui/preset）ES import 本模块；regex.js 产物停发