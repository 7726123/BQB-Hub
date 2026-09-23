// 审核留痕：只记录「谁在什么时候对哪条内容做了什么」，不保存内容本体。
// 用途是证明平台确实在处置（收到反馈即删、发现违规即下架），而不是放任不管；
// 也因此这里刻意不存任何正文/文件引用，避免留痕本身成为风险。
const db = require('./db');

/** action: approve | reject | delete */
function logAction(targetType, targetId, action, note, admin) {
  try {
    db.prepare('INSERT INTO review_log (ts, target_type, target_id, action, note, admin) VALUES (?, ?, ?, ?, ?, ?)')
      .run(Date.now(), String(targetType || ''), Number(targetId) || 0, String(action || ''), String(note || '').slice(0, 200), String(admin || ''));
  } catch (e) { console.warn('[review] 留痕写入失败:', e.message); }
}

module.exports = { logAction };
