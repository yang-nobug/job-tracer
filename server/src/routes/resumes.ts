import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { existsSync, unlinkSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, UPLOADS_DIR, now } from '../db.js'

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
  res.json(db.prepare('SELECT * FROM resumes ORDER BY uploaded_at DESC').all())
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
  res.status(201).json(db.prepare('SELECT * FROM resumes WHERE id = ?').get(result.lastInsertRowid))
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
