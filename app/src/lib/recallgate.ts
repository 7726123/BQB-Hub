// 归档回读注入的预算与去重闸门（三条通道共用：点名锚 / 实体直收 / 分数填充）。
//
// 为什么需要独立闸门：点名锚与实体直收原先无条件塞入，注释按「每条约 800 字」估算
// （6 条 ≈ 4.8k 字），但正文一整行时检索单元会退化成整块 8000 字（成因见 lib/htmltext.ts）——
// 真机留档实测一轮注入 42182 字 = 预算 10000 的 4.2 倍，且同一片段被塞了 3 次
// （直收只记录 seen、不跳过重复文本），预算被吃光后「按分数填充」通道一条都进不来。

/** 片段去重键：忽略空白后取前 40 字（与历史行为一致，勿改，改了会让老缓存失效） */
export function recallKey(text: string): string {
  return String(text || '').replace(/\s+/g, '').slice(0, 40);
}

/** 预算闸门：首条允许超预算（单条比预算还大时也得给一条，避免整轮空注入），其余一律不得超。
 *  去重由调用方按 recallKey 负责（同文本只收一次）。 */
export function recallFits(used: number, len: number, budget: number, picked: number): boolean {
  if (picked <= 0) return true;
  return used + len <= budget;
}

export default recallFits;
