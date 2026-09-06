<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { bumpData } from '../store'
import type { Resume } from '../types'

const visible = defineModel<boolean>({ default: false })
const resumes = ref<Resume[]>([])
const uploading = ref(false)
const uploadNote = ref('')
const textPreviewVisible = ref(false)
const textPreviewLoading = ref(false)
const textPreview = ref<{ filename: string; text: string; extraction_method: string | null; extraction_model: string | null; page_count: number | null } | null>(null)
let pollTimer: ReturnType<typeof setTimeout> | null = null

function active(item: Resume): boolean {
  return item.extraction_status === 'extracting' || (item.extraction_status === 'pending' && Boolean(item.started_at))
}

function status(item: Resume): { text: string; type: 'success' | 'warning' | 'danger' | 'info' } {
  if (item.extraction_status === 'completed') return { text: item.extraction_method === 'vision_pdf' ? '视觉提取完成' : '文字提取完成', type: 'success' }
  if (item.extraction_status === 'extracting') return { text: item.page_count ? `识别中 ${item.pages_completed || 0}/${item.page_count} 页` : '提取中', type: 'warning' }
  if (item.extraction_status === 'pending' && item.started_at) return { text: '等待开始', type: 'info' }
  if (item.extraction_status === 'unsupported') return { text: '格式暂不支持', type: 'warning' }
  if (item.extraction_status === 'failed') return { text: '提取失败', type: 'danger' }
  return { text: '尚未提取', type: 'info' }
}

const hasActive = computed(() => resumes.value.some(active))

async function load(): Promise<void> {
  try { resumes.value = await api.get<Resume[]>('/resumes') } catch (error) { ElMessage.error((error as Error).message) }
}

function stopPolling(): void {
  if (pollTimer) clearTimeout(pollTimer)
  pollTimer = null
}

function poll(): void {
  stopPolling()
  if (!visible.value || !hasActive.value) return
  pollTimer = setTimeout(async () => { await load(); poll() }, 1_500)
}

watch(visible, open => {
  if (open) { void load().then(poll) }
  else stopPolling()
})
watch(hasActive, () => poll())
onBeforeUnmount(stopPolling)

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploading.value = true
  try {
    await api.uploadResume(file, uploadNote.value.trim() || undefined)
    uploadNote.value = ''
    await load()
    bumpData()
    ElMessage.success('简历已上传，正在后台提取文字')
  } catch (error) { ElMessage.error((error as Error).message) }
  finally { uploading.value = false; input.value = '' }
}

async function retry(item: Resume): Promise<void> {
  try {
    await api.post(`/resumes/${item.id}/extract`)
    await load()
    ElMessage.success('已开始后台提取')
  } catch (error) { ElMessage.error((error as Error).message) }
}

function preview(item: Resume): void {
  window.open(`/api/resumes/${item.id}/file`, '_blank')
}

async function showExtractedText(item: Resume): Promise<void> {
  textPreviewVisible.value = true
  textPreviewLoading.value = true
  textPreview.value = null
  try {
    textPreview.value = await api.get(`/resumes/${item.id}/text`)
  } catch (error) {
    ElMessage.error((error as Error).message)
    textPreviewVisible.value = false
  } finally {
    textPreviewLoading.value = false
  }
}

async function remove(item: Resume): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除「${item.filename}」后，关联投递会取消该简历引用。确定继续吗？`, '删除简历', { type: 'warning' })
    await api.delete(`/resumes/${item.id}`)
    await load()
    bumpData()
    ElMessage.success('简历已删除')
  } catch (error) {
    if ((error as { toString(): string }).toString().includes('cancel')) return
    ElMessage.error((error as Error).message)
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="简历库" width="820px" top="8vh" append-to-body>
    <el-alert type="info" :closable="false" class="intro" title="先在这里上传和管理简历版本；完成文字提取后，可在新增投递或 AI 面试准备中选择对应版本。" />
    <div class="upload-bar">
      <el-input v-model="uploadNote" maxlength="80" placeholder="版本标签，如：AI 应用方向 / 后端方向" />
      <label class="upload-button" :class="{ disabled: uploading }">
        {{ uploading ? '上传中…' : '+ 上传简历' }}
        <input :disabled="uploading" type="file" accept=".pdf,.doc,.docx" @change="upload" />
      </label>
    </div>

    <el-empty v-if="!resumes.length" description="还没有简历版本，先上传一份吧" :image-size="75" />
    <div v-else class="resume-list">
      <article v-for="item in resumes" :key="item.id" class="resume-card">
        <div class="resume-main">
          <div class="resume-title"><b>{{ item.filename }}</b><el-tag size="small" :type="status(item).type">{{ status(item).text }}</el-tag></div>
          <div class="resume-meta">{{ item.note || '未标注版本用途' }} · {{ (item.size / 1024).toFixed(1) }} KB</div>
          <div v-if="item.extraction_status === 'completed'" class="extraction-meta">
            {{ item.extraction_method === 'vision_pdf' ? '视觉模型' : '本地 DOCX' }}{{ item.page_count ? ` · ${item.page_count} 页` : '' }}{{ item.extraction_model ? ` · ${item.extraction_model}` : '' }}
          </div>
          <div v-if="active(item)" class="progress-line">{{ status(item).text }}，可关闭窗口，任务会继续执行。</div>
          <div v-if="item.extraction_error" class="resume-error">{{ item.extraction_error }}</div>
        </div>
        <div class="resume-actions">
          <el-button link type="primary" @click="preview(item)">预览</el-button>
          <el-button v-if="item.extraction_status === 'completed'" link type="primary" @click="showExtractedText(item)">查看提取文字</el-button>
          <el-button v-if="!active(item) && item.extraction_status !== 'completed'" link type="warning" @click="retry(item)">{{ item.extraction_status === 'pending' ? '提取文字' : '重新提取' }}</el-button>
          <el-button link type="danger" @click="remove(item)">删除</el-button>
        </div>
      </article>
    </div>
    <el-dialog v-model="textPreviewVisible" :title="textPreview ? `提取文字：${textPreview.filename}` : '提取文字'" width="760px" append-to-body>
      <el-skeleton v-if="textPreviewLoading" :rows="8" animated />
      <template v-else-if="textPreview">
        <el-alert :closable="false" type="info" class="text-intro" title="这是用于 AI 面试准备的本地提取结果。请与原始简历预览核对；发现遗漏或错误可关闭后重新提取。" />
        <div class="text-meta">{{ textPreview.extraction_method === 'vision_pdf' ? 'PDF 视觉模型提取' : 'DOCX 本地文字提取' }}{{ textPreview.page_count ? ` · ${textPreview.page_count} 页` : '' }}{{ textPreview.extraction_model ? ` · ${textPreview.extraction_model}` : '' }}</div>
        <pre class="extracted-text">{{ textPreview.text }}</pre>
      </template>
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.intro { margin-bottom: 14px; }
.upload-bar { display: flex; gap: 10px; margin-bottom: 16px; }
.upload-button { flex: 0 0 auto; padding: 8px 14px; border-radius: 4px; cursor: pointer; color: #fff; background: #409eff; font-size: 14px; white-space: nowrap; }
.upload-button:hover { background: #66b1ff; }
.upload-button.disabled { cursor: not-allowed; opacity: .65; }
.upload-button input { display: none; }
.resume-list { display: grid; gap: 10px; max-height: 470px; overflow: auto; padding-right: 3px; }
.resume-card { display: flex; justify-content: space-between; gap: 14px; padding: 13px 14px; border: 1px solid #e4e7ed; border-radius: 8px; background: #fff; }
.resume-main { min-width: 0; }
.resume-title { display: flex; align-items: center; gap: 8px; min-width: 0; }
.resume-title b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.resume-meta, .progress-line, .extraction-meta { margin-top: 6px; color: #909399; font-size: 13px; }
.extraction-meta { color: #67c23a; }
.progress-line { color: #409eff; }
.resume-error { margin-top: 6px; color: #f56c6c; font-size: 12px; }
.resume-actions { display: flex; align-items: flex-start; gap: 3px; white-space: nowrap; }
.resume-actions .el-button + .el-button { margin-left: 0; }
.text-intro { margin-bottom: 10px; }
.text-meta { margin-bottom: 10px; color: #909399; font-size: 13px; }
.extracted-text { max-height: 55vh; margin: 0; overflow: auto; padding: 14px; border-radius: 6px; background: #f7f8fa; color: #303133; white-space: pre-wrap; word-break: break-word; font: 13px/1.7 ui-monospace, SFMono-Regular, Consolas, monospace; }
@media (max-width: 700px) { .resume-card { display: block; } .resume-actions { margin-top: 8px; } }
</style>
