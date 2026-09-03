import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, getSetting, now, setSetting } from './db.js'

// 火山方舟（OpenAI 兼容协议）配置与统一调用封装。
// 配置文件：项目根目录 config.json（参考 config.example.json，已 gitignore）。

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredConfigPath = process.env.JOB_TRACER_CONFIG_PATH?.trim()
const CONFIG_PATH = configuredConfigPath ? path.resolve(configuredConfigPath) : path.resolve(__dirname, '../../config.json')

export type AiTask =
  | 'applicationImport'
  | 'jdParse'
  | 'knowledgeExtract'
  | 'answerGenerate'
  | 'tutor'
  | 'recordingReview'
  | 'reviewAdvice'
  | 'interviewPrepAgent'
  | 'mailRecruitmentExtract'
  | 'mailScheduleReview'

export type AiOutputMode = 'text' | 'json_object' | 'json_schema'
export type AiThinking = 'enabled' | 'disabled'

export interface ArkModel {
  id: string
  label: string
  /** 图片能力必须显式设为 true，未知能力不会接收图片。 */
  vision?: boolean
  structuredOutput?: boolean
  thinking?: boolean
  streaming?: boolean
  maxImages?: number
  maxOutputTokens?: number
}

export interface ArkTaskConfig {
  enabled?: boolean
  model?: string
  outputMode?: AiOutputMode
  maxImages?: number
  maxOutputTokens?: number
  temperature?: number
  timeoutMs?: number
  thinking?: AiThinking
}

export interface ArkConfig {
  apiKey: string
  baseUrl: string
  models: ArkModel[]
  defaultModel: string
  tasks: Partial<Record<AiTask, ArkTaskConfig>>
  /** 旧配置兼容；等价于 tasks.applicationImport。 */
  recruitment?: ArkTaskConfig
}

export const AI_TASKS: AiTask[] = [
  'applicationImport', 'jdParse', 'knowledgeExtract', 'answerGenerate',
  'tutor', 'recordingReview', 'reviewAdvice', 'interviewPrepAgent', 'mailRecruitmentExtract', 'mailScheduleReview'
]

const TASK_DEFAULTS: Record<AiTask, Required<Omit<ArkTaskConfig, 'model' | 'maxImages' | 'enabled'>>> = {
  applicationImport: { outputMode: 'text', maxOutputTokens: 8192, temperature: 0, timeoutMs: 120_000, thinking: 'disabled' },
  jdParse: { outputMode: 'text', maxOutputTokens: 4096, temperature: 0, timeoutMs: 60_000, thinking: 'disabled' },
  knowledgeExtract: { outputMode: 'text', maxOutputTokens: 4096, temperature: 0, timeoutMs: 90_000, thinking: 'disabled' },
  answerGenerate: { outputMode: 'text', maxOutputTokens: 8192, temperature: 0.2, timeoutMs: 180_000, thinking: 'disabled' },
  tutor: { outputMode: 'text', maxOutputTokens: 4096, temperature: 0.3, timeoutMs: 120_000, thinking: 'disabled' },
  recordingReview: { outputMode: 'text', maxOutputTokens: 8192, temperature: 0.2, timeoutMs: 300_000, thinking: 'disabled' },
  reviewAdvice: { outputMode: 'text', maxOutputTokens: 4096, temperature: 0.3, timeoutMs: 90_000, thinking: 'disabled' },
  interviewPrepAgent: { outputMode: 'text', maxOutputTokens: 4096, temperature: 0.2, timeoutMs: 90_000, thinking: 'disabled' },
  mailRecruitmentExtract: { outputMode: 'text', maxOutputTokens: 4096, temperature: 0, timeoutMs: 90_000, thinking: 'disabled' },
  mailScheduleReview: { outputMode: 'text', maxOutputTokens: 2048, temperature: 0, timeoutMs: 60_000, thinking: 'disabled' }
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function normalizeTaskConfig(value: unknown): ArkTaskConfig | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const outputMode = ['text', 'json_object', 'json_schema'].includes(String(raw.outputMode))
    ? raw.outputMode as AiOutputMode
    : undefined
  const thinking = raw.thinking === 'enabled' || raw.thinking === 'disabled' ? raw.thinking : undefined
  const temperature = typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2
    ? raw.temperature
    : undefined
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : undefined,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : undefined,
    outputMode,
    maxImages: positiveInteger(raw.maxImages),
    maxOutputTokens: positiveInteger(raw.maxOutputTokens),
    timeoutMs: positiveInteger(raw.timeoutMs),
    temperature,
    thinking
  }
}

export function loadArkConfig(): ArkConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as { ark?: Record<string, unknown> }
    const ark = raw.ark
    if (!ark || typeof ark.apiKey !== 'string' || !ark.apiKey.trim() || ark.apiKey.includes('填入')) return null

    const modelList = Array.isArray(ark.models) ? ark.models : []
    const models: ArkModel[] = modelList
      .filter((value): value is Record<string, unknown> => !!value && typeof value === 'object')
      .filter(value => typeof value.id === 'string' && value.id.trim() && !value.id.includes('填入'))
      .map(value => ({
        id: String(value.id).trim(),
        label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : String(value.id).trim(),
        vision: typeof value.vision === 'boolean' ? value.vision : undefined,
        structuredOutput: typeof value.structuredOutput === 'boolean' ? value.structuredOutput : undefined,
        thinking: typeof value.thinking === 'boolean' ? value.thinking : undefined,
        streaming: typeof value.streaming === 'boolean' ? value.streaming : undefined,
        maxImages: positiveInteger(value.maxImages),
        maxOutputTokens: positiveInteger(value.maxOutputTokens)
      }))

    const legacyModel = typeof ark.model === 'string' && ark.model.trim() && !ark.model.includes('填入')
      ? ark.model.trim()
      : undefined
    if (legacyModel && !models.some(model => model.id === legacyModel)) {
      models.unshift({ id: legacyModel, label: legacyModel })
    }
    if (!models.length) return null

    const rawTasks = ark.tasks && typeof ark.tasks === 'object' ? ark.tasks as Record<string, unknown> : {}
    const tasks: Partial<Record<AiTask, ArkTaskConfig>> = {}
    for (const task of AI_TASKS) {
      const normalized = normalizeTaskConfig(rawTasks[task])
      if (normalized) tasks[task] = normalized
    }
    const recruitment = normalizeTaskConfig(ark.recruitment)
    if (recruitment && !tasks.applicationImport) tasks.applicationImport = recruitment

    const configuredDefault = typeof ark.defaultModel === 'string' ? ark.defaultModel.trim() : legacyModel
    const defaultModel = configuredDefault && models.some(model => model.id === configuredDefault)
      ? configuredDefault
      : models[0].id

    return {
      apiKey: ark.apiKey.trim(),
      baseUrl: (typeof ark.baseUrl === 'string' && ark.baseUrl.trim()
        ? ark.baseUrl.trim()
        : 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, ''),
      models,
      defaultModel,
      tasks,
      recruitment
    }
  } catch {
    return null
  }
}

export interface ResolvedAiTask extends Required<Omit<ArkTaskConfig, 'maxImages' | 'enabled'>> {
  task: AiTask
  maxImages?: number
  modelEntry: ArkModel
}

const TASK_ENABLED_PREFIX = 'ai_task_enabled:'

/** 运行时开关优先于 config.json；未显式配置时默认启用。 */
export function isAiTaskEnabled(task: AiTask): boolean {
  const saved = getSetting(`${TASK_ENABLED_PREFIX}${task}`)
  if (saved === '0') return false
  if (saved === '1') return true
  return loadArkConfig()?.tasks[task]?.enabled !== false
}

export function setAiTaskEnabled(task: AiTask, enabled: boolean): void {
  setSetting(`${TASK_ENABLED_PREFIX}${task}`, enabled ? '1' : '0')
}

export function resolveAiTask(task: AiTask, overrides: ArkTaskConfig = {}): ResolvedAiTask | null {
  const config = loadArkConfig()
  if (!config) return null
  const configured = config.tasks[task] ?? {}
  const defaults = TASK_DEFAULTS[task]
  const modelId = overrides.model ?? configured.model ?? config.defaultModel
  const modelEntry = config.models.find(model => model.id === modelId)
  if (!modelEntry) return null
  const maxOutputTokens = Math.min(
    positiveInteger(overrides.maxOutputTokens) ?? positiveInteger(configured.maxOutputTokens) ?? defaults.maxOutputTokens,
    modelEntry.maxOutputTokens ?? Number.MAX_SAFE_INTEGER
  )
  const configuredImages = positiveInteger(overrides.maxImages) ?? positiveInteger(configured.maxImages)
  const maxImages = configuredImages && modelEntry.maxImages
    ? Math.min(configuredImages, modelEntry.maxImages)
    : configuredImages ?? modelEntry.maxImages
  return {
    task,
    model: modelEntry.id,
    modelEntry,
    outputMode: overrides.outputMode ?? configured.outputMode ?? defaults.outputMode,
    maxImages,
    maxOutputTokens,
    temperature: overrides.temperature ?? configured.temperature ?? defaults.temperature,
    timeoutMs: overrides.timeoutMs ?? configured.timeoutMs ?? defaults.timeoutMs,
    thinking: overrides.thinking ?? configured.thinking ?? defaults.thinking
  }
}

/** 助教对话用的模型：运行时选择 > tutor 任务配置 > 默认模型。 */
export function tutorModel(): string | null {
  const config = loadArkConfig()
  if (!config) return null
  const saved = getSetting('tutor_model')
  if (saved && config.models.some(model => model.id === saved)) return saved
  return resolveAiTask('tutor')?.model ?? config.defaultModel
}

export function setTutorModel(modelId: string): boolean {
  const config = loadArkConfig()
  if (!config || !config.models.some(model => model.id === modelId)) return false
  setSetting('tutor_model', modelId)
  return true
}

/** 图片输入模型必须显式声明 vision: true。 */
export function visionArkModel(task: AiTask = 'knowledgeExtract'): string | null {
  const config = loadArkConfig()
  if (!config) return null
  const resolved = resolveAiTask(task)
  if (resolved?.modelEntry.vision === true) return resolved.model
  return config.models.find(model => model.vision === true)?.id ?? null
}

export type ChatContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: ChatContent
}

export interface AiUsage {
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
}

export interface AiCompletionResult {
  content: string
  model: string
  finishReason: string | null
  usage: AiUsage | null
  requestId: string | null
  durationMs: number
}

export class AiError extends Error {
  constructor(message: string, public statusCode = 502, public kind = 'provider_error') {
    super(message)
  }
}

interface CompletionOptions extends ArkTaskConfig {
  task?: AiTask
  signal?: AbortSignal
  responseSchema?: { name: string; schema: Record<string, unknown> }
}

interface ProviderMessage { content?: unknown }

interface ProviderPayload {
  id?: unknown
  model?: unknown
  choices?: { finish_reason?: unknown; message?: ProviderMessage }[]
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
}

function hasImages(messages: ChatMessage[]): number {
  return messages.reduce((count, message) => count + (Array.isArray(message.content)
    ? message.content.filter(part => part.type === 'image_url').length
    : 0), 0)
}

function providerError(status: number): AiError {
  if (status === 400) return new AiError('模型拒绝了请求，请检查任务模型及输出参数配置', 502, 'bad_request')
  if (status === 401 || status === 403) return new AiError('模型鉴权失败，请检查 API Key、模型 ID 和访问权限', 502, 'auth')
  if (status === 429) return new AiError('模型服务请求过于频繁，请稍后重试', 503, 'rate_limit')
  if (status >= 500) return new AiError('模型服务暂时不可用，请稍后重试', 503, 'provider_unavailable')
  return new AiError(`模型请求失败（${status}），请稍后重试`, 502, 'provider_error')
}

function unsupportedThinking(status: number, body: string): boolean {
  return status === 400 && /thinking/i.test(body) && /(unsupported|not support|unknown|unrecognized|invalid|不支持|未知)/i.test(body)
}

function responseFormat(mode: AiOutputMode, schema?: CompletionOptions['responseSchema']): Record<string, unknown> | undefined {
  if (mode === 'json_object') return { type: 'json_object' }
  if (mode === 'json_schema' && schema) {
    return { type: 'json_schema', json_schema: { name: schema.name, strict: true, schema: schema.schema } }
  }
  return undefined
}

function safeUsage(usage: ProviderPayload['usage']): AiUsage | null {
  if (!usage) return null
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : undefined
  return {
    promptTokens: number(usage.prompt_tokens),
    completionTokens: number(usage.completion_tokens),
    totalTokens: number(usage.total_tokens)
  }
}

async function requestCompletionRaw(
  messages: ChatMessage[],
  options: CompletionOptions
): Promise<AiCompletionResult> {
  const config = loadArkConfig()
  if (!config) throw new AiError('AI 未配置：请复制 config.example.json 为 config.json，填入火山方舟 API Key 和模型 ID', 422, 'not_configured')
  const task = options.task ?? 'reviewAdvice'
  const resolved = resolveAiTask(task, options)
  if (!resolved) throw new AiError(`AI 任务 ${task} 没有可用模型，请检查 config.json`, 422, 'model_not_configured')

  const imageCount = hasImages(messages)
  if (imageCount) {
    if (resolved.modelEntry.vision !== true) throw new AiError('当前任务模型未明确配置 vision: true，不能发送图片', 422, 'model_capability')
    if (resolved.maxImages && imageCount > resolved.maxImages) throw new AiError(`当前任务最多允许 ${resolved.maxImages} 张图片`, 422, 'input_limit')
  }
  if (resolved.thinking === 'enabled' && resolved.modelEntry.thinking !== true) {
    throw new AiError('当前任务启用了 thinking，但所选模型没有显式声明 thinking: true', 422, 'model_capability')
  }
  if (resolved.outputMode === 'json_schema' && resolved.modelEntry.structuredOutput !== true) {
    throw new AiError('当前任务要求 json_schema，但所选模型没有显式声明 structuredOutput: true', 422, 'model_capability')
  }

  const format = responseFormat(resolved.outputMode, options.responseSchema)
  const baseBody: Record<string, unknown> = {
    model: resolved.model,
    stream: false,
    messages,
    temperature: resolved.temperature,
    max_tokens: resolved.maxOutputTokens
  }
  if (format) baseBody.response_format = format
  if (resolved.thinking) baseBody.thinking = { type: resolved.thinking }

  const timeoutSignal = AbortSignal.timeout(resolved.timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal
  const started = Date.now()
  let thinkingDowngraded = false

  for (let attempt = 0; attempt < 2; attempt++) {
    let response: Response
    try {
      response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(baseBody),
        signal
      })
    } catch {
      if (signal.aborted) throw new AiError(options.signal?.aborted ? 'AI 请求已取消' : 'AI 请求超时，请稍后重试', 504, 'timeout')
      if (attempt === 0) continue
      throw new AiError('模型服务连接失败，请检查网络后重试', 502, 'network')
    }

    if (!response.ok) {
      const raw = await response.text().catch(() => '')
      if (!thinkingDowngraded && unsupportedThinking(response.status, raw) && 'thinking' in baseBody) {
        delete baseBody.thinking
        thinkingDowngraded = true
        attempt--
        continue
      }
      if (attempt === 0 && (response.status === 429 || response.status >= 500)) continue
      throw providerError(response.status)
    }

    let payload: ProviderPayload
    try {
      payload = await response.json() as ProviderPayload
    } catch {
      throw new AiError('模型服务返回了无法解析的响应', 502, 'invalid_response')
    }
    const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null
    const content = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : ''
    if (finishReason !== 'stop') {
      const message = finishReason === 'length'
        ? '模型输出达到长度上限，请减少输入或提高该任务的 maxOutputTokens'
        : finishReason === 'content_filter'
          ? '模型未能完成输出，请检查输入内容后重试'
          : '模型未完整输出结果，请稍后重试'
      throw new AiError(message, 502, 'incomplete_output')
    }
    if (!content) throw new AiError('模型返回为空', 502, 'empty_output')
    if (content.length > 100_000) throw new AiError('模型输出过长，请减少输入后重试', 502, 'output_limit')

    return {
      content,
      model: typeof payload.model === 'string' ? payload.model : resolved.model,
      finishReason,
      usage: safeUsage(payload.usage),
      requestId: typeof payload.id === 'string' ? payload.id : response.headers.get('x-request-id'),
      durationMs: Date.now() - started
    }
  }
  throw new AiError('模型请求失败，请稍后重试', 502, 'provider_error')
}

function hashMessages(messages: ChatMessage[]): string {
  const hash = createHash('sha256')
  for (const message of messages) {
    hash.update(message.role)
    hash.update('\0')
    const content = message.content
    if (Array.isArray(content)) {
      for (const part of content) {
        hash.update(part.type)
        hash.update(part.type === 'text' ? part.text : part.image_url.url)
      }
    } else {
      hash.update(content ?? '')
    }
    hash.update('\0')
  }
  return hash.digest('hex')
}

interface AiRunLog {
  task: AiTask
  model: string | null
  promptHash: string
  durationMs: number
  status: 'succeeded' | 'failed'
  result?: AiCompletionResult
  errorType?: string
}

function writeAiRun(entry: AiRunLog): void {
  try {
    db.prepare(`INSERT INTO ai_runs (
      task, model, prompt_hash, request_id, duration_ms, finish_reason,
      prompt_tokens, completion_tokens, total_tokens, status, error_type, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.task,
      entry.result?.model ?? entry.model,
      entry.promptHash,
      entry.result?.requestId ?? null,
      entry.result?.durationMs ?? entry.durationMs,
      entry.result?.finishReason ?? null,
      entry.result?.usage?.promptTokens ?? null,
      entry.result?.usage?.completionTokens ?? null,
      entry.result?.usage?.totalTokens ?? null,
      entry.status,
      entry.errorType ?? null,
      now()
    )
    // 单机工具保留最近 5000 次调用，避免日志无界增长。
    db.prepare('DELETE FROM ai_runs WHERE id NOT IN (SELECT id FROM ai_runs ORDER BY id DESC LIMIT 5000)').run()
  } catch (error) {
    console.error('写入 AI 调用日志失败:', (error as Error).message)
  }
}

async function requestCompletion(
  messages: ChatMessage[],
  options: CompletionOptions
): Promise<AiCompletionResult> {
  const task = options.task ?? 'reviewAdvice'
  const started = Date.now()
  const promptHash = hashMessages(messages)
  const model = resolveAiTask(task, options)?.model ?? options.model ?? null
  try {
    if (!isAiTaskEnabled(task)) {
      throw new AiError('该 AI 功能已停用，可在“AI 数据说明”中重新开启', 422, 'task_disabled')
    }
    const response = await requestCompletionRaw(messages, options)
    writeAiRun({ task, model, promptHash, durationMs: Date.now() - started, status: 'succeeded', result: response })
    return response
  } catch (error) {
    writeAiRun({
      task,
      model,
      promptHash,
      durationMs: Date.now() - started,
      status: 'failed',
      errorType: error instanceof AiError ? error.kind : 'unexpected'
    })
    throw error
  }
}

/** 统一文本调用；需要 usage/finishReason 等信息时使用此接口。 */
export async function completeChat(messages: ChatMessage[], options: CompletionOptions = {}): Promise<AiCompletionResult> {
  return requestCompletion(messages, options)
}

/** 旧调用兼容包装；新代码优先使用 completeChat。 */
export async function chat(messages: ChatMessage[], timeoutMs = 60_000, options?: { model?: string; task?: AiTask }): Promise<string> {
  const result = await completeChat(messages, { ...options, timeoutMs })
  return result.content
}

/** 从模型输出中提取 JSON（容忍 ```json 包裹和前后说明文字）。 */
export function extractJson<T>(text: string): T {
  let value = text.trim()
  const fence = value.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) value = fence[1].trim()
  const objectStart = value.indexOf('{')
  const objectEnd = value.lastIndexOf('}')
  if (objectStart >= 0 && objectEnd > objectStart) value = value.slice(objectStart, objectEnd + 1)
  return JSON.parse(value) as T
}

export interface StructuredChatOptions<T> extends CompletionOptions {
  schemaName: string
  schema: Record<string, unknown>
  validate: (value: unknown) => T
  repairInstruction?: (error: Error) => string
}

/** 统一结构化输出：解析、运行时校验，并在失败时最多修复一次。 */
export async function completeStructured<T>(
  messages: ChatMessage[],
  options: StructuredChatOptions<T>
): Promise<{ value: T; completion: AiCompletionResult; attempts: number }> {
  let currentMessages = messages
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const completion = await completeChat(currentMessages, {
      ...options,
      responseSchema: { name: options.schemaName, schema: options.schema }
    })
    try {
      const value = options.validate(extractJson<unknown>(completion.content))
      return { value, completion, attempts: attempt }
    } catch (error) {
      lastError = error as Error
      if (attempt === 2) break
      const repair = options.repairInstruction?.(lastError)
        ?? `上次输出未通过校验：${lastError.message.slice(0, 300)}。请仅修正格式和缺失字段，不补造事实，返回完整 JSON。`
      currentMessages = [
        ...messages,
        { role: 'assistant', content: completion.content },
        { role: 'user', content: repair }
      ]
    }
  }
  throw new AiError(`模型结果格式仍不符合要求：${lastError?.message ?? '未知校验错误'}`, 502, 'validation')
}
