import test from 'node:test'
import assert from 'node:assert/strict'
import { db, now } from '../db.js'
import { buildFtsQuery, searchKnowledge } from '../knowledge-retrieval.js'
import { retrievalFixtures } from './fixtures.js'
import { retrievalMetrics } from './retrieval-metrics.js'

function seed(): Map<string, number> {
  db.exec(`DELETE FROM tutor_message_feedback; DELETE FROM tutor_message_citations;
    DELETE FROM knowledge_retrieval_runs; DELETE FROM tutor_sessions; DELETE FROM knowledge_sources;`)
  const ts = now()
  const source = db.prepare(`INSERT INTO knowledge_sources
    (owner,company,position,round,source_type,created_at,updated_at) VALUES ('mine',?,?,?,?,?,?)`)
    .run('脱敏科技', '前端开发', '一面', 'manual', ts, ts)
  const insert = db.prepare(`INSERT INTO knowledge_items
    (source_id,question,answer,category,mastery,created_at,updated_at) VALUES (?,?,?,?,0,?,?)`)
  const rows = [
    ['Vue3 响应式原理是什么？', '通过 Proxy、依赖追踪和触发更新实现。', '八股'],
    ['JavaScript 事件循环中，微任务的执行时机是什么？', '当前宏任务结束、渲染前清空微任务队列。', '八股'],
    ['你在项目中如何优化首屏加载性能？', '拆包、预加载、图片优化和缓存。', '项目'],
    ['HTTP 强缓存和协商缓存有什么区别？', '强缓存不发请求，协商缓存会向服务端验证。', '八股']
  ]
  const ids = new Map<string, number>()
  for (const [question, answer, category] of rows) {
    const result = insert.run(source.lastInsertRowid, question, answer, category, ts, ts)
    ids.set(question, Number(result.lastInsertRowid))
  }
  // 重复题保留为高频信号，但检索上下文应折叠成一条。
  insert.run(source.lastInsertRowid, rows[0][0], '另一份相同题目的回答。', rows[0][2], ts, ts)
  return ids
}

test('FTS 查询不会执行用户提供的运算符', () => {
  const query = buildFtsQuery('事件循环 OR "任意命令"')
  assert.ok(query)
  assert.doesNotMatch(query!, /\sOR\s"任意命令"$/)
  assert.match(query!, /^"/)
})

test('混合检索达到固定样本 Recall@5 与 MRR 基线', () => {
  seed()
  const evaluated = retrievalFixtures.map(fixture => ({
    relevant: new Set<string>(fixture.relevantQuestions),
    returned: searchKnowledge(fixture.query, { limit: 5 }).items.map(item => item.question)
  }))
  const metrics = retrievalMetrics(evaluated, 5)
  assert.equal(metrics.recallAtK, 1)
  assert.ok(metrics.mrr >= 0.8, `MRR 退化为 ${metrics.mrr}`)
  const duplicate = searchKnowledge('Vue 响应式原理', { limit: 5 }).items[0]
  assert.equal(duplicate.question, 'Vue3 响应式原理是什么？')
  assert.equal(duplicate.duplicateCount, 2)
  assert.ok(duplicate.matchedBy.includes('fts5'))
})

test('回答反馈会成为后续检索的有界排序信号', () => {
  const ids = seed()
  const question = 'JavaScript 事件循环中，微任务的执行时机是什么？'
  const before = searchKnowledge('事件循环微任务', { limit: 5 }).items.find(item => item.id === ids.get(question))!
  const ts = now()
  const session = db.prepare("INSERT INTO tutor_sessions(title,created_at,updated_at) VALUES ('评测',?,?)").run(ts, ts)
  const assistant = db.prepare("INSERT INTO tutor_messages(session_id,role,content,created_at) VALUES (?,'assistant',?,?)")
    .run(session.lastInsertRowid, '带引用的脱敏回答', ts)
  db.prepare(`INSERT INTO tutor_message_citations(message_id,knowledge_item_id,citation_key,rank,score)
    VALUES (?,?, 'K1',1,1)`).run(assistant.lastInsertRowid, ids.get(question))
  db.prepare('INSERT INTO tutor_message_feedback(message_id,value,created_at,updated_at) VALUES (?,1,?,?)')
    .run(assistant.lastInsertRowid, ts, ts)
  const after = searchKnowledge('事件循环微任务', { limit: 5 }).items.find(item => item.id === ids.get(question))!
  assert.ok(after.score > before.score)
})
