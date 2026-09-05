<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { CodeReadingMode, CodeReadingSession, ProjectArchiveSummary } from '../types'
import RichText from './RichText.vue'

const open = defineModel<boolean>({ default: false })
const props = defineProps<{ project: ProjectArchiveSummary | null }>()
const question = ref('')
const mode = ref<CodeReadingMode>('explain')
const session = ref<CodeReadingSession | null>(null)
const starting = ref(false)
let timer: ReturnType<typeof setInterval> | null = null
const running = computed(() => session.value?.status === 'queued' || session.value?.status === 'running')
const modeOptions: Array<{ value: CodeReadingMode; label: string; hint: string }> = [
  { value: 'explain', label: '解释代码', hint: '梳理真实调用链和模块职责' },
  { value: 'architecture', label: '生成架构说明', hint: '按数据流、边界和异常处理说明设计' },
  { value: 'interview_story', label: '准备项目介绍', hint: '生成基于证据的面试话术与追问' }
]
function stopPolling(): void { if (timer) { clearInterval(timer); timer = null } }
async function refresh(): Promise<void> {
  if (!session.value) return
  try {
    session.value = await api.get<CodeReadingSession>(`/code-reading/sessions/${session.value.id}`)
    if (!running.value) stopPolling()
  } catch (error) { stopPolling(); ElMessage.error((error as Error).message) }
}
function startPolling(): void { stopPolling(); timer = setInterval(() => { void refresh() }, 1200) }
async function start(): Promise<void> {
  if (!props.project || !question.value.trim()) { ElMessage.warning('请先输入希望调查的具体问题'); return }
  starting.value = true
  try {
    session.value = await api.post<CodeReadingSession>(`/projects/${props.project.id}/code-reading/sessions`, { question: question.value, output_mode: mode.value })
    startPolling(); await refresh()
  } catch (error) { ElMessage.error((error as Error).message) } finally { starting.value = false }
}
async function cancel(): Promise<void> {
  if (!session.value) return
  try {
    session.value = await api.post<CodeReadingSession>(`/code-reading/sessions/${session.value.id}/cancel`)
    stopPolling()
  } catch (error) { ElMessage.error((error as Error).message) }
}
async function retry(): Promise<void> {
  if (!session.value) return
  starting.value = true
  try {
    session.value = await api.post<CodeReadingSession>(`/code-reading/sessions/${session.value.id}/retry`)
    startPolling(); await refresh()
  } catch (error) { ElMessage.error((error as Error).message) } finally { starting.value = false }
}
function claimType(kind: string): string { return kind === 'code_fact' ? '代码事实' : kind === 'inference' ? '工程推断' : '需要你确认' }
function claimTag(kind: string): 'success' | 'warning' | 'info' { return kind === 'code_fact' ? 'success' : kind === 'inference' ? 'warning' : 'info' }
function stepLabel(step: CodeReadingSession['steps'][number]): string {
  if (step.kind === 'tool') return `读取 ${step.tool_name}`
  if (step.kind === 'final' && step.status === 'failed') return '结论证据不足，继续调查'
  return step.kind === 'final' ? '形成结论' : '分析下一步'
}
watch(open, value => { if (!value) stopPolling() })
onUnmounted(stopPolling)
</script>

<template>
  <el-dialog v-model="open" width="980px" top="5vh" destroy-on-close title="只读代码理解 Agent">
    <el-alert type="info" :closable="false" show-icon title="Agent 只能使用受限的只读目录、搜索和分段读取工具。它不会修改项目仓库，也不会把整个仓库发送给模型。" />
    <template v-if="project">
      <div class="project-name">当前项目：<strong>{{ project.name }}</strong></div>
      <el-input v-model="question" type="textarea" :rows="3" maxlength="2000" show-word-limit :disabled="running" placeholder="例如：请梳理这个项目的 AI 面试准备流程，并说明 LangGraph、模型结构化输出和人工确认分别解决了什么问题。" />
      <div class="mode-row"><el-radio-group v-model="mode" :disabled="running"><el-radio-button v-for="item in modeOptions" :key="item.value" :value="item.value">{{ item.label }}</el-radio-button></el-radio-group><span>{{ modeOptions.find(item => item.value === mode)?.hint }}</span><el-button type="primary" :loading="starting || running" @click="start">开始调查</el-button></div>
      <section v-if="session" class="session">
        <div class="progress"><el-tag :type="session.status === 'completed' ? 'success' : session.status === 'failed' ? 'danger' : session.status === 'cancelled' ? 'info' : 'warning'">{{ session.status === 'queued' ? '排队中' : session.status === 'running' ? '正在调查' : session.status === 'completed' ? '已完成' : session.status === 'cancelled' ? '已取消' : '失败' }}</el-tag><span>已调用 {{ session.tool_calls_used }} / {{ session.max_tool_calls }} 次工具 · 已读取 {{ Math.ceil(session.bytes_read / 1024) }} KB</span><el-button v-if="running" link type="danger" @click="cancel">取消调查</el-button><el-button v-if="session.status === 'failed' || session.status === 'cancelled'" link type="primary" :loading="starting" @click="retry">按原问题重试</el-button></div>
        <el-alert v-if="session.error_message" type="error" :closable="false" :title="session.error_message" />
        <template v-if="session.final">
          <article class="answer"><h3>{{ session.final.overview }}</h3><RichText :content="session.final.answer" /></article>
          <div class="claims"><h3>结论与证据边界</h3><article v-for="(claim, index) in session.claims" :key="index"><div><el-tag :type="claimTag(claim.claim_kind)" size="small">{{ claimType(claim.claim_kind) }}</el-tag><strong>{{ claim.statement }}</strong><span class="confidence">{{ claim.confidence }}</span></div><p v-if="claim.caveat">{{ claim.caveat }}</p><code v-if="claim.evidence_refs.length">依据：{{ claim.evidence_refs.join('、') }}</code></article></div>
          <div v-if="session.final.follow_up_questions.length" class="follow"><h3>建议你补充或确认</h3><ul><li v-for="item in session.final.follow_up_questions" :key="item">{{ item }}</li></ul></div>
        </template>
        <el-collapse v-if="session.evidence.length" class="evidence"><el-collapse-item title="查看代码证据" name="evidence"><article v-for="item in session.evidence" :key="item.evidence_ref"><strong>{{ item.evidence_ref }}</strong> <code>{{ item.relative_path }}:{{ item.start_line }}-{{ item.end_line }}</code><pre>{{ item.excerpt }}</pre></article></el-collapse-item></el-collapse>
        <div v-if="running" class="steps"><span v-for="step in session.steps" :key="step.id"><el-tag size="small" :type="step.status === 'failed' ? 'warning' : 'info'">{{ stepLabel(step) }}</el-tag></span></div>
      </section>
    </template>
  </el-dialog>
</template>

<style scoped>
.project-name { margin:16px 0 8px; }.mode-row { display:flex; align-items:center; gap:12px; margin:12px 0; }.mode-row span { flex:1; color:#909399; font-size:12px; }.session { border-top:1px solid #ebeef5; padding-top:14px; }.progress { display:flex; align-items:center; gap:10px; color:#606266; font-size:13px; margin-bottom:12px; }.answer,.claims,.follow { border:1px solid #e4e7ed; border-radius:8px; padding:14px 16px; margin-top:12px; background:#fff; }.answer h3,.claims h3,.follow h3 { margin:0 0 10px; font-size:16px; }.claims article { padding:10px 0; border-top:1px solid #f0f2f5; }.claims article:first-of-type { border-top:0; }.claims article>div { display:flex; align-items:center; gap:8px; }.claims p { color:#909399; margin:7px 0; font-size:13px; }.confidence { color:#909399; font-size:12px; }.follow ul { margin:0; padding-left:18px; line-height:1.8; }.evidence { margin-top:12px; }.evidence article { border-top:1px solid #f0f2f5; padding:10px 0; }.evidence pre { margin:8px 0 0; max-height:250px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; padding:10px; background:#f7f9fc; font-size:12px; line-height:1.5; }.steps { display:flex; flex-wrap:wrap; gap:6px; margin-top:12px; }
</style>
