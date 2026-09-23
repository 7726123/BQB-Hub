// PluginManager：插件清单与启停状态。
// 插件 = 声明式清单（manifest），不含可执行代码——一切"会跑的东西"由 App 内置引擎提供，
// 插件只提供配置/数据（如记忆表格结构）。
// 插件全部内置（BUILTIN_PLUGINS）：随 App 版本更新才能变化，用户侧没有安装入口，
// 存储里只保留启停开关；老用户此前下载的第三方条目仍可读取（不能新增，可删除）。
import { SM } from '../infra/gate';

export interface PluginManifest {
  id: string;             // 唯一 ID（小写字母数字连字符）
  name: string;           // 显示名
  version: string;        // 版本号
  type: string;           // database | widget ···（内置引擎按类型/壳路由）
  shell?: string;         // widget 类型的壳标识（如 agent），引擎按它路由
  description?: string;   // 面向用户的说明：只讲能做什么，不暴露内部实现
  data?: any;             // 插件负载：按 type/shell 定义（内置项的权威来源永远是代码）
  installedAt?: number;
  builtin?: boolean;      // 内置插件：不可删除，只能开关
}

// 内置插件（定义在代码里，不进存储）：
// 改表格结构/提示词/阈值只需发版，用户端立即生效，不会像旧第三方 manifest 那样把老文案固化在本地。
const BUILTIN_PLUGINS: PluginManifest[] = [
  {
    id: 'db-classic-tables',
    name: '经典记忆数据库',
    version: '1.0.0',
    type: 'database',
    description: '自动整理剧情摘要、角色档案、物品追踪与世界设定，续写时把相关旧事带进上下文。',
    data: {
      tables: [
        { id: 'plot_summary', name: '剧情摘要', columns: ['#主线摘要', '#支线摘要'] },
        { id: 'character_profile', name: '角色档案', columns: ['角色名', '年龄', '性别', '身份', '性格', '当前位置', '周围角色', '生理', '人际关系', '着装', '待办事项', '约定'] },
        { id: 'item_tracking', name: '物品追踪', columns: ['物品名称', '物品描述', '物品位置', '持有者', '状态', '备注'] },
        { id: 'world_setting', name: '世界设定', columns: ['设定名', '类型', '详细说明', '影响范围'] },
      ],
    },
  },
  {
    id: 'agent-setting-sync',
    name: 'Agent 设定同步',
    version: '1.0.0',
    type: 'widget',
    shell: 'agent',
    description: '续写时自动发现剧情里的设定变化并整理成提案，写进本书的临时世界书；原书设定不会被自动改动，可随时回滚。',
  },
  {
    id: 'biqi',
    name: '比奇',
    version: '1.0.0',
    type: 'widget',
    shell: 'biqi',
    description: '在正文页开一个半屏窗口，和比奇讨论剧情该怎么改，它会直接修订本书的临时世界书（原书不动）；它能看到当前设定与最近正文。与「Agent 设定同步」只能开一个。',
  },
];

// 互斥组：同组插件维护同一份数据（临时世界书 overlay），同时开启会互相覆盖，
// 开启一方时自动关闭另一方。放在这里统一约束——任何入口（插件页/后续快捷开关）都受同一规则。
const EXCLUSIVE_GROUPS: string[][] = [['agent-setting-sync', 'biqi']];

export const PluginManager = {
  KEY: 'localPlugins',
  ENABLED_KEY: 'pluginEnabled',

  // 内置项在前（id 冲突时以内置为准），其后是存储里遗留的第三方条目
  getAll(): PluginManifest[] {
    const out: PluginManifest[] = BUILTIN_PLUGINS.map(p => Object.assign({}, p, { builtin: true }));
    const seen: Record<string, boolean> = {};
    out.forEach(p => { seen[p.id] = true; });
    const stored = SM().get<PluginManifest[]>(this.KEY, []) ?? [];
    stored.forEach(p => {
      if (!p || !p.id || seen[p.id]) return;
      seen[p.id] = true;
      out.push(Object.assign({}, p, { builtin: false }));
    });
    return out;
  },

  get(id: string): PluginManifest | null {
    return this.getAll().find(p => p.id === id) || null;
  },

  isBuiltin(id: string): boolean {
    return BUILTIN_PLUGINS.some(p => p.id === id);
  },

  saveAll(arr: PluginManifest[]): void { SM().set(this.KEY, arr); },

  // 仅用于清理存储里遗留的第三方条目；内置项拒绝删除
  uninstall(id: string): boolean {
    if (this.isBuiltin(id)) return false;
    const arr = SM().get<PluginManifest[]>(this.KEY, []) ?? [];
    const i = arr.findIndex(p => p && p.id === id);
    if (i < 0) return false;
    arr.splice(i, 1);
    this.saveAll(arr);
    SM().set(this.ENABLED_KEY + ':' + id, false);
    return true;
  },

  isEnabled(id: string): boolean {
    return !!SM().get<boolean>(this.ENABLED_KEY + ':' + id, false);
  },

  // 开启/关闭。开启互斥组内的插件时，自动关闭同组其它插件（返回值 = 被顶掉的名字，无则 null）
  setEnabled(id: string, on: boolean): string | null {
    SM().set(this.ENABLED_KEY + ':' + id, !!on);
    if (!on) return null;
    let bumped: string | null = null;
    for (const group of EXCLUSIVE_GROUPS) {
      if (group.indexOf(id) < 0) continue;
      for (const other of group) {
        if (other === id || !this.isEnabled(other)) continue;
        SM().set(this.ENABLED_KEY + ':' + other, false);
        const p = this.get(other);
        bumped = (p && p.name) || other;
      }
    }
    return bumped;
  },

  // 当前启用的、指定类型的插件列表
  getEnabledByType(type: string): PluginManifest[] {
    return this.getAll().filter(p => p.type === type && this.isEnabled(p.id));
  },

  // 数据库插件专用：当前生效的模板（第一个启用的 database 插件）
  getActiveDatabasePlugin(): PluginManifest | null {
    const list = this.getEnabledByType('database');
    return list.length > 0 ? list[0] : null;
  },

  // widget 插件专用：第一个启用且 shell 匹配的插件
  getActiveWidgetPlugin(shell: string): PluginManifest | null {
    const list = this.getEnabledByType('widget');
    return list.find(p => p.shell === shell) || null;
  },
};

// 挂载已移除（单 bundle 改造 P3-A）：消费方 ES import 本模块；plugins.js 产物停发
export default PluginManager;
