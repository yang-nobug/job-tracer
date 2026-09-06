import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { db, now } from './db.js'
import { createOperationRun, finishOperationRun, finishOperationStep, logApp, runWithTrace, startOperationStep } from './observability.js'
import { hasLikelySecretContent, isIgnoredSourceSegment, isProtectedSourceName } from './source-access-policy.js'

const MAX_FILES = 2_000
const MAX_FILE_BYTES = 1_000_000
const MAX_TOTAL_BYTES = 25 * 1024 * 1024
const MAX_CHUNK_CHARS = 6_000
const GENERATED_PATH = /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|.*\.min\.[cm]?js|.*\.map)$/i

export type ProjectLanguage = 'typescript' | 'javascript' | 'python' | 'java' | 'go' | 'rust' | 'vue' | 'sql' | 'markdown' | 'json' | 'yaml' | 'other'

function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function cleanText(value: unknown, limit = 8_000): string { return typeof value === 'string' ? value.trim().slice(0, limit) : '' }
function languageFor(file: string): ProjectLanguage {
  const ext = path.extname(file).toLowerCase()
  if (['.ts', '.tsx'].includes(ext)) return 'typescript'
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript'
  if (ext === '.py') return 'python'
  if (ext === '.java') return 'java'
  if (ext === '.go') return 'go'
  if (ext === '.rs') return 'rust'
  if (ext === '.vue') return 'vue'
  if (ext === '.sql') return 'sql'
  if (['.md', '.mdx'].includes(ext)) return 'markdown'
  if (ext === '.json') return 'json'
  if (['.yml', '.yaml'].includes(ext)) return 'yaml'
  return 'other'
}
function isTextCandidate(file: string): boolean { return languageFor(file) !== 'other' || ['README', 'Dockerfile', 'Makefile'].includes(path.basename(file)) }
function isBinary(buffer: Buffer): boolean { return buffer.subarray(0, 8_192).includes(0) }
function safeRelative(root: string, filename: string): string | null {
  const resolved = realpathSync(filename)
  const relative = path.relative(root, resolved)
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.replace(/\\/g, '/') : null
}
function jsonArray(value: unknown): string[] {
  try { return Array.isArray(JSON.parse(typeof value === 'string' ? value : '[]')) ? JSON.parse(typeof value === 'string' ? value : '[]').filter((item): item is string => typeof item === 'string') : [] } catch { return [] }
}

export class ProjectArchiveError extends Error {
  constructor(message: string, public code: string, public status = 422) { super(message) }
}

export function inspectProjectRoot(input: unknown): { sourcePath: string; realpath: string } {
  const sourcePath = cleanText(input, 2_000)
  if (!sourcePath) throw new ProjectArchiveError('请选择或输入项目根目录', 'PROJECT_PATH_REQUIRED')
  let realpath: string
  try {
    realpath = realpathSync(path.resolve(sourcePath))
    if (!statSync(realpath).isDirectory()) throw new Error('not directory')
  } catch {
    throw new ProjectArchiveError('项目路径不存在，或不是可读取的目录', 'PROJECT_PATH_INVALID')
  }
  return { sourcePath, realpath }
}

function normalizeScopes(root: string, raw: unknown): string[] {
  const source = Array.isArray(raw) ? raw : jsonArray(raw)
  const scopes = source.map(item => cleanText(item, 500).replace(/\\/g, '/')).filter(Boolean).slice(0, 20)
  const result = scopes.length ? scopes : ['.']
  const normalized: string[] = []
  for (const scope of result) {
    if (path.isAbsolute(scope)) throw new ProjectArchiveError('扫描范围必须是项目目录内的相对路径', 'PROJECT_SCOPE_INVALID')
    const target = path.resolve(root, scope)
    let real: string
    try { real = realpathSync(target) } catch { throw new ProjectArchiveError(`扫描范围不存在：${scope}`, 'PROJECT_SCOPE_INVALID') }
    const relative = path.relative(root, real)
    if ((relative && relative.startsWith('..')) || path.isAbsolute(relative) || !statSync(real).isDirectory()) {
      throw new ProjectArchiveError(`扫描范围不在项目根目录内：${scope}`, 'PROJECT_SCOPE_INVALID')
    }
    normalized.push(relative ? relative.replace(/\\/g, '/') : '.')
  }
  return [...new Set(normalized)].filter(scope => !normalized.some(parent => parent !== scope && (parent === '.' || scope.startsWith(`${parent}/`))))
}

function collectFiles(root: string, scopes: string[]): { files: string[]; skipped: Record<string, number>; seen: number; truncated: boolean } {
  const files: string[] = []; const skipped: Record<string, number> = {}; let seen = 0; let truncated = false
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1 }
  const walk = (dir: string): void => {
    if (truncated) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { skip('unreadable_directory'); return }
    for (const entry of entries) {
      if (truncated) return
      const target = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) { skip('symbolic_link'); continue }
      if (entry.isDirectory()) { if (isIgnoredSourceSegment(entry.name)) skip(`ignored:${entry.name}`); else walk(target); continue }
      if (!entry.isFile()) continue
      seen += 1
      if (files.length >= MAX_FILES) { truncated = true; skip('file_limit'); return }
      if (isProtectedSourceName(entry.name)) { skip('sensitive_name'); continue }
      if (!isTextCandidate(target)) { skip('unsupported_extension'); continue }
      try {
        const size = statSync(target).size
        if (size > MAX_FILE_BYTES) { skip('file_too_large'); continue }
        files.push(target)
      } catch { skip('unreadable_file') }
    }
  }
  for (const scope of scopes) walk(path.join(root, scope))
  return { files, skipped, seen, truncated }
}

type SymbolDraft = { name: string; kind: string; exported: number; startLine: number; endLine: number; signature: string }
function extractSymbols(lines: string[], language: ProjectLanguage): SymbolDraft[] {
  const result: SymbolDraft[] = []
  const patterns = language === 'python'
    ? [/^\s*(async\s+def|def|class)\s+([A-Za-z_]\w*)/]
    : [/^\s*(export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var)\s+([A-Za-z_$][\w$]*)/, /^\s*(?:public|private|protected)?\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/]
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    for (const pattern of patterns) {
      const match = line.match(pattern)
      if (!match) continue
      const name = language === 'python' ? match[2] : (match[2] ?? match[1])
      if (!name || ['if', 'for', 'while', 'switch', 'catch'].includes(name)) continue
      const kind = language === 'python' ? match[1].replace(/\s+def/, '').replace('def', 'function') : (line.match(/\b(class|interface|type|function|const|let|var)\b/)?.[1] ?? 'method')
      result.push({ name, kind, exported: /\bexport\b|^\s*(?:def|class)\s+[^_]/.test(line) ? 1 : 0, startLine: index + 1, endLine: Math.min(lines.length, index + 80), signature: line.trim().slice(0, 500) })
      break
    }
  }
  return result.slice(0, 400)
}
function chunksFor(lines: string[], symbols: SymbolDraft[]): Array<{ startLine: number; endLine: number; content: string; symbolIndex: number | null }> {
  const starts = [...new Set([1, ...symbols.map(item => item.startLine)])].sort((a, b) => a - b)
  const chunks: Array<{ startLine: number; endLine: number; content: string; symbolIndex: number | null }> = []
  for (let i = 0; i < starts.length; i += 1) {
    const start = starts[i]; const end = Math.min(lines.length, (starts[i + 1] ?? lines.length + 1) - 1)
    let cursor = start
    while (cursor <= end) {
      let last = cursor; let chars = 0
      while (last <= end && chars + lines[last - 1].length + 1 <= MAX_CHUNK_CHARS) { chars += lines[last - 1].length + 1; last += 1 }
      if (last === cursor) last += 1
      const content = lines.slice(cursor - 1, last - 1).join('\n').trim()
      if (content) {
        const symbolIndex = symbols.findIndex(s => s.startLine === start)
        chunks.push({ startLine: cursor, endLine: last - 1, content, symbolIndex: symbolIndex >= 0 ? symbolIndex : null })
      }
      cursor = last
    }
  }
  return chunks.slice(0, 500)
}

export function createProjectProfile(input: { sourcePath: unknown; name: unknown; description: unknown; scanScopes?: unknown }) {
  const root = inspectProjectRoot(input.sourcePath)
  const name = cleanText(input.name, 200) || path.basename(root.realpath)
  const description = cleanText(input.description, 8_000)
  const scanScopes = normalizeScopes(root.realpath, input.scanScopes)
  const duplicate = db.prepare('SELECT id FROM project_profiles WHERE root_realpath=?').get(root.realpath) as { id: number } | undefined
  if (duplicate) throw new ProjectArchiveError('该目录已经接入项目档案', 'PROJECT_ALREADY_EXISTS', 409)
  const ts = now()
  const result = db.prepare(`INSERT INTO project_profiles(name,description,source_path,root_realpath,scan_scopes_json,status,created_at,updated_at)
    VALUES(?,?,?,?,?,'ready',?,?)`).run(name, description, root.sourcePath, root.realpath, JSON.stringify(scanScopes), ts, ts)
  return projectDetail(Number(result.lastInsertRowid))
}

export function scanProject(projectId: number): ReturnType<typeof projectDetail> {
  const project = db.prepare('SELECT * FROM project_profiles WHERE id=?').get(projectId) as { id: number; root_realpath: string; scan_scopes_json: string } | undefined
  if (!project) throw new ProjectArchiveError('项目档案不存在', 'PROJECT_NOT_FOUND', 404)
  const root = inspectProjectRoot(project.root_realpath).realpath
  const scopes = normalizeScopes(root, project.scan_scopes_json)
  const operation = createOperationRun({ operationType: 'project_code_scan', parentEntityType: 'project_profile', parentEntityId: projectId,
    inputSummary: { root_path: root, scopes, read_only: true, max_files: MAX_FILES, max_total_bytes: MAX_TOTAL_BYTES } })
  return runWithTrace({ traceId: operation.traceId, operationRunId: operation.id }, () => {
    const step = startOperationStep({ operationRunId: operation.id, stepName: 'read_only_index', inputSummary: { root_path: root, scopes } })
    const started = now()
    const scanResult = db.prepare(`INSERT INTO project_repo_scans(project_id,status,root_realpath,file_limit,byte_limit,started_at)
      VALUES(?,'running',?,?,?,?)`).run(projectId, root, MAX_FILES, MAX_TOTAL_BYTES, started)
    const scanId = Number(scanResult.lastInsertRowid)
    db.prepare("UPDATE project_profiles SET status='scanning',updated_at=? WHERE id=?").run(started, projectId)
    try {
      const collected = collectFiles(root, scopes); let bytesRead = 0; let indexed = 0; let reused = 0; const skipped = collected.skipped
      const previous = new Map((db.prepare('SELECT id,relative_path,size_bytes,mtime_ms FROM project_code_files WHERE project_id=?').all(projectId) as Array<{ id: number; relative_path: string; size_bytes: number; mtime_ms: number | null }>).map(item => [item.relative_path, item]))
      const upsertFile = db.prepare(`INSERT INTO project_code_files(project_id,relative_path,language,size_bytes,mtime_ms,content_hash,line_count,is_generated,last_seen_scan_id,indexed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,relative_path) DO UPDATE SET language=excluded.language,size_bytes=excluded.size_bytes,mtime_ms=excluded.mtime_ms,content_hash=excluded.content_hash,line_count=excluded.line_count,is_generated=excluded.is_generated,last_seen_scan_id=excluded.last_seen_scan_id,indexed_at=excluded.indexed_at`)
      const removeSymbols = db.prepare('DELETE FROM project_code_symbols WHERE file_id=?')
      const removeChunks = db.prepare('DELETE FROM project_code_chunks WHERE file_id=?')
      const insertSymbol = db.prepare(`INSERT INTO project_code_symbols(project_id,file_id,name,kind,exported,start_line,end_line,signature,last_seen_scan_id) VALUES(?,?,?,?,?,?,?,?,?)`)
      const insertChunk = db.prepare(`INSERT INTO project_code_chunks(project_id,file_id,symbol_id,start_line,end_line,content,content_hash,last_seen_scan_id) VALUES(?,?,?,?,?,?,?,?)`)
      const markReused = db.prepare('UPDATE project_code_files SET last_seen_scan_id=?,indexed_at=? WHERE id=?')
      const markSymbolsReused = db.prepare('UPDATE project_code_symbols SET last_seen_scan_id=? WHERE file_id=?')
      const markChunksReused = db.prepare('UPDATE project_code_chunks SET last_seen_scan_id=? WHERE file_id=?')
      const tx = db.transaction(() => {
        for (const filename of collected.files) {
          if (bytesRead >= MAX_TOTAL_BYTES) { skipped.byte_limit = (skipped.byte_limit ?? 0) + 1; continue }
          const relative = safeRelative(root, filename)
          if (!relative) { skipped.outside_root = (skipped.outside_root ?? 0) + 1; continue }
          let metadata
          try { metadata = statSync(filename) } catch { skipped.unreadable_file = (skipped.unreadable_file ?? 0) + 1; continue }
          const prior = previous.get(relative)
          if (prior && prior.size_bytes === metadata.size && prior.mtime_ms != null && Math.abs(prior.mtime_ms - metadata.mtimeMs) < 0.01) {
            markReused.run(scanId, now(), prior.id); markSymbolsReused.run(scanId, prior.id); markChunksReused.run(scanId, prior.id)
            reused += 1; indexed += 1; continue
          }
          let buffer: Buffer
          try { buffer = readFileSync(filename) } catch { skipped.unreadable_file = (skipped.unreadable_file ?? 0) + 1; continue }
          if (isBinary(buffer)) { skipped.binary_file = (skipped.binary_file ?? 0) + 1; continue }
          if (hasLikelySecretContent(buffer)) { skipped.potential_secret = (skipped.potential_secret ?? 0) + 1; continue }
          if (bytesRead + buffer.length > MAX_TOTAL_BYTES) { skipped.byte_limit = (skipped.byte_limit ?? 0) + 1; continue }
          bytesRead += buffer.length
          const content = buffer.toString('utf8'); const lines = content.split(/\r?\n/); const language = languageFor(relative)
          upsertFile.run(projectId, relative, language, buffer.length, metadata.mtimeMs, sha256(buffer), lines.length, GENERATED_PATH.test(relative) ? 1 : 0, scanId, now())
          const file = db.prepare('SELECT id FROM project_code_files WHERE project_id=? AND relative_path=?').get(projectId, relative) as { id: number }
          removeSymbols.run(file.id); removeChunks.run(file.id)
          const symbols = extractSymbols(lines, language); const symbolIds: number[] = []
          for (const symbol of symbols) symbolIds.push(Number(insertSymbol.run(projectId, file.id, symbol.name, symbol.kind, symbol.exported, symbol.startLine, symbol.endLine, symbol.signature, scanId).lastInsertRowid))
          for (const chunk of chunksFor(lines, symbols)) insertChunk.run(projectId, file.id, chunk.symbolIndex == null ? null : symbolIds[chunk.symbolIndex] ?? null, chunk.startLine, chunk.endLine, chunk.content, sha256(chunk.content), scanId)
          indexed += 1
        }
        db.prepare('DELETE FROM project_code_files WHERE project_id=? AND last_seen_scan_id<>?').run(projectId, scanId)
        db.prepare('DELETE FROM project_code_chunks_fts WHERE project_id=?').run(String(projectId))
        db.prepare(`INSERT INTO project_code_chunks_fts(rowid,content,relative_path,project_id,chunk_id)
          SELECT c.id,c.content,f.relative_path,CAST(c.project_id AS TEXT),CAST(c.id AS TEXT) FROM project_code_chunks c JOIN project_code_files f ON f.id=c.file_id WHERE c.project_id=?`).run(projectId)
      })
      tx()
      const partial = collected.truncated || Object.keys(skipped).some(key => ['byte_limit', 'file_limit'].includes(key))
      db.prepare(`UPDATE project_repo_scans SET status=?,files_seen=?,files_indexed=?,files_reused=?,files_skipped=?,bytes_read=?,truncated=?,skipped_json=?,finished_at=? WHERE id=?`).run(
        partial ? 'partial_success' : 'succeeded', collected.seen, indexed, reused, Math.max(0, collected.seen - indexed), bytesRead, partial ? 1 : 0, JSON.stringify(skipped), now(), scanId)
      db.prepare("UPDATE project_profiles SET status='ready',last_scan_id=?,root_realpath=?,updated_at=? WHERE id=?").run(scanId, root, now(), projectId)
      finishOperationStep(step, { status: 'succeeded', outputSummary: { scan_id: scanId, files_indexed: indexed, files_reused: reused, bytes_read: bytesRead, truncated: partial } })
      finishOperationRun(operation.id, { status: partial ? 'partial_success' : 'succeeded', resultSummary: { scan_id: scanId, files_indexed: indexed, files_reused: reused, bytes_read: bytesRead, skipped } })
      return projectDetail(projectId)
    } catch (error) {
      const message = (error as Error).message || '扫描失败'
      db.prepare("UPDATE project_repo_scans SET status='failed',error_message=?,finished_at=? WHERE id=?").run(message.slice(0, 2_000), now(), scanId)
      db.prepare("UPDATE project_profiles SET status='failed',updated_at=? WHERE id=?").run(now(), projectId)
      finishOperationStep(step, { status: 'failed', errorCode: 'PROJECT_SCAN_FAILED', errorMessage: message })
      finishOperationRun(operation.id, { status: 'failed', errorCode: 'PROJECT_SCAN_FAILED', errorMessage: message })
      logApp({ level: 'error', source: 'project_archive', eventName: 'project.scan_failed', message, errorCode: 'PROJECT_SCAN_FAILED', entityType: 'project_profile', entityId: projectId })
      throw new ProjectArchiveError(`项目扫描失败：${message}`, 'PROJECT_SCAN_FAILED', 500)
    }
  })
}

export function projectList() {
  return db.prepare(`SELECT p.*,s.status AS scan_status,s.files_indexed,s.files_reused,s.files_seen,s.bytes_read,s.truncated,s.finished_at AS scanned_at,
    (SELECT COUNT(*) FROM project_code_symbols x WHERE x.project_id=p.id) AS symbol_count
    FROM project_profiles p LEFT JOIN project_repo_scans s ON s.id=p.last_scan_id ORDER BY p.updated_at DESC`).all()
}
export function projectDetail(projectId: number) {
  const project = db.prepare(`SELECT p.*,s.status AS scan_status,s.files_indexed,s.files_reused,s.files_seen,s.files_skipped,s.bytes_read,s.truncated,s.skipped_json,s.error_message,s.finished_at AS scanned_at,
    (SELECT COUNT(*) FROM project_code_symbols x WHERE x.project_id=p.id) AS symbol_count,(SELECT COUNT(*) FROM project_code_chunks x WHERE x.project_id=p.id) AS chunk_count
    FROM project_profiles p LEFT JOIN project_repo_scans s ON s.id=p.last_scan_id WHERE p.id=?`).get(projectId)
  if (!project) return null
  const files = db.prepare('SELECT id,relative_path,language,size_bytes,line_count,is_generated,indexed_at FROM project_code_files WHERE project_id=? ORDER BY relative_path LIMIT 300').all(projectId)
  const facts = db.prepare('SELECT * FROM project_facts WHERE project_id=? ORDER BY id DESC').all(projectId)
  return { project, files, facts }
}
export function searchProjectCode(projectId: number, query: string) {
  const text = cleanText(query, 300)
  if (!text) throw new ProjectArchiveError('请输入检索词', 'PROJECT_SEARCH_REQUIRED')
  const exists = db.prepare('SELECT id FROM project_profiles WHERE id=?').get(projectId)
  if (!exists) throw new ProjectArchiveError('项目档案不存在', 'PROJECT_NOT_FOUND', 404)
  // FTS 语法由用户输入时可能报错，退回普通 LIKE，保持检索入口可靠。
  try {
    return db.prepare(`SELECT c.id,f.relative_path,c.start_line,c.end_line,c.content,s.name AS symbol_name,s.kind AS symbol_kind
      FROM project_code_chunks_fts fts JOIN project_code_chunks c ON c.id=fts.rowid JOIN project_code_files f ON f.id=c.file_id
      LEFT JOIN project_code_symbols s ON s.id=c.symbol_id WHERE fts.project_id=? AND project_code_chunks_fts MATCH ? ORDER BY bm25(project_code_chunks_fts) LIMIT 20`).all(String(projectId), text)
  } catch {
    const like = `%${text}%`
    return db.prepare(`SELECT c.id,f.relative_path,c.start_line,c.end_line,c.content,s.name AS symbol_name,s.kind AS symbol_kind
      FROM project_code_chunks c JOIN project_code_files f ON f.id=c.file_id LEFT JOIN project_code_symbols s ON s.id=c.symbol_id
      WHERE c.project_id=? AND (c.content LIKE ? OR f.relative_path LIKE ? OR s.name LIKE ?) ORDER BY c.id DESC LIMIT 20`).all(projectId, like, like, like)
  }
}
export function deleteProjectProfile(projectId: number): boolean { return db.prepare('DELETE FROM project_profiles WHERE id=?').run(projectId).changes > 0 }
export function updateProjectProfile(projectId: number, input: { name?: unknown; description?: unknown; scanScopes?: unknown }) {
  const existing = db.prepare('SELECT * FROM project_profiles WHERE id=?').get(projectId) as { name: string; description: string; root_realpath: string; scan_scopes_json: string } | undefined
  if (!existing) throw new ProjectArchiveError('项目档案不存在', 'PROJECT_NOT_FOUND', 404)
  const name = input.name === undefined ? existing.name : cleanText(input.name, 200)
  if (!name) throw new ProjectArchiveError('项目名称不能为空', 'PROJECT_NAME_REQUIRED')
  const description = input.description === undefined ? existing.description : cleanText(input.description, 8_000)
  const scopes = input.scanScopes === undefined ? jsonArray(existing.scan_scopes_json) : normalizeScopes(existing.root_realpath, input.scanScopes)
  db.prepare('UPDATE project_profiles SET name=?,description=?,scan_scopes_json=?,updated_at=? WHERE id=?').run(name, description, JSON.stringify(scopes.length ? scopes : ['.']), now(), projectId)
  return projectDetail(projectId)
}
export function updateProjectFact(projectId: number, input: { factType: unknown; title: unknown; content: unknown; evidenceChunkIds: unknown }) {
  const factType = cleanText(input.factType, 40); const title = cleanText(input.title, 300); const content = cleanText(input.content, 8_000)
  if (!['architecture', 'responsibility', 'technology', 'decision', 'metric', 'risk'].includes(factType) || !title || !content) throw new ProjectArchiveError('请填写有效的事实类型、标题和内容', 'PROJECT_FACT_INVALID')
  if (!db.prepare('SELECT id FROM project_profiles WHERE id=?').get(projectId)) throw new ProjectArchiveError('项目档案不存在', 'PROJECT_NOT_FOUND', 404)
  const requested = Array.isArray(input.evidenceChunkIds) ? input.evidenceChunkIds.map(Number).filter(Number.isInteger).slice(0, 20) : []
  const evidence = requested.length
    ? (db.prepare(`SELECT id FROM project_code_chunks WHERE project_id=? AND id IN (${requested.map(() => '?').join(',')})`).all(projectId, ...requested) as Array<{ id: number }>).map(item => item.id)
    : []
  const ts = now(); const result = db.prepare(`INSERT INTO project_facts(project_id,fact_type,title,content,evidence_chunk_ids_json,confidence,created_at,updated_at) VALUES(?,?,?,?,?,'user_confirmed',?,?)`).run(projectId, factType, title, content, JSON.stringify(evidence), ts, ts)
  return db.prepare('SELECT * FROM project_facts WHERE id=?').get(result.lastInsertRowid)
}
