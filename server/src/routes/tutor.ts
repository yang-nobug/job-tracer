import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now } from '../db.js'
import { loadArkConfig, tutorModel, setTutorModel } from '../ai.js'

// AI 助教：会话管理（列表/加载/重命名/删除）+ 助教专用模型切换
// 对话生成（含知识库上下文检索）在 knowledge-ai.ts 的 /ai/knowledge/tutor

export const tutorRouter = Router()

// 助教可用的模型列表与当前选择（只影响 AI 助教；其他 AI 功能用 config 默认模型）
tutorRouter.get('/model', (_req: Request, res: Response) => {
  const config = loadArkConfig()
  if (!config) {
    res.status(422).json({ message: 'AI 未配置：请在 config.json 填入 ark 段' })
    return
  }
  res.json({ models: config.models, active: tutorModel() })
})

tutorRouter.put('/model', (req: Request, res: Response) => {
  const model = (req.body?.model ?? '').trim()
  if (!model) {
    res.status(422).json({ message: 'model 不能为空' })
    return
  }
  if (!setTutorModel(model)) {
    res.status(422).json({ message: '该模型不在 config.json 的模型列表里' })
    return
  }
  res.json({ active: model })
})

// 会话列表（含消息数与最后活跃时间，按活跃倒序）
tutorRouter.get('/sessions', (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.title, s.created_at, s.updated_at,
              (SELECT COUNT(*) FROM tutor_messages WHERE session_id = s.id) AS message_count
       FROM tutor_sessions s
       ORDER BY s.updated_at DESC`
    )
    .all()
  res.json(rows)
})

// 单个会话：元信息 + 全部消息
tutorRouter.get('/sessions/:id', (req: Request, res: Response) => {
  const session = db.prepare('SELECT * FROM tutor_sessions WHERE id = ?').get(req.params.id)
  if (!session) {
    res.status(404).json({ message: '会话不存在' })
    return
  }
  const messages = db
    .prepare('SELECT id, role, content, created_at FROM tutor_messages WHERE session_id = ? ORDER BY id')
    .all(req.params.id)
  res.json({ session, messages })
})

// 重命名
tutorRouter.patch('/sessions/:id', (req: Request, res: Response) => {
  const title = (req.body?.title ?? '').trim().slice(0, 50)
  if (!title) {
    res.status(422).json({ message: '标题不能为空' })
    return
  }
  const result = db.prepare('UPDATE tutor_sessions SET title=?, updated_at=? WHERE id=?').run(title, now(), req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '会话不存在' })
    return
  }
  res.json(db.prepare('SELECT * FROM tutor_sessions WHERE id = ?').get(req.params.id))
})

// 删除（级联删消息）
tutorRouter.delete('/sessions/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM tutor_sessions WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '会话不存在' })
    return
  }
  res.json({ ok: true })
})
