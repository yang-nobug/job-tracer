import test from 'node:test'
import assert from 'node:assert/strict'
import { decryptSecret, encryptSecret } from './mail-credential-store.js'
import { MailConnectionError, normalizeAuthorizationCode, normalizeEmail } from './mail-client.js'
import { classifyRecruitmentEnvelope } from './mail-candidate.js'
import { validateMailRecruitmentExtraction, type MailRecruitmentExtraction } from './mail-extraction-contracts.js'
import { extractBodyUrls, htmlToVisibleText } from './mail-content.js'
import { ScheduleValidationError, validateRecruitmentScheduleInput } from './recruitment-schedule.js'
import { canAutomaticallyConfirm } from './mail-automation-policy.js'
import { validateMailScheduleReview, type MailScheduleReview } from './mail-schedule-review.js'

test('邮箱授权码使用随机 IV 加密，密文不包含明文', () => {
  const key = Buffer.alloc(32, 7)
  const aad = Buffer.from('job-tracer:test-account')
  const first = encryptSecret('qq-authorization-code', key, aad)
  const second = encryptSecret('qq-authorization-code', key, aad)

  assert.equal(decryptSecret(first, key, aad), 'qq-authorization-code')
  assert.equal(decryptSecret(second, key, aad), 'qq-authorization-code')
  assert.notEqual(first.iv, second.iv)
  assert.notEqual(first.ciphertext, second.ciphertext)
  assert.equal(JSON.stringify(first).includes('qq-authorization-code'), false)
})

test('邮箱授权码密文绑定账号，不能换账号解密', () => {
  const key = Buffer.alloc(32, 9)
  const payload = encryptSecret('qq-authorization-code', key, Buffer.from('account:a'))
  assert.throws(() => decryptSecret(payload, key, Buffer.from('account:b')))
  assert.throws(() => decryptSecret(payload, Buffer.alloc(32, 8), Buffer.from('account:a')))
})

test('邮箱输入会规范化，并拒绝空白授权码和非法地址', () => {
  assert.equal(normalizeEmail('  Example@QQ.COM '), 'example@qq.com')
  assert.equal(normalizeAuthorizationCode('  abcdefgh12345678  '), 'abcdefgh12345678')
  assert.throws(() => normalizeEmail('not-an-email'), (error: unknown) =>
    error instanceof MailConnectionError && error.code === 'INVALID_EMAIL')
  assert.throws(() => normalizeAuthorizationCode('code with spaces'), (error: unknown) =>
    error instanceof MailConnectionError && error.code === 'INVALID_AUTHORIZATION_CODE')
})

test('招聘邮件候选规则优先识别面试、笔试和测评，并压低职位推广', () => {
  assert.equal(classifyRecruitmentEnvelope('XX 公司一面邀请', '招聘系统').isCandidate, true)
  assert.equal(classifyRecruitmentEnvelope('在线笔试通知', '校园招聘').isCandidate, true)
  assert.equal(classifyRecruitmentEnvelope('人才测评请于今晚完成', 'HR').isCandidate, true)
  assert.equal(classifyRecruitmentEnvelope('每日职位推荐 newsletter', '招聘平台').isCandidate, false)
  assert.equal(classifyRecruitmentEnvelope('普通账单提醒', 'service@example.com').isCandidate, false)
})

const sourceText = `邮件主题：XX公司一面邀请
发件人：XX公司招聘
邮件发送时间：2026-09-02T02:00:00.000Z
纯文本正文：
XX公司 Java开发 一面，请于2026年9月5日14:00参加腾讯会议。
会议链接：https://example.com/meet
请提前测试摄像头
联系人：张三 13800000000`

function validMailExtraction(): MailRecruitmentExtraction {
  return {
    schema_version: '1', relevant: true, event_type: 'interview', company: 'XX公司',
    position: 'Java开发', round: '一面', title: 'XX公司 Java开发一面', time_mode: 'fixed',
    scheduled_at: '2026-09-05 14:00', window_start_at: null, window_end_at: null,
    deadline_at: null, duration_minutes: null, timezone: 'Asia/Shanghai', location: '腾讯会议',
    meeting_link: 'https://example.com/meet', action_link: '', contact: '张三 13800000000',
    instructions: ['请提前测试摄像头'], confidence: 'high', warnings: [],
    evidence: [
      { field: 'event_type', quote: '一面' },
      { field: 'company', quote: 'XX公司' },
      { field: 'position', quote: 'Java开发' },
      { field: 'round', quote: '一面' },
      { field: 'scheduled_at', quote: '2026年9月5日14:00' },
      { field: 'location', quote: '腾讯会议' },
      { field: 'meeting_link', quote: 'https://example.com/meet' },
      { field: 'contact', quote: '张三 13800000000' },
      { field: 'instructions', quote: '请提前测试摄像头' }
    ]
  }
}

test('招聘邮件保留可靠字段，并逐字段清理无证据内容', () => {
  const value = validMailExtraction()
  assert.equal(
    validateMailRecruitmentExtraction(value, sourceText, ['https://example.com/meet']).scheduled_at,
    '2026-09-05 14:00'
  )

  const inventedCompany = structuredClone(value)
  inventedCompany.company = '不存在的公司'
  const cleanedCompany = validateMailRecruitmentExtraction(inventedCompany, sourceText, ['https://example.com/meet'])
  assert.equal(cleanedCompany.company, '')
  assert.match(cleanedCompany.warnings.join('；'), /公司缺少可核对的原文依据/)

  const inventedLink = structuredClone(value)
  inventedLink.meeting_link = 'https://evil.example/meet'
  const cleanedLink = validateMailRecruitmentExtraction(inventedLink, sourceText, ['https://example.com/meet'])
  assert.equal(cleanedLink.meeting_link, '')
  assert.match(cleanedLink.warnings.join('；'), /不在邮件原始链接/)

  const invalidWindow = structuredClone(value)
  invalidWindow.time_mode = 'window'
  invalidWindow.window_start_at = '2026-09-05 16:00'
  invalidWindow.window_end_at = '2026-09-05 14:00'
  invalidWindow.scheduled_at = null
  invalidWindow.evidence.push(
    { field: 'window_start_at', quote: '2026年9月5日14:00' },
    { field: 'window_end_at', quote: '2026年9月5日14:00' }
  )
  const cleanedWindow = validateMailRecruitmentExtraction(invalidWindow, sourceText, ['https://example.com/meet'])
  assert.equal(cleanedWindow.time_mode, 'unknown')
  assert.equal(cleanedWindow.window_start_at, null)
  assert.equal(cleanedWindow.window_end_at, null)
  assert.match(cleanedWindow.warnings.join('；'), /时间窗口不完整或顺序有误/)
})

test('非招聘候选中的杂质会被规范为空结果，而不是触发格式错误', () => {
  const value = validMailExtraction()
  value.relevant = false
  value.meeting_link = 'https://invented.example/test'
  value.evidence = [{ field: 'company', quote: '不在原文中的引用' }]
  const normalized = validateMailRecruitmentExtraction(value, sourceText, ['https://example.com/meet'])
  assert.equal(normalized.relevant, false)
  assert.equal(normalized.event_type, 'other')
  assert.equal(normalized.time_mode, 'unknown')
  assert.equal(normalized.company, '')
  assert.equal(normalized.scheduled_at, null)
  assert.equal(normalized.meeting_link, '')
  assert.deepEqual(normalized.evidence, [])
})

test('相关招聘动作没有明确时间时可正常返回时间未知', () => {
  const value = validMailExtraction()
  value.time_mode = 'unknown'
  value.scheduled_at = null
  value.evidence = value.evidence.filter(item => item.field !== 'scheduled_at')
  const result = validateMailRecruitmentExtraction(value, sourceText, ['https://example.com/meet'])
  assert.equal(result.relevant, true)
  assert.equal(result.time_mode, 'unknown')
  assert.equal(result.scheduled_at, null)
})

test('自动确认只接受高置信度且具有关键时间证据的测评、笔试和面试', () => {
  const valid = validMailExtraction()
  const review: MailScheduleReview = {
    schema_version: '1', decision: 'auto_confirm', reason: '主题和正文都明确邀请参加固定时间的一面',
    evidence: [{ field: 'subject', quote: 'XX公司一面邀请' }, { field: 'time', quote: '2026年9月5日14:00' }]
  }
  assert.equal(canAutomaticallyConfirm(valid, review), true)

  const medium = structuredClone(valid)
  medium.confidence = 'medium'
  assert.equal(canAutomaticallyConfirm(medium, review), false)

  const missingTimeEvidence = structuredClone(valid)
  missingTimeEvidence.evidence = missingTimeEvidence.evidence.filter(item => item.field !== 'scheduled_at')
  assert.equal(canAutomaticallyConfirm(missingTimeEvidence, review), false)

  const offer = structuredClone(valid)
  offer.event_type = 'offer'
  assert.equal(canAutomaticallyConfirm(offer, review), false)

  assert.equal(canAutomaticallyConfirm(valid, null), false)
  assert.equal(canAutomaticallyConfirm(valid, { ...review, decision: 'manual_review' }), false)
})

test('日程复核必须引用邮件原文，避免模型凭候选结果自动放行', () => {
  const review = validateMailScheduleReview({
    schema_version: '1', decision: 'auto_confirm', reason: '正文明确要求参加固定时间的一面',
    evidence: [
      { field: 'subject', quote: 'XX公司一面邀请' },
      { field: 'time', quote: '2026年9月5日14:00' }
    ]
  }, sourceText)
  assert.equal(review.decision, 'auto_confirm')
  assert.throws(() => validateMailScheduleReview({
    schema_version: '1', decision: 'auto_confirm', reason: '模型候选写得很完整',
    evidence: [{ field: 'time', quote: '2026年12月31日23:59' }]
  }, sourceText), /不在邮件原文中/)
})

test('邮件 HTML 只提取可见文字与 http(s) 链接，不执行或保留脚本', () => {
  const html = `<html><head><title>隐藏</title></head><body>
    <script>stealSecret()</script><style>.x{display:none}</style>
    <p>请参加面试&nbsp;并核对时间</p>
    <a href="https://example.com/test?a=1&amp;b=2">开始测评</a>
    <a href="javascript:alert(1)">危险链接</a></body></html>`
  const text = htmlToVisibleText(html)
  assert.match(text, /请参加面试 并核对时间/)
  assert.doesNotMatch(text, /stealSecret|display:none|隐藏/)
  assert.deepEqual(extractBodyUrls('', html), ['https://example.com/test?a=1&b=2'])
})

const scheduleBase = {
  applicationId: 1,
  eventType: 'interview',
  title: 'XX 公司一面',
  company: 'XX 公司',
  position: 'Java 开发',
  timeMode: 'fixed',
  scheduledAt: '2026-09-05 14:00',
  windowStartAt: null,
  windowEndAt: null,
  deadlineAt: null,
  durationMinutes: null,
  location: '腾讯会议',
  meetingLink: 'https://example.com/meeting',
  actionLink: '',
  contact: '',
  instructions: ['提前测试摄像头']
}

test('人工确认日程分别校验固定时间、窗口和未知时间', () => {
  const fixed = validateRecruitmentScheduleInput(scheduleBase)
  assert.equal(fixed.timeMode, 'fixed')
  assert.equal(fixed.scheduledAt, '2026-09-05 14:00')
  const fixedWithStaleDuration = validateRecruitmentScheduleInput({ ...scheduleBase, durationMinutes: 90 })
  assert.equal(fixedWithStaleDuration.durationMinutes, null)

  const invalidWindow = {
    ...scheduleBase, timeMode: 'window', scheduledAt: null,
    windowStartAt: '2026-09-05 18:00', windowEndAt: '2026-09-05 14:00'
  }
  assert.throws(() => validateRecruitmentScheduleInput(invalidWindow), (error: unknown) =>
    error instanceof ScheduleValidationError && /结束时间必须晚于/.test(error.message))

  const unknown = validateRecruitmentScheduleInput({ ...scheduleBase, timeMode: 'unknown' })
  assert.equal(unknown.scheduledAt, null)
  assert.equal(unknown.deadlineAt, null)
})

test('人工确认日程拒绝非 http(s) 链接，并保留开始后限时与截止时间', () => {
  assert.throws(() => validateRecruitmentScheduleInput({ ...scheduleBase, meetingLink: 'javascript:alert(1)' }), /http\(s\)/)
  const timed = validateRecruitmentScheduleInput({
    ...scheduleBase,
    timeMode: 'duration_after_open',
    scheduledAt: null,
    durationMinutes: 90,
    deadlineAt: '2026-09-06 23:59'
  })
  assert.equal(timed.durationMinutes, 90)
  assert.equal(timed.deadlineAt, '2026-09-06 23:59')
})
