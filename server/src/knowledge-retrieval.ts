import { createHash } from 'node:crypto'
import { db } from './db.js'

export interface KnowledgeSearchOptions {
  limit?: number
  owner?: 'others' | 'mine'
  category?: string
}

export interface RetrievedKnowledge {
  id: number
  sourceId: number | null
  question: string
  answer: string
  category: string
  mastery: number
  company: string
  position: string
  round: string
  owner: string
  score: number
  bm25: number | null
  matchedBy: ('fts5' | 'like')[]
  duplicateCount: number
}

export interface KnowledgeSearchResult {
  queryHash: string
  mode: 'hybrid' | 'fts5' | 'like' | 'empty'
  durationMs: number
  items: RetrievedKnowledge[]
}

export interface TutorCitation {
  ref: string
  item_id: number
  source_id: number | null
  question: string
  company: string
  position: string
  round: string
  rank: number
  score: number
}

export function tutorCitations(messageId: number): TutorCitation[] {
  return db.prepare(`SELECT c.citation_key AS ref, i.id AS item_id, i.source_id,
    i.question, COALESCE(s.company,'') AS company, COALESCE(s.position,'') AS position,
    COALESCE(s.round,'') AS round, c.rank, c.score
    FROM tutor_message_citations c
    JOIN knowledge_items i ON i.id=c.knowledge_item_id
    LEFT JOIN knowledge_sources s ON s.id=i.source_id
    WHERE c.message_id=? ORDER BY c.rank`).all(messageId) as TutorCitation[]
}

export function tutorCitationsByMessage(messageIds: number[]): Record<number, TutorCitation[]> {
  const ids = Array.from(new Set(messageIds.filter(Number.isInteger)))
  if (!ids.length) return {}
  const rows = db.prepare(`SELECT c.message_id, c.citation_key AS ref, i.id AS item_id, i.source_id,
    i.question, COALESCE(s.company,'') AS company, COALESCE(s.position,'') AS position,
    COALESCE(s.round,'') AS round, c.rank, c.score
    FROM tutor_message_citations c
    JOIN knowledge_items i ON i.id=c.knowledge_item_id
    LEFT JOIN knowledge_sources s ON s.id=i.source_id
    WHERE c.message_id IN (${ids.map(() => '?').join(',')}) ORDER BY c.message_id, c.rank`)
    .all(...ids) as (TutorCitation & { message_id: number })[]
  const grouped: Record<number, TutorCitation[]> = {}
  for (const { message_id, ...citation } of rows) (grouped[message_id] ??= []).push(citation)
  return grouped
}

interface CandidateRow {
  id: number
  source_id: number | null
  question: string
  answer: string
  category: string
  mastery: number
  company: string
  position: string
  round: string
  owner: string
  helpful: number
  unhelpful: number
  bm25_score: number | null
}

interface Candidate extends CandidateRow {
  ftsOrder?: number
  likeOrder?: number
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function compact(value: string): string {
  return normalized(value).replace(/[^\p{L}\p{N}+#]+/gu, '')
}

function rawTerms(query: string): string[] {
  const normalizedQuery = normalized(query)
  const parts = normalizedQuery.match(/[\p{Script=Han}]{2,}|[\p{L}\p{N}+#.]{2,}/gu) ?? []
  return Array.from(new Set([normalizedQuery, ...parts].filter(value => value.length >= 2))).slice(0, 12)
}

const LIKE_STOP_WORDS = new Set(['什么', '怎么', '如何', '是否', '一个', '这个', '哪些', '时候', '里面'])

function likeSearchTerms(query: string): string[] {
  const expanded: string[] = []
  for (const term of rawTerms(query)) {
    expanded.push(term)
    if (!/^[\p{Script=Han}]+$/u.test(term)) continue
    const chars = Array.from(term)
    for (let index = 0; index < chars.length - 1; index++) {
      const pair = chars.slice(index, index + 2).join('')
      if (!LIKE_STOP_WORDS.has(pair)) expanded.push(pair)
    }
  }
  return Array.from(new Set(expanded)).slice(0, 24)
}

/** trigram 查询使用安全的双引号词元，不拼接用户提供的 FTS 运算符。 */
export function buildFtsQuery(query: string): string | null {
  const tokens: string[] = []
  for (const term of rawTerms(query)) {
    const chars = Array.from(term)
    if (chars.length < 3) continue
    const containsHan = /\p{Script=Han}/u.test(term)
    if (containsHan) {
      for (let index = 0; index <= chars.length - 3; index++) tokens.push(chars.slice(index, index + 3).join(''))
    } else {
      tokens.push(term)
    }
  }
  const unique = Array.from(new Set(tokens)).slice(0, 32)
  return unique.length ? unique.map(token => `"${token.replace(/"/g, '""')}"`).join(' OR ') : null
}

export function hashKnowledgeQuery(query: string): string {
  return createHash('sha256').update(normalized(query)).digest('hex')
}

function baseSelect(scoreExpression: string): string {
  return `SELECT i.id, i.source_id, i.question, COALESCE(i.answer,'') AS answer,
    i.category, i.mastery, COALESCE(s.company,'') AS company,
    COALESCE(s.position,'') AS position, COALESCE(s.round,'') AS round,
    COALESCE(s.owner,'') AS owner, COALESCE(fb.helpful,0) AS helpful,
    COALESCE(fb.unhelpful,0) AS unhelpful, ${scoreExpression} AS bm25_score
    FROM knowledge_items i
    LEFT JOIN knowledge_sources s ON s.id=i.source_id
    LEFT JOIN (
      SELECT c.knowledge_item_id,
        SUM(CASE WHEN f.value=1 THEN 1 ELSE 0 END) AS helpful,
        SUM(CASE WHEN f.value=-1 THEN 1 ELSE 0 END) AS unhelpful
      FROM tutor_message_citations c
      JOIN tutor_message_feedback f ON f.message_id=c.message_id
      GROUP BY c.knowledge_item_id
    ) fb ON fb.knowledge_item_id=i.id`
}

function filters(): string {
  return ` AND (@owner='' OR s.owner=@owner) AND (@category='' OR i.category=@category)`
}

function ftsCandidates(match: string, options: KnowledgeSearchOptions): CandidateRow[] {
  return db.prepare(`${baseSelect('bm25(knowledge_items_fts, 8.0, 3.0, 1.2, 2.0, 1.0, 1.0)')}
    JOIN knowledge_items_fts ON knowledge_items_fts.rowid=i.id
    WHERE knowledge_items_fts MATCH @match ${filters()}
    ORDER BY bm25_score ASC LIMIT 50`).all({
      match,
      owner: options.owner ?? '',
      category: options.category ?? ''
    }) as CandidateRow[]
}

function likeCandidates(terms: string[], options: KnowledgeSearchOptions): CandidateRow[] {
  if (!terms.length) return []
  const conditions = terms.map((_, index) => `(
    i.question LIKE @term${index} OR COALESCE(i.answer,'') LIKE @term${index}
    OR COALESCE(s.company,'') LIKE @term${index} OR COALESCE(s.position,'') LIKE @term${index}
  )`).join(' OR ')
  const params: Record<string, string> = { owner: options.owner ?? '', category: options.category ?? '' }
  terms.forEach((term, index) => { params[`term${index}`] = `%${term}%` })
  return db.prepare(`${baseSelect('NULL')}
    WHERE (${conditions}) ${filters()}
    ORDER BY i.updated_at DESC LIMIT 50`).all(params) as CandidateRow[]
}

function scoreCandidate(candidate: Candidate, query: string, terms: string[]): number {
  const queryCompact = compact(query)
  const question = compact(candidate.question)
  const answer = compact(candidate.answer)
  const metadata = compact(`${candidate.company} ${candidate.position} ${candidate.round} ${candidate.category}`)
  let score = 0
  if (candidate.ftsOrder !== undefined) score += 8 / (1 + candidate.ftsOrder * 0.25)
  if (candidate.likeOrder !== undefined) score += 3 / (1 + candidate.likeOrder * 0.4)
  if (queryCompact && question.includes(queryCompact)) score += 8
  for (const term of terms) {
    const value = compact(term)
    if (!value) continue
    if (question.includes(value)) score += 2.4
    else if (answer.includes(value)) score += 0.8
    else if (metadata.includes(value)) score += 0.5
  }
  score += Math.max(-2, Math.min(2, (candidate.helpful - candidate.unhelpful) * 0.25))
  if (candidate.owner === 'mine') score += 0.2
  return Number(score.toFixed(4))
}

export function searchKnowledge(query: string, options: KnowledgeSearchOptions = {}): KnowledgeSearchResult {
  const started = Date.now()
  const trimmed = query.trim().slice(0, 2000)
  if (!trimmed) return { queryHash: hashKnowledgeQuery(''), mode: 'empty', durationMs: 0, items: [] }
  const terms = likeSearchTerms(trimmed)
  const match = buildFtsQuery(trimmed)
  let fts: CandidateRow[] = []
  if (match) {
    try {
      fts = ftsCandidates(match, options)
    } catch (error) {
      console.warn('[knowledge-search] FTS5 不可用，回退 LIKE:', (error as Error).message)
    }
  }
  const like = likeCandidates(terms, options)
  const merged = new Map<number, Candidate>()
  fts.forEach((row, index) => merged.set(row.id, { ...row, ftsOrder: index }))
  like.forEach((row, index) => {
    const current = merged.get(row.id)
    merged.set(row.id, current ? { ...current, likeOrder: index } : { ...row, likeOrder: index })
  })

  const ranked = Array.from(merged.values()).map(candidate => ({
    candidate,
    score: scoreCandidate(candidate, trimmed, terms)
  })).sort((a, b) => b.score - a.score || a.candidate.id - b.candidate.id)

  // 重复题在库中仍保留为高频信号，但同一次助教上下文只注入最相关的一条。
  const deduplicated = new Map<string, RetrievedKnowledge>()
  for (const { candidate, score } of ranked) {
    const key = compact(candidate.question)
    const existing = deduplicated.get(key)
    if (existing) {
      existing.duplicateCount += 1
      continue
    }
    deduplicated.set(key, {
      id: candidate.id,
      sourceId: candidate.source_id,
      question: candidate.question,
      answer: candidate.answer,
      category: candidate.category,
      mastery: candidate.mastery,
      company: candidate.company,
      position: candidate.position,
      round: candidate.round,
      owner: candidate.owner,
      score,
      bm25: candidate.bm25_score,
      matchedBy: [candidate.ftsOrder !== undefined ? 'fts5' : null, candidate.likeOrder !== undefined ? 'like' : null]
        .filter((value): value is 'fts5' | 'like' => value !== null),
      duplicateCount: 1
    })
  }
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit ?? 5)))
  const items = Array.from(deduplicated.values()).slice(0, limit)
  const mode = fts.length && like.length ? 'hybrid' : fts.length ? 'fts5' : like.length ? 'like' : 'empty'
  return { queryHash: hashKnowledgeQuery(trimmed), mode, durationMs: Date.now() - started, items }
}
