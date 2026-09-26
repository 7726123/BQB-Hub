// VariableManager：世界书作用域变量（按 wbId 隔离）+ computed 表达式 + [VAR] 块解析。
// 迁移自 www/modules/variables.js。
// 外部依赖解析约定：一律用裸标识符（typeof 守卫）——裸标识符同时命中
// ①旧脚本顶层 const（全局词法作用域，不挂 globalThis 属性）②已迁移模块显式挂载的
// globalThis 属性。用 globalThis.X 访问旧 const 全局会得到 undefined（踩过的坑）。
import { SM } from '../infra/gate';
import { WorldBookManager } from '../domain/worldbook';
import { StatusVars } from '../domain/statusvars';


interface VarMap { [name: string]: string }

export const VariableManager = {
  _key: 'wbVariables' as string,

  getAll(): VarMap {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return {};
    const all = SM().get<Record<string, VarMap>>(this._key, {}) ?? {};
    return all[wbId] || {};
  },

  getComputedValue(expr: string): string {
    try {
      const vars = this.getAll();
      let jsExpr = expr;
      Object.keys(vars).forEach(function (key) {
        const val = vars[key];
        const num = parseFloat(val);
        const replacement = !isNaN(num) ? String(num) : '"' + String(val).replace(/"/g, '\\"') + '"';
        // 边界用断言而非 \b：\b 只认 \w（[A-Za-z0-9_]），中文变量名永远匹配不上——
        // 原实现因此对中文变量失效（历史 bug），改为中英均适用的自定义边界。
        const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        jsExpr = jsExpr.replace(new RegExp('(?<![\\w\\u4e00-\\u9fa5])' + esc + '(?![\\w\\u4e00-\\u9fa5])', 'g'), replacement);
      });
      const result = new Function('return ' + jsExpr)();
      return String(result);
    } catch (e) {
      return '';
    }
  },

  set(name: string, value: unknown): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = SM().get<Record<string, VarMap>>(this._key, {}) ?? {};
    if (!all[wbId]) all[wbId] = {};
    all[wbId][name] = String(value);
    SM().set(this._key, all);
    this._recalcComputed(all[wbId]);
    SM().set(this._key, all);
  },

  setBatch(vars: VarMap): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = SM().get<Record<string, VarMap>>(this._key, {}) ?? {};
    if (!all[wbId]) all[wbId] = {};
    Object.entries(vars).forEach(([k, v]) => { all[wbId][k] = String(v); });
    this._recalcComputed(all[wbId]);
    SM().set(this._key, all);
  },

  _recalcComputed(vars: VarMap): void {
    const wb = WorldBookManager.getActive();
    if (!wb || !wb.entries) return;
    wb.entries.forEach(function (e) {
      if (e.type === '变量' && e.content) {
        e.content.split('\n').forEach(function (line) {
          const l = line.trim();
          if (!l) return;
          const eqIdx = l.indexOf('=');
          if (eqIdx < 0) return;
          const key = l.substring(0, eqIdx).trim();
          const val = l.substring(eqIdx + 1).trim();
          if (val.startsWith('computed:')) {
            const expr = val.substring(9);
            vars[key] = VariableManager.getComputedValue(expr);
          }
        });
      }
    });
  },

  get(name: string, fallback?: string): string {
    const vars = this.getAll();
    if (vars[name] !== undefined) return vars[name];
    // 世界书「变量」条目（一个条目 = 一个变量）的当前值也对 {{getvar::}} 可见：
    // 面板里的值可以直接在预设/条目/主角设定里引用。老 wbVariables 表优先（语义与之前完全一致），
    // 模式取当前生成链（小说 generate 开头 setMode('novel')、演出 setMode('chat')）。
    try {
      const hit = StatusVars.values(StatusVars.currentMode())[name];
      if (hit && hit.v !== undefined && hit.v !== '') return String(hit.v);
    } catch (e) { /* 拿不到就按未定义处理 */ }
    return fallback !== undefined ? fallback : '';
  },

  clear(): void {
    const wbId = WorldBookManager.getActiveId();
    if (!wbId) return;
    const all = SM().get<Record<string, VarMap>>(this._key, {}) ?? {};
    delete all[wbId];
    SM().set(this._key, all);
  },

  /** 解析 [VAR]...[/VAR] 块；支持 +/- 增量（基于当前值）。返回 null 表示无块。 */
  parseVarBlock(text: string): VarMap | null {
    if (!text) return null;
    const match = text.match(/\[VAR\]([\s\S]*?)\[\/VAR\]/);
    if (!match) return null;
    const vars: VarMap = {};
    match[1].split('\n').forEach(function (line) {
      const l = line.trim();
      if (!l) return;
      const eqIdx = l.indexOf('=');
      if (eqIdx < 0) return;
      const key = l.substring(0, eqIdx).trim();
      let val = l.substring(eqIdx + 1).trim();
      if (val.startsWith('computed:')) return;
      const current = VariableManager.get(key);
      if (val.startsWith('+') || val.startsWith('-')) {
        const num = parseFloat(val);
        const curNum = parseFloat(current);
        if (!isNaN(num) && !isNaN(curNum)) {
          val = String(curNum + num);
        }
      }
      vars[key] = val;
    });
    return vars;
  },

  /** 条件求值：`变量 OP 值`，六种比较；未定义变量/无法解析时返回 true（宽松放行）。 */
  evalCondition(condition: string): boolean {
    if (!condition || !condition.trim()) return true;
    const vars = this.getAll();
    const m = condition.trim().match(/^(\S+)\s*(>=|<=|>|<|=|!=)\s*(.+)$/);
    if (!m) return true;
    const varName = m[1];
    const op = m[2];
    const target = m[3];
    const current = vars[varName];
    if (current === undefined || current === '') return true;
    const numCur = parseFloat(current);
    const numTarget = parseFloat(target);
    if (!isNaN(numCur) && !isNaN(numTarget)) {
      switch (op) {
        case '>': return numCur > numTarget;
        case '<': return numCur < numTarget;
        case '>=': return numCur >= numTarget;
        case '<=': return numCur <= numTarget;
        case '=': return numCur === numTarget;
        case '!=': return numCur !== numTarget;
      }
    }
    switch (op) {
      case '=': return String(current) === target;
      case '!=': return String(current) !== target;
      default: return true;
    }
  },

};

// 挂载已移至 src/boot/compat.ts 白名单（P3-B）：index.html「刷新变量」按钮的字符串 onclick 引用；
// 消费方（app/ui）ES import 本模块；variables.js 产物停发
export default VariableManager;