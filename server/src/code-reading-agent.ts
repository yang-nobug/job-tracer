import { createHash, randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { completeStructured, isAiTaskEnabled, resolveAiTask } from './ai.js'
import { db, now } from './db.js'
import { createOperationRun, finishOperationRun, finishOperationStep, logApp, runWithTrace, startOperationStep } from './observability.js'
import { loadPrompt } from './prompt-loader.js'

const MAX_TOOL_CALLS = 12
const INTERNAL_TOOL_CALLS = 4
const MAX_BYTES_READ = 160 * 1024
const MAX_READ_LINES = 220
const MAX_TREE_ITEMS = 240
const MAX_SEARCH_FILES = 500
const MAX_SEARCH_HITS = 12
const MAX_FILE_SIZE = 1_000_000
const IGNORED_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', '.cache', 'vendor', 'target', '__pycache__', '.venv', 'venv'])
// 配置文件在个人项目中经常直接承载 API Key、数据库连接串或云凭据。代码调查只需读取
// 可公开的源码，不应为了“理解架构”把这些内容提供给模型。
const SENSITIVE_NAMES = /^(?:\.env(?:\..*)?|\.npmrc|\.pypirc|id_rsa(?:\.pub)?|.*\.(?:pem|key|p12|pfx|tfvars)|credentials(?:\..*)?|secrets?(?:\..*)?|config(?:\..*)?\.json)$/i
const TEXT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.vue', '.java', '.go', '.rs', '.sql', '.md', '.mdx', '.json', '.yml', '.yaml', '.html', '.css', '.scss', '.sh'])

type OutputMode = 'explain' | 'architecture' | 'interview_story'
type ToolName = 'list_tree' | 'find_files' | 'search_code' | 'read_range'
type Evidence = { ref: string; relative_path: string; start_line: number; end_line: number; excerpt: string }
type Claim = { kind: 'code_fact' | 'inference' | 'user_confirmation_required'; statement: string; confidence: 'high' | 'medium' | 'low'; evidence_refs: string[]; caveat: string | null }

export class CodeReadingError extends Error {
  constructor(message: string, public code: string, public status = 422) { super(message) }
}

function clean(value: unknown, max: number): string { return typeof value === 'string' ? value.trim().slice(0, max) : '' }
function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }
function stringify(value: unknown): string { try { return JSON.stringify(value) } catch { return '{}' } }
function parse<T>(value: unknown, fallback: T): T { try { return JSON.parse(typeof value === 'string' ? value : '') as T } catch { return fallback } }
function toolBudget(value: unknown): number { return Math.max(1, Math.min(MAX_TOOL_CALLS, Math.floor(Number(value) || MAX_TOOL_CALLS))) }
function isTextFile(filename: string): boolean { return TEXT_EXTENSIONS.has(path.extname(filename).toLowerCase()) || ['README', 'Dockerfile', 'Makefile'].includes(path.basename(filename)) }
function isBinary(value: Buffer): boolean { return value.subarray(0, 8192).includes(0) }

function projectRoot(projectId: number): { root: string; name: string } {
  const row = db.prepare('SELECT root_realpath,name FROM project_profiles WHERE id=?').get(projectId) as { root_realpath: string; name: string } | undefined
  if (!row) throw new CodeReadingError('项目档案不存在', 'PROJECT_NOT_FOUND', 404)
  try {
    const root = realpathSync(row.root_realpath)
    if (!statSync(root).isDirectory()) throw new Error('not directory')
    return { root, name: row.name }
  } catch { throw new CodeReadingError('项目根目录当前不可读取', 'PROJECT_ROOT_UNAVAILABLE', 409) }
}

function relativeSafe(root: string, value: unknown, required = false): { absolute: string; relative: string } {
  const requested = clean(value, 1000) || '.'
  if (required && requested === '.') throw new CodeReadingError('请指定项目内文件路径', 'PATH_REQUIRED')
  if (path.isAbsolute(requested)) throw new CodeReadingError('只能访问项目内的相对路径', 'PATH_OUTSIDE_PROJECT')
  const resolved = path.resolve(root, requested)
  let real: string
  try { real = realpathSync(resolved) } catch { throw new CodeReadingError(`路径不存在：${requested}`, 'PATH_NOT_FOUND') }
  const relative = path.relative(root, real)
  if ((relative && relative.startsWith('..')) || path.isAbsolute(relative)) throw new CodeReadingError('路径不在项目根目录内', 'PATH_OUTSIDE_PROJECT')
  const segments = relative.split(/[\\/]/).filter(Boolean)
  if (segments.some(segment => IGNORED_DIRS.has(segment)) || SENSITIVE_NAMES.test(path.basename(real))) {
    throw new CodeReadingError('该路径属于受保护范围，不能读取', 'PATH_PROTECTED')
  }
  return { absolute: real, relative: relative.replace(/\\/g, '/') || '.' }
}

function tree(root: string, rawPath: unknown, rawDepth: unknown): { items: Array<{ path: string; type: 'file' | 'directory' }>; truncated: boolean } {
  const target = relativeSafe(root, rawPath); const depth = Math.max(0, Math.min(4, Number(rawDepth) || 2)); const items: Array<{ path: string; type: 'file' | 'directory' }> = []; let truncated = false
  const walk = (directory: string, level: number): void => {
    if (truncated || level > depth) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (items.length >= MAX_TREE_ITEMS) { truncated = true; return }
      if (entry.isSymbolicLink() || IGNORED_DIRS.has(entry.name) || SENSITIVE_NAMES.test(entry.name)) continue
      const next = path.join(directory, entry.name); const rel = path.relative(root, next).replace(/\\/g, '/')
      if (entry.isDirectory()) { items.push({ path: `${rel}/`, type: 'directory' }); walk(next, level + 1) }
      else if (entry.isFile() && isTextFile(next)) items.push({ path: rel, type: 'file' })
    }
  }
  walk(target.absolute, 0); return { items, truncated }
}

function listFiles(root: string, rawQuery: unknown, rawScope: unknown): { files: string[]; truncated: boolean } {
  const query = clean(rawQuery, 200).toLowerCase(); if (!query) throw new CodeReadingError('find_files 需要 query', 'TOOL_ARGUMENT_INVALID')
  const scope = relativeSafe(root, rawScope); const files: string[] = []; let truncated = false
  const walk = (directory: string): void => {
    if (truncated) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= 100) { truncated = true; return }
      if (entry.isSymbolicLink() || IGNORED_DIRS.has(entry.name) || SENSITIVE_NAMES.test(entry.name)) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile() && isTextFile(target)) {
        const rel = path.relative(root, target).replace(/\\/g, '/')
        if (rel.toLowerCase().includes(query)) files.push(rel)
      }
    }
  }
  walk(scope.absolute); return { files, truncated }
}

function search(root: string, rawQuery: unknown, rawScope: unknown): { hits: Array<{ relative_path: string; start_line: number; end_line: number; excerpt: string }>; scanned_files: number; truncated: boolean } {
  const query = clean(rawQuery, 300); if (query.length < 2) throw new CodeReadingError('search_code 的 query 至少需要 2 个字符', 'TOOL_ARGUMENT_INVALID')
  const scope = relativeSafe(root, rawScope); const candidates: string[] = []; let stopped = false
  const walk = (directory: string): void => {
    if (stopped) return
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (candidates.length >= MAX_SEARCH_FILES) { stopped = true; return }
      if (entry.isSymbolicLink() || IGNORED_DIRS.has(entry.name) || SENSITIVE_NAMES.test(entry.name)) continue
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(target)
      else if (entry.isFile() && isTextFile(target)) {
        try { if (statSync(target).size <= MAX_FILE_SIZE) candidates.push(target) } catch { /* ignore */ }
      }
    }
  }
  walk(scope.absolute)
  const hits: Array<{ relative_path: string; start_line: number; end_line: number; excerpt: string }> = []
  for (const filename of candidates) {
    if (hits.length >= MAX_SEARCH_HITS) break
    let content: Buffer
    try { content = readFileSync(filename) } catch { continue }
    if (isBinary(content)) continue
    const lines = content.toString('utf8').split(/\r?\n/)
    for (let index = 0; index < lines.length && hits.length < MAX_SEARCH_HITS; index += 1) {
      if (!lines[index].toLowerCase().includes(query.toLowerCase())) continue
      const start = Math.max(1, index - 3); const end = Math.min(lines.length, index + 4)
      hits.push({ relative_path: path.relative(root, filename).replace(/\\/g, '/'), start_line: start, end_line: end, excerpt: lines.slice(start - 1, end).join('\n').slice(0, 4_000) })
    }
  }
  return { hits, scanned_files: candidates.length, truncated: stopped || hits.length >= MAX_SEARCH_HITS }
}

function readRange(root: string, rawPath: unknown, rawStart: unknown, rawEnd: unknown): { relative_path: string; start_line: number; end_line: number; excerpt: string } {
  const file = relativeSafe(root, rawPath, true)
  let stat; try { stat = statSync(file.absolute) } catch { throw new CodeReadingError('文件不可读取', 'FILE_UNREADABLE') }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE || !isTextFile(file.absolute)) throw new CodeReadingError('该文件不在允许的文本读取范围内', 'FILE_NOT_ALLOWED')
  const buffer = readFileSync(file.absolute); if (isBinary(buffer)) throw new CodeReadingError('不能读取二进制文件', 'FILE_BINARY')
  const lines = buffer.toString('utf8').split(/\r?\n/); const start = Math.max(1, Math.floor(Number(rawStart) || 1)); const requestedEnd = Math.floor(Number(rawEnd) || start + 119); const end = Math.min(lines.length, Math.max(start, Math.min(start + MAX_READ_LINES - 1, requestedEnd)))
  return { relative_path: file.relative, start_line: start, end_line: end, excerpt: lines.slice(start - 1, end).join('\n').slice(0, 16_000) }
}

const DECISION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['action', 'reason', 'tool', 'final'], properties: {
    action: { type: 'string', enum: ['tool', 'final'] }, reason: { type: 'string' },
    tool: { type: ['object', 'null'], additionalProperties: false, properties: { name: { type: 'string', enum: ['list_tree', 'find_files', 'search_code', 'read_range'] }, arguments: { type: 'object' } }, required: ['name', 'arguments'] },
    final: { type: ['object', 'null'], additionalProperties: false, properties: {
      overview: { type: 'string' }, answer: { type: 'string' }, claims: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['kind', 'statement', 'confidence', 'evidence_refs', 'caveat'], properties: { kind: { type: 'string', enum: ['code_fact', 'inference', 'user_confirmation_required'] }, statement: { type: 'string' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, evidence_refs: { type: 'array', items: { type: 'string' } }, caveat: { type: ['string', 'null'] } } } }, follow_up_questions: { type: 'array', items: { type: 'string' } }
    }, required: ['overview', 'answer', 'claims', 'follow_up_questions'] }
  }
}

function validateDecision(value: unknown): { action: 'tool' | 'final'; reason: string; tool: { name: ToolName; arguments: Record<string, unknown> } | null; final: { overview: string; answer: string; claims: Claim[]; follow_up_questions: string[] } | null } {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!raw || (raw.action !== 'tool' && raw.action !== 'final')) throw new Error('action 非法')
  const reason = clean(raw.reason, 600)
  if (raw.action === 'tool') {
    const tool = raw.tool as Record<string, unknown> | null
    if (!tool || !['list_tree', 'find_files', 'search_code', 'read_range'].includes(String(tool.name)) || !tool.arguments || typeof tool.arguments !== 'object' || Array.isArray(tool.arguments)) throw new Error('tool 格式非法')
    return { action: 'tool', reason, tool: { name: tool.name as ToolName, arguments: tool.arguments as Record<string, unknown> }, final: null }
  }
  const final = raw.final as Record<string, unknown> | null
  if (!final) throw new Error('final 缺失')
  const claims = Array.isArray(final.claims) ? final.claims.slice(0, 12).map(item => {
    const claim = item as Record<string, unknown>; const kind = claim.kind; const confidence = claim.confidence
    if (!['code_fact', 'inference', 'user_confirmation_required'].includes(String(kind)) || !['high', 'medium', 'low'].includes(String(confidence))) throw new Error('claim 类型非法')
    return { kind: kind as Claim['kind'], statement: clean(claim.statement, 600), confidence: confidence as Claim['confidence'], evidence_refs: Array.isArray(claim.evidence_refs) ? claim.evidence_refs.map(item => clean(item, 30)).filter(Boolean).slice(0, 8) : [], caveat: clean(claim.caveat, 500) || null }
  }).filter(item => item.statement) : []
  return { action: 'final', reason, tool: null, final: { overview: clean(final.overview, 2_000), answer: clean(final.answer, 12_000), claims, follow_up_questions: Array.isArray(final.follow_up_questions) ? final.follow_up_questions.map(item => clean(item, 300)).filter(Boolean).slice(0, 8) : [] } }
}

function addEvidence(sessionId: string, snippets: Array<{ relative_path: string; start_line: number; end_line: number; excerpt: string }>): Evidence[] {
  const count = db.prepare('SELECT COUNT(*) AS count FROM code_reading_evidence WHERE session_id=?').get(sessionId) as { count: number }
  const insert = db.prepare(`INSERT INTO code_reading_evidence(session_id,evidence_ref,relative_path,start_line,end_line,excerpt,content_hash,created_at) VALUES(?,?,?,?,?,?,?,?)`)
  return snippets.slice(0, 12).map((item, index) => {
    const ref = `C${count.count + index + 1}`; const excerpt = item.excerpt.slice(0, 4_000)
    insert.run(sessionId, ref, item.relative_path, item.start_line, item.end_line, excerpt, sha(excerpt), now())
    return { ref, ...item, excerpt }
  })
}

function executeTool(sessionId: string, root: string, tool: { name: ToolName; arguments: Record<string, unknown> }) {
  if (tool.name === 'list_tree') return tree(root, tool.arguments.path, tool.arguments.depth)
  if (tool.name === 'find_files') return listFiles(root, tool.arguments.query, tool.arguments.path)
  if (tool.name === 'read_range') {
    const value = readRange(root, tool.arguments.path, tool.arguments.start_line, tool.arguments.end_line)
    return { ...value, evidence: addEvidence(sessionId, [value]) }
  }
  const value = search(root, tool.arguments.query, tool.arguments.path)
  return { ...value, evidence: addEvidence(sessionId, value.hits) }
}

function sessionRow(sessionId: string) {
  const row = db.prepare('SELECT * FROM code_reading_sessions WHERE id=?').get(sessionId) as Record<string, unknown> | undefined
  if (!row) throw new CodeReadingError('代码调查会话不存在', 'SESSION_NOT_FOUND', 404)
  return row
}

export function createCodeReadingSession(input: { projectId: number; question: unknown; outputMode: unknown; maxToolCalls?: unknown }) {
  const question = clean(input.question, 2_000); const outputMode = input.outputMode
  if (!question) throw new CodeReadingError('请描述你希望调查的代码问题', 'QUESTION_REQUIRED')
  if (!['explain', 'architecture', 'interview_story'].includes(String(outputMode))) throw new CodeReadingError('输出模式不正确', 'OUTPUT_MODE_INVALID')
  projectRoot(input.projectId)
  if (!isAiTaskEnabled('codeReading') || !resolveAiTask('codeReading')) throw new CodeReadingError('请先在 config.json 配置可用的大模型', 'AI_NOT_CONFIGURED')
  const maxToolCalls = toolBudget(input.maxToolCalls)
  const operation = createOperationRun({ operationType: 'code_reading_agent', parentEntityType: 'project_profile', parentEntityId: input.projectId, inputSummary: { output_mode: outputMode, question, max_tool_calls: maxToolCalls } })
  const id = randomUUID(); const ts = now(); const model = resolveAiTask('codeReading')?.model ?? null
  db.prepare(`INSERT INTO code_reading_sessions(id,project_id,question,output_mode,status,model,max_tool_calls,max_bytes_read,trace_id,operation_run_id,created_at,updated_at) VALUES(?,?,?,?, 'queued',?,?,?,?,?,?,?)`).run(id, input.projectId, question, outputMode, model, maxToolCalls, MAX_BYTES_READ, operation.traceId, operation.id, ts, ts)
  return codeReadingSessionDetail(id)
}

/**
 * 代码 Agent 的工作记忆只存在于本次进程中。服务重启后不能拿着已消耗的工具预算
 * 盲目续跑，否则模型既看不到旧观察结果，也容易形成失真的结论。因此统一标记失败，
 * 让用户通过 retry 创建一条保留原问题的新会话。
 */
export function recoverInterruptedCodeReadingSessions(): number {
  const sessions = db.prepare("SELECT id,operation_run_id FROM code_reading_sessions WHERE status IN ('queued','running')").all() as Array<{ id: string; operation_run_id: number | null }>
  if (!sessions.length) return 0
  const message = '服务重启导致本次代码调查中断；请重试以重新开始完整调查。'
  const tx = db.transaction(() => {
    for (const session of sessions) {
      db.prepare("UPDATE code_reading_sessions SET status='failed',error_code='SERVICE_RESTARTED',error_message=?,updated_at=?,finished_at=? WHERE id=?").run(message, now(), now(), session.id)
      if (session.operation_run_id) finishOperationRun(session.operation_run_id, { status: 'failed', errorCode: 'SERVICE_RESTARTED', errorMessage: message, resultSummary: { code_reading_session_id: session.id } })
    }
  })
  tx()
  logApp({ level: 'warn', source: 'code_reading_agent', eventName: 'code_agent.interrupted_recovered', message, context: { sessions: sessions.length } })
  return sessions.length
}

export function cancelCodeReadingSession(sessionId: string): Record<string, unknown> {
  const session = sessionRow(sessionId)
  if (session.status === 'completed') throw new CodeReadingError('已完成的代码调查不能取消', 'SESSION_STATE_CONFLICT', 409)
  if (session.status === 'cancelled') return codeReadingSessionDetail(sessionId)
  if (session.status === 'failed') throw new CodeReadingError('失败的代码调查请使用重试', 'SESSION_STATE_CONFLICT', 409)
  db.prepare("UPDATE code_reading_sessions SET status='cancelled',error_code=NULL,error_message=NULL,updated_at=?,finished_at=? WHERE id=?").run(now(), now(), sessionId)
  if (session.operation_run_id) finishOperationRun(Number(session.operation_run_id), { status: 'cancelled', resultSummary: { code_reading_session_id: sessionId } })
  logApp({ level: 'info', source: 'code_reading_agent', eventName: 'code_agent.cancelled', message: '用户取消代码调查', entityType: 'code_reading_session', entityId: sessionId })
  return codeReadingSessionDetail(sessionId)
}

export function retryCodeReadingSession(sessionId: string): Record<string, unknown> {
  const session = sessionRow(sessionId)
  if (!['failed', 'cancelled'].includes(String(session.status))) throw new CodeReadingError('只有失败或已取消的代码调查可以重试', 'SESSION_STATE_CONFLICT', 409)
  return createCodeReadingSession({ projectId: Number(session.project_id), question: session.question, outputMode: session.output_mode, maxToolCalls: session.max_tool_calls })
}

export async function runCodeReadingSession(sessionId: string): Promise<void> {
  const row = sessionRow(sessionId); if (row.status !== 'queued') return
  const projectId = Number(row.project_id); const project = projectRoot(projectId); const operationRunId = Number(row.operation_run_id); const traceId = String(row.trace_id)
  const maxToolCalls = toolBudget(row.max_tool_calls)
  await runWithTrace({ traceId, operationRunId }, async () => {
    db.prepare("UPDATE code_reading_sessions SET status='running',updated_at=? WHERE id=?").run(now(), sessionId)
    const history: Array<Record<string, unknown>> = []
    try {
      for (let turn = 1; turn <= maxToolCalls + 1; turn += 1) {
        const current = sessionRow(sessionId); if (current.status === 'cancelled') return
        const evidence = db.prepare('SELECT evidence_ref,relative_path,start_line,end_line FROM code_reading_evidence WHERE session_id=? ORDER BY id').all(sessionId)
        const prompt = {
          project: { name: project.name }, task: String(row.question), output_mode: String(row.output_mode),
          budget: { tool_calls_remaining: maxToolCalls - Number(current.tool_calls_used), bytes_remaining: MAX_BYTES_READ - Number(current.bytes_read) },
          evidence_index: evidence,
          recent_observations: history.slice(-5),
          tools: {
            list_tree: { path: 'relative directory, optional', depth: '0-4' },
            find_files: { query: 'filename/path keyword', path: 'relative directory, optional' },
            search_code: { query: 'code keyword (>=2 chars)', path: 'relative directory, optional' },
            read_range: { path: 'relative file path', start_line: 'positive integer', end_line: `at most ${MAX_READ_LINES} lines` }
          }
        }
        const modelStep = startOperationStep({ operationRunId, stepName: 'code_agent_decide', sequence: turn, inputSummary: { turn, evidence_count: evidence.length } })
        const model = await completeStructured([{ role: 'system', content: `${loadPrompt('code-reading-agent.system.md')}\n\nJSON Schema:\n${JSON.stringify(DECISION_SCHEMA)}` }, { role: 'user', content: `<untrusted_task_context_json>\n${JSON.stringify(prompt)}\n</untrusted_task_context_json>` }], { task: 'codeReading', schemaName: 'code_reading_decision', schema: DECISION_SCHEMA, validate: validateDecision })
        const decision = model.value
        db.prepare(`INSERT INTO code_reading_steps(session_id,sequence,kind,input_json,output_json,status,created_at) VALUES(?,?, 'model',?,?, 'succeeded',?)`).run(sessionId, turn, stringify({ prompt }), stringify({ action: decision.action, reason: decision.reason }), now())
        finishOperationStep(modelStep, { status: 'succeeded', outputSummary: { action: decision.action, reason: decision.reason } })
        if (sessionRow(sessionId).status === 'cancelled') return
        if (decision.action === 'final' && decision.final) {
          const validRefs = new Set((evidence as Array<{ evidence_ref: string }>).map(item => item.evidence_ref))
          const claims = decision.final.claims
            .map(item => ({ ...item, evidence_refs: item.evidence_refs.filter(ref => validRefs.has(ref)) }))
            .filter(item => item.kind !== 'code_fact' || item.evidence_refs.length > 0)
          const codeFacts = claims.filter(item => item.kind === 'code_fact' && item.evidence_refs.length > 0)
          // 不能把模型的“已完成”当作调查完成。只要还有预算，却没有一条能回到源码的事实，
          // 就要求它继续使用只读工具；这样调用方拿到的不会是无依据的项目描述。
          if (!codeFacts.length && Number(current.tool_calls_used) < maxToolCalls) {
            const feedback = '当前结论没有任何可引用的代码事实。请继续调用工具读取与问题最相关的源码；在获得 C 编号证据前不要输出 final。'
            history.push({ agent_review: feedback, rejected_final_reason: decision.reason })
            db.prepare(`INSERT INTO code_reading_steps(session_id,sequence,kind,output_json,status,error_message,created_at) VALUES(?,?, 'final',?, 'failed',?,?)`).run(sessionId, turn, stringify({ ...decision.final, claims }), feedback, now())
            continue
          }
          const insert = db.prepare(`INSERT INTO code_reading_claims(session_id,claim_kind,statement,confidence,evidence_refs_json,caveat,created_at) VALUES(?,?,?,?,?,?,?)`)
          const tx = db.transaction(() => { for (const claim of claims) insert.run(sessionId, claim.kind, claim.statement, claim.confidence, stringify(claim.evidence_refs), claim.caveat, now()) })
          tx()
          const final = { ...decision.final, claims }
          db.prepare(`INSERT INTO code_reading_steps(session_id,sequence,kind,output_json,status,created_at) VALUES(?,?, 'final',?, 'succeeded',?)`).run(sessionId, turn, stringify(final), now())
          db.prepare("UPDATE code_reading_sessions SET status='completed',final_json=?,updated_at=?,finished_at=? WHERE id=?").run(stringify(final), now(), now(), sessionId)
          finishOperationRun(operationRunId, { status: 'succeeded', resultSummary: { evidence_count: validRefs.size, claim_count: claims.length, tool_calls: Number(current.tool_calls_used) } })
          return
        }
        if (!decision.tool || Number(current.tool_calls_used) >= maxToolCalls) throw new CodeReadingError('调查预算已耗尽，但模型未能形成可验证结论', 'TOOL_BUDGET_EXHAUSTED')
        const toolStep = startOperationStep({ operationRunId, stepName: `code_tool:${decision.tool.name}`, sequence: turn, inputSummary: decision.tool.arguments })
        try {
          const result = executeTool(sessionId, project.root, decision.tool)
          const resultText = stringify(result); const currentBytes = Number(current.bytes_read) + Buffer.byteLength(resultText, 'utf8')
          if (currentBytes > MAX_BYTES_READ) throw new CodeReadingError('本次调查读取内容超过安全预算', 'BYTE_BUDGET_EXHAUSTED')
          db.prepare(`INSERT INTO code_reading_steps(session_id,sequence,kind,tool_name,input_json,output_json,status,created_at) VALUES(?,?, 'tool',?,?,?, 'succeeded',?)`).run(sessionId, turn, decision.tool.name, stringify(decision.tool.arguments), resultText, now())
          db.prepare('UPDATE code_reading_sessions SET tool_calls_used=tool_calls_used+1,bytes_read=?,updated_at=? WHERE id=?').run(currentBytes, now(), sessionId)
          history.push({ tool: decision.tool.name, result })
          finishOperationStep(toolStep, { status: 'succeeded', outputSummary: { bytes: Buffer.byteLength(resultText, 'utf8') } })
        } catch (error) {
          const message = (error as Error).message
          db.prepare(`INSERT INTO code_reading_steps(session_id,sequence,kind,tool_name,input_json,status,error_message,created_at) VALUES(?,?, 'tool',?,?, 'failed',?,?)`).run(sessionId, turn, decision.tool.name, stringify(decision.tool.arguments), message, now())
          history.push({ tool: decision.tool.name, error: message })
          finishOperationStep(toolStep, { status: 'failed', errorCode: error instanceof CodeReadingError ? error.code : 'TOOL_FAILED', errorMessage: message })
        }
      }
      throw new CodeReadingError('调查轮次已耗尽', 'TOOL_BUDGET_EXHAUSTED')
    } catch (error) {
      const message = (error as Error).message || '代码调查失败'; const code = error instanceof CodeReadingError ? error.code : 'CODE_AGENT_FAILED'
      db.prepare("UPDATE code_reading_sessions SET status='failed',error_code=?,error_message=?,updated_at=?,finished_at=? WHERE id=?").run(code, message.slice(0, 2_000), now(), now(), sessionId)
      finishOperationRun(operationRunId, { status: 'failed', errorCode: code, errorMessage: message })
      logApp({ level: 'error', source: 'code_reading_agent', eventName: 'code_agent.failed', message, errorCode: code, entityType: 'code_reading_session', entityId: sessionId })
    }
  })
}

export function codeReadingSessionDetail(sessionId: string): Record<string, unknown> {
  const session = sessionRow(sessionId)
  const steps = db.prepare('SELECT id,sequence,kind,tool_name,input_json,output_json,status,error_message,created_at FROM code_reading_steps WHERE session_id=? ORDER BY id').all(sessionId)
  const evidence = db.prepare('SELECT evidence_ref,relative_path,start_line,end_line,excerpt,created_at FROM code_reading_evidence WHERE session_id=? ORDER BY id').all(sessionId)
  const claims = db.prepare('SELECT claim_kind,statement,confidence,evidence_refs_json,caveat FROM code_reading_claims WHERE session_id=? ORDER BY id').all(sessionId).map(item => ({ ...(item as Record<string, unknown>), evidence_refs: parse((item as { evidence_refs_json: string }).evidence_refs_json, []) }))
  return { ...session, final: parse(session.final_json, null), steps: (steps as Array<Record<string, unknown>>).map(item => ({ ...item, input: parse(item.input_json, null), output: parse(item.output_json, null), input_json: undefined, output_json: undefined })), evidence, claims }
}

export function listCodeReadingSessions(projectId: number) {
  return db.prepare('SELECT id,question,output_mode,status,tool_calls_used,bytes_read,created_at,updated_at,finished_at FROM code_reading_sessions WHERE project_id=? ORDER BY created_at DESC LIMIT 20').all(projectId)
}

/** 供其它 Agent 调用的同步适配层：仍复用同一套只读工具、预算、审计与证据表。 */
export async function investigateCodeForCaller(input: { projectIds: unknown; objective: unknown; questions: unknown; caller: string }) {
  const projectIds = Array.isArray(input.projectIds)
    ? [...new Set(input.projectIds.map(Number).filter(id => Number.isInteger(id) && id > 0))].slice(0, 2)
    : []
  if (!projectIds.length) return { packs: [], warning: '未选择项目，跳过代码调查。' }
  const objective = clean(input.objective, 1_200) || '提取与当前目标相关的项目实现证据'
  const questions = Array.isArray(input.questions) ? input.questions.map(item => clean(item, 500)).filter(Boolean).slice(0, 6) : []
  const packs = await Promise.all(projectIds.map(async projectId => {
    try {
      const question = `${objective}\n\n重点调查：\n${questions.map((item, index) => `${index + 1}. ${item}`).join('\n') || '请找出与目标最相关的真实实现、调用链和设计取舍。'}\n\n调用方：${clean(input.caller, 60) || 'internal'}`
      // 面试准备只需要少量、可引用的项目证据；保留完整 12 次预算给用户手动发起的深度调查。
      const created = createCodeReadingSession({ projectId, question, outputMode: 'interview_story', maxToolCalls: INTERNAL_TOOL_CALLS })
      await runCodeReadingSession(String(created.id))
      const detail = codeReadingSessionDetail(String(created.id))
      if (detail.status !== 'completed') {
        return { project_id: projectId, status: detail.status, error_message: detail.error_message ?? '代码调查未完成', facts: [], evidence: [] }
      }
      const final = detail.final as { overview?: string; claims?: Claim[]; follow_up_questions?: string[] } | null
      return {
        project_id: projectId, status: 'completed', session_id: detail.id,
        overview: final?.overview ?? '', facts: final?.claims ?? [], follow_up_questions: final?.follow_up_questions ?? [],
        evidence: detail.evidence
      }
    } catch (error) {
      const message = (error as Error).message || '代码调查未完成'
      logApp({ level: 'warn', source: 'code_reading_agent', eventName: 'code_agent.caller_project_failed', message, errorCode: error instanceof CodeReadingError ? error.code : 'CODE_AGENT_CALLER_PROJECT_FAILED', entityType: 'project_profile', entityId: projectId })
      return { project_id: projectId, status: 'failed', error_message: message.slice(0, 2_000), facts: [], evidence: [] }
    }
  }))
  return { packs, warning: null }
}
