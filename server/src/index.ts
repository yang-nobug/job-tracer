import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import { existsSync } from 'node:fs'
import { applicationsRouter } from './routes/applications.js'
import { eventsRouter } from './routes/events.js'
import { interviewsRouter } from './routes/interviews.js'
import { resumesRouter } from './routes/resumes.js'
import { statsRouter } from './routes/stats.js'
import { knowledgeRouter } from './routes/knowledge.js'
import { knowledgeAiRouter } from './routes/knowledge-ai.js'
import { recordingsRouter } from './routes/recordings.js'
import { aiRouter } from './routes/ai.js'
import { jdParseHandler } from './jd-parser.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PORT = 3210

const app = express()
app.use(express.json({ limit: '2mb' }))

app.use('/api', statsRouter)
app.use('/api', aiRouter)
app.use('/api', interviewsRouter)
app.use('/api', eventsRouter)
app.use('/api/resumes', resumesRouter)
app.use('/api/applications', applicationsRouter)
app.use('/api/knowledge', knowledgeRouter)
app.use('/api', knowledgeAiRouter)
app.use('/api/recordings', recordingsRouter)
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`job-tracer 已启动: http://localhost:${PORT}`)
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        console.log(`手机访问:      http://${net.address}:${PORT}`)
      }
    }
  }
})
