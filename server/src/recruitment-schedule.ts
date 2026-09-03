import {
  MAIL_EVENT_TYPES, MAIL_TIME_MODES,
  type MailEventType, type MailTimeMode
} from './mail-extraction-contracts.js'

export interface RecruitmentScheduleInput {
  applicationId: number | null
  eventType: MailEventType
  title: string
  company: string
  position: string
  timeMode: MailTimeMode
  scheduledAt: string | null
  windowStartAt: string | null
  windowEndAt: string | null
  deadlineAt: string | null
  durationMinutes: number | null
  timezone: 'Asia/Shanghai'
  location: string
  meetingLink: string
  actionLink: string
  contact: string
  instructions: string[]
}

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScheduleValidationError'
  }
}

const eventLabels: Record<MailEventType, string> = {
  assessment: '在线测评', written_test: '笔试', interview: '面试', ai_interview: 'AI 面试',
  offer: 'Offer / 录用', other: '招聘流程事项'
}

function valueText(value: unknown, label: string, maxLength: number): string {
  if (value == null) return ''
  if (typeof value !== 'string') throw new ScheduleValidationError(`${label}格式无效`)
  const result = value.trim()
  if (result.length > maxLength) throw new ScheduleValidationError(`${label}不能超过 ${maxLength} 个字符`)
  return result
}

function dateTime(value: unknown, label: string): string | null {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new ScheduleValidationError(`${label}格式无效`)
  const result = value.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(result)
  if (!match) throw new ScheduleValidationError(`${label}必须是 YYYY-MM-DD HH:mm`)
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const check = new Date(Date.UTC(year, month - 1, day, hour, minute))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) {
    throw new ScheduleValidationError(`${label}不是有效日期时间`)
  }
  return result
}

function httpLink(value: unknown, label: string): string {
  const link = valueText(value, label, 2048)
  if (!link) return ''
  try {
    const parsed = new URL(link)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error()
  } catch {
    throw new ScheduleValidationError(`${label}必须是完整的 http(s) 链接`)
  }
  return link
}

export function validateRecruitmentScheduleInput(value: unknown): RecruitmentScheduleInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ScheduleValidationError('日程内容格式无效')
  const data = value as Record<string, unknown>
  if (!MAIL_EVENT_TYPES.includes(data.eventType as MailEventType)) throw new ScheduleValidationError('事件类型无效')
  if (!MAIL_TIME_MODES.includes(data.timeMode as MailTimeMode)) throw new ScheduleValidationError('时间规则无效')
  const applicationId = data.applicationId == null || data.applicationId === '' ? null : Number(data.applicationId)
  if (applicationId !== null && (!Number.isInteger(applicationId) || applicationId <= 0)) {
    throw new ScheduleValidationError('关联投递编号无效')
  }
  const eventType = data.eventType as MailEventType
  const timeMode = data.timeMode as MailTimeMode
  const company = valueText(data.company, '公司', 200)
  const position = valueText(data.position, '岗位', 200)
  const providedTitle = valueText(data.title, '标题', 300)
  const title = providedTitle || [...new Set([company, position, eventLabels[eventType]].filter(Boolean))].join(' · ')
  if (!title) throw new ScheduleValidationError('日程标题不能为空')

  let scheduledAt = dateTime(data.scheduledAt, '固定开始时间')
  let windowStartAt = dateTime(data.windowStartAt, '窗口开始时间')
  let windowEndAt = dateTime(data.windowEndAt, '窗口结束时间')
  let deadlineAt = dateTime(data.deadlineAt, '截止时间')
  let durationMinutes = data.durationMinutes == null || data.durationMinutes === '' ? null : Number(data.durationMinutes)
  if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 10080)) {
    throw new ScheduleValidationError('开始后限时必须是 1～10080 分钟')
  }

  if (timeMode === 'fixed') {
    if (!scheduledAt) throw new ScheduleValidationError('固定时间事项必须填写开始时间')
    windowStartAt = null; windowEndAt = null; durationMinutes = null
  } else if (timeMode === 'window') {
    if (!windowStartAt || !windowEndAt) throw new ScheduleValidationError('时间窗口必须同时填写开放和关闭时间')
    if (windowStartAt >= windowEndAt) throw new ScheduleValidationError('窗口结束时间必须晚于开始时间')
    scheduledAt = null
  } else if (timeMode === 'deadline') {
    if (!deadlineAt) throw new ScheduleValidationError('截止时间事项必须填写截止时间')
    scheduledAt = null; windowStartAt = null; windowEndAt = null; durationMinutes = null
  } else if (timeMode === 'duration_after_open') {
    if (durationMinutes === null) throw new ScheduleValidationError('开始后计时事项必须填写限时分钟数')
    scheduledAt = null; windowStartAt = null; windowEndAt = null
  } else {
    scheduledAt = null; windowStartAt = null; windowEndAt = null; deadlineAt = null; durationMinutes = null
  }

  const rawInstructions = data.instructions
  if (!Array.isArray(rawInstructions)) throw new ScheduleValidationError('执行要求必须是数组')
  const instructions = rawInstructions.slice(0, 20).map((item, index) => {
    const result = valueText(item, `执行要求第 ${index + 1} 项`, 500)
    if (!result) throw new ScheduleValidationError(`执行要求第 ${index + 1} 项不能为空`)
    return result
  })

  return {
    applicationId, eventType, title, company, position, timeMode, scheduledAt,
    windowStartAt, windowEndAt, deadlineAt, durationMinutes, timezone: 'Asia/Shanghai',
    location: valueText(data.location, '地点', 500),
    meetingLink: httpLink(data.meetingLink, '会议链接'),
    actionLink: httpLink(data.actionLink, '操作链接'),
    contact: valueText(data.contact, '联系人', 500), instructions
  }
}
