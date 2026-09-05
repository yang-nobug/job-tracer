import { createHash } from 'node:crypto'
import { AiError, completeStructured, isAiTaskEnabled, loadArkConfig, resolveAiTask, type ChatContent, type ChatMessage } from './ai.js'
import { loadPrompt } from './prompt-loader.js'
import {
  EXTRACTION_SCHEMA, IMPORT_FIELDS, IMPORT_LIMITS, normalizeExtraction, validateExtraction,
  type ExtractionResult, type ImportSource, type Evidence, type ImportAnalysis
} from '../../shared/application-import.js'
import { ImportError, getImport, imageDataUrl, findDuplicates } from './application-materials.js'
import { resolveAppliedDate } from './application-dates.js'

export function extractionConfig() {
  const config = loadArkConfig()
  if (!config || !isAiTaskEnabled('applicationImport')) return { available: false, model: null, imageModel: null, maxImages: IMPORT_LIMITS.images }
  const resolved = resolveAiTask('applicationImport')
  const hasTaskModel = !!config.tasks.applicationImport?.model
  const imageModel = resolved?.modelEntry.vision === true
    ? resolved.modelEntry
    : hasTaskModel ? undefined : config.models.find(item => item.vision === true)
  const max = resolved?.maxImages ?? IMPORT_LIMITS.images
  return { available: !!resolved, model: resolved?.model ?? null, imageModel: imageModel?.id ?? null, maxImages: Math.max(1, Math.min(IMPORT_LIMITS.images, max)) }
}

function knownEvidence(evidence: Evidence[], sources: ImportSource[]): Evidence[] {
  return evidence.filter(item => sources.some(source => source.id === item.source_id))
}

/**
 * 视觉模型的引用文字不能在本地重新 OCR 验证。这里仅移除不存在的材料编号，
 * 不会因引用缺失或措辞差异清空模型已经输出的字段值；证据用于用户核对。
 */
export function normalizeEvidenceReferences(result: ExtractionResult, sources: ImportSource[]): ExtractionResult {
  for (const candidate of result.target_candidates) {
    const validSourceIds = candidate.source_ids.filter(id => sources.some(source => source.id === id))
    if (validSourceIds.length !== candidate.source_ids.length) {
      candidate.source_ids = validSourceIds
      result.warnings.push('一个目标岗位引用了不存在的材料编号，已忽略该编号')
    }
  }
  for (const key of IMPORT_FIELDS) {
    const field = result.fields[key]
    field.evidence = knownEvidence(field.evidence, sources)
    field.alternatives = field.alternatives.map(option => ({ ...option, evidence: knownEvidence(option.evidence, sources) }))
    if (field.state === 'conflict' && field.alternatives.length < 2) field.state = 'uncertain'
  }
  result.date_facts = result.date_facts.filter(fact => {
    fact.evidence = knownEvidence(fact.evidence, sources)
    if (!fact.evidence.length) { result.warnings.push('一条日期引用了不存在的材料，已排除'); return false }
    if (fact.kind === 'application' && !fact.evidence.some(e => /投递|申请|提交简历|简历提交/.test(e.quote))) {
      fact.kind = 'unknown'; result.warnings.push('日期引用未说明是投递时间，需核对')
    }
    if (fact.kind === 'application' && fact.evidence.some(e => /准备|计划|将于|打算|明天|明日/.test(e.quote))) {
      fact.kind = 'planned_application'; result.warnings.push('计划投递时间不作为实际投递时间')
    }
    return true
  })
  if (result.target_state !== 'single') {
    for (const field of Object.values(result.fields)) { field.value = null; field.state = 'uncertain'; field.alternatives = [] }
    result.date_facts = []
    result.warnings.push('材料包含多个岗位或目标不明，请移除无关材料后重新识别')
  }
  return result
}

export async function analyzeImport(id: string, cancel: AbortSignal): Promise<ImportAnalysis> {
  const draft = getImport(id)
  const config = loadArkConfig()
  const capabilities = extractionConfig()
  const images = draft.sources.filter(source => source.kind === 'image')
  const model = images.length ? capabilities.imageModel : capabilities.model
  if (!config || !model) throw new ImportError(images.length ? '请在 config.json 的 ark.models 中配置一个明确标注 vision: true 的图片模型' : '尚未配置可用的 AI 模型')
  if (images.length > capabilities.maxImages) throw new ImportError(`当前模型配置最多 ${capabilities.maxImages} 张图，请减少材料`)
  const prompt = loadPrompt('application-extract.system.md')
  const content: Exclude<ChatContent, string> = [{ type: 'text', text: JSON.stringify({ task: '提取一个岗位，材料如下', sources: draft.sources.map(s => ({ id: s.id, captured_at: s.captured_at })) }) }]
  for (const source of draft.sources) {
    content.push({ type: 'text', text: JSON.stringify({ source_id: source.id, material_text: source.text }) })
    if (source.kind === 'image') content.push({ type: 'image_url', image_url: { url: imageDataUrl(id, source.id) } })
  }
  content.push({ type: 'text', text: '材料已提供完毕。请按系统规则输出 JSON。' })
  const messages: ChatMessage[] = [
    { role: 'system', content: `${prompt}\n\nJSON Schema:\n${JSON.stringify(EXTRACTION_SCHEMA)}` },
    { role: 'user', content }
  ]
  const started = Date.now()
  try {
    const structured = await completeStructured(messages, {
      task: 'applicationImport',
      model,
      signal: cancel,
      schemaName: 'application_extraction',
      schema: EXTRACTION_SCHEMA,
      validate: value => normalizeEvidenceReferences(validateExtraction(normalizeExtraction(value)), draft.sources),
      repairInstruction: error => `上次输出未通过结构校验：${error.message.slice(0, 300)}。已重新附上全部截图、文字材料和你的上一轮输出。请在不丢失已识别字段值的前提下，只修正 JSON 格式、缺失字段或非法枚举；返回完整 JSON。`
    })
    const extraction: ExtractionResult = structured.value
    const applied_date = resolveAppliedDate(extraction.date_facts, draft.sources)
    if (extraction.target_state === 'single' && applied_date.state === 'resolved') {
      const status = extraction.fields.status
      if (status.state === 'missing') extraction.fields.status = { value: 'applied', state: 'extracted', evidence: applied_date.candidates[0].evidence, alternatives: [] }
      if (status.value === 'unsent') {
        status.state = 'conflict'; status.alternatives = [{ value: 'unsent', evidence: status.evidence }, { value: 'applied', evidence: applied_date.candidates[0].evidence }]; status.value = null
        extraction.warnings.push('存在实际投递时间，但状态显示未投递，请核对')
      }
    }
    const values = Object.fromEntries(IMPORT_FIELDS.map(key => [key, extraction.fields[key].value ?? '']))
    console.info(`[application-extract] model=${structured.completion.model} duration_ms=${Date.now() - started} attempts=${structured.attempts}`)
    return { extraction, applied_date, duplicates: values.company && values.position ? findDuplicates({ company: values.company, position: values.position, location: values.location, jd_link: values.jd_link }) : [], model: structured.completion.model, prompt_version: `1-${createHash('sha256').update(prompt).digest('hex').slice(0, 12)}` }
  } catch (error) {
    if (error instanceof ImportError) throw error
    if (error instanceof AiError) {
      const message = error.kind === 'validation'
        ? `模型输出仍不完整：${error.message.replace(/^模型结果格式仍不符合要求：?\s*/, '').slice(0, 160)}。请重新识别或手动录入`
        : error.message
      throw new ImportError(message, error.statusCode)
    }
    throw new ImportError('识别失败，请稍后重试', 502)
  }
}
