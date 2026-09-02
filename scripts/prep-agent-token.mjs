import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dataDir = process.env.JOB_TRACER_DATA_DIR?.trim()
  ? path.resolve(process.env.JOB_TRACER_DATA_DIR.trim())
  : path.resolve('data')
const tokenPath = path.join(dataDir, '.prep-agent-token')
mkdirSync(dataDir, { recursive: true })

let token = ''
try { token = readFileSync(tokenPath, 'utf8').trim() } catch { /* 首次启动时创建 */ }
if (!/^[a-f0-9]{64}$/i.test(token)) {
  token = randomBytes(32).toString('hex')
  writeFileSync(tokenPath, token, { encoding: 'utf8', mode: 0o600 })
}
process.stdout.write(token)
