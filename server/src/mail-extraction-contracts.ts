type JsonSchema = Record<string, unknown>

export const MAIL_EVENT_TYPES = ['assessment', 'written_test', 'interview', 'ai_interview', 'offer', 'other'] as const
export const MAIL_TIME_MODES = ['fixed', 'window', 'deadline', 'duration_after_open', 'flexible', 'unknown'] as const
export const MAIL_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
export const MAIL_EVIDENCE_FIELDS = [
  'event_type', 'company', 'position', 'round', 'scheduled_at', 'window_start_at',
  'window_end_at', 'deadline_at', 'duration_minutes', 'location', 'meeting_link',
  'action_link', 'contact', 'instructions'
] as const

export type MailEventType = typeof MAIL_EVENT_TYPES[number]
export type MailTimeMode = typeof MAIL_TIME_MODES[number]
export type MailConfidence = typeof MAIL_CONFIDENCE_LEVELS[number]
export type MailEvidenceField = typeof MAIL_EVIDENCE_FIELDS[number]

export interface MailExtractionEvidence {
  field: MailEvidenceField
  quote: string
}

export interface MailRecruitmentExtraction {
  schema_version: '1'
  relevant: boolean
  event_type: MailEventType
  company: string
  position: string
  round: string
  title: string
  time_mode: MailTimeMode
  scheduled_at: string | null
  window_start_at: string | null
  window_end_at: string | null
  deadline_at: string | null
  duration_minutes: number | null
  timezone: 'Asia/Shanghai'
  location: string
  meeting_link: string
  action_link: string
  contact: string
  instructions: string[]
  confidence: MailConfidence
  evidence: MailExtractionEvidence[]
  warnings: string[]
}

const nullableString = (maxLength: number): JsonSchema => ({ type: ['string', 'null'], maxLength })
const string = (maxLength: number): JsonSchema => ({ type: 'string', maxLength })

export const MAIL_RECRUITMENT_EXTRACTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'schema_version', 'relevant', 'event_type', 'company', 'position', 'round', 'title',
    'time_mode', 'scheduled_at', 'window_start_at', 'window_end_at', 'deadline_at',
    'duration_minutes', 'timezone', 'location', 'meeting_link', 'action_link', 'contact',
    'instructions', 'confidence', 'evidence', 'warnings'
  ],
  properties: {
    schema_version: { type: 'string', enum: ['1'] },
    relevant: { type: 'boolean' },
    event_type: { type: 'string', enum: [...MAIL_EVENT_TYPES] },
    company: string(200),
    position: string(200),
    round: string(100),
    title: string(300),
    time_mode: { type: 'string', enum: [...MAIL_TIME_MODES] },
    scheduled_at: nullableString(16),
    window_start_at: nullableString(16),
    window_end_at: nullableString(16),
    deadline_at: nullableString(16),
    duration_minutes: { type: ['integer', 'null'], minimum: 1, maximum: 10080 },
    timezone: { type: 'string', enum: ['Asia/Shanghai'] },
    location: string(500),
    meeting_link: string(2048),
    action_link: string(2048),
    contact: string(500),
    instructions: { type: 'array', maxItems: 10, items: string(500) },
    confidence: { type: 'string', enum: [...MAIL_CONFIDENCE_LEVELS] },
    evidence: {
      type: 'array', maxItems: 30, items: {
        type: 'object', additionalProperties: false, required: ['field', 'quote'], properties: {
          field: { type: 'string', enum: [...MAIL_EVIDENCE_FIELDS] },
          quote: string(500)
        }
      }
    },
    warnings: { type: 'array', maxItems: 10, items: string(500) }
  }
}

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} 必须是对象`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[], at: string): void {
  const missing = keys.filter(key => !Object.hasOwn(value, key))
  const extra = Object.keys(value).filter(key => !keys.includes(key))
  if (missing.length) throw new Error(`${at} 缺少字段：${missing.join('、')}`)
  if (extra.length) throw new Error(`${at} 含未定义字段：${extra.join('、')}`)
}

function text(value: unknown, at: string, maxLength: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${at} 必须是字符串`)
  const result = value.trim()
  if (required && !result) throw new Error(`${at} 不能为空`)
  if (result.length > maxLength) throw new Error(`${at} 超过最大长度 ${maxLength}`)
  return result
}

function nullableDateTime(value: unknown, at: string): string | null {
  if (value === null) return null
  const result = text(value, at, 16, true)
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(result)
  if (!match) throw new Error(`${at} 必须是 YYYY-MM-DD HH:mm 或 null`)
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    throw new Error(`${at} 不是有效日期时间`)
  }
  return result
}

function stringList(value: unknown, at: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${at} 必须是不超过 ${maxItems} 项的数组`)
  return value.map((item, index) => text(item, `${at}[${index}]`, maxLength, true))
}

const normalized = (value: string) => value.normalize('NFKC').replace(/\s/g, '').toLowerCase()

function verifiedLink(value: unknown, at: string, sourceUrls: string[]): string {
  const link = text(value, at, 2048)
  if (!link) return ''
  let parsed: URL
  try { parsed = new URL(link) } catch { throw new Error(`${at} 不是完整链接`) }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`${at} 协议不安全`)
  if (!sourceUrls.includes(link)) throw new Error(`${at} 不在邮件原始链接中`)
  return link
}

export function validateMailRecruitmentExtraction(
  value: unknown,
  sourceText: string,
  sourceUrls: string[]
): MailRecruitmentExtraction {
  const data = record(value, '$')
  const keys = [
    'schema_version', 'relevant', 'event_type', 'company', 'position', 'round', 'title',
    'time_mode', 'scheduled_at', 'window_start_at', 'window_end_at', 'deadline_at',
    'duration_minutes', 'timezone', 'location', 'meeting_link', 'action_link', 'contact',
    'instructions', 'confidence', 'evidence', 'warnings'
  ]
  const missing = keys.filter(key => !Object.hasOwn(data, key))
  if (missing.length) throw new Error(`$ 缺少字段：${missing.join('、')}`)
  if (data.schema_version !== '1') throw new Error('$.schema_version 必须是 1')
  if (typeof data.relevant !== 'boolean') throw new Error('$.relevant 必须是布尔值')
  const relevant = data.relevant
  if (!MAIL_EVENT_TYPES.includes(data.event_type as MailEventType)) throw new Error('$.event_type 无效')
  if (!MAIL_TIME_MODES.includes(data.time_mode as MailTimeMode)) throw new Error('$.time_mode 无效')
  if (!MAIL_CONFIDENCE_LEVELS.includes(data.confidence as MailConfidence)) throw new Error('$.confidence 无效')
  if (data.timezone !== 'Asia/Shanghai') throw new Error('$.timezone 必须是 Asia/Shanghai')

  const diagnostics: string[] = []
  const warn = (message: string) => {
    if (!diagnostics.includes(message)) diagnostics.push(message)
  }
  let modelWarnings: string[] = []
  try { modelWarnings = stringList(data.warnings, '$.warnings', 10, 500) } catch { warn('模型警告字段格式异常，已忽略') }

  if (!relevant) {
    return {
      schema_version: '1', relevant: false, event_type: 'other', company: '', position: '', round: '', title: '',
      time_mode: 'unknown', scheduled_at: null, window_start_at: null, window_end_at: null, deadline_at: null,
      duration_minutes: null, timezone: 'Asia/Shanghai', location: '', meeting_link: '', action_link: '', contact: '',
      instructions: [], confidence: data.confidence as MailConfidence, evidence: [], warnings: [...new Set([...modelWarnings, ...diagnostics])].slice(0, 10)
    }
  }

  const safeText = (input: unknown, field: string, maxLength: number): string => {
    try { return text(input, field, maxLength) } catch { warn(`${field} 格式异常，已留空`); return '' }
  }
  const safeDate = (input: unknown, field: string): string | null => {
    try { return nullableDateTime(input, field) } catch { warn(`${field} 不是有效时间，已留空`); return null }
  }
  const safeLink = (input: unknown, field: string): string => {
    try { return verifiedLink(input, field, sourceUrls) } catch { warn(`${field} 不在邮件原始链接中，已移除`); return '' }
  }

  const evidence: MailExtractionEvidence[] = []
  if (Array.isArray(data.evidence)) {
    for (const raw of data.evidence.slice(0, 30)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warn('一条原文证据格式异常，已忽略'); continue }
      const item = raw as Record<string, unknown>
      if (!MAIL_EVIDENCE_FIELDS.includes(item.field as MailEvidenceField) || typeof item.quote !== 'string') {
        warn('一条原文证据字段无效，已忽略'); continue
      }
      const quote = item.quote.trim().slice(0, 500)
      if (!quote || !normalized(sourceText).includes(normalized(quote))) {
        warn('一条模型引用无法在邮件原文中找到，已忽略'); continue
      }
      evidence.push({ field: item.field as MailEvidenceField, quote })
    }
  } else {
    warn('模型未返回可用的原文证据')
  }

  const evidenceQuotes = (field: MailEvidenceField) => evidence
    .filter(item => item.field === field).map(item => normalized(item.quote))
  const hasEvidence = (field: MailEvidenceField) => evidenceQuotes(field).length > 0
  const supportedText = (field: MailEvidenceField, value: string, label: string): string => {
    if (!value) return ''
    const target = normalized(value)
    if (evidenceQuotes(field).some(quote => quote.includes(target))) return value
    warn(`${label}缺少可核对的原文依据，已留空`)
    return ''
  }
  const supportedDate = (field: MailEvidenceField, value: string | null, label: string): string | null => {
    if (!value) return null
    if (hasEvidence(field)) return value
    warn(`${label}缺少原文依据，已留空`)
    return null
  }

  let eventType = data.event_type as MailEventType
  if (!hasEvidence('event_type')) {
    const patterns: Record<MailEventType, RegExp> = {
      assessment: /在线测评|人才测评|性格测评|能力测评|测评/u,
      written_test: /在线笔试|笔试|编程考试|机考/u,
      interview: /面试|电话沟通|视频沟通/u,
      ai_interview: /AI\s*面试|AI\s*面|数字人面试/u,
      offer: /Offer|录用|签约|入职确认/iu,
      other: /招聘|投递|候选人|完善简历|招聘流程/u
    }
    const match = sourceText.match(patterns[eventType])
    if (match?.[0]) evidence.push({ field: 'event_type', quote: match[0] })
    else { eventType = 'other'; warn('事件类型缺少明确原文依据，已标为其他招聘事项') }
  }

  let duration: number | null = null
  if (data.duration_minutes !== null) {
    if (Number.isInteger(data.duration_minutes) && Number(data.duration_minutes) >= 1 && Number(data.duration_minutes) <= 10080) {
      duration = Number(data.duration_minutes)
      if (!hasEvidence('duration_minutes')) { duration = null; warn('作答时长缺少原文依据，已留空') }
    } else warn('作答时长格式异常，已留空')
  }

  let instructions: string[] = []
  if (Array.isArray(data.instructions)) {
    const quotes = evidenceQuotes('instructions')
    for (const raw of data.instructions.slice(0, 10)) {
      if (typeof raw !== 'string' || !raw.trim()) continue
      const instruction = raw.trim().slice(0, 500)
      if (quotes.some(quote => quote.includes(normalized(instruction)))) instructions.push(instruction)
      else warn('一条执行要求缺少可核对的原文依据，已忽略')
    }
  } else warn('执行要求格式异常，已留空')

  let meetingLink = safeLink(data.meeting_link, '$.meeting_link')
  let actionLink = safeLink(data.action_link, '$.action_link')
  if (meetingLink && !hasEvidence('meeting_link')) evidence.push({ field: 'meeting_link', quote: meetingLink })
  if (actionLink && !hasEvidence('action_link')) evidence.push({ field: 'action_link', quote: actionLink })

  let scheduledAt = supportedDate('scheduled_at', safeDate(data.scheduled_at, '$.scheduled_at'), '固定时间')
  let windowStartAt = supportedDate('window_start_at', safeDate(data.window_start_at, '$.window_start_at'), '窗口开始时间')
  let windowEndAt = supportedDate('window_end_at', safeDate(data.window_end_at, '$.window_end_at'), '窗口结束时间')
  let deadlineAt = supportedDate('deadline_at', safeDate(data.deadline_at, '$.deadline_at'), '截止时间')

  if ((windowStartAt && !windowEndAt) || (!windowStartAt && windowEndAt) || (windowStartAt && windowEndAt && windowStartAt >= windowEndAt)) {
    windowStartAt = null; windowEndAt = null
    warn('时间窗口不完整或顺序有误，已留空')
  }

  let timeMode: MailTimeMode
  const requestedMode = data.time_mode as MailTimeMode
  if (requestedMode === 'window' && windowStartAt && windowEndAt) timeMode = 'window'
  else if (requestedMode === 'fixed' && scheduledAt) timeMode = 'fixed'
  else if (requestedMode === 'duration_after_open' && duration !== null) timeMode = 'duration_after_open'
  else if (requestedMode === 'deadline' && deadlineAt) timeMode = 'deadline'
  else if (scheduledAt) timeMode = 'fixed'
  else if (windowStartAt && windowEndAt) timeMode = 'window'
  else if (duration !== null) timeMode = 'duration_after_open'
  else if (deadlineAt) timeMode = 'deadline'
  else if (requestedMode === 'flexible') timeMode = 'flexible'
  else timeMode = 'unknown'

  if (timeMode === 'fixed') { windowStartAt = null; windowEndAt = null }
  if (timeMode === 'window') scheduledAt = null
  if (timeMode === 'duration_after_open' || timeMode === 'deadline') {
    scheduledAt = null; windowStartAt = null; windowEndAt = null
  }
  if (timeMode === 'flexible' || timeMode === 'unknown') {
    scheduledAt = null; windowStartAt = null; windowEndAt = null; deadlineAt = null; duration = null
  }

  const company = supportedText('company', safeText(data.company, '$.company', 200), '公司')
  const position = supportedText('position', safeText(data.position, '$.position', 200), '岗位')
  const round = supportedText('round', safeText(data.round, '$.round', 100), '轮次')
  const location = supportedText('location', safeText(data.location, '$.location', 500), '地点')
  const contact = supportedText('contact', safeText(data.contact, '$.contact', 500), '联系人')
  const eventLabels: Record<MailEventType, string> = {
    assessment: '在线测评', written_test: '笔试', interview: '面试', ai_interview: 'AI 面试', offer: 'Offer / 录用', other: '招聘流程事项'
  }
  const title = [...new Set([company, position, round, eventLabels[eventType]].filter(Boolean))].join(' · ').slice(0, 300)

  const activeEvidence = new Set<MailEvidenceField>(['event_type'])
  if (company) activeEvidence.add('company')
  if (position) activeEvidence.add('position')
  if (round) activeEvidence.add('round')
  if (scheduledAt) activeEvidence.add('scheduled_at')
  if (windowStartAt) activeEvidence.add('window_start_at')
  if (windowEndAt) activeEvidence.add('window_end_at')
  if (deadlineAt) activeEvidence.add('deadline_at')
  if (duration !== null) activeEvidence.add('duration_minutes')
  if (location) activeEvidence.add('location')
  if (meetingLink) activeEvidence.add('meeting_link')
  if (actionLink) activeEvidence.add('action_link')
  if (contact) activeEvidence.add('contact')
  if (instructions.length) activeEvidence.add('instructions')
  const finalWarnings = [...new Set([...modelWarnings, ...diagnostics])].slice(0, 10)

  const result: MailRecruitmentExtraction = {
    schema_version: '1', relevant: true, event_type: eventType, company, position, round, title,
    time_mode: timeMode, scheduled_at: scheduledAt, window_start_at: windowStartAt,
    window_end_at: windowEndAt, deadline_at: deadlineAt, duration_minutes: duration,
    timezone: 'Asia/Shanghai', location, meeting_link: meetingLink, action_link: actionLink,
    contact, instructions, confidence: finalWarnings.length ? 'low' : data.confidence as MailConfidence,
    evidence: evidence.filter(item => activeEvidence.has(item.field)), warnings: finalWarnings
  }
  return result
}
