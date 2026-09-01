import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1')), '..')
const tempRoot = await mkdtemp(path.join(tmpdir(), 'job-tracer-prep-agent-'))
let appProcess = null
let mockServer = null

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function modelValue(system) {
  if (system.includes('岗位画像节点')) return {
    responsibilities: [],
    must_have_skills: [{ text: 'Vue 与性能优化', source_refs: ['APP'], confidence: 1 }],
    nice_to_have_skills: [], project_signals: [],
    likely_interview_topics: ['Vue 响应式', '首屏性能优化'], unknowns: []
  }
  if (system.includes('检索规划节点')) return {
    queries: [{ query: 'Vue 响应式原理', reason: '岗位要求 Vue', category: '八股', owner: null }]
  }
  if (system.includes('差距分析节点')) return {
    gaps: [{
      skill: 'Vue 响应式', current_level: 'developing', target_level: 'interview_ready',
      reason: '本地知识掌握度仍需提升', evidence_refs: ['E1'], confidence: 0.8
    }],
    strengths: [], warnings: []
  }
  if (system.includes('计划生成节点')) return {
    summary: '围绕 Vue 原理和项目表达完成一面准备',
    items: [{
      title: '复习 Vue 响应式原理', category: 'knowledge', priority: 'high',
      estimated_minutes: 30, reason: '岗位明确要求 Vue', evidence_refs: ['E1'],
      success_criteria: '能在三分钟内说明 Proxy、依赖收集和触发更新'
    }]
  }
  if (system.includes('计划审查节点')) return { verdict: 'pass', issues: [] }
  throw new Error('Unknown prompt')
}

async function request(base, method, pathname, body) {
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${pathname}: ${response.status} ${JSON.stringify(payload)}`)
  return payload
}

async function waitFor(check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = await check()
      if (last) return last
    } catch (error) {
      last = error
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out: ${last instanceof Error ? last.message : JSON.stringify(last)}`)
}

try {
  const [appPort, agentPort, modelPort] = await Promise.all([freePort(), freePort(), freePort()])
  mockServer = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    try {
      const body = JSON.parse(raw || '{}')
      const system = String(body.messages?.find(message => message.role === 'system')?.content || '')
      const content = JSON.stringify(modelValue(system))
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        id: `mock-${Date.now()}`, model: 'mock-prep-agent',
        choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 }
      }))
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: error.message }))
    }
  })
  await new Promise(resolve => mockServer.listen(modelPort, '127.0.0.1', resolve))

  const configPath = path.join(tempRoot, 'config.json')
  const dataPath = path.join(tempRoot, 'data')
  await writeFile(configPath, JSON.stringify({
    ark: {
      apiKey: 'mock-key', baseUrl: `http://127.0.0.1:${modelPort}/v1`,
      defaultModel: 'mock-prep-agent',
      models: [{
        id: 'mock-prep-agent', label: 'Mock', vision: false,
        structuredOutput: false, thinking: false, streaming: false, maxOutputTokens: 8192
      }],
      tasks: {
        interviewPrepAgent: {
          enabled: true, outputMode: 'text', maxOutputTokens: 4096,
          temperature: 0, timeoutMs: 10_000, thinking: 'disabled'
        }
      }
    }
  }))

  const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
  appProcess = spawn(process.execPath, [tsxCli, 'server/src/index.ts'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(appPort),
      PREP_AGENT_PORT: String(agentPort),
      PREP_AGENT_PYTHON: path.join(projectRoot, '.venv-agent', 'Scripts', 'python.exe'),
      JOB_TRACER_DATA_DIR: dataPath,
      JOB_TRACER_CONFIG_PATH: configPath
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let logs = ''
  appProcess.stdout.on('data', chunk => { logs += String(chunk) })
  appProcess.stderr.on('data', chunk => { logs += String(chunk) })
  const base = `http://127.0.0.1:${appPort}/api`
  await waitFor(async () => {
    const response = await fetch(`${base}/meta`)
    return response.ok
  })

  const application = await request(base, 'POST', '/applications', {
    company: '星海科技', position: '前端开发工程师', status: 'unsent',
    jd_text: '负责 Vue 3 项目开发和首屏性能优化，要求理解响应式原理。'
  })
  const interview = await request(base, 'POST', `/applications/${application.id}/interviews`, {
    round: '一面', scheduled_at: '2026-09-03 10:00'
  })
  const sourceRow = await request(base, 'POST', '/knowledge/sources', {
    owner: 'mine', company: '星海科技', position: '前端开发工程师',
    round: '一面', application_id: application.id
  })
  await request(base, 'POST', '/knowledge/items', {
    source_id: sourceRow.id, question: 'Vue 3 响应式原理是什么？',
    answer: '使用 Proxy 拦截对象操作，通过 track 收集依赖并由 trigger 触发更新。', category: '八股'
  })

  const created = await request(base, 'POST', '/prep-agent/runs', {
    application_id: application.id,
    interview_id: interview.id,
    goal: '准备一面',
    constraints: { available_minutes: 120, focus: ['前端基础'] },
    request_id: 'e2e-request-0001'
  })
  const waiting = await waitFor(async () => {
    const current = await request(base, 'GET', `/prep-agent/runs/${created.id}`)
    if (current.status === 'failed') throw new Error(current.error_message)
    return current.status === 'waiting_review' ? current : null
  })
  assert.equal(waiting.plan.items.length, 1)
  assert.equal(waiting.model_calls, 5)
  const beforeApproval = await request(base, 'GET', `/applications/${application.id}`)
  assert.equal(beforeApproval.interviews[0].checklist.length, 0, 'approval 前不应写入 checklist')

  await request(base, 'POST', `/prep-agent/runs/${created.id}/resume`, { action: 'approve' })
  const completed = await waitFor(async () => {
    const current = await request(base, 'GET', `/prep-agent/runs/${created.id}`)
    if (current.status === 'failed') throw new Error(current.error_message)
    return current.status === 'completed' ? current : null
  })
  assert.equal(completed.persisted_items.length, 1)
  assert.equal(completed.total_tokens, 300)
  const afterApproval = await request(base, 'GET', `/applications/${application.id}`)
  assert.equal(afterApproval.interviews[0].checklist.length, 1)
  assert.match(afterApproval.interviews[0].checklist[0].content, /Vue 响应式原理/)

  const checkpoint = path.join(dataPath, 'prep_agent_checkpoints.db')
  await waitFor(async () => {
    try { return (await import('node:fs/promises')).stat(checkpoint) } catch { return null }
  })
  console.log(JSON.stringify({
    ok: true,
    run_id: created.id,
    model_calls: completed.model_calls,
    total_tokens: completed.total_tokens,
    steps: completed.steps.length,
    checklist_items: afterApproval.interviews[0].checklist.length
  }))
} finally {
  if (appProcess && appProcess.exitCode === null) {
    appProcess.kill('SIGTERM')
    await Promise.race([
      new Promise(resolve => appProcess.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 2500))
    ])
  }
  if (mockServer) await new Promise(resolve => mockServer.close(resolve))
  const systemTemp = path.resolve(tmpdir())
  const resolvedTemp = path.resolve(tempRoot)
  if (!resolvedTemp.startsWith(systemTemp + path.sep)) throw new Error(`Refusing to remove ${resolvedTemp}`)
  await rm(resolvedTemp, { recursive: true, force: true })
}

