import { Router } from 'express'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, KNOWLEDGE_IMAGES_DIR, now } from '../db.js'
import { chat, extractJson, type ChatContent } from '../ai.js'
import { loadPrompt } from '../prompt-loader.js'
import { KNOWLEDGE_CATEGORIES } from '../types.js'

// 知识库 AI：拆题 / 生成答案 / 助教对话（需求 3.9.2 / 3.9.4）

export const knowledgeAiRouter = Router()

const EXTRACT_MAX_TEXT = 10_000
// 单批上限：一次塞太多题目，答案质量会明显下降（前端会分批调用）
const ANSWER_BATCH_LIMIT = 5
const TUTOR_CONTEXT_TOP_N = 5

interface CandidateQuestion {
  question: string
  answer?: string
  category?: string
}

function validCategory(c: unknown): string {
  return typeof c === 'string' && KNOWLEDGE_CATEGORIES.includes(c) ? c : '其他'
}

/** 规整模型拆出的候选题目（过滤空题、修 category） */
function normalizeQuestions(raw: unknown): CandidateQuestion[] {
  const list = Array.isArray(raw) ? raw : []
  const out: CandidateQuestion[] = []
  for (const item of list) {
    const question = String(item?.question ?? '').trim()
    if (!question) continue
    const answer = String(item?.answer ?? '').trim()
    out.push({
      question: question.slice(0, 500),
      answer: answer || undefined,
      category: validCategory(item?.category)
    })
  }
  return out
}

/** 规整模型拆出的元信息（company/position/round） */
function normalizeMeta(raw: { company?: unknown; position?: unknown; round?: unknown }) {
  const clean = (v: unknown, max = 100) => String(v ?? '').trim().slice(0, max)
  return {
    company: clean(raw.company),
    position: clean(raw.position),
    round: clean(raw.round, 20)
  }
}

// 文本面经 -> 元信息 + 候选题目列表
knowledgeAiRouter.post('/ai/knowledge/extract-text', async (req: Request, res: Response) => {
  const text = (req.body?.text ?? '').trim()
  if (!text) {
    res.status(422).json({ message: 'text 不能为空' })
    return
  }
  try {
    const output = await chat([
      { role: 'system', content: loadPrompt('knowledge-extract.system.md') },
      { role: 'user', content: text.slice(0, EXTRACT_MAX_TEXT) }
    ])
    const parsed = extractJson<{ company?: unknown; position?: unknown; round?: unknown; questions?: unknown }>(output)
    res.json({ ...normalizeMeta(parsed), questions: normalizeQuestions(parsed.questions) })
  } catch (err) {
    console.error('[extract-text]', (err as Error).message)
    res.status(502).json({ message: (err as Error).message })
  }
})

// 已存截图 -> 候选题目列表（按 image_id 读磁盘文件，避免二次上传）
knowledgeAiRouter.post('/ai/knowledge/extract-image', async (req: Request, res: Response) => {
  const imageId = Number(req.body?.image_id)
  const img = imageId
    ? (db.prepare('SELECT * FROM knowledge_images WHERE id = ?').get(imageId) as
        | { stored_name: string; filename: string }
        | undefined)
    : undefined
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
  const dataUrl = `data:${types[ext] ?? 'image/png'};base64,${readFileSync(filePath).toString('base64')}`
  try {
    const content: ChatContent = [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: '请从这张面试题截图中拆出题目列表。' }
    ]
    const output = await chat(
      [
        { role: 'system', content: loadPrompt('knowledge-extract.system.md') },
        { role: 'user', content }
      ],
      90_000
    )
    const parsed = extractJson<{ company?: unknown; position?: unknown; round?: unknown; questions?: unknown }>(output)
    res.json({ ...normalizeMeta(parsed), questions: normalizeQuestions(parsed.questions) })
  } catch (err) {
    console.error('[extract-image]', (err as Error).message)
    res.status(502).json({ message: (err as Error).message })
  }
})

// 批量生成答案并落库；有答案的条目跳过
knowledgeAiRouter.post('/ai/knowledge/generate-answers', async (req: Request, res: Response) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : []
  if (ids.length === 0) {
    res.status(422).json({ message: 'ids 不能为空' })
    return
  }
  if (ids.length > ANSWER_BATCH_LIMIT) {
    res.status(422).json({ message: `单批最多 ${ANSWER_BATCH_LIMIT} 条` })
    return
  }
  const placeholders = ids.map(() => '?').join(',')
  const items = db
    .prepare(`SELECT id, question, answer FROM knowledge_items WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number; question: string; answer: string | null }[]
  // 只给没有答案的生成
  const todo = items.filter(i => !i.answer || !i.answer.trim())
  if (todo.length === 0) {
    res.json({ items, generated: 0 })
    return
  }
  try {
    const questionList = todo.map(i => ({ id: i.id, question: i.question }))
    const output = await chat(
      [
        { role: 'system', content: loadPrompt('knowledge-answer.system.md') },
        { role: 'user', content: JSON.stringify(questionList) }
      ],
      180_000
    )
    // 答案是 markdown，塞 JSON 里模型很容易转义出错，改用 @@@ID:x@@@ 分隔符解析
    const byId = parseAnswerBlocks(output)
    if (byId.size === 0) {
      throw new Error('模型没有按格式返回答案，请重试')
    }
    const update = db.prepare('UPDATE knowledge_items SET answer=?, updated_at=? WHERE id=?')
    const ts = now()
    const tx = db.transaction(() => {
      for (const item of todo) {
        const answer = byId.get(item.id)
        if (answer) update.run(answer, ts, item.id)
      }
    })
    tx()
    const refreshed = db
      .prepare(`SELECT id, question, answer, category, mastery FROM knowledge_items WHERE id IN (${placeholders})`)
      .all(...ids)
    res.json({ items: refreshed, generated: byId.size })
  } catch (err) {
    console.error('[generate-answers]', (err as Error).message)
    res.status(502).json({ message: (err as Error).message })
  }
})

/** 解析模型输出的 @@@ID:x@@@ 答案块，容忍格式瑕疵 */
function parseAnswerBlocks(output: string): Map<number, string> {
  const byId = new Map<number, string>()
  const re = /@@@ID[:：]?\s*(\d+)\s*@@@([\s\S]*?)(?=@@@ID[:：]?\s*\d+\s*@@@|$)/g
  for (const m of output.matchAll(re)) {
    const id = Number(m[1])
    const answer = m[2].trim()
    if (id && answer) byId.set(id, answer)
  }
  return byId
}

// 助教对话：按最后一条用户消息检索知识库 top-N 注入上下文
knowledgeAiRouter.post('/ai/knowledge/tutor', async (req: Request, res: Response) => {
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : []
  const valid = messages.filter(
    (m: { role?: unknown; content?: unknown }) =>
      (m?.role === 'user' || m?.role === 'assistant') && typeof m?.content === 'string' && m.content.trim()
  )
  if (valid.length === 0 || valid[valid.length - 1].role !== 'user') {
    res.status(422).json({ message: 'messages 不能为空，且最后一条应为用户消息' })
    return
  }
  if (valid.length > 40) {
    res.status(422).json({ message: '对话过长，请新开一个对话' })
    return
  }

  // 检索知识库：对最后一条用户消息做关键词匹配打分
  const lastUser = (valid as { role: string; content: string }[]).filter(m => m.role === 'user').pop()!
  const keywords = Array.from(
    new Set(
      lastUser.content
        .split(/[\s，。？！、,.?!；;：:（）()\-/\\]+/)
        .map(w => w.trim())
        .filter(w => w.length >= 2)
    )
  ).slice(0, 12)
  const context = keywords.length
    ? db
        .prepare(
          `SELECT question, IFNULL(answer,'') AS answer, category, mastery FROM knowledge_items
           WHERE ${keywords.map(() => "(question LIKE ? OR IFNULL(answer,'') LIKE ?)").join(' OR ')}
           ORDER BY mastery ASC, updated_at DESC`
        )
        .all(...keywords.flatMap(k => [`%${k}%`, `%${k}%`] as const))
        .map(
          (row: { question: string; answer: string; category: string; mastery: number }) =>
            `【${row.category}｜掌握度${row.mastery}】${row.question}\n${row.answer || '（还没有答案）'}`
        )
        .slice(0, TUTOR_CONTEXT_TOP_N)
    : []

  const systemPrompt =
    loadPrompt('learn-tutor.system.md') +
    (context.length
      ? `\n\n---\n知识库参考条目（与用户问题相关的已有记录，回答时可结合）：\n${context.join('\n\n')}`
      : '')

  try {
    const reply = await chat(
      [{ role: 'system', content: systemPrompt }, ...valid.map((m: { role: string; content: string }) => ({ role: m.role as 'user' | 'assistant', content: m.content }))],
      120_000
    )
    res.json({ reply, contextCount: context.length })
  } catch (err) {
    console.error('[tutor]', (err as Error).message)
    res.status(502).json({ message: (err as Error).message })
  }
})
