// DatabaseManager：记忆表格数据库（迁移自 www/modules/database.js）。
// 灵感来自 yuzuki-Memory（柚月）：表格 = 列名数组，主键 = 第一列，
// `#` 前缀列 = 追加列（新内容按行拼到旧值后）。每本书独立数据库。
// 表格模板来自内置插件「经典记忆数据库」（见 plugins.ts）：未启用 → 无表、不注入、不填表。
import { SM } from '../infra/gate';
import { PluginManager } from './plugins';
import { BookManager } from './book';

interface MemTable { id: string; name: string; columns: string[]; icon?: string }
interface MemRecord { id: string; values: Record<string, string> }
interface MemDB {
  version: number;
  tables: MemTable[];
  records: Record<string, MemRecord[]>;
  activeTableId: string;
}
interface TableSettings { mode: string; endpoint: string; apiKey: string; model: string }

export const DatabaseManager = {
  KEY: 'memoryTableDB',
  SETTINGS_KEY: 'memoryTableSettings',
  PLOT_MAX_LINES: 80, // 剧情摘要每列保留的最大行数（滚动窗口）

  // 当前生效的数据库模板：来自启用的 database 插件；未启用 → 空（不注入不填表）
  activeTables(): { id: string; name: string; columns: string[] }[] {
    const plugin = (typeof PluginManager !== 'undefined') ? PluginManager.getActiveDatabasePlugin() : null;
    if (!plugin || !plugin.data || !Array.isArray(plugin.data.tables) || plugin.data.tables.length === 0) return [];
    return plugin.data.tables.map(function (t: any, i: number) {
      return {
        id: String(t.id || (plugin.id + '_t' + i)),
        name: String(t.name || ('表' + (i + 1))),
        columns: Array.isArray(t.columns) ? t.columns.map(String) : [],
      };
    });
  },

  // 填表提示词模板：database 插件可覆盖（data.fillPrompt），否则 null → 调用方用通用模板
  fillPrompt(): string | null {
    const plugin = (typeof PluginManager !== 'undefined') ? PluginManager.getActiveDatabasePlugin() : null;
    if (plugin && plugin.data && typeof plugin.data.fillPrompt === 'string' && plugin.data.fillPrompt.trim()) {
      return plugin.data.fillPrompt;
    }
    return null;
  },

  // 每本书独立数据库：KEY 存 { bookId: db } 嵌套对象，切书自动切换
  _bookId(): string {
    const book = (typeof BookManager !== 'undefined') ? BookManager.getActive() : null;
    return book ? book.id : 'none';
  },

  getDB(): MemDB {
    const all = SM().get<Record<string, MemDB>>(this.KEY, {}) ?? {};
    const bookId = this._bookId();
    let db = all[bookId];
    if (!db || db.version !== 1 || !db.tables || db.tables.length === 0) {
      db = this._defaultDB();
      all[bookId] = db;
      SM().set(this.KEY, all);
    }
    // 保证 records 结构完整 + 列同步（旧库缺列用当前模板列补齐，记录数据保留；icon 字段已废弃顺手清掉）
    this.activeTables().forEach(function (t) {
      if (!db!.records[t.id]) db!.records[t.id] = [];
      const old = db!.tables.find(function (x) { return x.id === t.id; });
      if (old) {
        if (JSON.stringify(old.columns) !== JSON.stringify(t.columns)) old.columns = t.columns.slice();
        if (old.icon) old.icon = '';
      } else {
        db!.tables.push({ id: t.id, name: t.name, columns: t.columns.slice() });
      }
    });
    return db;
  },

  _defaultDB(): MemDB {
    const tables = this.activeTables();
    return {
      version: 1,
      tables: tables.map(function (t) { return { id: t.id, name: t.name, columns: t.columns.slice() }; }),
      records: {},
      activeTableId: tables.some(function (t) { return t.id === 'character_profile'; }) ? 'character_profile' : (tables.length > 0 ? tables[0].id : '')
    };
  },

  saveDB(db: MemDB): void {
    const all = SM().get<Record<string, MemDB>>(this.KEY, {}) ?? {};
    all[this._bookId()] = db;
    SM().set(this.KEY, all);
  },

  // === 开关与 API 配置 ===
  // 开关 = 「存在启用的 database 插件」
  isEnabled(): boolean {
    if (typeof PluginManager === 'undefined') return false;
    return !!PluginManager.getActiveDatabasePlugin();
  },
  setEnabled(v: boolean): void {
    // 旧入口保留：无插件时不产生任何状态
    void v;
  },

  getSettings(): TableSettings {
    return SM().get<TableSettings>(this.SETTINGS_KEY, { mode: 'main', endpoint: '', apiKey: '', model: '' }) ?? { mode: 'main', endpoint: '', apiKey: '', model: '' };
  },
  saveSettings(s: TableSettings): void { SM().set(this.SETTINGS_KEY, s); },

  // 填表 API：独立配置（endpoint+apiKey 都非空）才用它，否则 null → 调用方回退主 API
  getApiConfig(): { endpoint: string; apiKey: string; model?: string } | null {
    const s = this.getSettings();
    if (s.mode === 'custom' && s.endpoint && s.apiKey) {
      const cfg: { endpoint: string; apiKey: string; model?: string } = { endpoint: s.endpoint, apiKey: s.apiKey };
      if (s.model) cfg.model = s.model;
      return cfg;
    }
    return null;
  },

  // === 表格/记录 ===
  getTables(): MemTable[] { return this.getDB().tables; },
  getRecords(tableId: string): MemRecord[] { return this.getDB().records[tableId] || []; },
  getActiveTableId(): string { return this.getDB().activeTableId; },
  setActiveTable(id: string): void { const db = this.getDB(); db.activeTableId = id; this.saveDB(db); },
  getTable(tableId: string): MemTable | null { return this.getDB().tables.find(function (t) { return t.id === tableId; }) || null; },

  // 主键 = 第一列（去掉 #/* 修饰符）
  _primaryColumn(table: MemTable): string { return (table.columns[0] || '').replace(/^[#*]/, ''); },

  // 剧情摘要表：确保有一条默认记录（主线/支线追加列）
  ensurePlotRecord(): MemRecord {
    const db = this.getDB();
    if (!db.records.plot_summary || db.records.plot_summary.length === 0) {
      db.records.plot_summary = [{ id: 'rec_plot_main', values: { '主线摘要': '', '支线摘要': '' } }];
      this.saveDB(db);
    }
    return db.records.plot_summary[0];
  },

  // 剧情摘要按行追加：
  // 1) 完全相同的行不重复追加（模型复读防护）
  // 2) 行首 [日期] 可解析时按日期排序插入，保持时间线有序
  // 3) 超过 PLOT_MAX_LINES 行时裁掉最旧的（滚动窗口）
  appendPlotLine(colName: string, line: string): MemRecord {
    const db = this.getDB();
    if (!db.records.plot_summary || db.records.plot_summary.length === 0) {
      db.records.plot_summary = [{ id: 'rec_plot_main', values: { '主线摘要': '', '支线摘要': '' } }];
    }
    const rec = db.records.plot_summary[0];
    const newText = String(line || '').trim();
    if (!newText) return rec;
    const old = rec.values[colName] || '';
    let lines = old ? old.split('\n').map(function (s) { return s.trim(); }).filter(Boolean) : [];
    if (lines.some(function (s) { return s === newText; })) return rec;
    lines.push(newText);
    // 日期感知排序：能解析 [M月D日 / YYYY年M月D日 / YYYY-M-D] 的行按时间排（缺年按 2000），解析不了的保持相对顺序垫底
    const dateRe = /(?:(\d{1,4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日|(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/;
    function sortKey(s: string): number {
      const m = s.match(dateRe);
      if (!m) return Number.MAX_SAFE_INTEGER;
      if (m[2] !== undefined && m[2] !== '') return Date.UTC(+(m[1] || 2000), +m[2] - 1, +m[3]);
      return Date.UTC(+m[4]!, +m[5]! - 1, +m[6]!);
    }
    lines.sort(function (a, b) {
      const ka = sortKey(a), kb = sortKey(b);
      if (ka === kb) return 0;
      if (ka === Number.MAX_SAFE_INTEGER) return 1;
      if (kb === Number.MAX_SAFE_INTEGER) return -1;
      return ka - kb;
    });
    if (lines.length > this.PLOT_MAX_LINES) lines = lines.slice(lines.length - this.PLOT_MAX_LINES);
    rec.values[colName] = lines.join('\n');
    this.saveDB(db);
    return rec;
  },

  // 主键别名拆分：「名字A|名字B」各段均指同一实体
  _pkAliases(v: string | undefined): string[] {
    return String(v || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
  },

  // 新增/更新记录（填表与手动编辑共用）。追加列（#前缀）：新内容按行拼到旧值后；普通列：覆盖。
  // 别名合并：新主键任一别名命中已有记录 → 视为同一记录，别名并回主键（第一段保持主姓名）。
  upsertRecord(tableId: string, values: Record<string, unknown>): MemRecord | null {
    const db = this.getDB();
    const table = this.getTable(tableId);
    if (!table) return null;
    const pk = this._primaryColumn(table);
    const pkVal = String(values[pk] || '').trim();
    if (!pkVal) return null;
    if (!db.records[tableId]) db.records[tableId] = [];
    const newAliases = this._pkAliases(pkVal);
    let rec = db.records[tableId].find(function (r) {
      const oldAliases = DatabaseManager._pkAliases(r.values[pk]);
      return oldAliases.some(function (o) { return newAliases.indexOf(o) >= 0; });
    });
    if (rec) {
      // 主键别名并集（原主段在前，保持稳定）
      const merged = this._pkAliases(rec.values[pk]).slice();
      newAliases.forEach(function (a) { if (merged.indexOf(a) < 0) merged.push(a); });
      rec.values[pk] = merged.join('|');
      table.columns.forEach(function (col) {
        const colName = col.replace(/^[#*]/, '');
        if (colName === pk) return;
        const v = values[colName];
        if (v == null) return;
        const tv = String(v).trim();
        if (!tv) return;
        if (col.charAt(0) === '#') {
          const old = rec!.values[colName] || '';
          // 追加列去重：新值已是旧值的末行则不重复拼
          const oldLines = old.trim() ? old.trim().split('\n') : [];
          if (oldLines.length && oldLines[oldLines.length - 1] === tv) return;
          rec!.values[colName] = old.trim() ? old.trim() + '\n' + tv : tv;
        } else {
          rec!.values[colName] = tv;
        }
      });
    } else {
      rec = { id: 'rec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), values: {} };
      table.columns.forEach(function (col) {
        const colName = col.replace(/^[#*]/, '');
        const v = values[colName];
        if (colName === pk) { rec!.values[colName] = newAliases.join('|'); return; }
        if (v != null && String(v).trim()) rec!.values[colName] = String(v).trim();
      });
      db.records[tableId].push(rec);
    }
    this.saveDB(db);
    return rec;
  },

  // 手动编辑记录：非追加列覆盖，追加列整段替换
  updateRecord(tableId: string, recordId: string, values: Record<string, unknown>): boolean {
    const db = this.getDB();
    const rec = (db.records[tableId] || []).find(function (r) { return r.id === recordId; });
    if (!rec) return false;
    const table = this.getTable(tableId)!;
    table.columns.forEach(function (col) {
      const colName = col.replace(/^[#*]/, '');
      if (values[colName] != null) rec.values[colName] = String(values[colName]).trim();
    });
    this.saveDB(db);
    return true;
  },

  deleteRecord(tableId: string, recordId: string): void {
    const db = this.getDB();
    db.records[tableId] = (db.records[tableId] || []).filter(function (r) { return r.id !== recordId; });
    this.saveDB(db);
  },

  // 清空当前书的整个数据库（重置本书时调用）
  clear(): void {
    const all = SM().get<Record<string, MemDB>>(this.KEY, {}) ?? {};
    delete all[this._bookId()];
    SM().set(this.KEY, all);
  },

  // 全部表格 dump 成文本（注入 prompt + 填表上下文）
  getTableDump(): string {
    const db = this.getDB();
    const lines: string[] = [];
    db.tables.forEach(function (t) {
      lines.push('#' + t.name);
      const recs = db.records[t.id] || [];
      if (recs.length === 0) { lines.push('（暂无记录）'); return; }
      const pk = DatabaseManager._primaryColumn(t);
      recs.forEach(function (r) {
        const segs: string[] = [];
        t.columns.forEach(function (col) {
          const colName = col.replace(/^[#*]/, '');
          if (colName === pk) return;
          const v = r.values[colName];
          if (v && String(v).trim()) segs.push(colName + '：' + String(v).trim());
        });
        lines.push('[' + ((r.values[pk] || '?') + '').trim() + ']' + (segs.length ? '|' + segs.join('|') : ''));
      });
    });
    return lines.join('\n');
  },
};

// 挂载已移除（单 bundle 改造 P3-B）：消费方 ES import；database.js 停发
export default DatabaseManager;