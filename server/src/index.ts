import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { applicationsRouter } from './routes/applications.js'
import { eventsRouter } from './routes/events.js'
import { interviewsRouter } from './routes/interviews.js'
import { resumesRouter } from './routes/resumes.js'
import { statsRouter } from './routes/stats.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { knowledgeAiRouter } from './routes/knowledge-ai.js'
import { recoverInterruptedRecordings, recordingsRouter } from './routes/recordings.js'
import { tutorRouter } from './routes/tutor.js'
import { aiRouter } from './routes/ai.js'
import { jdParseHandler } from './jd-parser.js'
import { applicationImportsRouter } from './routes/application-imports.js'
import { prepAgentRouter } from './routes/prep-agent.js'
import {
  configurePrepAgentRuntime, recoverPrepAgentRuntimeRun, stopPrepAgentService
} from './prep-agent-runtime.js'
import { recoverablePrepAgentRuns } from './prep-agent-service.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const configuredPort = Number(process.env.PORT)
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535 ? configuredPort : 3210
configurePrepAgentRuntime(PORT)

const app = express()
const recoveredRecordings = recoverInterruptedRecordings()
if (recoveredRecordings) console.log(`[recordings] 已恢复 ${recoveredRecordings} 个中断任务，可在页面点击重试`)
app.use(express.json({ limit: '2mb' }))

app.use('/api', statsRouter)
app.use('/api', aiRouter)
app.use('/api', interviewsRouter)
app.use('/api', eventsRouter)
app.use('/api/resumes', resumesRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/application-imports', applicationImportsRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api', knowledgeAiRouter)
app.use('/api/recordings', recordingsRouter)
app.use('/api/tutor', tutorRouter)
app.use('/api', prepAgentRouter)
app.post('/api/jd-parse', jdParseHandler)

// 统一错误处理（422/500 -> JSON）
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err)
  res.status(500).json({ message: err.message || '服务器错误' })
})

// 托管前端构建产物（npm run build 后存在）
const publicDir = path.resolve(__dirname, '../public')
if (existsSync(publicDir)) {
  app.use(express.static(publicDir))
  // 前端路由回退
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })
}

// 仅允许本机浏览器访问，不向局域网开放。
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`job-tracer 已启动: http://localhost:${PORT}`)
  const recoverable = recoverablePrepAgentRuns()
  if (recoverable.length) {
    console.log(`[prep-agent] 正在恢复 ${recoverable.length} 个中断运行`)
    for (const run of recoverable) {
      recoverPrepAgentRuntimeRun(run.id).catch(error => {
        console.error(`[prep-agent] 恢复 ${run.id} 失败:`, (error as Error).message)
      })
    }
  }
})

function shutdown(): void {
  stopPrepAgentService()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
