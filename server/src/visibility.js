// 审核可见性谓词：公开路径只认 status = 'approved'；按 id 取单行的接口（详情/预览/下载）
// 给作者与管理员开口子——作者要看得到自己的待审稿，管理员要能先预览再决定审不审。
// 抽在一处是为了不让十余处 SQL 各写一遍：漏一个点就是未过审内容泄漏。
const { isAdminReq } = require('./auth');

/** 公开可见谓词（列表 / 检索拼进 WHERE） */
function approvedSql() { return "status = 'approved'"; }

/**
 * 单行可见性：管理员全可见；其余人只可见已通过的、或自己上传的。
 * 调用方的 SELECT 必须带上 status 与 author_id——漏带会按不可见处理
 * （fail closed：宁可 404 也不把未过审内容漏出去）。
 */
function canSee(req, row) {
  if (!row) return false;
  if (isAdminReq(req)) return true;
  if (row.status === 'approved') return true;
  return !!(req && req.user && row.author_id === req.user.id);
}

module.exports = { approvedSql, canSee };
