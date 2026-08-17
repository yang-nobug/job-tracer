import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 火山方舟（OpenAI 兼容协议）配置与调用封装
// 配置文件：项目根目录 config.json（参考 config.example.json，已 gitignore）

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

export interface ArkConfig {
  apiKey: string
  model: string
  baseUrl: string
}

export function loadArkConfig(): ArkConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as { ark?: Partial<ArkConfig> }
    const ark = raw.ark
    if (!ark?.apiKey || !ark?.model) return null
    if (ark.apiKey.includes('填入')) return null
    return {
      apiKey: ark.apiKey,
      model: ark.model,
      baseUrl: ark.baseUrl || 'https://ark.cn-beijing.volces.com/api/v3'
    }
  } catch {
    return null
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** 发起一次 chat/completions 请求 */
async function postCompletion(config: ArkConfig, body: object, signal: AbortSignal): Promise<Response> {
  return fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`
    },
    body: JSON.stringify(body),
    signal
  })
}

/** 调用大模型，返回文本内容；错误时抛出带用户可读信息的 Error */
export async function chat(messages: ChatMessage[], timeoutMs = 60_000): Promise<string> {
  const config = loadArkConfig()
  if (!config) {
    throw new Error('AI 未配置：请复制 config.example.json 为 config.json，填入火山方舟 API Key 和模型 ID')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const base = { model: config.model, messages, temperature: 0.3 }
    // 豆包思考型模型：本工具的任务简单，默认关闭深度思考以提速省费
    let res = await postCompletion(config, { ...base, thinking: { type: 'disabled' } }, controller.signal)
    // 模型不支持 thinking 参数时自动去掉重试
    if (res.status === 400) {
      res = await postCompletion(config, base, controller.signal)
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
