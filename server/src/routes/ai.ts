import { Router } from 'express'
import type { Request, Response } from 'express'
import { db } from '../db.js'
import { chat, extractJson } from '../ai.js'
import { readReviewFile } from '../review-file.js'
import { loadPrompt, renderTemplate } from '../prompt-loader.js'

// 提示词在 server/src/prompts/ 目录下独立维护，修改无需重启

export const aiRouter = Router()

// AI JD 解析：提取公司/职位/地点 + 岗位要求摘要
aiRouter.post('/ai/jd-parse', async (req: Request, res: Response) => {
  const text = (req.body?.text ?? '').trim()
  if (!text) {
    res.status(422).json({ message: 'text 不能为空' })
    return
  }
  try {
    const output = await chat([
      { role: 'system', content: loadPrompt('jd-parse.system.md') },
      { role: 'user', content: text.slice(0, 8000) }
    ])
    const parsed = extractJson<{
      company?: string
      position?: string
      location?: string
      summary?: string
      jd?: string
    }>(output)
    res.json({
      company: parsed.company?.trim() || undefined,
      position: parsed.position?.trim() || undefined,
      location: parsed.location?.trim() || undefined,
      summary: parsed.summary?.trim() || undefined,
      jd: parsed.jd?.trim() || undefined
    })
  } catch (err) {
    res.status(502).json({ message: (err as Error).message })
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
    const output = await chat([
      { role: 'system', content: loadPrompt('review-advice.system.md') },
      { role: 'user', content: userContent }
    ])
    res.json({ advice: output })
  } catch (err) {
    res.status(502).json({ message: (err as Error).message })
  }
})
