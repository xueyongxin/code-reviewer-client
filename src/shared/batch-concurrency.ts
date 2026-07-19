/** 批量审查默认并发 */
export const DEFAULT_BATCH_REVIEW_CONCURRENCY = 2
/** 批量审查允许的最大并发 */
export const MAX_BATCH_REVIEW_CONCURRENCY = 5
/** 批量审查允许的最小并发 */
export const MIN_BATCH_REVIEW_CONCURRENCY = 1

/** 将用户配置钳制到 1–5，非法值回落默认 2 */
export const clampBatchReviewConcurrency = (value?: number | null): number => {
  if (value == null) return DEFAULT_BATCH_REVIEW_CONCURRENCY
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return DEFAULT_BATCH_REVIEW_CONCURRENCY
  return Math.min(
    MAX_BATCH_REVIEW_CONCURRENCY,
    Math.max(MIN_BATCH_REVIEW_CONCURRENCY, n)
  )
}
