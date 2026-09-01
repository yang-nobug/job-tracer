import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import type { Request, Response } from 'express'
import { db, KNOWLEDGE_IMAGES_DIR, now } from '../db.js'
import { AiError, completeChat, completeStructured, tutorModel, visionArkModel, type ChatContent } from '../ai.js'
import {
  ANSWER_GENERATION_SCHEMA,
  KNOWLEDGE_EXTRACTION_SCHEMA,
  validateAnswerGeneration,
  validateKnowledgeExtraction
} from '../ai-contracts.js'
import { loadPrompt } from '../prompt-loader.js'
import { searchKnowledge, tutorCitations } from '../knowledge-retrieval.js'

// 知识库 AI：拆题 / 生成答案 / 助教对话（需求 3.9.2 / 3.9.4）

export const knowledgeAiRouter = Router()

const EXTRACT_MAX_TEXT = 10_000
// 单批上限：一次塞太多题目，答案质量会明显下降（前端会分批调用）
const ANSWER_BATCH_LIMIT = 5
const TUTOR_CONTEXT_TOP_N = 5

// 文本面经 -> 元信息 + 候选题目列表
knowledgeAiRouter.post('/ai/knowledge/extract-text', async (req: Request, res: Response) => {
  const text = (req.body?.text ?? '').trim()
  if (!text) {
    res.status(422).json({ message: 'text 不能为空' })
    return
  }
  try {
    const { value } = await completeStructured([
      { role: 'system', content: `${loadPrompt('knowledge-extract.system.md')}\n\nJSON Schema:\n${JSON.stringify(KNOWLEDGE_EXTRACTION_SCHEMA)}` },
      { role: 'user', content: `<untrusted_interview_material>\n${text.slice(0, EXTRACT_MAX_TEXT)}\n</untrusted_interview_material>` }
    ], {
      task: 'knowledgeExtract',
      schemaName: 'knowledge_extraction',
      schema: KNOWLEDGE_EXTRACTION_SCHEMA,
      validate: validateKnowledgeExtraction
    })
    res.json(value)
  } catch (err) {
    console.error('[extract-text]', (err as Error).message)
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: (err as Error).message })
  }
})

// 已存截图 -> 候选题目列表（按 image_id 读磁盘文件，避免二次上传）
knowledgeAiRouter.post('/ai/knowledge/extract-image', async (req: Request, res: Response) => {
  const imageId = Number(req.body?.image_id)
  const img = imageId
    ? (db.prepare('SELECT * FROM knowledge_images WHERE id = ?').get(imageId) as
        | { stored_name: string; inference_stored_name: string | null; inference_mime: string | null; filename: string }
        | undefined)
    : undefined
  if (!img) {
    res.status(404).json({ message: '截图不存在' })
    return
  }
  const inferenceName = img.inference_stored_name ?? img.stored_name
  const filePath = path.join(KNOWLEDGE_IMAGES_DIR, inferenceName)
  if (!existsSync(filePath)) {
    res.status(404).json({ message: '截图文件已丢失' })
    return
  }
  const ext = path.extname(inferenceName).toLowerCase()
  const types: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
  }
  const dataUrl = `data:${img.inference_mime ?? types[ext] ?? 'image/png'};base64,${readFileSync(filePath).toString('base64')}`
  try {
    // 当前模型不支持视觉时，自动找列表里的视觉模型兜底
    const visionModel = visionArkModel()
    if (!visionModel) {
      res.status(422).json({ message: '当前模型不支持图片输入，请在模型列表里配一个 vision 模型' })
      return
    }
    const content: ChatContent = [
      { type: 'image_url', image_url: { url: dataUrl } },
      { type: 'text', text: '请从这张面试题截图中拆出题目列表。' }
    ]
    const { value } = await completeStructured(
      [
        { role: 'system', content: `${loadPrompt('knowledge-extract.system.md')}\n\nJSON Schema:\n${JSON.stringify(KNOWLEDGE_EXTRACTION_SCHEMA)}` },
        { role: 'user', content }
      ],
      {
        task: 'knowledgeExtract',
        model: visionModel,
        schemaName: 'knowledge_extraction',
        schema: KNOWLEDGE_EXTRACTION_SCHEMA,
        validate: validateKnowledgeExtraction
      }
    )
    res.json(value)
  } catch (err) {
    console.error('[extract-image]', (err as Error).message)
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: (err as Error).message })
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
    const { value } = await completeStructured(
      [
        { role: 'system', content: `${loadPrompt('knowledge-answer.system.md')}\n\nJSON Schema:\n${JSON.stringify(ANSWER_GENERATION_SCHEMA)}` },
        { role: 'user', content: `<untrusted_questions>\n${JSON.stringify(questionList)}\n</untrusted_questions>` }
      ],
      {
        task: 'answerGenerate',
        schemaName: 'knowledge_answers',
        schema: ANSWER_GENERATION_SCHEMA,
        validate: result => validateAnswerGeneration(result, todo.map(item => item.id))
      }
    )
    const byId = new Map(value.answers.map(answer => [answer.id, answer.answer]))
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
    res.json({ items: refreshed, generated: value.answers.length })
  } catch (err) {
    console.error('[generate-answers]', (err as Error).message)
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: (err as Error).message })
  }
})

// 助教对话：历史存 SQLite（tutor_sessions/tutor_messages），带最近 N 条上下文 + 知识库检索
const TUTOR_HISTORY_SCAN = 40
const TUTOR_HISTORY_CHAR_BUDGET = 12_000
const TUTOR_CONTEXT_CHAR_BUDGET = 10_000

function boundedHistory(sessionId: number): { role: 'user' | 'assistant'; content: string }[] {
  const newest = db
    .prepare(`SELECT role, content FROM tutor_messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
    .all(sessionId, TUTOR_HISTORY_SCAN) as { role: 'user' | 'assistant'; content: string }[]
  const selected: typeof newest = []
  let used = 0
  for (const message of newest) {
    if (selected.length && used + message.content.length > TUTOR_HISTORY_CHAR_BUDGET) break
    selected.push(message)
    used += message.content.length
  }
  return selected.reverse()
}

knowledgeAiRouter.post('/ai/knowledge/tutor', async (req: Request, res: Response) => {
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : ''
  if (!content) {
    res.status(422).json({ message: 'content 不能为空' })
    return
  }
  const requestedSessionId = Number(req.body?.session_id) || 0
  const suppliedRequestId = typeof req.body?.request_id === 'string' ? req.body.request_id.trim() : ''
  const requestId = /^[a-zA-Z0-9_-]{8,128}$/.test(suppliedRequestId) ? suppliedRequestId : randomUUID()
  const ts = now()

  try {
    const completed = db
      .prepare(`SELECT id, session_id, content FROM tutor_messages WHERE request_id = ? AND role = 'assistant'`)
      .get(requestId) as { id: number; session_id: number; content: string } | undefined
    if (completed) {
      res.json({
        session_id: completed.session_id,
        assistant_message_id: completed.id,
        reply: completed.content,
        citations: tutorCitations(completed.id),
        contextCount: 0,
        request_id: requestId,
        replayed: true
      })
      return
    }

    if (requestedSessionId && !db.prepare('SELECT id FROM tutor_sessions WHERE id = ?').get(requestedSessionId)) {
      res.status(404).json({ message: '会话不存在，请新开对话' })
      return
    }
    const history = requestedSessionId ? boundedHistory(requestedSessionId) : []

    const retrieval = searchKnowledge(content, { limit: TUTOR_CONTEXT_TOP_N * 2 })
    const context: {
      item_id: number; source_id: number | null; category: string; mastery: number
      company: string; position: string; round: string; question: string; answer: string; score: number
    }[] = []
    let contextChars = 0
    for (const item of retrieval.items) {
      const candidate = {
        item_id: item.id,
        source_id: item.sourceId,
        category: item.category,
        mastery: item.mastery,
        company: item.company,
        position: item.position,
        round: item.round,
        question: item.question,
        answer: item.answer.slice(0, 2500),
        score: item.score
      }
      const size = JSON.stringify(candidate).length
      if (context.length && contextChars + size > TUTOR_CONTEXT_CHAR_BUDGET) break
      context.push(candidate)
      contextChars += size
      if (context.length >= TUTOR_CONTEXT_TOP_N) break
    }
    const citedContext = context.map((item, index) => ({ ref: `K${index + 1}`, ...item }))
    const serializedContext = JSON.stringify(citedContext)
    const userMessage = context.length
      ? `<knowledge_context>\n${serializedContext}\n</knowledge_context>\n\n<question>\n${content}\n</question>`
      : `<question>\n${content}\n</question>`
    const completion = await completeChat(
      [{ role: 'system', content: loadPrompt('learn-tutor.system.md') }, ...history, { role: 'user', content: userMessage }],
      { task: 'tutor', model: tutorModel() || undefined }
    )
    const referenced = new Set(Array.from(completion.content.matchAll(/\[K(\d+)\]/g), match => `K${Number(match[1])}`))
    const usedCitations = citedContext.filter(item => referenced.has(item.ref))

    // 只有模型成功后，才在一个事务中写入完整问答；失败不会污染历史。
    const save = db.transaction(() => {
      let sessionId = requestedSessionId
      if (!sessionId) {
        const created = db
          .prepare(`INSERT INTO tutor_sessions (title, created_at, updated_at) VALUES (?, ?, ?)`)
          .run(content.slice(0, 20), ts, ts)
        sessionId = Number(created.lastInsertRowid)
      }
      db.prepare(`INSERT INTO tutor_messages (session_id, role, content, created_at, request_id) VALUES (?, 'user', ?, ?, ?)`).run(sessionId, content, ts, requestId)
      const assistant = db.prepare(`INSERT INTO tutor_messages (session_id, role, content, created_at, request_id) VALUES (?, 'assistant', ?, ?, ?)`).run(sessionId, completion.content, now(), requestId)
      const assistantMessageId = Number(assistant.lastInsertRowid)
      const insertCitation = db.prepare(`INSERT INTO tutor_message_citations
        (message_id, knowledge_item_id, citation_key, rank, score) VALUES (?, ?, ?, ?, ?)`)
      usedCitations.forEach(item => {
        insertCitation.run(assistantMessageId, item.item_id, item.ref, Number(item.ref.slice(1)), item.score)
      })
      db.prepare(`INSERT INTO knowledge_retrieval_runs
        (request_id, session_id, assistant_message_id, query_hash, mode, result_ids_json, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          requestId,
          sessionId,
          assistantMessageId,
          retrieval.queryHash,
          retrieval.mode,
          JSON.stringify(citedContext.map(item => item.item_id)),
          retrieval.durationMs,
          ts
        )
      db.prepare('UPDATE tutor_sessions SET updated_at=? WHERE id=?').run(now(), sessionId)
      return { sessionId, assistantMessageId }
    })

    let saved: { sessionId: number; assistantMessageId: number }
    try {
      saved = save()
    } catch (saveError) {
      const replay = db
        .prepare(`SELECT id, session_id, content FROM tutor_messages WHERE request_id = ? AND role = 'assistant'`)
        .get(requestId) as { id: number; session_id: number; content: string } | undefined
      if (!replay) throw saveError
      res.json({
        session_id: replay.session_id,
        assistant_message_id: replay.id,
        reply: replay.content,
        citations: tutorCitations(replay.id),
        contextCount: context.length,
        request_id: requestId,
        replayed: true
      })
      return
    }

    res.json({
      session_id: saved.sessionId,
      assistant_message_id: saved.assistantMessageId,
      reply: completion.content,
      citations: tutorCitations(saved.assistantMessageId),
      contextCount: context.length,
      retrievalMode: retrieval.mode,
      request_id: requestId
    })
  } catch (err) {
    console.error('[tutor]', (err as Error).message)
    res.status(err instanceof AiError ? err.statusCode : 502).json({ message: (err as Error).message, request_id: requestId })
  }
})
