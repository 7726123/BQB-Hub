// compat：为 HTML 字符串内联事件保留的全局白名单（docs/single-bundle-refactor.md D1）。
// 内联事件字符串里的方法调用（如 UsageStats.clearHistory()）在全局作用域解析名字，
// 这是唯一必须挂 globalThis 的理由；名单由 tests/ui-refs.test.ts 校验（引用名 ⊆ 白名单，漏挂即红）。
// 单 bundle 改造期间逐模块把挂载从各自文件迁入此处；迁移完成后只剩本文件挂载。
import { UsageStats } from '../lib/usage';
import { ClientLog } from '../domain/clientlog';
import { WorldBookManager } from '../domain/worldbook';
import { VariableManager } from '../lib/variables';
import { UpdateManager } from '../domain/update';

const g = globalThis as unknown as Record<string, unknown>;
g.UsageStats = UsageStats;
g.ClientLog = ClientLog;
// ui.ts 条目注入开关的字符串 onclick 引用（P3-B：worldbook 停发后由白名单提供）
g.WorldBookManager = WorldBookManager;
// index.html「刷新变量」按钮的字符串 onclick 引用（P3-B）
g.VariableManager = VariableManager;
// index.html「检查更新」按钮的字符串 onclick 引用（P3-B）
g.UpdateManager = UpdateManager;
