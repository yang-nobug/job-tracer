import { Router } from 'express'
import {
  ProjectArchiveError, createProjectProfile, deleteProjectProfile, projectDetail, projectList,
  scanProject, searchProjectCode, updateProjectFact, updateProjectProfile
} from '../project-code-archive.js'

export const projectsRouter = Router()

function projectId(value: unknown): number {
  const id = Number(value)
  if (!Number.isInteger(id) || id <= 0) throw new ProjectArchiveError('项目档案编号无效', 'PROJECT_ID_INVALID')
  return id
}
function sendError(res: import('express').Response, error: unknown): void {
  if (error instanceof ProjectArchiveError) { res.status(error.status).json({ message: error.message, code: error.code }); return }
  throw error
}

projectsRouter.get('/projects', (_req, res) => { res.json(projectList()) })
projectsRouter.post('/projects', (req, res) => {
  try { res.status(201).json(createProjectProfile({ sourcePath: req.body?.source_path, name: req.body?.name, description: req.body?.description, scanScopes: req.body?.scan_scopes })) }
  catch (error) { sendError(res, error) }
})
projectsRouter.patch('/projects/:id', (req, res) => {
  try { res.json(updateProjectProfile(projectId(req.params.id), { name: req.body?.name, description: req.body?.description, scanScopes: req.body?.scan_scopes })) }
  catch (error) { sendError(res, error) }
})
projectsRouter.get('/projects/:id', (req, res) => {
  try { const result = projectDetail(projectId(req.params.id)); if (!result) { res.status(404).json({ message: '项目档案不存在' }); return }; res.json(result) }
  catch (error) { sendError(res, error) }
})
projectsRouter.post('/projects/:id/scan', (req, res) => {
  try { res.json(scanProject(projectId(req.params.id))) }
  catch (error) { sendError(res, error) }
})
projectsRouter.get('/projects/:id/search', (req, res) => {
  try { res.json(searchProjectCode(projectId(req.params.id), typeof req.query.q === 'string' ? req.query.q : '')) }
  catch (error) { sendError(res, error) }
})
projectsRouter.post('/projects/:id/facts', (req, res) => {
  try { res.status(201).json(updateProjectFact(projectId(req.params.id), { factType: req.body?.fact_type, title: req.body?.title, content: req.body?.content, evidenceChunkIds: req.body?.evidence_chunk_ids })) }
  catch (error) { sendError(res, error) }
})
projectsRouter.delete('/projects/:id', (req, res) => {
  try { if (!deleteProjectProfile(projectId(req.params.id))) { res.status(404).json({ message: '项目档案不存在' }); return }; res.json({ ok: true }) }
  catch (error) { sendError(res, error) }
})
