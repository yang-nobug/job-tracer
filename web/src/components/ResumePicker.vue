<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { Resume } from '../types'

const model = defineModel<number | null>({ default: null })
const props = defineProps<{ reloadTrigger?: number }>()

const resumes = ref<Resume[]>([])
const selectedResume = computed(() => resumes.value.find(item => item.id === model.value) ?? null)
const uploadNote = ref('')
let pollTimer: ReturnType<typeof setTimeout> | null = null

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function resumeStatus(resume: Resume): string {
  if (resume.extraction_status === 'pending' && resume.started_at) return '等待开始提取…'
  if (resume.extraction_status === 'extracting' && resume.page_count) return `正在识别第 ${resume.pages_completed || 0}/${resume.page_count} 页…`
  if (resume.extraction_status === 'extracting') return '正在提取文字…'
  return ''
}

function extractionIsActive(resume: Resume): boolean {
  return resume.extraction_status === 'extracting' || (resume.extraction_status === 'pending' && Boolean(resume.started_at))
}

async function load(): Promise<void> {
  try {
    resumes.value = await api.get<Resume[]>('/resumes')
  } catch { /* 忽略 */ }
}

async function pollUntilFinished(resumeId: number): Promise<void> {
  stopPolling()
  const current = resumes.value.find(item => item.id === resumeId)
  if (!current || !extractionIsActive(current)) return
  pollTimer = setTimeout(async () => {
    await load()
    const latest = resumes.value.find(item => item.id === resumeId)
    if (latest?.extraction_status === 'completed') ElMessage.success('简历文字提取完成，可用于 AI 面试准备')
    else if (latest?.extraction_status === 'failed' || latest?.extraction_status === 'unsupported') ElMessage.warning(latest.extraction_error || '简历文字提取失败')
    else await pollUntilFinished(resumeId)
  }, 1_500)
}

watch(
  () => props.reloadTrigger,
  () => load(),
  { immediate: true }
)

async function onUpload(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const r = (await api.uploadResume(file, uploadNote.value.trim() || undefined)) as Resume
    ElMessage.success('简历已上传，正在后台提取文字')
    await load()
    model.value = r.id
    void pollUntilFinished(r.id)
    uploadNote.value = ''
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    input.value = ''
  }
}

async function extract(): Promise<void> {
  if (!model.value) return
  try {
    const result = await api.post<Resume>(`/resumes/${model.value}/extract`)
    await load()
    ElMessage.info('已开始后台提取，完成后会自动更新')
    void pollUntilFinished(result.id)
  } catch (error) { ElMessage.error((error as Error).message) }
}

function preview(): void {
  if (model.value) {
    window.open(`/api/resumes/${model.value}/file`, '_blank')
  }
}

onBeforeUnmount(stopPolling)
</script>

<template>
  <div class="resume-picker">
    <el-select v-model="model" placeholder="选择简历（可选）" clearable style="flex: 1">
      <el-option v-for="r in resumes" :key="r.id" :label="r.filename" :value="r.id" />
    </el-select>
    <el-input v-model="uploadNote" maxlength="80" placeholder="版本标签，如：AI 应用方向" class="resume-note" />
    <label class="upload-btn">
      上传
      <input type="file" accept=".pdf,.doc,.docx" @change="onUpload" />
    </label>
    <el-button v-if="model" link type="primary" @click="preview">预览</el-button>
    <el-button v-if="selectedResume && !extractionIsActive(selectedResume) && selectedResume.extraction_status !== 'completed'" link type="warning" @click="extract">{{ selectedResume.extraction_status === 'failed' || selectedResume.extraction_status === 'unsupported' ? '重新提取' : '提取文字' }}</el-button>
    <el-tag v-else-if="selectedResume?.extraction_status === 'completed'" size="small" type="success">可用于 AI 准备</el-tag>
  </div>
  <div v-if="selectedResume && extractionIsActive(selectedResume)" class="extracting-status">{{ resumeStatus(selectedResume) }}</div>
  <div v-if="selectedResume?.extraction_error" class="extract-error">{{ selectedResume.extraction_error }}</div>
</template>

<style scoped>
.resume-picker { display: flex; gap: 8px; width: 100%; align-items: center; }
.resume-note { max-width: 190px; }
.upload-btn {
  border: 1px solid #dcdfe6; border-radius: 4px; padding: 5px 12px; cursor: pointer;
  font-size: 13px; color: #606266; white-space: nowrap; background: #fff;
}
.upload-btn:hover { color: #409eff; border-color: #c6e2ff; }
.upload-btn input { display: none; }
.extract-error { width:100%; color:#e6a23c; font-size:12px; margin-top:4px; }
.extracting-status { width:100%; color:#409eff; font-size:12px; margin-top:4px; }
</style>
