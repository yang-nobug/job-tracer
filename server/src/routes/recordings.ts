import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync, unlinkSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, RECORDINGS_DIR, now, today } from '../db.js'
import { createReviewFile, writeReviewFile } from '../review-file.js'
import { loadPrompt, renderTemplate } from '../prompt-loader.js'
import { completeStructured, isAiTaskEnabled, loadArkConfig } from '../ai.js'
import {
  RECORDING_ANALYSIS_SCHEMA, RECORDING_CHUNK_SCHEMA,
  validateRecordingAnalysis, validateRecordingChunk,
  type RecordingAnalysisResult, type RecordingChunkResult
} from '../ai-contracts.js'
import { RECORDING_CHUNK_THRESHOLD, splitRecordingTranscript, type TranscriptChunk } from '../recording-analysis.js'
import { loadOssConfig, ossPut, ossSignedUrl, ossDelete } from '../oss.js'
import { loadAsrConfig, transcribe, type AsrFormat } from '../asr.js'

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
  analysis_json: string | null
  analysis_stage: string
  attempts: number
  error: string | null
  created_at: string
  updated_at: string
}

interface ChunkRow {
  recording_id: number
  chunk_index: number
  start_offset: number
  end_offset: number
  status: 'pending' | 'analyzing' | 'done' | 'failed'
  result_json: string | null
  error: string | null
  attempts: number
}

const activeRecordings = new Set<number>()

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

function ensureChunkRows(recordingId: number, chunks: TranscriptChunk[]): ChunkRow[] {
  let rows = db.prepare('SELECT * FROM recording_analysis_chunks WHERE recording_id = ? ORDER BY chunk_index').all(recordingId) as ChunkRow[]
  const aligned = rows.length === chunks.length && rows.every((row, index) =>
    row.chunk_index === index && row.start_offset === chunks[index].start && row.end_offset === chunks[index].end
  )
  if (!aligned) {
    db.transaction(() => {
      db.prepare('DELETE FROM recording_analysis_chunks WHERE recording_id = ?').run(recordingId)
      const insert = db.prepare(`INSERT INTO recording_analysis_chunks (
        recording_id, chunk_index, start_offset, end_offset, status, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?)`)
      for (const chunk of chunks) insert.run(recordingId, chunk.index, chunk.start, chunk.end, now())
    })()
    rows = db.prepare('SELECT * FROM recording_analysis_chunks WHERE recording_id = ? ORDER BY chunk_index').all(recordingId) as ChunkRow[]
  }
  return rows
}

async function analyzeLongTranscript(
  recordingId: number,
  transcript: string,
  info: InterviewInfo,
  signal?: AbortSignal
): Promise<RecordingAnalysisResult> {
  const chunks = splitRecordingTranscript(transcript)
  const rows = ensureChunkRows(recordingId, chunks)
  const partials: RecordingChunkResult[] = []
  const chunkPrompt = loadPrompt('recording-chunk.system.md')

  for (const chunk of chunks) {
    signal?.throwIfAborted()
    const persisted = rows[chunk.index]
    if (persisted.status === 'done' && persisted.result_json) {
      try {
        partials.push(validateRecordingChunk(JSON.parse(persisted.result_json)))
        continue
      } catch {
        // 旧数据或损坏数据会在本轮重新生成。
      }
    }
    updateRecording(recordingId, { analysis_stage: `chunk:${chunk.index + 1}/${chunks.length}` })
    db.prepare(`UPDATE recording_analysis_chunks SET status='analyzing', error=NULL,
      attempts=attempts+1, updated_at=? WHERE recording_id=? AND chunk_index=?`)
      .run(now(), recordingId, chunk.index)
    try {
      const { value } = await completeStructured([
        { role: 'system', content: `${chunkPrompt}\n\nJSON Schema:\n${JSON.stringify(RECORDING_CHUNK_SCHEMA)}` },
        {
          role: 'user',
          content: `<untrusted_recording_chunk index="${chunk.index + 1}" total="${chunks.length}">\n${chunk.text}\n</untrusted_recording_chunk>`
        }
      ], {
        task: 'recordingReview',
        signal,
        schemaName: 'recording_chunk',
        schema: RECORDING_CHUNK_SCHEMA,
        validate: validateRecordingChunk
      })
      db.prepare(`UPDATE recording_analysis_chunks SET status='done', result_json=?, error=NULL, updated_at=?
        WHERE recording_id=? AND chunk_index=?`).run(JSON.stringify(value), now(), recordingId, chunk.index)
      partials.push(value)
    } catch (error) {
      db.prepare(`UPDATE recording_analysis_chunks SET status='failed', error=?, updated_at=?
        WHERE recording_id=? AND chunk_index=?`).run((error as Error).message.slice(0, 1000), now(), recordingId, chunk.index)
      throw error
    }
  }

  updateRecording(recordingId, { analysis_stage: 'merging' })
  const mergePrompt = renderTemplate(loadPrompt('recording-merge.system.md'), { 公司: info.company, 轮次: info.round })
  let remainingQuestions = 100
  let mergeInputTrimmed = false
  const compactChunks = partials.map((result, index) => {
    const selected = result.questions.slice(0, remainingQuestions)
    remainingQuestions -= selected.length
    if (selected.length < result.questions.length || result.summary.length > 700) mergeInputTrimmed = true
    return {
      index: index + 1,
      summary: result.summary.slice(0, 700),
      questions: selected.map(question => ({
        question: question.question.slice(0, 500),
        answer: question.answer.slice(0, 800),
        category: question.category
      }))
    }
  })
  const mergeInput = {
    company: info.company,
    position: info.position || '未知',
    round: info.round,
    scheduled_at: info.scheduled_at,
    input_trimmed_to_context_budget: mergeInputTrimmed,
    chunks: compactChunks
  }
  const { value } = await completeStructured([
    { role: 'system', content: `${mergePrompt}\n\nJSON Schema:\n${JSON.stringify(RECORDING_ANALYSIS_SCHEMA)}` },
    { role: 'user', content: `<untrusted_chunk_results>\n${JSON.stringify(mergeInput)}\n</untrusted_chunk_results>` }
  ], {
    task: 'recordingReview',
    signal,
    schemaName: 'recording_analysis',
    schema: RECORDING_ANALYSIS_SCHEMA,
    validate: validateRecordingAnalysis
  })
  return value
}

async function analyzeTranscript(recordingId: number, transcript: string, info: InterviewInfo): Promise<RecordingAnalysisResult> {
  if (transcript.length > RECORDING_CHUNK_THRESHOLD) return analyzeLongTranscript(recordingId, transcript, info)
  updateRecording(recordingId, { analysis_stage: 'single_pass' })
  const system = renderTemplate(loadPrompt('recording-analysis.system.md'), { 公司: info.company, 轮次: info.round })
  const user = [
    `公司：${info.company}`,
    `岗位：${info.position || '未知'}`,
    `轮次：${info.round}`,
    `面试时间：${info.scheduled_at}`,
    '',
    '转写文本：',
    transcript
  ].join('\n')
  const { value } = await completeStructured([
    { role: 'system', content: `${system}\n\nJSON Schema:\n${JSON.stringify(RECORDING_ANALYSIS_SCHEMA)}` },
    { role: 'user', content: `<untrusted_recording_transcript>\n${user}\n</untrusted_recording_transcript>` }
  ], {
    task: 'recordingReview',
    schemaName: 'recording_analysis',
    schema: RECORDING_ANALYSIS_SCHEMA,
    validate: validateRecordingAnalysis
  })
  return value
}

function finalizeRecording(recordingId: number, info: InterviewInfo, analysis: RecordingAnalysisResult): void {
  const reviewFile = info.review_file || createReviewFile(info.company, info.round, info.scheduled_at)
  writeReviewFile(reviewFile, analysis.review)
  const ts = now()
  db.transaction(() => {
    const current = getRecording(recordingId)
    if (!current || current.status === 'done') return
    const sourceResult = db.prepare(
      `INSERT INTO knowledge_sources (owner, company, position, round, source_type, note, application_id, created_at, updated_at)
       VALUES ('mine', ?, ?, ?, 'audio', ?, ?, ?, ?)`
    ).run(
      info.company,
      info.position,
      info.round,
      `来自 ${info.scheduled_at.slice(0, 10)} 录音复盘`,
      info.application_id,
      ts,
      ts
    )
    const sourceId = Number(sourceResult.lastInsertRowid)
    const insertItem = db.prepare(
      `INSERT INTO knowledge_items (source_id, question, answer, category, mastery, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    for (const question of analysis.questions) {
      insertItem.run(sourceId, question.question, question.answer || null, question.category, ts, ts)
    }
    db.prepare('UPDATE interviews SET review_file = ? WHERE id = ?').run(reviewFile, info.interview_id)
    db.prepare(`INSERT INTO events (application_id, type, event_date, content, created_at)
      VALUES (?, 'other', ?, ?, ?)`).run(
      info.application_id,
      today(),
      `录音复盘完成：${info.round} 转写入库 ${analysis.questions.length} 题`,
      ts
    )
    db.prepare(`UPDATE recordings SET status='done', error=NULL, knowledge_source_id=?,
      analysis_stage='done', updated_at=? WHERE id=?`).run(sourceId, ts, recordingId)
  })()
}

// ---------- 后台管道 ----------

/**
 * 录音复盘管道：OSS 转传 -> ASR 转写 -> AI 分析 -> 写复盘 md + 面经入库
 * 已有转写、分段或最终分析结果时自动复用（失败重试和重启恢复用）。
 */
async function runPipelineInternal(recordingId: number): Promise<void> {
  const rec = getRecording(recordingId)
  if (!rec) return
  db.prepare('UPDATE recordings SET attempts=attempts+1, updated_at=? WHERE id=?').run(now(), recordingId)
  const info = getInterviewInfo(rec.interview_id)
  if (!info) {
    updateRecording(recordingId, { status: 'failed', error: '关联的面试记录不存在' })
    return
  }

  try {
    if (!isAiTaskEnabled('recordingReview')) throw new Error('录音复盘 AI 已停用，可在“AI 数据说明”中重新开启')
    // ---- 阶段一：转写（有留存全文且重试时跳过）----
    let transcript = rec.transcript
    if (!transcript) {
      const ossConfig = loadOssConfig()
      if (!ossConfig) throw new Error('OSS 未配置：请在 config.json 填入 oss 段（AccessKeyId/Secret/bucket/region）')
      const asrConfig = loadAsrConfig()
      if (!asrConfig) throw new Error('ASR 未配置：请在 config.json 填入 asr 段（apiKey 或 appId+accessToken）')

      updateRecording(recordingId, { status: 'uploading', error: null, analysis_stage: 'uploading' })

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
      updateRecording(recordingId, { status: 'transcribing', analysis_stage: 'transcribing' })
      await ossPut(ossConfig, objectKey, path.join(RECORDINGS_DIR, storedName), contentTypeFor(ext))
      const url = ossSignedUrl(ossConfig, objectKey)
      try {
        transcript = await transcribe(asrConfig, url, DIRECT_FORMATS[ext])
      } finally {
        await ossDelete(ossConfig, objectKey).catch((e) => console.error('[recordings] OSS 清理失败:', e.message))
      }
      updateRecording(recordingId, { transcript, analysis_stage: 'analysis_pending' })
      console.log(`[recordings] #${recordingId} 转写完成，${transcript.length} 字`)
    }

    // ---- 阶段二：AI 分析 ----
    const arkConfig = loadArkConfig()
    if (!arkConfig) throw new Error('AI 未配置：请在 config.json 填入 ark 段')

    updateRecording(recordingId, { status: 'analyzing', analysis_stage: 'analysis_pending' })
    let analysis: RecordingAnalysisResult
    const current = getRecording(recordingId)
    if (current?.analysis_json) {
      try {
        analysis = validateRecordingAnalysis(JSON.parse(current.analysis_json))
      } catch {
        analysis = await analyzeTranscript(recordingId, transcript, info)
        updateRecording(recordingId, { analysis_json: JSON.stringify(analysis), analysis_stage: 'finalizing' })
      }
    } else {
      analysis = await analyzeTranscript(recordingId, transcript, info)
      updateRecording(recordingId, { analysis_json: JSON.stringify(analysis), analysis_stage: 'finalizing' })
    }
    finalizeRecording(recordingId, info, analysis)
    console.log(`[recordings] #${recordingId} 管道完成：复盘已写入，${analysis.questions.length} 题入库`)
  } catch (err) {
    const message = (err as Error).message || '未知错误'
    console.error(`[recordings] #${recordingId} 管道失败:`, message)
    updateRecording(recordingId, { status: 'failed', error: message })
  }
}

async function runPipeline(recordingId: number): Promise<void> {
  if (activeRecordings.has(recordingId)) return
  activeRecordings.add(recordingId)
  try {
    await runPipelineInternal(recordingId)
  } finally {
    activeRecordings.delete(recordingId)
  }
}

/** 服务启动时把不可能仍在运行的任务标记为可重试，并保留转写和分段结果。 */
export function recoverInterruptedRecordings(): number {
  const ts = now()
  db.prepare("UPDATE recording_analysis_chunks SET status='pending', error=NULL, updated_at=? WHERE status='analyzing'").run(ts)
  const result = db.prepare(`UPDATE recordings SET status='failed',
    error='服务重启中断，可点击重试；已有转写和分段进度会继续复用', updated_at=?
    WHERE status IN ('uploading','transcribing','analyzing')`).run(ts)
  return result.changes
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
    if (req.file?.path && existsSync(req.file.path)) unlinkSync(req.file.path)
    res.status(422).json({ message: '面试记录不存在，请先在投递详情里添加面试日程' })
    return
  }
  if (!req.file) {
    res.status(422).json({ message: '请选择录音文件' })
    return
  }
  if (!isAiTaskEnabled('recordingReview')) {
    if (existsSync(req.file.path)) unlinkSync(req.file.path)
    res.status(422).json({ message: '录音复盘 AI 已停用，可在“AI 数据说明”中重新开启' })
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
              r.knowledge_source_id, r.analysis_stage, r.attempts, r.created_at, r.updated_at,
              i.round, i.scheduled_at, a.company, a.position,
              (r.transcript IS NOT NULL AND r.transcript != '') AS has_transcript,
              (SELECT COUNT(*) FROM recording_analysis_chunks c WHERE c.recording_id=r.id) AS chunk_total,
              (SELECT COUNT(*) FROM recording_analysis_chunks c WHERE c.recording_id=r.id AND c.status='done') AS chunk_done
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
      `SELECT r.*, i.round, i.scheduled_at, a.company, a.position,
              (SELECT COUNT(*) FROM recording_analysis_chunks c WHERE c.recording_id=r.id) AS chunk_total,
              (SELECT COUNT(*) FROM recording_analysis_chunks c WHERE c.recording_id=r.id AND c.status='done') AS chunk_done
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
  if (activeRecordings.has(rec.id)) {
    res.status(409).json({ message: '上一次处理正在收尾，请稍后再重试' })
    return
  }
  updateRecording(rec.id, {
    status: rec.transcript ? 'analyzing' : 'uploading',
    analysis_stage: rec.transcript ? 'analysis_pending' : 'uploading',
    error: null
  })
  void runPipeline(rec.id)
  res.json(getRecording(rec.id))
})

// 删除：本地音频文件 + 记录（已生成的复盘 md 与面经保留）
recordingsRouter.delete('/:id', (req: Request, res: Response) => {
  const rec = getRecording(Number(req.params.id))
  if (!rec) {
    res.status(404).json({ message: '录音不存在' })
    return
  }
  if (activeRecordings.has(rec.id)) {
    res.status(409).json({ message: '录音正在处理中，请等待完成或失败后再删除' })
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
