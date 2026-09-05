export const IMPORT_LIMITS = { images: 9, imageBytes: 10 * 1024 * 1024, totalBytes: 30 * 1024 * 1024, text: 20000, pixels: 16_000_000 }
export const IMPORT_STATUSES = ['unsent', 'applied', 'assessment', 'testing', 'ai', 'round1', 'round2', 'round3', 'hr', 'offer'] as const
export const IMPORT_FIELDS = ['company', 'position', 'location', 'channel', 'jd_link', 'jd_text', 'contact_name', 'contact_info', 'summary', 'status'] as const
export type ImportField = typeof IMPORT_FIELDS[number]
export const IMPORT_LABELS: Record<ImportField, string> = { company: '公司', position: '职位', location: '地点', channel: '渠道', jd_link: '投递链接', jd_text: 'JD 正文', contact_name: '联系人', contact_info: '联系方式', summary: '岗位摘要', status: '状态' }
export interface Evidence { source_id: string; quote: string }
export interface ExtractedField {
  value: string | null
  state: 'extracted' | 'missing' | 'uncertain' | 'conflict'
  evidence: Evidence[]
  alternatives: { value: string; evidence: Evidence[] }[]
}
export interface DateFact {
  kind: 'application' | 'planned_application' | 'publish' | 'update' | 'interview' | 'unknown'
  raw: string
  evidence: Evidence[]
}
export interface ExtractionResult {
  schema_version: '1'
  target_state: 'single' | 'multiple' | 'unclear'
  target_candidates: { company: string | null; position: string | null; source_ids: string[] }[]
  fields: Record<ImportField, ExtractedField>
  date_facts: DateFact[]
  warnings: string[]
}
export interface ImportSource {
  id: string; kind: 'text' | 'image'; text: string | null; filename: string | null
  mime: string | null; captured_at: string | null; url: string | null
}
export interface AppliedDateCandidate {
  date: string | null; time: string | null; raw: string; evidence: Evidence[]; issue: string | null
}
export interface AppliedDateResult {
  state: 'resolved' | 'missing' | 'uncertain' | 'conflict'
  value: string | null; time: string | null; candidates: AppliedDateCandidate[]
}
export interface ImportAnalysis {
  extraction: ExtractionResult; applied_date: AppliedDateResult
  duplicates: { id: number; company: string; position: string; location: string | null }[]
  model: string; prompt_version: string
}
export interface ImportDraft { id: string; sources: ImportSource[]; analysis: ImportAnalysis | null; application_id: number | null }

type JsonSchema = { [key: string]: unknown }
const textSchema: JsonSchema = { type: 'string' }
const nullableText: JsonSchema = { type: ['string', 'null'] }
const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const array = (items: JsonSchema): JsonSchema => ({ type: 'array', items })
const evidenceSchema = array(object({ source_id: textSchema, quote: textSchema }))
const fieldSchema = (status = false): JsonSchema => object({
  value: status ? { type: ['string', 'null'], enum: [...IMPORT_STATUSES, null] } : nullableText,
  state: { type: 'string', enum: ['extracted', 'missing', 'uncertain', 'conflict'] },
  evidence: evidenceSchema,
  alternatives: array(object({ value: status ? { type: 'string', enum: [...IMPORT_STATUSES] } : textSchema, evidence: evidenceSchema }))
})
export const EXTRACTION_SCHEMA = object({
  schema_version: { type: 'string', enum: ['1'] },
  target_state: { type: 'string', enum: ['single', 'multiple', 'unclear'] },
  target_candidates: array(object({ company: nullableText, position: nullableText, source_ids: array(textSchema) })),
  fields: object(Object.fromEntries(IMPORT_FIELDS.map(key => [key, fieldSchema(key === 'status')]))),
  date_facts: array(object({ kind: { type: 'string', enum: ['application', 'planned_application', 'publish', 'update', 'interview', 'unknown'] }, raw: textSchema, evidence: evidenceSchema })),
  warnings: array(textSchema)
})

const FIELD_STATES = ['extracted', 'missing', 'uncertain', 'conflict'] as const
const TARGET_STATES = ['single', 'multiple', 'unclear'] as const
const DATE_KINDS = ['application', 'planned_application', 'publish', 'update', 'interview', 'unknown'] as const

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function text(value: unknown, max = 24_000): string | null {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null
}

function evidenceList(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const raw = record(item)
    const source_id = text(raw?.source_id, 200)
    const quote = text(raw?.quote, 500)
    return source_id && quote ? [{ source_id, quote }] : []
  }).slice(0, 80)
}

/**
 * 视觉模型常能识别岗位内容，却偶尔遗漏空数组或某个未提供字段。
 * 这里仅补齐结构并清理格式错误。只要模型给出合法字段值，就保留给用户核对；
 * 不因缺少证据或字段状态而清空模型已经识别出的公司、职位等信息。
 */
export function normalizeExtraction(value: unknown): ExtractionResult {
  const raw = record(value)
  if (!raw) throw new Error('根对象不是 JSON 对象')
  const diagnostics: string[] = []
  const rawFields = record(raw.fields)
  if (!rawFields) throw new Error('fields 不是对象')

  const fields = Object.fromEntries(IMPORT_FIELDS.map(key => {
    const item = record(rawFields[key])
    if (!item) {
      diagnostics.push(`${key} 未返回，已留空待补充`)
      return [key, { value: null, state: 'missing', evidence: [], alternatives: [] }]
    }
    const value = text(item.value, key === 'jd_text' ? 24_000 : 2_000)
    const evidence = evidenceList(item.evidence)
    const alternatives = Array.isArray(item.alternatives) ? item.alternatives.flatMap(option => {
      const candidate = record(option)
      const candidateValue = text(candidate?.value, key === 'jd_text' ? 24_000 : 2_000)
      const candidateEvidence = evidenceList(candidate?.evidence)
      return candidateValue ? [{ value: candidateValue, evidence: candidateEvidence }] : []
    }).slice(0, 80) : []
    const requestedState = FIELD_STATES.includes(item.state as typeof FIELD_STATES[number])
      ? item.state as ExtractedField['state']
      : null
    const validStatus = key !== 'status' || value === null || IMPORT_STATUSES.includes(value as typeof IMPORT_STATUSES[number])

    if (requestedState === 'conflict' && alternatives.length >= 2) {
      return [key, { value: null, state: 'conflict', evidence: [], alternatives }]
    }
    if (value && validStatus) {
      return [key, { value, state: 'extracted', evidence, alternatives: [] }]
    }
    if (value) diagnostics.push(`${key} 状态值不合法，已留空待补充`)
    else if (requestedState === 'conflict') diagnostics.push(`${key} 的冲突候选不足，已改为待核对`)
    return [key, { value: null, state: requestedState === 'uncertain' || value ? 'uncertain' : 'missing', evidence: [], alternatives: [] }]
  })) as Record<ImportField, ExtractedField>

  const targetCandidates = Array.isArray(raw.target_candidates) ? raw.target_candidates.flatMap(item => {
    const candidate = record(item)
    if (!candidate) return []
    const company = text(candidate.company, 2_000)
    const position = text(candidate.position, 2_000)
    const source_ids = Array.isArray(candidate.source_ids)
      ? candidate.source_ids.flatMap(id => text(id, 200) ? [text(id, 200)!] : []).slice(0, 80)
      : []
    return [{ company, position, source_ids }]
  }).slice(0, 80) : []
  const hasCoreFields = Boolean(fields.company.value && fields.position.value)
  const target_state = TARGET_STATES.includes(raw.target_state as typeof TARGET_STATES[number])
    ? raw.target_state as ExtractionResult['target_state']
    : hasCoreFields ? 'single' : 'unclear'
  if (raw.target_state !== target_state) {
    diagnostics.push(hasCoreFields
      ? '目标岗位状态未返回，已根据公司和职位按单个岗位处理'
      : '目标岗位状态未按格式返回，已改为待确认')
  }

  const date_facts = Array.isArray(raw.date_facts) ? raw.date_facts.flatMap(item => {
    const fact = record(item)
    const kind = DATE_KINDS.includes(fact?.kind as typeof DATE_KINDS[number]) ? fact?.kind as DateFact['kind'] : null
    const rawDate = text(fact?.raw, 160)
    const evidence = evidenceList(fact?.evidence)
    if (!kind || !rawDate || !evidence.length) {
      if (fact) diagnostics.push('一条日期信息缺少完整格式或证据，已忽略')
      return []
    }
    return [{ kind, raw: rawDate, evidence }]
  }).slice(0, 80) : []
  const warnings = Array.isArray(raw.warnings)
    ? raw.warnings.flatMap(item => text(item, 2_000) ? [text(item, 2_000)!] : []).slice(0, 80)
    : []

  return {
    schema_version: '1',
    target_state,
    target_candidates: targetCandidates,
    fields,
    date_facts,
    warnings: [...new Set([...warnings, ...diagnostics])].slice(0, 80)
  }
}

// Validate the small, fixed schema above at runtime, including additional keys.
// This is deliberately not a general JSON Schema engine.
function checkSchema(value: unknown, schema: JsonSchema, at = '$'): void {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type]
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (!types.includes(type)) throw new Error(`${at} 类型不正确`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${at} 不在允许范围内`)
  if (type === 'string' && (value as string).length > 24000) throw new Error(`${at} 过长`)
  if (type === 'array') {
    if ((value as unknown[]).length > 80) throw new Error(`${at} 条目过多`)
    for (const [i, item] of (value as unknown[]).entries()) checkSchema(item, schema.items as JsonSchema, `${at}[${i}]`)
  }
  if (type === 'object') {
    const data = value as Record<string, unknown>
    const props = schema.properties as Record<string, JsonSchema>
    if (Object.keys(data).some(key => !Object.hasOwn(props, key))) throw new Error(`${at} 含未定义字段`)
    for (const key of Object.keys(props)) checkSchema(data[key], props[key], `${at}.${key}`)
  }
}
export function validateExtraction(value: unknown): ExtractionResult {
  checkSchema(value, EXTRACTION_SCHEMA)
  const result = value as ExtractionResult
  for (const key of IMPORT_FIELDS) {
    const field = result.fields[key]
    if (field.state === 'extracted' && !field.value?.trim()) throw new Error(`${key} 缺少字段值`)
    if (field.state !== 'extracted' && field.value !== null) throw new Error(`${key} 未确认的字段必须为 null`)
    if (field.state === 'conflict' && field.alternatives.length < 2) throw new Error(`${key} 缺少冲突候选`)
    if (field.alternatives.some(option => !option.value.trim())) throw new Error(`${key} 候选缺少字段值`)
    if (key !== 'jd_text' && (field.value?.length ?? 0) > 2000) throw new Error(`${key} 过长`)
  }
  if (result.date_facts.some(fact => !fact.raw.trim() || fact.raw.length > 160 || !fact.evidence.length)) throw new Error('日期缺少原文或证据')
  const evidence = [
    ...Object.values(result.fields).flatMap(field => [...field.evidence, ...field.alternatives.flatMap(option => option.evidence)]),
    ...result.date_facts.flatMap(fact => fact.evidence)
  ]
  if (evidence.some(item => !item.source_id.trim() || !item.quote.trim() || item.quote.length > 500)) throw new Error('证据原文为空或过长')
  return result
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return false
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate()
}
export function isClockTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)
}
