/**
 * 只有本轮任务真的产生新 commit 时才展示改动摘要。
 *
 * 之前直接用 lastGoodCommit..HEAD，会把历史未激活提交和用户已有的未提交改动
 * 都算到这次任务上，随便问一句也会弹出几十个文件。
 */
export function shouldShowTaskPreview({ startHead, endHead, changes, dirty } = {}) {
  if (!startHead || !endHead || startHead === endHead) return false;
  const count = Array.isArray(changes) ? changes.length : 0;
  return count > 0 || dirty === true;
}
