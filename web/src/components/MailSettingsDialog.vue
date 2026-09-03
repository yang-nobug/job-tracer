<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { bumpData } from '../store'

interface MailAccount {
  id: number
  provider: string
  email: string
  host: string
  port: number
  secure: boolean
  mailbox: string
  status: 'connected' | 'error'
  lastTestedAt: string | null
  lastErrorCode: string | null
  credentialAvailable: boolean
}

interface AccountResponse {
  configured: boolean
  account: MailAccount | null
}

interface MailPreview {
  uid: number
  subject: string
  from: string
  sentAt: string | null
  isRead: boolean
}

interface TestResponse extends AccountResponse {
  readOnly: true
  messageCount: number
  recent: MailPreview[]
}

interface MailCandidate {
  id: number
  subject: string
  sender: string
  sentAt: string | null
  isRead: boolean
  score: number
  matchedTerms: string[]
  status: 'candidate' | 'ignored'
  firstSeenAt: string
  analysisStatus: 'running' | 'succeeded' | 'failed' | null
  analysis: MailRecruitmentExtraction | null
  analysisModel: string | null
  analysisPromptVersion: string | null
  analysisErrorCode: string | null
  scheduleReview: MailScheduleReview | null
  scheduleReviewModel: string | null
  scheduleReviewPromptVersion: string | null
  scheduleReviewErrorCode: string | null
  analyzedAt: string | null
  bodyTruncated: boolean
  applicationMatches: ApplicationMatch[]
  scheduleId: number | null
  scheduleStatus: 'active' | 'completed' | 'cancelled' | null
}

type MailEventType = 'assessment' | 'written_test' | 'interview' | 'ai_interview' | 'offer' | 'other'
type MailTimeMode = 'fixed' | 'window' | 'deadline' | 'duration_after_open' | 'flexible' | 'unknown'

interface MailEvidence {
  field: string
  quote: string
}

type MailScheduleReviewDecision = 'auto_confirm' | 'manual_review' | 'reject'

interface MailScheduleReviewEvidence {
  field: 'subject' | 'event_type' | 'time' | 'company' | 'position' | 'action'
  quote: string
}

interface MailScheduleReview {
  schema_version: '1'
  decision: MailScheduleReviewDecision
  reason: string
  evidence: MailScheduleReviewEvidence[]
}

interface MailRecruitmentExtraction {
  schema_version: '1'
  relevant: boolean
  event_type: MailEventType
  company: string
  position: string
  round: string
  title: string
  time_mode: MailTimeMode
  scheduled_at: string | null
  window_start_at: string | null
  window_end_at: string | null
  deadline_at: string | null
  duration_minutes: number | null
  timezone: 'Asia/Shanghai'
  location: string
  meeting_link: string
  action_link: string
  contact: string
  instructions: string[]
  confidence: 'high' | 'medium' | 'low'
  evidence: MailEvidence[]
  warnings: string[]
}

interface ApplicationMatch {
  id: number
  company: string
  position: string
  status: string
  score: number
  reasons: string[]
}

interface ApplicationOption {
  id: number
  company: string
  position: string
  status: string
}

interface RecruitmentScheduleItem {
  id: number
  applicationId: number | null
  sourceCandidateId: number | null
  eventType: MailEventType
  title: string
  company: string
  position: string
  timeMode: MailTimeMode
  scheduledAt: string | null
  windowStartAt: string | null
  windowEndAt: string | null
  deadlineAt: string | null
  durationMinutes: number | null
  timezone: 'Asia/Shanghai'
  location: string
  meetingLink: string
  actionLink: string
  contact: string
  instructions: string[]
  status: 'active' | 'completed' | 'cancelled'
  primaryAt: string | null
  createdAt: string
  updatedAt: string
}

interface ScheduleDraft {
  applicationId: number | null
  eventType: MailEventType
  title: string
  company: string
  position: string
  timeMode: MailTimeMode
  scheduledAt: string | null
  windowStartAt: string | null
  windowEndAt: string | null
  deadlineAt: string | null
  durationMinutes: number | null
  location: string
  meetingLink: string
  actionLink: string
  contact: string
  instructionsText: string
}

interface ScanResponse {
  scannedCount: number
  candidateCount: number
  newCandidateCount: number
  hasMore: boolean
  candidates: MailCandidate[]
}

interface MailAutomationSettings {
  enabled: boolean
  runTime: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: 'idle' | 'running' | 'succeeded' | 'failed'
  lastErrorCode: string | null
  lastErrorMessage: string | null
  lastScannedCount: number
  lastAnalyzedCount: number
  lastConfirmedCount: number
  lastReviewCount: number
  running: boolean
}

interface MailAutomationRunResponse {
  scannedCount: number
  analyzedCount: number
  confirmedCount: number
  reviewCount: number
  settings: MailAutomationSettings
}

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })

const loading = ref(false)
const testing = ref(false)
const scanning = ref(false)
const deleting = ref(false)
const analyzingCandidateId = ref<number | null>(null)
const confirmingSchedule = ref(false)
const updatingScheduleId = ref<number | null>(null)
const savingAutomation = ref(false)
const runningAutomation = ref(false)
const account = ref<MailAccount | null>(null)
const email = ref('')
const authorizationCode = ref('')
const recent = ref<MailPreview[]>([])
const messageCount = ref<number | null>(null)
const candidates = ref<MailCandidate[]>([])
const scanResult = ref<ScanResponse | null>(null)
const analysisDialogVisible = ref(false)
const analysisCandidate = ref<MailCandidate | null>(null)
const applications = ref<ApplicationOption[]>([])
const scheduleItems = ref<RecruitmentScheduleItem[]>([])
const automationSettings = ref<MailAutomationSettings | null>(null)
const scheduleStatusFilter = ref<'active' | 'completed' | 'cancelled' | 'all'>('active')
const scheduleDraft = ref<ScheduleDraft>({
  applicationId: null, eventType: 'other', title: '', company: '', position: '', timeMode: 'unknown',
  scheduledAt: null, windowStartAt: null, windowEndAt: null, deadlineAt: null,
  durationMinutes: null, location: '', meetingLink: '', actionLink: '', contact: '', instructionsText: ''
})

const hasNewCredential = computed(() => authorizationCode.value.trim().length > 0)
const actionLabel = computed(() => account.value && !hasNewCredential.value ? '重新测试只读连接' : '测试并保存')
const activeScheduleItems = computed(() => scheduleItems.value.filter(item => item.status === 'active'))
const visibleScheduleItems = computed(() => scheduleStatusFilter.value === 'all'
  ? scheduleItems.value
  : scheduleItems.value.filter(item => item.status === scheduleStatusFilter.value))

function formatTime(value: string | null): string {
  if (!value) return '时间未知'
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

const eventLabels: Record<MailEventType, string> = {
  assessment: '在线测评', written_test: '笔试', interview: '面试', ai_interview: 'AI 面试', offer: 'Offer / 录用', other: '其他招聘事项'
}
const timeModeLabels: Record<MailTimeMode, string> = {
  fixed: '固定开始时间', window: '可完成时间窗口', deadline: '截止时间', duration_after_open: '开始后计时', flexible: '时间灵活', unknown: '时间未知'
}
const scheduleStatusLabels: Record<RecruitmentScheduleItem['status'], string> = {
  active: '进行中', completed: '已完成', cancelled: '已取消'
}
const eventOptions = Object.entries(eventLabels).map(([value, label]) => ({ value: value as MailEventType, label }))
const timeModeOptions = Object.entries(timeModeLabels).map(([value, label]) => ({ value: value as MailTimeMode, label }))
const evidenceLabels: Record<string, string> = {
  event_type: '事件类型', company: '公司', position: '岗位', round: '轮次', scheduled_at: '固定时间',
  window_start_at: '窗口开始', window_end_at: '窗口结束', deadline_at: '截止时间',
  duration_minutes: '作答时长', location: '地点', meeting_link: '会议链接', action_link: '操作链接', contact: '联系人', instructions: '执行要求'
}
const reviewDecisionLabels: Record<MailScheduleReviewDecision, string> = {
  auto_confirm: '自动确认通过', manual_review: '需要人工核对', reject: '不建议加入日程'
}
const reviewEvidenceLabels: Record<MailScheduleReviewEvidence['field'], string> = {
  subject: '邮件主题', event_type: '事件类型', time: '时间', company: '公司', position: '岗位', action: '具体动作'
}
const reviewDecisionTypes: Record<MailScheduleReviewDecision, 'success' | 'warning' | 'danger'> = {
  auto_confirm: 'success', manual_review: 'warning', reject: 'danger'
}

function reviewDecisionLabel(review: MailScheduleReview | null): string {
  return review ? reviewDecisionLabels[review.decision] : '复核未完成'
}

function reviewDecisionType(review: MailScheduleReview | null): 'success' | 'warning' | 'danger' | 'info' {
  return review ? reviewDecisionTypes[review.decision] : 'warning'
}

function canWriteSchedule(candidate: MailCandidate): boolean {
  return candidate.scheduleId !== null || candidate.scheduleReview?.decision === 'auto_confirm'
}

function extractedTimeLines(extraction: MailRecruitmentExtraction): string[] {
  const lines: string[] = []
  if (extraction.scheduled_at) lines.push(`开始：${extraction.scheduled_at}`)
  if (extraction.window_start_at) lines.push(`开放：${extraction.window_start_at}`)
  if (extraction.window_end_at) lines.push(`关闭：${extraction.window_end_at}`)
  if (extraction.deadline_at) lines.push(`截止：${extraction.deadline_at}`)
  if (extraction.duration_minutes) lines.push(`开始后限时：${extraction.duration_minutes} 分钟`)
  if (!lines.length) lines.push(extraction.time_mode === 'flexible' ? '邮件说明时间可灵活安排' : '邮件中没有可确认的完整时间')
  return lines
}

function scheduleTimeLines(item: RecruitmentScheduleItem): string[] {
  const lines: string[] = []
  if (item.scheduledAt) lines.push(`开始 ${item.scheduledAt}`)
  if (item.windowStartAt) lines.push(`开放 ${item.windowStartAt}`)
  if (item.windowEndAt) lines.push(`关闭 ${item.windowEndAt}`)
  if (item.deadlineAt) lines.push(`截止 ${item.deadlineAt}`)
  if (item.durationMinutes) lines.push(`开始后限时 ${item.durationMinutes} 分钟`)
  if (!lines.length) lines.push(item.timeMode === 'flexible' ? '时间灵活安排' : '时间待确认')
  return lines
}

function scheduleSummary(item: RecruitmentScheduleItem): string {
  const title = item.title.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  return [item.company, item.position]
    .filter(value => value.trim() && !title.includes(value.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()))
    .join(' · ')
}

function replaceCandidate(updated: MailCandidate): void {
  const index = candidates.value.findIndex(item => item.id === updated.id)
  if (index >= 0) candidates.value.splice(index, 1, updated)
}

function scheduleForCandidate(candidateId: number): RecruitmentScheduleItem | undefined {
  return scheduleItems.value.find(item => item.sourceCandidateId === candidateId)
}

function resetScheduleDraft(candidate: MailCandidate): void {
  const extraction = candidate.analysis
  if (!extraction) return
  const saved = scheduleForCandidate(candidate.id)
  const suggestedApplication = candidate.applicationMatches.find(item => item.score >= 8)?.id ?? null
  scheduleDraft.value = saved ? {
    applicationId: saved.applicationId,
    eventType: saved.eventType,
    title: saved.title,
    company: saved.company,
    position: saved.position,
    timeMode: saved.timeMode,
    scheduledAt: saved.scheduledAt,
    windowStartAt: saved.windowStartAt,
    windowEndAt: saved.windowEndAt,
    deadlineAt: saved.deadlineAt,
    durationMinutes: saved.durationMinutes,
    location: saved.location,
    meetingLink: saved.meetingLink,
    actionLink: saved.actionLink,
    contact: saved.contact,
    instructionsText: saved.instructions.join('\n')
  } : {
    applicationId: suggestedApplication,
    eventType: extraction.event_type,
    title: extraction.title,
    company: extraction.company,
    position: extraction.position,
    timeMode: extraction.time_mode,
    scheduledAt: extraction.scheduled_at,
    windowStartAt: extraction.window_start_at,
    windowEndAt: extraction.window_end_at,
    deadlineAt: extraction.deadline_at,
    durationMinutes: extraction.duration_minutes,
    location: extraction.location,
    meetingLink: extraction.meeting_link,
    actionLink: extraction.action_link,
    contact: extraction.contact,
    instructionsText: extraction.instructions.join('\n')
  }
}

function showAnalysis(candidate: MailCandidate): void {
  analysisCandidate.value = candidate
  resetScheduleDraft(candidate)
  analysisDialogVisible.value = true
}

async function analyzeCandidate(candidate: MailCandidate): Promise<void> {
  analyzingCandidateId.value = candidate.id
  try {
    const updated = await api.post<MailCandidate>(`/mail/candidates/${candidate.id}/analyze`)
    replaceCandidate(updated)
    analysisCandidate.value = updated
    resetScheduleDraft(updated)
    analysisDialogVisible.value = true
    if (updated.scheduleId) {
      scheduleItems.value = await api.get<RecruitmentScheduleItem[]>('/schedule?status=all&limit=200')
      bumpData()
    }
    ElMessage.success(updated.scheduleId
      ? 'AI 复核通过，已自动加入招聘日程'
      : updated.analysis?.relevant ? '已生成招聘事件草稿，等待 AI 复核或人工处理' : 'AI 判断该邮件不是具体招聘流程通知')
  } catch (error) {
    ElMessage.error((error as Error).message)
    await load()
  } finally {
    analyzingCandidateId.value = null
  }
}

async function confirmSchedule(): Promise<void> {
  const candidate = analysisCandidate.value
  if (!candidate?.analysis?.relevant || !canWriteSchedule(candidate)) return
  confirmingSchedule.value = true
  try {
    const draft = scheduleDraft.value
    const saved = await api.post<RecruitmentScheduleItem>(`/mail/candidates/${candidate.id}/confirm-schedule`, {
      ...draft,
      instructions: draft.instructionsText.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    })
    const index = scheduleItems.value.findIndex(item => item.id === saved.id)
    if (index >= 0) scheduleItems.value.splice(index, 1, saved)
    else scheduleItems.value.push(saved)
    candidate.scheduleId = saved.id
    candidate.scheduleStatus = saved.status
    bumpData()
    ElMessage.success(index >= 0 ? '日程已更新' : '已加入招聘日程')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    confirmingSchedule.value = false
  }
}

async function updateScheduleStatus(item: RecruitmentScheduleItem, status: 'active' | 'completed' | 'cancelled'): Promise<void> {
  updatingScheduleId.value = item.id
  try {
    const updated = await api.patch<RecruitmentScheduleItem>(`/schedule/${item.id}/status`, { status })
    const index = scheduleItems.value.findIndex(value => value.id === item.id)
    if (index >= 0) scheduleItems.value.splice(index, 1, updated)
    const candidate = candidates.value.find(value => value.id === updated.sourceCandidateId)
    if (candidate) candidate.scheduleStatus = updated.status
    bumpData()
    ElMessage.success(status === 'completed' ? '日程已标记完成' : status === 'cancelled' ? '日程已取消' : '日程已恢复')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    updatingScheduleId.value = null
  }
}

async function saveAutomationSettings(): Promise<void> {
  if (!automationSettings.value) return
  savingAutomation.value = true
  try {
    automationSettings.value = await api.patch<MailAutomationSettings>('/mail/automation', {
      enabled: automationSettings.value.enabled,
      runTime: automationSettings.value.runTime
    })
    ElMessage.success(automationSettings.value.enabled ? '每日自动处理已开启' : '每日自动处理已关闭')
  } catch (error) {
    ElMessage.error((error as Error).message)
    await load()
  } finally {
    savingAutomation.value = false
  }
}

async function runAutomationNow(): Promise<void> {
  runningAutomation.value = true
  try {
    const result = await api.post<MailAutomationRunResponse>('/mail/automation/run')
    automationSettings.value = result.settings
    await load()
    bumpData()
    ElMessage.success(`自动处理完成：识别 ${result.analyzedCount} 封，确认 ${result.confirmedCount} 条日程，${result.reviewCount} 封留待人工核对`)
  } catch (error) {
    ElMessage.error((error as Error).message)
    await load()
  } finally {
    runningAutomation.value = false
  }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [result, savedCandidates, savedApplications, savedSchedules, savedAutomation] = await Promise.all([
      api.get<AccountResponse>('/mail/account'),
      api.get<MailCandidate[]>('/mail/candidates?limit=100'),
      api.get<ApplicationOption[]>('/applications'),
      api.get<RecruitmentScheduleItem[]>('/schedule?status=all&limit=200'),
      api.get<MailAutomationSettings>('/mail/automation')
    ])
    account.value = result.account
    candidates.value = savedCandidates
    applications.value = savedApplications
    scheduleItems.value = savedSchedules
    automationSettings.value = savedAutomation
    if (result.account) email.value = result.account.email
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

async function scanMailbox(): Promise<void> {
  if (!account.value) return
  scanning.value = true
  try {
    const result = await api.post<ScanResponse>('/mail/scan')
    candidates.value = result.candidates
    scanResult.value = result
    const extra = result.hasMore ? '，还有新增邮件未处理，可再扫描一次' : ''
    ElMessage.success(`检查 ${result.scannedCount} 封，新增 ${result.newCandidateCount} 个招聘候选${extra}`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    scanning.value = false
  }
}

async function ignoreCandidate(candidate: MailCandidate): Promise<void> {
  try {
    await api.patch(`/mail/candidates/${candidate.id}`, { status: 'ignored' })
    candidates.value = candidates.value.filter(item => item.id !== candidate.id)
    ElMessage.success('已忽略；后续扫描不会再次加入这封邮件')
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function testAndSave(): Promise<void> {
  if (!email.value.trim()) {
    ElMessage.warning('请填写完整的 QQ 邮箱地址')
    return
  }
  if (!account.value && !authorizationCode.value.trim()) {
    ElMessage.warning('请填写 QQ 邮箱生成的授权码')
    return
  }
  testing.value = true
  try {
    const previousEmail = account.value?.email
    const result = await api.post<TestResponse>('/mail/account/test', {
      email: email.value.trim(),
      authorizationCode: authorizationCode.value
    })
    account.value = result.account
    email.value = result.account!.email
    if (previousEmail && previousEmail !== result.account!.email) {
      candidates.value = []
      scanResult.value = null
    }
    recent.value = result.recent
    messageCount.value = result.messageCount
    authorizationCode.value = ''
    ElMessage.success(`只读连接成功，收件箱共有 ${result.messageCount} 封邮件`)
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    testing.value = false
  }
}

async function removeConnection(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '删除后，job-tracer 将无法继续读取邮箱；QQ 邮箱中的邮件不会受到影响。',
      '删除邮箱连接？',
      { type: 'warning', confirmButtonText: '删除连接', cancelButtonText: '取消' }
    )
    deleting.value = true
    await api.delete('/mail/account')
    account.value = null
    email.value = ''
    authorizationCode.value = ''
    recent.value = []
    messageCount.value = null
    candidates.value = []
    scanResult.value = null
    if (automationSettings.value) {
      automationSettings.value.enabled = false
      automationSettings.value.nextRunAt = null
      automationSettings.value.lastStatus = 'idle'
    }
    ElMessage.success('邮箱连接和本机保存的授权码已删除')
  } catch (error) {
    if (error !== 'cancel' && error !== 'close') ElMessage.error((error as Error).message)
  } finally {
    deleting.value = false
  }
}

function onClosed(): void {
  authorizationCode.value = ''
  recent.value = []
  messageCount.value = null
  analysisDialogVisible.value = false
  analysisCandidate.value = null
}

watch(() => props.modelValue, open => { if (open) void load() })
watch(() => scheduleDraft.value.timeMode, timeMode => {
  if (timeMode === 'fixed') {
    scheduleDraft.value.windowStartAt = null
    scheduleDraft.value.windowEndAt = null
    scheduleDraft.value.durationMinutes = null
  } else if (timeMode === 'window') {
    scheduleDraft.value.scheduledAt = null
  } else if (timeMode === 'deadline') {
    scheduleDraft.value.scheduledAt = null
    scheduleDraft.value.windowStartAt = null
    scheduleDraft.value.windowEndAt = null
    scheduleDraft.value.durationMinutes = null
  } else if (timeMode === 'duration_after_open') {
    scheduleDraft.value.scheduledAt = null
    scheduleDraft.value.windowStartAt = null
    scheduleDraft.value.windowEndAt = null
  } else {
    scheduleDraft.value.scheduledAt = null
    scheduleDraft.value.windowStartAt = null
    scheduleDraft.value.windowEndAt = null
    scheduleDraft.value.deadlineAt = null
    scheduleDraft.value.durationMinutes = null
  }
})
</script>

<template>
  <el-dialog
    v-model="visible"
    title="QQ 邮箱与招聘日程"
    width="760px"
    top="6vh"
    append-to-body
    destroy-on-close
    @closed="onClosed"
  >
    <div v-loading="loading" class="mail-settings">
      <el-alert type="info" :closable="false" show-icon>
        <template #title>仅连接个人 QQ 邮箱的 IMAP，只读检查收件箱</template>
        <p class="alert-copy">
          连接使用 imap.qq.com:993 和 TLS。测试只获取最近邮件的主题、发件人、时间及当前已读状态，不读取正文或附件，也不会修改邮件。
        </p>
      </el-alert>

      <section v-if="account" class="status-card" :class="account.status">
        <div>
          <div class="status-title">
            <b>{{ account.email }}</b>
            <el-tag :type="account.status === 'connected' && account.credentialAvailable ? 'success' : 'danger'" size="small">
              {{ account.status === 'connected' && account.credentialAvailable ? '已连接' : '需要检查' }}
            </el-tag>
            <el-tag type="info" size="small">只读</el-tag>
          </div>
          <p>上次测试：{{ formatTime(account.lastTestedAt) }}</p>
        </div>
        <div class="status-actions">
          <el-button type="primary" plain :loading="scanning" @click="scanMailbox">扫描近期招聘邮件</el-button>
          <el-button text type="danger" :loading="deleting" @click="removeConnection">删除连接</el-button>
        </div>
      </section>

      <section v-if="account && automationSettings" class="mail-automation-card">
        <div class="automation-heading">
          <div>
            <h3>自动确认招聘日程</h3>
            <p>job-tracer 运行期间，每天在设定时间扫描新邮件并识别；只有高置信度且时间证据完整的测评、笔试和面试会自动加入日程。</p>
          </div>
          <el-switch v-model="automationSettings.enabled" active-text="每天自动处理" />
        </div>
        <el-alert type="warning" :closable="false" show-icon>
          <template #title>开启后会自动读取候选邮件正文并发送给已配置的 AI 模型</template>
          <p class="alert-copy">附件仍不会读取或发送。低置信度、时间未知、Offer 和其他类型不会自动确认，会保留在候选列表等待你核对。每次最多自动识别 10 封，避免异常邮件造成大量模型调用。</p>
        </el-alert>
        <div class="automation-controls">
          <el-time-picker
            v-model="automationSettings.runTime"
            format="HH:mm"
            value-format="HH:mm"
            placeholder="每日执行时间"
            :clearable="false"
          />
          <el-button type="primary" plain :loading="savingAutomation" @click="saveAutomationSettings">保存自动化设置</el-button>
          <el-button :loading="runningAutomation || automationSettings.running" @click="runAutomationNow">立即自动处理一次</el-button>
        </div>
        <div class="automation-status">
          <span v-if="automationSettings.enabled">下次执行：{{ automationSettings.nextRunAt || '计算中' }}</span>
          <span v-else>自动处理当前已关闭</span>
          <span v-if="automationSettings.lastRunAt">上次执行：{{ formatTime(automationSettings.lastRunAt) }}</span>
          <el-tag v-if="automationSettings.lastStatus === 'running'" type="warning" size="small">正在处理</el-tag>
          <el-tag v-else-if="automationSettings.lastStatus === 'succeeded'" type="success" size="small">
            扫描 {{ automationSettings.lastScannedCount }} · 识别 {{ automationSettings.lastAnalyzedCount }} · 自动确认 {{ automationSettings.lastConfirmedCount }} · 待核对 {{ automationSettings.lastReviewCount }}
          </el-tag>
          <el-tag v-else-if="automationSettings.lastStatus === 'failed'" type="danger" size="small">
            {{ automationSettings.lastErrorMessage || '上次自动处理失败' }}
          </el-tag>
        </div>
      </section>

      <el-form label-position="top" class="connect-form" @submit.prevent="testAndSave">
        <el-form-item label="QQ 邮箱地址">
          <el-input
            v-model="email"
            maxlength="254"
            autocomplete="username"
            placeholder="例如 123456@qq.com"
          />
        </el-form-item>
        <el-form-item>
          <template #label>
            <span>QQ 邮箱授权码</span>
            <span v-if="account" class="optional-hint">留空会使用本机已保存的授权码</span>
          </template>
          <el-input
            v-model="authorizationCode"
            type="password"
            show-password
            maxlength="128"
            autocomplete="new-password"
            placeholder="不是 QQ 登录密码，也不要发到聊天或提交到 Git"
            @keyup.enter="testAndSave"
          />
        </el-form-item>
        <div class="form-actions">
          <el-link href="https://mail.qq.com/" target="_blank" type="primary">打开 QQ 邮箱设置</el-link>
          <el-button type="primary" :loading="testing" @click="testAndSave">{{ actionLabel }}</el-button>
        </div>
      </el-form>

      <section v-if="account" class="candidate-section">
        <div class="preview-heading">
          <div>
            <h3>招聘邮件候选</h3>
            <p>扫描只使用主题和发件人做宽松粗筛，候选中可能有无关邮件。手动识别或开启每日自动处理后，AI 会先提取招聘事件，再独立复核它是否真的是合理、可执行的招聘日程。</p>
          </div>
          <div v-if="scanResult" class="scan-tags">
            <el-tag type="info">本次检查 {{ scanResult.scannedCount }}</el-tag>
            <el-tag type="success">新增候选 {{ scanResult.newCandidateCount }}</el-tag>
          </div>
        </div>
        <el-alert
          v-if="scanResult?.hasMore"
          type="warning"
          :closable="false"
          title="新增邮件超过单批上限，请再次点击“扫描近期招聘邮件”继续。"
          class="more-alert"
        />
        <el-alert type="warning" :closable="false" show-icon class="ai-disclosure">
          <template #title>AI 识别需要发送这封候选邮件的正文文字</template>
          <p class="alert-copy">
            识别时，邮件标题、发件人、发送时间、正文文字和正文链接会发送给你配置的火山方舟模型；不会读取或发送附件，也不会在数据库保存邮件正文。AI 会用第二个独立步骤对提取结果和原文做日程合理性复核；只要复核通过，就会自动写入招聘日程。后续发现问题可在日程列表中修改或取消。
          </p>
        </el-alert>
        <div v-if="candidates.length" class="candidate-list">
          <article v-for="candidate in candidates" :key="candidate.id" class="candidate-card">
            <div class="candidate-main">
              <div class="candidate-title">
                <span v-if="!candidate.isRead" class="unread-dot" title="邮箱中当前未读" />
                <b>{{ candidate.subject }}</b>
              </div>
              <p>{{ candidate.sender }}</p>
              <div class="candidate-meta">
                <span>{{ formatTime(candidate.sentAt) }}</span>
                <el-tag v-for="term in candidate.matchedTerms" :key="term" size="small" effect="plain">{{ term }}</el-tag>
                <el-tag v-if="candidate.scheduleStatus === 'active'" size="small" type="success">已加入日程</el-tag>
                <el-tag v-else-if="candidate.scheduleStatus === 'completed'" size="small" type="info">日程已完成</el-tag>
                <el-tag v-else-if="candidate.scheduleStatus === 'cancelled'" size="small" type="danger">日程已取消</el-tag>
                <el-tag v-else-if="candidate.scheduleReview?.decision === 'auto_confirm'" size="small" type="success" effect="plain">AI 复核通过</el-tag>
                <el-tag v-else-if="candidate.scheduleReview?.decision === 'manual_review'" size="small" type="warning" effect="plain">待人工核对</el-tag>
                <el-tag v-else-if="candidate.scheduleReview?.decision === 'reject'" size="small" type="info" effect="plain">AI 建议忽略</el-tag>
                <el-tag v-else-if="candidate.analysisStatus === 'succeeded' && !candidate.scheduleReview && !candidate.scheduleReviewErrorCode" size="small" type="warning" effect="plain">待补做 AI 复核</el-tag>
              </div>
            </div>
            <div class="candidate-actions">
              <el-button
                v-if="candidate.analysisStatus === 'succeeded'"
                text type="primary"
                @click="showAnalysis(candidate)"
              >查看识别结果</el-button>
              <el-button
                v-else
                text type="primary"
                :loading="analyzingCandidateId === candidate.id || candidate.analysisStatus === 'running'"
                @click="analyzeCandidate(candidate)"
              >{{ candidate.analysisStatus === 'running' ? '正在识别' : candidate.analysisStatus === 'failed' ? '重试 AI 识别' : '读取正文并 AI 识别' }}</el-button>
              <el-button text type="info" @click="ignoreCandidate(candidate)">忽略</el-button>
            </div>
          </article>
        </div>
        <el-empty v-else description="还没有招聘邮件候选，点击上方按钮开始扫描" :image-size="55" />
      </section>

      <section v-if="scheduleItems.length" class="schedule-list-section">
        <div class="preview-heading">
          <div>
            <h3>已确认的招聘日程</h3>
            <p>这些事项已经进入顶部“近期日程”；时间未知或灵活安排的事项保留在此处，不进入倒计时。</p>
          </div>
          <el-radio-group v-model="scheduleStatusFilter" size="small">
            <el-radio-button value="active">进行中 {{ activeScheduleItems.length }}</el-radio-button>
            <el-radio-button value="completed">已完成</el-radio-button>
            <el-radio-button value="cancelled">已取消</el-radio-button>
            <el-radio-button value="all">全部</el-radio-button>
          </el-radio-group>
        </div>
        <div v-if="visibleScheduleItems.length" class="confirmed-schedule-list">
          <article v-for="item in visibleScheduleItems" :key="item.id" class="confirmed-schedule-card" :class="item.status">
            <div class="schedule-date-badge">
              <b>{{ item.primaryAt ? item.primaryAt.slice(5, 10) : '待定' }}</b>
              <span>{{ item.primaryAt ? item.primaryAt.slice(11) : '时间' }}</span>
            </div>
            <div class="confirmed-schedule-main">
              <div class="confirmed-schedule-title">
                <b>{{ item.title }}</b>
                <el-tag size="small" effect="plain">{{ eventLabels[item.eventType] }}</el-tag>
                <el-tag v-if="item.status !== 'active'" size="small" :type="item.status === 'completed' ? 'info' : 'danger'">
                  {{ scheduleStatusLabels[item.status] }}
                </el-tag>
              </div>
              <p>{{ scheduleSummary(item) || '公司与岗位已包含在标题中' }}</p>
              <div class="schedule-time-lines">
                <span v-for="line in scheduleTimeLines(item)" :key="line">{{ line }}</span>
              </div>
            </div>
            <div class="schedule-card-actions">
              <template v-if="item.status === 'active'">
                <el-button text type="success" :loading="updatingScheduleId === item.id" @click="updateScheduleStatus(item, 'completed')">标记完成</el-button>
                <el-button text type="danger" :loading="updatingScheduleId === item.id" @click="updateScheduleStatus(item, 'cancelled')">取消</el-button>
              </template>
              <el-button v-else text type="primary" :loading="updatingScheduleId === item.id" @click="updateScheduleStatus(item, 'active')">恢复日程</el-button>
            </div>
          </article>
        </div>
        <el-empty v-else :description="`没有${scheduleStatusFilter === 'completed' ? '已完成' : scheduleStatusFilter === 'cancelled' ? '已取消' : '进行中'}的日程`" :image-size="48" />
      </section>

      <section v-if="messageCount !== null" class="preview-section">
        <div class="preview-heading">
          <div>
            <h3>连接验证结果</h3>
            <p>收件箱共 {{ messageCount }} 封；以下是最近 {{ recent.length }} 封的信封信息。</p>
          </div>
          <el-tag type="success">服务器已确认只读模式</el-tag>
        </div>
        <el-table v-if="recent.length" :data="recent" size="small" max-height="280">
          <el-table-column label="主题" min-width="230" show-overflow-tooltip>
            <template #default="scope">
              <span :class="{ unread: !scope.row.isRead }">{{ scope.row.subject }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="from" label="发件人" min-width="190" show-overflow-tooltip />
          <el-table-column label="时间" width="170">
            <template #default="scope">{{ formatTime(scope.row.sentAt) }}</template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="收件箱中还没有邮件" :image-size="55" />
      </section>

      <div class="security-note">
        <b>授权码如何保存</b>
        <p>授权码只会发送给本机 job-tracer 后端，再用于登录 QQ IMAP；不会发送给 AI。后端使用本机生成的 AES-256-GCM 密钥加密保存，接口不会返回授权码，日志也不会记录它。</p>
      </div>
    </div>

    <el-dialog
      v-model="analysisDialogVisible"
      title="招聘邮件识别结果"
      width="720px"
      append-to-body
      destroy-on-close
    >
      <div v-if="analysisCandidate?.analysis" class="analysis-result">
        <header class="analysis-hero">
          <div>
            <div class="analysis-tags">
              <el-tag :type="analysisCandidate.analysis.relevant ? 'success' : 'info'">
                {{ analysisCandidate.analysis.relevant ? '招聘流程通知' : '非具体流程通知' }}
              </el-tag>
              <el-tag v-if="analysisCandidate.analysis.relevant" effect="plain">
                {{ eventLabels[analysisCandidate.analysis.event_type] }}
              </el-tag>
              <el-tag :type="analysisCandidate.analysis.confidence === 'high' ? 'success' : analysisCandidate.analysis.confidence === 'medium' ? 'warning' : 'danger'" effect="plain">
                {{ analysisCandidate.analysis.confidence === 'high' ? '高置信度' : analysisCandidate.analysis.confidence === 'medium' ? '中等置信度' : '低置信度' }}
              </el-tag>
            </div>
            <h3>{{ analysisCandidate.analysis.title || analysisCandidate.subject }}</h3>
            <p>{{ analysisCandidate.subject }}</p>
          </div>
          <el-tag v-if="analysisCandidate.bodyTruncated" type="warning">正文过长，已截断</el-tag>
        </header>

        <el-alert
          v-if="!analysisCandidate.analysis.relevant"
          type="info"
          :closable="false"
          title="这封邮件没有识别出需要加入日程的招聘动作，可以核对原邮件后忽略。"
        />

        <template v-else>
          <section class="analysis-section">
            <h4>事件信息</h4>
            <dl class="fact-grid">
              <div><dt>公司</dt><dd>{{ analysisCandidate.analysis.company || '未识别' }}</dd></div>
              <div><dt>岗位</dt><dd>{{ analysisCandidate.analysis.position || '未识别' }}</dd></div>
              <div><dt>轮次</dt><dd>{{ analysisCandidate.analysis.round || '未识别' }}</dd></div>
              <div><dt>地点 / 方式</dt><dd>{{ analysisCandidate.analysis.location || '未识别' }}</dd></div>
              <div v-if="analysisCandidate.analysis.contact" class="wide"><dt>联系人</dt><dd>{{ analysisCandidate.analysis.contact }}</dd></div>
            </dl>
          </section>

          <section class="analysis-section time-card">
            <div class="section-heading">
              <h4>时间规则</h4>
              <el-tag effect="plain">{{ timeModeLabels[analysisCandidate.analysis.time_mode] }}</el-tag>
            </div>
            <p v-for="line in extractedTimeLines(analysisCandidate.analysis)" :key="line">{{ line }}</p>
            <small>统一按 Asia/Shanghai（中国标准时间）展示；AI 日程复核通过后会自动写入，之后仍可修改或取消。</small>
          </section>

          <section v-if="analysisCandidate.analysis.instructions.length" class="analysis-section">
            <h4>执行要求</h4>
            <ol class="instruction-list">
              <li v-for="item in analysisCandidate.analysis.instructions" :key="item">{{ item }}</li>
            </ol>
          </section>

          <section v-if="analysisCandidate.analysis.meeting_link || analysisCandidate.analysis.action_link" class="analysis-section">
            <h4>邮件中的链接</h4>
            <div class="link-list">
              <el-link v-if="analysisCandidate.analysis.meeting_link" :href="analysisCandidate.analysis.meeting_link" target="_blank" rel="noopener noreferrer" type="primary">打开会议链接</el-link>
              <el-link v-if="analysisCandidate.analysis.action_link" :href="analysisCandidate.analysis.action_link" target="_blank" rel="noopener noreferrer" type="primary">打开测评 / 操作链接</el-link>
            </div>
          </section>

          <section v-if="analysisCandidate.applicationMatches.length" class="analysis-section">
            <h4>可能对应的已有投递</h4>
            <div class="match-list">
              <div v-for="match in analysisCandidate.applicationMatches" :key="match.id" class="match-item">
                <div><b>{{ match.company }}</b><span>{{ match.position }}</span></div>
                <div class="match-reasons"><el-tag v-for="reason in match.reasons" :key="reason" size="small" effect="plain">{{ reason }}</el-tag></div>
              </div>
            </div>
          </section>

          <section v-if="canWriteSchedule(analysisCandidate)" class="analysis-section schedule-editor-section">
            <div class="section-heading">
              <div>
                <h4>{{ analysisCandidate.scheduleId ? '已自动加入招聘日程' : '可写入招聘日程' }}</h4>
                <p>AI 原始识别结果不会被覆盖。你可以在这里修改内容，再保存日程修改。</p>
              </div>
              <el-tag v-if="analysisCandidate.scheduleStatus === 'active'" type="success">已加入，可更新</el-tag>
            </div>
            <el-form label-position="top" class="schedule-form">
              <el-form-item label="关联已有投递（可选）">
                <el-select v-model="scheduleDraft.applicationId" clearable filterable placeholder="不关联，作为独立日程保存" style="width: 100%">
                  <el-option
                    v-for="application in applications"
                    :key="application.id"
                    :value="application.id"
                    :label="`${application.company} · ${application.position}`"
                  />
                </el-select>
              </el-form-item>
              <div class="schedule-form-grid">
                <el-form-item label="公司"><el-input v-model="scheduleDraft.company" maxlength="200" /></el-form-item>
                <el-form-item label="岗位"><el-input v-model="scheduleDraft.position" maxlength="200" /></el-form-item>
                <el-form-item label="事件类型">
                  <el-select v-model="scheduleDraft.eventType" style="width: 100%">
                    <el-option v-for="option in eventOptions" :key="option.value" :value="option.value" :label="option.label" />
                  </el-select>
                </el-form-item>
                <el-form-item label="时间规则">
                  <el-select v-model="scheduleDraft.timeMode" style="width: 100%">
                    <el-option v-for="option in timeModeOptions" :key="option.value" :value="option.value" :label="option.label" />
                  </el-select>
                </el-form-item>
                <el-form-item label="日程标题" class="wide-field">
                  <el-input v-model="scheduleDraft.title" maxlength="300" placeholder="例如：XX 公司 Java 岗在线测评" />
                </el-form-item>

                <el-form-item v-if="scheduleDraft.timeMode === 'fixed'" label="固定开始时间">
                  <el-date-picker v-model="scheduleDraft.scheduledAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
                </el-form-item>
                <template v-if="scheduleDraft.timeMode === 'window'">
                  <el-form-item label="窗口开放时间">
                    <el-date-picker v-model="scheduleDraft.windowStartAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
                  </el-form-item>
                  <el-form-item label="窗口关闭时间">
                    <el-date-picker v-model="scheduleDraft.windowEndAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
                  </el-form-item>
                </template>
                <el-form-item v-if="['fixed', 'window', 'deadline', 'duration_after_open'].includes(scheduleDraft.timeMode)" :label="scheduleDraft.timeMode === 'deadline' ? '截止时间' : '截止时间（如邮件有说明）'">
                  <el-date-picker v-model="scheduleDraft.deadlineAt" type="datetime" value-format="YYYY-MM-DD HH:mm" format="YYYY-MM-DD HH:mm" style="width: 100%" />
                </el-form-item>
                <el-form-item v-if="['window', 'duration_after_open'].includes(scheduleDraft.timeMode)" label="开始后限时（分钟）">
                  <el-input-number v-model="scheduleDraft.durationMinutes" :min="1" :max="10080" controls-position="right" style="width: 100%" />
                </el-form-item>

                <el-form-item label="地点 / 会议方式"><el-input v-model="scheduleDraft.location" maxlength="500" /></el-form-item>
                <el-form-item label="联系人"><el-input v-model="scheduleDraft.contact" maxlength="500" /></el-form-item>
                <el-form-item label="会议链接" class="wide-field"><el-input v-model="scheduleDraft.meetingLink" maxlength="2048" /></el-form-item>
                <el-form-item label="测评 / 操作链接" class="wide-field"><el-input v-model="scheduleDraft.actionLink" maxlength="2048" /></el-form-item>
                <el-form-item label="执行要求（每行一项）" class="wide-field">
                  <el-input v-model="scheduleDraft.instructionsText" type="textarea" :rows="3" maxlength="4000" show-word-limit />
                </el-form-item>
              </div>
            </el-form>
          </section>
          <el-alert
            v-if="!canWriteSchedule(analysisCandidate)"
            type="warning"
            :closable="false"
            title="AI 日程复核尚未通过，这封邮件不会加入日程。你可以查看复核理由，或重新识别。"
          />
        </template>

        <section v-if="analysisCandidate.scheduleReview || analysisCandidate.scheduleReviewErrorCode" class="analysis-section review-section">
          <div class="section-heading">
            <h4>AI 日程合理性复核</h4>
            <el-tag :type="reviewDecisionType(analysisCandidate.scheduleReview)" effect="plain">
              {{ reviewDecisionLabel(analysisCandidate.scheduleReview) }}
            </el-tag>
          </div>
          <p class="review-reason">{{ analysisCandidate.scheduleReview?.reason || '复核步骤未完成，不能自动确认；请根据原邮件人工核对。' }}</p>
          <div v-if="analysisCandidate.scheduleReview?.evidence.length" class="review-evidence-list">
            <blockquote v-for="(evidence, index) in analysisCandidate.scheduleReview.evidence" :key="`${evidence.field}-${index}`">
              <span>{{ reviewEvidenceLabels[evidence.field] }}</span>
              <p>{{ evidence.quote }}</p>
            </blockquote>
          </div>
          <small v-if="analysisCandidate.scheduleReviewErrorCode" class="review-error">复核错误码：{{ analysisCandidate.scheduleReviewErrorCode }}。自动处理已安全跳过这封邮件。</small>
        </section>

        <el-alert v-if="analysisCandidate.analysis.warnings.length" type="warning" :closable="false" class="warning-box">
          <template #title>需要人工核对</template>
          <ul><li v-for="warning in analysisCandidate.analysis.warnings" :key="warning">{{ warning }}</li></ul>
        </el-alert>

        <section v-if="analysisCandidate.analysis.evidence.length" class="analysis-section evidence-section">
          <h4>原文证据</h4>
          <div class="evidence-list">
            <blockquote v-for="(evidence, index) in analysisCandidate.analysis.evidence" :key="`${evidence.field}-${index}`">
              <span>{{ evidenceLabels[evidence.field] || evidence.field }}</span>
              <p>{{ evidence.quote }}</p>
            </blockquote>
          </div>
        </section>

        <footer class="analysis-footer">
          <span>识别于 {{ formatTime(analysisCandidate.analyzedAt) }}；正文未保存。</span>
          <div>
            <el-button :loading="analyzingCandidateId === analysisCandidate.id" @click="analyzeCandidate(analysisCandidate)">重新识别</el-button>
            <el-button
              v-if="analysisCandidate.analysis.relevant && canWriteSchedule(analysisCandidate)"
              type="primary"
              :loading="confirmingSchedule"
              @click="confirmSchedule"
            >{{ analysisCandidate.scheduleId ? '保存日程修改' : '加入招聘日程' }}</el-button>
          </div>
        </footer>
      </div>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.mail-settings { min-height: 240px; }
.alert-copy { margin: 5px 0 0; color: #606266; font-size: 12px; line-height: 1.65; }
.status-card {
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  margin-top: 16px; padding: 13px 15px; border: 1px solid #d9ecff; border-radius: 9px; background: #f4faff;
}
.status-card.error { border-color: #fde2e2; background: #fef6f6; }
.status-title { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.status-card p { margin: 5px 0 0; color: #909399; font-size: 12px; }
.status-actions { display: flex; align-items: center; gap: 6px; }
.status-actions .el-button + .el-button { margin-left: 0; }
.mail-automation-card { margin-top: 16px; padding: 15px; border: 1px solid #e4e7ed; border-radius: 9px; background: #fafafa; }
.automation-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; margin-bottom: 12px; }
.automation-heading h3 { margin: 0; font-size: 15px; }
.automation-heading p { max-width: 560px; margin: 5px 0 0; color: #606266; font-size: 12px; line-height: 1.6; }
.automation-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 9px; margin-top: 13px; }
.automation-controls .el-button + .el-button { margin-left: 0; }
.automation-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; margin-top: 12px; color: #606266; font-size: 12px; }
.connect-form { margin-top: 18px; }
.connect-form :deep(.el-form-item) { margin-bottom: 15px; }
.optional-hint { margin-left: 8px; color: #909399; font-size: 12px; font-weight: 400; }
.form-actions { display: flex; align-items: center; justify-content: space-between; }
.preview-section { margin-top: 22px; border-top: 1px solid #ebeef5; padding-top: 18px; }
.candidate-section { margin-top: 22px; border-top: 1px solid #ebeef5; padding-top: 18px; }
.schedule-list-section { margin-top: 22px; border-top: 1px solid #ebeef5; padding-top: 18px; }
.preview-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; margin-bottom: 10px; }
.preview-heading h3 { margin: 0; font-size: 15px; }
.preview-heading p { margin: 5px 0 0; color: #909399; font-size: 12px; }
.unread { color: #303133; font-weight: 700; }
.scan-tags { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.more-alert { margin-bottom: 10px; }
.ai-disclosure { margin-bottom: 12px; }
.candidate-list { display: flex; flex-direction: column; gap: 8px; max-height: 330px; overflow: auto; padding-right: 2px; }
.candidate-card { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; padding: 11px 13px; border: 1px solid #ebeef5; border-radius: 8px; background: #fff; }
.candidate-card:hover { border-color: #c6e2ff; background: #f8fbff; }
.candidate-main { min-width: 0; }
.candidate-title { display: flex; align-items: center; gap: 7px; min-width: 0; }
.candidate-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.candidate-main > p { margin: 5px 0; color: #606266; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.candidate-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 5px; color: #909399; font-size: 12px; }
.candidate-actions { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; }
.candidate-actions .el-button + .el-button { margin-left: 0; }
.unread-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #409eff; }
.confirmed-schedule-list { display: flex; flex-direction: column; gap: 9px; max-height: 330px; overflow: auto; }
.confirmed-schedule-card { display: flex; align-items: flex-start; gap: 13px; padding: 12px; border: 1px solid #d9ecff; border-radius: 9px; background: #f7fbff; }
.confirmed-schedule-card.completed, .confirmed-schedule-card.cancelled { border-color: #e4e7ed; background: #f8f9fa; }
.confirmed-schedule-card.completed .schedule-date-badge, .confirmed-schedule-card.cancelled .schedule-date-badge { background: #909399; }
.schedule-date-badge { width: 54px; flex: 0 0 auto; padding: 6px 3px; border-radius: 7px; background: #409eff; color: #fff; text-align: center; }
.schedule-date-badge b { display: block; font-size: 14px; }
.schedule-date-badge span { display: block; margin-top: 3px; font-size: 11px; opacity: 0.9; }
.confirmed-schedule-main { flex: 1; min-width: 0; }
.confirmed-schedule-title { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.confirmed-schedule-main > p { margin: 5px 0; color: #606266; font-size: 12px; }
.schedule-time-lines { display: flex; flex-wrap: wrap; gap: 5px 12px; color: #409eff; font-size: 12px; }
.schedule-card-actions { display: flex; flex: 0 0 auto; gap: 3px; }
.schedule-card-actions .el-button + .el-button { margin-left: 0; }
.analysis-result { color: #303133; }
.analysis-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding: 4px 2px 16px; }
.analysis-hero h3 { margin: 9px 0 4px; font-size: 20px; }
.analysis-hero p { margin: 0; color: #909399; font-size: 12px; }
.analysis-tags { display: flex; flex-wrap: wrap; gap: 7px; }
.analysis-section { margin-top: 14px; padding: 15px 16px; border: 1px solid #ebeef5; border-radius: 10px; background: #fff; }
.analysis-section h4 { margin: 0 0 12px; font-size: 15px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.section-heading h4 { margin-bottom: 0; }
.fact-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 22px; margin: 0; }
.fact-grid > div { min-width: 0; }
.fact-grid .wide { grid-column: 1 / -1; }
.fact-grid dt { margin-bottom: 4px; color: #909399; font-size: 12px; }
.fact-grid dd { margin: 0; line-height: 1.55; overflow-wrap: anywhere; }
.time-card { border-color: #c6e2ff; background: #f7fbff; }
.time-card p { margin: 10px 0 0; font-size: 15px; font-weight: 600; }
.time-card small { display: block; margin-top: 10px; color: #909399; line-height: 1.5; }
.review-section { border-color: #d9ecff; background: #f7fbff; }
.review-reason { margin: 10px 0 0; line-height: 1.65; white-space: pre-wrap; }
.review-evidence-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.review-evidence-list blockquote { margin: 0; padding: 8px 11px; border-left: 3px solid #79bbff; border-radius: 0 6px 6px 0; background: #fff; }
.review-evidence-list blockquote span { color: #409eff; font-size: 12px; font-weight: 600; }
.review-evidence-list blockquote p { margin: 4px 0 0; color: #606266; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.review-error { display: block; margin-top: 10px; color: #e6a23c; line-height: 1.5; }
.instruction-list { margin: 0; padding-left: 22px; }
.instruction-list li { padding: 3px 0; line-height: 1.6; }
.link-list { display: flex; flex-wrap: wrap; gap: 22px; }
.match-list { display: flex; flex-direction: column; gap: 9px; }
.match-item { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 11px; border-radius: 7px; background: #f5f7fa; }
.match-item span { margin-left: 9px; color: #606266; }
.match-reasons { display: flex; gap: 5px; }
.schedule-editor-section { border-color: #b3e19d; background: #fbfef9; }
.schedule-editor-section .section-heading { align-items: flex-start; }
.schedule-editor-section .section-heading h4 { margin-bottom: 4px; }
.schedule-editor-section .section-heading p { margin: 0; color: #909399; font-size: 12px; line-height: 1.6; }
.schedule-form { margin-top: 14px; }
.schedule-form :deep(.el-form-item) { margin-bottom: 14px; }
.schedule-form-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
.schedule-form-grid .wide-field { grid-column: 1 / -1; }
.warning-box { margin-top: 14px; }
.warning-box ul { margin: 7px 0 0; padding-left: 20px; line-height: 1.65; }
.evidence-section { background: #fafafa; }
.evidence-list { display: flex; flex-direction: column; gap: 9px; }
.evidence-list blockquote { margin: 0; padding: 9px 12px; border-left: 3px solid #a0cfff; border-radius: 0 6px 6px 0; background: #fff; }
.evidence-list blockquote span { color: #409eff; font-size: 12px; font-weight: 600; }
.evidence-list blockquote p { margin: 5px 0 0; color: #606266; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.analysis-footer { display: flex; align-items: center; justify-content: space-between; gap: 15px; margin-top: 18px; color: #909399; font-size: 12px; }
.analysis-footer > div { display: flex; gap: 8px; }
.analysis-footer .el-button + .el-button { margin-left: 0; }
.security-note { margin-top: 20px; padding: 12px 14px; border-radius: 8px; background: #f5f7fa; color: #606266; font-size: 12px; }
.security-note b { color: #303133; }
.security-note p { margin: 5px 0 0; line-height: 1.7; }
@media (max-width: 700px) {
  .status-card, .preview-heading { align-items: flex-start; flex-direction: column; }
  .status-actions { align-items: flex-start; flex-direction: column; }
  .form-actions { gap: 12px; align-items: flex-start; flex-direction: column; }
  .candidate-card, .analysis-footer, .match-item, .confirmed-schedule-card { align-items: flex-start; flex-direction: column; }
  .fact-grid { grid-template-columns: 1fr; }
  .fact-grid .wide { grid-column: auto; }
  .schedule-form-grid { grid-template-columns: 1fr; }
  .schedule-form-grid .wide-field { grid-column: auto; }
}
</style>
