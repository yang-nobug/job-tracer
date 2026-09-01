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
    if (field.state === 'extracted' && (!field.value?.trim() || !field.evidence.length)) throw new Error(`${key} 缺少字段值或证据`)
    if (field.state !== 'extracted' && field.value !== null) throw new Error(`${key} 未确认的字段必须为 null`)
    if (field.state === 'conflict' && field.alternatives.length < 2) throw new Error(`${key} 缺少冲突候选`)
    if (field.alternatives.some(option => !option.value.trim() || !option.evidence.length)) throw new Error(`${key} 候选缺少证据`)
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
