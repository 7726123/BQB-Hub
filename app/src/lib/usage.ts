// UsageStats：续写会话用量统计（tokens/缓存命中/费用）+ 用量历史渲染。
// 迁移自 www/modules/usage.js；文件尾部的 _wbKey 全局函数（book.js 依赖）也一并迁移。
// 外部依赖解析约定：裸标识符（详见 variables.ts 头注）——旧脚本顶层 const 不挂 globalThis。
import { SM } from '../infra/gate';
import { WorldBookManager } from '../domain/worldbook';
interface ApiCallRecord {
  label: string;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  cost?: number;
}
interface ApiConfigLike { priceInput?: number; priceCached?: number; priceOutput?: number }


export interface UsageRecord {
  id: string | null;
  time: number | null;
  duration: number;
  apiCalls: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  hitRate: string;
  cost: number;
  wordCount: number;
  byLabel: Record<string, { count: number; promptTokens: number; cachedTokens: number; completionTokens: number }>;
}

export const UsageStats = {
  MAX_HISTORY: 10,
  _sessionCalls: [] as ApiCallRecord[],
  _sessionStartIndex: null as number | null,
  _sessionStartTime: null as number | null,
  _currentSessionId: null as string | null,

  beginSession(): void {
    this._sessionCalls = [];
    this._sessionStartIndex = APIHandler._apiCalls.length;
    this._sessionStartTime = Date.now();
    this._currentSessionId = 'sess_' + Date.now();
  },

  endSession(wordCount: number): UsageRecord | null {
    if (this._sessionStartIndex === null) return null;
    const calls = APIHandler._apiCalls.slice(this._sessionStartIndex);
    if (calls.length === 0) return null;

    let totalPrompt = 0, totalCached = 0, totalCompletion = 0, totalCost = 0;
    const byLabel: UsageRecord['byLabel'] = {};
    calls.forEach(c => {
      totalPrompt += c.promptTokens || 0;
      totalCached += c.cachedTokens || 0;
      totalCompletion += c.completionTokens || 0;
      totalCost += c.cost || 0;
      if (!byLabel[c.label]) byLabel[c.label] = { count: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
      byLabel[c.label].count++;
      byLabel[c.label].promptTokens += c.promptTokens || 0;
      byLabel[c.label].cachedTokens += c.cachedTokens || 0;
      byLabel[c.label].completionTokens += c.completionTokens || 0;
    });

    const hitRate = totalPrompt > 0 ? (totalCached / totalPrompt * 100).toFixed(1) : '0.0';
    const record: UsageRecord = {
      id: this._currentSessionId,
      time: this._sessionStartTime,
      duration: Date.now() - (this._sessionStartTime ?? Date.now()),
      apiCalls: calls.length,
      promptTokens: totalPrompt,
      cachedTokens: totalCached,
      completionTokens: totalCompletion,
      hitRate: hitRate,
      cost: totalCost,
      wordCount: wordCount || 0,
      byLabel: byLabel
    };

    const history = SM().get<UsageRecord[]>('usageHistory', []) ?? [];
    history.unshift(record);
    if (history.length > this.MAX_HISTORY) history.length = this.MAX_HISTORY;
    SM().set('usageHistory', history);

    this._sessionStartIndex = null;
    this._currentSessionId = null;
    this.render();
    return record;
  },

  getHistory(): UsageRecord[] {
    return SM().get<UsageRecord[]>('usageHistory', []) ?? [];
  },

  clearHistory(): void {
    SM().set('usageHistory', []);
    this.render();
    App.toast('历史已清空');
  },

  formatDuration(ms: number): string {
    if (ms < 1000) return ms + 'ms';
    return (ms / 1000).toFixed(1) + 's';
  },

  formatCost(cost: number): string {
    return '¥' + cost.toFixed(6);
  },

  // 输出速度（tokens/秒）：会话内所有调用（续写+摘要+填表+二审等）的输出 token 总和 / 实际耗时。
  // 注意分母含全部调用时间（不只正文生成），故略低于纯生成速度；字面标注「输出速度」。
  outputSpeed(completionTokens: number, durationMs: number): number {
    if (!completionTokens || !durationMs || durationMs <= 0) return 0;
    return completionTokens / (durationMs / 1000);
  },

  formatSpeed(completionTokens: number, durationMs: number): string {
    const v = this.outputSpeed(completionTokens, durationMs);
    if (v <= 0) return '—';
    return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + ' tokens/s';
  },

  render(): void {
    const history = this.getHistory();
    const sessionEl = document.getElementById('usageSessionStats');
    const listEl = document.getElementById('usageHistoryList');
    const cfg = SM().get<ApiConfigLike>('apiConfig', {}) ?? {};

    if (history.length === 0) {
      if (sessionEl) sessionEl.innerHTML = '';
      if (listEl) listEl.innerHTML = '<div class="empty-box"><div class="empty-tt">暂无用量记录</div><div class="empty-sub">续写完成后自动记录 tokens 与费用</div></div>';
      return;
    }

    const totalAll = history.reduce((acc, r) => {
      acc.promptTokens += r.promptTokens;
      acc.cachedTokens += r.cachedTokens;
      acc.completionTokens += r.completionTokens;
      acc.cost += r.cost;
      acc.apiCalls += r.apiCalls;
      acc.wordCount += r.wordCount;
      return acc;
    }, { promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0, apiCalls: 0, wordCount: 0 });

    const overallHitRate = totalAll.promptTokens > 0 ? (totalAll.cachedTokens / totalAll.promptTokens * 100).toFixed(1) : '0.0';

    if (sessionEl) {
      const totalSpeed = this.outputSpeed(totalAll.completionTokens, history.reduce((acc, r) => acc + (r.duration || 0), 0));
      sessionEl.innerHTML = `
        <section class="set-group">
          <div class="set-group-head"><span class="set-badge">汇</span><span class="set-group-name">累计统计</span><i class="set-rule"></i><span class="set-group-count">${history.length} 次续写</span></div>
          <div class="stat-grid" style="margin-top:10px;">
            <div class="stat-cell"><div class="st-label">API 调用</div><div class="st-value">${totalAll.apiCalls}<span class="st-unit">次</span></div></div>
            <div class="stat-cell"><div class="st-label">总字数</div><div class="st-value">${totalAll.wordCount.toLocaleString()}</div></div>
            <div class="stat-cell hl-accent"><div class="st-label">总费用</div><div class="st-value">${this.formatCost(totalAll.cost)}</div></div>
            <div class="stat-cell"><div class="st-label">输入 tokens</div><div class="st-value">${totalAll.promptTokens.toLocaleString()}</div></div>
            <div class="stat-cell hl-primary"><div class="st-label">缓存命中</div><div class="st-value">${overallHitRate}<span class="st-unit">%</span></div></div>
            <div class="stat-cell"><div class="st-label">输出速度</div><div class="st-value">${totalSpeed > 0 ? (totalSpeed >= 100 ? totalSpeed.toFixed(0) : totalSpeed.toFixed(1)) : '—'}<span class="st-unit">tok/s</span></div></div>
          </div>
          <div class="stat-foot">费用估算：输入 ¥${cfg.priceInput ?? 1}/1M · 缓存 ¥${cfg.priceCached ?? 0.1}/1M · 输出 ¥${cfg.priceOutput ?? 2}/1M（可在「我的 · 模型与密钥」中修改）</div>
        </section>`;
    }

    if (listEl) {
      listEl.innerHTML = history.map((r, i) => {
        const date = new Date(r.time ?? 0);
        const timeStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `
        <div class="uh-card">
          <div class="uh-head">
            <span class="chip chip-primary">#${history.length - i}</span>
            <span class="chip chip-default">${this.formatDuration(r.duration)}</span>
            <span class="uh-time">${timeStr}</span>
          </div>
          <div class="uh-grid">
            <div>调用<b>${r.apiCalls}次</b></div>
            <div>字数<b>${r.wordCount}</b></div>
            <div>费用<b>${this.formatCost(r.cost)}</b></div>
            <div>输入<b>${r.promptTokens.toLocaleString()}</b></div>
            <div>缓存<b style="color:var(--primary)">${r.hitRate}%</b></div>
            <div>输出<b>${r.completionTokens.toLocaleString()}</b></div>
          </div>
          ${r.wordCount > 0 ? '<div class="uh-foot">输出速度 ' + this.formatSpeed(r.completionTokens, r.duration) + ' · 输出 ' + r.completionTokens.toLocaleString() + ' tokens</div>' : '<div class="uh-foot">输出速度 ' + this.formatSpeed(r.completionTokens, r.duration) + '</div>'}
        </div>`;
      }).join('');
    }
  }
};

// 世界书作用域的存储键（book/ui/app 经 ES import 使用；不再挂全局）
function _wbKey(key: string): string {
  const wb = typeof WorldBookManager !== 'undefined' ? WorldBookManager.getActive() : null;
  return key + '_wb_' + (wb ? wb.id : 'none');
}

export { _wbKey };
export default UsageStats;