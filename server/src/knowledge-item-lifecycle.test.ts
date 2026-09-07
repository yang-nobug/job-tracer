import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 路由会加载 SQLite 单例，因此先切换到临时数据目录，绝不触碰用户的正式知识库。
const testDataDir = mkdtempSync(path.join(os.tmpdir(), 'job-tracer-knowledge-item-'))
process.env.JOB_TRACER_DATA_DIR = testDataDir
const { db, now } = await import('./db.js')
const { knowledgeRouter } = await import('./routes/knowledge.js')

const app = express()
app.use(express.json())
app.use('/knowledge', knowledgeRouter)
const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
  const value = app.listen(0, '127.0.0.1', () => resolve(value))
})
const address = server.address()
if (!address || typeof address === 'string') throw new Error('测试 HTTP 服务启动失败')
const baseUrl = `http://127.0.0.1:${address.port}/knowledge`

after(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  db.close()
  rmSync(testDataDir, { recursive: true, force: true })
})

async function json(pathname: string, options: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  })
}

test('编辑、恢复答案版本与 Markdown 导出保持当前面经一致', async () => {
  const ts = now()
  const source = db.prepare(`INSERT INTO knowledge_sources
    (owner,company,position,round,source_type,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('others', '示例科技', 'AI 应用开发工程师', '一面', 'manual', '用于生命周期测试', ts, ts)
  const item = db.prepare(`INSERT INTO knowledge_items
    (source_id,question,answer,category,mastery,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
    .run(source.lastInsertRowid, '如何解释 RAG 的召回与重排？', '旧答案', '项目', 1, ts, ts)
  const itemId = Number(item.lastInsertRowid)
  const duplicate = db.prepare(`INSERT INTO knowledge_sources
    (owner,company,position,round,source_type,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('others', '示例科技', 'AI 应用开发工程师', '一面', 'manual', '第二份面经', now(), now())

  const sourcesResponse = await json('/sources?owner=others')
  assert.equal(sourcesResponse.status, 200)
  const sources = await sourcesResponse.json() as Array<{ id: number; duplicate_count: number; duplicate_index: number }>
  const first = sources.find(row => row.id === Number(source.lastInsertRowid))
  const second = sources.find(row => row.id === Number(duplicate.lastInsertRowid))
  assert.deepEqual(first && { count: first.duplicate_count, index: first.duplicate_index }, { count: 2, index: 1 })
  assert.deepEqual(second && { count: second.duplicate_count, index: second.duplicate_index }, { count: 2, index: 2 })

  const edit = await json(`/items/${itemId}`, {
    method: 'PUT', body: JSON.stringify({
      question: '如何解释 RAG 的召回、重排与生成？', answer: '手工修订后的答案', category: '项目', expected_updated_at: ts
    })
  })
  assert.equal(edit.status, 200)
  const edited = await edit.json() as { answer: string; updated_at: string }
  assert.equal(edited.answer, '手工修订后的答案')

  const versionsResponse = await json(`/items/${itemId}/answer-versions`)
  assert.equal(versionsResponse.status, 200)
  const versions = await versionsResponse.json() as Array<{ id: number; answer: string; reason: string }>
  assert.equal(versions.length, 1)
  assert.deepEqual(versions[0] && { answer: versions[0].answer, reason: versions[0].reason }, { answer: '旧答案', reason: 'before_manual_edit' })

  const stale = await json(`/items/${itemId}`, {
    method: 'PUT', body: JSON.stringify({ question: '不应覆盖', expected_updated_at: ts })
  })
  assert.equal(stale.status, 409)

  const restored = await json(`/items/${itemId}/answer-versions/${versions[0].id}/restore`, {
    method: 'POST', body: JSON.stringify({ expected_updated_at: edited.updated_at })
  })
  assert.equal(restored.status, 200)
  assert.equal((await restored.json() as { answer: string }).answer, '旧答案')

  const exported = await fetch(`${baseUrl}/sources/${source.lastInsertRowid}/export.md`)
  assert.equal(exported.status, 200)
  const disposition = exported.headers.get('content-disposition') ?? ''
  assert.match(disposition, /attachment/)
  const encodedFilename = disposition.match(/filename\*=UTF-8''(.+)$/)?.[1] ?? ''
  assert.equal(decodeURIComponent(encodedFilename), '示例科技-AI 应用开发工程师-一面-面经（1）.md')
  const markdown = await exported.text()
  assert.match(markdown, /# 示例科技 · AI 应用开发工程师 · 一面/)
  assert.match(markdown, /> 如何解释 RAG 的召回、重排与生成？/)
  assert.match(markdown, /旧答案/)
})
