<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import type {
  PrepExecutionTask, PrepTaskMessage, PrepTaskProgress, PrepTaskSession
} from '../types'
import RichText from './RichText.vue'

const props = defineProps<{ modelValue: boolean; task: PrepExecutionTask | null }>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'updated', task: PrepExecutionTask): void
}>()

const session = ref<PrepTaskSession | null>(null)
const loading = ref(false)
const startingGeneration = ref(false)
const savingProgress = ref(false)
const sending = ref(false)
const activeTab = ref('course')
const input = ref('')
const moduleProgress = ref<number[]>([])
const checkProgress = ref<number[]>([])
const openModules = ref<string[]>([])
const openPractices = ref<string[]>([])
const messageList = ref<HTMLElement | null>(null)
const retryRequest = ref<{ content: string; requestId: string } | null>(null)
let loadSequence = 0
let generationPollSequence = 0
let pendingProgress: (PrepTaskProgress & { done?: boolean }) | null = null

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})

const task = computed(() => session.value?.task ?? props.task)
const guide = computed(() => session.value?.guide ?? null)
const generation = computed(() => session.value?.generation ?? task.value?.generation ?? null)
const generationRunning = computed(() => generation.value?.status === 'running')
const generating = computed(() => startingGeneration.value || generationRunning.value)

const categoryLabel: Record<string, string> = {
  knowledge: '知识复习', project: '项目表达', coding: '编码练习',
  communication: '沟通表达', mock: '模拟面试'
}
const priorityLabel: Record<string, string> = { high: '高优先级', medium: '中优先级', low: '低优先级' }
const stageLabel: Record<string, string> = {
  queued: '准备生成', blueprint: '设计课程蓝图', modules: '编写教学模块',
  practice: '生成分层练习', review: '检查课程质量', repair: '修复薄弱内容',
  finalizing: '保存完整课程', completed: '生成完成', failed: '生成失败', interrupted: '生成中断'
}
const sectionLabel: Record<string, string> = {
  explanation: '原理讲解', example: '具体示例', comparison: '对比与取舍',
  pitfall: '常见错误', interview_answer: '面试表达', project_template: '项目模板',
  code_walkthrough: '代码与思路'
}
const levelLabel: Record<string, string> = {
  basic: '基础', understanding: '理解', application: '应用', interview: '面试'
}
const levelType: Record<string, 'info' | 'success' | 'warning' | 'danger'> = {
  basic: 'info', understanding: 'success', application: 'warning', interview: 'danger'
}
const practiceLabel: Record<string, string> = {
  short_answer: '知识问答', scenario: '场景分析', system_design: '系统设计',
  coding_exercise: '编码练习', project_story: '项目表达',
  behavioral_rehearsal: '沟通演练', mock_question: '模拟面试'
}

function accept(next: PrepTaskSession, notifyParent = true): void {
  session.value = next
  moduleProgress.value = [...next.progress.steps]
  checkProgress.value = [...next.progress.checks]
  if (next.guide && !openModules.value.length) openModules.value = [next.guide.modules[0]?.id].filter(Boolean)
  if (notifyParent) emit('updated', next.task)
}

function stopPolling(): void {
  generationPollSequence++
}

async function pollGeneration(sequence: number, announce: boolean): Promise<void> {
  let failures = 0
  while (sequence === generationPollSequence && props.modelValue && props.task?.id) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (sequence !== generationPollSequence || !props.modelValue || !props.task?.id) return
    try {
      const next = await api.get<PrepTaskSession>(`/prep-agent/plan-items/${props.task.id}/session`)
      failures = 0
      accept(next, false)
      if (next.generation.status === 'completed') {
        accept(next, true)
        activeTab.value = 'course'
        if (announce) ElMessage.success('完整执行课程已生成')
        return
      }
      if (next.generation.status === 'failed') {
        if (announce) ElMessage.error(next.generation.error || '执行课程生成失败')
        return
      }
    } catch (error) {
      failures++
      if (failures >= 3) {
        ElMessage.error((error as Error).message)
        return
      }
    }
  }
}

function startPolling(announce: boolean): Promise<void> {
  const sequence = ++generationPollSequence
  return pollGeneration(sequence, announce)
}

async function load(): Promise<void> {
  const id = props.task?.id
  if (!id) return
  const sequence = ++loadSequence
  loading.value = true
  let shouldPoll = false
  try {
    const next = await api.get<PrepTaskSession>(`/prep-agent/plan-items/${id}/session`)
    if (sequence === loadSequence) {
      accept(next, false)
      shouldPoll = next.generation.status === 'running'
    }
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    if (sequence === loadSequence) loading.value = false
  }
  if (shouldPoll && sequence === loadSequence) void startPolling(false)
}

async function generate(force = false): Promise<void> {
  if (!task.value || generating.value) return
  if (force) {
    try {
      await ElMessageBox.confirm(
        '新课程生成成功后会替换旧指引并清空旧进度和陪练对话；生成失败时仍保留旧内容。是否继续？',
        '重新生成完整课程', { type: 'warning' }
      )
    } catch { return }
  }
  startingGeneration.value = true
  try {
    const next = await api.post<PrepTaskSession>(`/prep-agent/plan-items/${task.value.id}/guide`, { force })
    accept(next, false)
    if (next.generation.status === 'running') await startPolling(true)
    else if (next.generation.status === 'completed') accept(next, true)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    startingGeneration.value = false
  }
}

async function flushProgress(): Promise<void> {
  if (!task.value || !guide.value || savingProgress.value) return
  savingProgress.value = true
  try {
    while (pendingProgress) {
      const body = pendingProgress
      pendingProgress = null
      const next = await api.patch<PrepTaskSession>(`/prep-agent/plan-items/${task.value.id}/progress`, body)
      accept(next)
      if (body.done !== undefined) ElMessage.success(body.done ? '已标记为完成' : '已恢复为未完成')
    }
  } catch (error) {
    pendingProgress = null
    ElMessage.error((error as Error).message)
    await load()
  } finally {
    savingProgress.value = false
    if (pendingProgress) void flushProgress()
  }
}

function saveProgress(done?: boolean): void {
  if (!task.value || !guide.value) return
  pendingProgress = {
    steps: [...moduleProgress.value], checks: [...checkProgress.value],
    ...(done === undefined ? {} : { done })
  }
  void flushProgress()
}

function toggleModule(index: number, checked: boolean): void {
  const values = new Set(moduleProgress.value)
  if (checked) values.add(index)
  else values.delete(index)
  moduleProgress.value = Array.from(values).sort((left, right) => left - right)
  saveProgress()
}

async function scrollMessages(): Promise<void> {
  await nextTick()
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight
}

function requestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `task-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function send(preset?: string): Promise<void> {
  if (!task.value || !guide.value || sending.value) return
  const content = (preset ?? input.value).trim()
  if (!content) return
  const id = retryRequest.value?.content === content ? retryRequest.value.requestId : requestId()
  input.value = ''
  const optimistic: PrepTaskMessage = { id: 0, role: 'user', content, request_id: id, created_at: '' }
  session.value?.messages.push(optimistic)
  sending.value = true
  await scrollMessages()
  try {
    const result = await api.post<{ message: PrepTaskMessage }>(`/prep-agent/plan-items/${task.value.id}/messages`, {
      content, request_id: id
    })
    retryRequest.value = null
    session.value?.messages.push(result.message)
  } catch (error) {
    if (session.value?.messages.at(-1) === optimistic) session.value.messages.pop()
    input.value = content
    retryRequest.value = { content, requestId: id }
    ElMessage.error((error as Error).message)
  } finally {
    sending.value = false
    await scrollMessages()
  }
}

watch([() => props.modelValue, () => props.task?.id] as const, ([open, taskId]) => {
  if (open && taskId) {
    activeTab.value = 'course'
    retryRequest.value = null
    openModules.value = []
    openPractices.value = []
    void load()
  } else if (!open) {
    loadSequence++
    stopPolling()
    pendingProgress = null
    session.value = null
  }
}, { immediate: true })

onBeforeUnmount(() => { loadSequence++; stopPolling() })
</script>

<template>
  <el-dialog v-model="visible" width="1080px" top="2vh" title="AI 准备任务工作区" destroy-on-close>
    <div v-loading="loading" class="task-workspace">
      <template v-if="task">
        <div class="task-head">
          <div>
            <h3>{{ task.title }}</h3>
            <div class="task-tags">
              <el-tag>{{ categoryLabel[task.category] || task.category }}</el-tag>
              <el-tag :type="task.priority === 'high' ? 'danger' : task.priority === 'medium' ? 'warning' : 'info'">
                {{ priorityLabel[task.priority] }}
              </el-tag>
              <el-tag type="info">建议 {{ task.estimated_minutes }} 分钟</el-tag>
              <el-tag v-if="task.done" type="success">已完成</el-tag>
              <el-tag v-if="guide" type="success">课程 v{{ guide.version }}</el-tag>
            </div>
          </div>
          <el-button v-if="guide" plain :loading="generating" :disabled="generationRunning" @click="generate(true)">
            重新生成完整课程
          </el-button>
        </div>
        <div class="task-context">
          <p><strong>安排理由：</strong>{{ task.reason }}</p>
          <p><strong>完成标准：</strong>{{ task.success_criteria }}</p>
        </div>

        <div v-if="generationRunning" class="generation-card">
          <div class="generation-title">
            <strong>{{ stageLabel[generation?.stage || 'queued'] || '正在生成完整课程' }}</strong>
            <span>模型调用 {{ generation?.model_calls || 0 }} 次 · Token {{ generation?.total_tokens || 0 }}</span>
          </div>
          <el-progress :percentage="generation?.progress || 1" :stroke-width="10" />
          <div class="muted">课程会在后台继续生成，可以关闭弹窗后稍后回来查看。</div>
        </div>
        <el-alert
          v-else-if="generation?.status === 'failed'"
          type="error" :closable="false" show-icon class="generation-error"
          :title="generation.error || '完整课程生成失败'"
        >
          <template #default>
            <el-button size="small" type="primary" @click="generate(Boolean(guide))">重新尝试</el-button>
          </template>
        </el-alert>

        <el-empty v-if="!guide && !generationRunning" description="生成完整课程后，可以按模块学习并完成分层练习">
          <el-button type="primary" :loading="generating" @click="generate(false)">生成完整执行课程</el-button>
        </el-empty>

        <el-tabs v-if="guide" v-model="activeTab" class="workspace-tabs">
          <el-tab-pane label="课程内容" name="course">
            <el-alert
              v-if="guide.quality_review.verdict === 'warn'"
              type="warning" :closable="false" show-icon class="quality-warning"
              title="这份课程仍有需要人工留意的内容"
            >
              <ul>
                <li v-for="issue in guide.quality_review.issues" :key="`${issue.code}-${issue.module_id}`">
                  {{ issue.message }}；建议：{{ issue.repair_instruction }}
                </li>
              </ul>
            </el-alert>

            <section class="guide-section course-overview">
              <h4>课程目标</h4>
              <RichText :content="guide.overview" />
              <div class="overview-grid">
                <div>
                  <strong>完成后你应该能够</strong>
                  <ul><li v-for="item in guide.objectives" :key="item">{{ item }}</li></ul>
                </div>
                <div>
                  <strong>前置知识</strong>
                  <ul v-if="guide.prerequisites.length"><li v-for="item in guide.prerequisites" :key="item">{{ item }}</li></ul>
                  <p v-else class="muted">没有额外前置要求</p>
                </div>
              </div>
            </section>

            <section class="guide-section">
              <h4>目标覆盖</h4>
              <div v-for="item in guide.coverage_map" :key="item.objective" class="coverage-row">
                <span>{{ item.objective }}</span>
                <div>
                  <el-tag v-for="id in item.module_ids" :key="id" size="small">{{ id }}</el-tag>
                  <el-tag v-for="level in item.practice_levels" :key="level" size="small" type="info">
                    {{ levelLabel[level] }}练习
                  </el-tag>
                </div>
              </div>
            </section>

            <section class="guide-section">
              <div class="section-heading">
                <h4>学习模块</h4>
                <span class="muted">已完成 {{ moduleProgress.length }}/{{ guide.modules.length }}</span>
              </div>
              <div v-for="(module, moduleIndex) in guide.modules" :key="module.id" class="course-module">
                <div class="module-meta">
                  <el-checkbox
                    :model-value="moduleProgress.includes(moduleIndex)"
                    @change="value => toggleModule(moduleIndex, Boolean(value))"
                  >学完本模块</el-checkbox>
                  <el-tag size="small" type="info">建议 {{ module.recommended_minutes }} 分钟</el-tag>
                </div>
                <el-collapse v-model="openModules">
                  <el-collapse-item :name="module.id">
                    <template #title>
                      <strong>{{ module.id }} · {{ module.title }}</strong>
                    </template>
                    <p class="module-purpose">{{ module.purpose }}</p>
                    <div class="learning-outcomes">
                      <strong>本节学习结果</strong>
                      <ul><li v-for="item in module.learning_outcomes" :key="item">{{ item }}</li></ul>
                    </div>
                    <article v-for="(section, index) in module.sections" :key="index" class="learning-section">
                      <div class="learning-section-title">
                        <el-tag size="small" effect="plain">{{ sectionLabel[section.type] || section.type }}</el-tag>
                        <strong>{{ section.title }}</strong>
                      </div>
                      <RichText :content="section.content" />
                      <div v-if="section.evidence_refs.length" class="evidence-refs">
                        <span>依据：</span>
                        <el-tag v-for="refName in section.evidence_refs" :key="refName" size="small">{{ refName }}</el-tag>
                      </div>
                    </article>
                    <div class="self-checks">
                      <strong>本节自测</strong>
                      <div v-for="(item, index) in module.self_checks" :key="index" class="self-check">
                        <p>{{ index + 1 }}. {{ item.question }}</p>
                        <details><summary>检查要点</summary><ul><li v-for="point in item.expected_points" :key="point">{{ point }}</li></ul></details>
                      </div>
                    </div>
                  </el-collapse-item>
                </el-collapse>
              </div>
            </section>
          </el-tab-pane>

          <el-tab-pane :label="`分层练习（${guide.practice_set.length}）`" name="practice">
            <section class="guide-section">
              <h4>从理解到面试表达</h4>
              <p class="muted">建议先独立作答，再逐步查看提示、答案结构和参考答案。</p>
              <el-collapse v-model="openPractices">
                <el-collapse-item
                  v-for="(exercise, index) in guide.practice_set"
                  :key="index" :name="String(index)" class="practice-item"
                >
                  <template #title>
                    <div class="practice-title">
                      <el-tag size="small" :type="levelType[exercise.level]">{{ levelLabel[exercise.level] }}</el-tag>
                      <el-tag size="small" effect="plain">{{ practiceLabel[exercise.type] || exercise.type }}</el-tag>
                      <strong>{{ index + 1 }}. {{ exercise.prompt }}</strong>
                    </div>
                  </template>
                  <div class="practice-body">
                    <div class="module-links">
                      <span>对应模块：</span><el-tag v-for="id in exercise.module_ids" :key="id" size="small">{{ id }}</el-tag>
                    </div>
                    <details><summary>分级提示</summary><ol><li v-for="hint in exercise.hints" :key="hint">{{ hint }}</li></ol></details>
                    <details><summary>答案结构</summary><RichText :content="exercise.answer_outline" /></details>
                    <details><summary>参考答案</summary><RichText :content="exercise.reference_answer" /></details>
                    <div class="practice-columns">
                      <div>
                        <strong>面试官可能追问</strong>
                        <ul><li v-for="item in exercise.follow_ups" :key="item">{{ item }}</li></ul>
                      </div>
                      <div>
                        <strong>评分标准</strong>
                        <ul><li v-for="item in exercise.rubric" :key="item.criterion"><b>{{ item.criterion }}（{{ item.score }}分）</b>：{{ item.description }}</li></ul>
                      </div>
                    </div>
                  </div>
                </el-collapse-item>
              </el-collapse>
            </section>

            <section class="guide-section completion-section">
              <h4>完成前自检</h4>
              <el-checkbox-group v-model="checkProgress" class="completion-checks" @change="saveProgress()">
                <el-checkbox v-for="(item, index) in guide.completion_checklist" :key="index" :value="index">{{ item }}</el-checkbox>
              </el-checkbox-group>
            </section>
          </el-tab-pane>

          <el-tab-pane label="AI 讲解与陪练" name="coach">
            <div class="quick-actions">
              <el-button size="small" @click="send('请结合课程内容，讲解最关键、最容易答错的部分，并给一个具体例子。')">重点讲解</el-button>
              <el-button size="small" @click="send('现在开始模拟面试。请从课程的 interview 级练习中一次只问一个问题，等我回答后按 rubric 点评并追问。')">开始模拟</el-button>
              <el-button size="small" @click="send('请根据完成标准给我一个可填写的作答结构；涉及个人项目的事实请保留占位符。')">作答模板</el-button>
              <el-button size="small" @click="input = '这是我的回答：\n\n请按课程评分标准逐项点评，并给出改进版表达。'">点评回答</el-button>
            </div>
            <div ref="messageList" class="coach-messages">
              <el-empty v-if="!session?.messages.length" :image-size="55" description="可以让 AI 讲解、模拟提问或点评你的回答" />
              <div v-for="message in session?.messages" :key="message.id || `${message.role}-${message.content}`" :class="['coach-message', message.role]">
                <RichText v-if="message.role === 'assistant'" :content="message.content" compact />
                <div v-else>{{ message.content }}</div>
              </div>
              <div v-if="sending" class="coach-message assistant">思考中…</div>
            </div>
            <div class="coach-input">
              <el-input
                v-model="input" type="textarea" :rows="4" maxlength="5000" show-word-limit
                placeholder="回答模拟题、粘贴项目表达，或继续追问。Ctrl+Enter 发送"
                @keydown.ctrl.enter.prevent="send()"
              />
              <el-button type="primary" :loading="sending" @click="send()">发送</el-button>
            </div>
          </el-tab-pane>
        </el-tabs>

        <div v-if="guide" class="footer-actions">
          <el-button @click="visible = false">关闭</el-button>
          <el-button
            :type="task.done ? 'default' : 'success'" :loading="savingProgress"
            @click="saveProgress(!task.done)"
          >{{ task.done ? '恢复为未完成' : '标记这项任务完成' }}</el-button>
        </div>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.task-workspace { min-height: 300px; }
.task-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }
.task-head h3 { margin: 0 0 9px; font-size: 19px; }
.task-tags { display: flex; flex-wrap: wrap; gap: 6px; }
.task-context { margin: 14px 0; padding: 10px 14px; border-radius: 8px; background: #f7f9fc; color: #606266; }
.task-context p { margin: 4px 0; }
.muted { color: #909399; font-size: 12px; }
.generation-card { margin: 12px 0; padding: 13px 15px; border: 1px solid #c6e2ff; border-radius: 9px; background: #f5f9ff; }
.generation-title { display: flex; justify-content: space-between; margin-bottom: 9px; }
.generation-title span { color: #909399; font-size: 12px; }
.generation-error, .quality-warning { margin: 12px 0; }
.quality-warning ul { margin: 5px 0; padding-left: 20px; }
.workspace-tabs { margin-top: 10px; }
.guide-section { margin-bottom: 24px; }
.guide-section h4 { margin: 0 0 10px; font-size: 17px; }
.course-overview { padding: 15px; border-radius: 9px; background: #f7f9fc; }
.overview-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 14px; }
.overview-grid ul, .guide-section ul { margin: 7px 0; padding-left: 22px; }
.coverage-row { display: grid; grid-template-columns: minmax(260px, 1fr) 1fr; gap: 12px; padding: 9px 11px; border-bottom: 1px solid #ebeef5; }
.coverage-row > div { display: flex; flex-wrap: wrap; gap: 5px; }
.section-heading { display: flex; justify-content: space-between; align-items: center; }
.course-module { margin-bottom: 12px; padding: 10px 13px; border: 1px solid #dcdfe6; border-radius: 9px; }
.module-meta { display: flex; justify-content: flex-end; align-items: center; gap: 10px; margin-bottom: 3px; }
.module-purpose { color: #606266; }
.learning-outcomes { padding: 10px 12px; border-left: 3px solid #409eff; background: #f5f9ff; }
.learning-section { margin: 15px 0; padding: 14px; border: 1px solid #ebeef5; border-radius: 8px; }
.learning-section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 9px; }
.evidence-refs, .module-links { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; margin-top: 9px; color: #909399; }
.self-checks { padding: 13px; border-radius: 8px; background: #fafafa; }
.self-check { margin-top: 10px; }
.self-check p { margin: 5px 0; font-weight: 600; }
.self-check details, .practice-body details { margin: 7px 0; padding: 8px 10px; border-radius: 6px; background: #f7f9fc; }
.self-check summary, .practice-body summary { cursor: pointer; color: #409eff; }
.practice-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.practice-title strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.practice-body { padding: 5px 8px 14px; }
.practice-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; margin-top: 12px; }
.practice-columns ul { padding-left: 20px; }
.completion-section { padding: 14px; border-radius: 8px; background: #f7f9fc; }
.completion-checks { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.quick-actions { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
.coach-messages { height: 390px; overflow-y: auto; padding: 12px; border: 1px solid #ebeef5; border-radius: 8px; background: #fafafa; }
.coach-message { width: fit-content; max-width: 82%; margin-bottom: 10px; padding: 9px 12px; border-radius: 10px; }
.coach-message.user { margin-left: auto; color: white; background: #409eff; white-space: pre-wrap; }
.coach-message.assistant { background: white; border: 1px solid #e4e7ed; }
.coach-input { display: flex; align-items: flex-end; gap: 8px; margin-top: 10px; }
.footer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
@media (max-width: 900px) {
  .overview-grid, .practice-columns { grid-template-columns: 1fr; }
  .coverage-row { grid-template-columns: 1fr; }
}
</style>
