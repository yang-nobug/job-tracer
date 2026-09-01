import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepAgentInternalToken } from './prep-agent-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '../..')
const configuredPort = Number(process.env.PREP_AGENT_PORT)
const SERVICE_PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 3211
const SERVICE_URL = (process.env.PREP_AGENT_BASE_URL || `http://127.0.0.1:${SERVICE_PORT}`).replace(/\/+$/, '')
const EXTERNAL_SERVICE = Boolean(process.env.PREP_AGENT_BASE_URL)
const PROTOCOL_VERSION = 1

let nodePort = 3210
let child: ChildProcess | null = null
let readyPromise: Promise<void> | null = null

export function configurePrepAgentRuntime(port: number): void {
  nodePort = port
}

function pythonExecutable(): string {
  if (process.env.PREP_AGENT_PYTHON?.trim()) return process.env.PREP_AGENT_PYTHON.trim()
  const venv = path.join(PROJECT_ROOT, '.venv-agent', 'Scripts', 'python.exe')
  return existsSync(venv) ? venv : 'python'
}

async function health(): Promise<boolean> {
  try {
    const response = await fetch(`${SERVICE_URL}/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const value = await response.json() as { protocol?: number }
    return value.protocol === PROTOCOL_VERSION
  } catch {
    return false
  }
}

function launch(): void {
  if (EXTERNAL_SERVICE) return
  if (child && child.exitCode === null) return
  const dataDir = process.env.JOB_TRACER_DATA_DIR?.trim()
    ? path.resolve(process.env.JOB_TRACER_DATA_DIR.trim())
    : path.join(PROJECT_ROOT, 'data')
  const checkpointPath = path.join(dataDir, 'prep_agent_checkpoints.db')
  const spawned = spawn(pythonExecutable(), [
    '-m', 'uvicorn', 'agent_service.main:app',
    '--host', '127.0.0.1', '--port', String(SERVICE_PORT), '--log-level', 'warning'
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      JOB_TRACER_BASE_URL: `http://127.0.0.1:${nodePort}`,
      PREP_AGENT_INTERNAL_TOKEN: prepAgentInternalToken(),
      PREP_AGENT_CONTROL_TOKEN: prepAgentInternalToken(),
      PREP_AGENT_CHECKPOINT_PATH: checkpointPath
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child = spawned
  spawned.stdout?.on('data', chunk => {
    const message = String(chunk).trim()
    if (message) console.log(`[prep-agent] ${message}`)
  })
  spawned.stderr?.on('data', chunk => {
    const message = String(chunk).trim()
    if (message) console.error(`[prep-agent] ${message}`)
  })
  spawned.on('exit', code => {
    if (code && code !== 0) console.error(`[prep-agent] Python 服务退出，code=${code}`)
    child = null
    readyPromise = null
  })
}

export async function ensurePrepAgentService(): Promise<void> {
  if (process.env.PREP_AGENT_DISABLED === '1') {
    throw new Error('面试准备 Agent 的 Python 环境不可用，请根据启动窗口提示检查 Python 和依赖')
  }
  if (await health()) return
  if (readyPromise) return readyPromise
  readyPromise = (async () => {
    launch()
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (await health()) return
      if (!EXTERNAL_SERVICE && child?.exitCode != null) break
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    throw new Error(EXTERNAL_SERVICE
      ? '面试准备 Agent 服务不可用，请检查 PREP_AGENT_BASE_URL'
      : '面试准备 Agent 服务启动失败，请检查 Python 环境和 agent_service/requirements.txt')
  })().finally(() => { readyPromise = null })
  return readyPromise
}

async function control(pathname: string, body?: unknown): Promise<Record<string, unknown>> {
  await ensurePrepAgentService()
  const response = await fetch(`${SERVICE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-prep-agent-control-token': prepAgentInternalToken()
    },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000)
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) throw new Error(typeof payload.detail === 'string' ? payload.detail : `Agent 服务请求失败 (${response.status})`)
  return payload
}

export async function startPrepAgentRun(runId: string): Promise<void> {
  await control(`/runs/${encodeURIComponent(runId)}/start`)
}

export async function resumePrepAgentRun(runId: string, decision: unknown): Promise<void> {
  await control(`/runs/${encodeURIComponent(runId)}/resume`, decision)
}

export async function cancelPrepAgentRuntimeRun(runId: string): Promise<void> {
  try { await control(`/runs/${encodeURIComponent(runId)}/cancel`) } catch { /* 数据库取消仍然有效 */ }
}

export async function recoverPrepAgentRuntimeRun(runId: string): Promise<void> {
  await control(`/runs/${encodeURIComponent(runId)}/recover`)
}

export function stopPrepAgentService(): void {
  if (!child || child.exitCode !== null) return
  child.kill()
  child = null
}
