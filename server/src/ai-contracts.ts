import { KNOWLEDGE_CATEGORIES } from './types.js'

type JsonSchema = Record<string, unknown>

const string = (maxLength: number): JsonSchema => ({ type: 'string', maxLength })
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false
})
const array = (items: JsonSchema, maxItems: number): JsonSchema => ({ type: 'array', items, maxItems })

function record(value: unknown, at: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} 必须是对象`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: string[], at: string): void {
  const actual = Object.keys(value)
  const missing = keys.filter(key => !Object.hasOwn(value, key))
  const extra = actual.filter(key => !keys.includes(key))
  if (missing.length) throw new Error(`${at} 缺少字段：${missing.join('、')}`)
  if (extra.length) throw new Error(`${at} 含未定义字段：${extra.join('、')}`)
}

function text(value: unknown, at: string, maxLength: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${at} 必须是字符串`)
  const normalized = value.trim()
  if (required && !normalized) throw new Error(`${at} 不能为空`)
  if (normalized.length > maxLength) throw new Error(`${at} 超过最大长度 ${maxLength}`)
  return normalized
}

function list(value: unknown, at: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${at} 必须是数组`)
  if (value.length > maxItems) throw new Error(`${at} 最多 ${maxItems} 项`)
  return value
}

// ---------- JD 解析 ----------

export interface JdParseResult {
  company: string
  position: string
  location: string
  summary: string
  jd: string
}

export const JD_PARSE_SCHEMA = object({
  company: string(200),
  position: string(200),
  location: string(200),
  summary: string(500),
  jd: string(20_000)
})

export function validateJdParse(value: unknown): JdParseResult {
  const data = record(value, '$')
  exactKeys(data, ['company', 'position', 'location', 'summary', 'jd'], '$')
  return {
    company: text(data.company, '$.company', 200),
    position: text(data.position, '$.position', 200),
    location: text(data.location, '$.location', 200),
    summary: text(data.summary, '$.summary', 500),
    jd: text(data.jd, '$.jd', 20_000)
  }
}

// ---------- 知识拆题 ----------

const KNOWLEDGE_ROUNDS = ['', '一面', '二面', '三面', 'HR面', '心理测评', '笔试', 'AI面', '其他'] as const

export interface KnowledgeCandidateResult {
  question: string
  answer: string
  category: string
}

export interface KnowledgeExtractionResult {
  company: string
  position: string
  round: string
  questions: KnowledgeCandidateResult[]
}

const categorySchema: JsonSchema = { type: 'string', enum: [...KNOWLEDGE_CATEGORIES] }
export const KNOWLEDGE_EXTRACTION_SCHEMA = object({
  company: string(100),
  position: string(100),
  round: { type: 'string', enum: [...KNOWLEDGE_ROUNDS] },
  questions: array(object({
    question: string(500),
    answer: string(5000),
    category: categorySchema
  }), 100)
})

export function validateKnowledgeExtraction(value: unknown): KnowledgeExtractionResult {
  const data = record(value, '$')
  exactKeys(data, ['company', 'position', 'round', 'questions'], '$')
  const round = text(data.round, '$.round', 20)
  if (!(KNOWLEDGE_ROUNDS as readonly string[]).includes(round)) throw new Error('$.round 不在允许范围内')
  const questions = list(data.questions, '$.questions', 100).map((raw, index) => {
    const item = record(raw, `$.questions[${index}]`)
    exactKeys(item, ['question', 'answer', 'category'], `$.questions[${index}]`)
    const category = text(item.category, `$.questions[${index}].category`, 20, true)
    if (!KNOWLEDGE_CATEGORIES.includes(category)) throw new Error(`$.questions[${index}].category 不在允许范围内`)
    return {
      question: text(item.question, `$.questions[${index}].question`, 500, true),
      answer: text(item.answer, `$.questions[${index}].answer`, 5000),
      category
    }
  })
  return {
    company: text(data.company, '$.company', 100),
    position: text(data.position, '$.position', 100),
    round,
    questions
  }
}

// ---------- 批量答案 ----------

export interface GeneratedAnswer {
  id: number
  answer: string
}

export interface AnswerGenerationResult {
  answers: GeneratedAnswer[]
}

export const ANSWER_GENERATION_SCHEMA = object({
  answers: array(object({
    id: { type: 'integer' },
    answer: string(20_000)
  }), 10)
})

export function validateAnswerGeneration(value: unknown, expectedIds: number[]): AnswerGenerationResult {
  const data = record(value, '$')
  exactKeys(data, ['answers'], '$')
  const expected = new Set(expectedIds)
  const seen = new Set<number>()
  const answers = list(data.answers, '$.answers', 10).map((raw, index) => {
    const item = record(raw, `$.answers[${index}]`)
    exactKeys(item, ['id', 'answer'], `$.answers[${index}]`)
    if (!Number.isInteger(item.id)) throw new Error(`$.answers[${index}].id 必须是整数`)
    const id = Number(item.id)
    if (!expected.has(id)) throw new Error(`模型返回了未请求的题目 ID：${id}`)
    if (seen.has(id)) throw new Error(`题目 ID ${id} 重复`)
    seen.add(id)
    return { id, answer: text(item.answer, `$.answers[${index}].answer`, 20_000, true) }
  })
  const missing = expectedIds.filter(id => !seen.has(id))
  if (missing.length) throw new Error(`模型缺少题目答案：${missing.join('、')}`)
  return { answers }
}

// ---------- 录音复盘 ----------

export interface RecordingAnalysisResult {
  review: string
  questions: KnowledgeCandidateResult[]
}

export interface RecordingChunkResult {
  summary: string
  questions: KnowledgeCandidateResult[]
}

export const RECORDING_CHUNK_SCHEMA = object({
  summary: string(4000),
  questions: array(object({
    question: string(500),
    answer: string(5000),
    category: categorySchema
  }), 50)
})

export function validateRecordingChunk(value: unknown): RecordingChunkResult {
  const data = record(value, '$')
  exactKeys(data, ['summary', 'questions'], '$')
  const questions = list(data.questions, '$.questions', 50).map((raw, index) => {
    const item = record(raw, `$.questions[${index}]`)
    exactKeys(item, ['question', 'answer', 'category'], `$.questions[${index}]`)
    const category = text(item.category, `$.questions[${index}].category`, 20, true)
    if (!KNOWLEDGE_CATEGORIES.includes(category)) throw new Error(`$.questions[${index}].category 不在允许范围内`)
    return {
      question: text(item.question, `$.questions[${index}].question`, 500, true),
      answer: text(item.answer, `$.questions[${index}].answer`, 5000),
      category
    }
  })
  return { summary: text(data.summary, '$.summary', 4000, true), questions }
}

export const RECORDING_ANALYSIS_SCHEMA = object({
  review: string(60_000),
  questions: array(object({
    question: string(500),
    answer: string(5000),
    category: categorySchema
  }), 100)
})

export function validateRecordingAnalysis(value: unknown): RecordingAnalysisResult {
  const data = record(value, '$')
  exactKeys(data, ['review', 'questions'], '$')
  const questions = list(data.questions, '$.questions', 100).map((raw, index) => {
    const item = record(raw, `$.questions[${index}]`)
    exactKeys(item, ['question', 'answer', 'category'], `$.questions[${index}]`)
    const category = text(item.category, `$.questions[${index}].category`, 20, true)
    if (!KNOWLEDGE_CATEGORIES.includes(category)) throw new Error(`$.questions[${index}].category 不在允许范围内`)
    return {
      question: text(item.question, `$.questions[${index}].question`, 500, true),
      answer: text(item.answer, `$.questions[${index}].answer`, 5000),
      category
    }
  })
  return { review: text(data.review, '$.review', 60_000, true), questions }
}
