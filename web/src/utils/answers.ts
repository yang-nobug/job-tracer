import { api } from '../api'
import type { KnowledgeItem } from '../types'

/** 每批题目数：一次发给模型的题目太多，答案质量会明显下降 */
const CHUNK_SIZE = 5

/**
 * 分批生成答案：把题目按 CHUNK_SIZE 切片串行请求，
 * 每批完成即落库，中途失败时前面批次的结果不丢。
 * onProgress(已完成数, 总数) 用于展示进度。
 */
export async function generateAnswersChunked(
  ids: number[],
  onProgress?: (done: number, total: number) => void
): Promise<KnowledgeItem[]> {
  const all: KnowledgeItem[] = []
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE)
    const r = await api.post<{ items: KnowledgeItem[] }>('/ai/knowledge/generate-answers', { ids: chunk })
    all.push(...r.items)
    onProgress?.(Math.min(i + CHUNK_SIZE, ids.length), ids.length)
  }
  return all
}
