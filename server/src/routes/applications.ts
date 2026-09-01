import { Router } from 'express'
import type { Request, Response } from 'express'
import { db, now, today } from '../db.js'
import { STATUS_LABELS, STATUS_ORDER, type Status } from '../types.js'
import { isCalendarDate, isClockTime, type ImportAnalysis } from '../../../shared/application-import.js'
import { activeImports, findDuplicates, getImport, getImportRow, getMaterialFileNames, removeMaterialFiles, ImportError } from '../application-materials.js'

export const applicationsRouter = Router()

interface AppBody {
  company?: string
  position?: string
  status?: Status
  applied_at?: string | null
  applied_time?: string | null
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

function addStatusEvent(appId: number, from: Status, to: Status, eventDate = today()): void {
  db.prepare(
    `INSERT INTO events (application_id, type, event_date, content, created_at)
     VALUES (?, 'status', ?, ?, ?)`
  ).run(appId, eventDate, `状态：${STATUS_LABELS[from]} -> ${STATUS_LABELS[to]}`, now())
}

/** 校验并规范化请求体，返回错误消息或规范化的字段 */
function validate(body: AppBody): { error?: string; values?: Record<string, unknown> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: '表单格式不正确' }
  for (const key of ['company', 'position', 'status', 'applied_at', 'applied_time', 'channel', 'location', 'jd_link', 'jd_text', 'contact_name', 'contact_info', 'notes'] as const) {
    if (body[key] != null && typeof body[key] !== 'string') return { error: `${key} 必须为文本` }
  }
  const company = (body.company ?? '').trim()
  const position = (body.position ?? '').trim()
  if (!company) return { error: '公司不能为空' }
  if (!position) return { error: '职位不能为空' }

  const status: Status = body.status != null && isStatus(body.status) ? body.status : 'unsent'

  // A missing business date is never silently replaced by the record creation date.
  const applied_at = body.applied_at || null
  const applied_time = body.applied_time || null
  if (status !== 'unsent' && !applied_at) return { error: '请填写实际投递日期，或明确选择使用今天' }
  if (applied_at && !isCalendarDate(applied_at)) return { error: '投递日期不是有效的日历日期' }
  if (applied_time && (!applied_at || !isClockTime(applied_time))) return { error: '投递时刻须为 HH:mm 或 HH:mm:ss，且必须有投递日期' }
  if (status === 'unsent' && (applied_at || applied_time)) return { error: '材料包含投递时间，请核对状态；若确实未投递，请清除日期' }
  if (body.jd_link) {
    try { if (!['http:', 'https:'].includes(new URL(body.jd_link).protocol)) throw new Error() }
    catch { return { error: '投递链接必须是完整的 http/https 地址' } }
  }

  return {
    values: {
      company,
      position,
      status,
      applied_at,
      applied_time,
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
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id) as
    | (Record<string, unknown> & { resume_id: number | null })
    | undefined
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
  const resumeId = app.resume_id
  const resume = resumeId
    ? db.prepare('SELECT * FROM resumes WHERE id = ?').get(resumeId) ?? null
    : null
  const importIds = db.prepare('SELECT id FROM application_imports WHERE application_id=? ORDER BY created_at').all(req.params.id) as { id: string }[]
  res.json({ ...app, events, interviews, resume, materials: importIds.map(({ id }) => getImport(id)) })
})

// 新建
applicationsRouter.post('/', (req: Request, res: Response) => {
  const { error, values } = validate(req.body)
  if (error || !values) {
    res.status(422).json({ message: error })
    return
  }
  const importId = req.body.import_id
  if (importId != null && typeof importId !== 'string') throw new ImportError('材料编号无效')
  if (importId) {
    const draft = getImportRow(importId)
    if (draft.application_id) {
      if (draft.confirmed_json !== JSON.stringify(values)) throw new ImportError('这份材料已经保存，若要修改请编辑原记录', 409)
      res.json(db.prepare('SELECT * FROM applications WHERE id=?').get(draft.application_id)); return
    }
    if (activeImports.has(importId)) throw new ImportError('材料正在识别，请等待完成或取消', 409)
    if (req.body.import_confirmed !== true) throw new ImportError('请先核对识别字段与实际投递时间')
    const analysis = draft.analysis_json ? JSON.parse(draft.analysis_json) as ImportAnalysis : null
    if ((!analysis || analysis.extraction.target_state !== 'single') && req.body.import_manual !== true) throw new ImportError('请选定一个岗位重新识别，或明确选择手动填写')
    const duplicates = findDuplicates(values as { company: string; position: string; location: string | null; jd_link: string | null })
    if (duplicates.length && req.body.allow_duplicate !== true) { res.status(409).json({ message: '发现可能重复的投递记录，请确认后再保存', duplicates }); return }
  }
  const appId = db.transaction(() => {
    const result = db
    .prepare(
      `INSERT INTO applications (company, position, status, applied_at, applied_time, channel, location, resume_id,
                                 jd_link, jd_text, contact_name, contact_info, notes, created_at, updated_at)
       VALUES (@company, @position, @status, @applied_at, @applied_time, @channel, @location, @resume_id,
               @jd_link, @jd_text, @contact_name, @contact_info, @notes, @ts, @ts)`
    )
    .run({ ...values, ts: now() })

    const id = Number(result.lastInsertRowid)
    if (values.status !== 'unsent') addStatusEvent(id, 'unsent', values.status as Status, values.applied_at as string)
    if (importId) db.prepare('UPDATE application_imports SET application_id=?,confirmed_json=? WHERE id=?').run(id, JSON.stringify(values), importId)
    return id
  })()
  res.status(201).json(db.prepare('SELECT * FROM applications WHERE id = ?').get(appId))
})

// 更新
applicationsRouter.put('/:id', (req: Request, res: Response) => {
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(req.params.id) as
    | { id: number; status: Status; applied_time: string | null }
    | undefined
  if (!app) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  const { error, values } = validate({ ...req.body, applied_time: req.body.applied_time === undefined ? app.applied_time : req.body.applied_time })
  if (error || !values) {
    res.status(422).json({ message: error })
    return
  }
  db.prepare(
    `UPDATE applications SET company=@company, position=@position, status=@status, applied_at=@applied_at, applied_time=@applied_time,
       channel=@channel, location=@location, resume_id=@resume_id, jd_link=@jd_link, jd_text=@jd_text,
       contact_name=@contact_name, contact_info=@contact_info, notes=@notes, updated_at=@ts
     WHERE id=@id`
  ).run({ ...values, ts: now(), id: app.id })

  if (values.status !== app.status) {
    const statusEventDate = app.status === 'unsent' && values.status !== 'unsent'
      ? values.applied_at as string
      : today()
    addStatusEvent(app.id, app.status, values.status as Status, statusEventDate)
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
  const imports = db.prepare('SELECT id FROM application_imports WHERE application_id=?').all(req.params.id) as { id: string }[]
  const files = imports.flatMap(({ id }) => getMaterialFileNames(id))
  const result = db.prepare('DELETE FROM applications WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '记录不存在' })
    return
  }
  try { removeMaterialFiles(files) } catch (err) { console.error('[application-materials] 删除文件失败:', (err as Error).message) }
  res.json({ ok: true })
})

applicationsRouter.use((err: Error, _req: Request, res: Response, next: import('express').NextFunction) => {
  if (err instanceof ImportError) res.status(err.status).json({ message: err.message })
  else next(err)
})
