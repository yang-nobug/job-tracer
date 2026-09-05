<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { bumpData } from '../store'
import type { Interview, PrepAgentEvidence, PrepAgentReference, PrepAgentRun, PrepPlanItem, ProjectArchiveSummary, Resume } from '../types'

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
const form = reactive({ focusText: '', goal: '', projectIds: [] as number[], resumeId: null as number | null })
const availableProjects = ref<ProjectArchiveSummary[]>([])
const availableResumes = ref<Resume[]>([])
const editableSummary = ref('')
const editableItems = ref<PrepPlanItem[]>([])
const revisionFeedback = ref('')
const loadedPlanRun = ref('')
const historyRuns = ref<PrepAgentRun[]>([])
const selectedHistoryRunId = ref('')
const references = ref<PrepAgentReference[]>([])
const referencesForRun = ref('')
const selectedReference = ref<PrepAgentReference | null>(null)
const referenceOpen = ref(false)
let source: EventSource | null = null
let completedNotified = ''

const visible = computed({
  get: () => props.modelValue,
  set: value => emit('update:modelValue', value)
})

const terminal = computed(() => run.value && ['completed', 'failed', 'cancelled'].includes(run.value.status))
const waitingReview = computed(() => run.value?.status === 'waiting_review')
const totalMinutes = computed(() => editableItems.value.reduce((sum, item) => sum + Number(item.estimated_minutes || 0), 0))
const evidenceByRef = computed(() => new Map((run.value?.evidence ?? []).map(item => [item.ref, item])))
const codeEvidence = computed(() => (run.value?.evidence ?? []).filter(item => item.ref.startsWith('CE')))

const stageLabels: Record<string, string> = {
  validate_request: '校验运行参数',
  load_context: '读取岗位和历史资料',
  extract_role_profile: '提取岗位能力画像',
  read_code_evidence: '按岗位重点读取项目代码',
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
  if (referencesForRun.value !== next.id) void loadReferences(next.id)
  if (next.status === 'completed' && completedNotified !== next.id) {
    completedNotified = next.id
    bumpData()
    emit('completed')
    ElMessage.success('AI 准备计划已写入面试清单')
  }
}

async function loadReferences(runId: string): Promise<void> {
  try {
    references.value = await api.get<PrepAgentReference[]>(`/prep-agent/runs/${runId}/references`)
    referencesForRun.value = runId
  } catch {
    // 引用加载失败不影响计划本身；下次运行状态刷新会再尝试。
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
    const rows = await api.get<PrepAgentRun[]>(`/prep-agent/interviews/${props.interview.id}/runs?limit=10`)
    historyRuns.value = rows
    selectedHistoryRunId.value = rows[0]?.id || ''
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
  try {
    availableProjects.value = await api.get<ProjectArchiveSummary[]>('/projects')
  } catch {
    availableProjects.value = []
  }
  try {
    const resumes = await api.get<Resume[]>('/resumes')
    availableResumes.value = resumes.filter(item => item.extraction_status === 'completed' && Boolean(item.text_available))
  } catch {
    availableResumes.value = []
  }
}

function historyLabel(item: PrepAgentRun): string {
  const time = item.created_at.replace('T', ' ').slice(0, 16)
  const status = item.status === 'completed' ? '已写入' : item.status === 'waiting_review' ? '待确认'
    : item.status === 'failed' ? '失败' : item.status === 'cancelled' ? '已取消' : '进行中'
  return `${time} · ${status} · ${item.goal.slice(0, 26)}`
}

async function selectHistoryRun(runId: string): Promise<void> {
  if (!runId || runId === run.value?.id) return
  loading.value = true
  closeSource()
  try {
    const detail = await api.get<PrepAgentRun>(`/prep-agent/runs/${runId}`)
    acceptRun(detail)
    if (!['completed', 'failed', 'cancelled'].includes(detail.status)) watchRun(detail.id)
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
  references.value = []
  referencesForRun.value = ''
  form.focusText = ''
  form.goal = props.interview ? `准备 ${props.interview.round}` : ''
  form.projectIds = []
}

function requestId(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `prep-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function startRun(): Promise<void> {
  if (!props.interview) return
  if (props.interview.done) {
    ElMessage.info('该面试已完成，请在复盘中记录收获后再进行针对性补强')
    return
  }
  starting.value = true
  try {
    const focus = form.focusText.split(/[，,\n]/).map(item => item.trim()).filter(Boolean).slice(0, 8)
    const next = await api.post<PrepAgentRun>('/prep-agent/runs', {
      application_id: props.applicationId,
      interview_id: props.interview.id,
      goal: form.goal.trim() || `准备 ${props.interview.round}`,
      constraints: { focus, project_ids: form.projectIds.slice(0, 2), resume_id: form.resumeId },
      request_id: requestId()
    })
    historyRuns.value = [next, ...historyRuns.value.filter(item => item.id !== next.id)].slice(0, 10)
    selectedHistoryRunId.value = next.id
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

function reference(ref: string): PrepAgentReference | undefined {
  return references.value.find(item => item.ref === ref)
}

function evidenceLabel(ref: string): string {
  if (ref === 'APP') return '当前投递'
  if (ref === 'IV') return '当前面试'
  const item = reference(ref) ?? evidence(ref)
  return item ? `${ref} · ${item.title}` : ref
}

function showReference(ref: string): void {
  const item = reference(ref)
  if (!item) {
    ElMessage.info(`引用 ${ref} 的原文暂不可用`)
    return
  }
  selectedReference.value = item
  referenceOpen.value = true
}

function openReferenceSource(): void {
  if (selectedReference.value?.source_id) window.open(`/#/learn/knowledge/${selectedReference.value.source_id}`, '_blank', 'noopener')
}

const hasAnalysis = computed(() => Boolean(
  run.value?.role_profile || run.value?.gap_analysis || run.value?.critic
))

const levelLabels: Record<string, string> = {
  unknown: '尚无依据', weak: '待补强', developing: '正在形成', ready: '已有基础',
  review: '需要复习', practice: '需要练习', interview_ready: '面试可用'
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
        <el-alert v-if="interview?.done" type="info" :closable="false" show-icon title="该面试已完成">
          建议先在复盘中记录题目、表现与改进点；当前入口不会再生成面试前准备计划。
        </el-alert>
        <el-alert type="info" :closable="false" show-icon>
          Agent 会读取当前岗位、历史复盘和本地知识库。生成结果只有在你确认后才会写入准备清单。
        </el-alert>
        <div v-if="historyRuns.length" class="history-picker">
          <span class="muted">历史准备计划</span>
          <el-select v-model="selectedHistoryRunId" placeholder="选择历史运行" @change="selectHistoryRun">
            <el-option v-for="item in historyRuns" :key="item.id" :label="historyLabel(item)" :value="item.id" />
          </el-select>
        </div>
        <el-form label-position="top" class="start-form">
          <el-form-item label="准备目标">
            <el-input v-model="form.goal" maxlength="500" placeholder="例如：准备后天的一面，重点强化项目表达" />
          </el-form-item>
          <el-form-item label="重点方向（逗号分隔，可选）" class="focus-field">
            <el-input v-model="form.focusText" placeholder="前端基础，项目表达，算法" />
          </el-form-item>
          <el-form-item v-if="availableProjects.length" label="关联项目（可选，最多 2 个）" class="project-field">
            <el-select v-model="form.projectIds" multiple collapse-tags :max-collapse-tags="2" :multiple-limit="2" placeholder="选择后，Agent 会按岗位重点只读调查代码">
              <el-option v-for="project in availableProjects" :key="project.id" :label="project.name" :value="project.id" />
            </el-select>
            <div class="field-tip">代码 Agent 只读取必要片段，返回项目证据供准备计划、项目话术和追问使用。</div>
          </el-form-item>
          <el-form-item v-if="availableResumes.length" label="简历版本（可选）" class="project-field">
            <el-select v-model="form.resumeId" clearable placeholder="选择本次要参考的简历版本">
              <el-option v-for="resume in availableResumes" :key="resume.id" :label="resume.note ? `${resume.filename} · ${resume.note}` : resume.filename" :value="resume.id" />
            </el-select>
            <div class="field-tip">简历是全局版本资料，不要求当前投递曾绑定它。Agent 仅将所选简历作为 RES 证据核对项目表述，不把它当作源码或个人贡献证明。</div>
          </el-form-item>
          <div v-else class="field-tip">没有可用的简历文本。请在投递表单的简历选择器上传 PDF/DOCX，并点击“提取文字”。</div>
        </el-form>
        <div class="footer-actions">
          <el-button @click="visible = false">取消</el-button>
          <el-button type="primary" :disabled="Boolean(interview?.done)" :loading="starting" @click="startRun">开始生成</el-button>
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

        <div v-if="historyRuns.length > 1" class="history-picker">
          <span class="muted">查看历史运行</span>
          <el-select v-model="selectedHistoryRunId" placeholder="选择运行" @change="selectHistoryRun">
            <el-option v-for="item in historyRuns" :key="item.id" :label="historyLabel(item)" :value="item.id" />
          </el-select>
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

        <el-collapse v-if="hasAnalysis" class="analysis-panel">
          <el-collapse-item v-if="run.role_profile" name="profile">
            <template #title>
              <span class="analysis-title">岗位能力画像</span>
              <span class="muted">基于 JD 与当前面试资料</span>
            </template>
            <div class="analysis-grid">
              <section v-for="section in [
                { key: 'responsibilities', label: '核心职责', values: run.role_profile.responsibilities },
                { key: 'must_have_skills', label: '必备能力', values: run.role_profile.must_have_skills },
                { key: 'nice_to_have_skills', label: '加分项', values: run.role_profile.nice_to_have_skills },
                { key: 'project_signals', label: '项目考察信号', values: run.role_profile.project_signals }
              ]" :key="section.key" class="analysis-section">
                <h4>{{ section.label }}</h4>
                <div v-if="section.values.length" class="statement-list">
                  <div v-for="(item, index) in section.values" :key="index" class="statement">
                    <span>{{ item.text }}</span>
                    <span class="confidence">置信度 {{ Math.round(item.confidence * 100) }}%</span>
                    <div v-if="item.source_refs.length" class="refs compact">
                      <template v-for="refName in item.source_refs" :key="refName">
                        <el-button link type="primary" size="small" @click="showReference(refName)">{{ evidenceLabel(refName) }}</el-button>
                      </template>
                    </div>
                  </div>
                </div>
                <span v-else class="muted">未识别到</span>
              </section>
            </div>
            <section v-if="run.role_profile.likely_interview_topics.length" class="analysis-section full-width">
              <h4>高概率考察主题</h4>
              <el-tag v-for="topic in run.role_profile.likely_interview_topics" :key="topic" class="topic-tag">{{ topic }}</el-tag>
            </section>
            <el-alert v-for="item in run.role_profile.unknowns" :key="item" type="info" :title="item" :closable="false" class="analysis-alert" />
          </el-collapse-item>

          <el-collapse-item v-if="run.gap_analysis" name="gaps">
            <template #title>
              <span class="analysis-title">能力差距与已有优势</span>
              <span class="muted">结合历史复盘、掌握度和检索资料</span>
            </template>
            <div class="gap-columns">
              <section class="analysis-section">
                <h4>优先补强</h4>
                <div v-if="run.gap_analysis.gaps.length" class="gap-list">
                  <article v-for="item in run.gap_analysis.gaps" :key="`${item.skill}-${item.reason}`" class="gap-card gap-card--weak">
                    <div><strong>{{ item.skill }}</strong><span class="level">{{ levelLabels[item.current_level] }} → {{ levelLabels[item.target_level] }}</span></div>
                    <p>{{ item.reason }}</p>
                    <div class="refs compact"><el-button v-for="refName in item.evidence_refs" :key="refName" link type="primary" size="small" @click="showReference(refName)">{{ evidenceLabel(refName) }}</el-button></div>
                  </article>
                </div>
                <span v-else class="muted">没有识别出明确短板</span>
              </section>
              <section class="analysis-section">
                <h4>可直接利用的优势</h4>
                <div v-if="run.gap_analysis.strengths.length" class="gap-list">
                  <article v-for="item in run.gap_analysis.strengths" :key="`${item.skill}-${item.reason}`" class="gap-card gap-card--strength">
                    <div><strong>{{ item.skill }}</strong><span class="level">{{ levelLabels[item.current_level] }} → {{ levelLabels[item.target_level] }}</span></div>
                    <p>{{ item.reason }}</p>
                    <div class="refs compact"><el-button v-for="refName in item.evidence_refs" :key="refName" link type="primary" size="small" @click="showReference(refName)">{{ evidenceLabel(refName) }}</el-button></div>
                  </article>
                </div>
                <span v-else class="muted">暂无可确认的优势证据</span>
              </section>
            </div>
            <el-alert v-for="warning in run.gap_analysis.warnings" :key="warning" type="warning" :title="warning" :closable="false" class="analysis-alert" />
          </el-collapse-item>

          <el-collapse-item v-if="codeEvidence.length" name="code-evidence">
            <template #title>
              <span class="analysis-title">项目代码证据</span>
              <span class="muted">由读代码 Agent 按当前岗位重点调查</span>
            </template>
            <div class="code-evidence-list">
              <article v-for="item in codeEvidence" :key="item.ref" class="code-evidence-card">
                <div><el-tag type="success" size="small">{{ item.ref }}</el-tag><strong>{{ item.title }}</strong></div>
                <p>{{ item.excerpt }}</p>
                <el-button link type="primary" size="small" @click="showReference(item.ref)">查看路径、行号与原始片段</el-button>
              </article>
            </div>
          </el-collapse-item>

          <el-collapse-item v-if="run.critic" name="critic">
            <template #title>
              <span class="analysis-title">计划审查</span>
              <el-tag :type="run.critic.verdict === 'pass' ? 'success' : run.critic.verdict === 'warn' ? 'warning' : 'danger'" size="small">
                {{ run.critic.verdict === 'pass' ? '通过' : run.critic.verdict === 'warn' ? '有提醒' : '需要修订' }}
              </el-tag>
            </template>
            <p v-if="!run.critic.issues.length" class="muted">未发现引用、重复或完成标准方面的问题。</p>
            <ul v-else class="critic-list"><li v-for="(item, index) in run.critic.issues" :key="`${item.code}-${index}`">{{ item.message }}</li></ul>
          </el-collapse-item>
        </el-collapse>

        <template v-if="waitingReview">
          <div class="recommended-time">
            建议学习时长合计 {{ totalMinutes }} 分钟，仅供参考；请以完成学习目标为准
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
              <span class="minutes">建议分钟</span>
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
              <el-button v-for="refName in item.evidence_refs" :key="refName" link type="primary" size="small" @click="showReference(refName)">{{ evidenceLabel(refName) }}</el-button>
            </div>
          </div>
          <el-button v-if="editableItems.length < 12" plain size="small" @click="addItem">+ 补充任务</el-button>

          <div class="revision">
            <el-input v-model="revisionFeedback" maxlength="1000" placeholder="如果希望重新生成，请说明修改要求" />
            <el-button :loading="submitting" @click="submitDecision('revise')">按要求修订</el-button>
          </div>
          <div class="footer-actions">
            <el-button :loading="submitting" @click="submitDecision('cancel')">取消本次运行</el-button>
            <el-button type="primary" :loading="submitting" @click="submitDecision('edit')">
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

    <el-dialog v-model="referenceOpen" title="引用原文" width="720px" append-to-body>
      <template v-if="selectedReference">
        <div class="reference-head"><el-tag size="small">{{ selectedReference.ref }}</el-tag><strong>{{ selectedReference.title }}</strong></div>
        <p class="muted">{{ selectedReference.subtitle }}</p>
        <pre class="reference-excerpt">{{ selectedReference.excerpt }}</pre>
        <el-button v-if="selectedReference.source_id" link type="primary" @click="openReferenceSource">查看完整面经来源</el-button>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.prep-agent { min-height: 180px; }
.start-form { margin-top: 18px; }
.focus-field { flex: 1; }
.project-field :deep(.el-select) { width: 100%; }
.field-tip { margin-top: 5px; color: #909399; font-size: 12px; line-height: 1.5; }
.footer-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }
.run-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.history-picker { display: flex; align-items: center; gap: 10px; margin: 12px 0; }
.history-picker .el-select { flex: 1; }
.muted { color: #909399; font-size: 12px; }
.steps { background: #f7f9fc; border-radius: 8px; padding: 10px 12px; margin-bottom: 12px; max-height: 180px; overflow: auto; }
.step { display: grid; grid-template-columns: 10px minmax(150px, auto) 1fr auto; align-items: center; gap: 8px; min-height: 26px; font-size: 13px; }
.step-dot { width: 8px; height: 8px; border-radius: 50%; background: #909399; }
.step-dot.completed { background: #67c23a; }
.step-dot.failed { background: #f56c6c; }
.step-dot.running { background: #409eff; }
.warning { margin: 8px 0; }
.analysis-panel { margin: 12px 0; border-top: 1px solid #e4e7ed; border-bottom: 1px solid #e4e7ed; }
.analysis-title { margin-right: 10px; font-weight: 600; }
.analysis-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.analysis-section { min-width: 0; border: 1px solid #ebeef5; border-radius: 8px; padding: 10px; background: #fafcff; }
.analysis-section h4 { margin: 0 0 8px; color: #303133; font-size: 13px; }
.full-width { margin-top: 12px; }
.statement-list, .gap-list { display: grid; gap: 8px; }
.statement { padding-bottom: 8px; border-bottom: 1px dashed #dcdfe6; font-size: 13px; line-height: 1.5; }
.statement:last-child { padding-bottom: 0; border-bottom: 0; }
.confidence { display: block; margin-top: 3px; color: #909399; font-size: 12px; }
.compact { margin-top: 5px; }
.topic-tag { margin: 0 6px 6px 0; }
.analysis-alert { margin-top: 8px; }
.gap-columns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.gap-card { border-left: 3px solid #e6a23c; border-radius: 4px; padding: 8px; background: #fff; font-size: 13px; }
.gap-card--strength { border-left-color: #67c23a; }
.gap-card p { margin: 5px 0 0; color: #606266; line-height: 1.5; }
.code-evidence-list { display: grid; gap: 10px; }
.code-evidence-card { border: 1px solid #d9ecff; border-radius: 7px; padding: 10px; background: #f5faff; }
.code-evidence-card>div { display: flex; align-items: center; gap: 8px; }
.code-evidence-card p { margin: 8px 0 4px; white-space: pre-wrap; color: #606266; font-size: 13px; line-height: 1.55; }
.level { margin-left: 7px; color: #909399; font-size: 12px; }
.critic-list { margin: 0; padding-left: 18px; color: #606266; font-size: 13px; line-height: 1.8; }
.recommended-time { margin: 14px 0 8px; font-weight: 600; color: #409eff; }
.summary-input { margin-bottom: 10px; }
.plan-item { border: 1px solid #e4e7ed; border-radius: 9px; padding: 10px; margin-bottom: 10px; background: #fff; }
.plan-item-head { display: flex; align-items: center; gap: 7px; }
.item-index { width: 24px; height: 24px; border-radius: 50%; background: #ecf5ff; color: #409eff; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.minutes { color: #909399; font-size: 12px; white-space: nowrap; }
.plan-meta { display: flex; gap: 8px; margin: 8px 0; }
.refs { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; color: #909399; font-size: 12px; }
.refs a { color: #409eff; text-decoration: none; }
.reference-head { display: flex; align-items: center; gap: 8px; }
.reference-excerpt { max-height: 48vh; overflow: auto; padding: 12px; margin: 10px 0; white-space: pre-wrap; overflow-wrap: anywhere; border-radius: 6px; background: #f5f7fa; color: #303133; font: 13px/1.65 ui-monospace, SFMono-Regular, Consolas, monospace; }
.revision { display: flex; gap: 8px; margin-top: 14px; }
.running-skeleton { margin-top: 18px; }
@media (max-width: 700px) {
  .analysis-grid, .gap-columns { grid-template-columns: 1fr; }
  .history-picker { align-items: stretch; flex-direction: column; gap: 4px; }
}
</style>
