<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

interface TaskSetting {
  task: string
  label: string
  data: string
  visible: boolean
  enabled: boolean
  configured: boolean
}

interface SettingsResponse {
  provider: string
  tasks: TaskSetting[]
  recording: { ossConfigured: boolean; asrConfigured: boolean }
}

interface AiCallRecord {
  id: number
  task: string
  stage: string
  attempt: number
  retry_of_call_id: number | null
  model: string | null
  duration_ms: number
  total_tokens: number | null
  status: 'succeeded' | 'validation_failed' | 'provider_failed'
  error_type: string | null
  error_message: string | null
  created_at: string
}

interface AiCallDetail extends AiCallRecord {
  prompt_hash: string
  provider_request_id: string | null
  provider_attempts: number | null
  finish_reason: string | null
  prompt_tokens: number | null
  completion_tokens: number | null
  request_messages_json: string
  response_schema_json: string | null
  request_options_json: string
  raw_response: string | null
  parsed_response_json: string | null
  validated_response_json: string | null
  finished_at: string
}

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const loading = ref(false)
const tasks = ref<TaskSetting[]>([])
const calls = ref<AiCallRecord[]>([])
const selectedCall = ref<AiCallDetail | null>(null)
const detailLoading = ref(false)
const detailOpen = ref(false)
const recording = ref<SettingsResponse['recording']>({ ossConfigured: false, asrConfigured: false })
const saving = ref(new Set<string>())

function taskLabel(task: string): string {
  return tasks.value.find(item => item.task === task)?.label ?? task
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [settings, recentRuns] = await Promise.all([
      api.get<SettingsResponse>('/ai/settings'),
      api.get<AiCallRecord[]>('/ai/calls?limit=30')
    ])
    tasks.value = settings.tasks.filter(task => task.visible)
    recording.value = settings.recording
    calls.value = recentRuns
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    loading.value = false
  }
}

async function showCall(id: number): Promise<void> {
  detailLoading.value = true
  detailOpen.value = true
  try { selectedCall.value = await api.get<AiCallDetail>(`/ai/calls/${id}`) }
  catch (error) { ElMessage.error((error as Error).message) }
  finally { detailLoading.value = false }
}

function pretty(value: string | null): string {
  if (!value) return '—'
  try { return JSON.stringify(JSON.parse(value), null, 2) } catch { return value }
}

function statusLabel(status: AiCallRecord['status']): string {
  return status === 'succeeded' ? '通过' : status === 'validation_failed' ? '结构失败' : '调用失败'
}

async function changeTask(task: TaskSetting, enabled: string | number | boolean): Promise<void> {
  const next = Boolean(enabled)
  const previous = !next
  saving.value = new Set(saving.value).add(task.task)
  try {
    await api.put(`/ai/settings/${task.task}`, { enabled: next })
  } catch (error) {
    task.enabled = previous
    ElMessage.error((error as Error).message)
  } finally {
    const nextSaving = new Set(saving.value)
    nextSaving.delete(task.task)
    saving.value = nextSaving
  }
}

watch(() => props.modelValue, open => { if (open) void load() })
</script>

<template>
  <el-dialog v-model="visible" title="AI 数据说明与功能开关" width="820px" top="6vh" append-to-body>
    <div v-loading="loading" class="privacy-body">
      <el-alert
        type="info"
        :closable="false"
        title="所有开关保存在本机。关闭某项后，该任务会在发送数据前直接停止；手动录入、浏览和编辑等非 AI 功能仍可使用。"
      />

      <h3>各功能会发送的数据</h3>
      <div class="task-list">
        <div v-for="task in tasks" :key="task.task" class="task-row">
          <div class="task-copy">
            <div>
              <b>{{ task.label }}</b>
              <el-tag v-if="!task.configured" size="small" type="info">未配置</el-tag>
            </div>
            <p>{{ task.data }} → 火山方舟</p>
          </div>
          <el-switch
            v-model="task.enabled"
            :loading="saving.has(task.task)"
            active-text="启用"
            inactive-text="停用"
            @change="value => changeTask(task, value)"
          />
        </div>
      </div>

      <h3>录音复盘的额外流转</h3>
      <p class="explain">
        原录音保存在本机，并临时上传到配置的私有 OSS，语音识别服务通过签名地址读取；正常转写结束后程序会立即尝试删除 OSS 对象。转写文本再发送至火山方舟。若进程异常退出，仍建议在 OSS 侧配置生命周期清理规则。
      </p>
      <div class="service-tags">
        <el-tag :type="recording.ossConfigured ? 'success' : 'info'">OSS {{ recording.ossConfigured ? '已配置' : '未配置' }}</el-tag>
        <el-tag :type="recording.asrConfigured ? 'success' : 'info'">ASR {{ recording.asrConfigured ? '已配置' : '未配置' }}</el-tag>
      </div>

      <h3>本机 AI 调用审计</h3>
      <p class="explain">保存每次调用的完整文字输入、模型原始输出、结构校验结果和重试关系，最多保留最近 5000 次。图片不会重复保存 Base64，只记录本地材料指纹；日志可能含招聘、复盘和邮件内容，请仅在本机查看。</p>
      <el-table v-if="calls.length" :data="calls" size="small" max-height="250">
        <el-table-column label="时间" width="170">
          <template #default="scope">{{ formatTime(scope.row.created_at) }}</template>
        </el-table-column>
        <el-table-column label="任务" min-width="130">
          <template #default="scope">{{ taskLabel(scope.row.task) }}</template>
        </el-table-column>
        <el-table-column prop="stage" label="阶段" min-width="130" show-overflow-tooltip />
        <el-table-column prop="model" label="模型" min-width="150" show-overflow-tooltip />
        <el-table-column label="耗时" width="90">
          <template #default="scope">{{ (scope.row.duration_ms / 1000).toFixed(1) }}s</template>
        </el-table-column>
        <el-table-column prop="total_tokens" label="Token" width="80" />
        <el-table-column label="状态" width="90">
          <template #default="scope">
            <el-tag :type="scope.row.status === 'succeeded' ? 'success' : 'danger'" size="small">
              {{ statusLabel(scope.row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="详情" width="70">
          <template #default="scope"><el-button link type="primary" @click="showCall(scope.row.id)">查看</el-button></template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="还没有 AI 调用记录" :image-size="60" />
    </div>

    <el-dialog v-model="detailOpen" title="AI 调用详情" width="900px" append-to-body>
      <div v-loading="detailLoading" class="call-detail" v-if="selectedCall">
        <p><b>{{ taskLabel(selectedCall.task) }}</b> · {{ selectedCall.stage }} · 第 {{ selectedCall.attempt }} 次调用</p>
        <el-alert v-if="selectedCall.error_message" type="error" :closable="false" :title="selectedCall.error_message" />
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="模型">{{ selectedCall.model || '—' }}</el-descriptions-item>
          <el-descriptions-item label="耗时">{{ (selectedCall.duration_ms / 1000).toFixed(1) }}s</el-descriptions-item>
          <el-descriptions-item label="Token">{{ selectedCall.total_tokens ?? '—' }}</el-descriptions-item>
          <el-descriptions-item label="服务重试">{{ selectedCall.provider_attempts ?? 1 }} 次请求</el-descriptions-item>
          <el-descriptions-item label="重试来源" :span="3">{{ selectedCall.retry_of_call_id ? `调用 #${selectedCall.retry_of_call_id}` : '首次调用' }}</el-descriptions-item>
        </el-descriptions>
        <details open><summary>请求消息</summary><pre>{{ pretty(selectedCall.request_messages_json) }}</pre></details>
        <details><summary>结构 Schema</summary><pre>{{ pretty(selectedCall.response_schema_json) }}</pre></details>
        <details open><summary>模型原始输出</summary><pre>{{ selectedCall.raw_response || '—' }}</pre></details>
        <details><summary>解析后的 JSON</summary><pre>{{ pretty(selectedCall.parsed_response_json) }}</pre></details>
        <details><summary>通过校验后的结果</summary><pre>{{ pretty(selectedCall.validated_response_json) }}</pre></details>
      </div>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.privacy-body { min-height: 240px; }
h3 { margin: 20px 0 10px; font-size: 15px; }
.task-list { border: 1px solid #ebeef5; border-radius: 8px; overflow: hidden; }
.task-row { display: flex; align-items: center; justify-content: space-between; gap: 24px; padding: 12px 14px; border-bottom: 1px solid #ebeef5; }
.task-row:last-child { border-bottom: 0; }
.task-copy { min-width: 0; }
.task-copy b { margin-right: 8px; }
.task-copy p, .explain { margin: 5px 0 0; color: #606266; font-size: 12px; line-height: 1.7; }
.service-tags { display: flex; gap: 8px; margin-top: 10px; }
.call-detail { max-height: 70vh; overflow: auto; }
.call-detail details { margin-top: 12px; }
.call-detail summary { cursor: pointer; color: #409eff; font-weight: 600; }
.call-detail pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 260px; overflow: auto; padding: 10px; border-radius: 6px; background: #f5f7fa; font-size: 12px; line-height: 1.5; }
</style>
