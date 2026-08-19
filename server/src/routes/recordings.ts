import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, RECORDINGS_DIR, now, today } from '../db.js'
import { createReviewFile, writeReviewFile } from '../review-file.js'
import { loadPrompt, renderTemplate } from '../prompt-loader.js'
import { chat, loadArkConfig } from '../ai.js'
import { loadOssConfig, ossPut, ossSignedUrl, ossDelete } from '../oss.js'
import { loadAsrConfig, transcribe, type AsrFormat } from '../asr.js'
import { KNOWLEDGE_CATEGORIES } from '../types.js'

export const recordingsRouter = Router()

interface RecordingRow {
  id: number
  interview_id: number
  filename: string
  stored_name: string
  size: number
  status: string
  transcript: string | null
  knowledge_source_id: number | null
  error: string | null
  created_at: string
  updated_at: string
}

interface InterviewInfo {
  interview_id: number
  round: string
  scheduled_at: string
  review_file: string | null
  application_id: number
  company: string
  position: string | null
}

function getInterviewInfo(interviewId: number): InterviewInfo | undefined {
  return db
    .prepare(
      `SELECT i.id AS interview_id, i.round, i.scheduled_at, i.review_file,
              a.id AS application_id, a.company, a.position
       FROM interviews i JOIN applications a ON i.application_id = a.id
       WHERE i.id = ?`
    )
    .get(interviewId) as InterviewInfo | undefined
}

function updateRecording(id: number, fields: Partial<RecordingRow>): void {
  const keys = Object.keys(fields)
  if (!keys.length) return
  const setSql = keys.map((k) => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE recordings SET ${setSql}, updated_at = @updated_at WHERE id = @id`).run({
    ...fields,
    updated_at: now(),
    id
  })
}

function getRecording(id: number): RecordingRow | undefined {
  return db.prepare('SELECT * FROM recordings WHERE id = ?').get(id) as RecordingRow | undefined
}

// ---------- 上传 ----------

// ASR 直接支持 mp3/wav/ogg；m4a/aac/webm/amr 需要 ffmpeg 转码
const DIRECT_FORMATS: Record<string, AsrFormat> = { '.mp3': 'mp3', '.wav': 'wav', '.ogg': 'ogg' }
const TRANSCODE_EXTS = ['.m4a', '.aac', '.webm', '.amr', '.mp4']

// multer 把 multipart 文件名按 latin1 解码，中文会变乱码：能无损还原成 UTF-8 时采用还原结果
function fixOriginalName(name: string): string {
  const bytes = Buffer.from(name, 'latin1')
  const decoded = bytes.toString('utf8')
  return decoded !== name && Buffer.from(decoded, 'utf8').equals(bytes) ? decoded : name
}

const upload = multer({
  storage: multer.diskStorage({
    destination: RECORDINGS_DIR,
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase()
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`)
    }
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    if (DIRECT_FORMATS[ext] || TRANSCODE_EXTS.includes(ext)) cb(null, true)
    else cb(new Error('仅支持音频文件（mp3/wav/ogg/m4a/aac/webm/amr）'))
  }
})

/** 机器上是否有可用的 ffmpeg（结果缓存，转码 m4a 用） */
let ffmpegChecked = false
let ffmpegAvailable = false
function hasFfmpeg(): boolean {
  if (!ffmpegChecked) {
    try {
      ffmpegAvailable = spawnSync('ffmpeg', ['-version'], { timeout: 10_000 }).status === 0
    } catch {
      ffmpegAvailable = false
    }
    ffmpegChecked = true
    console.log(`[recordings] ffmpeg ${ffmpegAvailable ? '可用' : '不可用（m4a 等格式将无法转码）'}`)
  }
  return ffmpegAvailable
}

/** ffmpeg 转码为 ASR 支持的 mp3 单声道；返回新文件名，失败抛错 */
function transcodeToMp3(storedName: string): string {
  const src = path.join(RECORDINGS_DIR, storedName)
  const outName = `${storedName}.mp3`
  const out = path.join(RECORDINGS_DIR, outName)
  const result = spawnSync(
    'ffmpeg',
    ['-y', '-i', src, '-ac', '1', '-ar', '16000', '-b:a', '64k', out],
    { timeout: 10 * 60 * 1000, windowsHide: true }
  )
  if (result.status !== 0 || !existsSync(out)) {
    const stderr = result.stderr?.toString().slice(-300) || ''
    throw new Error(`ffmpeg 转码失败: ${stderr}`)
  }
  unlinkSync(src) // 原格式文件不再保留，只留转码后的 mp3
  return outName
}

// ---------- 分析结果解析 ----------

interface AnalysisResult {
  review: string
  questions: { question: string; answer: string; category: string }[]
}

/** 从模型输出中拆出复盘 md 与题目 JSON（沿用分隔符格式防 markdown 转义） */
function parseAnalysis(output: string): AnalysisResult {
  const reviewMatch = output.match(/@@@REVIEW@@@([\s\S]*?)(?=@@@QUESTIONS@@@|$)/)
  const questionsMatch = output.match(/@@@QUESTIONS@@@([\s\S]*?)$/)
  if (!reviewMatch) throw new Error('AI 输出缺少 @@@REVIEW@@@ 段落')

  // 模型偶尔会在复盘末尾重复输出标记，统一清掉再写入文件
  const review = reviewMatch[1].replace(/@@@[\w:：\s]*@@@/g, '').trim()

  let questions: AnalysisResult['questions'] = []
  if (questionsMatch) {
    let t = questionsMatch[1].trim()
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fence) t = fence[1].trim()
    const start = t.indexOf('[')
    const end = t.lastIndexOf(']')
    if (start >= 0 && end > start) {
      try {
        const parsed = JSON.parse(t.slice(start, end + 1)) as { question?: string; answer?: string; category?: string }[]
        questions = parsed
          .filter((q) => q && typeof q.question === 'string' && q.question.trim())
          .map((q) => ({
            question: q.question!.trim(),
            answer: typeof q.answer === 'string' ? q.answer.trim() : '',
            category:
              typeof q.category === 'string' && (KNOWLEDGE_CATEGORIES as string[]).includes(q.category)
                ? q.category
                : '其他'
          }))
      } catch {
        // JSON 解析失败不致命：复盘已到手，题目列表置空
        console.error('[recordings] 题目 JSON 解析失败，仅写入复盘')
      }
    }
  }
  return { review, questions }
}

// ---------- 后台管道 ----------

/**
 * 录音复盘管道：OSS 转传 -> ASR 转写 -> AI 分析 -> 写复盘 md + 面经入库
 * resume = true 时若已有转写全文则跳过转写直接分析（失败重试用）
 */
async function runPipeline(recordingId: number, resume = false): Promise<void> {
  const rec = getRecording(recordingId)
  if (!rec) return
  const info = getInterviewInfo(rec.interview_id)
  if (!info) {
    updateRecording(recordingId, { status: 'failed', error: '关联的面试记录不存在' })
    return
  }

  try {
    // ---- 阶段一：转写（有留存全文且重试时跳过）----
    let transcript = resume && rec.transcript ? rec.transcript : null
    if (!transcript) {
      const ossConfig = loadOssConfig()
      if (!ossConfig) throw new Error('OSS 未配置：请在 config.json 填入 oss 段（AccessKeyId/Secret/bucket/region）')
      const asrConfig = loadAsrConfig()
      if (!asrConfig) throw new Error('ASR 未配置：请在 config.json 填入 asr 段（apiKey 或 appId+accessToken）')

      updateRecording(recordingId, { status: 'uploading', error: null })

      // m4a 等不支持格式先转码
      let storedName = rec.stored_name
      let ext = path.extname(storedName).toLowerCase()
      if (!DIRECT_FORMATS[ext]) {
        if (!hasFfmpeg()) {
          throw new Error('该音频格式需要转码，但本机未安装 ffmpeg：请安装 ffmpeg 或自行转成 mp3 后重试')
        }
        storedName = transcodeToMp3(storedName)
        ext = '.mp3'
        const { size } = statSync(path.join(RECORDINGS_DIR, storedName))
        updateRecording(recordingId, { stored_name: storedName, size })
      }

      // 转传 OSS 私有桶 -> 签名 URL -> 提交 ASR -> 轮询 -> 清理 OSS
      const objectKey = `job-tracer/${recordingId}-${storedName}`
      updateRecording(recordingId, { status: 'transcribing' })
      await ossPut(ossConfig, objectKey, path.join(RECORDINGS_DIR, storedName), contentTypeFor(ext))
      const url = ossSignedUrl(ossConfig, objectKey)
      try {
        transcript = await transcribe(asrConfig, url, DIRECT_FORMATS[ext])
      } finally {
        await ossDelete(ossConfig, objectKey).catch((e) => console.error('[recordings] OSS 清理失败:', e.message))
      }
      updateRecording(recordingId, { transcript })
      console.log(`[recordings] #${recordingId} 转写完成，${transcript.length} 字`)
    }

    // ---- 阶段二：AI 分析 ----
    const arkConfig = loadArkConfig()
    if (!arkConfig) throw new Error('AI 未配置：请在 config.json 填入 ark 段')

    updateRecording(recordingId, { status: 'analyzing' })
    const system = renderTemplate(loadPrompt('recording-analysis.system.md'), {
      公司: info.company,
      轮次: info.round
    })
    const user = [
      `公司：${info.company}`,
      `岗位：${info.position || '未知'}`,
      `轮次：${info.round}`,
      `面试时间：${info.scheduled_at}`,
      '',
      '转写文本：',
      transcript
    ].join('\n')
    const output = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      5 * 60_000
    )
    const { review, questions } = parseAnalysis(output)

    // 写复盘 md（复盘只来源于录音，直接覆盖模板）
    const reviewFile = info.review_file || createReviewFile(info.company, info.round, info.scheduled_at)
    if (!info.review_file) {
      db.prepare('UPDATE interviews SET review_file = ? WHERE id = ?').run(reviewFile, info.interview_id)
    }
    writeReviewFile(reviewFile, review)

    // 自动创建「我的面试」面经 + 题目入库
    const ts = now()
    const sourceResult = db
      .prepare(
        `INSERT INTO knowledge_sources (owner, company, position, round, source_type, note, application_id, created_at, updated_at)
         VALUES ('mine', ?, ?, ?, 'audio', ?, ?, ?, ?)`
      )
      .run(
        info.company,
        info.position,
        info.round,
        `来自 ${info.scheduled_at.slice(0, 10)} 录音复盘`,
        info.application_id,
        ts,
        ts
      )
    const insertItem = db.prepare(
      `INSERT INTO knowledge_items (source_id, question, answer, category, mastery, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    const insertAll = db.transaction(() => {
      for (const q of questions) insertItem.run(sourceResult.lastInsertRowid, q.question, q.answer || null, q.category, ts, ts)
    })
    insertAll()

    // 时间线留痕
    db.prepare(
      `INSERT INTO events (application_id, type, event_date, content, created_at)
       VALUES (?, 'other', ?, ?, ?)`
    ).run(info.application_id, today(), `录音复盘完成：${info.round} 转写入库 ${questions.length} 题`, now())

    updateRecording(recordingId, {
      status: 'done',
      error: null,
      knowledge_source_id: Number(sourceResult.lastInsertRowid)
    })
    console.log(`[recordings] #${recordingId} 管道完成：复盘已写入，${questions.length} 题入库`)
  } catch (err) {
    const message = (err as Error).message || '未知错误'
    console.error(`[recordings] #${recordingId} 管道失败:`, message)
    updateRecording(recordingId, { status: 'failed', error: message })
  }
}

function contentTypeFor(ext: string): string {
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg'
  }
  return map[ext] || 'application/octet-stream'
}

// ---------- 路由 ----------

// 上传录音：校验面试记录 -> 存文件 -> 建记录 -> 异步启动管道
recordingsRouter.post('/', upload.single('audio'), (req: Request, res: Response) => {
  const interviewId = Number(req.body?.interview_id)
  if (!interviewId || !getInterviewInfo(interviewId)) {
    res.status(422).json({ message: '面试记录不存在，请先在投递详情里添加面试日程' })
    return
  }
  if (!req.file) {
    res.status(422).json({ message: '请选择录音文件' })
    return
  }
  const filename = fixOriginalName(req.file.originalname)
  const result = db
    .prepare(
      `INSERT INTO recordings (interview_id, filename, stored_name, size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'uploading', ?, ?)`
    )
    .run(interviewId, filename, req.file.filename, req.file.size, now(), now())

  void runPipeline(Number(result.lastInsertRowid)) // 后台跑，不阻塞响应
  res.status(201).json(getRecording(Number(result.lastInsertRowid)))
})

// 列表（含面试/投递信息）
recordingsRouter.get('/', (_req: Request, res: Response) => {
  const rows = db
    .prepare(
      `SELECT r.id, r.interview_id, r.filename, r.size, r.status, r.error,
              r.knowledge_source_id, r.created_at, r.updated_at,
              i.round, i.scheduled_at, a.company, a.position,
              (r.transcript IS NOT NULL AND r.transcript != '') AS has_transcript
       FROM recordings r
       JOIN interviews i ON r.interview_id = i.id
       JOIN applications a ON i.application_id = a.id
       ORDER BY r.created_at DESC`
    )
    .all()
  res.json(rows)
})

// 单条详情（前端轮询状态用；含转写全文）
recordingsRouter.get('/:id', (req: Request, res: Response) => {
  const rec = db
    .prepare(
      `SELECT r.*, i.round, i.scheduled_at, a.company, a.position
       FROM recordings r
       JOIN interviews i ON r.interview_id = i.id
       JOIN applications a ON i.application_id = a.id
       WHERE r.id = ?`
    )
    .get(req.params.id)
  if (!rec) {
    res.status(404).json({ message: '录音不存在' })
    return
  }
  res.json(rec)
})

// 失败重试：有转写全文则从分析阶段续跑，否则整条重跑
recordingsRouter.post('/:id/retry', (req: Request, res: Response) => {
  const rec = getRecording(Number(req.params.id))
  if (!rec) {
    res.status(404).json({ message: '录音不存在' })
    return
  }
  if (rec.status !== 'failed') {
    res.status(422).json({ message: '只有失败的录音才能重试' })
    return
  }
  updateRecording(rec.id, { status: rec.transcript ? 'analyzing' : 'uploading', error: null })
  void runPipeline(rec.id, true)
  res.json(getRecording(rec.id))
})

// 删除：本地音频文件 + 记录（已生成的复盘 md 与面经保留）
recordingsRouter.delete('/:id', (req: Request, res: Response) => {
  const rec = getRecording(Number(req.params.id))
  if (!rec) {
    res.status(404).json({ message: '录音不存在' })
    return
  }
  const filePath = path.join(RECORDINGS_DIR, rec.stored_name)
  if (existsSync(filePath)) {
    try {
      unlinkSync(filePath)
    } catch {
      // 文件删不掉不阻塞记录删除
    }
  }
  db.prepare('DELETE FROM recordings WHERE id = ?').run(rec.id)
  res.json({ ok: true })
})
