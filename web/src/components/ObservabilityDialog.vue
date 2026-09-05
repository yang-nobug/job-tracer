<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

interface OperationRun {
  id: number
  trace_id: string
  operation_type: string
  trigger_type: string
  status: string
  error_code: string | null
  error_message: string | null
  started_at: string
  duration_ms: number | null
}
interface RunDetail { run: OperationRun; steps: any[]; logs: any[]; aiCalls: any[] }

const props = defineProps<{ modelValue: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
const visible = computed({ get: () => props.modelValue, set: value => emit('update:modelValue', value) })
const loading = ref(false)
const runs = ref<OperationRun[]>([])
const detail = ref<RunDetail | null>(null)
const detailOpen = ref(false)

function time(value: string): string { return new Date(value).toLocaleString('zh-CN', { hour12: false }) }
function duration(value: number | null): string { return value == null ? '运行中' : `${(value / 1000).toFixed(1)} 秒` }
function statusType(status: string): 'success' | 'warning' | 'danger' | 'info' {
  return status === 'succeeded' ? 'success' : status === 'partial_success' ? 'warning' : status === 'failed' ? 'danger' : 'info'
}
async function load(): Promise<void> {
  loading.value = true
  try { runs.value = await api.get<OperationRun[]>('/observability/runs?limit=50') }
  catch (error) { ElMessage.error((error as Error).message) }
  finally { loading.value = false }
}
async function showDetail(id: number): Promise<void> {
  try { detail.value = await api.get<RunDetail>(`/observability/runs/${id}`); detailOpen.value = true }
  catch (error) { ElMessage.error((error as Error).message) }
}
watch(() => props.modelValue, open => { if (open) void load() })
</script>

<template>
  <el-dialog v-model="visible" title="运行与日志" width="1060px" destroy-on-close>
    <p class="hint">这里展示可追踪的长任务。展开后可查看步骤、错误和关联的 AI 调用；普通请求日志只用于本机诊断。</p>
    <div class="toolbar"><el-button size="small" :loading="loading" @click="load">刷新</el-button></div>
    <el-table v-loading="loading" :data="runs" size="small" max-height="460">
      <el-table-column label="时间" width="175"><template #default="s">{{ time(s.row.started_at) }}</template></el-table-column>
      <el-table-column prop="operation_type" label="任务" min-width="185" show-overflow-tooltip />
      <el-table-column label="状态" width="110"><template #default="s"><el-tag size="small" :type="statusType(s.row.status)">{{ s.row.status }}</el-tag></template></el-table-column>
      <el-table-column label="耗时" width="90"><template #default="s">{{ duration(s.row.duration_ms) }}</template></el-table-column>
      <el-table-column prop="error_code" label="错误码" min-width="150" show-overflow-tooltip />
      <el-table-column label="详情" width="75"><template #default="s"><el-button link type="primary" @click="showDetail(s.row.id)">查看</el-button></template></el-table-column>
    </el-table>
    <el-empty v-if="!loading && !runs.length" description="还没有可追踪的运行任务" :image-size="70" />
    <el-dialog v-model="detailOpen" title="运行链路详情" width="920px" append-to-body>
      <template v-if="detail">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="任务">{{ detail.run.operation_type }}</el-descriptions-item>
          <el-descriptions-item label="链路 ID"><code>{{ detail.run.trace_id }}</code></el-descriptions-item>
          <el-descriptions-item label="状态">{{ detail.run.status }}</el-descriptions-item>
          <el-descriptions-item label="耗时">{{ duration(detail.run.duration_ms) }}</el-descriptions-item>
        </el-descriptions>
        <h4>执行步骤</h4>
        <el-timeline v-if="detail.steps.length">
          <el-timeline-item v-for="step in detail.steps" :key="step.id" :type="statusType(step.status)" :timestamp="time(step.started_at)">
            <b>{{ step.step_name }}</b> · {{ step.status }}<span v-if="step.duration_ms != null"> · {{ duration(step.duration_ms) }}</span>
            <div v-if="step.error_code" class="error">{{ step.error_code }}：{{ step.error_message }}</div>
          </el-timeline-item>
        </el-timeline>
        <el-empty v-else description="该任务尚未写入步骤" :image-size="45" />
        <h4>关联 AI 调用（{{ detail.aiCalls.length }}）</h4>
        <el-table :data="detail.aiCalls" size="small" max-height="220">
          <el-table-column prop="stage" label="阶段" min-width="180" />
          <el-table-column prop="model" label="模型" min-width="150" />
          <el-table-column prop="status" label="状态" width="130" />
          <el-table-column label="耗时" width="85"><template #default="s">{{ duration(s.row.duration_ms) }}</template></el-table-column>
        </el-table>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.hint { margin: 0 0 12px; color: #606266; font-size: 13px; line-height: 1.7; }
.toolbar { margin-bottom: 10px; text-align: right; }
h4 { margin: 20px 0 10px; }
.error { margin-top: 5px; color: #f56c6c; white-space: pre-wrap; }
code { font-size: 12px; overflow-wrap: anywhere; }
</style>
