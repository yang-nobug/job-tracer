<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'

// 上传面试录音：选面试记录 + 拖入音频，上传后服务端异步跑转写+复盘管道

const props = defineProps<{ open: boolean; interviews: { id: number; company: string; round: string; scheduled_at: string }[] }>()
const emit = defineEmits<{ (e: 'update:open', v: boolean): void; (e: 'uploaded'): void }>()

const visible = computed({
  get: () => props.open,
  set: (v: boolean) => emit('update:open', v)
})

const AUDIO_EXTS = ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.webm', '.amr']
const MAX_SIZE = 300 * 1024 * 1024

const interviewId = ref<number | null>(null)
const file = ref<File | null>(null)
const dragging = ref(false)
const uploading = ref(false)
const fileInput = ref<HTMLInputElement>()

watch(
  () => props.open,
  (open) => {
    if (open) {
      interviewId.value = null
      file.value = null
      uploading.value = false
    }
  }
)

function pickAudio(f: File | null | undefined): void {
  if (!f) return
  const dot = f.name.lastIndexOf('.')
  const ext = dot >= 0 ? f.name.slice(dot).toLowerCase() : ''
  if (!AUDIO_EXTS.includes(ext)) {
    ElMessage.error('仅支持音频文件（mp3/wav/ogg/m4a/aac/webm/amr）')
    return
  }
  if (f.size > MAX_SIZE) {
    ElMessage.error('文件超过 300MB，请压缩后再上传')
    return
  }
  file.value = f
}

function onDrop(event: DragEvent): void {
  dragging.value = false
  pickAudio(event.dataTransfer?.files?.[0])
}

function onFileInput(event: Event): void {
  const input = event.target as HTMLInputElement
  pickAudio(input.files?.[0])
  input.value = ''
}

function fmtSize(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(bytes / 1024)}KB`
}

async function submit(): Promise<void> {
  if (!interviewId.value) {
    ElMessage.warning('先选择这场录音对应的面试记录')
    return
  }
  if (!file.value) {
    ElMessage.warning('请选择录音文件')
    return
  }
  uploading.value = true
  try {
    await api.uploadRecording(interviewId.value, file.value)
    ElMessage.success('上传成功，转写完成后复盘和面经会自动生成（本页可看进度）')
    emit('uploaded')
    visible.value = false
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    uploading.value = false
  }
}
</script>

<template>
  <el-dialog v-model="visible" title="上传面试录音" width="480px" :close-on-click-modal="false">
    <el-form label-width="80px">
      <el-form-item label="面试记录">
        <el-select v-model="interviewId" placeholder="选这场录音对应的面试" filterable style="width: 100%">
          <el-option
            v-for="iv in interviews"
            :key="iv.id"
            :value="iv.id"
            :label="`${iv.company} · ${iv.round}（${iv.scheduled_at}）`"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="录音文件">
        <div
          class="drop-zone"
          :class="{ 'drag-over': dragging, filled: !!file }"
          @dragenter="dragging = true"
          @dragleave="dragging = false"
          @dragover.prevent
          @drop.prevent="onDrop"
          @click="fileInput?.click()"
        >
          <template v-if="file">
            <div class="file-name">🎵 {{ file.name }}</div>
            <div class="file-size">{{ fmtSize(file.size) }} · 点击可重选</div>
          </template>
          <template v-else>
            <div class="drop-tip">把录音文件拖到这里，或点击选择</div>
            <div class="drop-sub">支持 mp3 / wav / ogg / m4a / aac / webm，≤300MB</div>
          </template>
          <input ref="fileInput" type="file" :accept="AUDIO_EXTS.join(',')" hidden @change="onFileInput" />
        </div>
      </el-form-item>
    </el-form>
    <div class="flow-tip">
      上传后自动：转写全文 → AI 分析生成复盘 → 题目入库「我的面试」面经。长录音需要几分钟，可以关掉弹窗去干别的。
    </div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="uploading" @click="submit">上传并开始转写</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.drop-zone {
  width: 100%;
  min-height: 80px;
  border: 1.5px dashed #c0c4cc;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  cursor: pointer;
  padding: 12px;
  box-sizing: border-box;
  transition: border-color 0.2s, background 0.2s;
}
.drop-zone:hover { border-color: #409eff; }
.drop-zone.drag-over { border-color: #409eff; background: #ecf5ff; }
.drop-zone.filled { border-style: solid; border-color: #409eff; background: #f5f9ff; }
.drop-tip { color: #606266; font-size: 13px; }
.drop-sub { color: #909399; font-size: 12px; }
.file-name { font-size: 14px; color: #303133; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { color: #909399; font-size: 12px; }
.flow-tip { color: #909399; font-size: 12px; line-height: 1.6; margin: 4px 0 0 80px; }
</style>
