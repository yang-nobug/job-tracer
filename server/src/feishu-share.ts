import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredConfigPath = process.env.JOB_TRACER_CONFIG_PATH?.trim()
const CONFIG_PATH = configuredConfigPath ? path.resolve(configuredConfigPath) : path.resolve(__dirname, '../../config.json')
const FEISHU_WEBHOOK_HOSTS = new Set(['open.feishu.cn', 'open.larksuite.com'])
const MAX_JD_CHARS = 5_000

export interface FeishuShareApplication {
  id: number
  company: string
  position: string
  location: string | null
  channel: string | null
  status: string
  jd_link: string | null
  jd_text: string | null
}

interface FeishuConfig {
  webhookUrl: string
}

function configuredWebhookUrl(): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as { feishu?: Record<string, unknown> }
    const value = raw.feishu?.webhookUrl
    if (typeof value !== 'string' || !value.trim()) return null
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' || !FEISHU_WEBHOOK_HOSTS.has(url.hostname) || !url.pathname.startsWith('/open-apis/bot/v2/hook/')) return null
    return url.toString()
  } catch {
    return null
  }
}

export function feishuShareConfigured(): boolean {
  return configuredWebhookUrl() !== null
}

function text(value: string | null | undefined, fallback = '未填写'): string {
  const result = value?.trim()
  return result || fallback
}

function limit(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…（正文已截断，请通过 JD 链接查看完整内容）` : value
}

export function applicationShareText(app: FeishuShareApplication): string {
  const lines = [
    '【招聘信息】',
    `公司：${text(app.company)}`,
    `职位：${text(app.position)}`,
    `地点：${text(app.location)}`,
    `渠道：${text(app.channel)}`,
    `当前状态：${text(app.status)}`
  ]
  if (app.jd_link?.trim()) lines.push(`岗位 JD 链接：${app.jd_link.trim()}`)
  if (app.jd_text?.trim()) lines.push('', 'JD 正文：', limit(app.jd_text.trim(), MAX_JD_CHARS))
  return lines.join('\n')
}

export function feishuApplicationMessage(app: FeishuShareApplication): Record<string, unknown> {
  const shareText = applicationShareText(app)
  return {
    msg_type: 'text',
    content: {
      text: shareText
    }
  }
}

export class FeishuShareError extends Error {
  constructor(message: string, public readonly status = 422) {
    super(message)
  }
}

export async function shareApplicationToFeishu(app: FeishuShareApplication): Promise<void> {
  const webhookUrl = configuredWebhookUrl()
  if (!webhookUrl) throw new FeishuShareError('飞书机器人未配置：请在 config.json 填入 feishu.webhookUrl')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(feishuApplicationMessage(app)),
      signal: controller.signal
    })
    const payload = await response.json().catch(() => ({})) as { code?: number; msg?: string; StatusMessage?: string }
    if (!response.ok || (typeof payload.code === 'number' && payload.code !== 0)) {
      throw new FeishuShareError(`飞书发送失败：${payload.msg || payload.StatusMessage || `HTTP ${response.status}`}`, 502)
    }
  } catch (error) {
    if (error instanceof FeishuShareError) throw error
    if ((error as Error).name === 'AbortError') throw new FeishuShareError('飞书发送超时，请检查网络后重试', 504)
    throw new FeishuShareError(`飞书发送失败：${(error as Error).message}`, 502)
  } finally {
    clearTimeout(timer)
  }
}
