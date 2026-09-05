import { Router } from 'express'
import {
  CodeReadingError, cancelCodeReadingSession, codeReadingSessionDetail, createCodeReadingSession, investigateCodeForCaller, listCodeReadingSessions, retryCodeReadingSession, runCodeReadingSession
} from '../code-reading-agent.js'
import { prepAgentInternalToken } from '../prep-agent-service.js'

export const codeReadingRouter = Router()

function projectId(value: unknown): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new CodeReadingError('项目档案编号无效', 'PROJECT_ID_INVALID')
  return id
}
function sessionId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new CodeReadingError('会话编号无效', 'SESSION_ID_INVALID')
  return id
}
function handle(res: import('express').Response, error: unknown): void {
  if (error instanceof CodeReadingError) { res.status(error.status).json({ message: error.message, code: error.code }); return }
  throw error
}

codeReadingRouter.get('/projects/:projectId/code-reading/sessions', (req, res) => {
  try { res.json(listCodeReadingSessions(projectId(req.params.projectId))) } catch (error) { handle(res, error) }
})
codeReadingRouter.post('/projects/:projectId/code-reading/sessions', (req, res) => {
  try {
    const session = createCodeReadingSession({ projectId: projectId(req.params.projectId), question: req.body?.question, outputMode: req.body?.output_mode })
    void runCodeReadingSession(String(session.id))
    res.status(202).json(session)
  } catch (error) { handle(res, error) }
})
codeReadingRouter.get('/code-reading/sessions/:id', (req, res) => {
  try { res.json(codeReadingSessionDetail(sessionId(req.params.id))) } catch (error) { handle(res, error) }
})
codeReadingRouter.post('/code-reading/sessions/:id/cancel', (req, res) => {
  try { res.json(cancelCodeReadingSession(sessionId(req.params.id))) } catch (error) { handle(res, error) }
})
codeReadingRouter.post('/code-reading/sessions/:id/retry', (req, res) => {
  try {
    const session = retryCodeReadingSession(sessionId(req.params.id))
    void runCodeReadingSession(String(session.id))
    res.status(202).json(session)
  } catch (error) { handle(res, error) }
})

codeReadingRouter.post('/internal/code-reading/investigate', async (req, res, next) => {
  const address = req.socket.remoteAddress ?? ''
  const local = address === '127.0.0.1' || address === '::1' || address.endsWith(':127.0.0.1')
  if (!local || req.get('x-prep-agent-token') !== prepAgentInternalToken()) { res.status(403).json({ message: '禁止访问代码调查内部接口' }); return }
  try {
    res.json(await investigateCodeForCaller({ projectIds: req.body?.project_ids, objective: req.body?.objective, questions: req.body?.questions, caller: 'interview_prep' }))
  } catch (error) {
    try { handle(res, error) } catch (unknown) { next(unknown) }
  }
})
