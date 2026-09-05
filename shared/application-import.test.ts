import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeExtraction, validateExtraction } from './application-import.js'

test('招聘材料提取会补齐视觉模型遗漏的空字段和空数组', () => {
  const result = validateExtraction(normalizeExtraction({
    target_state: 'single',
    fields: {
      company: { value: '广联达科技股份有限公司', state: 'extracted', evidence: [{ source_id: 'image_1', quote: '广联达科技股份有限公司' }] },
      position: { value: 'AI Agent开发工程师', state: 'extracted', evidence: [{ source_id: 'image_1', quote: 'AI Agent开发工程师' }], alternatives: [] }
    },
    target_candidates: [],
    date_facts: [],
    warnings: []
  }))
  assert.equal(result.fields.company.value, '广联达科技股份有限公司')
  assert.deepEqual(result.fields.company.alternatives, [])
  assert.equal(result.fields.location.state, 'missing')
  assert.deepEqual(result.fields.location.evidence, [])
})

test('缺少证据的模型字段仍会保留，供用户在表单中核对', () => {
  const result = validateExtraction(normalizeExtraction({
    schema_version: '1', target_state: 'single', target_candidates: [], date_facts: [], warnings: [],
    fields: {
      company: { value: '广联达科技股份有限公司', state: 'extracted', evidence: [], alternatives: [] }
    }
  }))
  assert.equal(result.fields.company.value, '广联达科技股份有限公司')
  assert.equal(result.fields.company.state, 'extracted')
  assert.deepEqual(result.fields.company.evidence, [])
})

test('模型遗漏目标岗位状态时，有公司和职位仍按单个岗位进入核对', () => {
  const result = validateExtraction(normalizeExtraction({
    fields: {
      company: { value: '美团', evidence: [] },
      position: { value: 'AI应用开发工程师', evidence: [] }
    },
    target_candidates: [], date_facts: [], warnings: []
  }))
  assert.equal(result.target_state, 'single')
  assert.equal(result.fields.position.value, 'AI应用开发工程师')
})

test('不合法日期和额外字段会被隔离，可靠字段仍可保留', () => {
  const result = validateExtraction(normalizeExtraction({
    schema_version: '2', target_state: 'single', target_candidates: [], warnings: ['截图清晰'],
    fields: {
      company: {
        value: '广联达科技股份有限公司', state: 'extracted',
        evidence: [{ source_id: 'image_1', quote: '广联达科技股份有限公司', ignored: true }],
        alternatives: [], confidence: 0.9
      }
    },
    date_facts: [{ kind: 'application', raw: '2026-09-01', evidence: [] }],
    extra: 'ignored'
  }))
  assert.equal(result.schema_version, '1')
  assert.equal(result.fields.company.value, '广联达科技股份有限公司')
  assert.deepEqual(result.date_facts, [])
  assert.equal('extra' in result, false)
})
