import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now, today } from '../db.js'
import { createReviewFile, readReviewFile, writeReviewFile } from '../review-file.js'
import { STATUS_ORDER, STATUS_LABELS, type Status } from '../types.js'

export const interviewsRouter = Router()

// 面试轮次对应的状态（添加面试时自动推进）
const ROUND_TO_STATUS: Record<string, Status> = {
  一面: 'round1',
  二面: 'round2',
  三面: 'round3',
  HR面: 'hr'
}

// 添加面试：自动生成复盘 md + 写时间线事件
interviewsRouter.post('/applications/:id/interviews', (req: Request, res: Response) => {
  const app = db
    .prepare('SELECT * FROM applications WHERE id = ?')
    .get(req.params.id) as { id: number; company: string; status: Status } | undefined
  if (!app) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  const round = (req.body?.round ?? '').trim()
  const scheduledAt = (req.body?.scheduled_at ?? '').trim()
  if (!round) {
    res.status(422).json({ message: '轮次不能为空' })
    return
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(scheduledAt)) {
    res.status(422).json({ message: '时间格式应为 YYYY-MM-DD HH:mm' })
    return
  }
  const reviewFile = createReviewFile(app.company, round, scheduledAt)
  const result = db
    .prepare(
      `INSERT INTO interviews (application_id, round, scheduled_at, location, review_file, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(app.id, round, scheduledAt, req.body?.location?.trim() || null, reviewFile, now())

  db.prepare(
    `INSERT INTO events (application_id, type, event_date, content, created_at)
     VALUES (?, 'interview', ?, ?, ?)`
  ).run(app.id, today(), `添加面试：${round} ${scheduledAt}${req.body?.location ? ' @' + req.body.location : ''}`, now())

  // 添加面试时自动推进状态（只前进不后退；「其他」轮次不映射）
  const target = ROUND_TO_STATUS[round]
  if (target && STATUS_ORDER.indexOf(target) > STATUS_ORDER.indexOf(app.status)) {
    db.prepare('UPDATE applications SET status=?, updated_at=? WHERE id=?').run(target, now(), app.id)
    db.prepare(
      `INSERT INTO events (application_id, type, event_date, content, created_at)
       VALUES (?, 'status', ?, ?, ?)`
    ).run(app.id, today(), `状态：${STATUS_LABELS[app.status]} -> ${STATUS_LABELS[target]}`, now())
  }

  res.status(201).json(db.prepare('SELECT * FROM interviews WHERE id = ?').get(result.lastInsertRowid))
})

interviewsRouter.patch('/interviews/:id', (req: Request, res: Response) => {
  const iv = db.prepare('SELECT * FROM interviews WHERE id = ?').get(req.params.id) as
    | { id: number; round: string; scheduled_at: string; location: string | null; done: 0 | 1 }
    | undefined
  if (!iv) {
    res.status(404).json({ message: '面试不存在' })
    return
  }
  const round = req.body?.round?.trim() || iv.round
  const scheduledAt = req.body?.scheduled_at || iv.scheduled_at
  const location = req.body?.location !== undefined ? req.body.location?.trim() || null : iv.location
  const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : iv.done
  db.prepare('UPDATE interviews SET round=?, scheduled_at=?, location=?, done=? WHERE id=?').run(
    round, scheduledAt, location, done, iv.id
  )
  res.json(db.prepare('SELECT * FROM interviews WHERE id = ?').get(iv.id))
})

interviewsRouter.delete('/interviews/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM interviews WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '面试不存在' })
    return
  }
  res.json({ ok: true })
})

// 复盘 md 读写
interviewsRouter.get('/interviews/:id/review', (req: Request, res: Response) => {
  const iv = db.prepare('SELECT * FROM interviews WHERE id = ?').get(req.params.id) as
    | { review_file: string | null }
    | undefined
  if (!iv) {
    res.status(404).json({ message: '面试不存在' })
    return
  }
  if (!iv.review_file) {
    res.json({ content: '' })
    return
  }
  res.json({ content: readReviewFile(iv.review_file) })
})

interviewsRouter.put('/interviews/:id/review', (req: Request, res: Response) => {
  const iv = db.prepare('SELECT * FROM interviews WHERE id = ?').get(req.params.id) as
    | { id: number; review_file: string | null }
    | undefined
  if (!iv) {
    res.status(404).json({ message: '面试不存在' })
    return
  }
  const content = req.body?.content
  if (typeof content !== 'string') {
    res.status(422).json({ message: 'content 不能为空' })
    return
  }
  if (iv.review_file) {
    writeReviewFile(iv.review_file, content)
  }
  res.json({ ok: true })
})

// 复盘汇总（全部面试 + 投递信息，按面试时间倒序）
interviewsRouter.get('/reviews', (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT i.id, i.round, i.scheduled_at, i.done, i.review_file,
              a.id AS application_id, a.company, a.position
       FROM interviews i JOIN applications a ON i.application_id = a.id
       ORDER BY i.scheduled_at DESC`
    )
    .all()
  res.json(rows)
})

// 准备清单
interviewsRouter.post('/interviews/:id/checklist', (req: Request, res: Response) => {
  const iv = db.prepare('SELECT id FROM interviews WHERE id = ?').get(req.params.id)
  if (!iv) {
    res.status(404).json({ message: '面试不存在' })
    return
  }
  const content = (req.body?.content ?? '').trim()
  if (!content) {
    res.status(422).json({ message: '内容不能为空' })
    return
  }
  const maxSort = db
    .prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM checklist_items WHERE interview_id = ?')
    .get(req.params.id) as { m: number }
  const result = db
    .prepare('INSERT INTO checklist_items (interview_id, content, done, sort) VALUES (?, ?, 0, ?)')
    .run(req.params.id, content, maxSort.m + 1)
  res.status(201).json(db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(result.lastInsertRowid))
})

interviewsRouter.patch('/checklist/:id', (req: Request, res: Response) => {
  const item = db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(req.params.id) as
    | { id: number; content: string; done: 0 | 1 }
    | undefined
  if (!item) {
    res.status(404).json({ message: '清单项不存在' })
    return
  }
  const content = req.body?.content?.trim() || item.content
  const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : item.done
  db.prepare('UPDATE checklist_items SET content=?, done=? WHERE id=?').run(content, done, item.id)
  res.json(db.prepare('SELECT * FROM checklist_items WHERE id = ?').get(item.id))
})

interviewsRouter.delete('/checklist/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM checklist_items WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '清单项不存在' })
    return
  }
  res.json({ ok: true })
})
