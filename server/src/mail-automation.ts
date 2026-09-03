import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now } from './db.js'
import type { MailRecruitmentExtraction } from './mail-extraction-contracts.js'
import type { MailScheduleReview } from './mail-schedule-review.js'
import { canAutomaticallyConfirm } from './mail-automation-policy.js'
import { hasQqAuthorizationCode } from './mail-credential-store.js'

interface AutomationSettingsRow {
  enabled: number
  run_time: string
  last_run_at: string | null
  last_status: 'idle' | 'running' | 'succeeded' | 'failed'
  last_error_code: string | null
  last_error_message: string | null
  last_scanned_count: number
  last_analyzed_count: number
  last_confirmed_count: number
  last_review_count: number
  updated_at: string
}

interface ApplicationMatch {
  id: number
  score: number
}

interface AutomationCandidate {
  id: number
  bodyTruncated: boolean
  analysisStatus: 'running' | 'succeeded' | 'failed' | null
  analysis: MailRecruitmentExtraction | null
  scheduleReview: MailScheduleReview | null
  scheduleReviewErrorCode: string | null
  scheduleId: number | null
  applicationMatches: ApplicationMatch[]
}

interface ScanResponse {
  scannedCount: number
  hasMore: boolean
  candidates: AutomationCandidate[]
}

export interface MailAutomationResult {
  scannedCount: number
  analyzedCount: number
  confirmedCount: number
  reviewCount: number
}

class AutomationRequestError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'AutomationRequestError'
  }
}

const MAX_SCANS_PER_RUN = 3
const MAX_ANALYSES_PER_RUN = 10
let serviceBaseUrl = 'http://127.0.0.1:3210'
let schedulerTimer: ReturnType<typeof setInterval> | null = null
let runningCycle: Promise<MailAutomationResult> | null = null

const selectSettings = db.prepare(`SELECT enabled, run_time, last_run_at, last_status,
  last_error_code, last_error_message, last_scanned_count, last_analyzed_count,
  last_confirmed_count, last_review_count, updated_at
  FROM mail_automation_settings WHERE id = 1`)

function settingsRow(): AutomationSettingsRow {
  return selectSettings.get() as AutomationSettingsRow
}

function localDateKey(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function localDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${localDateKey(value)} ${pad(value.getHours())}:${pad(value.getMinutes())}`
}

function nextRunAt(row: AutomationSettingsRow): string | null {
  if (!row.enabled) return null
  const [hour, minute] = row.run_time.split(':').map(Number)
  const candidate = new Date()
  candidate.setHours(hour, minute, 0, 0)
  const ranToday = row.last_run_at ? localDateKey(new Date(row.last_run_at)) === localDateKey(new Date()) : false
  if (candidate.getTime() <= Date.now() || ranToday) candidate.setDate(candidate.getDate() + 1)
  return localDateTime(candidate)
}

export function publicMailAutomationSettings() {
  const row = settingsRow()
  return {
    enabled: Boolean(row.enabled),
    runTime: row.run_time,
    nextRunAt: nextRunAt(row),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastErrorCode: row.last_error_code,
    lastErrorMessage: row.last_error_message,
    lastScannedCount: row.last_scanned_count,
    lastAnalyzedCount: row.last_analyzed_count,
    lastConfirmedCount: row.last_confirmed_count,
    lastReviewCount: row.last_review_count,
    running: Boolean(runningCycle)
  }
}

function schedulePayload(candidate: AutomationCandidate) {
  const extraction = candidate.analysis!
  const applicationId = candidate.applicationMatches.find(match => match.score >= 8)?.id ?? null
  return {
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
  }
}

async function localApi<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${serviceBaseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers }
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    throw new AutomationRequestError(
      typeof payload.message === 'string' ? payload.message : `本机接口返回 ${response.status}`,
      typeof payload.code === 'string' ? payload.code : `HTTP_${response.status}`
    )
  }
  return payload as T
}

async function executeCycle(): Promise<MailAutomationResult> {
  const startedAt = now()
  db.prepare(`UPDATE mail_automation_settings SET last_run_at = ?, last_status = 'running',
    last_error_code = NULL, last_error_message = NULL, updated_at = ? WHERE id = 1`)
    .run(startedAt, startedAt)
  try {
    let scan: ScanResponse | null = null
    let scannedCount = 0
    for (let attempt = 0; attempt < MAX_SCANS_PER_RUN; attempt++) {
      scan = await localApi<ScanResponse>('/api/mail/scan', { method: 'POST', body: '{}' })
      scannedCount += scan.scannedCount
      if (!scan.hasMore) break
    }
    const candidates = scan?.candidates ?? []
    let analyzedCount = 0
    let confirmedCount = 0
    let reviewCount = 0

    for (const original of candidates) {
      if (original.scheduleId) continue
      let candidate = original
      const needsScheduleReview = candidate.analysisStatus === 'succeeded'
        && !candidate.scheduleReview
        && !candidate.bodyTruncated
        && !candidate.scheduleReviewErrorCode
      if ((candidate.analysisStatus === null || needsScheduleReview) && analyzedCount < MAX_ANALYSES_PER_RUN) {
        analyzedCount++
        try {
          candidate = await localApi<AutomationCandidate>(`/api/mail/candidates/${candidate.id}/analyze`, {
            method: 'POST', body: '{}'
          })
        } catch {
          reviewCount++
          continue
        }
        if (candidate.scheduleId) {
          confirmedCount++
          continue
        }
      }
      if (candidate.analysisStatus !== 'succeeded' || candidate.bodyTruncated || !canAutomaticallyConfirm(candidate.analysis, candidate.scheduleReview)) {
        if (candidate.analysisStatus !== null) reviewCount++
        continue
      }
      try {
        await localApi(`/api/mail/candidates/${candidate.id}/confirm-schedule`, {
          method: 'POST', body: JSON.stringify(schedulePayload(candidate))
        })
        confirmedCount++
      } catch {
        reviewCount++
      }
    }

    const finishedAt = now()
    db.prepare(`UPDATE mail_automation_settings SET last_status = 'succeeded',
      last_scanned_count = ?, last_analyzed_count = ?, last_confirmed_count = ?,
      last_review_count = ?, last_error_code = NULL, last_error_message = NULL, updated_at = ?
      WHERE id = 1`).run(scannedCount, analyzedCount, confirmedCount, reviewCount, finishedAt)
    return { scannedCount, analyzedCount, confirmedCount, reviewCount }
  } catch (error) {
    const code = error instanceof AutomationRequestError ? error.code : 'MAIL_AUTOMATION_ERROR'
    const message = error instanceof AutomationRequestError ? error.message : '自动处理招聘邮件失败'
    db.prepare(`UPDATE mail_automation_settings SET last_status = 'failed',
      last_error_code = ?, last_error_message = ?, updated_at = ? WHERE id = 1`)
      .run(code, message.slice(0, 500), now())
    throw error
  }
}

export function runMailAutomationCycle(): Promise<MailAutomationResult> {
  if (runningCycle) return runningCycle
  runningCycle = executeCycle().finally(() => { runningCycle = null })
  return runningCycle
}

function shouldRunNow(row: AutomationSettingsRow): boolean {
  if (!row.enabled || row.last_status === 'running') return false
  const current = new Date()
  if (row.last_run_at && localDateKey(new Date(row.last_run_at)) === localDateKey(current)) return false
  const [hour, minute] = row.run_time.split(':').map(Number)
  return current.getHours() * 60 + current.getMinutes() >= hour * 60 + minute
}

async function schedulerTick(): Promise<void> {
  const row = settingsRow()
  if (!shouldRunNow(row)) return
  try {
    await runMailAutomationCycle()
  } catch (error) {
    console.warn('[mail-automation] 自动处理失败:', error instanceof Error ? error.message : '未知错误')
  }
}

export function configureMailAutomation(port: number): void {
  serviceBaseUrl = `http://127.0.0.1:${port}`
}

export function startMailAutomationScheduler(): void {
  if (schedulerTimer) return
  db.prepare(`UPDATE mail_automation_settings SET last_status = 'failed',
    last_error_code = 'INTERRUPTED', last_error_message = '上次自动处理因服务停止而中断',
    updated_at = ? WHERE last_status = 'running'`).run(now())
  setTimeout(() => { void schedulerTick() }, 1500).unref()
  schedulerTimer = setInterval(() => { void schedulerTick() }, 60_000)
  schedulerTimer.unref()
}

export function stopMailAutomationScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer)
  schedulerTimer = null
}

export const mailAutomationRouter = Router()

mailAutomationRouter.get('/mail/automation', (_req: Request, res: Response) => {
  res.json(publicMailAutomationSettings())
})

mailAutomationRouter.patch('/mail/automation', (req: Request, res: Response) => {
  const enabled = req.body?.enabled
  const runTime = req.body?.runTime
  if (typeof enabled !== 'boolean' || typeof runTime !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(runTime)) {
    res.status(422).json({ message: '自动处理开关或每日执行时间无效' })
    return
  }
  if (enabled) {
    const account = db.prepare("SELECT id, status, credential_ref FROM mail_accounts WHERE provider = 'qq' LIMIT 1")
      .get() as { id: number; status: string; credential_ref: string } | undefined
    if (!account) {
      res.status(422).json({ message: '请先连接 QQ 邮箱' })
      return
    }
    if (account.status !== 'connected' || !hasQqAuthorizationCode(account.credential_ref)) {
      res.status(422).json({ message: 'QQ 邮箱连接或授权码不可用，请重新测试连接' })
      return
    }
  }
  db.prepare(`UPDATE mail_automation_settings SET enabled = ?, run_time = ?, updated_at = ? WHERE id = 1`)
    .run(enabled ? 1 : 0, runTime, now())
  res.json(publicMailAutomationSettings())
})

mailAutomationRouter.post('/mail/automation/run', async (_req: Request, res: Response) => {
  const account = db.prepare("SELECT id FROM mail_accounts WHERE provider = 'qq' LIMIT 1").get()
  if (!account) {
    res.status(422).json({ message: '请先连接 QQ 邮箱' })
    return
  }
  try {
    const result = await runMailAutomationCycle()
    res.json({ ...result, settings: publicMailAutomationSettings() })
  } catch (error) {
    const requestError = error instanceof AutomationRequestError ? error : null
    res.status(502).json({
      message: requestError?.message ?? '自动处理招聘邮件失败',
      code: requestError?.code ?? 'MAIL_AUTOMATION_ERROR'
    })
  }
})
