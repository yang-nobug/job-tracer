import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeStoredPrepTaskGuide, validatePrepLearningModule, validatePrepTaskBlueprint,
  validatePrepTaskGuide, validatePrepTaskPracticeSet
} from './prep-task-contracts.js'

const longText = (title: string) => `${title}。`.repeat(110)

function validBlueprint() {
  return {
    overview: '围绕响应式原理构建完整学习、应用和面试表达能力。',
    objectives: ['能够说明依赖收集与触发更新', '能够分析响应式失效场景'],
    prerequisites: ['JavaScript 对象和函数基础'],
    coverage_map: [
      { objective: '能够说明依赖收集与触发更新', module_ids: ['M1'], practice_levels: ['basic', 'interview'] },
      { objective: '能够分析响应式失效场景', module_ids: ['M2'], practice_levels: ['understanding', 'application'] }
    ],
    modules: [
      {
        id: 'M1', title: '响应式更新链路', purpose: '建立完整心智模型', recommended_minutes: 40,
        learning_outcomes: ['说明 track 的职责', '说明 trigger 的职责'], evidence_refs: ['K1']
      },
      {
        id: 'M2', title: '边界与排错', purpose: '分析常见失效原因', recommended_minutes: 35,
        learning_outcomes: ['识别错误使用方式', '给出排查步骤'], evidence_refs: []
      }
    ]
  }
}

function validModule(id = 'M1') {
  return {
    id, title: id === 'M1' ? '响应式更新链路' : '边界与排错', purpose: '建立可用于排错和面试表达的知识结构',
    recommended_minutes: 40,
    learning_outcomes: ['说明核心工作过程', '使用具体场景解释边界'], evidence_refs: id === 'M1' ? ['K1'] : [],
    sections: [
      { type: 'explanation', title: '原理', content: longText('读取时收集依赖，写入时触发更新'), evidence_refs: id === 'M1' ? ['K1'] : [] },
      { type: 'example', title: '示例', content: longText('以组件读取状态并更新视图为例逐步推演'), evidence_refs: [] },
      { type: 'pitfall', title: '易错点', content: longText('错误解构可能破坏响应式连接，需要区分值与引用'), evidence_refs: [] },
      { type: 'interview_answer', title: '面试表达', content: longText('先给结论，再讲读取、收集、写入和触发'), evidence_refs: [] }
    ],
    self_checks: [
      { question: 'track 在什么时候执行？', expected_points: ['发生属性读取', '记录当前副作用'] },
      { question: 'trigger 如何找到更新目标？', expected_points: ['根据属性查找依赖', '调度对应副作用'] }
    ]
  }
}

function validPractice() {
  const levels = ['basic', 'understanding', 'application', 'interview', 'application', 'interview'] as const
  return {
    items: levels.map((level, index) => ({
      level,
      type: index < 2 ? 'short_answer' : index < 4 ? 'scenario' : 'mock_question',
      prompt: `第 ${index + 1} 题：请从不同角度分析 Vue 响应式链路。`,
      hints: ['先定位读取或写入阶段。'],
      answer_outline: '先给出结论，再按照 Proxy 拦截、track 收集、trigger 触发和组件更新的顺序展开；随后补充一个具体组件示例、常见误区、适用边界和排查方法。',
      reference_answer: longText('Vue 通过 Proxy 拦截读取与写入，在读取时由 track 建立依赖，在写入时由 trigger 找到并调度副作用'),
      follow_ups: ['如果发生嵌套对象更新，排查思路有什么变化？'],
      rubric: [
        { criterion: '准确性', description: '关键概念和调用顺序正确。', score: 5 },
        { criterion: '完整性', description: '包含机制、示例和边界。', score: 5 }
      ],
      module_ids: [index % 2 ? 'M2' : 'M1']
    })),
    completion_checklist: ['能脱稿说明完整链路', '能分析常见失效场景', '完成一道应用题', '完成一次模拟回答']
  }
}

test('课程蓝图要求目标、模块和练习覆盖关系完整', () => {
  assert.equal(validatePrepTaskBlueprint(validBlueprint()).modules.length, 2)
  const invalid = validBlueprint()
  invalid.coverage_map = invalid.coverage_map.slice(0, 1)
  assert.throws(() => validatePrepTaskBlueprint(invalid), /coverage_map/)
})

test('教学模块必须包含足够正文、解释和具体示例', () => {
  assert.equal(validatePrepLearningModule(validModule()).sections.length, 4)
  const shallow = validModule()
  shallow.sections[0].content = '过短'
  assert.throws(() => validatePrepLearningModule(shallow), /不能少于/)
})

test('分层练习覆盖四种难度并提供答案、追问和评分标准', () => {
  assert.equal(validatePrepTaskPracticeSet(validPractice(), new Set(['M1', 'M2'])).items.length, 6)
  const invalid = validPractice()
  invalid.items = invalid.items.map(item => item.level === 'interview' ? { ...item, level: 'basic' as const } : item)
  assert.throws(() => validatePrepTaskPracticeSet(invalid, new Set(['M1', 'M2'])), /缺少 interview/)
})

test('完整 v2 课程通过合约，建议时长不构成总量限制', () => {
  const blueprint = validBlueprint()
  const practice = validPractice()
  const guide = {
    version: 2,
    ...blueprint,
    modules: [validModule('M1'), validModule('M2')],
    practice_set: practice.items,
    completion_checklist: practice.completion_checklist,
    quality_review: { verdict: 'pass', repaired: false, issues: [] }
  }
  assert.equal(validatePrepTaskGuide(guide).modules.reduce((sum, item) => sum + item.recommended_minutes, 0), 80)
})

test('旧版简要指引可以转换为 v2 兼容视图', () => {
  const converted = normalizeStoredPrepTaskGuide({
    overview: '旧版指引', objectives: ['说明响应式原理'],
    steps: [{ title: '梳理原理', minutes: 15, instruction: '按读取和写入阶段梳理。' }],
    key_points: [], exercises: [], completion_checklist: ['能够说明原理']
  })
  assert.equal(converted.version, 2)
  assert.equal(converted.quality_review.verdict, 'warn')
  assert.equal(converted.practice_set.length, 6)
})
