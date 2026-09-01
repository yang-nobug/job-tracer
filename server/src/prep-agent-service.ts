import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { db, getSetting, now, setSetting } from './db.js'
import { readReviewFile } from './review-file.js'
import { searchKnowledge, type RetrievedKnowledge } from './knowledge-retrieval.js'
import { KNOWLEDGE_CATEGORIES } from './types.js'
import { validatePrepPlan, type PrepPlan, type PrepPlanItem } from './prep-agent-contracts.js'

export const PREP_AGENT_STATUSES = [
  'pending', 'running', 'waiting_review', 'committing', 'completed', 'failed', 'cancelled'
] as const

export type PrepAgentStatus = (typeof PREP_AGENT_STATUSES)[number]

export interface PrepAgentConstraints {
  available_minutes: number
  focus: string[]
}

interface PrepAgentRunRow {
  id: string
  thread_id: string
  request_id: string
  application_id: number
  interview_id: number
  status: PrepAgentStatus
  goal: string
  constraints_json: string
  input_hash: string
  snapshot_hash: string | null
  current_node: string | null
  plan_json: string | null
  evidence_json: string | null
  warnings_json: string
  error_type: string | null
  error_message: string | null
  model_calls: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  created_at: string
  updated_at: string
  finished_at: string | null
}

export interface PrepAgentEvidence {
  ref: string
  type: 'knowledge_item' | 'review' | 'mastery' | 'application' | 'interview'
  title: string
  excerpt: string
  source_id?: number | null
  item_id?: number
  score?: number
  company?: string
  position?: string
  round?: string
}

export interface PrepAgentContext {
  snapshot_hash: string
  application: {
    ref: 'APP'
    id: number
    company: string
    position: string
    status: string
    location: string | null
    jd_text: string | null
    notes: string | null
  }
  interview: {
    ref: 'IV'
    id: number
    round: string
    scheduled_at: string
    location: string | null
    done: number
  }
  existing_checklist: Array<{ id: number; content: string; done: number }>
  reviews: PrepAgentEvidence[]
  mastery: PrepAgentEvidence[]
}

export class PrepAgentError extends Error {
  constructor(message: string, public statusCode = 422, public kind = 'validation') {
    super(message)
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

function json<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try { return JSON.parse(value) as T } catch { return fallback }
}

function clipped(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function normalizedTask(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function prepAgentInternalToken(): string {
  const key = 'prep_agent_internal_token'
  const current = getSetting(key)
  if (current && current.length >= 32) return current
  const token = randomBytes(32).toString('hex')
  setSetting(key, token)
  return token
}

export function validatePrepAgentCreate(body: unknown): {
  applicationId: number
  interviewId: number
  goal: string
  constraints: PrepAgentConstraints
  requestId: string
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PrepAgentError('请求格式不正确')
  const raw = body as Record<string, unknown>
  const applicationId = Number(raw.application_id)
  const interviewId = Number(raw.interview_id)
  if (!Number.isInteger(applicationId) || applicationId <= 0) throw new PrepAgentError('application_id 非法')
  if (!Number.isInteger(interviewId) || interviewId <= 0) throw new PrepAgentError('interview_id 非法')
  const goal = clipped(raw.goal, 500) || '根据当前岗位和面试资料生成准备计划'
  const rawConstraints = raw.constraints && typeof raw.constraints === 'object' && !Array.isArray(raw.constraints)
    ? raw.constraints as Record<string, unknown>
    : {}
  const availableMinutes = Number(rawConstraints.available_minutes ?? 240)
  if (!Number.isInteger(availableMinutes) || availableMinutes < 30 || availableMinutes > 2880) {
    throw new PrepAgentError('available_minutes 必须是 30～2880 的整数')
  }
  const focus = Array.isArray(rawConstraints.focus)
    ? rawConstraints.focus.map(item => clipped(item, 40)).filter(Boolean).slice(0, 8)
    : []
  const requestId = clipped(raw.request_id, 100)
  if (!requestId || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new PrepAgentError('request_id 非法')
  return { applicationId, interviewId, goal, constraints: { available_minutes: availableMinutes, focus }, requestId }
}

export function createPrepAgentRun(input: ReturnType<typeof validatePrepAgentCreate>): PrepAgentRunRow {
  const existingByRequest = db.prepare('SELECT * FROM prep_agent_runs WHERE request_id=?').get(input.requestId) as PrepAgentRunRow | undefined
  if (existingByRequest) return existingByRequest
  const interview = db.prepare(`SELECT i.id, i.application_id
    FROM interviews i JOIN applications a ON a.id=i.application_id
    WHERE i.id=? AND a.id=?`).get(input.interviewId, input.applicationId) as { id: number; application_id: number } | undefined
  if (!interview) throw new PrepAgentError('投递或面试不存在，或者二者不匹配', 404, 'not_found')
  const active = db.prepare(`SELECT id FROM prep_agent_runs
    WHERE interview_id=? AND status IN ('pending','running','waiting_review','committing')
    ORDER BY created_at DESC LIMIT 1`).get(input.interviewId) as { id: string } | undefined
  if (active) throw new PrepAgentError('这场面试已有正在进行或等待确认的准备计划', 409, 'active_run')
  const id = randomUUID()
  const threadId = `prep:${id}`
  const constraintsJson = JSON.stringify(input.constraints)
  const timestamp = now()
  const inputHash = sha256(stableJson({
    application_id: input.applicationId,
    interview_id: input.interviewId,
    goal: input.goal,
    constraints: input.constraints
  }))
  db.prepare(`INSERT INTO prep_agent_runs (
    id, thread_id, request_id, application_id, interview_id, status, goal,
    constraints_json, input_hash, warnings_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?)`).run(
    id, threadId, input.requestId, input.applicationId, input.interviewId,
    input.goal, constraintsJson, inputHash, timestamp, timestamp
  )
  return getPrepAgentRunRow(id)
}

export function getPrepAgentRunRow(id: string): PrepAgentRunRow {
  const row = db.prepare('SELECT * FROM prep_agent_runs WHERE id=?').get(id) as PrepAgentRunRow | undefined
  if (!row) throw new PrepAgentError('Agent 运行不存在', 404, 'not_found')
  return row
}

export function serializePrepAgentRun(id: string, includeSteps = true): Record<string, unknown> {
  const row = getPrepAgentRunRow(id)
  const steps = includeSteps ? db.prepare(`SELECT id, node, attempt, status, summary, duration_ms,
    error_type, created_at, finished_at FROM prep_agent_steps WHERE run_id=? ORDER BY id`).all(id) : undefined
  const planItems = row.status === 'completed'
    ? db.prepare(`SELECT id, checklist_id, title, category, priority, estimated_minutes,
        reason, success_criteria, evidence_json, sort
      FROM prep_agent_plan_items WHERE run_id=? ORDER BY sort`).all(id).map(value => {
        const item = value as Record<string, unknown> & { evidence_json: string }
        return { ...item, evidence_refs: json<string[]>(item.evidence_json, []), evidence_json: undefined }
      })
    : undefined
  return {
    id: row.id,
    thread_id: row.thread_id,
    request_id: row.request_id,
    application_id: row.application_id,
    interview_id: row.interview_id,
    status: row.status,
    goal: row.goal,
    constraints: json<PrepAgentConstraints>(row.constraints_json, { available_minutes: 240, focus: [] }),
    snapshot_hash: row.snapshot_hash,
    current_node: row.current_node,
    plan: json<PrepPlan | null>(row.plan_json, null),
    evidence: json<PrepAgentEvidence[]>(row.evidence_json, []),
    warnings: json<string[]>(row.warnings_json, []),
    error_type: row.error_type,
    error_message: row.error_message,
    model_calls: row.model_calls,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    total_tokens: row.total_tokens,
    created_at: row.created_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
    ...(steps ? { steps } : {}),
    ...(planItems ? { persisted_items: planItems } : {})
  }
}

export function listPrepAgentRuns(interviewId: number, limit = 10): Record<string, unknown>[] {
  if (!Number.isInteger(interviewId) || interviewId <= 0) throw new PrepAgentError('interview_id 非法')
  const ids = db.prepare(`SELECT id FROM prep_agent_runs WHERE interview_id=?
    ORDER BY created_at DESC LIMIT ?`).all(interviewId, Math.max(1, Math.min(20, limit))) as { id: string }[]
  return ids.map(({ id }) => serializePrepAgentRun(id, false))
}

export function buildPrepAgentContext(runId: string): PrepAgentContext {
  const run = getPrepAgentRunRow(runId)
  const row = db.prepare(`SELECT
      a.id AS application_id, a.company, a.position, a.status, a.location AS application_location,
      a.jd_text, a.notes, a.updated_at AS application_updated_at,
      i.id AS interview_id, i.round, i.scheduled_at, i.location AS interview_location,
      i.done, i.created_at AS interview_created_at
    FROM prep_agent_runs r
    JOIN applications a ON a.id=r.application_id
    JOIN interviews i ON i.id=r.interview_id AND i.application_id=a.id
    WHERE r.id=?`).get(runId) as Record<string, unknown> | undefined
  if (!row) throw new PrepAgentError('投递或面试已不存在', 404, 'not_found')

  const checklist = db.prepare(`SELECT id, content, done FROM checklist_items
    WHERE interview_id=? ORDER BY sort, id`).all(run.interview_id) as Array<{ id: number; content: string; done: number }>

  const reviewRows = db.prepare(`SELECT i.id, i.round, i.scheduled_at, i.review_file
    FROM interviews i WHERE i.application_id=? AND i.id<>? AND i.review_file IS NOT NULL
    ORDER BY i.scheduled_at DESC LIMIT 8`).all(run.application_id, run.interview_id) as Array<{
      id: number; round: string; scheduled_at: string; review_file: string
    }>
  const reviews: PrepAgentEvidence[] = []
  for (const item of reviewRows) {
    let content = ''
    try { content = clipped(readReviewFile(item.review_file), 4000) } catch { content = '' }
    const meaningful = content.replace(/[-\s#*:：]/g, '')
    if (!meaningful) continue
    reviews.push({
      ref: `R${reviews.length + 1}`,
      type: 'review',
      title: `${item.round} · ${item.scheduled_at}`,
      excerpt: content,
      round: item.round
    })
  }

  const masteryRows = db.prepare(`SELECT i.id, i.source_id, i.question, COALESCE(i.answer,'') AS answer,
      i.category, i.mastery, COALESCE(s.company,'') AS company,
      COALESCE(s.position,'') AS position, COALESCE(s.round,'') AS round
    FROM knowledge_items i LEFT JOIN knowledge_sources s ON s.id=i.source_id
    WHERE i.mastery<2
    ORDER BY CASE WHEN s.application_id=? THEN 0 WHEN s.company=? THEN 1 ELSE 2 END,
             i.mastery ASC, i.updated_at DESC LIMIT 30`).all(
    run.application_id, String(row.company ?? '')
  ) as Array<Record<string, unknown>>
  const mastery: PrepAgentEvidence[] = masteryRows.map((item, index) => ({
    ref: `M${index + 1}`,
    type: 'mastery',
    item_id: Number(item.id),
    source_id: item.source_id == null ? null : Number(item.source_id),
    title: String(item.question),
    excerpt: clipped(item.answer, 1200),
    company: String(item.company ?? ''),
    position: String(item.position ?? ''),
    round: String(item.round ?? '')
  }))

  const contextWithoutHash = {
    application: {
      ref: 'APP' as const,
      id: Number(row.application_id),
      company: String(row.company),
      position: String(row.position),
      status: String(row.status),
      location: row.application_location == null ? null : String(row.application_location),
      jd_text: clipped(row.jd_text, 12_000) || null,
      notes: clipped(row.notes, 3000) || null
    },
    interview: {
      ref: 'IV' as const,
      id: Number(row.interview_id),
      round: String(row.round),
      scheduled_at: String(row.scheduled_at),
      location: row.interview_location == null ? null : String(row.interview_location),
      done: Number(row.done)
    },
    existing_checklist: checklist,
    reviews,
    mastery
  }
  const snapshotSource = {
    ...contextWithoutHash,
    application_updated_at: row.application_updated_at,
    interview_created_at: row.interview_created_at
  }
  return { snapshot_hash: sha256(stableJson(snapshotSource)), ...contextWithoutHash }
}

export function searchPrepAgentEvidence(queries: unknown): PrepAgentEvidence[] {
  if (!Array.isArray(queries) || queries.length > 8) throw new PrepAgentError('queries 必须是最多 8 项的数组')
  const merged = new Map<number, RetrievedKnowledge>()
  for (const [index, value] of queries.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PrepAgentError(`queries[${index}] 非法`)
    const raw = value as Record<string, unknown>
    const query = clipped(raw.query, 200)
    if (!query) throw new PrepAgentError(`queries[${index}].query 不能为空`)
    const category = raw.category == null ? undefined : clipped(raw.category, 40)
    if (category && !KNOWLEDGE_CATEGORIES.includes(category)) throw new PrepAgentError(`queries[${index}].category 非法`)
    const owner = raw.owner === 'mine' || raw.owner === 'others' ? raw.owner : undefined
    const result = searchKnowledge(query, { limit: 8, category, owner })
    for (const item of result.items) {
      const existing = merged.get(item.id)
      if (!existing || item.score > existing.score) merged.set(item.id, item)
    }
  }
  return Array.from(merged.values())
    .sort((left, right) => right.score - left.score || left.id - right.id)
    .slice(0, 15)
    .map((item, index) => ({
      ref: `E${index + 1}`,
      type: 'knowledge_item',
      item_id: item.id,
      source_id: item.sourceId,
      title: item.question,
      excerpt: clipped(item.answer, 1800),
      score: item.score,
      company: item.company,
      position: item.position,
      round: item.round
    }))
}

export function insertPrepAgentStep(runId: string, body: unknown): number {
  getPrepAgentRunRow(runId)
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const node = clipped(raw.node, 80)
  if (!node) throw new PrepAgentError('node 不能为空')
  const attempt = Number(raw.attempt ?? 1)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20) throw new PrepAgentError('attempt 非法')
  const result = db.prepare(`INSERT INTO prep_agent_steps
    (run_id, node, attempt, status, summary, input_hash, created_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?)`).run(
      runId, node, attempt, clipped(raw.summary, 500) || null,
      clipped(raw.input_hash, 64) || null, now()
    )
  db.prepare(`UPDATE prep_agent_runs SET status='running', current_node=?, updated_at=?
    WHERE id=? AND status NOT IN ('completed','cancelled')`).run(node, now(), runId)
  return Number(result.lastInsertRowid)
}

export function finishPrepAgentStep(runId: string, stepId: number, body: unknown): void {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const status = raw.status === 'completed' || raw.status === 'failed' ? raw.status : null
  if (!status) throw new PrepAgentError('step status 非法')
  const duration = Number(raw.duration_ms)
  if (!Number.isInteger(duration) || duration < 0) throw new PrepAgentError('duration_ms 非法')
  const result = db.prepare(`UPDATE prep_agent_steps SET status=?, summary=?, duration_ms=?,
      output_hash=?, error_type=?, finished_at=? WHERE id=? AND run_id=? AND status='running'`).run(
    status, clipped(raw.summary, 500) || null, duration,
    clipped(raw.output_hash, 64) || null, clipped(raw.error_type, 80) || null,
    now(), stepId, runId
  )
  if (!result.changes) throw new PrepAgentError('步骤不存在或已结束', 409, 'step_conflict')
}

export function updatePrepAgentRun(runId: string, body: unknown): void {
  const current = getPrepAgentRunRow(runId)
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const status = typeof raw.status === 'string' && PREP_AGENT_STATUSES.includes(raw.status as PrepAgentStatus)
    ? raw.status as PrepAgentStatus
    : current.status
  if (['completed', 'cancelled'].includes(current.status) && status !== current.status) return
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.map(value => clipped(value, 300)).filter(Boolean).slice(0, 30)
    : json<string[]>(current.warnings_json, [])
  const metrics = raw.metrics && typeof raw.metrics === 'object' && !Array.isArray(raw.metrics)
    ? raw.metrics as Record<string, unknown>
    : {}
  const metric = (key: string, fallback: number): number => {
    const value = Number(metrics[key])
    return Number.isInteger(value) && value >= 0 ? value : fallback
  }
  const plan = raw.plan === undefined ? current.plan_json : JSON.stringify(validatePrepPlan(raw.plan))
  const evidence = raw.evidence === undefined
    ? current.evidence_json
    : JSON.stringify(Array.isArray(raw.evidence) ? raw.evidence.slice(0, 30) : [])
  const terminal = ['completed', 'failed', 'cancelled'].includes(status)
  db.prepare(`UPDATE prep_agent_runs SET status=?, snapshot_hash=?, current_node=?, plan_json=?,
      evidence_json=?, warnings_json=?, error_type=?, error_message=?, model_calls=?,
      prompt_tokens=?, completion_tokens=?, total_tokens=?, updated_at=?, finished_at=?
    WHERE id=?`).run(
      status,
      raw.snapshot_hash === undefined ? current.snapshot_hash : clipped(raw.snapshot_hash, 64) || null,
      raw.current_node === undefined ? current.current_node : clipped(raw.current_node, 80) || null,
      plan,
      evidence,
      JSON.stringify(warnings),
      raw.error_type === undefined ? current.error_type : clipped(raw.error_type, 80) || null,
      raw.error_message === undefined ? current.error_message : clipped(raw.error_message, 500) || null,
      metric('model_calls', current.model_calls),
      metric('prompt_tokens', current.prompt_tokens),
      metric('completion_tokens', current.completion_tokens),
      metric('total_tokens', current.total_tokens),
      now(), terminal ? now() : null, runId
    )
}

function validatePlanAgainstRun(run: PrepAgentRunRow, rawPlan: unknown): { plan: PrepPlan; context: PrepAgentContext } {
  const plan = validatePrepPlan(rawPlan)
  const constraints = json<PrepAgentConstraints>(run.constraints_json, { available_minutes: 240, focus: [] })
  const total = plan.items.reduce((sum, item) => sum + item.estimated_minutes, 0)
  if (total > constraints.available_minutes) throw new PrepAgentError(`计划总时长 ${total} 分钟超过预算 ${constraints.available_minutes} 分钟`)
  const context = buildPrepAgentContext(run.id)
  const evidence = json<PrepAgentEvidence[]>(run.evidence_json, [])
  const validRefs = new Set([
    'APP', 'IV', ...context.reviews.map(item => item.ref), ...context.mastery.map(item => item.ref),
    ...evidence.map(item => item.ref)
  ])
  const seen = new Set<string>()
  const existing = context.existing_checklist.map(item => normalizedTask(item.content)).filter(Boolean)
  for (const [index, item] of plan.items.entries()) {
    const key = normalizedTask(item.title)
    if (!key) throw new PrepAgentError(`第 ${index + 1} 项标题无效`)
    if (seen.has(key)) throw new PrepAgentError(`第 ${index + 1} 项与计划中的其他任务重复`)
    if (existing.some(value => value.includes(key) || key.includes(value))) {
      throw new PrepAgentError(`第 ${index + 1} 项与已有准备清单重复`)
    }
    seen.add(key)
    for (const ref of item.evidence_refs) {
      if (!validRefs.has(ref)) throw new PrepAgentError(`第 ${index + 1} 项包含无效引用 ${ref}`)
    }
  }
  return { plan, context }
}

export function validatePrepAgentPlanForRun(runId: string, rawPlan: unknown): PrepPlan {
  return validatePlanAgainstRun(getPrepAgentRunRow(runId), rawPlan).plan
}

export function persistPrepAgentPlan(runId: string, rawPlan: unknown): { checklistIds: number[]; plan: PrepPlan } {
  const run = getPrepAgentRunRow(runId)
  if (run.status === 'completed') {
    const rows = db.prepare(`SELECT checklist_id FROM prep_agent_plan_items
      WHERE run_id=? AND checklist_id IS NOT NULL ORDER BY sort`).all(runId) as { checklist_id: number }[]
    return { checklistIds: rows.map(row => row.checklist_id), plan: json<PrepPlan>(run.plan_json, { summary: '', items: [] }) }
  }
  if (run.status !== 'waiting_review' && run.status !== 'committing') {
    throw new PrepAgentError('当前运行不在等待确认状态', 409, 'run_state')
  }
  const { plan, context } = validatePlanAgainstRun(run, rawPlan)
  if (run.snapshot_hash && run.snapshot_hash !== context.snapshot_hash) {
    throw new PrepAgentError('投递、面试或准备清单在生成后发生了变化，请重新生成或重新确认', 409, 'snapshot_changed')
  }
  const timestamp = now()
  const evidence = json<PrepAgentEvidence[]>(run.evidence_json, [])
  const evidenceByRef = new Map(evidence.map(item => [item.ref, item]))
  const ids = db.transaction(() => {
    db.prepare(`UPDATE prep_agent_runs SET status='committing', current_node='persist_plan', updated_at=? WHERE id=?`).run(timestamp, runId)
    const existingRows = db.prepare(`SELECT checklist_id FROM prep_agent_plan_items
      WHERE run_id=? AND checklist_id IS NOT NULL ORDER BY sort`).all(runId) as { checklist_id: number }[]
    if (existingRows.length) return existingRows.map(row => row.checklist_id)
    const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) AS value FROM checklist_items WHERE interview_id=?')
      .get(run.interview_id) as { value: number }
    const insertChecklist = db.prepare(`INSERT INTO checklist_items (interview_id, content, done, sort)
      VALUES (?, ?, 0, ?)`)
    const insertPlan = db.prepare(`INSERT INTO prep_agent_plan_items
      (run_id, checklist_id, title, category, priority, estimated_minutes, reason,
       success_criteria, evidence_json, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const checklistIds: number[] = []
    plan.items.forEach((item: PrepPlanItem, index) => {
      const content = `[${item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}] ${item.title}（约${item.estimated_minutes}分钟）`
      const result = insertChecklist.run(run.interview_id, content, maxSort.value + index + 1)
      const checklistId = Number(result.lastInsertRowid)
      checklistIds.push(checklistId)
      const evidenceSnapshot = item.evidence_refs.map(ref => evidenceByRef.get(ref) ?? { ref })
      insertPlan.run(
        runId, checklistId, item.title, item.category, item.priority, item.estimated_minutes,
        item.reason, item.success_criteria, JSON.stringify(evidenceSnapshot), index
      )
    })
    db.prepare(`UPDATE prep_agent_runs SET status='completed', current_node='finalize', plan_json=?,
      updated_at=?, finished_at=?, error_type=NULL, error_message=NULL WHERE id=?`).run(
        JSON.stringify(plan), timestamp, timestamp, runId
      )
    return checklistIds
  })()
  return { checklistIds: ids, plan }
}

export function cancelPrepAgentRun(runId: string): void {
  const run = getPrepAgentRunRow(runId)
  if (run.status === 'completed') throw new PrepAgentError('已完成的计划不能取消', 409, 'run_state')
  if (run.status === 'cancelled') return
  db.prepare(`UPDATE prep_agent_runs SET status='cancelled', current_node='cancelled',
    updated_at=?, finished_at=? WHERE id=?`).run(now(), now(), runId)
}

export function recoverablePrepAgentRuns(): Array<{ id: string; thread_id: string }> {
  return db.prepare(`SELECT id, thread_id FROM prep_agent_runs WHERE status IN ('pending','running','committing')
    ORDER BY created_at`).all() as Array<{ id: string; thread_id: string }>
}
