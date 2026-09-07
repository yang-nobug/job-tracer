import { db, now } from './db.js'

export type KnowledgeAnswerSnapshotReason = 'before_manual_edit' | 'before_ai_regenerate' | 'before_restore'

/**
 * 保存被替换前的非空答案。答案版本是本地撤销保障，不保存模型请求或截图内容。
 */
export function snapshotKnowledgeAnswer(
  itemId: number,
  answer: string | null | undefined,
  reason: KnowledgeAnswerSnapshotReason,
  model?: string | null
): void {
  const content = answer?.trim()
  if (!content) return
  db.prepare(`INSERT INTO knowledge_answer_versions
    (knowledge_item_id, answer, reason, model, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(itemId, content, reason, model ?? null, now())
}
