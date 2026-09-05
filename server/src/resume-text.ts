import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { db, UPLOADS_DIR, now } from './db.js'

const MAX_RESUME_TEXT = 24_000
type ResumeRow = { id: number; filename: string; stored_name: string; size: number; note: string | null; uploaded_at: string }

function cleaned(value: unknown): string {
  return typeof value === 'string'
    ? value.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, MAX_RESUME_TEXT)
    : ''
}
function parse(value: string): { text?: unknown; error?: unknown } { try { return JSON.parse(value) as { text?: unknown; error?: unknown } } catch { return {} } }
function row(resumeId: number): ResumeRow | undefined { return db.prepare('SELECT id,filename,stored_name,size,note,uploaded_at FROM resumes WHERE id=?').get(resumeId) as ResumeRow | undefined }
function python(): string { return process.env.PREP_AGENT_PYTHON?.trim() || process.env.PYTHON?.trim() || 'python' }

export function resumeWithText(resumeId: number): Record<string, unknown> | null {
  const resume = row(resumeId); if (!resume) return null
  const text = db.prepare('SELECT status,text_content,error_message,extracted_at,updated_at FROM resume_texts WHERE resume_id=?').get(resumeId) as Record<string, unknown> | undefined
  return { ...resume, extraction_status: text?.status ?? 'pending', extraction_error: text?.error_message ?? null, extracted_at: text?.extracted_at ?? null, text_available: text?.status === 'completed' }
}

export function listResumesWithText(): Record<string, unknown>[] {
  return db.prepare(`SELECT r.*,COALESCE(t.status,'pending') AS extraction_status,t.error_message AS extraction_error,t.extracted_at,
    CASE WHEN t.status='completed' AND length(COALESCE(t.text_content,''))>0 THEN 1 ELSE 0 END AS text_available
    FROM resumes r LEFT JOIN resume_texts t ON t.resume_id=r.id ORDER BY r.uploaded_at DESC`).all() as Record<string, unknown>[]
}

export function extractResumeText(resumeId: number): Record<string, unknown> {
  const resume = row(resumeId)
  if (!resume) throw new Error('简历不存在')
  const file = path.join(UPLOADS_DIR, resume.stored_name)
  const timestamp = now()
  if (!existsSync(file)) {
    db.prepare(`INSERT INTO resume_texts(resume_id,status,text_content,content_hash,error_message,extracted_at,updated_at) VALUES(?,'failed',NULL,NULL,?,NULL,?)
      ON CONFLICT(resume_id) DO UPDATE SET status='failed',text_content=NULL,content_hash=NULL,error_message=excluded.error_message,updated_at=excluded.updated_at`).run(resumeId, '简历文件已丢失', timestamp)
    return resumeWithText(resumeId)!
  }
  const extension = path.extname(resume.stored_name).toLowerCase()
  if (extension === '.doc') {
    const message = '旧版 .doc 暂不支持自动提取，请另存为 .docx 或 PDF 后重新上传'
    db.prepare(`INSERT INTO resume_texts(resume_id,status,text_content,content_hash,error_message,extracted_at,updated_at) VALUES(?,'unsupported',NULL,NULL,?,NULL,?)
      ON CONFLICT(resume_id) DO UPDATE SET status='unsupported',text_content=NULL,content_hash=NULL,error_message=excluded.error_message,updated_at=excluded.updated_at`).run(resumeId, message, timestamp)
    return resumeWithText(resumeId)!
  }
  db.prepare(`INSERT INTO resume_texts(resume_id,status,text_content,content_hash,error_message,extracted_at,updated_at) VALUES(?,'extracting',NULL,NULL,NULL,NULL,?)
    ON CONFLICT(resume_id) DO UPDATE SET status='extracting',error_message=NULL,updated_at=excluded.updated_at`).run(resumeId, timestamp)
  const result = spawnSync(python(), [path.resolve('scripts/extract-resume-text.py'), file], {
    encoding: 'utf8', timeout: 30_000, maxBuffer: 1_200_000, windowsHide: true,
    // Windows 的 Python 默认会继承系统代码页；简历往往含中文，必须固定为 UTF-8。
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' }
  })
  const payload = parse(result.stdout || result.stderr || '')
  const text = cleaned(payload.text)
  if (result.status === 0 && text) {
    db.prepare(`UPDATE resume_texts SET status='completed',text_content=?,content_hash=?,error_message=NULL,extracted_at=?,updated_at=? WHERE resume_id=?`).run(text, createHash('sha256').update(text).digest('hex'), now(), now(), resumeId)
  } else {
    const message = cleaned(payload.error) || cleaned(result.stderr) || (result.error?.message ? `简历提取失败：${result.error.message}` : '简历文本提取失败')
    db.prepare(`UPDATE resume_texts SET status='failed',text_content=NULL,content_hash=NULL,error_message=?,updated_at=? WHERE resume_id=?`).run(message.slice(0, 1_000), now(), resumeId)
  }
  return resumeWithText(resumeId)!
}
