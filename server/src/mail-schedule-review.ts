import type { MailRecruitmentExtraction } from './mail-extraction-contracts.js'

export const MAIL_SCHEDULE_REVIEW_DECISIONS = ['auto_confirm', 'manual_review', 'reject'] as const
export type MailScheduleReviewDecision = typeof MAIL_SCHEDULE_REVIEW_DECISIONS[number]

export interface MailScheduleReviewEvidence {
  field: 'subject' | 'event_type' | 'time' | 'company' | 'position' | 'action'
  quote: string
}

export interface MailScheduleReview {
  schema_version: '1'
  decision: MailScheduleReviewDecision
  reason: string
  evidence: MailScheduleReviewEvidence[]
}

type JsonSchema = Record<string, unknown>

export const MAIL_SCHEDULE_REVIEW_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schema_version', 'decision', 'reason', 'evidence'],
  properties: {
    schema_version: { type: 'string', enum: ['1'] },
    decision: { type: 'string', enum: [...MAIL_SCHEDULE_REVIEW_DECISIONS] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    evidence: {
      type: 'array', minItems: 1, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false, required: ['field', 'quote'],
        properties: {
          field: { type: 'string', enum: ['subject', 'event_type', 'time', 'company', 'position', 'action'] },
          quote: { type: 'string', minLength: 1, maxLength: 500 }
        }
      }
    }
  }
}

const normalized = (value: string) => value.normalize('NFKC').replace(/\s/g, '').toLowerCase()

export function validateMailScheduleReview(value: unknown, sourceText: string): MailScheduleReview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('日程复核结果必须是对象')
  const data = value as Record<string, unknown>
  if (data.schema_version !== '1') throw new Error('日程复核 schema_version 无效')
  if (!MAIL_SCHEDULE_REVIEW_DECISIONS.includes(data.decision as MailScheduleReviewDecision)) {
    throw new Error('日程复核 decision 无效')
  }
  if (typeof data.reason !== 'string' || !data.reason.trim() || data.reason.trim().length > 1000) {
    throw new Error('日程复核 reason 无效')
  }
  if (!Array.isArray(data.evidence) || data.evidence.length < 1 || data.evidence.length > 8) {
    throw new Error('日程复核 evidence 必须是 1～8 项')
  }
  const allowed = new Set<MailScheduleReviewEvidence['field']>(['subject', 'event_type', 'time', 'company', 'position', 'action'])
  const source = normalized(sourceText)
  const evidence: MailScheduleReviewEvidence[] = []
  for (const [index, raw] of data.evidence.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`日程复核 evidence[${index}] 无效`)
    const item = raw as Record<string, unknown>
    if (!allowed.has(item.field as MailScheduleReviewEvidence['field']) || typeof item.quote !== 'string') {
      throw new Error(`日程复核 evidence[${index}] 字段无效`)
    }
    const quote = item.quote.trim().slice(0, 500)
    if (!quote || !source.includes(normalized(quote))) throw new Error(`日程复核 evidence[${index}] 不在邮件原文中`)
    evidence.push({ field: item.field as MailScheduleReviewEvidence['field'], quote })
  }
  return {
    schema_version: '1',
    decision: data.decision as MailScheduleReviewDecision,
    reason: data.reason.trim(),
    evidence
  }
}

export function reviewCanAutoConfirm(
  extraction: MailRecruitmentExtraction | null,
  review: MailScheduleReview | null
): boolean {
  return Boolean(extraction?.relevant && review?.decision === 'auto_confirm' && review.evidence.length > 0)
}
