import { Router } from 'express'
import type { NextFunction, Request, Response } from 'express'
import { AiError, isAiTaskEnabled, resolveAiTask } from '../ai.js'
import { PrepAgentError } from '../prep-agent-service.js'
import {
  chatWithPrepTask, generatePrepTaskGuide, getPrepTaskSession,
  listPrepExecutionTasks, updatePrepTaskProgress
} from '../prep-task-execution.js'

export const prepTasksRouter = Router()

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => { handler(req, res).catch(next) }
}

function parseId(value: unknown, name: string): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new PrepAgentError(`${name} 非法`)
  return id
}

function requireAgentModel(): void {
  if (!isAiTaskEnabled('interviewPrepAgent')) throw new PrepAgentError('面试准备 Agent 已停用', 422, 'task_disabled')
  if (!resolveAiTask('interviewPrepAgent')) throw new PrepAgentError('请先配置可用的大模型', 422, 'not_configured')
}

prepTasksRouter.get('/prep-agent/interviews/:id/tasks', (req, res) => {
  res.json(listPrepExecutionTasks(parseId(req.params.id, 'interview_id')))
})

prepTasksRouter.get('/prep-agent/plan-items/:id/session', (req, res) => {
  res.json(getPrepTaskSession(parseId(req.params.id, 'plan_item_id')))
})

prepTasksRouter.post('/prep-agent/plan-items/:id/guide', asyncRoute(async (req, res) => {
  requireAgentModel()
  const result = generatePrepTaskGuide(parseId(req.params.id, 'plan_item_id'), req.body?.force === true)
  res.status(202).json(result)
}))

prepTasksRouter.patch('/prep-agent/plan-items/:id/progress', (req, res) => {
  res.json(updatePrepTaskProgress(parseId(req.params.id, 'plan_item_id'), req.body))
})

prepTasksRouter.post('/prep-agent/plan-items/:id/messages', asyncRoute(async (req, res) => {
  requireAgentModel()
  res.json(await chatWithPrepTask(parseId(req.params.id, 'plan_item_id'), req.body))
}))

prepTasksRouter.use((error: Error, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error)
  const status = error instanceof PrepAgentError
    ? error.statusCode
    : error instanceof AiError
      ? error.statusCode
      : 500
  res.status(status).json({
    message: error.message || '准备任务执行请求失败',
    error_type: error instanceof PrepAgentError ? error.kind : error instanceof AiError ? error.kind : 'unexpected'
  })
})
