<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { bumpData } from '../store'
import type { Interview, PrepAgentEvidence, PrepAgentRun, PrepPlanItem } from '../types'

const props = defineProps<{
  modelValue: boolean
  applicationId: number
  interview: Interview | null
}>()
const emit = defineEmits<{
  (event: 'update:modelValue', value: boolean): void
  (event: 'completed'): void
}>()

const run = ref<PrepAgentRun | null>(null)
const loading = ref(false)
const starting = ref(false)
const submitting = ref(false)
const form = reactive({ availableMinutes: 240, focusText: '', goal: '' })
const editableSummary = ref('')
const editableItems = ref<PrepPlanItem[]>([])
const revisionFeedback = ref('')
const loadedPlanRun = ref('')
let source: EventSource | null = null
let completedNotified = ''

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})

const terminal = computed(() => run.value && ['completed', 'failed', 'cancelled'].includes(run.value.status))
const waitingReview = computed(() => run.value?.status === 'waiting_review')
const totalMinutes = computed(() => editableItems.value.reduce((sum, item) => sum + Number(item.estimated_minutes || 0), 0))
const overBudget = computed(() => totalMinutes.value > (run.value?.constraints.available_minutes ?? form.availableMinutes))
const evidenceByRef = computed(() => new Map((run.value?.evidence ?? []).map(item => [item.ref, item])))

const stageLabels: Record<string, string> = {
  validate_request: '校验运行参数',
  load_context: '读取岗位和历史资料',
  extract_role_profile: '提取岗位能力画像',
  plan_retrieval_queries: '规划知识检索',
  retrieve_evidence: '检索相关面经和知识',
  analyze_gaps: '分析能力差距',
  draft_plan: '生成准备计划',
  critic_plan: '检查计划质量',
  revise_plan: '修订准备计划',
  human_review: '等待人工确认',
  persist_plan: '写入准备清单',
  finalize: '已完成'
}

const categoryOptions = [
  { value: 'knowledge', label: '知识复习' },
  { value: 'project', label: '项目表达' },
  { value: 'coding', label: '编码练习' },
  { value: 'communication', label: '沟通表达' },
  { value: 'mock', label: '模拟面试' }
] as const

function closeSource(): void {
  source?.close()
  source = null
}

function syncEditable(next: PrepAgentRun): void {
  if (next.status !== 'waiting_review' || !next.plan || loadedPlanRun.value === `${next.id}:${next.updated_at}`) return
  editableSummary.value = next.plan.summary
  editableItems.value = next.plan.items.map(item => ({ ...item, evidence_refs: [...item.evidence_refs] }))
  loadedPlanRun.value = `${next.id}:${next.updated_at}`
}

function acceptRun(next: PrepAgentRun): void {
  run.value = next
  syncEditable(next)
  if (next.status === 'completed' && completedNotified !== next.id) {
    completedNotified = next.id
    bumpData()
    emit('completed')
    ElMessage.success('AI 准备计划已写入面试清单')
  }
}

function watchRun(runId: string): void {
  closeSource()
  source = new EventSource(`/api/prep-agent/runs/${encodeURIComponent(runId)}/events`)
  source.addEventListener('run', event => {
    try {
      const next = JSON.parse((event as MessageEvent).data) as PrepAgentRun
      acceptRun(next)
      if (['completed', 'failed', 'cancelled'].includes(next.status)) closeSource()
    } catch {
      /* 下一次事件会重新同步完整状态 */
    }
  })
  source.onerror = () => {
    closeSource()
    void refreshRun()
  }
}

async function refreshRun(): Promise<void> {
  if (!run.value) return
  try {
    const next = await api.get<PrepAgentRun>(`/prep-agent/runs/${run.value.id}`)
    acceptRun(next)
    if (!['completed', 'failed', 'cancelled'].includes(next.status)) watchRun(next.id)
  } catch {
    /* 保留当前可见状态 */
  }
}

async function loadLatest(): Promise<void> {
  if (!props.interview) return
  loading.value = true
  closeSource()
  try {
    const rows = await api.get<PrepAgentRun[]>(`/prep-agent/interviews/${props.interview.id}/runs?limit=1`)
    if (rows[0] && !['failed', 'cancelled'].includes(rows[0].status)) {
      const detail = await api.get<PrepAgentRun>(`/prep-agent/runs/${rows[0].id}`)
      acceptRun(detail)
      if (!['completed', 'failed', 'cancelled'].includes(detail.status)) watchRun(detail.id)
    } else {
      resetForNewRun()
    }
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

function resetForNewRun(): void {
  closeSource()
  run.value = null
  editableSummary.value = ''
  editableItems.value = []
  revisionFeedback.value = ''
  loadedPlanRun.value = ''
  form.availableMinutes = 240
  form.focusText = ''
  form.goal = props.interview ? `准备 ${props.interview.round}` : ''
}

function requestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `prep-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function startRun(): Promise<void> {
  if (!props.interview) return
  starting.value = true
  try {
    const focus = form.focusText.split(/[，,\n]/).map(item => item.trim()).filter(Boolean).slice(0, 8)
    const next = await api.post<PrepAgentRun>('/prep-agent/runs', {
      application_id: props.applicationId,
      interview_id: props.interview.id,
      goal: form.goal.trim() || `准备 ${props.interview.round}`,
      constraints: { available_minutes: form.availableMinutes, focus },
      request_id: requestId()
    })
    acceptRun(next)
    watchRun(next.id)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    starting.value = false
  }
}

function removeItem(index: number): void {
  if (editableItems.value.length <= 1) {
    ElMessage.warning('计划至少保留一项任务')
    return
  }
  editableItems.value.splice(index, 1)
}

function addItem(): void {
  if (editableItems.value.length >= 12) return
  editableItems.value.push({
    title: '', category: 'knowledge', priority: 'medium', estimated_minutes: 30,
    reason: '用户补充', evidence_refs: [], success_criteria: ''
  })
}

async function submitDecision(action: 'edit' | 'revise' | 'cancel'): Promise<void> {
  if (!run.value) return
  if (action === 'edit') {
    if (overBudget.value) {
      ElMessage.warning('计划总时间超过预算，请先调整')
      return
    }
    if (editableItems.value.some(item => !item.title.trim() || !item.success_criteria.trim())) {
      ElMessage.warning('每项任务都需要标题和完成标准')
      return
    }
  }
  if (action === 'revise' && !revisionFeedback.value.trim()) {
    ElMessage.warning('请填写希望如何修改计划')
    return
  }
  submitting.value = true
  try {
    const body = action === 'edit'
      ? { action, edited_plan: { summary: editableSummary.value.trim() || '面试准备计划', items: editableItems.value } }
      : action === 'revise'
        ? { action, feedback: revisionFeedback.value.trim() }
        : { action }
    const endpoint = action === 'cancel'
      ? `/prep-agent/runs/${run.value.id}/cancel`
      : `/prep-agent/runs/${run.value.id}/resume`
    const next = await api.post<PrepAgentRun>(endpoint, body)
    revisionFeedback.value = ''
    acceptRun(next)
    if (!['completed', 'failed', 'cancelled'].includes(next.status)) watchRun(next.id)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    submitting.value = false
  }
}

function evidence(ref: string): PrepAgentEvidence | undefined {
  return evidenceByRef.value.get(ref)
}

watch(() => [props.modelValue, props.interview?.id] as const, ([open]) => {
  if (open) void loadLatest()
  else closeSource()
}, { immediate: true })

onBeforeUnmount(closeSource)
</script>

<template>
  <el-dialog v-model="visible" width="860px" top="5vh" title="AI 面试准备计划" destroy-on-close>
    <div v-loading="loading" class="prep-agent">
      <template v-if="!run">
        <el-alert type="info" :closable="false" show-icon>
          Agent 会读取当前岗位、历史复盘和本地知识库。生成结果只有在你确认后才会写入准备清单。
        </el-alert>
        <el-form label-position="top" class="start-form">
          <el-form-item label="准备目标">
            <el-input v-model="form.goal" maxlength="500" placeholder="例如：准备后天的一面，重点强化项目表达" />
          </el-form-item>
          <div class="form-row">
            <el-form-item label="可用时间（分钟）">
              <el-input-number v-model="form.availableMinutes" :min="30" :max="2880" :step="30" />
            </el-form-item>
            <el-form-item label="重点方向（逗号分隔）" class="focus-field">
              <el-input v-model="form.focusText" placeholder="前端基础，项目表达，算法" />
            </el-form-item>
          </div>
        </el-form>
        <div class="footer-actions">
          <el-button @click="visible = false">取消</el-button>
          <el-button type="primary" :loading="starting" @click="startRun">开始生成</el-button>
        </div>
      </template>

      <template v-else>
        <div class="run-head">
          <div>
            <strong>{{ stageLabels[run.current_node || ''] || '准备中' }}</strong>
            <div class="muted">模型调用 {{ run.model_calls }} 次 · Token {{ run.total_tokens }}</div>
          </div>
          <el-tag v-if="run.status === 'waiting_review'" type="warning">等待确认</el-tag>
          <el-tag v-else-if="run.status === 'completed'" type="success">已写入</el-tag>
          <el-tag v-else-if="run.status === 'failed'" type="danger">失败</el-tag>
          <el-tag v-else-if="run.status === 'cancelled'" type="info">已取消</el-tag>
          <el-tag v-else>运行中</el-tag>
        </div>

        <div v-if="run.steps?.length" class="steps">
          <div v-for="step in run.steps" :key="step.id" class="step">
            <span :class="['step-dot', step.status]" />
            <span>{{ stageLabels[step.node] || step.node }}</span>
            <span class="muted">{{ step.summary }}</span>
            <span v-if="step.duration_ms != null" class="muted">{{ step.duration_ms }}ms</span>
          </div>
        </div>

        <el-alert
          v-for="warning in run.warnings"
          :key="warning"
          type="warning"
          :title="warning"
          :closable="false"
          show-icon
          class="warning"
        />

        <template v-if="waitingReview">
          <div class="budget" :class="{ exceeded: overBudget }">
            计划 {{ totalMinutes }} 分钟 / 预算 {{ run.constraints.available_minutes }} 分钟
          </div>
          <el-input v-model="editableSummary" type="textarea" :rows="2" maxlength="1000" class="summary-input" />

          <div v-for="(item, index) in editableItems" :key="index" class="plan-item">
            <div class="plan-item-head">
              <span class="item-index">{{ index + 1 }}</span>
              <el-input v-model="item.title" maxlength="160" placeholder="准备任务" />
              <el-select v-model="item.priority" style="width: 92px">
                <el-option label="高" value="high" />
                <el-option label="中" value="medium" />
                <el-option label="低" value="low" />
              </el-select>
              <el-input-number v-model="item.estimated_minutes" :min="5" :max="480" :step="5" controls-position="right" />
              <span class="minutes">分钟</span>
              <el-button link type="danger" @click="removeItem(index)">删除</el-button>
            </div>
            <div class="plan-meta">
              <el-select v-model="item.category" style="width: 120px">
                <el-option v-for="option in categoryOptions" :key="option.value" :label="option.label" :value="option.value" />
              </el-select>
              <el-input v-model="item.reason" maxlength="600" placeholder="安排理由" />
            </div>
            <el-input v-model="item.success_criteria" maxlength="500" placeholder="完成标准" />
            <div v-if="item.evidence_refs.length" class="refs">
              <span>依据：</span>
              <template v-for="refName in item.evidence_refs" :key="refName">
                <a
                  v-if="evidence(refName)?.source_id"
                  :href="`/learn/knowledge/${evidence(refName)?.source_id}`"
                  target="_blank"
                >{{ refName }} · {{ evidence(refName)?.title }}</a>
                <el-tag v-else size="small">{{ refName }}</el-tag>
              </template>
            </div>
          </div>
          <el-button v-if="editableItems.length < 12" plain size="small" @click="addItem">+ 补充任务</el-button>

          <div class="revision">
            <el-input v-model="revisionFeedback" maxlength="1000" placeholder="如果希望重新生成，请说明修改要求" />
            <el-button :loading="submitting" @click="submitDecision('revise')">按要求修订</el-button>
          </div>
          <div class="footer-actions">
            <el-button :loading="submitting" @click="submitDecision('cancel')">取消本次运行</el-button>
            <el-button type="primary" :loading="submitting" :disabled="overBudget" @click="submitDecision('edit')">
              确认并写入清单
            </el-button>
          </div>
        </template>

        <template v-else-if="run.status === 'completed'">
          <el-result icon="success" title="准备计划已写入" sub-title="可以在当前面试卡片的准备清单中逐项完成" />
          <div class="footer-actions">
            <el-button @click="resetForNewRun">再生成一份</el-button>
            <el-button type="primary" @click="visible = false">关闭</el-button>
          </div>
        </template>

        <template v-else-if="run.status === 'failed' || run.status === 'cancelled'">
          <el-result :icon="run.status === 'failed' ? 'error' : 'info'" :title="run.status === 'failed' ? '生成失败' : '运行已取消'">
            <template #sub-title>{{ run.error_message || '本次运行没有写入准备清单' }}</template>
          </el-result>
          <div class="footer-actions">
            <el-button @click="visible = false">关闭</el-button>
            <el-button type="primary" @click="resetForNewRun">重新生成</el-button>
          </div>
        </template>

        <template v-else>
          <el-skeleton :rows="5" animated class="running-skeleton" />
          <div class="footer-actions">
            <el-button :loading="submitting" @click="submitDecision('cancel')">取消运行</el-button>
          </div>
        </template>
      </template>
    </div>
  </el-dialog>
</template>

<style scoped>
.prep-agent { min-height: 180px; }
.start-form { margin-top: 18px; }
.form-row { display: flex; gap: 18px; }
.focus-field { flex: 1; }
.footer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.run-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.muted { color: #909399; font-size: 12px; }
.steps { background: #f7f9fc; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; max-height: 180px; overflow: auto; }
.step { display: grid; grid-template-columns: 10px minmax(150px, auto) 1fr auto; align-items: center; gap: 8px; min-height: 26px; font-size: 13px; }
.step-dot { width: 8px; height: 8px; border-radius: 50%; background: #909399; }
.step-dot.completed { background: #67c23a; }
.step-dot.failed { background: #f56c6c; }
.step-dot.running { background: #409eff; }
.warning { margin: 8px 0; }
.budget { margin: 14px 0 8px; font-weight: 600; color: #409eff; }
.budget.exceeded { color: #f56c6c; }
.summary-input { margin-bottom: 10px; }
.plan-item { border: 1px solid #e4e7ed; border-radius: 9px; padding: 10px; margin-bottom: 10px; background: #fff; }
.plan-item-head { display: flex; align-items: center; gap: 7px; }
.item-index { width: 24px; height: 24px; border-radius: 50%; background: #ecf5ff; color: #409eff; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.minutes { color: #909399; font-size: 12px; white-space: nowrap; }
.plan-meta { display: flex; gap: 8px; margin: 8px 0; }
.refs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: #909399; font-size: 12px; }
.refs a { color: #409eff; text-decoration: none; }
.revision { display: flex; gap: 8px; margin-top: 14px; }
.running-skeleton { margin-top: 18px; }
</style>
