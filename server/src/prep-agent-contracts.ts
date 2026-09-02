export type PrepEvidenceRef = string

export interface PrepEvidenceStatement {
  text: string
  source_refs: string[]
  confidence: number
}

export interface PrepRoleProfile {
  responsibilities: PrepEvidenceStatement[]
  must_have_skills: PrepEvidenceStatement[]
  nice_to_have_skills: PrepEvidenceStatement[]
  project_signals: PrepEvidenceStatement[]
  likely_interview_topics: string[]
  unknowns: string[]
}

export interface PrepRetrievalQuery {
  query: string
  reason: string
  category: string | null
  owner: 'mine' | 'others' | null
}

export interface PrepQueryPlan {
  queries: PrepRetrievalQuery[]
}

export interface PrepGap {
  skill: string
  current_level: 'unknown' | 'weak' | 'developing' | 'ready'
  target_level: 'review' | 'practice' | 'interview_ready'
  reason: string
  evidence_refs: PrepEvidenceRef[]
  confidence: number
}

export interface PrepGapAnalysis {
  gaps: PrepGap[]
  strengths: PrepGap[]
  warnings: string[]
}

export interface PrepPlanItem {
  title: string
  category: 'knowledge' | 'project' | 'coding' | 'communication' | 'mock'
  priority: 'high' | 'medium' | 'low'
  estimated_minutes: number
  reason: string
  evidence_refs: PrepEvidenceRef[]
  success_criteria: string
}

export interface PrepPlan {
  summary: string
  items: PrepPlanItem[]
}

export type PrepCriticIssueCode =
  | 'INVALID_REFERENCE'
  | 'UNSUPPORTED_CLAIM'
  | 'DUPLICATED_ITEM'
  | 'VAGUE_ACTION'
  | 'MISSING_SUCCESS_CRITERIA'
  | 'ROLE_REQUIREMENT_NOT_COVERED'
  | 'PRIVACY_LEAK'

export interface PrepCriticResult {
  verdict: 'pass' | 'warn' | 'revise'
  issues: Array<{
    code: PrepCriticIssueCode
    item_index: number | null
    message: string
  }>
}

const evidenceStatementSchema = {
  type: 'object', additionalProperties: false,
  required: ['text', 'source_refs', 'confidence'],
  properties: {
    text: { type: 'string' },
    source_refs: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
}

export const PREP_ROLE_PROFILE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['responsibilities', 'must_have_skills', 'nice_to_have_skills', 'project_signals', 'likely_interview_topics', 'unknowns'],
  properties: {
    responsibilities: { type: 'array', items: evidenceStatementSchema },
    must_have_skills: { type: 'array', items: evidenceStatementSchema },
    nice_to_have_skills: { type: 'array', items: evidenceStatementSchema },
    project_signals: { type: 'array', items: evidenceStatementSchema },
    likely_interview_topics: { type: 'array', items: { type: 'string' } },
    unknowns: { type: 'array', items: { type: 'string' } }
  }
}

export const PREP_QUERY_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['queries'],
  properties: {
    queries: {
      type: 'array', maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        required: ['query', 'reason', 'category', 'owner'],
        properties: {
          query: { type: 'string' }, reason: { type: 'string' },
          category: { type: ['string', 'null'], enum: ['八股', '项目', '算法', '综合面试', '其他', null] },
          owner: { type: ['string', 'null'], enum: ['mine', 'others', null] }
        }
      }
    }
  }
}

const gapSchema = {
  type: 'object', additionalProperties: false,
  required: ['skill', 'current_level', 'target_level', 'reason', 'evidence_refs', 'confidence'],
  properties: {
    skill: { type: 'string' },
    current_level: { type: 'string', enum: ['unknown', 'weak', 'developing', 'ready'] },
    target_level: { type: 'string', enum: ['review', 'practice', 'interview_ready'] },
    reason: { type: 'string' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  }
}

export const PREP_GAP_ANALYSIS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['gaps', 'strengths', 'warnings'],
  properties: {
    gaps: { type: 'array', items: gapSchema },
    strengths: { type: 'array', items: gapSchema },
    warnings: { type: 'array', items: { type: 'string' } }
  }
}

export const PREP_PLAN_ITEM_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'category', 'priority', 'estimated_minutes', 'reason', 'evidence_refs', 'success_criteria'],
  properties: {
    title: { type: 'string' },
    category: { type: 'string', enum: ['knowledge', 'project', 'coding', 'communication', 'mock'] },
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    estimated_minutes: { type: 'integer', minimum: 5, maximum: 480 },
    reason: { type: 'string' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    success_criteria: { type: 'string' }
  }
}

export const PREP_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['summary', 'items'],
  properties: {
    summary: { type: 'string' },
    items: { type: 'array', minItems: 1, maxItems: 12, items: PREP_PLAN_ITEM_SCHEMA }
  }
}

export const PREP_CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'warn', 'revise'] },
    issues: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'item_index', 'message'],
        properties: {
          code: { type: 'string', enum: [
            'INVALID_REFERENCE', 'UNSUPPORTED_CLAIM', 'DUPLICATED_ITEM', 'VAGUE_ACTION',
            'MISSING_SUCCESS_CRITERIA',
            'ROLE_REQUIREMENT_NOT_COVERED', 'PRIVACY_LEAK'
          ] },
          item_index: { type: ['integer', 'null'] },
          message: { type: 'string' }
        }
      }
    }
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`)
  return value as Record<string, unknown>
}

function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空文本`)
  if (value.trim().length > max) throw new Error(`${name} 不能超过 ${max} 字符`)
  return value.trim()
}

function optionalTexts(value: unknown, name: string, maxItems: number, maxText = 300): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} 必须是最多 ${maxItems} 项的数组`)
  return value.map((item, index) => text(item, `${name}[${index}]`, maxText))
}

function numberRange(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} 必须在 ${min}～${max} 之间`)
  }
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${name} 非法`)
  return value as T
}

function evidenceStatement(value: unknown, name: string): PrepEvidenceStatement {
  const item = record(value, name)
  return {
    text: text(item.text, `${name}.text`, 500),
    source_refs: optionalTexts(item.source_refs, `${name}.source_refs`, 8, 60),
    confidence: numberRange(item.confidence, `${name}.confidence`, 0, 1)
  }
}

function evidenceStatements(value: unknown, name: string): PrepEvidenceStatement[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${name} 必须是最多 20 项的数组`)
  return value.map((item, index) => evidenceStatement(item, `${name}[${index}]`))
}

export function validatePrepRoleProfile(value: unknown): PrepRoleProfile {
  const raw = record(value, 'role_profile')
  return {
    responsibilities: evidenceStatements(raw.responsibilities, 'responsibilities'),
    must_have_skills: evidenceStatements(raw.must_have_skills, 'must_have_skills'),
    nice_to_have_skills: evidenceStatements(raw.nice_to_have_skills, 'nice_to_have_skills'),
    project_signals: evidenceStatements(raw.project_signals, 'project_signals'),
    likely_interview_topics: optionalTexts(raw.likely_interview_topics, 'likely_interview_topics', 20),
    unknowns: optionalTexts(raw.unknowns, 'unknowns', 20)
  }
}

export function validatePrepQueryPlan(value: unknown): PrepQueryPlan {
  const raw = record(value, 'query_plan')
  if (!Array.isArray(raw.queries) || raw.queries.length > 8) throw new Error('queries 必须是最多 8 项的数组')
  const seen = new Set<string>()
  const queries = raw.queries.map((value, index) => {
    const item = record(value, `queries[${index}]`)
    const query = text(item.query, `queries[${index}].query`, 200)
    const key = query.normalize('NFKC').toLowerCase().replace(/\s+/g, '')
    if (seen.has(key)) throw new Error(`queries[${index}] 与前面的查询重复`)
    seen.add(key)
    const owner = item.owner == null ? null : oneOf(item.owner, ['mine', 'others'] as const, `queries[${index}].owner`)
    return {
      query,
      reason: text(item.reason, `queries[${index}].reason`, 300),
      category: item.category == null
        ? null
        : oneOf(item.category, ['八股', '项目', '算法', '综合面试', '其他'] as const, `queries[${index}].category`),
      owner
    }
  })
  return { queries }
}

function gap(value: unknown, name: string): PrepGap {
  const item = record(value, name)
  return {
    skill: text(item.skill, `${name}.skill`, 120),
    current_level: oneOf(item.current_level, ['unknown', 'weak', 'developing', 'ready'] as const, `${name}.current_level`),
    target_level: oneOf(item.target_level, ['review', 'practice', 'interview_ready'] as const, `${name}.target_level`),
    reason: text(item.reason, `${name}.reason`, 600),
    evidence_refs: optionalTexts(item.evidence_refs, `${name}.evidence_refs`, 15, 60),
    confidence: numberRange(item.confidence, `${name}.confidence`, 0, 1)
  }
}

function gaps(value: unknown, name: string): PrepGap[] {
  if (!Array.isArray(value) || value.length > 20) throw new Error(`${name} 必须是最多 20 项的数组`)
  return value.map((item, index) => gap(item, `${name}[${index}]`))
}

export function validatePrepGapAnalysis(value: unknown): PrepGapAnalysis {
  const raw = record(value, 'gap_analysis')
  return {
    gaps: gaps(raw.gaps, 'gaps'),
    strengths: gaps(raw.strengths, 'strengths'),
    warnings: optionalTexts(raw.warnings, 'warnings', 20, 300)
  }
}

export function validatePrepPlanItem(value: unknown, name = 'plan_item'): PrepPlanItem {
  const item = record(value, name)
  const estimated = numberRange(item.estimated_minutes, `${name}.estimated_minutes`, 5, 480)
  if (!Number.isInteger(estimated)) throw new Error(`${name}.estimated_minutes 必须是整数`)
  return {
    title: text(item.title, `${name}.title`, 160),
    category: oneOf(item.category, ['knowledge', 'project', 'coding', 'communication', 'mock'] as const, `${name}.category`),
    priority: oneOf(item.priority, ['high', 'medium', 'low'] as const, `${name}.priority`),
    estimated_minutes: estimated,
    reason: text(item.reason, `${name}.reason`, 600),
    evidence_refs: optionalTexts(item.evidence_refs, `${name}.evidence_refs`, 15, 60),
    success_criteria: text(item.success_criteria, `${name}.success_criteria`, 500)
  }
}

export function validatePrepPlan(value: unknown): PrepPlan {
  const raw = record(value, 'plan')
  if (!Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > 12) {
    throw new Error('items 必须包含 1～12 项')
  }
  return {
    summary: text(raw.summary, 'summary', 1000),
    items: raw.items.map((item, index) => validatePrepPlanItem(item, `items[${index}]`))
  }
}

export function validatePrepCritic(value: unknown): PrepCriticResult {
  const raw = record(value, 'critic')
  const verdict = oneOf(raw.verdict, ['pass', 'warn', 'revise'] as const, 'verdict')
  if (!Array.isArray(raw.issues) || raw.issues.length > 30) throw new Error('issues 必须是最多 30 项的数组')
  const codes = [
    'INVALID_REFERENCE', 'UNSUPPORTED_CLAIM', 'DUPLICATED_ITEM', 'VAGUE_ACTION',
    'MISSING_SUCCESS_CRITERIA',
    'ROLE_REQUIREMENT_NOT_COVERED', 'PRIVACY_LEAK'
  ] as const
  const issues = raw.issues.map((value, index) => {
    const item = record(value, `issues[${index}]`)
    const itemIndex = item.item_index
    if (itemIndex !== null && (!Number.isInteger(itemIndex) || Number(itemIndex) < 0 || Number(itemIndex) > 11)) {
      throw new Error(`issues[${index}].item_index 非法`)
    }
    return {
      code: oneOf(item.code, codes, `issues[${index}].code`),
      item_index: itemIndex === null ? null : Number(itemIndex),
      message: text(item.message, `issues[${index}].message`, 400)
    }
  })
  return { verdict, issues }
}

export const PREP_MODEL_CONTRACTS = {
  role_profile: { schemaName: 'prep_role_profile', schema: PREP_ROLE_PROFILE_SCHEMA, validate: validatePrepRoleProfile, prompt: 'prep-role-profile.system.md' },
  query_plan: { schemaName: 'prep_query_plan', schema: PREP_QUERY_PLAN_SCHEMA, validate: validatePrepQueryPlan, prompt: 'prep-query-plan.system.md' },
  gap_analysis: { schemaName: 'prep_gap_analysis', schema: PREP_GAP_ANALYSIS_SCHEMA, validate: validatePrepGapAnalysis, prompt: 'prep-gap-analysis.system.md' },
  plan: { schemaName: 'prep_plan', schema: PREP_PLAN_SCHEMA, validate: validatePrepPlan, prompt: 'prep-plan.system.md' },
  critic: { schemaName: 'prep_critic', schema: PREP_CRITIC_SCHEMA, validate: validatePrepCritic, prompt: 'prep-critic.system.md' }
} as const

export type PrepModelKind = keyof typeof PREP_MODEL_CONTRACTS
