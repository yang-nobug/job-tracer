import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now, today } from '../db.js'

export const eventsRouter = Router()

eventsRouter.post('/applications/:id/events', (req: Request, res: Response) => {
  const app = db.prepare('SELECT id FROM applications WHERE id = ?').get(req.params.id)
  if (!app) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  const content = (req.body?.content ?? '').trim()
  if (!content) {
    res.status(422).json({ message: '内容不能为空' })
    return
  }
  const type = ['note', 'status', 'interview', 'other'].includes(req.body?.type) ? req.body.type : 'note'
  const eventDate = req.body?.event_date || today()
  const result = db
    .prepare(
      `INSERT INTO events (application_id, type, event_date, content, created_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run(req.params.id, type, eventDate, content, now())
  res.status(201).json(db.prepare('SELECT * FROM events WHERE id = ?').get(result.lastInsertRowid))
})

eventsRouter.delete('/events/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '事件不存在' })
    return
  }
  res.json({ ok: true })
})
