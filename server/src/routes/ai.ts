import { Router } from 'express'
import type { Request, Response } from 'express'
import { db } from '../db.js'
import {
  AI_TASKS, AiError, completeChat, completeStructured, isAiTaskEnabled,
  resolveAiTask, setAiTaskEnabled, type AiTask
} from '../ai.js'
import { loadAsrConfig } from '../asr.js'
import { loadOssConfig } from '../oss.js'
import { JD_PARSE_SCHEMA, validateJdParse } from '../ai-contracts.js'
import { readReviewFile } from '../review-file.js'
import { loadPrompt, renderTemplate } from '../prompt-loader.js'

// 提示词在 server/src/prompts/ 目录下独立维护，修改无需重启

export const aiRouter = Router()

const AI_TASK_INFO: Record<AiTask, { label: string; data: string; visible: boolean }> = {
  applicationImport: { label: '招聘材料识别', data: '输入文字和压缩后的图片副本', visible: true },
  jdParse: { label: 'JD 解析', data: '岗位描述文字', visible: true },
  knowledgeExtract: { label: '知识提取', data: '知识来源文字和压缩后的图片副本', visible: true },
  answerGenerate: { label: '答案生成', data: '题目、岗位信息和关联知识', visible: true },
  tutor: { label: 'AI 助教', data: '当前问题、必要的对话历史和检索到的知识', visible: true },
  recordingReview: { label: '录音复盘', data: '语音转写文本或分段提取结果', visible: true },
  reviewAdvice: { label: '复盘建议', data: '复盘内容、岗位信息和 JD 摘要', visible: true },
  interviewPrepAgent: { label: '面试准备 Agent', data: '岗位信息、面试信息、必要的历史复盘和检索知识', visible: true }
}

aiRouter.get('/ai/settings', (_req: Request, res: Response) => {
  res.json({
    provider: '火山方舟',
    tasks: AI_TASKS.map(task => ({
      task,
      ...AI_TASK_INFO[task],
      enabled: isAiTaskEnabled(task),
      configured: resolveAiTask(task) !== null
    })),
    recording: {
      ossConfigured: loadOssConfig() !== null,
      asrConfigured: loadAsrConfig() !== null
    }
  })
})

aiRouter.put('/ai/settings/:task', (req: Request, res: Response) => {
  const task = req.params.task as AiTask
  if (!AI_TASKS.includes(task)) {
    res.status(404).json({ message: '未知 AI 任务' })
    return
  }
  if (typeof req.body?.enabled !== 'boolean') {
    res.status(422).json({ message: 'enabled 必须是布尔值' })
    return
  }
  setAiTaskEnabled(task, req.body.enabled)
  res.json({ task, enabled: isAiTaskEnabled(task) })
})

aiRouter.get('/ai/runs', (req: Request, res: Response) => {
  const requested = Number(req.query.limit)
  const limit = Number.isFinite(requested) ? Math.min(200, Math.max(1, Math.floor(requested))) : 50
  const rows = db.prepare(`SELECT id, task, model, prompt_hash, request_id, duration_ms,
    finish_reason, prompt_tokens, completion_tokens, total_tokens, status, error_type, created_at
    FROM ai_runs ORDER BY id DESC LIMIT ?`).all(limit)
  res.json(rows)
})

// AI JD 解析：提取公司/职位/地点 + 岗位要求摘要
aiRouter.post('/ai/jd-parse', async (req: Request, res: Response) => {
  const text = (req.body?.text ?? '').trim()
  if (!text) {
    res.status(422).json({ message: 'text 不能为空' })
    return
  }
  try {
    const { value: parsed } = await completeStructured([
      { role: 'system', content: `${loadPrompt('jd-parse.system.md')}\n\nJSON Schema:\n${JSON.stringify(JD_PARSE_SCHEMA)}` },
      { role: 'user', content: `<untrusted_jd>\n${text.slice(0, 8000)}\n</untrusted_jd>` }
    ], {
      task: 'jdParse',
      schemaName: 'jd_parse',
      schema: JD_PARSE_SCHEMA,
      validate: validateJdParse
    })
    res.json({
      company: parsed.company || undefined,
      position: parsed.position || undefined,
      location: parsed.location || undefined,
      summary: parsed.summary || undefined,
      jd: parsed.jd || undefined
    })
  } catch (err) {
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: (err as Error).message })
  }
})

// 复盘 AI 助手：分析复盘内容，给出薄弱点、改进建议、下轮预测问题
aiRouter.post('/ai/review-advice', async (req: Request, res: Response) => {
  const interviewId = req.body?.interviewId
  if (!interviewId) {
    res.status(422).json({ message: 'interviewId 不能为空' })
    return
  }
  const row = db
    .prepare(
      `SELECT i.round, i.scheduled_at, i.review_file, a.company, a.position, a.jd_text
       FROM interviews i JOIN applications a ON i.application_id = a.id
       WHERE i.id = ?`
    )
    .get(interviewId) as
    | { round: string; scheduled_at: string; review_file: string | null; company: string; position: string; jd_text: string | null }
    | undefined
  if (!row) {
    res.status(404).json({ message: '面试不存在' })
    return
  }

  const review = row.review_file ? readReviewFile(row.review_file) : ''
  if (!review.trim() || review.trim() === review.replace(/[-\s#*:：]/g, '')) {
    res.status(422).json({ message: '复盘还是空模板，先写点内容再让 AI 点评吧' })
    return
  }

  try {
    const userContent = renderTemplate(loadPrompt('review-advice.user.md'), {
      company: row.company,
      position: row.position,
      round: row.round,
      jd: (row.jd_text || '（无）').slice(0, 3000),
      review: review.slice(0, 6000)
    })
    const result = await completeChat([
      { role: 'system', content: loadPrompt('review-advice.system.md') },
      { role: 'user', content: userContent }
    ], { task: 'reviewAdvice' })
    res.json({ advice: result.content })
  } catch (err) {
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: (err as Error).message })
  }
})
