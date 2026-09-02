import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { AiError, completeStructured, isAiTaskEnabled, resolveAiTask } from '../ai.js'
import { loadPrompt } from '../prompt-loader.js'
import {
  PREP_MODEL_CONTRACTS, type PrepModelKind
} from '../prep-agent-contracts.js'
import {
  PrepAgentError, buildPrepAgentContext, cancelPrepAgentRun, createPrepAgentRun,
  finishPrepAgentStep, getPrepAgentRunRow, insertPrepAgentStep, listPrepAgentRuns,
  parsePrepAgentConstraints, persistPrepAgentPlan, prepAgentInternalToken, recoverablePrepAgentRuns,
  searchPrepAgentEvidence, serializePrepAgentRun, updatePrepAgentRun, validatePrepAgentCreate,
  validatePrepAgentPlanForRun
} from '../prep-agent-service.js'
import {
  cancelPrepAgentRuntimeRun, resumePrepAgentRun, startPrepAgentRun
} from '../prep-agent-runtime.js'

export const prepAgentRouter = Router()

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next) }
}

function parseId(value: unknown, name: string): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new PrepAgentError(`${name} 非法`)
  return id
}

prepAgentRouter.post('/prep-agent/runs', asyncRoute(async (req, res) => {
  if (!isAiTaskEnabled('interviewPrepAgent')) throw new PrepAgentError('面试准备 Agent 已停用', 422, 'task_disabled')
  if (!resolveAiTask('interviewPrepAgent')) throw new PrepAgentError('请先配置可用的大模型，再生成面试准备计划', 422, 'not_configured')
  const input = validatePrepAgentCreate(req.body)
  const run = createPrepAgentRun(input)
  if (run.status === 'pending') {
    try {
      await startPrepAgentRun(run.id)
    } catch (error) {
      updatePrepAgentRun(run.id, {
        status: 'failed', error_type: 'agent_unavailable', error_message: (error as Error).message
      })
      throw new PrepAgentError((error as Error).message, 503, 'agent_unavailable')
    }
  }
  res.status(202).json(serializePrepAgentRun(run.id))
}))

prepAgentRouter.get('/prep-agent/runs/:id', (req, res) => {
  res.json(serializePrepAgentRun(String(req.params.id)))
})

prepAgentRouter.get('/prep-agent/interviews/:id/runs', (req, res) => {
  const interviewId = parseId(req.params.id, 'interview_id')
  const limit = Number.isFinite(Number(req.query.limit)) ? Number(req.query.limit) : 10
  res.json(listPrepAgentRuns(interviewId, limit))
})

prepAgentRouter.post('/prep-agent/runs/:id/resume', asyncRoute(async (req, res) => {
  const runId = String(req.params.id)
  const run = getPrepAgentRunRow(runId)
  if (run.status !== 'waiting_review') throw new PrepAgentError('当前运行不在等待确认状态', 409, 'run_state')
  const action = req.body?.action
  if (!['approve', 'edit', 'revise', 'cancel'].includes(action)) throw new PrepAgentError('action 非法')
  const decision: Record<string, unknown> = { action }
  if (action === 'edit') decision.edited_plan = validatePrepAgentPlanForRun(runId, req.body?.edited_plan)
  if (action === 'revise') {
    const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback.trim().slice(0, 1000) : ''
    if (!feedback) throw new PrepAgentError('请填写重新生成的修改要求')
    decision.feedback = feedback
  }
  if (action === 'cancel') {
    cancelPrepAgentRun(runId)
    await cancelPrepAgentRuntimeRun(runId)
  } else {
    await resumePrepAgentRun(runId, decision)
  }
  res.status(202).json(serializePrepAgentRun(runId))
}))

prepAgentRouter.post('/prep-agent/runs/:id/cancel', asyncRoute(async (req, res) => {
  const runId = String(req.params.id)
  cancelPrepAgentRun(runId)
  await cancelPrepAgentRuntimeRun(runId)
  res.json(serializePrepAgentRun(runId))
}))

prepAgentRouter.get('/prep-agent/runs/:id/events', (req, res) => {
  const runId = String(req.params.id)
  getPrepAgentRunRow(runId)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  let last = ''
  let closed = false
  const send = () => {
    if (closed) return
    try {
      const payload = serializePrepAgentRun(runId)
      const serialized = JSON.stringify(payload)
      if (serialized !== last) {
        res.write(`event: run\ndata: ${serialized}\n\n`)
        last = serialized
      } else {
        res.write(': keepalive\n\n')
      }
      const status = payload.status
      if (status === 'completed' || status === 'failed' || status === 'cancelled') {
        clearInterval(timer)
        setTimeout(() => { if (!closed) res.end() }, 200)
      }
    } catch {
      clearInterval(timer)
      res.end()
    }
  }
  const timer = setInterval(send, 1000)
  req.on('close', () => { closed = true; clearInterval(timer) })
  send()
})

function internalOnly(req: Request, res: Response, next: NextFunction): void {
  const address = req.socket.remoteAddress ?? ''
  const local = address === '127.0.0.1' || address === '::1' || address.endsWith(':127.0.0.1')
  if (!local || req.get('x-prep-agent-token') !== prepAgentInternalToken()) {
    res.status(403).json({ message: '禁止访问 Agent 内部接口' })
    return
  }
  next()
}

prepAgentRouter.use('/internal/prep-agent', internalOnly)

prepAgentRouter.get('/internal/prep-agent/runs/recoverable', (_req, res) => {
  res.json(recoverablePrepAgentRuns())
})

prepAgentRouter.get('/internal/prep-agent/runs/:id/input', (req, res) => {
  const run = getPrepAgentRunRow(String(req.params.id))
  res.json({
    run_id: run.id,
    thread_id: run.thread_id,
    request_id: run.request_id,
    application_id: run.application_id,
    interview_id: run.interview_id,
    goal: run.goal,
    constraints: parsePrepAgentConstraints(run.constraints_json),
    status: run.status
  })
})

prepAgentRouter.get('/internal/prep-agent/runs/:id/context', (req, res) => {
  res.json(buildPrepAgentContext(String(req.params.id)))
})

prepAgentRouter.post('/internal/prep-agent/search', (req, res) => {
  res.json({ evidence: searchPrepAgentEvidence(req.body?.queries) })
})

prepAgentRouter.post('/internal/prep-agent/model', asyncRoute(async (req, res) => {
  const kind = req.body?.kind as PrepModelKind
  if (!(kind in PREP_MODEL_CONTRACTS)) throw new PrepAgentError('未知模型节点')
  const contract = PREP_MODEL_CONTRACTS[kind]
  const input = req.body?.input
  const serialized = JSON.stringify(input ?? {})
  if (serialized.length > 160_000) throw new PrepAgentError('模型节点输入过长')
  const validate = contract.validate as (value: unknown) => unknown
  const result = await completeStructured([
    {
      role: 'system',
      content: `${loadPrompt(contract.prompt)}\n\nJSON Schema:\n${JSON.stringify(contract.schema)}`
    },
    {
      role: 'user',
      content: `<untrusted_context_json>\n${serialized}\n</untrusted_context_json>`
    }
  ], {
    task: 'interviewPrepAgent',
    schemaName: contract.schemaName,
    schema: contract.schema,
    validate
  })
  res.json({
    value: result.value,
    attempts: result.attempts,
    model: result.completion.model,
    usage: result.completion.usage,
    duration_ms: result.completion.durationMs
  })
}))

prepAgentRouter.post('/internal/prep-agent/runs/:id/steps', (req, res) => {
  const id = insertPrepAgentStep(String(req.params.id), req.body)
  res.status(201).json({ id })
})

prepAgentRouter.patch('/internal/prep-agent/runs/:id/steps/:stepId', (req, res) => {
  finishPrepAgentStep(String(req.params.id), parseId(req.params.stepId, 'step_id'), req.body)
  res.json({ ok: true })
})

prepAgentRouter.post('/internal/prep-agent/runs/:id/status', (req, res) => {
  updatePrepAgentRun(String(req.params.id), req.body)
  res.json({ ok: true })
})

prepAgentRouter.post('/internal/prep-agent/runs/:id/persist', (req, res) => {
  res.json(persistPrepAgentPlan(String(req.params.id), req.body?.plan))
})

prepAgentRouter.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error)
  const status = error instanceof PrepAgentError
    ? error.statusCode
    : error instanceof AiError
      ? error.statusCode
      : 500
  res.status(status).json({
    message: error.message || '面试准备 Agent 请求失败',
    error_type: error instanceof PrepAgentError ? error.kind : error instanceof AiError ? error.kind : 'unexpected'
  })
})
