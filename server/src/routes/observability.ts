import { Router } from 'express'
import { db } from '../db.js'
import { listAppLogs, listOperationRuns, operationRunDetail } from '../observability.js'

export const observabilityRouter = Router()

function positive(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(1, Math.floor(parsed))) : fallback
}

observabilityRouter.get('/observability/runs', (req, res) => {
  res.json(listOperationRuns(positive(req.query.limit, 50, 200)))
})

observabilityRouter.get('/observability/runs/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) { res.status(422).json({ message: '运行记录编号无效' }); return }
  const result = operationRunDetail(id)
  if (!result) { res.status(404).json({ message: '运行记录不存在' }); return }
  res.json(result)
})

observabilityRouter.get('/observability/logs', (req, res) => {
  res.json(listAppLogs({
    limit: positive(req.query.limit, 100, 200),
    level: typeof req.query.level === 'string' ? req.query.level : undefined,
    traceId: typeof req.query.trace_id === 'string' ? req.query.trace_id : undefined,
    source: typeof req.query.source === 'string' ? req.query.source : undefined
  }))
})

observabilityRouter.delete('/observability/logs', (req, res) => {
  const scope = req.query.scope
  if (scope === 'all') db.prepare('DELETE FROM app_logs').run()
  else if (scope === 'info') db.prepare("DELETE FROM app_logs WHERE level IN ('debug','info')").run()
  else { res.status(422).json({ message: '仅支持 scope=info 或 scope=all' }); return }
  res.json({ ok: true })
})
