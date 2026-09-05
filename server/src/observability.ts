import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { db, now } from './db.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type OperationStatus = 'queued' | 'running' | 'succeeded' | 'partial_success' | 'failed' | 'cancelled'
export type StepStatus = 'running' | 'succeeded' | 'skipped' | 'failed'

export interface TraceContext {
  traceId: string
  operationRunId?: number
  operationStepId?: number
}

const storage = new AsyncLocalStorage<TraceContext>()
const MAX_CONTEXT_CHARS = 20_000
const SENSITIVE_KEY = /(?:authorization|credential|password|api[_-]?key|token|cookie|secret)/i

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]'
  if (Array.isArray(value)) return value.slice(0, 100).map(item => redact(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100).map(([key, item]) => [
      key, SENSITIVE_KEY.test(key) ? '[redacted]' : redact(item, depth + 1)
    ]))
  }
  if (typeof value === 'string') return value.length > 4_000 ? `${value.slice(0, 4_000)}…[truncated]` : value
  return value
}

function json(value: unknown): string | null {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(redact(value))
    return text.length > MAX_CONTEXT_CHARS ? `${text.slice(0, MAX_CONTEXT_CHARS)}…[truncated]` : text
  } catch { return JSON.stringify({ unavailable: true }) }
}

export function validTraceId(value: unknown): string | null {
  const traceId = typeof value === 'string' ? value.trim() : ''
  return /^[a-zA-Z0-9_-]{8,100}$/.test(traceId) ? traceId : null
}

export function newTraceId(prefix = 'tr'): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export function currentTrace(): TraceContext | null {
  return storage.getStore() ?? null
}

export function runWithTrace<T>(context: TraceContext, callback: () => T): T {
  return storage.run(context, callback)
}

export function createOperationRun(input: {
  operationType: string
  triggerType?: 'manual' | 'scheduled' | 'retry' | 'system'
  traceId?: string
  parentEntityType?: string
  parentEntityId?: string | number
  inputSummary?: unknown
  retryOfRunId?: number
}): { id: number; traceId: string } {
  const traceId = input.traceId ?? currentTrace()?.traceId ?? newTraceId()
  const result = db.prepare(`INSERT INTO operation_runs(
    trace_id,operation_type,trigger_type,status,parent_entity_type,parent_entity_id,input_summary_json,retry_of_run_id,started_at,created_at
  ) VALUES (?,?,?,'running',?,?,?,?,?,?)`).run(
    traceId, input.operationType, input.triggerType ?? 'manual', input.parentEntityType ?? null,
    input.parentEntityId == null ? null : String(input.parentEntityId), json(input.inputSummary), input.retryOfRunId ?? null, now(), now()
  )
  const id = Number(result.lastInsertRowid)
  logApp({ level: 'info', source: 'operation', eventName: 'operation.started', traceId, operationRunId: id,
    message: `开始执行 ${input.operationType}`, context: { trigger_type: input.triggerType ?? 'manual' } })
  return { id, traceId }
}

export function finishOperationRun(id: number, input: {
  status: Exclude<OperationStatus, 'queued' | 'running'>
  resultSummary?: unknown
  errorCode?: string
  errorMessage?: string
}): void {
  const started = db.prepare('SELECT trace_id,started_at FROM operation_runs WHERE id=?').get(id) as { trace_id: string; started_at: string } | undefined
  if (!started) return
  const durationMs = Math.max(0, Date.now() - Date.parse(started.started_at))
  db.prepare(`UPDATE operation_runs SET status=?,result_summary_json=?,error_code=?,error_message=?,finished_at=?,duration_ms=?
    WHERE id=? AND status IN ('queued','running')`).run(
    input.status, json(input.resultSummary), input.errorCode ?? null, input.errorMessage?.slice(0, 2_000) ?? null,
    now(), durationMs, id
  )
  logApp({ level: input.status === 'failed' ? 'error' : input.status === 'partial_success' ? 'warn' : 'info',
    source: 'operation', eventName: `operation.${input.status}`, traceId: started.trace_id, operationRunId: id,
    message: `任务 ${input.status}`, errorCode: input.errorCode, context: input.resultSummary })
}

export function startOperationStep(input: {
  operationRunId: number
  stepName: string
  parentStepId?: number
  sequence?: number
  inputSummary?: unknown
}): number {
  const result = db.prepare(`INSERT INTO operation_steps(
    operation_run_id,parent_step_id,step_name,sequence,status,input_summary_json,started_at,created_at
  ) VALUES (?,?,?,?, 'running',?,?,?)`).run(
    input.operationRunId, input.parentStepId ?? null, input.stepName, input.sequence ?? 0,
    json(input.inputSummary), now(), now()
  )
  return Number(result.lastInsertRowid)
}

export function finishOperationStep(id: number, input: {
  status: Exclude<StepStatus, 'running'>
  outputSummary?: unknown
  errorCode?: string
  errorMessage?: string
}): void {
  const started = db.prepare('SELECT started_at FROM operation_steps WHERE id=?').get(id) as { started_at: string } | undefined
  if (!started) return
  db.prepare(`UPDATE operation_steps SET status=?,output_summary_json=?,error_code=?,error_message=?,finished_at=?,duration_ms=?
    WHERE id=? AND status='running'`).run(
    input.status, json(input.outputSummary), input.errorCode ?? null, input.errorMessage?.slice(0, 2_000) ?? null,
    now(), Math.max(0, Date.now() - Date.parse(started.started_at)), id
  )
}

export function logApp(input: {
  level: LogLevel
  source: string
  eventName: string
  message: string
  traceId?: string
  operationRunId?: number
  operationStepId?: number
  entityType?: string
  entityId?: string | number
  errorCode?: string
  errorStack?: string
  context?: unknown
}): void {
  try {
    const active = currentTrace()
    db.prepare(`INSERT INTO app_logs(
      level,source,event_name,trace_id,operation_run_id,operation_step_id,entity_type,entity_id,message,context_json,error_code,error_stack,created_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      input.level, input.source.slice(0, 80), input.eventName.slice(0, 120), input.traceId ?? active?.traceId ?? null,
      input.operationRunId ?? active?.operationRunId ?? null, input.operationStepId ?? active?.operationStepId ?? null,
      input.entityType ?? null, input.entityId == null ? null : String(input.entityId), input.message.slice(0, 2_000),
      json(input.context), input.errorCode ?? null, process.env.NODE_ENV === 'development' ? input.errorStack?.slice(0, 8_000) ?? null : null, now()
    )
    db.prepare(`DELETE FROM app_logs WHERE id NOT IN (SELECT id FROM app_logs ORDER BY id DESC LIMIT 20000)
      AND level IN ('debug','info')`).run()
    db.prepare(`DELETE FROM app_logs WHERE id NOT IN (SELECT id FROM app_logs WHERE level IN ('warn','error') ORDER BY id DESC LIMIT 10000)
      AND level IN ('warn','error')`).run()
  } catch (error) {
    // 日志系统绝不能反过来影响业务路径。
    console.error('[observability] 日志写入失败:', (error as Error).message)
  }
}

export function listOperationRuns(limit = 50) {
  return db.prepare(`SELECT id,trace_id,operation_type,trigger_type,status,parent_entity_type,parent_entity_id,
    result_summary_json,error_code,error_message,started_at,finished_at,duration_ms
    FROM operation_runs ORDER BY id DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit)))
}

export function operationRunDetail(id: number) {
  const run = db.prepare('SELECT * FROM operation_runs WHERE id=?').get(id)
  if (!run) return null
  const steps = db.prepare('SELECT * FROM operation_steps WHERE operation_run_id=? ORDER BY id').all(id)
  const logs = db.prepare(`SELECT id,level,source,event_name,message,context_json,error_code,created_at
    FROM app_logs WHERE operation_run_id=? ORDER BY id DESC LIMIT 200`).all(id)
  const calls = db.prepare(`SELECT id,task,stage,attempt,model,status,error_type,error_message,duration_ms,created_at
    FROM ai_call_records WHERE operation_run_id=? ORDER BY id`).all(id)
  return { run, steps, logs, aiCalls: calls }
}

export function listAppLogs(input: { limit?: number; level?: string; traceId?: string; source?: string }) {
  const limit = Math.min(200, Math.max(1, input.limit ?? 100))
  const conditions: string[] = []
  const values: unknown[] = []
  if (input.level && ['debug', 'info', 'warn', 'error'].includes(input.level)) { conditions.push('level=?'); values.push(input.level) }
  if (input.traceId && validTraceId(input.traceId)) { conditions.push('trace_id=?'); values.push(input.traceId) }
  if (input.source) { conditions.push('source=?'); values.push(input.source.slice(0, 80)) }
  values.push(limit)
  return db.prepare(`SELECT id,level,source,event_name,trace_id,operation_run_id,operation_step_id,entity_type,entity_id,message,context_json,error_code,created_at
    FROM app_logs ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...values)
}
