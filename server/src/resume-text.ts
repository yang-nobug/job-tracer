import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AiError, completeChat, isAiTaskEnabled, visionArkModel, type ChatContent } from './ai.js'
import { db, UPLOADS_DIR, now } from './db.js'
import { loadPrompt } from './prompt-loader.js'

const MAX_RESUME_TEXT = 24_000
const MAX_PYTHON_OUTPUT = 256 * 1024
const PYTHON_TIMEOUT_MS = 60_000
const activeExtractions = new Set<number>()
const __dirname = path.dirname(fileURLToPath(import.meta.url))

type ResumeRow = { id: number; filename: string; stored_name: string; size: number; note: string | null; uploaded_at: string }
type RenderedPage = { path: string; width: number; height: number; bytes: number }

function cleaned(value: unknown, max = MAX_RESUME_TEXT): string {
  return typeof value === 'string'
    ? value.replace(/\u0000/g, '').replace(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, max)
    : ''
}
function parse(value: string): { text?: unknown; pages?: unknown; error?: unknown } { try { return JSON.parse(value) as { text?: unknown; pages?: unknown; error?: unknown } } catch { return {} } }
function row(resumeId: number): ResumeRow | undefined { return db.prepare('SELECT id,filename,stored_name,size,note,uploaded_at FROM resumes WHERE id=?').get(resumeId) as ResumeRow | undefined }
function python(): string { return process.env.PREP_AGENT_PYTHON?.trim() || process.env.PYTHON?.trim() || 'python' }
function script(name: string): string { return path.resolve(__dirname, '../../scripts', name) }

function resumeTextRow(resumeId: number): Record<string, unknown> | undefined {
  return db.prepare(`SELECT status,text_content,error_message,extracted_at,updated_at,
    extraction_method,model AS extraction_model,page_count,pages_completed,started_at
    FROM resume_texts WHERE resume_id=?`).get(resumeId) as Record<string, unknown> | undefined
}

export function resumeWithText(resumeId: number): Record<string, unknown> | null {
  const resume = row(resumeId); if (!resume) return null
  const text = resumeTextRow(resumeId)
  return { ...resume, extraction_status: text?.status ?? 'pending', extraction_error: text?.error_message ?? null,
    extracted_at: text?.extracted_at ?? null, extraction_method: text?.extraction_method ?? null,
    extraction_model: text?.extraction_model ?? null, page_count: text?.page_count ?? null,
    pages_completed: text?.pages_completed ?? 0, started_at: text?.started_at ?? null,
    text_available: text?.status === 'completed' }
}

export function listResumesWithText(): Record<string, unknown>[] {
  return db.prepare(`SELECT r.*,COALESCE(t.status,'pending') AS extraction_status,t.error_message AS extraction_error,t.extracted_at,
    t.extraction_method,t.model AS extraction_model,t.page_count,COALESCE(t.pages_completed,0) AS pages_completed,t.started_at,
    CASE WHEN t.status='completed' AND length(COALESCE(t.text_content,''))>0 THEN 1 ELSE 0 END AS text_available
    FROM resumes r LEFT JOIN resume_texts t ON t.resume_id=r.id ORDER BY r.uploaded_at DESC`).all() as Record<string, unknown>[]
}

function saveState(resumeId: number, input: {
  status: 'pending' | 'extracting' | 'completed' | 'failed' | 'unsupported'
  method?: 'vision_pdf' | 'docx_xml' | null
  model?: string | null
  pageCount?: number | null
  pagesCompleted?: number
  text?: string | null
  error?: string | null
  extractedAt?: string | null
  startedAt?: string | null
}): void {
  const timestamp = now()
  const text = input.text === undefined ? null : input.text
  const hash = text ? createHash('sha256').update(text).digest('hex') : null
  db.prepare(`INSERT INTO resume_texts(
    resume_id,status,text_content,content_hash,error_message,extracted_at,updated_at,
    extraction_method,model,page_count,pages_completed,started_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(resume_id) DO UPDATE SET
    status=excluded.status,text_content=excluded.text_content,content_hash=excluded.content_hash,
    error_message=excluded.error_message,extracted_at=excluded.extracted_at,updated_at=excluded.updated_at,
    extraction_method=excluded.extraction_method,model=excluded.model,page_count=excluded.page_count,
    pages_completed=excluded.pages_completed,started_at=excluded.started_at`).run(
    resumeId, input.status, text, hash, input.error ?? null, input.extractedAt ?? null, timestamp,
    input.method ?? null, input.model ?? null, input.pageCount ?? null, input.pagesCompleted ?? 0, input.startedAt ?? null
  )
}

function runPythonJson(scriptName: string, args: string[], timeoutMs = PYTHON_TIMEOUT_MS): Promise<{ text?: unknown; pages?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), [script(scriptName), ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''; let stderr = ''; let timedOut = false
    const append = (current: string, chunk: Buffer) => `${current}${chunk.toString('utf8')}`.slice(0, MAX_PYTHON_OUTPUT)
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk) })
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', code => {
      clearTimeout(timer)
      const payload = parse(stdout || stderr)
      if (!timedOut && code === 0) { resolve(payload); return }
      const message = cleaned(payload.error, 1_000) || cleaned(stderr, 1_000)
        || (timedOut ? '简历处理超时，请使用更小的文件后重试' : '简历处理失败')
      reject(new Error(message))
    })
  })
}

function renderedPages(value: unknown): RenderedPage[] {
  if (!Array.isArray(value) || !value.length) throw new Error('PDF 没有生成可供识别的页面图片')
  const pages = value.map(item => item && typeof item === 'object' ? item as Record<string, unknown> : null).filter(Boolean).map(item => ({
    path: cleaned(item!.path, 4_000), width: Number(item!.width), height: Number(item!.height), bytes: Number(item!.bytes)
  }))
  if (!pages.length || pages.some(page => !page.path || !Number.isFinite(page.bytes) || page.bytes <= 0 || !existsSync(page.path))) {
    throw new Error('PDF 页面渲染结果无效')
  }
  return pages
}

async function extractPdfWithVision(resumeId: number, filename: string): Promise<{ text: string; model: string; pages: number }> {
  if (!isAiTaskEnabled('resumeExtract')) throw new AiError('简历视觉识别已停用，可在“AI 数据说明”中重新开启', 422, 'task_disabled')
  const model = visionArkModel('resumeExtract')
  if (!model) throw new AiError('请在 config.json 的 ark.models 中配置 vision: true 的模型，才能识别 PDF 简历', 422, 'model_capability')
  const renderDir = mkdtempSync(path.join(os.tmpdir(), 'job-tracer-resume-'))
  try {
    const rendered = await runPythonJson('render-resume-pdf.py', [filename, renderDir])
    const pages = renderedPages(rendered.pages)
    saveState(resumeId, { status: 'extracting', method: 'vision_pdf', model, pageCount: pages.length, pagesCompleted: 0, startedAt: now() })
    const textParts: string[] = []
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index]
      const image = readFileSync(page.path)
      const content: ChatContent = [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}` } },
        { type: 'text', text: `这是简历第 ${index + 1}/${pages.length} 页。请严格按要求提取这一页的文字内容。` }
      ]
      const result = await completeChat([
        { role: 'system', content: loadPrompt('resume-vision-extract.system.md') },
        { role: 'user', content }
      ], { task: 'resumeExtract', model })
      const pageText = cleaned(result.content, 12_000)
      if (!pageText) throw new Error(`视觉模型未能识别第 ${index + 1} 页简历`)
      textParts.push(`## 第 ${index + 1} 页\n${pageText}`)
      saveState(resumeId, { status: 'extracting', method: 'vision_pdf', model, pageCount: pages.length, pagesCompleted: index + 1, startedAt: now() })
    }
    const text = cleaned(textParts.join('\n\n'))
    if (!text) throw new Error('视觉模型未能从 PDF 简历提取文字')
    return { text, model, pages: pages.length }
  } finally {
    rmSync(renderDir, { recursive: true, force: true })
  }
}

async function extractDocx(filename: string): Promise<string> {
  const payload = await runPythonJson('extract-resume-docx.py', [filename])
  const text = cleaned(payload.text)
  if (!text) throw new Error(cleaned(payload.error, 1_000) || '未能从 DOCX 简历提取文字')
  return text
}

async function runResumeExtraction(resumeId: number): Promise<void> {
  if (activeExtractions.has(resumeId)) return
  activeExtractions.add(resumeId)
  try {
    const resume = row(resumeId)
    if (!resume) return
    const filename = path.join(UPLOADS_DIR, resume.stored_name)
    if (!existsSync(filename)) throw new Error('简历文件已丢失')
    const extension = path.extname(resume.stored_name).toLowerCase()
    if (extension === '.doc') {
      saveState(resumeId, { status: 'unsupported', error: '旧版 .doc 暂不支持自动提取，请另存为 .docx 或 PDF 后重新上传' })
      return
    }
    if (extension === '.pdf') {
      saveState(resumeId, { status: 'extracting', method: 'vision_pdf', pagesCompleted: 0, startedAt: now() })
      const result = await extractPdfWithVision(resumeId, filename)
      saveState(resumeId, { status: 'completed', method: 'vision_pdf', model: result.model, pageCount: result.pages,
        pagesCompleted: result.pages, text: result.text, extractedAt: now() })
      return
    }
    if (extension !== '.docx') throw new Error('不支持的简历格式')
    saveState(resumeId, { status: 'extracting', method: 'docx_xml', pagesCompleted: 0, startedAt: now() })
    const text = await extractDocx(filename)
    saveState(resumeId, { status: 'completed', method: 'docx_xml', pagesCompleted: 0, text, extractedAt: now() })
  } catch (error) {
    saveState(resumeId, { status: 'failed', error: ((error as Error).message || '简历文本提取失败').slice(0, 1_000) })
  } finally {
    activeExtractions.delete(resumeId)
  }
}

/** 仅排队，不等待 PDF 渲染或模型调用；HTTP 请求因此不会阻塞服务。 */
export function requestResumeTextExtraction(resumeId: number): Record<string, unknown> {
  const resume = row(resumeId)
  if (!resume) throw new Error('简历不存在')
  if (!activeExtractions.has(resumeId)) {
    saveState(resumeId, { status: 'pending', pagesCompleted: 0, startedAt: now() })
    queueMicrotask(() => { void runResumeExtraction(resumeId) })
  }
  return resumeWithText(resumeId)!
}

/** 服务重启后没有可安全恢复的模型上下文，改为可重试状态，避免假装仍在处理中。 */
export function recoverInterruptedResumeExtractions(): number {
  const result = db.prepare(`UPDATE resume_texts SET status='failed',error_message='服务重启中断，可点击重新提取',updated_at=?
    WHERE status IN ('pending','extracting')`).run(now())
  return result.changes
}
