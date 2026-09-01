import test from 'node:test'
import assert from 'node:assert/strict'
import { validateExtraction } from '../../../shared/application-import.js'
import { resolveAppliedDate } from '../application-dates.js'
import { validateRecordingChunk } from '../ai-contracts.js'
import { splitRecordingTranscript } from '../recording-analysis.js'
import { dateFixtures, extractionFixtures } from './fixtures.js'

test('脱敏投递样本符合合约，并保留多岗位与注入边界预期', () => {
  for (const fixture of extractionFixtures) {
    const validated = validateExtraction(fixture.expected)
    assert.equal(validated.target_state, fixture.expected.target_state, fixture.id)
  }
  assert.match(extractionFixtures.find(item => item.id === 'prompt-injection-is-material')!.material, /忽略此前规则/)
})

test('投递日期固定样本覆盖相对日期、冲突和缺失', () => {
  for (const fixture of dateFixtures) {
    const actual = resolveAppliedDate(fixture.facts, fixture.sources)
    assert.equal(actual.state, fixture.expected.state, fixture.id)
    assert.equal(actual.value, fixture.expected.value, fixture.id)
  }
})

test('录音分段确定、完整覆盖且控制最大分段数', () => {
  const transcript = Array.from({ length: 4000 }, (_, index) => `第${index}行：面试对话内容。`).join('\n')
  const first = splitRecordingTranscript(transcript)
  const second = splitRecordingTranscript(transcript)
  assert.deepEqual(first, second)
  assert.ok(first.length > 1 && first.length <= 60)
  assert.equal(first[0].start, 0)
  assert.equal(first.at(-1)?.end, transcript.length)
  for (let index = 1; index < first.length; index++) {
    assert.ok(first[index].start < first[index - 1].end, '相邻分段应保留上下文重叠')
    assert.ok(first[index].start <= first[index - 1].end, '分段不能漏字')
  }
  const veryLong = `${'脱敏对话'.repeat(180)}\n`.repeat(2000)
  assert.ok(splitRecordingTranscript(veryLong).length <= 60, '极长转写也必须限制分段数量')
})

test('录音分段合约拒绝错误分类、额外字段和损坏数组', () => {
  assert.deepEqual(validateRecordingChunk({
    summary: '候选人介绍了项目架构。',
    questions: [{ question: '如何做状态管理？', answer: '使用集中式 store。', category: '项目' }]
  }).questions.length, 1)
  assert.throws(() => validateRecordingChunk({ summary: 'x', questions: [], injected: true }), /未定义字段/)
  assert.throws(() => validateRecordingChunk({ summary: 'x', questions: '损坏' }), /必须是数组/)
  assert.throws(() => validateRecordingChunk({
    summary: 'x', questions: [{ question: 'q', answer: '', category: '不存在的分类' }]
  }), /category 不在允许范围内/)
})
