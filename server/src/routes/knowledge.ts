import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, KNOWLEDGE_IMAGES_DIR, now } from '../db.js'
import { KNOWLEDGE_CATEGORIES, MASTERY_LEVELS } from '../types.js'
import { inspectImage } from '../application-materials.js'
import { searchKnowledge } from '../knowledge-retrieval.js'
import { snapshotKnowledgeAnswer } from '../knowledge-answer-history.js'

export const knowledgeRouter = Router()

knowledgeRouter.get('/search', (req: Request, res: Response) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (!query) {
    res.status(422).json({ message: 'q 不能为空' })
    return
  }
  const owner = req.query.owner === 'mine' || req.query.owner === 'others' ? req.query.owner : undefined
  const category = typeof req.query.category === 'string' ? req.query.category : undefined
  const limit = Number(req.query.limit)
  res.json(searchKnowledge(query, { owner, category, limit: Number.isFinite(limit) ? limit : 10 }))
})

// multer 把 multipart 文件名按 latin1 解码，中文会变乱码：能无损还原成 UTF-8 时采用还原结果
function fixOriginalName(name: string): string {
  const bytes = Buffer.from(name, 'latin1')
  const decoded = bytes.toString('utf8')
  return decoded !== name && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : name
}

const imgUpload = multer({
  storage: multer.diskStorage({
    destination: KNOWLEDGE_IMAGES_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    }
  }),
  limits: { files: 2, fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    // 小图会直接作为视觉模型输入，推理副本不一定是 JPEG：需与原图支持范围保持一致。
    if (file.fieldname === 'inference_file' && ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) cb(null, true)
    else if (file.fieldname === 'file' && ['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) cb(null, true)
    else cb(new Error('仅支持图片文件（jpg/png/webp/bmp）'))
  }
})

function removeKnowledgeFile(name: string | null | undefined): void {
  if (!name) return
  const filePath = path.join(KNOWLEDGE_IMAGES_DIR, path.basename(name))
  if (existsSync(filePath)) unlinkSync(filePath)
}

function validCategory(c: unknown): string {
  return typeof c === 'string' && KNOWLEDGE_CATEGORIES.includes(c) ? c : '其他'
}

function requestedUpdatedAt(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function conflict(res: Response): void {
  res.status(409).json({ message: '这条题目已被其他操作更新，请刷新后再试', error_type: 'knowledge_item_conflict' })
}

function markdownQuote(value: string): string {
  return value.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n')
}

function markdownFilenamePart(value: string): string {
  return value.trim().replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').slice(0, 80) || '未命名'
}

// ---------- 面经（源） ----------

// 列表（含题目数/截图数）
knowledgeRouter.get('/sources', (req: Request, res: Response) => {
  const { owner, keyword } = req.query
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (owner === 'others' || owner === 'mine') {
    where.push('s.owner = @owner')
    params.owner = owner
  }
  if (keyword) {
    where.push("(s.company LIKE @kw OR s.position LIKE @kw OR IFNULL(s.round, '') LIKE @kw)")
    params.kw = `%${keyword}%`
  }
  const rows = db
    .prepare(
      `WITH indexed_sources AS (
        SELECT s.*,
          COUNT(*) OVER (
            PARTITION BY s.owner, s.company, COALESCE(s.position, ''), COALESCE(s.round, '')
          ) AS duplicate_count,
          ROW_NUMBER() OVER (
            PARTITION BY s.owner, s.company, COALESCE(s.position, ''), COALESCE(s.round, '')
            ORDER BY s.id ASC
          ) AS duplicate_index
        FROM knowledge_sources s
      )
      SELECT s.*,
        (SELECT COUNT(*) FROM knowledge_items WHERE source_id = s.id) AS item_count,
        (SELECT COUNT(*) FROM knowledge_images WHERE source_id = s.id) AS image_count
       FROM indexed_sources s ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY s.created_at DESC`
    )
    .all(params)
  res.json(rows)
})

knowledgeRouter.post('/sources', (req: Request, res: Response) => {
  const owner = req.body?.owner === 'mine' ? 'mine' : 'others'
  const company = (req.body?.company ?? '').trim()
  if (!company) {
    res.status(422).json({ message: '公司不能为空' })
    return
  }
  const sourceType = ['text', 'image', 'manual'].includes(req.body?.source_type) ? req.body.source_type : 'manual'
  const ts = now()
  const result = db
    .prepare(
      `INSERT INTO knowledge_sources (owner, company, position, round, source_type, note, application_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      owner,
      company,
      req.body?.position?.trim() || null,
      req.body?.round?.trim() || null,
      sourceType,
      req.body?.note?.trim() || null,
      owner === 'mine' && req.body?.application_id ? Number(req.body.application_id) : null,
      ts,
      ts
    )
  res.status(201).json(db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(result.lastInsertRowid))
})

knowledgeRouter.put('/sources/:id', (req: Request, res: Response) => {
  const src = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!src) {
    res.status(404).json({ message: '面经不存在' })
    return
  }
  const company = (req.body?.company ?? (src as { company: string }).company).trim()
  if (!company) {
    res.status(422).json({ message: '公司不能为空' })
    return
  }
  db.prepare(
    `UPDATE knowledge_sources SET company=?, position=?, round=?, note=?, updated_at=? WHERE id=?`
  ).run(
    company,
    req.body?.position?.trim() ?? (src as { position: string | null }).position,
    req.body?.round?.trim() ?? (src as { round: string | null }).round,
    req.body?.note?.trim() ?? (src as { note: string | null }).note,
    now(),
    req.params.id
  )
  res.json(db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(req.params.id))
})

knowledgeRouter.delete('/sources/:id', (req: Request, res: Response) => {
  const src = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(req.params.id) as
    | { id: number }
    | undefined
  if (!src) {
    res.status(404).json({ message: '面经不存在' })
    return
  }
  // 先删截图文件，记录由外键级联删除（条目 + 截图记录）
  const images = db.prepare('SELECT stored_name, inference_stored_name FROM knowledge_images WHERE source_id = ?').all(src.id) as {
    stored_name: string; inference_stored_name: string | null
  }[]
  for (const img of images) {
    removeKnowledgeFile(img.stored_name)
    removeKnowledgeFile(img.inference_stored_name)
  }
  db.prepare('DELETE FROM knowledge_sources WHERE id = ?').run(src.id)
  res.json({ ok: true })
})

/** 下载当前面经的可移植 Markdown；截图不内嵌，避免单个 .md 文件膨胀或失效。 */
knowledgeRouter.get('/sources/:id/export.md', (req: Request, res: Response) => {
  const source = db.prepare('SELECT * FROM knowledge_sources WHERE id=?').get(req.params.id) as
    | { id: number; owner: 'mine' | 'others'; company: string; position: string | null; round: string | null; note: string | null; created_at: string }
    | undefined
  if (!source) {
    res.status(404).json({ message: '面经不存在' })
    return
  }
  const items = db.prepare(`SELECT id,question,answer,category,mastery FROM knowledge_items
    WHERE source_id=? ORDER BY id`).all(source.id) as Array<{ id: number; question: string; answer: string | null; category: string; mastery: number }>
  const mastery = ['未掌握', '模糊', '已掌握']
  const title = [source.company, source.position, source.round].filter(Boolean).join(' · ') || source.company
  const lines = [
    `# ${title}`,
    '',
    `- 面经来源：${source.owner === 'mine' ? '我的面试' : '他人面经'}`,
    `- 录入时间：${source.created_at.slice(0, 10)}`,
    `- 题目数量：${items.length}`,
    ...(source.note ? [`- 备注：${source.note}`] : []),
    '',
    '---'
  ]
  for (const [index, item] of items.entries()) {
    lines.push(
      '',
      `## ${index + 1}. 问题`,
      '',
      markdownQuote(item.question),
      '',
      `- 分类：${item.category}`,
      `- 掌握度：${mastery[item.mastery] ?? '未知'}`,
      '',
      '### 参考答案',
      '',
      item.answer?.trim() || '> 暂无参考答案'
    )
  }
  // 同公司、岗位、轮次允许录入多份面经；按录入顺序编号，避免导出文件同名。
  const duplicateIndex = Number(db.prepare(`SELECT COUNT(*) AS count FROM knowledge_sources
    WHERE owner=? AND company=? AND COALESCE(position, '')=COALESCE(?, '') AND COALESCE(round, '')=COALESCE(?, '') AND id<=?`)
    .get(source.owner, source.company, source.position, source.round, source.id)?.count ?? 1)
  const filename = `${[
    markdownFilenamePart(source.company),
    source.position ? markdownFilenamePart(source.position) : '',
    source.round ? markdownFilenamePart(source.round) : '',
    `面经（${duplicateIndex}）`
  ].filter(Boolean).join('-')}.md`
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="interview-notes.md"; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(`${lines.join('\n')}\n`)
})

// 面经详情：条目 + 截图
knowledgeRouter.get('/sources/:id', (req: Request, res: Response) => {
  const src = db.prepare('SELECT * FROM knowledge_sources WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined
  if (!src) {
    res.status(404).json({ message: '面经不存在' })
    return
  }
  const items = db.prepare('SELECT * FROM knowledge_items WHERE source_id = ? ORDER BY id').all(req.params.id)
  const images = db.prepare('SELECT id, filename, created_at FROM knowledge_images WHERE source_id = ? ORDER BY id').all(
    req.params.id
  )
  res.json({ ...src, items, images })
})

// ---------- 题目条目 ----------

// 列表（join 面经信息，keyword 同时搜问题与答案）
knowledgeRouter.get('/items', (req: Request, res: Response) => {
  const { owner, category, mastery, keyword, source_id } = req.query
  const where: string[] = []
  const params: Record<string, unknown> = {}
  if (owner === 'others' || owner === 'mine') {
    where.push('s.owner = @owner')
    params.owner = owner
  }
  if (category && KNOWLEDGE_CATEGORIES.includes(String(category))) {
    where.push('i.category = @category')
    params.category = category
  }
  if (mastery !== undefined && MASTERY_LEVELS.includes(Number(mastery) as 0 | 1 | 2)) {
    where.push('i.mastery = @mastery')
    params.mastery = Number(mastery)
  }
  if (source_id) {
    where.push('i.source_id = @source_id')
    params.source_id = Number(source_id)
  }
  if (keyword) {
    where.push(`(i.question LIKE @kw OR IFNULL(i.answer, '') LIKE @kw)`)
    params.kw = `%${keyword}%`
  }
  const rows = db
    .prepare(
      `SELECT i.*, s.company AS source_company, s.position AS source_position,
              s.round AS source_round, s.owner AS source_owner
       FROM knowledge_items i LEFT JOIN knowledge_sources s ON i.source_id = s.id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY i.updated_at DESC`
    )
    .all(params)
  res.json(rows)
})

knowledgeRouter.post('/items', (req: Request, res: Response) => {
  const question = (req.body?.question ?? '').trim()
  if (!question) {
    res.status(422).json({ message: '问题不能为空' })
    return
  }
  const ts = now()
  const result = db
    .prepare(
      `INSERT INTO knowledge_items (source_id, question, answer, category, mastery, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      req.body?.source_id ? Number(req.body.source_id) : null,
      question,
      req.body?.answer || null,
      validCategory(req.body?.category),
      ts,
      ts
    )
  res.status(201).json(db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(result.lastInsertRowid))
})

// 候选批量入库（录入流程）
knowledgeRouter.post('/items/batch', (req: Request, res: Response) => {
  const sourceId = Number(req.body?.source_id)
  const items = req.body?.items
  if (!sourceId || !db.prepare('SELECT id FROM knowledge_sources WHERE id = ?').get(sourceId)) {
    res.status(422).json({ message: '面经不存在' })
    return
  }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(422).json({ message: '题目列表不能为空' })
    return
  }
  if (items.length > 100) {
    res.status(422).json({ message: '单批最多 100 条' })
    return
  }
  const ts = now()
  const insert = db.prepare(
    `INSERT INTO knowledge_items (source_id, question, answer, category, mastery, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  )
  const ids: number[] = []
  const tx = db.transaction(() => {
    for (const item of items) {
      const question = (item?.question ?? '').trim()
      if (!question) continue
      const r = insert.run(sourceId, question, item.answer || null, validCategory(item.category), ts, ts)
      ids.push(Number(r.lastInsertRowid))
    }
  })
  tx()
  if (ids.length === 0) {
    res.status(422).json({ message: '没有有效题目' })
    return
  }
  res.status(201).json(
    db.prepare(`SELECT * FROM knowledge_items WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`).all(...ids)
  )
})

knowledgeRouter.put('/items/:id', (req: Request, res: Response) => {
  const item = db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(req.params.id) as
    | { id: number; question: string; answer: string | null; category: string; updated_at: string }
    | undefined
  if (!item) {
    res.status(404).json({ message: '条目不存在' })
    return
  }
  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : item.question
  if (!question) {
    res.status(422).json({ message: '问题不能为空' })
    return
  }
  if (question.length > 2000) {
    res.status(422).json({ message: '问题不能超过 2000 字符' })
    return
  }
  const hasAnswer = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'answer')
  if (hasAnswer && req.body?.answer != null && typeof req.body.answer !== 'string') {
    res.status(422).json({ message: '答案必须是文字或空值' })
    return
  }
  const answer = hasAnswer ? (typeof req.body?.answer === 'string' ? req.body.answer.trim() || null : null) : item.answer
  if (answer && answer.length > 20_000) {
    res.status(422).json({ message: '答案不能超过 20000 字符' })
    return
  }
  const expected = requestedUpdatedAt(req.body?.expected_updated_at)
  if (expected && expected !== item.updated_at) {
    conflict(res)
    return
  }
  const timestamp = now()
  try {
    db.transaction(() => {
      if (answer !== item.answer) snapshotKnowledgeAnswer(item.id, item.answer, 'before_manual_edit')
      const result = db.prepare(`UPDATE knowledge_items SET question=?, answer=?, category=?, updated_at=?
        WHERE id=?${expected ? ' AND updated_at=?' : ''}`).run(
        question, answer, validCategory(req.body?.category ?? item.category), timestamp, item.id, ...(expected ? [expected] : [])
      )
      if (!result.changes) throw new Error('knowledge_item_conflict')
    })()
  } catch (error) {
    if ((error as Error).message === 'knowledge_item_conflict') return conflict(res)
    throw error
  }
  res.json(db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(req.params.id))
})

knowledgeRouter.get('/items/:id/answer-versions', (req: Request, res: Response) => {
  const itemId = Number(req.params.id)
  if (!itemId || !db.prepare('SELECT id FROM knowledge_items WHERE id=?').get(itemId)) {
    res.status(404).json({ message: '题目不存在' })
    return
  }
  const rows = db.prepare(`SELECT id,answer,reason,model,created_at FROM knowledge_answer_versions
    WHERE knowledge_item_id=? ORDER BY id DESC LIMIT 30`).all(itemId)
  res.json(rows)
})

knowledgeRouter.post('/items/:id/answer-versions/:versionId/restore', (req: Request, res: Response) => {
  const itemId = Number(req.params.id)
  const versionId = Number(req.params.versionId)
  const item = db.prepare('SELECT id,answer,updated_at FROM knowledge_items WHERE id=?').get(itemId) as
    | { id: number; answer: string | null; updated_at: string }
    | undefined
  const version = db.prepare(`SELECT answer FROM knowledge_answer_versions
    WHERE id=? AND knowledge_item_id=?`).get(versionId, itemId) as { answer: string } | undefined
  if (!item || !version) {
    res.status(404).json({ message: '题目或答案版本不存在' })
    return
  }
  const expected = requestedUpdatedAt(req.body?.expected_updated_at)
  if (expected && expected !== item.updated_at) {
    conflict(res)
    return
  }
  const timestamp = now()
  try {
    db.transaction(() => {
      if (version.answer !== item.answer) snapshotKnowledgeAnswer(item.id, item.answer, 'before_restore')
      const result = db.prepare(`UPDATE knowledge_items SET answer=?, updated_at=?
        WHERE id=?${expected ? ' AND updated_at=?' : ''}`).run(version.answer, timestamp, item.id, ...(expected ? [expected] : []))
      if (!result.changes) throw new Error('knowledge_item_conflict')
    })()
  } catch (error) {
    if ((error as Error).message === 'knowledge_item_conflict') return conflict(res)
    throw error
  }
  res.json(db.prepare('SELECT * FROM knowledge_items WHERE id=?').get(itemId))
})

knowledgeRouter.patch('/items/:id/mastery', (req: Request, res: Response) => {
  const mastery = Number(req.body?.mastery)
  if (!MASTERY_LEVELS.includes(mastery as 0 | 1 | 2)) {
    res.status(422).json({ message: 'mastery 应为 0/1/2' })
    return
  }
  const result = db.prepare('UPDATE knowledge_items SET mastery=?, updated_at=? WHERE id=?').run(
    mastery,
    now(),
    req.params.id
  )
  if (result.changes === 0) {
    res.status(404).json({ message: '条目不存在' })
    return
  }
  res.json(db.prepare('SELECT * FROM knowledge_items WHERE id = ?').get(req.params.id))
})

knowledgeRouter.delete('/items/:id', (req: Request, res: Response) => {
  const result = db.prepare('DELETE FROM knowledge_items WHERE id = ?').run(req.params.id)
  if (result.changes === 0) {
    res.status(404).json({ message: '条目不存在' })
    return
  }
  res.json({ ok: true })
})

// ---------- 截图 ----------

// 上传截图（挂在面经下留底；AI 提取按 image_id 读取磁盘文件，避免二次上传）
knowledgeRouter.post('/images', imgUpload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'inference_file', maxCount: 1 }
]), (req: Request, res: Response) => {
  const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>
  const original = files.file?.[0]
  const inference = files.inference_file?.[0]
  const cleanup = () => { removeKnowledgeFile(original?.filename); removeKnowledgeFile(inference?.filename) }
  const sourceId = Number(req.body?.source_id)
  if (!sourceId || !db.prepare('SELECT id FROM knowledge_sources WHERE id = ?').get(sourceId)) {
    cleanup()
    res.status(422).json({ message: '面经不存在' })
    return
  }
  if (!original || !inference) {
    cleanup()
    res.status(422).json({ message: '请选择图片；图片推理副本缺失时请刷新页面后重试' })
    return
  }
  try {
    const inferenceInfo = inspectImage(readFileSync(inference.path))
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/bmp'].includes(inferenceInfo.mime)
      || Math.max(inferenceInfo.width, inferenceInfo.height) > 2048) {
      throw new Error('图片推理副本格式或尺寸不正确')
    }
    const result = db
      .prepare(`INSERT INTO knowledge_images (
        source_id, filename, stored_name, inference_stored_name, inference_mime, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(sourceId, fixOriginalName(original.originalname), original.filename, inference.filename, inferenceInfo.mime, now())
    res.status(201).json(db.prepare('SELECT * FROM knowledge_images WHERE id = ?').get(result.lastInsertRowid))
  } catch (error) {
    cleanup()
    res.status(422).json({ message: (error as Error).message || '图片处理失败' })
  }
})

knowledgeRouter.get('/images/:id/file', (req: Request, res: Response) => {
  const img = db.prepare('SELECT * FROM knowledge_images WHERE id = ?').get(req.params.id) as
    | { stored_name: string; filename: string }
    | undefined
  if (!img) {
    res.status(404).json({ message: '截图不存在' })
    return
  }
  const filePath = path.join(KNOWLEDGE_IMAGES_DIR, img.stored_name)
  if (!existsSync(filePath)) {
    res.status(404).json({ message: '截图文件已丢失' })
    return
  }
  const ext = path.extname(img.stored_name).toLowerCase()
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
  }
  res.setHeader('Content-Type', types[ext] ?? 'application/octet-stream')
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(img.filename)}`)
  res.sendFile(filePath)
})

knowledgeRouter.delete('/images/:id', (req: Request, res: Response) => {
  const img = db.prepare('SELECT * FROM knowledge_images WHERE id = ?').get(req.params.id) as
    | { id: number; stored_name: string; inference_stored_name: string | null }
    | undefined
  if (!img) {
    res.status(404).json({ message: '截图不存在' })
    return
  }
  removeKnowledgeFile(img.stored_name)
  removeKnowledgeFile(img.inference_stored_name)
  db.prepare('DELETE FROM knowledge_images WHERE id = ?').run(img.id)
  res.json({ ok: true })
})
