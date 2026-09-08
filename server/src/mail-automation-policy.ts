import type { MailRecruitmentExtraction } from './mail-extraction-contracts.js'
import { reviewCanAutoConfirm, type MailScheduleReview } from './mail-schedule-review.js'

/**
 * 日程是否自动写入只由独立复核结论决定。提取阶段的置信度、时间完整度和正文长度
 * 都是供复核器判断的上下文，不再作为第二道业务拦截，避免重复人工处理。
 */
export function canAutomaticallyConfirm(
  extraction: MailRecruitmentExtraction | null,
  review: MailScheduleReview | null
): boolean {
  return reviewCanAutoConfirm(extraction, review)
}
