import test from 'node:test'
import assert from 'node:assert/strict'
import {
  validateAnswerGeneration,
  validateJdParse,
  validateKnowledgeExtraction,
  validateRecordingAnalysis
} from './ai-contracts.js'

test('JD 合约会清理字符串并拒绝未定义字段', () => {
  assert.deepEqual(validateJdParse({
    company: ' 示例公司 ',
    position: '前端开发',
    location: '',
    summary: 'Vue 方向',
    jd: '岗位职责'
  }), {
    company: '示例公司',
    position: '前端开发',
    location: '',
    summary: 'Vue 方向',
    jd: '岗位职责'
  })
  assert.throws(() => validateJdParse({
    company: '', position: '', location: '', summary: '', jd: '', unexpected: true
  }), /未定义字段/)
})

test('知识拆题合约拒绝非法分类和空题目', () => {
  const base = { company: '', position: '', round: '', questions: [] }
  assert.deepEqual(validateKnowledgeExtraction(base), base)
  assert.throws(() => validateKnowledgeExtraction({
    ...base,
    questions: [{ question: '事件循环是什么？', answer: '', category: '前端' }]
  }), /category 不在允许范围内/)
  assert.throws(() => validateKnowledgeExtraction({
    ...base,
    questions: [{ question: ' ', answer: '', category: '八股' }]
  }), /question 不能为空/)
})

test('答案生成必须完整覆盖请求 ID', () => {
  const valid = validateAnswerGeneration({
    answers: [{ id: 2, answer: '答案二' }, { id: 1, answer: '答案一' }]
  }, [1, 2])
  assert.equal(valid.answers.length, 2)
  assert.throws(() => validateAnswerGeneration({ answers: [{ id: 1, answer: '答案一' }] }, [1, 2]), /缺少题目答案/)
  assert.throws(() => validateAnswerGeneration({ answers: [{ id: 3, answer: '答案三' }] }, [1]), /未请求的题目 ID/)
})

test('录音分析不会在题目 JSON 损坏时静默保存空结果', () => {
  assert.deepEqual(validateRecordingAnalysis({
    review: '# 复盘',
    questions: [{ question: '介绍项目', answer: '介绍了架构', category: '项目' }]
  }).questions[0].category, '项目')
  assert.throws(() => validateRecordingAnalysis({ review: '# 复盘', questions: '损坏' }), /questions 必须是数组/)
})
