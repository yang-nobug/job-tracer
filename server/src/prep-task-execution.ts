import { db, now } from './db.js'
import {
  completeChat, completeStructured, type AiCompletionResult, type ChatMessage
} from './ai.js'
import { searchKnowledge, type RetrievedKnowledge } from './knowledge-retrieval.js'
import { loadPrompt } from './prompt-loader.js'
import { buildPrepAgentContext, PrepAgentError } from './prep-agent-service.js'
import {
  PREP_LEARNING_MODULE_SCHEMA, PREP_TASK_BLUEPRINT_SCHEMA, PREP_TASK_CRITIC_SCHEMA,
  PREP_TASK_PRACTICE_SCHEMA, normalizeStoredPrepTaskGuide, validatePrepLearningModule,
  validatePrepTaskBlueprint, validatePrepTaskCritic, validatePrepTaskGuide,
  validatePrepTaskPracticeSet, type PrepLearningModule, type PrepTaskBlueprint,
  type PrepTaskBlueprintModule, type PrepTaskCriticResult, type PrepTaskGuide,
  type PrepTaskPracticeSet
} from './prep-task-contracts.js'

type GenerationStatus = 'idle' | 'running' | 'completed' | 'failed'

interface PrepTaskRow {
  id: number
  run_id: string
  checklist_id: number
  application_id: number
  interview_id: number
  title: string
  category: string
  priority: string
  estimated_minutes: number
  reason: string
  success_criteria: string
  evidence_json: string
  sort: number
  checklist_content: string
  done: number
  goal: string
  run_evidence_json: string | null
  session_id?: number | null
  guide_json?: string | null
  progress_json?: string | null
  guide_model?: string | null
  guide_generated_at?: string | null
  session_updated_at?: string | null
  message_count?: number
  guide_version?: number
  generation_status?: GenerationStatus
  generation_stage?: string | null
  generation_progress?: number
  generation_error?: string | null
  generation_started_at?: string | null
  generation_model_calls?: number
  generation_prompt_tokens?: number
  generation_completion_tokens?: number
  generation_total_tokens?: number
  quality_json?: string | null
}

export interface PrepTaskProgress {
  steps: number[]
  checks: number[]
}

interface GenerationMetrics {
  modelCalls: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  model: string | null
}

const activeGenerations = new Map<number, Promise<void>>()

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try { return value ? JSON.parse(value) as T : fallback } catch { return fallback }
}

function clipped(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function taskSelect(where: string): string {
  return `SELECT p.id, p.run_id, p.checklist_id, p.title, p.category, p.priority,
      p.estimated_minutes, p.reason, p.success_criteria, p.evidence_json, p.sort,
      r.application_id, r.interview_id, r.goal, r.evidence_json AS run_evidence_json,
      c.content AS checklist_content, c.done,
      s.id AS session_id, s.guide_json, s.progress_json, s.guide_model,
      s.guide_generated_at, s.updated_at AS session_updated_at,
      s.guide_version, s.generation_status, s.generation_stage, s.generation_progress,
      s.generation_error, s.generation_started_at, s.generation_model_calls,
      s.generation_prompt_tokens, s.generation_completion_tokens, s.generation_total_tokens,
      s.quality_json,
      COALESCE((SELECT COUNT(*) FROM prep_task_messages m WHERE m.session_id=s.id), 0) AS message_count
    FROM prep_agent_plan_items p
    JOIN prep_agent_runs r ON r.id=p.run_id AND r.status='completed'
    JOIN checklist_items c ON c.id=p.checklist_id AND c.interview_id=r.interview_id
    LEFT JOIN prep_task_sessions s ON s.plan_item_id=p.id
    ${where}`
}

function taskRow(planItemId: number): PrepTaskRow {
  if (!Number.isInteger(planItemId) || planItemId <= 0) throw new PrepAgentError('plan_item_id 非法')
  const row = db.prepare(taskSelect('WHERE p.id=?')).get(planItemId) as PrepTaskRow | undefined
  if (!row) throw new PrepAgentError('AI 准备任务不存在或对应清单已删除', 404, 'not_found')
  return row
}

function evidenceRefs(row: PrepTaskRow): string[] {
  const snapshots = parseJson<Array<{ ref?: unknown }>>(row.evidence_json, [])
  return snapshots.map(item => clipped(item?.ref, 60)).filter(Boolean)
}

function generationState(row: PrepTaskRow): Record<string, unknown> {
  const stored = row.generation_status ?? 'idle'
  const status = stored === 'idle' && row.guide_json ? 'completed' : stored
  return {
    status,
    stage: row.generation_stage ?? null,
    progress: Number(row.generation_progress ?? (row.guide_json ? 100 : 0)),
    error: row.generation_error ?? null,
    started_at: row.generation_started_at ?? null,
    model_calls: Number(row.generation_model_calls ?? 0),
    prompt_tokens: Number(row.generation_prompt_tokens ?? 0),
    completion_tokens: Number(row.generation_completion_tokens ?? 0),
    total_tokens: Number(row.generation_total_tokens ?? 0)
  }
}

function serializedTask(row: PrepTaskRow): Record<string, unknown> {
  return {
    id: row.id,
    run_id: row.run_id,
    checklist_id: row.checklist_id,
    application_id: row.application_id,
    interview_id: row.interview_id,
    title: row.title,
    category: row.category,
    priority: row.priority,
    estimated_minutes: row.estimated_minutes,
    reason: row.reason,
    success_criteria: row.success_criteria,
    evidence_refs: evidenceRefs(row),
    sort: row.sort,
    checklist_content: row.checklist_content,
    done: row.done,
    guide_ready: Boolean(row.guide_json),
    guide_version: Number(row.guide_version ?? (row.guide_json ? 1 : 0)),
    guide_generated_at: row.guide_generated_at ?? null,
    message_count: Number(row.message_count ?? 0),
    progress: parseJson<PrepTaskProgress>(row.progress_json, { steps: [], checks: [] }),
    generation: generationState(row)
  }
}

export function listPrepExecutionTasks(interviewId: number): Record<string, unknown>[] {
  if (!Number.isInteger(interviewId) || interviewId <= 0) throw new PrepAgentError('interview_id 非法')
  const rows = db.prepare(taskSelect('WHERE r.interview_id=? ORDER BY c.sort, p.sort')).all(interviewId) as PrepTaskRow[]
  return rows.map(serializedTask)
}

function ensureSession(row: PrepTaskRow): number {
  if (row.session_id) return Number(row.session_id)
  const timestamp = now()
  db.prepare(`INSERT INTO prep_task_sessions(plan_item_id,created_at,updated_at)
    VALUES (?,?,?) ON CONFLICT(plan_item_id) DO NOTHING`).run(row.id, timestamp, timestamp)
  const session = db.prepare('SELECT id FROM prep_task_sessions WHERE plan_item_id=?').get(row.id) as { id: number }
  return Number(session.id)
}

function freshKnowledge(row: PrepTaskRow): Array<Record<string, unknown>> {
  const merged = new Map<number, RetrievedKnowledge>()
  const queries = [row.title, row.success_criteria]
    .map(value => clipped(value, 200))
    .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
  for (const query of queries) {
    const result = searchKnowledge(query, { limit: 6 })
    for (const item of result.items) {
      const current = merged.get(item.id)
      if (!current || item.score > current.score) merged.set(item.id, item)
    }
  }
  return Array.from(merged.values())
    .sort((left, right) => right.score - left.score || left.id - right.id)
    .slice(0, 10)
    .map((item, index) => ({
      ref: `K${index + 1}`,
      type: 'knowledge_item',
      item_id: item.id,
      source_id: item.sourceId,
      title: item.question,
      excerpt: clipped(item.answer, 2400),
      category: item.category,
      mastery: item.mastery,
      company: item.company,
      position: item.position,
      round: item.round,
      score: item.score
    }))
}

function buildTaskContext(row: PrepTaskRow): Record<string, unknown> {
  const context = buildPrepAgentContext(row.run_id)
  const sources = new Map<string, Record<string, unknown>>()
  const add = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const item = value as Record<string, unknown>
    const ref = clipped(item.ref, 60)
    if (ref) sources.set(ref, item)
  }
  add(context.application)
  add(context.interview)
  context.reviews.forEach(add)
  context.mastery.forEach(add)
  parseJson<Record<string, unknown>[]>(row.run_evidence_json, []).forEach(add)
  const snapshots = parseJson<Record<string, unknown>[]>(row.evidence_json, [])
  for (const snapshot of snapshots) {
    const ref = clipped(snapshot.ref, 60)
    if (ref && Object.keys(snapshot).length > 1) sources.set(ref, snapshot)
  }
  const selectedEvidence = evidenceRefs(row).map(ref => sources.get(ref) ?? { ref, unavailable: true })
  const retrieved = freshKnowledge(row)
  return {
    task: {
      id: row.id,
      title: row.title,
      category: row.category,
      priority: row.priority,
      estimated_minutes: row.estimated_minutes,
      reason: row.reason,
      success_criteria: row.success_criteria,
      evidence_refs: evidenceRefs(row)
    },
    plan_goal: row.goal,
    application: context.application,
    interview: context.interview,
    evidence: [...selectedEvidence, ...retrieved]
  }
}

function validContextRefs(context: Record<string, unknown>): Set<string> {
  const refs = new Set(['APP', 'IV'])
  const evidence = Array.isArray(context.evidence) ? context.evidence : []
  for (const value of evidence) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const ref = clipped((value as Record<string, unknown>).ref, 60)
      if (ref) refs.add(ref)
    }
  }
  return refs
}

function guideFromRow(row: PrepTaskRow): PrepTaskGuide | null {
  if (!row.guide_json) return null
  try { return normalizeStoredPrepTaskGuide(JSON.parse(row.guide_json)) } catch { return null }
}

function sessionEvidence(row: PrepTaskRow): Record<string, unknown>[] {
  const merged = new Map<string, Record<string, unknown>>()
  for (const item of [
    ...parseJson<Record<string, unknown>[]>(row.run_evidence_json, []),
    ...parseJson<Record<string, unknown>[]>(row.evidence_json, [])
  ]) {
    const ref = clipped(item.ref, 60)
    if (ref) merged.set(ref, item)
  }
  return evidenceRefs(row).map(ref => merged.get(ref) ?? { ref, unavailable: true })
}

function recoverInterruptedGeneration(row: PrepTaskRow): PrepTaskRow {
  if (row.session_id && row.generation_status === 'running' && !activeGenerations.has(row.id)) {
    db.prepare(`UPDATE prep_task_sessions SET generation_status='failed', generation_stage='interrupted',
      generation_error=?, updated_at=? WHERE id=?`).run(
      '服务在生成过程中重新启动，请点击重试；已有旧指引没有被覆盖。', now(), row.session_id
    )
    return taskRow(row.id)
  }
  return row
}

export function getPrepTaskSession(planItemId: number): Record<string, unknown> {
  let row = taskRow(planItemId)
  ensureSession(row)
  row = recoverInterruptedGeneration(taskRow(planItemId))
  const messages = db.prepare(`SELECT id, role, content, request_id, created_at
    FROM prep_task_messages WHERE session_id=? ORDER BY id DESC LIMIT 100`).all(row.session_id) as Array<Record<string, unknown>>
  return {
    task: serializedTask(row),
    guide: guideFromRow(row),
    progress: parseJson<PrepTaskProgress>(row.progress_json, { steps: [], checks: [] }),
    evidence: sessionEvidence(row),
    messages: messages.reverse(),
    generation: generationState(row)
  }
}

function validateEvidenceRefs(refs: string[], validRefs: Set<string>, name: string): void {
  for (const ref of refs) if (!validRefs.has(ref)) throw new Error(`${name} 包含无效引用 ${ref}`)
}

function validateBlueprintEvidence(blueprint: PrepTaskBlueprint, validRefs: Set<string>): PrepTaskBlueprint {
  blueprint.modules.forEach((module, index) => validateEvidenceRefs(module.evidence_refs, validRefs, `modules[${index}].evidence_refs`))
  return blueprint
}

function validateModuleEvidence(module: PrepLearningModule, validRefs: Set<string>): PrepLearningModule {
  validateEvidenceRefs(module.evidence_refs, validRefs, `${module.id}.evidence_refs`)
  module.sections.forEach((section, index) => validateEvidenceRefs(
    section.evidence_refs, validRefs, `${module.id}.sections[${index}].evidence_refs`
  ))
  return module
}

function emptyMetrics(): GenerationMetrics {
  return { modelCalls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, model: null }
}

function recordCompletion(metrics: GenerationMetrics, completion: AiCompletionResult): void {
  metrics.modelCalls++
  metrics.promptTokens += Number(completion.usage?.promptTokens ?? 0)
  metrics.completionTokens += Number(completion.usage?.completionTokens ?? 0)
  metrics.totalTokens += Number(completion.usage?.totalTokens ?? 0)
  metrics.model = completion.model
}

function updateGeneration(sessionId: number, stage: string, progress: number, metrics: GenerationMetrics): void {
  db.prepare(`UPDATE prep_task_sessions SET generation_stage=?, generation_progress=?,
    generation_model_calls=?, generation_prompt_tokens=?, generation_completion_tokens=?,
    generation_total_tokens=?, updated_at=? WHERE id=?`).run(
    stage, Math.max(0, Math.min(99, Math.round(progress))), metrics.modelCalls,
    metrics.promptTokens, metrics.completionTokens, metrics.totalTokens, now(), sessionId
  )
}

async function structuredStage<T>(input: Record<string, unknown>, options: {
  prompt: string
  schemaName: string
  schema: Record<string, unknown>
  validate: (value: unknown) => T
  metrics: GenerationMetrics
}): Promise<T> {
  const serialized = JSON.stringify(input)
  if (serialized.length > 160_000) throw new PrepAgentError('准备任务上下文过长，请精简 JD 或知识资料')
  const result = await completeStructured([
    {
      role: 'system',
      content: `${loadPrompt(options.prompt)}\n\nJSON Schema:\n${JSON.stringify(options.schema)}`
    },
    { role: 'user', content: `<untrusted_task_context_json>\n${serialized}\n</untrusted_task_context_json>` }
  ], {
    task: 'interviewPrepAgent',
    schemaName: options.schemaName,
    schema: options.schema,
    validate: options.validate,
    maxOutputTokens: 8192,
    timeoutMs: 180_000
  })
  recordCompletion(options.metrics, result.completion)
  return result.value
}

async function generateModule(
  context: Record<string, unknown>, blueprint: PrepTaskBlueprint,
  descriptor: PrepTaskBlueprintModule, validRefs: Set<string>, metrics: GenerationMetrics,
  criticFeedback: PrepTaskCriticResult['issues'] = []
): Promise<PrepLearningModule> {
  return structuredStage({
    task_context: context,
    course_overview: blueprint.overview,
    course_objectives: blueprint.objectives,
    module: descriptor,
    critic_feedback: criticFeedback
  }, {
    prompt: 'prep-task-module.system.md',
    schemaName: 'prep_task_learning_module_v2',
    schema: PREP_LEARNING_MODULE_SCHEMA as unknown as Record<string, unknown>,
    validate(value) {
      return validateModuleEvidence(validatePrepLearningModule(value, descriptor), validRefs)
    },
    metrics
  })
}

async function generatePractice(
  context: Record<string, unknown>, blueprint: PrepTaskBlueprint, modules: PrepLearningModule[],
  metrics: GenerationMetrics, criticFeedback: PrepTaskCriticResult['issues'] = []
): Promise<PrepTaskPracticeSet> {
  const moduleIds = new Set(modules.map(module => module.id))
  return structuredStage({
    task: context.task,
    overview: blueprint.overview,
    objectives: blueprint.objectives,
    coverage_map: blueprint.coverage_map,
    modules,
    critic_feedback: criticFeedback
  }, {
    prompt: 'prep-task-practice.system.md',
    schemaName: 'prep_task_practice_v2',
    schema: PREP_TASK_PRACTICE_SCHEMA as unknown as Record<string, unknown>,
    validate: value => validatePrepTaskPracticeSet(value, moduleIds),
    metrics
  })
}

function guideDraft(
  blueprint: PrepTaskBlueprint, modules: PrepLearningModule[], practice: PrepTaskPracticeSet,
  quality: PrepTaskGuide['quality_review']
): PrepTaskGuide {
  return validatePrepTaskGuide({
    version: 2,
    ...blueprint,
    modules,
    practice_set: practice.items,
    completion_checklist: practice.completion_checklist,
    quality_review: quality
  })
}

async function criticGuide(guide: PrepTaskGuide, metrics: GenerationMetrics): Promise<PrepTaskCriticResult> {
  return structuredStage({ guide }, {
    prompt: 'prep-task-critic.system.md',
    schemaName: 'prep_task_course_critic_v2',
    schema: PREP_TASK_CRITIC_SCHEMA as unknown as Record<string, unknown>,
    validate: validatePrepTaskCritic,
    metrics
  })
}

async function runGuideGeneration(planItemId: number, sessionId: number, force: boolean): Promise<void> {
  const metrics = emptyMetrics()
  try {
    const row = taskRow(planItemId)
    const context = buildTaskContext(row)
    const validRefs = validContextRefs(context)
    updateGeneration(sessionId, 'blueprint', 5, metrics)
    const blueprint = await structuredStage({ task_context: context }, {
      prompt: 'prep-task-blueprint.system.md',
      schemaName: 'prep_task_blueprint_v2',
      schema: PREP_TASK_BLUEPRINT_SCHEMA as unknown as Record<string, unknown>,
      validate: value => validateBlueprintEvidence(validatePrepTaskBlueprint(value), validRefs),
      metrics
    })

    updateGeneration(sessionId, 'modules', 15, metrics)
    const modules: PrepLearningModule[] = []
    for (let index = 0; index < blueprint.modules.length; index += 2) {
      const batch = blueprint.modules.slice(index, index + 2)
      modules.push(...await Promise.all(batch.map(module => generateModule(
        context, blueprint, module, validRefs, metrics
      ))))
      updateGeneration(sessionId, 'modules', 15 + 50 * Math.min(1, modules.length / blueprint.modules.length), metrics)
    }

    updateGeneration(sessionId, 'practice', 68, metrics)
    let practice = await generatePractice(context, blueprint, modules, metrics)
    let draft = guideDraft(blueprint, modules, practice, { verdict: 'pass', repaired: false, issues: [] })

    updateGeneration(sessionId, 'review', 82, metrics)
    let critic = await criticGuide(draft, metrics)
    let repaired = false
    if (critic.verdict === 'revise') {
      updateGeneration(sessionId, 'repair', 88, metrics)
      const repairableModules = Array.from(new Set(critic.issues
        .filter(issue => issue.target === 'module' && issue.module_id)
        .map(issue => String(issue.module_id))))
        .filter(id => blueprint.modules.some(module => module.id === id))
        .slice(0, 2)
      for (const moduleId of repairableModules) {
        const moduleIndex = modules.findIndex(module => module.id === moduleId)
        const descriptor = blueprint.modules.find(module => module.id === moduleId)
        if (moduleIndex >= 0 && descriptor) {
          modules[moduleIndex] = await generateModule(
            context, blueprint, descriptor, validRefs, metrics,
            critic.issues.filter(issue => issue.module_id === moduleId)
          )
          repaired = true
        }
      }
      const practiceIssues = critic.issues.filter(issue => issue.target === 'practice' || issue.target === 'guide')
      if (practiceIssues.length) {
        practice = await generatePractice(context, blueprint, modules, metrics, practiceIssues)
        repaired = true
      }
      draft = guideDraft(blueprint, modules, practice, { verdict: 'pass', repaired, issues: [] })
      critic = await criticGuide(draft, metrics)
    }

    const guide = guideDraft(blueprint, modules, practice, {
      verdict: critic.verdict === 'pass' ? 'pass' : 'warn',
      repaired,
      issues: critic.issues
    })
    updateGeneration(sessionId, 'finalizing', 98, metrics)
    const timestamp = now()
    db.transaction(() => {
      db.prepare(`UPDATE prep_task_sessions SET guide_json=?, guide_version=2,
        progress_json='{"steps":[],"checks":[]}', guide_model=?, guide_generated_at=?,
        generation_status='completed', generation_stage='completed', generation_progress=100,
        generation_error=NULL, generation_model_calls=?, generation_prompt_tokens=?,
        generation_completion_tokens=?, generation_total_tokens=?, quality_json=?, updated_at=?
        WHERE id=?`).run(
        JSON.stringify(guide), metrics.model, timestamp, metrics.modelCalls, metrics.promptTokens,
        metrics.completionTokens, metrics.totalTokens, JSON.stringify(guide.quality_review), timestamp, sessionId
      )
      if (force) db.prepare('DELETE FROM prep_task_messages WHERE session_id=?').run(sessionId)
    })()
  } catch (error) {
    const message = clipped((error as Error).message, 500) || '执行指引生成失败'
    db.prepare(`UPDATE prep_task_sessions SET generation_status='failed', generation_stage='failed',
      generation_error=?, generation_model_calls=?, generation_prompt_tokens=?,
      generation_completion_tokens=?, generation_total_tokens=?, updated_at=? WHERE id=?`).run(
      message, metrics.modelCalls, metrics.promptTokens, metrics.completionTokens,
      metrics.totalTokens, now(), sessionId
    )
  }
}

export function generatePrepTaskGuide(planItemId: number, force = false): Record<string, unknown> {
  let row = taskRow(planItemId)
  const sessionId = ensureSession(row)
  row = recoverInterruptedGeneration(taskRow(planItemId))
  if (activeGenerations.has(planItemId) || row.generation_status === 'running') return getPrepTaskSession(planItemId)
  if (row.guide_json && !force) return getPrepTaskSession(planItemId)
  const timestamp = now()
  db.prepare(`UPDATE prep_task_sessions SET generation_status='running', generation_stage='queued',
    generation_progress=1, generation_error=NULL, generation_started_at=?,
    generation_model_calls=0, generation_prompt_tokens=0, generation_completion_tokens=0,
    generation_total_tokens=0, updated_at=? WHERE id=?`).run(timestamp, timestamp, sessionId)
  const running = runGuideGeneration(planItemId, sessionId, force)
    .finally(() => { activeGenerations.delete(planItemId) })
  activeGenerations.set(planItemId, running)
  return getPrepTaskSession(planItemId)
}

function normalizedIndexes(value: unknown, max: number, name: string): number[] {
  if (!Array.isArray(value)) throw new PrepAgentError(`${name} 必须是数组`)
  const result = [...new Set(value.map(Number))]
  if (result.some(index => !Number.isInteger(index) || index < 0 || index >= max)) {
    throw new PrepAgentError(`${name} 包含无效序号`)
  }
  return result.sort((left, right) => left - right)
}

export function updatePrepTaskProgress(planItemId: number, body: unknown): Record<string, unknown> {
  let row = taskRow(planItemId)
  const sessionId = ensureSession(row)
  row = taskRow(planItemId)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PrepAgentError('请求格式不正确')
  const raw = body as Record<string, unknown>
  const guide = guideFromRow(row)
  if (!guide) throw new PrepAgentError('请先生成执行指引', 409, 'guide_required')
  const current = parseJson<PrepTaskProgress>(row.progress_json, { steps: [], checks: [] })
  const progress: PrepTaskProgress = {
    steps: raw.steps === undefined ? current.steps : normalizedIndexes(raw.steps, guide.modules.length, 'steps'),
    checks: raw.checks === undefined ? current.checks : normalizedIndexes(raw.checks, guide.completion_checklist.length, 'checks')
  }
  const done = raw.done === undefined ? undefined : Boolean(raw.done)
  db.transaction(() => {
    db.prepare('UPDATE prep_task_sessions SET progress_json=?, updated_at=? WHERE id=?')
      .run(JSON.stringify(progress), now(), sessionId)
    if (done !== undefined) db.prepare('UPDATE checklist_items SET done=? WHERE id=?').run(done ? 1 : 0, row.checklist_id)
  })()
  return getPrepTaskSession(planItemId)
}

function boundedHistory(sessionId: number): ChatMessage[] {
  const rows = db.prepare(`SELECT role, content FROM prep_task_messages
    WHERE session_id=? ORDER BY id DESC LIMIT 20`).all(sessionId) as Array<{ role: 'user' | 'assistant'; content: string }>
  const selected: ChatMessage[] = []
  let budget = 24_000
  for (const row of rows) {
    const content = clipped(row.content, 5000)
    if (!content) continue
    if (content.length > budget) break
    selected.push({ role: row.role, content })
    budget -= content.length
  }
  return selected.reverse()
}

export async function chatWithPrepTask(planItemId: number, body: unknown): Promise<Record<string, unknown>> {
  let row = taskRow(planItemId)
  const sessionId = ensureSession(row)
  row = taskRow(planItemId)
  const guide = guideFromRow(row)
  if (!guide) throw new PrepAgentError('请先生成执行指引', 409, 'guide_required')
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PrepAgentError('请求格式不正确')
  const raw = body as Record<string, unknown>
  const content = clipped(raw.content, 5000)
  if (!content) throw new PrepAgentError('消息不能为空')
  const requestId = clipped(raw.request_id, 100)
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new PrepAgentError('request_id 非法')
  const existing = db.prepare(`SELECT id, content, created_at FROM prep_task_messages
    WHERE session_id=? AND request_id=? AND role='assistant'`).get(sessionId, requestId) as Record<string, unknown> | undefined
  if (existing) return { session_id: sessionId, request_id: requestId, message: { ...existing, role: 'assistant' } }

  const context = buildTaskContext(row)
  const executionContext = JSON.stringify({ ...context, guide })
  if (executionContext.length > 160_000) throw new PrepAgentError('准备任务上下文过长，请精简资料')
  const response = await completeChat([
    { role: 'system', content: loadPrompt('prep-task-coach.system.md') },
    { role: 'user', content: `<untrusted_task_context_json>\n${executionContext}\n</untrusted_task_context_json>` },
    ...boundedHistory(sessionId),
    { role: 'user', content }
  ], { task: 'interviewPrepAgent' })

  const timestamp = now()
  const assistantId = db.transaction(() => {
    db.prepare(`INSERT INTO prep_task_messages(session_id,role,content,request_id,created_at)
      VALUES (?,'user',?,?,?)`).run(sessionId, content, requestId, timestamp)
    const result = db.prepare(`INSERT INTO prep_task_messages(session_id,role,content,request_id,created_at)
      VALUES (?,'assistant',?,?,?)`).run(sessionId, response.content, requestId, timestamp)
    db.prepare('UPDATE prep_task_sessions SET updated_at=? WHERE id=?').run(timestamp, sessionId)
    return Number(result.lastInsertRowid)
  })()
  return {
    session_id: sessionId,
    request_id: requestId,
    message: { id: assistantId, role: 'assistant', content: response.content, request_id: requestId, created_at: timestamp }
  }
}
