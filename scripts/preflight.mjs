import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const requiredMajor = 24
const require = createRequire(import.meta.url)

function fail(code, message) {
  console.error(`[job-tracer] ${message}`)
  process.exit(code)
}

const major = Number(process.versions.node.split('.')[0])
if (major !== requiredMajor) {
  fail(1, `Node.js 版本不匹配：当前 ${process.versions.node}，项目要求 24.x（推荐 24.20.0）。请切换版本后重新运行 start.bat。`)
}

const packagePath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
if (!existsSync(lockPath) || !existsSync(path.join(root, 'node_modules'))) {
  fail(10, '依赖尚未安装或缺少 package-lock.json，准备执行 npm install。')
}

try {
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  const declared = { ...pkg.dependencies, ...pkg.devDependencies }
  const locked = { ...(lock.packages?.['']?.dependencies ?? {}), ...(lock.packages?.['']?.devDependencies ?? {}) }
  if (Object.entries(declared).some(([name, version]) => locked[name] !== version)) {
    fail(10, 'package.json 与 package-lock.json 不一致，准备重新安装依赖。')
  }
  require.resolve('tsx')
} catch (error) {
  if (Number(process.exitCode)) process.exit(process.exitCode)
  fail(10, `依赖检查失败：${error.message}`)
}

try {
  const Database = require('better-sqlite3')
  const check = new Database(':memory:')
  check.prepare('SELECT 1').get()
  check.close()
} catch (error) {
  const abi = process.versions.modules
  fail(12, `better-sqlite3 无法加载（当前 Node ABI ${abi}）：${String(error.message).split('\n')[0]}`)
}

function latestMtime(target) {
  if (!existsSync(target)) return 0
  const stat = statSync(target)
  if (!stat.isDirectory()) return stat.mtimeMs
  let latest = stat.mtimeMs
  for (const name of readdirSync(target)) latest = Math.max(latest, latestMtime(path.join(target, name)))
  return latest
}

const publicIndex = path.join(root, 'server', 'public', 'index.html')
const outputTime = existsSync(publicIndex) ? statSync(publicIndex).mtimeMs : 0
const inputTime = Math.max(
  latestMtime(path.join(root, 'web', 'src')),
  latestMtime(path.join(root, 'web', 'index.html')),
  latestMtime(path.join(root, 'shared')),
  latestMtime(path.join(root, 'vite.config.ts'))
)
if (!outputTime || inputTime > outputTime) fail(11, '前端产物缺失或早于源码，准备重新构建。')

console.log(`[job-tracer] 环境检查通过：Node ${process.versions.node} / ABI ${process.versions.modules}`)
