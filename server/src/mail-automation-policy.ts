import type { MailRecruitmentExtraction } from './mail-extraction-contracts.js'
import { reviewCanAutoConfirm, type MailScheduleReview } from './mail-schedule-review.js'

const ACTIONABLE_EVENTS = new Set(['assessment', 'written_test', 'interview', 'ai_interview'])

/**
 * 自动确认使用比人工草稿更严格的门槛：独立复核必须明确放行，事件和关键时间
 * 还必须有逐字段原文证据。低置信度、无明确时间以及 Offer/其他事项始终交给用户核对。
 */
export function canAutomaticallyConfirm(
  extraction: MailRecruitmentExtraction | null,
  review: MailScheduleReview | null
): boolean {
  if (!reviewCanAutoConfirm(extraction, review) || !extraction || extraction.confidence !== 'high' || !ACTIONABLE_EVENTS.has(extraction.event_type)) return false
  const evidence = new Set(extraction.evidence.map(item => item.field))
  if (!evidence.has('event_type')) return false
  if (extraction.time_mode === 'fixed') return Boolean(extraction.scheduled_at && evidence.has('scheduled_at'))
  if (extraction.time_mode === 'window') {
    return Boolean(extraction.window_start_at && extraction.window_end_at
      && evidence.has('window_start_at') && evidence.has('window_end_at'))
  }
  if (extraction.time_mode === 'deadline') return Boolean(extraction.deadline_at && evidence.has('deadline_at'))
  if (extraction.time_mode === 'duration_after_open') {
    return Boolean(extraction.duration_minutes && evidence.has('duration_minutes')
      && (!extraction.deadline_at || evidence.has('deadline_at')))
  }
  return false
}
