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
let modelRequests = 0

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

const richText = (topic) => `${topic}。`.repeat(110)

function modelValue(system, userContent = '') {
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
      estimated_minutes: 180, reason: '岗位明确要求 Vue', evidence_refs: ['E1'],
      success_criteria: '能在三分钟内说明 Proxy、依赖收集和触发更新'
    }]
  }
  if (system.includes('计划审查节点')) return { verdict: 'pass', issues: [] }
  if (system.includes('课程设计节点')) return {
    overview: '通过原理、边界和表达两个模块掌握 Vue 响应式。',
    objectives: ['能完整说明响应式更新链路', '能分析常见响应式失效场景'],
    prerequisites: ['JavaScript 对象基础'],
    coverage_map: [
      { objective: '能完整说明响应式更新链路', module_ids: ['M1'], practice_levels: ['basic', 'interview'] },
      { objective: '能分析常见响应式失效场景', module_ids: ['M2'], practice_levels: ['understanding', 'application'] }
    ],
    modules: [
      {
        id: 'M1', title: '响应式更新链路', purpose: '建立原理心智模型', recommended_minutes: 180,
        learning_outcomes: ['说明 track 的职责', '说明 trigger 的职责'], evidence_refs: ['E1']
      },
      {
        id: 'M2', title: '边界与排错', purpose: '分析失效场景', recommended_minutes: 120,
        learning_outcomes: ['识别常见误用', '给出排查步骤'], evidence_refs: []
      }
    ]
  }
  if (system.includes('教学内容编写节点')) {
    const second = userContent.includes('"id":"M2"')
    const id = second ? 'M2' : 'M1'
    return {
      id, title: second ? '边界与排错' : '响应式更新链路',
      purpose: second ? '分析失效场景' : '建立原理心智模型', recommended_minutes: second ? 120 : 180,
      learning_outcomes: second ? ['识别常见误用', '给出排查步骤'] : ['说明 track 的职责', '说明 trigger 的职责'],
      evidence_refs: second ? [] : ['E1'],
      sections: [
        { type: 'explanation', title: '原理讲解', content: richText('读取时由 track 收集依赖，写入时由 trigger 调度更新'), evidence_refs: second ? [] : ['E1'] },
        { type: 'example', title: '组件示例', content: richText('以组件读取 ref 并在事件中修改状态为例逐步推演'), evidence_refs: [] },
        { type: 'pitfall', title: '常见错误', content: richText('错误解构可能丢失响应式连接，需要区分值和引用'), evidence_refs: [] },
        { type: 'interview_answer', title: '面试表达', content: richText('回答时先给结论，再讲拦截、收集、触发和更新'), evidence_refs: [] }
      ],
      self_checks: [
        { question: 'track 在何时执行？', expected_points: ['发生读取', '记录副作用'] },
        { question: 'trigger 如何更新组件？', expected_points: ['定位依赖', '调度执行'] }
      ]
    }
  }
  if (system.includes('练习设计节点')) {
    const levels = ['basic', 'understanding', 'application', 'interview', 'application', 'interview']
    return {
      items: levels.map((level, index) => ({
        level, type: index < 2 ? 'short_answer' : index < 4 ? 'scenario' : 'mock_question',
        prompt: `第 ${index + 1} 题：从不同角度分析 Vue 响应式。`, hints: ['先确定读取或写入阶段。'],
        answer_outline: '先给结论，再按照 Proxy 拦截、track 收集、trigger 触发和组件更新的顺序展开；随后补充具体组件示例、常见误区、适用边界和排查方法。',
        reference_answer: richText('Vue 使用 Proxy 拦截对象操作，在读取时收集依赖，在写入时触发对应副作用'),
        follow_ups: ['嵌套对象的排查方法有什么不同？'],
        rubric: [
          { criterion: '准确性', description: '关键概念和顺序正确。', score: 5 },
          { criterion: '完整性', description: '包含机制、例子和边界。', score: 5 }
        ],
        module_ids: [index % 2 ? 'M2' : 'M1']
      })),
      completion_checklist: ['能说明更新链路', '能分析失效场景', '完成应用题', '完成模拟回答']
    }
  }
  if (system.includes('质量审查节点')) return { verdict: 'pass', issues: [] }
  if (system.includes('执行教练')) return '先从核心链路开始：Proxy 拦截读取后由 track 收集依赖，修改时由 trigger 触发更新。[E1]'
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
      const userContent = String(body.messages?.find(message => message.role === 'user')?.content || '')
      const value = modelValue(system, userContent)
      const content = typeof value === 'string' ? value : JSON.stringify(value)
      modelRequests++
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
    constraints: { available_minutes: 30, focus: ['前端基础'] },
    request_id: 'e2e-request-0001'
  })
  assert.deepEqual(created.constraints, { focus: ['前端基础'] }, '旧 available_minutes 应兼容读取但不再形成限制')
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

  const tasks = await request(base, 'GET', `/prep-agent/interviews/${interview.id}/tasks`)
  assert.equal(tasks.length, 1)
  assert.equal(tasks[0].guide_ready, false)
  const generationStarted = await request(base, 'POST', `/prep-agent/plan-items/${tasks[0].id}/guide`, {})
  assert.equal(generationStarted.generation.status, 'running')
  const guideSession = await waitFor(async () => {
    const current = await request(base, 'GET', `/prep-agent/plan-items/${tasks[0].id}/session`)
    if (current.generation.status === 'failed') throw new Error(current.generation.error)
    return current.generation.status === 'completed' ? current : null
  })
  assert.equal(guideSession.guide.version, 2)
  assert.equal(guideSession.guide.modules.length, 2)
  assert.equal(guideSession.guide.practice_set.length, 6)
  assert.equal(
    guideSession.guide.modules.reduce((sum, item) => sum + item.recommended_minutes, 0),
    300,
    '课程模块建议时长合计可以超过任务建议时长'
  )
  const progressed = await request(base, 'PATCH', `/prep-agent/plan-items/${tasks[0].id}/progress`, {
    steps: [0], checks: [0], done: true
  })
  assert.deepEqual(progressed.progress, { steps: [0], checks: [0] })
  assert.equal(progressed.task.done, 1)
  const chatRequest = {
    content: '请讲解最关键的原理。', request_id: 'task-chat-request-0001'
  }
  const firstReply = await request(base, 'POST', `/prep-agent/plan-items/${tasks[0].id}/messages`, chatRequest)
  const repeatedReply = await request(base, 'POST', `/prep-agent/plan-items/${tasks[0].id}/messages`, chatRequest)
  assert.equal(firstReply.message.id, repeatedReply.message.id, '重复 request_id 应返回同一回答')
  assert.match(firstReply.message.content, /track/)
  const finalSession = await request(base, 'GET', `/prep-agent/plan-items/${tasks[0].id}/session`)
  assert.equal(finalSession.messages.length, 2, '幂等重试不应重复保存消息')
  const afterExecution = await request(base, 'GET', `/applications/${application.id}`)
  assert.equal(afterExecution.interviews[0].checklist[0].done, 1)

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
    checklist_items: afterApproval.interviews[0].checklist.length,
    execution_guide_modules: finalSession.guide.modules.length,
    execution_practice_items: finalSession.guide.practice_set.length,
    execution_messages: finalSession.messages.length,
    provider_requests: modelRequests
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
