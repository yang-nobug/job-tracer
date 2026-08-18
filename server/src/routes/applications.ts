import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now, today } from '../db.js'
import { STATUS_LABELS, STATUS_ORDER, type Status } from '../types.js'

export const applicationsRouter = Router()

interface AppBody {
  company?: string
  position?: string
  status?: Status
  applied_at?: string | null
  channel?: string | null
  location?: string | null
  resume_id?: number | null
  jd_link?: string | null
  jd_text?: string | null
  contact_name?: string | null
  contact_info?: string | null
  notes?: string | null
}

function isStatus(s: unknown): s is Status {
  return typeof s === 'string' && (STATUS_ORDER as readonly string[]).includes(s)
}

function addStatusEvent(appId: number, from: Status, to: Status): void {
  db.prepare(
    `INSERT INTO events (application_id, type, event_date, content, created_at)
     VALUES (?, 'status', ?, ?, ?)`
  ).run(appId, today(), `状态：${STATUS_LABELS[from]} -> ${STATUS_LABELS[to]}`, now())
}

/** 校验并规范化请求体，返回错误消息或规范化的字段 */
function validate(body: AppBody): { error?: string; values?: Record<string, unknown> } {
  const company = (body.company ?? '').trim()
  const position = (body.position ?? '').trim()
  if (!company) return { error: '公司不能为空' }
  if (!position) return { error: '职位不能为空' }

  const status: Status = body.status != null && isStatus(body.status) ? body.status : 'unsent'

  // 标记"已投递"及之后的状态时，投递日期必填（缺省自动填今天）
  let applied_at: string | null = body.applied_at ? body.applied_at : null
  if (status !== 'unsent' && !applied_at) applied_at = today()

  return {
    values: {
      company,
      position,
      status,
      applied_at,
      channel: body.channel?.trim() || null,
      location: body.location?.trim() || null,
      resume_id: body.resume_id ?? null,
      jd_link: body.jd_link?.trim() || null,
      jd_text: body.jd_text || null,
      contact_name: body.contact_name?.trim() || null,
      contact_info: body.contact_info?.trim() || null,
      notes: body.notes || null
    }
  }
}

// 列表（支持筛选）
applicationsRouter.get('/', (req: Request, res: Response) => {
  const { status, channel, keyword, rejected, from, to } = req.query
  const where: string[] = []
  const params: Record<string, unknown> = {}

  if (status && isStatus(status)) {
    where.push('status = @status')
    params.status = status
  }
  if (channel) {
    where.push('channel = @channel')
    params.channel = channel
  }
  if (keyword) {
    where.push('(company LIKE @kw OR position LIKE @kw)')
    params.kw = `%${keyword}%`
  }
  if (rejected === 'true') where.push('rejected_at IS NOT NULL')
  if (rejected === 'false') where.push('rejected_at IS NULL')
  if (from) {
    where.push('applied_at >= @from')
    params.from = from
  }
  if (to) {
    where.push('applied_at <= @to')
    params.to = to
  }

  const sql = `SELECT *,
    (SELECT round FROM interviews WHERE application_id = applications.id
     ORDER BY scheduled_at DESC, id DESC LIMIT 1) AS last_round,
    (SELECT scheduled_at FROM interviews WHERE application_id = applications.id
     AND done = 0
     ORDER BY scheduled_at ASC, id DESC LIMIT 1) AS next_interview_at
    FROM applications ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updated_at DESC`
  res.json(db.prepare(sql).all(params))
})

// 详情
applicationsRouter.get('/:id', (req: Request, res: Response) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id)
  if (!app) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  const events = db
    .prepare('SELECT * FROM events WHERE application_id = ? ORDER BY event_date DESC, id DESC')
    .all(req.params.id)
  const interviews = db
    .prepare('SELECT * FROM interviews WHERE application_id = ? ORDER BY scheduled_at DESC')
    .all(req.params.id)
  for (const iv of interviews as { id: number }[]) {
    ;(iv as { checklist?: unknown[] }).checklist = db
      .prepare('SELECT * FROM checklist_items WHERE interview_id = ? ORDER BY sort, id')
      .all(iv.id)
  }
  const resumeId = (app as { resume_id: number | null }).resume_id
  const resume = resumeId
    ? db.prepare('SELECT * FROM resumes WHERE id = ?').get(resumeId) ?? null
    : null
  res.json({ ...app, events, interviews, resume })
})

// 新建
applicationsRouter.post('/', (req: Request, res: Response) => {
  const { error, values } = validate(req.body)
  if (error || !values) {
    res.status(422).json({ message: error })
    return
  }
  const result = db
    .prepare(
      `INSERT INTO applications (company, position, status, applied_at, channel, location, resume_id,
                                 jd_link, jd_text, contact_name, contact_info, notes, created_at, updated_at)
       VALUES (@company, @position, @status, @applied_at, @channel, @location, @resume_id,
               @jd_link, @jd_text, @contact_name, @contact_info, @notes, @ts, @ts)`
    )
    .run({ ...values, ts: now() })

  if (values.status !== 'unsent') {
    addStatusEvent(Number(result.lastInsertRowid), 'unsent', values.status as Status)
  }
  res.status(201).json(db.prepare('SELECT * FROM applications WHERE id = ?').get(result.lastInsertRowid))
})

// 更新
applicationsRouter.put('/:id', (req: Request, res: Response) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id) as
    | { id: number; status: Status }
    | undefined
  if (!app) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  const { error, values } = validate(req.body)
  if (error || !values) {
    res.status(422).json({ message: error })
    return
  }
  db.prepare(
    `UPDATE applications SET company=@company, position=@position, status=@status, applied_at=@applied_at,
       channel=@channel, location=@location, resume_id=@resume_id, jd_link=@jd_link, jd_text=@jd_text,
       contact_name=@contact_name, contact_info=@contact_info, notes=@notes, updated_at=@ts
     WHERE id=@id`
  ).run({ ...values, ts: now(), id: app.id })

  if (values.status !== app.status) {
    addStatusEvent(app.id, app.status, values.status as Status)
  }
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id))
})

// 标记挂掉 / 撤销
applicationsRouter.patch('/:id/reject', (req: Request, res: Response) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id) as
    | { id: number; rejected_at: string | null; company: string; position: string }
    | undefined
  if (!app) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  if (app.rejected_at) {
    // 撤销
    db.prepare('UPDATE applications SET rejected_at=NULL, reject_type=NULL, updated_at=? WHERE id=?').run(now(), app.id)
  } else {
    const rejectType = req.body?.reject_type === 'me' ? 'me' : 'company'
    db.prepare('UPDATE applications SET rejected_at=?, reject_type=?, updated_at=? WHERE id=?').run(
      today(), rejectType, now(), app.id
    )
    db.prepare(
      `INSERT INTO events (application_id, type, event_date, content, created_at)
       VALUES (?, 'note', ?, ?, ?)`
    ).run(app.id, today(), rejectType === 'me' ? '标记：我拒了' : '标记：被拒', now())
  }
  res.json(db.prepare('SELECT * FROM applications WHERE id = ?').get(app.id))
})

// 删除（级联 events/interviews/checklist）
applicationsRouter.delete('/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM applications WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  res.json({ ok: true })
})
