import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 火山引擎「大模型录音文件识别（标准版）」封装：提交任务 + 轮询结果
// 文档：openspeech.bytedance.com/api/v3/auc/bigmodel/submit | /query
// 鉴权两种模式兼容：新版控制台 X-Api-Key；旧版 X-Api-App-Key + X-Api-Access-Key

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../../config.json')

const SUBMIT_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit'
const QUERY_URL = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/query'

export interface AsrConfig {
  apiKey?: string
  appId?: string
  accessToken?: string
  resourceId: string
}

export function loadAsrConfig(): AsrConfig | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as { asr?: Partial<AsrConfig> }
    const asr = raw.asr
    if (!asr) return null
    // 旧版控制台 appId + accessToken 优先（新版 X-Api-Key 是不同平台的 key，容易误填成方舟 key）
    const hasOld = !!(asr.appId && asr.accessToken && !String(asr.appId).includes('填入'))
    const hasNew = !!asr.apiKey && !asr.apiKey.includes('填入') && asr.apiKey !== ''
    if (!hasOld && !hasNew) return null
    return {
      apiKey: hasOld ? undefined : asr.apiKey,
      appId: asr.appId || undefined,
      accessToken: asr.accessToken || undefined,
      resourceId: asr.resourceId || 'volc.seedasr.auc'
    }
  } catch {
    return null
  }
}

/** 按控制台版本生成鉴权 header（与任务无关的公共部分） */
function authHeaders(config: AsrConfig): Record<string, string> {
  const headers: Record<string, string> = { 'X-Api-Resource-Id': config.resourceId }
  if (config.apiKey) {
    headers['X-Api-Key'] = config.apiKey
  } else {
    headers['X-Api-App-Key'] = config.appId!
    headers['X-Api-Access-Key'] = config.accessToken!
  }
  return headers
}

/** ASR 音频容器格式（m4a/aac 不支持，转码在路由层用 ffmpeg 处理） */
export type AsrFormat = 'wav' | 'mp3' | 'ogg' | 'raw'

export interface AsrTask {
  requestId: string   // X-Api-Request-Id，查询任务用同一个
  logId?: string
}

/** 提交转写任务（audio.url 为 OSS 签名 URL）；成功返回任务号 */
export async function submitAsrTask(
  config: AsrConfig,
  audioUrl: string,
  format: AsrFormat
): Promise<AsrTask> {
  const requestId = randomUUID()
  const res = await fetch(SUBMIT_URL, {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'Content-Type': 'application/json',
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1'
    },
    body: JSON.stringify({
      user: { uid: 'job-tracer' },
      audio: { url: audioUrl, format },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,   // 数字规范化："一九七零" -> "1970"
        enable_punc: true,  // 标点
        enable_ddc: true    // 顺滑（去语气词/重复），转写全文更可读
      }
    })
  })
  const code = res.headers.get('x-api-status-code') || ''
  const message = res.headers.get('x-api-message') || ''
  const logId = res.headers.get('x-tt-logid') || undefined
  if (code !== '20000000') {
    throw new Error(`ASR 提交失败 (${code || res.status}): ${message || '未知错误'}`)
  }
  return { requestId, logId }
}

export type AsrQueryStatus = 'queued' | 'processing' | 'done' | 'failed'

export interface AsrQueryResult {
  status: AsrQueryStatus
  text?: string      // 转写全文（仅 done 时有）
  message?: string   // 失败原因
}

/** 查询转写结果 */
export async function queryAsrTask(config: AsrConfig, task: AsrTask): Promise<AsrQueryResult> {
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: {
      ...authHeaders(config),
      'Content-Type': 'application/json',
      'X-Api-Request-Id': task.requestId
    },
    body: '{}'
  })
  const code = res.headers.get('x-api-status-code') || ''
  const message = res.headers.get('x-api-message') || ''
  if (code === '20000000') {
    const body = (await res.json().catch(() => null)) as { result?: { text?: string } } | null
    const text = body?.result?.text
    if (!text) return { status: 'failed', message: '转写完成但返回文本为空' }
    return { status: 'done', text }
  }
  if (code === '20000001') return { status: 'processing' }
  if (code === '20000002') return { status: 'queued' }
  return { status: 'failed', message: `ASR 查询失败 (${code || res.status}): ${message || '未知错误'}` }
}

/** 提交并轮询直到完成（intervalMs 间隔，timeoutMs 上限）；失败/超时抛错 */
export async function transcribe(
  config: AsrConfig,
  audioUrl: string,
  format: AsrFormat,
  intervalMs = 10_000,
  timeoutMs = 30 * 60 * 1000
): Promise<string> {
  const task = await submitAsrTask(config, audioUrl, format)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs))
    const result = await queryAsrTask(config, task)
    if (result.status === 'done') return result.text!
    if (result.status === 'failed') throw new Error(result.message || '转写失败')
    // queued / processing：继续轮询
  }
  throw new Error('转写超时（超过 30 分钟），请稍后重试')
}
