import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db, getSetting, setSetting } from './db.js'

// 火山方舟（OpenAI 兼容协议）配置与调用封装
// 配置文件：项目根目录 config.json（参考 config.example.json，已 gitignore）
// 支持多模型登记（ark.models）+ 运行时切换（当前选择存 SQLite settings 表）

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

export interface ArkModel {
  id: string       // 模型 ID（endpoint 或完整 id）
  label: string    // 界面显示名
  vision?: boolean // 是否支持图片输入（截图识别用）
}

export interface ArkConfig {
  apiKey: string
  baseUrl: string
  models: ArkModel[]      // 可选模型列表（至少一项）
  defaultModel: string    // 默认模型 id
  recruitment?: {
    model?: string
    outputMode?: 'text' | 'json_object' | 'json_schema'
    maxImages?: number
    temperature?: number
    thinking?: 'enabled' | 'disabled'
  }
}

export function loadArkConfig(): ArkConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as {
      ark?: { apiKey?: string; model?: string; baseUrl?: string; models?: Partial<ArkModel>[]; recruitment?: ArkConfig['recruitment'] }
    }
    const ark = raw.ark
    if (!ark?.apiKey) return null
    if (ark.apiKey.includes('填入')) return null

    // 模型列表：优先 ark.models，否则退回单个 ark.model
    const models: ArkModel[] = Array.isArray(ark.models) && ark.models.length
      ? ark.models
          .filter((m) => m && typeof m.id === 'string' && m.id && !String(m.id).includes('填入'))
          .map((m) => ({ id: m.id!, label: m.label || m.id!, vision: m.vision }))
      : []
    if (ark.model && !ark.model.includes('填入') && !models.some((m) => m.id === ark.model)) {
      models.unshift({ id: ark.model, label: ark.model })
    }
    if (!models.length) return null

    return {
      apiKey: ark.apiKey,
      baseUrl: ark.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3',
      models,
      recruitment: ark.recruitment,
      defaultModel: ark.model && !ark.model.includes('填入') && models.some((m) => m.id === ark.model)
        ? ark.model
        : models[0].id
    }
  } catch {
    return null
  }
}

/** 助教对话用的模型：settings 里的选择 > config 默认（只影响 AI 助教，其他 AI 功能始终用默认模型） */
export function tutorModel(): string | null {
  const config = loadArkConfig()
  if (!config) return null
  const saved = getSetting('tutor_model')
  if (saved && config.models.some((m) => m.id === saved)) return saved
  return config.defaultModel
}

/** 切换助教模型（校验必须在列表内）；返回是否成功 */
export function setTutorModel(modelId: string): boolean {
  const config = loadArkConfig()
  if (!config || !config.models.some((m) => m.id === modelId)) return false
  setSetting('tutor_model', modelId)
  return true
}

/** 图片输入用的模型：默认模型标了 vision:false 时，找列表里第一个 vision 模型兜底 */
export function visionArkModel(): string | null {
  const config = loadArkConfig()
  if (!config) return null
  const defaultEntry = config.models.find((m) => m.id === config.defaultModel)
  if (!defaultEntry || defaultEntry.vision !== false) return config.defaultModel
  const fallback = config.models.find((m) => m.vision === true)
  return fallback ? fallback.id : null
}

/** 多模态消息内容：纯文本，或 文本+图片 混合数组 */
export type ChatContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
>

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: ChatContent
}

interface ChatOptions {
  model?: string   // 指定模型（默认用当前生效模型）
}

/** 发起一次 chat/completions 请求 */
async function postCompletion(config: ArkConfig, model: string, body: object, signal: AbortSignal): Promise<Response> {
  return fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify({ ...body, model }),
    signal
  })
}

/** 调用大模型，返回文本内容；错误时抛出带用户可读信息的 Error */
export async function chat(messages: ChatMessage[], timeoutMs = 60_000, options?: ChatOptions): Promise<string> {
  const config = loadArkConfig()
  if (!config) {
    throw new Error('AI 未配置：请复制 config.example.json 为 config.json，填入火山方舟 API Key 和模型 ID')
  }
  const model = options?.model || config.defaultModel

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const base = { messages, temperature: 0.3 }
    // 豆包思考型模型：本工具的任务简单，默认关闭深度思考以提速省费
    let res = await postCompletion(config, model, { ...base, thinking: { type: 'disabled' } }, controller.signal)
    // 模型不支持 thinking 参数时自动去掉重试
    if (res.status === 400) {
      res = await postCompletion(config, model, base, controller.signal)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`火山方舟请求失败 (${res.status}): ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[]
    }
    const content = data.choices?.[0]?.message?.content
    if (!content) throw new Error('模型返回为空')
    return content
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('AI 请求超时，请稍后重试')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型输出中稳健地提取 JSON（容忍 ```json 包裹、前后杂文字） */
export function extractJson<T>(text: string): T {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return JSON.parse(t) as T
}

// ---------- 工具调用（function calling，浏览器自动化 agent 用） ----------

/** OpenAI 兼容协议的一次函数调用 */
export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/** 支持工具调用协议的多轮消息（比 ChatMessage 多 assistant.tool_calls 与 tool 角色） */
export type ToolChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: ChatContent }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** 调用大模型（带工具定义），返回文本内容与工具调用列表 */
export async function chatWithTools(
  messages: ToolChatMessage[],
  tools: ToolDef[],
  timeoutMs = 90_000
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const config = loadArkConfig()
  if (!config) {
    throw new Error('AI 未配置：请复制 config.example.json 为 config.json，填入火山方舟 API Key 和模型 ID')
  }
  // 视觉决策必须用 vision 模型（截图输入）
  const model = visionArkModel()
  if (!model) throw new Error('未找到支持图片输入的模型：请在 config.json 的 ark.models 里为某个模型标记 "vision": true')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const base = { messages, tools, tool_choice: 'auto' }
    let res = await postCompletion(config, model, { ...base, thinking: { type: 'disabled' } }, controller.signal)
    if (res.status === 400) {
      res = await postCompletion(config, model, base, controller.signal)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`火山方舟请求失败 (${res.status}): ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]
    }
    const message = data.choices?.[0]?.message
    return { content: message?.content ?? '', toolCalls: message?.tool_calls ?? [] }
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new Error('AI 请求超时，请稍后重试')
    throw err
  } finally {
    clearTimeout(timer)
  }
}
