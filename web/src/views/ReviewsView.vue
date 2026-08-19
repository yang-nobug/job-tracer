<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import type { Interview, RecordingRow, RecordingStatus } from '../types'
import { RECORDING_STATUS_LABELS, RECORDING_STATUS_TAG_TYPES } from '../types'
import ReviewEditor from '../components/ReviewEditor.vue'
import RecordingUploadDialog from '../components/RecordingUploadDialog.vue'

interface ReviewRow extends Interview {
  application_id: number
  company: string
  position: string
}

const rows = ref<ReviewRow[]>([])
const loading = ref(true)
const editing = ref<ReviewRow | null>(null)

// ---- 录音复盘管道 ----
const recordings = ref<RecordingRow[]>([])
const uploadOpen = ref(false)
const transcriptOpen = ref<Record<number, boolean>>({})
const transcriptCache = ref<Record<number, string>>({})
let pollTimer: ReturnType<typeof setInterval> | null = null

const ACTIVE_STATUSES: RecordingStatus[] = ['uploading', 'transcribing', 'analyzing']
const hasActive = computed(() => recordings.value.some((r) => ACTIVE_STATUSES.includes(r.status)))

async function loadRecordings(): Promise<void> {
  try {
    recordings.value = (await api.get<RecordingRow[]>('/recordings')) as RecordingRow[]
  } catch {
    /* 轮询失败静默，下一轮再试 */
  }
}

function syncPolling(): void {
  const need = hasActive.value
  if (need && !pollTimer) {
    pollTimer = setInterval(async () => {
      const before = new Map(recordings.value.map((r) => [r.id, r.status]))
      await loadRecordings()
      // 有任务刚变成 done 才提示（全失败收尾不打扰）
      const justDone = recordings.value.some((r) => before.get(r.id) !== 'done' && r.status === 'done')
      if (justDone) ElMessage.success('录音处理完成，复盘已更新')
      if (!hasActive.value && pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }, 3000)
  } else if (!need && pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

async function retryRecording(rec: RecordingRow): Promise<void> {
  try {
    await api.post(`/recordings/${rec.id}/retry`)
    ElMessage.success('已重新开始处理')
    await loadRecordings()
    syncPolling()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

function removeRecording(rec: RecordingRow): void {
  ElMessageBox.confirm(`删除录音「${rec.filename}」？已生成的复盘和面经不受影响`, '提示', { type: 'warning' })
    .then(async () => {
      try {
        await api.delete(`/recordings/${rec.id}`)
        await loadRecordings()
      } catch (err) {
        ElMessage.error((err as Error).message)
      }
    })
    .catch(() => {})
}

/** 展开转写全文（懒加载，缓存） */
async function toggleTranscript(rec: RecordingRow): Promise<void> {
  const open = !transcriptOpen.value[rec.id]
  transcriptOpen.value = { ...transcriptOpen.value, [rec.id]: open }
  if (open && transcriptCache.value[rec.id] === undefined) {
    try {
      const detail = await api.get<{ transcript: string | null }>(`/recordings/${rec.id}`)
      transcriptCache.value = { ...transcriptCache.value, [rec.id]: detail.transcript || '（无转写内容）' }
    } catch (err) {
      transcriptCache.value = { ...transcriptCache.value, [rec.id]: `加载失败：${(err as Error).message}` }
    }
  }
}

function fmtSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`
}

onMounted(async () => {
  try {
    // /reviews 返回的行结构含 application_id/company/position
    rows.value = (await api.get<ReviewRow[]>('/reviews')) as ReviewRow[]
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
  await loadRecordings()
  syncPolling()
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<template>
  <div v-loading="loading">
    <div class="toolbar">
      <el-button type="primary" @click="uploadOpen = true">⬆ 上传录音</el-button>
      <span class="toolbar-tip">录音自动转写 -> AI 生成复盘 -> 题目入库面经</span>
    </div>

    <!-- 录音处理列表（含进行中状态） -->
    <div v-if="recordings.length" class="recording-list">
      <el-card v-for="rec in recordings" :key="rec.id" shadow="never" class="rec-card">
        <div class="r-row">
          <el-tag :type="RECORDING_STATUS_TAG_TYPES[rec.status]" size="small" effect="dark">
            {{ RECORDING_STATUS_LABELS[rec.status] }}
          </el-tag>
          <span class="r-company">{{ rec.company }}</span>
          <el-tag size="small" type="info">{{ rec.round }}</el-tag>
          <span class="rec-name">🎵 {{ rec.filename }}（{{ fmtSize(rec.size) }}）</span>
          <span class="r-spacer" />
          <el-button
            v-if="rec.status === 'failed'"
            size="small"
            type="primary"
            plain
            @click="retryRecording(rec)"
          >重试</el-button>
          <el-button
            v-if="rec.has_transcript"
            size="small"
            link
            @click="toggleTranscript(rec)"
          >{{ transcriptOpen[rec.id] ? '收起转写' : '查看转写' }}</el-button>
          <el-button size="small" link type="danger" @click="removeRecording(rec)">删除</el-button>
        </div>
        <div v-if="rec.status === 'failed' && rec.error" class="rec-error">失败原因：{{ rec.error }}</div>
        <div v-if="rec.status === 'done'" class="rec-done">
          ✅ 复盘已生成，题目已入库「我的面试」面经
        </div>
        <pre v-if="transcriptOpen[rec.id]" class="transcript">{{ transcriptCache[rec.id] ?? '加载中…' }}</pre>
      </el-card>
    </div>

    <el-empty v-if="!rows.length && !loading" description="还没有面试复盘，去详情里添加面试吧" />
    <div v-else class="review-list">
      <el-card v-for="row in rows" :key="row.id" shadow="never" class="review-card" @click="editing = row">
        <div class="r-row">
          <span class="r-company">{{ row.company }}</span>
          <el-tag size="small">{{ row.round }}</el-tag>
          <el-tag v-if="row.done" type="success" size="small">已完成</el-tag>
          <span class="r-spacer" />
          <span class="r-time">{{ row.scheduled_at }}</span>
        </div>
        <div class="r-position">{{ row.position }}</div>
      </el-card>
    </div>

    <ReviewEditor
      v-if="editing"
      :interview="{ ...editing, checklist: [] }"
      @closed="editing = null"
    />

    <RecordingUploadDialog v-model:open="uploadOpen" :interviews="rows" @uploaded="loadRecordings().then(syncPolling)" />
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.toolbar-tip { color: #909399; font-size: 12px; }
.recording-list { display: flex; flex-direction: column; gap: 10px; max-width: 720px; margin-bottom: 18px; }
.rec-card :deep(.el-card__body) { padding: 12px 14px; }
.rec-name { color: #606266; font-size: 13px; }
.rec-error { color: #f56c6c; font-size: 12px; margin-top: 6px; }
.rec-done { color: #67c23a; font-size: 12px; margin-top: 6px; }
.transcript {
  margin: 8px 0 0;
  padding: 10px;
  background: #f5f7fa;
  border-radius: 6px;
  color: #606266;
  font-size: 12px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}
.review-list { display: flex; flex-direction: column; gap: 10px; max-width: 720px; }
.review-card { cursor: pointer; }
.review-card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
.r-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.r-company { font-weight: 600; font-size: 15px; }
.r-spacer { flex: 1; }
.r-time { color: #909399; font-size: 13px; }
.r-position { color: #606266; font-size: 13px; margin-top: 4px; }
</style>
