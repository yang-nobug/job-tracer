import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now } from '../db.js'
import {
  deleteQqAuthorizationCode, hasQqAuthorizationCode, loadQqAuthorizationCode, storeQqAuthorizationCode
} from '../mail-credential-store.js'
import {
  fetchQqMessageBody, inspectQqMailbox, MailConnectionError, normalizeAuthorizationCode, normalizeEmail,
  scanQqMailboxEnvelopes,
  QQ_IMAP_HOST, QQ_IMAP_MAILBOX, QQ_IMAP_PORT
} from '../mail-client.js'
import { classifyRecruitmentEnvelope } from '../mail-candidate.js'
import { analyzeRecruitmentMail, mailAnalysisError } from '../mail-recruitment-analysis.js'
import type { MailRecruitmentExtraction } from '../mail-extraction-contracts.js'
import type { MailScheduleReview } from '../mail-schedule-review.js'
import { canAutomaticallyConfirm } from '../mail-automation-policy.js'
import {
  ScheduleValidationError, validateRecruitmentScheduleInput,
  type RecruitmentScheduleInput
} from '../recruitment-schedule.js'

interface MailAccountRow {
  id: number
  provider: string
  email: string
  host: string
  port: number
  secure: number
  mailbox: string
  credential_ref: string
  status: 'connected' | 'error'
  last_tested_at: string | null
  last_error_code: string | null
  created_at: string
  updated_at: string
}

interface MailSyncStateRow {
  uid_validity: string
  last_uid: number
}

interface MailCandidateRow {
  id: number
  account_id: number
  mailbox: string
  uid_validity: string
  uid: number
  subject: string
  sender: string
  sent_at: string | null
  is_read: number
  score: number
  matched_terms_json: string
  status: 'candidate' | 'ignored'
  created_at: string
  analysis_status: 'running' | 'succeeded' | 'failed' | null
  extraction_json: string | null
  body_truncated: number | null
  analysis_model: string | null
  prompt_version: string | null
  analysis_error_code: string | null
  schedule_review_json: string | null
  review_model: string | null
  review_prompt_version: string | null
  review_error_code: string | null
  analyzed_at: string | null
  schedule_id: number | null
  schedule_status: 'active' | 'completed' | 'cancelled' | null
}

interface ApplicationMatchSource {
  id: number
  company: string
  position: string
  status: string
}

interface RecruitmentScheduleRow {
  id: number
  application_id: number | null
  source_mail_candidate_id: number | null
  event_type: string
  title: string
  company: string
  position: string
  time_mode: string
  scheduled_at: string | null
  window_start_at: string | null
  window_end_at: string | null
  deadline_at: string | null
  duration_minutes: number | null
  timezone: string
  location: string
  meeting_link: string
  action_link: string
  contact: string
  instructions_json: string
  status: 'active' | 'completed' | 'cancelled'
  created_at: string
  updated_at: string
  application_company?: string | null
  application_position?: string | null
}

const analyzingCandidates = new Set<number>()
const scanningAccounts = new Set<number>()

/** 仅在服务成功监听端口后调用，避免第二个启动失败的进程干扰正在运行的识别。 */
export function recoverInterruptedMailAnalyses(): number {
  const recovered = db.prepare(`UPDATE mail_candidate_analyses
    SET status = 'failed', error_code = 'INTERRUPTED', analyzed_at = ?, updated_at = ?
    WHERE status = 'running'`).run(now(), now()).changes
  if (recovered) console.info(`[mail] 已恢复 ${recovered} 个中断的邮件识别任务，可在页面重试`)
  return recovered
}

const selectQqAccount = db.prepare(`SELECT id, provider, email, host, port, secure, mailbox,
  credential_ref, status, last_tested_at, last_error_code, created_at, updated_at
  FROM mail_accounts WHERE provider = 'qq' LIMIT 1`)

function getQqAccount(): MailAccountRow | undefined {
  return selectQqAccount.get() as MailAccountRow | undefined
}

function publicAccount(row: MailAccountRow) {
  return {
    id: row.id,
    provider: 'QQ邮箱',
    email: row.email,
    host: row.host,
    port: row.port,
    secure: Boolean(row.secure),
    mailbox: row.mailbox,
    status: row.status,
    lastTestedAt: row.last_tested_at,
    lastErrorCode: row.last_error_code,
    credentialAvailable: hasQqAuthorizationCode(row.credential_ref)
  }
}

function sendMailError(res: Response, error: unknown): void {
  if (error instanceof MailConnectionError) {
    res.status(422).json({ message: error.message, code: error.code })
    return
  }
  const message = error instanceof Error && /凭据|授权码/.test(error.message)
    ? error.message
    : '邮箱操作失败，请稍后重试'
  res.status(500).json({ message, code: 'MAIL_INTERNAL_ERROR' })
}

function parseSavedExtraction(value: string | null): MailRecruitmentExtraction | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as MailRecruitmentExtraction
      : null
  } catch {
    return null
  }
}

function parseSavedScheduleReview(value: string | null): MailScheduleReview | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    if (parsed.schema_version !== '1' || !['auto_confirm', 'manual_review', 'reject'].includes(String(parsed.decision))) return null
    if (typeof parsed.reason !== 'string' || !Array.isArray(parsed.evidence)) return null
    return parsed as unknown as MailScheduleReview
  } catch {
    return null
  }
}

const comparable = (value: string) => value.normalize('NFKC').toLowerCase()
  .replace(/有限责任公司|股份有限公司|有限公司|集团/g, '')
  .replace(/[^\p{L}\p{N}]/gu, '')

function applicationMatches(extraction: MailRecruitmentExtraction | null, applications: ApplicationMatchSource[]) {
  if (!extraction?.relevant) return []
  const company = comparable(extraction.company)
  const position = comparable(extraction.position)
  if (!company && !position) return []
  return applications.map(application => {
    const appCompany = comparable(application.company)
    const appPosition = comparable(application.position)
    let score = 0
    const reasons: string[] = []
    if (company && appCompany) {
      if (company === appCompany) { score += 8; reasons.push('公司一致') }
      else if (company.length >= 2 && appCompany.length >= 2 && (company.includes(appCompany) || appCompany.includes(company))) {
        score += 5; reasons.push('公司名称相近')
      }
    }
    if (position && appPosition) {
      if (position === appPosition) { score += 5; reasons.push('岗位一致') }
      else if (position.length >= 2 && appPosition.length >= 2 && (position.includes(appPosition) || appPosition.includes(position))) {
        score += 3; reasons.push('岗位名称相近')
      }
    }
    return { id: application.id, company: application.company, position: application.position, status: application.status, score, reasons }
  }).filter(item => item.score >= 5).sort((a, b) => b.score - a.score || b.id - a.id).slice(0, 5)
}

function publicCandidate(row: MailCandidateRow, applications: ApplicationMatchSource[] = []) {
  let matchedTerms: string[] = []
  try {
    const parsed = JSON.parse(row.matched_terms_json)
    if (Array.isArray(parsed)) matchedTerms = parsed.filter(value => typeof value === 'string').slice(0, 20)
  } catch { /* 旧数据损坏时按空标签展示 */ }
  const extraction = parseSavedExtraction(row.extraction_json)
  const scheduleReview = parseSavedScheduleReview(row.schedule_review_json)
  const analysisStatus = row.analysis_status === 'succeeded' && !extraction ? 'failed' : row.analysis_status
  return {
    id: row.id,
    subject: row.subject,
    sender: row.sender,
    sentAt: row.sent_at,
    isRead: Boolean(row.is_read),
    score: row.score,
    matchedTerms,
    status: row.status,
    firstSeenAt: row.created_at,
    analysisStatus,
    analysis: extraction,
    analysisModel: row.analysis_model,
    analysisPromptVersion: row.prompt_version,
    analysisErrorCode: analysisStatus === 'failed' && !row.analysis_error_code ? 'INVALID_SAVED_RESULT' : row.analysis_error_code,
    scheduleReview,
    scheduleReviewModel: row.review_model,
    scheduleReviewPromptVersion: row.review_prompt_version,
    scheduleReviewErrorCode: row.review_error_code,
    analyzedAt: row.analyzed_at,
    bodyTruncated: Boolean(row.body_truncated),
    applicationMatches: applicationMatches(extraction, applications),
    scheduleId: row.schedule_id,
    scheduleStatus: row.schedule_status
  }
}

const CANDIDATE_SELECT = `SELECT c.id, c.account_id, c.mailbox, c.uid_validity, c.uid,
  c.subject, c.sender, c.sent_at, c.is_read, c.score, c.matched_terms_json,
  c.status, c.created_at, a.status AS analysis_status, a.extraction_json,
  a.body_truncated, a.model AS analysis_model, a.prompt_version,
  a.error_code AS analysis_error_code, a.schedule_review_json,
  a.review_model, a.review_prompt_version, a.review_error_code, a.analyzed_at,
  s.id AS schedule_id, s.status AS schedule_status
  FROM mail_candidates c
  LEFT JOIN mail_candidate_analyses a ON a.candidate_id = c.id`
  + ` LEFT JOIN recruitment_schedule_items s ON s.source_mail_candidate_id = c.id`

const SCHEDULE_SELECT = `SELECT s.*, a.company AS application_company, a.position AS application_position
  FROM recruitment_schedule_items s
  LEFT JOIN applications a ON a.id = s.application_id`

function publicSchedule(row: RecruitmentScheduleRow) {
  let instructions: string[] = []
  try {
    const parsed = JSON.parse(row.instructions_json)
    if (Array.isArray(parsed)) instructions = parsed.filter(item => typeof item === 'string').slice(0, 20)
  } catch { /* 损坏的旧值按空数组展示 */ }
  const primaryAt = row.scheduled_at ?? row.window_end_at ?? row.deadline_at
  return {
    id: row.id,
    applicationId: row.application_id,
    sourceCandidateId: row.source_mail_candidate_id,
    eventType: row.event_type,
    title: row.title,
    company: row.company || row.application_company || '',
    position: row.position || row.application_position || '',
    timeMode: row.time_mode,
    scheduledAt: row.scheduled_at,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    deadlineAt: row.deadline_at,
    durationMinutes: row.duration_minutes,
    timezone: row.timezone,
    location: row.location,
    meetingLink: row.meeting_link,
    actionLink: row.action_link,
    contact: row.contact,
    instructions,
    status: row.status,
    primaryAt,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function upsertRecruitmentSchedule(candidateId: number, input: RecruitmentScheduleInput) {
  let company = input.company
  let position = input.position
  if (input.applicationId !== null) {
    const application = db.prepare('SELECT company, position FROM applications WHERE id = ?')
      .get(input.applicationId) as { company: string; position: string } | undefined
    if (!application) throw new ScheduleValidationError('关联的投递记录不存在')
    company ||= application.company
    position ||= application.position
  }
  const timestamp = now()
  const existing = db.prepare('SELECT id FROM recruitment_schedule_items WHERE source_mail_candidate_id = ?')
    .get(candidateId) as { id: number } | undefined
  let scheduleId: number
  if (existing) {
    db.prepare(`UPDATE recruitment_schedule_items SET application_id = ?, event_type = ?, title = ?,
      company = ?, position = ?, time_mode = ?, scheduled_at = ?, window_start_at = ?,
      window_end_at = ?, deadline_at = ?, duration_minutes = ?, timezone = ?, location = ?,
      meeting_link = ?, action_link = ?, contact = ?, instructions_json = ?, status = 'active',
      updated_at = ? WHERE id = ?`).run(
      input.applicationId, input.eventType, input.title, company, position, input.timeMode,
      input.scheduledAt, input.windowStartAt, input.windowEndAt, input.deadlineAt,
      input.durationMinutes, input.timezone, input.location, input.meetingLink, input.actionLink,
      input.contact, JSON.stringify(input.instructions), timestamp, existing.id
    )
    scheduleId = existing.id
  } else {
    const inserted = db.prepare(`INSERT INTO recruitment_schedule_items (
      application_id, source_mail_candidate_id, event_type, title, company, position,
      time_mode, scheduled_at, window_start_at, window_end_at, deadline_at, duration_minutes,
      timezone, location, meeting_link, action_link, contact, instructions_json, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
      input.applicationId, candidateId, input.eventType, input.title, company, position,
      input.timeMode, input.scheduledAt, input.windowStartAt, input.windowEndAt, input.deadlineAt,
      input.durationMinutes, input.timezone, input.location, input.meetingLink, input.actionLink,
      input.contact, JSON.stringify(input.instructions), timestamp, timestamp
    )
    scheduleId = Number(inserted.lastInsertRowid)
  }
  const row = db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(scheduleId) as RecruitmentScheduleRow
  return { schedule: publicSchedule(row), created: !existing }
}

function extractionScheduleInput(extraction: MailRecruitmentExtraction, applicationId: number | null): RecruitmentScheduleInput {
  return validateRecruitmentScheduleInput({
    applicationId,
    eventType: extraction.event_type,
    title: extraction.title,
    company: extraction.company,
    position: extraction.position,
    timeMode: extraction.time_mode,
    scheduledAt: extraction.scheduled_at,
    windowStartAt: extraction.window_start_at,
    windowEndAt: extraction.window_end_at,
    deadlineAt: extraction.deadline_at,
    durationMinutes: extraction.duration_minutes,
    location: extraction.location,
    meetingLink: extraction.meeting_link,
    actionLink: extraction.action_link,
    contact: extraction.contact,
    instructions: extraction.instructions
  })
}

function matchableApplications(): ApplicationMatchSource[] {
  return db.prepare(`SELECT id, company, position, status FROM applications
    ORDER BY updated_at DESC, id DESC`).all() as ApplicationMatchSource[]
}

function listCandidates(accountId: number, limit = 100) {
  const rows = db.prepare(`${CANDIDATE_SELECT}
    WHERE c.account_id = ? AND c.status = 'candidate'
    ORDER BY COALESCE(c.sent_at, c.created_at) DESC, c.id DESC LIMIT ?`).all(accountId, limit) as MailCandidateRow[]
  const applications = matchableApplications()
  return rows.map(row => publicCandidate(row, applications))
}

export const mailRouter = Router()

mailRouter.get('/mail/account', (_req: Request, res: Response) => {
  const account = getQqAccount()
  res.json({ configured: Boolean(account), account: account ? publicAccount(account) : null })
})

mailRouter.post('/mail/account/test', async (req: Request, res: Response) => {
  const saved = getQqAccount()
  const suppliedCode = typeof req.body?.authorizationCode === 'string' && req.body.authorizationCode.trim().length > 0
  try {
    const email = suppliedCode
      ? normalizeEmail(req.body?.email)
      : saved
        ? saved.email
        : normalizeEmail(req.body?.email)
    if (!suppliedCode && !saved) {
      throw new MailConnectionError('请填写 QQ 邮箱地址和授权码', 'CREDENTIAL_REQUIRED')
    }
    if (!suppliedCode && req.body?.email && normalizeEmail(req.body.email) !== saved?.email.toLowerCase()) {
      throw new MailConnectionError('邮箱地址发生变化时，需要重新填写授权码', 'CREDENTIAL_REQUIRED')
    }

    let authorizationCode: string
    if (suppliedCode) {
      authorizationCode = normalizeAuthorizationCode(req.body.authorizationCode)
    } else {
      try {
        authorizationCode = loadQqAuthorizationCode(saved!.credential_ref, saved!.email)
      } catch (error) {
        throw new MailConnectionError((error as Error).message, 'CREDENTIAL_UNAVAILABLE')
      }
    }
    const inspection = await inspectQqMailbox(email, authorizationCode)
    const testedAt = now()

    let credentialRef = saved?.credential_ref
    if (suppliedCode) credentialRef = storeQqAuthorizationCode(email, authorizationCode)
    if (!credentialRef) throw new Error('邮箱授权码保存失败')

    // 更换邮箱时删除旧账号行，让同步游标、候选邮件和扫描历史通过外键级联清理。
    if (saved && saved.email.toLowerCase() !== email) {
      db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(saved.id)
    }

    db.prepare(`INSERT INTO mail_accounts (
      provider, email, host, port, secure, mailbox, credential_ref, status,
      last_tested_at, last_error_code, created_at, updated_at
    ) VALUES ('qq', ?, ?, ?, 1, ?, ?, 'connected', ?, NULL, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      email = excluded.email,
      host = excluded.host,
      port = excluded.port,
      secure = excluded.secure,
      mailbox = excluded.mailbox,
      credential_ref = excluded.credential_ref,
      status = 'connected',
      last_tested_at = excluded.last_tested_at,
      last_error_code = NULL,
      updated_at = excluded.updated_at`).run(
      email, QQ_IMAP_HOST, QQ_IMAP_PORT, QQ_IMAP_MAILBOX, credentialRef, testedAt, testedAt, testedAt
    )

    const account = getQqAccount()!
    res.json({
      configured: true,
      account: publicAccount(account),
      readOnly: inspection.readOnly,
      messageCount: inspection.messageCount,
      recent: inspection.recent
    })
  } catch (error) {
    if (!suppliedCode && saved && error instanceof MailConnectionError) {
      db.prepare(`UPDATE mail_accounts SET status = 'error', last_tested_at = ?,
        last_error_code = ?, updated_at = ? WHERE id = ?`).run(now(), error.code, now(), saved.id)
    }
    sendMailError(res, error)
  }
})

mailRouter.get('/mail/candidates', (req: Request, res: Response) => {
  const account = getQqAccount()
  if (!account) {
    res.json([])
    return
  }
  const requested = Number(req.query.limit)
  const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 100
  res.json(listCandidates(account.id, limit))
})

mailRouter.get('/schedule', (req: Request, res: Response) => {
  const requested = Number(req.query.limit)
  const limit = Number.isFinite(requested) ? Math.min(500, Math.max(1, Math.floor(requested))) : 100
  const status = typeof req.query.status === 'string' ? req.query.status : 'active'
  if (!['active', 'completed', 'cancelled', 'all'].includes(status)) {
    res.status(422).json({ message: '日程状态无效' })
    return
  }
  const rows = status === 'all'
    ? db.prepare(`${SCHEDULE_SELECT} ORDER BY COALESCE(s.scheduled_at, s.window_end_at, s.deadline_at, s.created_at) ASC LIMIT ?`)
      .all(limit) as RecruitmentScheduleRow[]
    : db.prepare(`${SCHEDULE_SELECT} WHERE s.status = ?
        ORDER BY COALESCE(s.scheduled_at, s.window_end_at, s.deadline_at, s.created_at) ASC LIMIT ?`)
      .all(status, limit) as RecruitmentScheduleRow[]
  res.json(rows.map(publicSchedule))
})

mailRouter.patch('/schedule/:id/status', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const status = req.body?.status
  if (!Number.isInteger(id) || id <= 0 || !['active', 'completed', 'cancelled'].includes(status)) {
    res.status(422).json({ message: '日程编号或状态无效' })
    return
  }
  const result = db.prepare('UPDATE recruitment_schedule_items SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), id)
  if (!result.changes) {
    res.status(404).json({ message: '日程不存在' })
    return
  }
  const row = db.prepare(`${SCHEDULE_SELECT} WHERE s.id = ?`).get(id) as RecruitmentScheduleRow
  res.json(publicSchedule(row))
})

mailRouter.post('/mail/scan', async (_req: Request, res: Response) => {
  const account = getQqAccount()
  if (!account) {
    res.status(422).json({ message: '请先连接 QQ 邮箱', code: 'MAIL_NOT_CONFIGURED' })
    return
  }
  if (scanningAccounts.has(account.id)) {
    res.status(409).json({ message: '邮箱正在扫描，请稍候', code: 'MAIL_SCAN_RUNNING' })
    return
  }
  scanningAccounts.add(account.id)
  const startedAt = now()
  const runResult = db.prepare(`INSERT INTO mail_scan_runs (account_id, status, started_at)
    VALUES (?, 'running', ?)`).run(account.id, startedAt)
  const runId = Number(runResult.lastInsertRowid)

  try {
    let authorizationCode: string
    try {
      authorizationCode = loadQqAuthorizationCode(account.credential_ref, account.email)
    } catch (error) {
      throw new MailConnectionError((error as Error).message, 'CREDENTIAL_UNAVAILABLE')
    }
    const state = db.prepare(`SELECT uid_validity, last_uid FROM mail_sync_state
      WHERE account_id = ? AND mailbox = ?`).get(account.id, account.mailbox) as MailSyncStateRow | undefined
    const batch = await scanQqMailboxEnvelopes(
      account.email,
      authorizationCode,
      state ? { uidValidity: state.uid_validity, lastUid: state.last_uid } : null
    )

    let candidateCount = 0
    let newCandidateCount = 0
    const finishedAt = now()
    db.transaction(() => {
      if (state && state.uid_validity !== batch.uidValidity) {
        db.prepare('DELETE FROM mail_candidates WHERE account_id = ? AND mailbox = ?')
          .run(account.id, account.mailbox)
      }
      const insertCandidate = db.prepare(`INSERT OR IGNORE INTO mail_candidates (
        account_id, mailbox, uid_validity, uid, subject, sender, sent_at, is_read,
        score, matched_terms_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`)
      const refreshCandidate = db.prepare(`UPDATE mail_candidates SET subject = ?, sender = ?, sent_at = ?,
        is_read = ?, score = ?, matched_terms_json = ?, updated_at = ?
        WHERE account_id = ? AND mailbox = ? AND uid_validity = ? AND uid = ?`)

      for (const message of batch.scanned) {
        const classification = classifyRecruitmentEnvelope(message.subject, message.from)
        if (!classification.isCandidate) continue
        candidateCount++
        const termsJson = JSON.stringify(classification.matchedTerms)
        const inserted = insertCandidate.run(
          account.id, account.mailbox, batch.uidValidity, message.uid, message.subject, message.from,
          message.sentAt, message.isRead ? 1 : 0, classification.score, termsJson, finishedAt, finishedAt
        )
        if (inserted.changes) {
          newCandidateCount++
        } else {
          refreshCandidate.run(
            message.subject, message.from, message.sentAt, message.isRead ? 1 : 0,
            classification.score, termsJson, finishedAt,
            account.id, account.mailbox, batch.uidValidity, message.uid
          )
        }
      }

      db.prepare(`INSERT INTO mail_sync_state (
        account_id, mailbox, uid_validity, last_uid, last_scanned_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, mailbox) DO UPDATE SET
        uid_validity = excluded.uid_validity,
        last_uid = excluded.last_uid,
        last_scanned_at = excluded.last_scanned_at`).run(
        account.id, account.mailbox, batch.uidValidity, batch.lastUid, finishedAt
      )
      db.prepare(`UPDATE mail_scan_runs SET status = 'succeeded', scanned_count = ?,
        candidate_count = ?, new_candidate_count = ?, finished_at = ? WHERE id = ?`).run(
        batch.scanned.length, candidateCount, newCandidateCount, finishedAt, runId
      )
      db.prepare(`UPDATE mail_accounts SET status = 'connected', last_tested_at = ?,
        last_error_code = NULL, updated_at = ? WHERE id = ?`).run(finishedAt, finishedAt, account.id)
    })()

    res.json({
      scannedCount: batch.scanned.length,
      candidateCount,
      newCandidateCount,
      hasMore: batch.hasMore,
      candidates: listCandidates(account.id)
    })
  } catch (error) {
    const code = error instanceof MailConnectionError ? error.code : 'MAIL_SCAN_ERROR'
    db.prepare(`UPDATE mail_scan_runs SET status = 'failed', error_code = ?, finished_at = ?
      WHERE id = ?`).run(code, now(), runId)
    if (error instanceof MailConnectionError) {
      db.prepare(`UPDATE mail_accounts SET status = 'error', last_error_code = ?, updated_at = ?
        WHERE id = ?`).run(error.code, now(), account.id)
    }
    sendMailError(res, error)
  } finally {
    scanningAccounts.delete(account.id)
  }
})

mailRouter.post('/mail/candidates/:id/analyze', async (req: Request, res: Response) => {
  const candidateId = Number(req.params.id)
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    res.status(422).json({ message: '候选邮件编号无效', code: 'INVALID_CANDIDATE_ID' })
    return
  }
  const account = getQqAccount()
  const candidate = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ? AND c.status = 'candidate'`)
    .get(candidateId) as MailCandidateRow | undefined
  if (!account || !candidate || candidate.account_id !== account.id) {
    res.status(404).json({ message: '候选邮件不存在', code: 'MAIL_CANDIDATE_NOT_FOUND' })
    return
  }
  if (analyzingCandidates.has(candidateId)) {
    res.status(409).json({ message: '这封邮件正在识别，请稍候', code: 'MAIL_ANALYSIS_RUNNING' })
    return
  }

  analyzingCandidates.add(candidateId)
  const updatedAt = now()
  db.prepare(`INSERT INTO mail_candidate_analyses (candidate_id, status, updated_at)
    VALUES (?, 'running', ?)
    ON CONFLICT(candidate_id) DO UPDATE SET status = 'running', extraction_json = NULL,
      body_hash = NULL, body_truncated = 0, model = NULL, prompt_version = NULL,
      error_code = NULL, schedule_review_json = NULL, review_model = NULL,
      review_prompt_version = NULL, review_error_code = NULL,
      analyzed_at = NULL, updated_at = excluded.updated_at`)
    .run(candidateId, updatedAt)

  try {
    let authorizationCode: string
    try {
      authorizationCode = loadQqAuthorizationCode(account.credential_ref, account.email)
    } catch (error) {
      throw new MailConnectionError((error as Error).message, 'CREDENTIAL_UNAVAILABLE')
    }
    const body = await fetchQqMessageBody(
      account.email, authorizationCode, candidate.uid_validity, candidate.uid
    )
    const analysis = await analyzeRecruitmentMail({
      subject: candidate.subject,
      sender: candidate.sender,
      sentAt: candidate.sent_at,
      body
    })
    const analyzedAt = now()
    db.prepare(`UPDATE mail_candidate_analyses SET status = 'succeeded', extraction_json = ?,
      body_hash = ?, body_truncated = ?, model = ?, prompt_version = ?, error_code = NULL,
      schedule_review_json = ?, review_model = ?, review_prompt_version = ?, review_error_code = ?,
      analyzed_at = ?, updated_at = ? WHERE candidate_id = ?`).run(
      JSON.stringify(analysis.extraction), analysis.bodyHash, analysis.truncated ? 1 : 0,
      analysis.model, analysis.promptVersion,
      analysis.scheduleReview ? JSON.stringify(analysis.scheduleReview) : null,
      analysis.reviewModel, analysis.reviewPromptVersion, analysis.reviewErrorCode,
      analyzedAt, analyzedAt, candidateId
    )
    if (!analysis.truncated && canAutomaticallyConfirm(analysis.extraction, analysis.scheduleReview)) {
      try {
        const existingSchedule = db.prepare('SELECT id FROM recruitment_schedule_items WHERE source_mail_candidate_id = ?')
          .get(candidateId) as { id: number } | undefined
        if (!existingSchedule) {
          const applications = matchableApplications()
          const matchedApplicationId = applicationMatches(analysis.extraction, applications)
            .find(match => match.score >= 8)?.id ?? null
          upsertRecruitmentSchedule(candidateId, extractionScheduleInput(analysis.extraction, matchedApplicationId))
        }
      } catch (error) {
        console.warn(`[mail-analysis] candidate_id=${candidateId} auto schedule failed`, error instanceof Error ? error.message : 'unknown')
        analysis.extraction.warnings = [...new Set([
          ...analysis.extraction.warnings,
          'AI 复核已通过，但自动写入日程失败，请在下方核对后重试'
        ])].slice(0, 10)
        db.prepare(`UPDATE mail_candidate_analyses SET extraction_json = ?, updated_at = ? WHERE candidate_id = ?`)
          .run(JSON.stringify(analysis.extraction), now(), candidateId)
      }
    }
    const saved = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ?`).get(candidateId) as MailCandidateRow
    res.json(publicCandidate(saved, matchableApplications()))
  } catch (error) {
    const failure = error instanceof MailConnectionError
      ? { status: 422, code: error.code, message: error.message }
      : mailAnalysisError(error)
    console.warn(`[mail-analysis] candidate_id=${candidateId} failed code=${failure.code}`)
    db.prepare(`UPDATE mail_candidate_analyses SET status = 'failed', extraction_json = NULL,
      body_hash = NULL, body_truncated = 0, model = NULL, prompt_version = NULL,
      error_code = ?, schedule_review_json = NULL, review_model = NULL,
      review_prompt_version = NULL, review_error_code = NULL,
      analyzed_at = ?, updated_at = ? WHERE candidate_id = ?`)
      .run(failure.code, now(), now(), candidateId)
    res.status(failure.status).json({ message: failure.message, code: failure.code })
  } finally {
    analyzingCandidates.delete(candidateId)
  }
})

mailRouter.post('/mail/candidates/:id/confirm-schedule', (req: Request, res: Response) => {
  const candidateId = Number(req.params.id)
  if (!Number.isInteger(candidateId) || candidateId <= 0) {
    res.status(422).json({ message: '候选邮件编号无效' })
    return
  }
  const candidate = db.prepare(`${CANDIDATE_SELECT} WHERE c.id = ? AND c.status = 'candidate'`)
    .get(candidateId) as MailCandidateRow | undefined
  const extraction = candidate ? parseSavedExtraction(candidate.extraction_json) : null
  if (!candidate || candidate.analysis_status !== 'succeeded' || !extraction?.relevant) {
    res.status(422).json({ message: '请先完成 AI 识别，并确认这是一项具体招聘流程通知' })
    return
  }
  const existing = db.prepare('SELECT id FROM recruitment_schedule_items WHERE source_mail_candidate_id = ?')
    .get(candidateId) as { id: number } | undefined
  const review = parseSavedScheduleReview(candidate.schedule_review_json)
  if (!existing && review?.decision !== 'auto_confirm') {
    res.status(422).json({ message: '只有 AI 日程复核通过的邮件才能加入日程；请重新识别或保留为候选邮件' })
    return
  }
  try {
    const input = validateRecruitmentScheduleInput(req.body)
    const result = upsertRecruitmentSchedule(candidateId, input)
    res.status(result.created ? 201 : 200).json(result.schedule)
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      res.status(422).json({ message: error.message })
      return
    }
    res.status(500).json({ message: '保存日程失败，请稍后重试' })
  }
})

mailRouter.patch('/mail/candidates/:id', (req: Request, res: Response) => {
  const status = req.body?.status
  if (status !== 'candidate' && status !== 'ignored') {
    res.status(422).json({ message: '候选邮件状态无效' })
    return
  }
  const result = db.prepare('UPDATE mail_candidates SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, now(), req.params.id)
  if (!result.changes) {
    res.status(404).json({ message: '候选邮件不存在' })
    return
  }
  res.json({ ok: true })
})

mailRouter.delete('/mail/account', (_req: Request, res: Response) => {
  const account = getQqAccount()
  if (account) {
    db.prepare('DELETE FROM mail_accounts WHERE id = ?').run(account.id)
    deleteQqAuthorizationCode(account.credential_ref)
  }
  db.prepare(`UPDATE mail_automation_settings SET enabled = 0, last_status = 'idle',
    last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = 1`).run(now())
  res.json({ ok: true })
})
