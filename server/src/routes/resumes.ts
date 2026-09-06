import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, UPLOADS_DIR, now } from '../db.js'
import { requestResumeTextExtraction, listResumesWithText, resumeWithText } from '../resume-text.js'

export const resumesRouter = Router()

const ALLOWED_EXT = ['.pdf', '.doc', '.docx']

// multer 把 multipart 文件名按 latin1 解码，中文会变乱码：能无损还原成 UTF-8 时采用还原结果
function fixOriginalName(name: string): string {
  const bytes = Buffer.from(name, 'latin1')
  const decoded = bytes.toString('utf8')
  return decoded !== name && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : name
}

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      const safe = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
      cb(null, safe)
    }
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (ALLOWED_EXT.includes(ext)) cb(null, true)
    else cb(new Error('仅支持 PDF / Word 文件'))
  }
})

resumesRouter.get('/', (_req: Request, res: Response) => {
  res.json(listResumesWithText())
})

resumesRouter.post('/', upload.single('file'), (req: Request, res: Response) => {
  if (!req.file) {
    res.status(422).json({ message: '请选择文件' })
    return
  }
  const result = db
    .prepare('INSERT INTO resumes (filename, stored_name, size, note, uploaded_at) VALUES (?, ?, ?, ?, ?)')
    .run(
      fixOriginalName(req.file.originalname),
      req.file.filename,
      req.file.size,
      req.body?.note?.trim() || null,
      now()
    )
  // 简历提取始终异步执行：PDF 渲染后会交由视觉模型识别，不能阻塞 Node 服务。
  res.status(202).json(requestResumeTextExtraction(Number(result.lastInsertRowid)))
})

resumesRouter.post('/:id/extract', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) { res.status(422).json({ message: '简历编号无效' }); return }
  try { res.status(202).json(requestResumeTextExtraction(id)) }
  catch (error) { res.status(500).json({ message: (error as Error).message || '简历提取失败' }) }
})

// 文件流（浏览器在线预览 PDF / 下载 Word）
resumesRouter.get('/:id/file', (req: Request, res: Response) => {
  const resume = db.prepare('SELECT * FROM resumes WHERE id = ?').get(req.params.id) as
    | { stored_name: string; filename: string }
    | undefined
  if (!resume) {
    res.status(404).json({ message: '简历不存在' })
    return
  }
  const filePath = path.join(UPLOADS_DIR, resume.stored_name)
  if (!existsSync(filePath)) {
    res.status(404).json({ message: '文件已丢失' })
    return
  }
  const ext = path.extname(resume.stored_name).toLowerCase()
  const contentType = ext === '.pdf' ? 'application/pdf' : 'application/octet-stream'
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(resume.filename)}`)
  res.sendFile(filePath)
})

// 提取结果仅保留在本地 SQLite；用户可在简历库核对后再用于 AI 面试准备。
resumesRouter.get('/:id/text', (req: Request, res: Response) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) { res.status(422).json({ message: '简历编号无效' }); return }
  const resume = db.prepare('SELECT id, filename FROM resumes WHERE id = ?').get(id) as
    | { id: number; filename: string }
    | undefined
  if (!resume) { res.status(404).json({ message: '简历不存在' }); return }
  const extracted = db.prepare(`SELECT status, text_content, extraction_method, model, page_count, extracted_at
    FROM resume_texts WHERE resume_id = ?`).get(id) as
    | { status: string; text_content: string | null; extraction_method: string | null; model: string | null; page_count: number | null; extracted_at: string | null }
    | undefined
  if (extracted?.status !== 'completed' || !extracted.text_content) {
    res.status(409).json({ message: '简历文字尚未提取完成' })
    return
  }
  res.json({
    resume_id: resume.id,
    filename: resume.filename,
    text: extracted.text_content,
    extraction_method: extracted.extraction_method,
    extraction_model: extracted.model,
    page_count: extracted.page_count,
    extracted_at: extracted.extracted_at
  })
})

resumesRouter.delete('/:id', (req: Request, res: Response) => {
  const resume = db.prepare('SELECT * FROM resumes WHERE id = ?').get(req.params.id) as
    | { id: number; stored_name: string }
    | undefined
  if (!resume) {
    res.status(404).json({ message: '简历不存在' })
    return
  }
  const filePath = path.join(UPLOADS_DIR, resume.stored_name)
  if (existsSync(filePath)) unlinkSync(filePath)
  db.prepare('UPDATE applications SET resume_id = NULL WHERE resume_id = ?').run(resume.id)
  db.prepare('DELETE FROM resumes WHERE id = ?').run(resume.id)
  res.json({ ok: true })
})
