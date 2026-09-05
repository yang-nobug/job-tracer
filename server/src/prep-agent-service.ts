import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { db, getSetting, now, setSetting } from './db.js'
import { readReviewFile } from './review-file.js'
import { searchKnowledge, type RetrievedKnowledge } from './knowledge-retrieval.js'
import { KNOWLEDGE_CATEGORIES } from './types.js'
import { createOperationRun, currentTrace, finishOperationRun, finishOperationStep, startOperationStep } from './observability.js'
import {
  validatePrepCritic, validatePrepGapAnalysis, validatePrepPlan, validatePrepRoleProfile,
  type PrepCriticResult, type PrepGapAnalysis, type PrepPlan, type PrepPlanItem, type PrepRoleProfile
} from './prep-agent-contracts.js'

export const PREP_AGENT_STATUSES = [
  'pending', 'running', 'waiting_review', 'committing', 'completed', 'failed', 'cancelled'
] as const

export type PrepAgentStatus = (typeof PREP_AGENT_STATUSES)[number]

export interface PrepAgentConstraints {
  focus: string[]
  project_ids: number[]
  /** 全局简历版本；与投递记录里的 resume_id 无关。 */
  resume_id: number | null
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
  role_profile_json: string | null
  gap_analysis_json: string | null
  critic_json: string | null
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
  trace_id: string | null
  operation_run_id: number | null
}

export interface PrepAgentEvidence {
  ref: string
  type: 'knowledge_item' | 'review' | 'mastery' | 'application' | 'interview' | 'project' | 'resume'
  title: string
  excerpt: string
  source_id?: number | null
  item_id?: number
  score?: number
  company?: string
  position?: string
  round?: string
  code_session_id?: string
  code_evidence_refs?: string[]
}

export interface PrepAgentReference {
  ref: string
  type: 'application' | 'interview' | 'review' | 'mastery' | 'knowledge_item' | 'project' | 'resume'
  title: string
  subtitle: string
  excerpt: string
  source_id?: number | null
  item_id?: number | null
  code_session_id?: string | null
  code_evidence_refs?: string[]
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
  resume: PrepAgentEvidence | null
  resume_status: string | null
  reviews: PrepAgentEvidence[]
  mastery: PrepAgentEvidence[]
  projects: PrepAgentEvidence[]
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

export function parsePrepAgentConstraints(value: string | null): PrepAgentConstraints {
  const raw = json<Record<string, unknown>>(value, {})
  const focus = Array.isArray(raw.focus)
    ? raw.focus.map(item => clipped(item, 40)).filter(Boolean).slice(0, 8)
    : []
  const projectIds = Array.isArray(raw.project_ids)
    ? [...new Set(raw.project_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 2)
    : []
  const resumeId = Number(raw.resume_id)
  return { focus, project_ids: projectIds, resume_id: Number.isInteger(resumeId) && resumeId > 0 ? resumeId : null }
}

function normalizedTask(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

export function prepAgentInternalToken(): string {
  const configured = process.env.PREP_AGENT_INTERNAL_TOKEN?.trim()
  if (configured && configured.length >= 32) return configured
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
  const focus = Array.isArray(rawConstraints.focus)
    ? rawConstraints.focus.map(item => clipped(item, 40)).filter(Boolean).slice(0, 8)
    : []
  const requestId = clipped(raw.request_id, 100)
  if (!requestId || !/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new PrepAgentError('request_id 非法')
  const projectIds = Array.isArray(rawConstraints.project_ids)
    ? [...new Set(rawConstraints.project_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 2)
    : []
  if (projectIds.length) {
    const found = db.prepare(`SELECT id FROM project_profiles WHERE id IN (${projectIds.map(() => '?').join(',')})`).all(...projectIds) as Array<{ id: number }>
    if (found.length !== projectIds.length) throw new PrepAgentError('选择的项目档案不存在', 404, 'not_found')
  }
  const rawResumeId = Number(rawConstraints.resume_id)
  const resumeId = Number.isInteger(rawResumeId) && rawResumeId > 0 ? rawResumeId : null
  if (resumeId) {
    const resume = db.prepare(`SELECT r.id FROM resumes r JOIN resume_texts t ON t.resume_id=r.id
      WHERE r.id=? AND t.status='completed' AND length(COALESCE(t.text_content,''))>0`).get(resumeId)
    if (!resume) throw new PrepAgentError('选择的简历不存在或尚未成功提取文本', 422, 'resume_unavailable')
  }
  return { applicationId, interviewId, goal, constraints: { focus, project_ids: projectIds, resume_id: resumeId }, requestId }
}

export function createPrepAgentRun(input: ReturnType<typeof validatePrepAgentCreate>): PrepAgentRunRow {
  const existingByRequest = db.prepare('SELECT * FROM prep_agent_runs WHERE request_id=?').get(input.requestId) as PrepAgentRunRow | undefined
  if (existingByRequest) return existingByRequest
  const interview = db.prepare(`SELECT i.id, i.application_id, i.done
    FROM interviews i JOIN applications a ON a.id=i.application_id
    WHERE i.id=? AND a.id=?`).get(input.interviewId, input.applicationId) as { id: number; application_id: number; done: number } | undefined
  if (!interview) throw new PrepAgentError('投递或面试不存在，或者二者不匹配', 404, 'not_found')
  if (interview.done) throw new PrepAgentError('该面试已完成，不能再生成面试准备计划；请在复盘中记录收获后再进行补强。', 409, 'interview_completed')
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
  const traceId = currentTrace()?.traceId
  const operation = createOperationRun({ operationType: 'prep_agent_plan', traceId, parentEntityType: 'interview', parentEntityId: input.interviewId,
    inputSummary: { application_id: input.applicationId, interview_id: input.interviewId, goal: input.goal, focus: input.constraints.focus, project_ids: input.constraints.project_ids, resume_id: input.constraints.resume_id } })
  db.prepare(`INSERT INTO prep_agent_runs (
    id, thread_id, request_id, application_id, interview_id, status, goal,
    constraints_json, input_hash, warnings_json, trace_id, operation_run_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, '[]', ?, ?, ?, ?)`).run(
    id, threadId, input.requestId, input.applicationId, input.interviewId,
    input.goal, constraintsJson, inputHash, operation.traceId, operation.id, timestamp, timestamp
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
    constraints: parsePrepAgentConstraints(row.constraints_json),
    snapshot_hash: row.snapshot_hash,
    current_node: row.current_node,
    plan: json<PrepPlan | null>(row.plan_json, null),
    evidence: json<PrepAgentEvidence[]>(row.evidence_json, []),
    role_profile: json<PrepRoleProfile | null>(row.role_profile_json, null),
    gap_analysis: json<PrepGapAnalysis | null>(row.gap_analysis_json, null),
    critic: json<PrepCriticResult | null>(row.critic_json, null),
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
    FROM prep_agent_runs pr
    JOIN applications a ON a.id=pr.application_id
    JOIN interviews i ON i.id=r.interview_id AND i.application_id=a.id
    WHERE pr.id=?`).get(runId) as Record<string, unknown> | undefined
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

  // 简历是全局版本资料，由本次运行明确选择，不依赖投递记录是否曾绑定该文件。
  // 它只能支持项目表达核对，不能替代源码证据或证明个人贡献。
  const selectedResumeId = parsePrepAgentConstraints(run.constraints_json).resume_id
  const resumeRow = selectedResumeId
    ? db.prepare(`SELECT r.id,r.filename,r.note,t.text_content FROM resumes r JOIN resume_texts t ON t.resume_id=r.id
      WHERE r.id=? AND t.status='completed'`).get(selectedResumeId) as { id: number; filename: string; note: string | null; text_content: string } | undefined
    : undefined
  const resumeText = clipped(resumeRow?.text_content, 16_000)
  const resume: PrepAgentEvidence | null = resumeRow && resumeText
    ? { ref: 'RES', type: 'resume', item_id: resumeRow.id, title: resumeRow.note ? `${resumeRow.filename} · ${resumeRow.note}` : resumeRow.filename, excerpt: resumeText }
    : null

  // 只提供用户主动填写的项目描述与确认事实，不把整仓代码或任意代码片段送入模型。
  const selectedProjectIds = parsePrepAgentConstraints(run.constraints_json).project_ids
  const projectRows = selectedProjectIds.length
    ? db.prepare(`SELECT p.id,p.name,p.description FROM project_profiles p WHERE p.id IN (${selectedProjectIds.map(() => '?').join(',')}) ORDER BY p.updated_at DESC`).all(...selectedProjectIds) as Array<{ id: number; name: string; description: string }>
    : []
  const projectIds = projectRows.map(item => item.id)
  const projectFacts = projectIds.length
    ? db.prepare(`SELECT id,project_id,fact_type,title,content,evidence_chunk_ids_json FROM project_facts
      WHERE project_id IN (${projectIds.map(() => '?').join(',')}) ORDER BY id DESC`).all(...projectIds) as Array<{ id: number; project_id: number; fact_type: string; title: string; content: string; evidence_chunk_ids_json: string }>
    : []
  const evidenceIds = [...new Set(projectFacts.flatMap(item => json<number[]>(item.evidence_chunk_ids_json, []).filter(Number.isInteger)))].slice(0, 120)
  const codeLocations = new Map<number, string>()
  if (evidenceIds.length) {
    const rows = db.prepare(`SELECT c.id,f.relative_path,c.start_line,c.end_line FROM project_code_chunks c
      JOIN project_code_files f ON f.id=c.file_id WHERE c.id IN (${evidenceIds.map(() => '?').join(',')})`).all(...evidenceIds) as Array<{ id: number; relative_path: string; start_line: number; end_line: number }>
    for (const item of rows) codeLocations.set(item.id, `${item.relative_path}:${item.start_line}-${item.end_line}`)
  }
  const factsByProject = new Map<number, string[]>()
  for (const fact of projectFacts) {
    const locations = json<number[]>(fact.evidence_chunk_ids_json, []).map(id => codeLocations.get(id)).filter(Boolean)
    const line = `${fact.fact_type}：${fact.title}\n${fact.content}${locations.length ? `\n代码依据（仅定位，不含源码）：${locations.join('；')}` : ''}`
    const values = factsByProject.get(fact.project_id) ?? []; values.push(line); factsByProject.set(fact.project_id, values)
  }
  const projects: PrepAgentEvidence[] = projectRows.map((item, index) => ({
    ref: `P${index + 1}`, type: 'project', item_id: item.id, title: item.name,
    excerpt: clipped([item.description, ...(factsByProject.get(item.id) ?? [])].filter(Boolean).join('\n\n'), 6_000) || '尚未填写项目说明或已确认事实。'
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
    resume,
    resume_status: selectedResumeId ? (resume ? 'completed' : 'unavailable') : null,
    reviews,
    mastery,
    projects
  }
  const snapshotSource = {
    ...contextWithoutHash,
    application_updated_at: row.application_updated_at,
    interview_created_at: row.interview_created_at
  }
  return { snapshot_hash: sha256(stableJson(snapshotSource)), ...contextWithoutHash }
}

/** 将计划中使用的短引用统一解析为可展示的本地证据，不向模型或前端暴露文件路径。 */
export function buildPrepAgentReferences(runId: string): PrepAgentReference[] {
  const context = buildPrepAgentContext(runId)
  const references: PrepAgentReference[] = [
    {
      ref: 'APP', type: 'application', title: `${context.application.company} · ${context.application.position}`,
      subtitle: `投递状态：${context.application.status}${context.application.location ? ` · ${context.application.location}` : ''}`,
      excerpt: [context.application.jd_text && `JD 正文\n${context.application.jd_text}`, context.application.notes && `投递备注\n${context.application.notes}`]
        .filter(Boolean).join('\n\n') || '当前投递未填写 JD 或备注。'
    },
    {
      ref: 'IV', type: 'interview', title: context.interview.round,
      subtitle: `面试时间：${context.interview.scheduled_at}${context.interview.location ? ` · ${context.interview.location}` : ''}`,
      excerpt: context.interview.done ? '该面试已标记完成。' : '当前待准备的面试。'
    },
    ...(context.resume ? [{
      ref: context.resume.ref, type: 'resume' as const, title: context.resume.title,
      subtitle: '当前投递关联的简历文本：用于核对项目表述，不等同于源码或个人贡献证明', excerpt: context.resume.excerpt, item_id: context.resume.item_id
    }] : []),
    ...context.reviews.map(item => ({
      ref: item.ref, type: 'review' as const, title: item.title,
      subtitle: '历史面试复盘', excerpt: item.excerpt || '复盘原文不可用。'
    })),
    ...context.mastery.map(item => ({
      ref: item.ref, type: 'mastery' as const, title: item.title,
      subtitle: `知识掌握度：待补强${item.company ? ` · ${item.company}` : ''}`,
      excerpt: item.excerpt || '该知识条目尚未填写答案。', source_id: item.source_id ?? null, item_id: item.item_id
    })),
    ...context.projects.map(item => ({
      ref: item.ref, type: 'project' as const, title: item.title,
      subtitle: '项目档案：用户填写的说明和已确认事实', excerpt: item.excerpt, item_id: item.item_id
    }))
  ]
  const run = getPrepAgentRunRow(runId)
  for (const item of json<PrepAgentEvidence[]>(run.evidence_json, [])) {
    if (references.some(reference => reference.ref === item.ref)) continue
    const codeSessionId = typeof item.code_session_id === 'string' && /^[a-f0-9-]{36}$/i.test(item.code_session_id) ? item.code_session_id : null
    const codeEvidenceRefs = Array.isArray(item.code_evidence_refs) ? item.code_evidence_refs.filter(ref => typeof ref === 'string').slice(0, 12) : []
    const codeEvidence = codeSessionId && codeEvidenceRefs.length
      ? db.prepare(`SELECT evidence_ref,relative_path,start_line,end_line,excerpt FROM code_reading_evidence
        WHERE session_id=? AND evidence_ref IN (${codeEvidenceRefs.map(() => '?').join(',')}) ORDER BY id`).all(codeSessionId, ...codeEvidenceRefs) as Array<{ evidence_ref: string; relative_path: string; start_line: number; end_line: number; excerpt: string }>
      : []
    const codeExcerpt = codeEvidence.length
      ? `${item.excerpt || ''}\n\n代码原始证据：\n${codeEvidence.map(entry => `[${entry.evidence_ref}] ${entry.relative_path}:${entry.start_line}-${entry.end_line}\n${entry.excerpt}`).join('\n\n')}`.slice(0, 12_000)
      : item.excerpt || '证据原文不可用。'
    references.push({
      ref: item.ref, type: item.type === 'review' ? 'review' : item.type === 'mastery' ? 'mastery' : item.type === 'knowledge_item' ? 'knowledge_item' : item.type === 'application' ? 'application' : item.type === 'project' ? 'project' : item.type === 'resume' ? 'resume' : 'interview',
      title: item.title, subtitle: codeSessionId ? '读代码 Agent 调查结果' : item.type === 'knowledge_item' ? '知识库检索结果' : '计划检索证据',
      excerpt: codeExcerpt, source_id: item.source_id ?? null, item_id: item.item_id,
      code_session_id: codeSessionId, code_evidence_refs: codeEvidenceRefs
    })
  }
  return references
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
  const run = getPrepAgentRunRow(runId)
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  const node = clipped(raw.node, 80)
  if (!node) throw new PrepAgentError('node 不能为空')
  const attempt = Number(raw.attempt ?? 1)
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 20) throw new PrepAgentError('attempt 非法')
  const operationStepId = run.operation_run_id
    ? startOperationStep({ operationRunId: run.operation_run_id, stepName: node, sequence: attempt, inputSummary: { summary: clipped(raw.summary, 500) } })
    : null
  const result = db.prepare(`INSERT INTO prep_agent_steps
    (run_id, node, attempt, status, summary, input_hash, operation_step_id, created_at)
    VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`).run(
    runId, node, attempt, clipped(raw.summary, 500) || null,
    clipped(raw.input_hash, 64) || null, operationStepId, now()
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
  const operationStep = db.prepare('SELECT operation_step_id FROM prep_agent_steps WHERE id=?').get(stepId) as { operation_step_id: number | null } | undefined
  if (operationStep?.operation_step_id) {
    finishOperationStep(operationStep.operation_step_id, {
      status: status === 'completed' ? 'succeeded' : 'failed',
      outputSummary: status === 'completed' ? { summary: clipped(raw.summary, 500) } : undefined,
      errorCode: status === 'failed' ? clipped(raw.error_type, 80) || 'PREP_AGENT_STEP_FAILED' : undefined,
      errorMessage: status === 'failed' ? clipped(raw.summary, 500) : undefined
    })
  }
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
  const roleProfile = raw.role_profile === undefined
    ? current.role_profile_json
    : JSON.stringify(validatePrepRoleProfile(raw.role_profile))
  const gapAnalysis = raw.gap_analysis === undefined
    ? current.gap_analysis_json
    : JSON.stringify(validatePrepGapAnalysis(raw.gap_analysis))
  const critic = raw.critic === undefined
    ? current.critic_json
    : JSON.stringify(validatePrepCritic(raw.critic))
  const terminal = ['completed', 'failed', 'cancelled'].includes(status)
  db.prepare(`UPDATE prep_agent_runs SET status=?, snapshot_hash=?, current_node=?, plan_json=?,
      evidence_json=?, role_profile_json=?, gap_analysis_json=?, critic_json=?, warnings_json=?, error_type=?, error_message=?, model_calls=?,
      prompt_tokens=?, completion_tokens=?, total_tokens=?, updated_at=?, finished_at=?
    WHERE id=?`).run(
      status,
      raw.snapshot_hash === undefined ? current.snapshot_hash : clipped(raw.snapshot_hash, 64) || null,
      raw.current_node === undefined ? current.current_node : clipped(raw.current_node, 80) || null,
      plan,
      evidence,
      roleProfile,
      gapAnalysis,
      critic,
      JSON.stringify(warnings),
      raw.error_type === undefined ? current.error_type : clipped(raw.error_type, 80) || null,
      raw.error_message === undefined ? current.error_message : clipped(raw.error_message, 500) || null,
      metric('model_calls', current.model_calls),
      metric('prompt_tokens', current.prompt_tokens),
      metric('completion_tokens', current.completion_tokens),
      metric('total_tokens', current.total_tokens),
      now(), terminal ? now() : null, runId
    )
  if (terminal && current.operation_run_id) {
    const errorCode = raw.error_type === undefined ? current.error_type ?? undefined : clipped(raw.error_type, 80) || undefined
    const errorMessage = raw.error_message === undefined ? current.error_message ?? undefined : clipped(raw.error_message, 500) || undefined
    finishOperationRun(current.operation_run_id, {
      status: status === 'completed' ? 'succeeded' : status === 'cancelled' ? 'cancelled' : 'failed',
      resultSummary: { prep_agent_run_id: runId, model_calls: metric('model_calls', current.model_calls) }, errorCode, errorMessage
    })
  }
}

function validatePlanAgainstRun(run: PrepAgentRunRow, rawPlan: unknown): { plan: PrepPlan; context: PrepAgentContext } {
  const plan = validatePrepPlan(rawPlan)
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
      const content = `[${item.priority === 'high' ? '高' : item.priority === 'medium' ? '中' : '低'}] ${item.title}（建议${item.estimated_minutes}分钟）`
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
  if (run.operation_run_id) {
    finishOperationRun(run.operation_run_id, {
      status: 'succeeded', resultSummary: { prep_agent_run_id: runId, checklist_count: ids.length, model_calls: run.model_calls }
    })
  }
  return { checklistIds: ids, plan }
}

export function cancelPrepAgentRun(runId: string): void {
  const run = getPrepAgentRunRow(runId)
  if (run.status === 'completed') throw new PrepAgentError('已完成的计划不能取消', 409, 'run_state')
  if (run.status === 'cancelled') return
  db.prepare(`UPDATE prep_agent_runs SET status='cancelled', current_node='cancelled',
    updated_at=?, finished_at=? WHERE id=?`).run(now(), now(), runId)
  if (run.operation_run_id) {
    finishOperationRun(run.operation_run_id, { status: 'cancelled', resultSummary: { prep_agent_run_id: runId } })
  }
}

export function recoverablePrepAgentRuns(): Array<{ id: string; thread_id: string }> {
  return db.prepare(`SELECT id, thread_id FROM prep_agent_runs WHERE status IN ('pending','running','committing')
    ORDER BY created_at`).all() as Array<{ id: string; thread_id: string }>
}
