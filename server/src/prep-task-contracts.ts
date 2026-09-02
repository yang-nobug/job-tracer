export type PrepTaskSectionType =
  | 'explanation'
  | 'example'
  | 'comparison'
  | 'pitfall'
  | 'interview_answer'
  | 'project_template'
  | 'code_walkthrough'

export type PrepPracticeLevel = 'basic' | 'understanding' | 'application' | 'interview'

export type PrepTaskPracticeType =
  | 'short_answer'
  | 'scenario'
  | 'system_design'
  | 'coding_exercise'
  | 'project_story'
  | 'behavioral_rehearsal'
  | 'mock_question'

export interface PrepTaskBlueprintModule {
  id: string
  title: string
  purpose: string
  recommended_minutes: number
  learning_outcomes: string[]
  evidence_refs: string[]
}

export interface PrepTaskCoverageItem {
  objective: string
  module_ids: string[]
  practice_levels: PrepPracticeLevel[]
}

export interface PrepTaskBlueprint {
  overview: string
  objectives: string[]
  prerequisites: string[]
  coverage_map: PrepTaskCoverageItem[]
  modules: PrepTaskBlueprintModule[]
}

export interface PrepLearningSection {
  type: PrepTaskSectionType
  title: string
  content: string
  evidence_refs: string[]
}

export interface PrepLearningModule extends PrepTaskBlueprintModule {
  sections: PrepLearningSection[]
  self_checks: Array<{ question: string; expected_points: string[] }>
}

export interface PrepPracticeItem {
  level: PrepPracticeLevel
  type: PrepTaskPracticeType
  prompt: string
  hints: string[]
  answer_outline: string
  reference_answer: string
  follow_ups: string[]
  rubric: Array<{ criterion: string; description: string; score: number }>
  module_ids: string[]
}

export interface PrepTaskPracticeSet {
  items: PrepPracticeItem[]
  completion_checklist: string[]
}

export type PrepTaskCriticIssueCode =
  | 'MISSING_COVERAGE'
  | 'SHALLOW_MODULE'
  | 'MISSING_EXAMPLE'
  | 'DUPLICATED_PRACTICE'
  | 'SHALLOW_FOLLOW_UP'
  | 'UNSUPPORTED_CLAIM'
  | 'PERSONAL_FACT_RISK'

export interface PrepTaskCriticResult {
  verdict: 'pass' | 'revise'
  issues: Array<{
    code: PrepTaskCriticIssueCode
    target: 'guide' | 'module' | 'practice'
    module_id: string | null
    message: string
    repair_instruction: string
  }>
}

export interface PrepTaskGuide extends PrepTaskBlueprint {
  version: 2
  modules: PrepLearningModule[]
  practice_set: PrepPracticeItem[]
  completion_checklist: string[]
  quality_review: {
    verdict: 'pass' | 'warn'
    repaired: boolean
    issues: PrepTaskCriticResult['issues']
  }
}

const SECTION_TYPES: readonly PrepTaskSectionType[] = [
  'explanation', 'example', 'comparison', 'pitfall', 'interview_answer', 'project_template', 'code_walkthrough'
]
const PRACTICE_LEVELS: readonly PrepPracticeLevel[] = ['basic', 'understanding', 'application', 'interview']
const PRACTICE_TYPES: readonly PrepTaskPracticeType[] = [
  'short_answer', 'scenario', 'system_design', 'coding_exercise',
  'project_story', 'behavioral_rehearsal', 'mock_question'
]
const CRITIC_CODES: readonly PrepTaskCriticIssueCode[] = [
  'MISSING_COVERAGE', 'SHALLOW_MODULE', 'MISSING_EXAMPLE', 'DUPLICATED_PRACTICE',
  'SHALLOW_FOLLOW_UP', 'UNSUPPORTED_CLAIM', 'PERSONAL_FACT_RISK'
]

const blueprintModuleSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'title', 'purpose', 'recommended_minutes', 'learning_outcomes', 'evidence_refs'],
  properties: {
    id: { type: 'string', pattern: '^M[1-9][0-9]?$' },
    title: { type: 'string' }, purpose: { type: 'string' },
    recommended_minutes: { type: 'integer', minimum: 5, maximum: 480 },
    learning_outcomes: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
    evidence_refs: { type: 'array', maxItems: 15, items: { type: 'string' } }
  }
} as const

const coverageSchema = {
  type: 'object', additionalProperties: false,
  required: ['objective', 'module_ids', 'practice_levels'],
  properties: {
    objective: { type: 'string' },
    module_ids: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } },
    practice_levels: {
      type: 'array', minItems: 1, maxItems: 4,
      items: { type: 'string', enum: PRACTICE_LEVELS }
    }
  }
} as const

export const PREP_TASK_BLUEPRINT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['overview', 'objectives', 'prerequisites', 'coverage_map', 'modules'],
  properties: {
    overview: { type: 'string' },
    objectives: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string' } },
    prerequisites: { type: 'array', maxItems: 8, items: { type: 'string' } },
    coverage_map: { type: 'array', minItems: 2, maxItems: 8, items: coverageSchema },
    modules: { type: 'array', minItems: 2, maxItems: 6, items: blueprintModuleSchema }
  }
} as const

export const PREP_LEARNING_MODULE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: [
    'id', 'title', 'purpose', 'recommended_minutes', 'learning_outcomes',
    'evidence_refs', 'sections', 'self_checks'
  ],
  properties: {
    ...blueprintModuleSchema.properties,
    sections: {
      type: 'array', minItems: 4, maxItems: 8,
      items: {
        type: 'object', additionalProperties: false,
        required: ['type', 'title', 'content', 'evidence_refs'],
        properties: {
          type: { type: 'string', enum: SECTION_TYPES },
          title: { type: 'string' },
          content: { type: 'string', minLength: 180 },
          evidence_refs: { type: 'array', maxItems: 15, items: { type: 'string' } }
        }
      }
    },
    self_checks: {
      type: 'array', minItems: 2, maxItems: 5,
      items: {
        type: 'object', additionalProperties: false,
        required: ['question', 'expected_points'],
        properties: {
          question: { type: 'string' },
          expected_points: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } }
        }
      }
    }
  }
} as const

const practiceItemSchema = {
  type: 'object', additionalProperties: false,
  required: [
    'level', 'type', 'prompt', 'hints', 'answer_outline', 'reference_answer',
    'follow_ups', 'rubric', 'module_ids'
  ],
  properties: {
    level: { type: 'string', enum: PRACTICE_LEVELS },
    type: { type: 'string', enum: PRACTICE_TYPES },
    prompt: { type: 'string' },
    hints: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
    answer_outline: { type: 'string', minLength: 60 },
    reference_answer: { type: 'string', minLength: 120 },
    follow_ups: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string' } },
    rubric: {
      type: 'array', minItems: 2, maxItems: 6,
      items: {
        type: 'object', additionalProperties: false,
        required: ['criterion', 'description', 'score'],
        properties: {
          criterion: { type: 'string' }, description: { type: 'string' },
          score: { type: 'integer', minimum: 1, maximum: 5 }
        }
      }
    },
    module_ids: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } }
  }
} as const

export const PREP_TASK_PRACTICE_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['items', 'completion_checklist'],
  properties: {
    items: { type: 'array', minItems: 6, maxItems: 12, items: practiceItemSchema },
    completion_checklist: { type: 'array', minItems: 4, maxItems: 10, items: { type: 'string' } }
  }
} as const

export const PREP_TASK_CRITIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'revise'] },
    issues: {
      type: 'array', maxItems: 20,
      items: {
        type: 'object', additionalProperties: false,
        required: ['code', 'target', 'module_id', 'message', 'repair_instruction'],
        properties: {
          code: { type: 'string', enum: CRITIC_CODES },
          target: { type: 'string', enum: ['guide', 'module', 'practice'] },
          module_id: { type: ['string', 'null'] },
          message: { type: 'string' }, repair_instruction: { type: 'string' }
        }
      }
    }
  }
} as const

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} 必须是对象`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key))
  if (unexpected.length) throw new Error(`${name} 包含未定义字段：${unexpected.join(', ')}`)
}

function text(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} 必须是非空文本`)
  const result = value.trim()
  if (result.length < min) throw new Error(`${name} 不能少于 ${min} 字符`)
  if (result.length > max) throw new Error(`${name} 不能超过 ${max} 字符`)
  return result
}

function texts(value: unknown, name: string, min: number, max: number, textMax: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new Error(`${name} 必须包含 ${min}～${max} 项`)
  }
  return value.map((item, index) => text(item, `${name}[${index}]`, textMax))
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], name: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new Error(`${name} 非法`)
  return value as T
}

function integer(value: unknown, name: string, min: number, max: number): number {
  const result = Number(value)
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} 非法`)
  return result
}

function uniqueTexts(value: unknown, name: string, min: number, max: number, textMax: number): string[] {
  const result = texts(value, name, min, max, textMax)
  if (new Set(result).size !== result.length) throw new Error(`${name} 不能包含重复项`)
  return result
}

function blueprintModule(value: unknown, name: string): PrepTaskBlueprintModule {
  const raw = record(value, name)
  exactKeys(raw, ['id', 'title', 'purpose', 'recommended_minutes', 'learning_outcomes', 'evidence_refs'], name)
  const id = text(raw.id, `${name}.id`, 20)
  if (!/^M[1-9][0-9]?$/.test(id)) throw new Error(`${name}.id 必须采用 M1、M2 格式`)
  return {
    id,
    title: text(raw.title, `${name}.title`, 160),
    purpose: text(raw.purpose, `${name}.purpose`, 1000),
    recommended_minutes: integer(raw.recommended_minutes, `${name}.recommended_minutes`, 5, 480),
    learning_outcomes: uniqueTexts(raw.learning_outcomes, `${name}.learning_outcomes`, 2, 6, 500),
    evidence_refs: Array.isArray(raw.evidence_refs)
      ? uniqueTexts(raw.evidence_refs, `${name}.evidence_refs`, 0, 15, 60)
      : []
  }
}

function coverageItems(value: unknown, objectives: string[], moduleIds: Set<string>): PrepTaskCoverageItem[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) throw new Error('coverage_map 必须包含 2～8 项')
  const result = value.map((entry, index): PrepTaskCoverageItem => {
    const name = `coverage_map[${index}]`
    const raw = record(entry, name)
    exactKeys(raw, ['objective', 'module_ids', 'practice_levels'], name)
    const objective = text(raw.objective, `${name}.objective`, 500)
    if (!objectives.includes(objective)) throw new Error(`${name}.objective 必须来自 objectives`)
    const ids = uniqueTexts(raw.module_ids, `${name}.module_ids`, 1, 6, 20)
    if (ids.some(id => !moduleIds.has(id))) throw new Error(`${name}.module_ids 包含不存在的模块`)
    const levels = uniqueTexts(raw.practice_levels, `${name}.practice_levels`, 1, 4, 40)
      .map((level, levelIndex) => oneOf(level, PRACTICE_LEVELS, `${name}.practice_levels[${levelIndex}]`))
    return { objective, module_ids: ids, practice_levels: levels }
  })
  if (new Set(result.map(item => item.objective)).size !== objectives.length) {
    throw new Error('coverage_map 必须且只能覆盖每个 objective 一次')
  }
  return result
}

export function validatePrepTaskBlueprint(value: unknown): PrepTaskBlueprint {
  const raw = record(value, 'blueprint')
  exactKeys(raw, ['overview', 'objectives', 'prerequisites', 'coverage_map', 'modules'], 'blueprint')
  if (!Array.isArray(raw.modules) || raw.modules.length < 2 || raw.modules.length > 6) {
    throw new Error('modules 必须包含 2～6 项')
  }
  const modules = raw.modules.map((item, index) => blueprintModule(item, `modules[${index}]`))
  const moduleIds = new Set(modules.map(item => item.id))
  if (moduleIds.size !== modules.length) throw new Error('modules.id 不能重复')
  const objectives = uniqueTexts(raw.objectives, 'objectives', 2, 8, 500)
  const coverageMap = coverageItems(raw.coverage_map, objectives, moduleIds)
  const coveredModules = new Set(coverageMap.flatMap(item => item.module_ids))
  if (modules.some(module => !coveredModules.has(module.id))) throw new Error('每个模块都必须被 coverage_map 引用')
  return {
    overview: text(raw.overview, 'overview', 3000),
    objectives,
    prerequisites: Array.isArray(raw.prerequisites) ? uniqueTexts(raw.prerequisites, 'prerequisites', 0, 8, 500) : [],
    coverage_map: coverageMap,
    modules
  }
}

export function validatePrepLearningModule(value: unknown, expected?: PrepTaskBlueprintModule): PrepLearningModule {
  const raw = record(value, 'module')
  exactKeys(raw, [
    'id', 'title', 'purpose', 'recommended_minutes', 'learning_outcomes',
    'evidence_refs', 'sections', 'self_checks'
  ], 'module')
  const base = blueprintModule({
    id: raw.id, title: raw.title, purpose: raw.purpose,
    recommended_minutes: raw.recommended_minutes, learning_outcomes: raw.learning_outcomes,
    evidence_refs: raw.evidence_refs
  }, 'module')
  if (expected && base.id !== expected.id) throw new Error(`module.id 必须是 ${expected.id}`)
  if (!Array.isArray(raw.sections) || raw.sections.length < 4 || raw.sections.length > 8) {
    throw new Error('module.sections 必须包含 4～8 项')
  }
  const sections = raw.sections.map((entry, index): PrepLearningSection => {
    const name = `module.sections[${index}]`
    const item = record(entry, name)
    exactKeys(item, ['type', 'title', 'content', 'evidence_refs'], name)
    return {
      type: oneOf(item.type, SECTION_TYPES, `${name}.type`),
      title: text(item.title, `${name}.title`, 160),
      content: text(item.content, `${name}.content`, 5000, 180),
      evidence_refs: Array.isArray(item.evidence_refs)
        ? uniqueTexts(item.evidence_refs, `${name}.evidence_refs`, 0, 15, 60)
        : []
    }
  })
  if (!sections.some(section => section.type === 'explanation')) throw new Error('module.sections 必须包含 explanation')
  if (!sections.some(section => ['example', 'comparison', 'project_template', 'code_walkthrough'].includes(section.type))) {
    throw new Error('module.sections 必须包含示例、对比、项目模板或代码讲解')
  }
  if (sections.reduce((sum, section) => sum + section.content.length, 0) < 1200) {
    throw new Error('module.sections 教学正文合计不能少于 1200 字符')
  }
  if (!Array.isArray(raw.self_checks) || raw.self_checks.length < 2 || raw.self_checks.length > 5) {
    throw new Error('module.self_checks 必须包含 2～5 项')
  }
  const selfChecks = raw.self_checks.map((entry, index) => {
    const name = `module.self_checks[${index}]`
    const item = record(entry, name)
    exactKeys(item, ['question', 'expected_points'], name)
    return {
      question: text(item.question, `${name}.question`, 1000),
      expected_points: uniqueTexts(item.expected_points, `${name}.expected_points`, 2, 6, 500)
    }
  })
  return { ...base, sections, self_checks: selfChecks }
}

export function validatePrepTaskPracticeSet(value: unknown, moduleIds?: Set<string>): PrepTaskPracticeSet {
  const raw = record(value, 'practice_set')
  exactKeys(raw, ['items', 'completion_checklist'], 'practice_set')
  if (!Array.isArray(raw.items) || raw.items.length < 6 || raw.items.length > 12) {
    throw new Error('practice_set.items 必须包含 6～12 项')
  }
  const items = raw.items.map((entry, index): PrepPracticeItem => {
    const name = `practice_set.items[${index}]`
    const item = record(entry, name)
    exactKeys(item, [
      'level', 'type', 'prompt', 'hints', 'answer_outline', 'reference_answer',
      'follow_ups', 'rubric', 'module_ids'
    ], name)
    const ids = uniqueTexts(item.module_ids, `${name}.module_ids`, 1, 6, 20)
    if (moduleIds && ids.some(id => !moduleIds.has(id))) throw new Error(`${name}.module_ids 包含不存在的模块`)
    if (!Array.isArray(item.rubric) || item.rubric.length < 2 || item.rubric.length > 6) {
      throw new Error(`${name}.rubric 必须包含 2～6 项`)
    }
    const rubric = item.rubric.map((entry, rubricIndex) => {
      const rubricName = `${name}.rubric[${rubricIndex}]`
      const value = record(entry, rubricName)
      exactKeys(value, ['criterion', 'description', 'score'], rubricName)
      return {
        criterion: text(value.criterion, `${rubricName}.criterion`, 300),
        description: text(value.description, `${rubricName}.description`, 800),
        score: integer(value.score, `${rubricName}.score`, 1, 5)
      }
    })
    return {
      level: oneOf(item.level, PRACTICE_LEVELS, `${name}.level`),
      type: oneOf(item.type, PRACTICE_TYPES, `${name}.type`),
      prompt: text(item.prompt, `${name}.prompt`, 2500),
      hints: uniqueTexts(item.hints, `${name}.hints`, 1, 4, 800),
      answer_outline: text(item.answer_outline, `${name}.answer_outline`, 5000, 60),
      reference_answer: text(item.reference_answer, `${name}.reference_answer`, 8000, 120),
      follow_ups: uniqueTexts(item.follow_ups, `${name}.follow_ups`, 1, 5, 1000),
      rubric,
      module_ids: ids
    }
  })
  for (const level of PRACTICE_LEVELS) {
    if (!items.some(item => item.level === level)) throw new Error(`practice_set.items 缺少 ${level} 难度`)
  }
  if (new Set(items.map(item => item.prompt.normalize('NFKC').replace(/\s+/g, '').toLowerCase())).size !== items.length) {
    throw new Error('practice_set.items 不能包含重复题目')
  }
  return {
    items,
    completion_checklist: uniqueTexts(raw.completion_checklist, 'completion_checklist', 4, 10, 500)
  }
}

export function validatePrepTaskCritic(value: unknown): PrepTaskCriticResult {
  const raw = record(value, 'critic')
  exactKeys(raw, ['verdict', 'issues'], 'critic')
  if (!Array.isArray(raw.issues) || raw.issues.length > 20) throw new Error('critic.issues 必须是最多 20 项的数组')
  const issues = raw.issues.map((entry, index) => {
    const name = `critic.issues[${index}]`
    const item = record(entry, name)
    exactKeys(item, ['code', 'target', 'module_id', 'message', 'repair_instruction'], name)
    return {
      code: oneOf(item.code, CRITIC_CODES, `${name}.code`),
      target: oneOf(item.target, ['guide', 'module', 'practice'] as const, `${name}.target`),
      module_id: item.module_id === null ? null : text(item.module_id, `${name}.module_id`, 20),
      message: text(item.message, `${name}.message`, 800),
      repair_instruction: text(item.repair_instruction, `${name}.repair_instruction`, 1200)
    }
  })
  const verdict = oneOf(raw.verdict, ['pass', 'revise'] as const, 'critic.verdict')
  if (verdict === 'pass' && issues.length) throw new Error('critic.verdict 为 pass 时 issues 必须为空')
  return { verdict, issues }
}

function validateQualityReview(value: unknown): PrepTaskGuide['quality_review'] {
  const raw = record(value, 'quality_review')
  exactKeys(raw, ['verdict', 'repaired', 'issues'], 'quality_review')
  if (typeof raw.repaired !== 'boolean') throw new Error('quality_review.repaired 必须是布尔值')
  const verdict = oneOf(raw.verdict, ['pass', 'warn'] as const, 'quality_review.verdict')
  const critic = validatePrepTaskCritic({ verdict: verdict === 'pass' ? 'pass' : 'revise', issues: raw.issues })
  return { verdict, repaired: raw.repaired, issues: critic.issues }
}

export function validatePrepTaskGuide(value: unknown): PrepTaskGuide {
  const raw = record(value, 'guide')
  exactKeys(raw, [
    'version', 'overview', 'objectives', 'prerequisites', 'coverage_map', 'modules',
    'practice_set', 'completion_checklist', 'quality_review'
  ], 'guide')
  if (raw.version !== 2) throw new Error('guide.version 必须是 2')
  const rawModules = Array.isArray(raw.modules) ? raw.modules : []
  const blueprint = validatePrepTaskBlueprint({
    overview: raw.overview, objectives: raw.objectives, prerequisites: raw.prerequisites,
    coverage_map: raw.coverage_map,
    modules: rawModules.map(value => {
      const item = record(value, 'guide.modules[]')
      return {
        id: item.id, title: item.title, purpose: item.purpose,
        recommended_minutes: item.recommended_minutes,
        learning_outcomes: item.learning_outcomes, evidence_refs: item.evidence_refs
      }
    })
  })
  if (rawModules.length !== blueprint.modules.length) throw new Error('guide.modules 非法')
  const modules = rawModules.map((item, index) => validatePrepLearningModule(item, blueprint.modules[index]))
  const moduleIds = new Set(modules.map(item => item.id))
  const practice = validatePrepTaskPracticeSet({ items: raw.practice_set, completion_checklist: raw.completion_checklist }, moduleIds)
  return {
    version: 2,
    overview: blueprint.overview,
    objectives: blueprint.objectives,
    prerequisites: blueprint.prerequisites,
    coverage_map: blueprint.coverage_map,
    modules,
    practice_set: practice.items,
    completion_checklist: practice.completion_checklist,
    quality_review: validateQualityReview(raw.quality_review)
  }
}

export function normalizeStoredPrepTaskGuide(value: unknown): PrepTaskGuide {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).version === 2) {
    return validatePrepTaskGuide(value)
  }
  const legacy = record(value, 'legacy_guide')
  const overview = typeof legacy.overview === 'string' && legacy.overview.trim()
    ? legacy.overview.trim()
    : '这是由旧版执行指引转换的学习内容，建议重新生成以获得更完整的课程。'
  const objectives = Array.isArray(legacy.objectives)
    ? legacy.objectives.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
    : []
  while (objectives.length < 2) objectives.push(objectives.length ? '通过练习验证学习结果' : '完成当前任务要求的核心内容')
  const rawSteps = Array.isArray(legacy.steps) ? legacy.steps : []
  const rawPoints = Array.isArray(legacy.key_points) ? legacy.key_points : []
  const modules: PrepLearningModule[] = (rawSteps.length ? rawSteps : [{ title: '旧版学习内容', minutes: 30, instruction: overview }])
    .slice(0, 6)
    .map((entry, index) => {
      const step = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {}
      const point = rawPoints[index] && typeof rawPoints[index] === 'object' && !Array.isArray(rawPoints[index])
        ? rawPoints[index] as Record<string, unknown>
        : {}
      const instruction = typeof step.instruction === 'string' ? step.instruction : overview
      const explanation = typeof point.explanation === 'string' ? point.explanation : instruction
      const padded = (value: string): string => value.length >= 180
        ? value
        : `${value}\n\n这是旧版指引保存的简要内容，信息深度有限。重新生成后会补充原理、示例、易错点、面试表达和分层练习。`.repeat(2)
      return {
        id: `M${index + 1}`,
        title: typeof step.title === 'string' && step.title.trim() ? step.title.trim() : `学习模块 ${index + 1}`,
        purpose: '承接旧版执行步骤；重新生成后可获得完整教学内容。',
        recommended_minutes: Number.isInteger(Number(step.minutes)) ? Math.max(5, Math.min(480, Number(step.minutes))) : 30,
        learning_outcomes: ['能够复述本模块核心内容', '能够回答至少一道相关面试问题'],
        evidence_refs: [],
        sections: [
          { type: 'explanation', title: '旧版讲解', content: padded(explanation), evidence_refs: [] },
          { type: 'example', title: '旧版示例说明', content: padded(instruction), evidence_refs: [] },
          { type: 'pitfall', title: '需要进一步补充', content: padded('旧版没有生成完整的易错点分析。'), evidence_refs: [] },
          { type: 'interview_answer', title: '面试表达提醒', content: padded('请根据任务完成标准整理自己的表达，涉及个人经历时只使用真实信息。'), evidence_refs: [] }
        ],
        self_checks: [
          { question: '你能否脱稿说明本模块的核心内容？', expected_points: ['结论明确', '说明原因'] },
          { question: '你能否给出一个具体例子？', expected_points: ['例子与主题相关', '说明适用边界'] }
        ]
      }
    })
  const moduleIds = modules.map(item => item.id)
  const rawExercises = Array.isArray(legacy.exercises) ? legacy.exercises : []
  const levels: PrepPracticeLevel[] = ['basic', 'understanding', 'application', 'interview']
  const practiceSet: PrepPracticeItem[] = Array.from({ length: 6 }, (_, index) => {
    const source = rawExercises[index % Math.max(1, rawExercises.length)]
    const item = source && typeof source === 'object' && !Array.isArray(source) ? source as Record<string, unknown> : {}
    const prompt = typeof item.prompt === 'string' ? item.prompt : `请说明学习模块 ${modules[index % modules.length].title} 的核心内容。`
    const outline = typeof item.answer_outline === 'string' ? item.answer_outline : '先给结论，再解释原理，最后给出例子和适用边界。'
    return {
      level: levels[index % levels.length],
      type: index >= 4 ? 'mock_question' : 'short_answer',
      prompt: `${prompt}${index >= rawExercises.length ? `（扩展练习 ${index + 1}）` : ''}`,
      hints: [typeof item.guidance === 'string' ? item.guidance : '结合本模块内容回答。'],
      answer_outline: outline.length >= 60 ? outline : `${outline} 同时说明关键概念、工作机制、具体示例和常见错误。`,
      reference_answer: `${outline}\n\n这是旧版内容转换出的答案框架。请重新生成执行指引，以获得更完整、经过质量检查的参考答案。`,
      follow_ups: Array.isArray(item.follow_ups) && item.follow_ups.length
        ? item.follow_ups.filter((value): value is string => typeof value === 'string').slice(0, 5)
        : ['这个结论在什么情况下不成立？'],
      rubric: [
        { criterion: '准确性', description: '结论和关键概念正确。', score: 5 },
        { criterion: '完整性', description: '包含原理、例子和边界。', score: 5 }
      ],
      module_ids: [modules[index % modules.length].id]
    }
  })
  const checklist = Array.isArray(legacy.completion_checklist)
    ? legacy.completion_checklist.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map(item => item.trim())
    : []
  while (checklist.length < 4) checklist.push([
    '已完成全部学习模块', '已完成基础与应用练习', '可以脱稿回答核心问题', '已核对个人经历均为真实信息'
  ][checklist.length])
  return {
    version: 2,
    overview,
    objectives: objectives.slice(0, 8),
    prerequisites: [],
    coverage_map: objectives.slice(0, 8).map((objective, index) => ({
      objective,
      module_ids: [moduleIds[index % moduleIds.length]],
      practice_levels: [levels[index % levels.length]]
    })),
    modules,
    practice_set: practiceSet,
    completion_checklist: checklist.slice(0, 10),
    quality_review: {
      verdict: 'warn', repaired: false,
      issues: [{
        code: 'SHALLOW_MODULE', target: 'guide', module_id: null,
        message: '这是旧版简要指引的兼容视图，内容深度有限。',
        repair_instruction: '点击重新生成指引以创建完整课程。'
      }]
    }
  }
}
