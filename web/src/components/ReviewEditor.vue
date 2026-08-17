<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import MarkdownIt from 'markdown-it'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { Interview } from '../types'

const props = defineProps<{ interview: Interview }>()
const emit = defineEmits<(e: 'closed') => void>()

const md = new MarkdownIt()
const content = ref('')
const editMode = ref(false)
const draft = ref('')
const loading = ref(true)
const saving = ref(false)

const title = computed(() => {
  const label = props.interview.review_file || '复盘'
  return `📝 ${label}`
})

const rendered = computed(() => md.render(content.value))

onMounted(async () => {
  try {
    const r = await api.get<{ content: string }>(`/interviews/$glm-5.3_common/review`)
    content.value = r.content
    draft.value = r.content
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
})

function startEdit(): void {
  draft.value = content.value
  editMode.value = true
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await api.put(`/interviews/$glm-5.3_common/review`, { content: draft.value })
    content.value = draft.value
    editMode.value = false
    ElMessage.success('已保存')
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    saving.value = false
  }
}

async function reloadFromDisk(): Promise<void> {
  try {
    const r = await api.get<{ content: string }>(`/interviews/$glm-5.3_common/review`)
    content.value = r.content
    draft.value = r.content
    ElMessage.success('已从磁盘刷新')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

// AI 点评（火山方舟，需在 config.json 配置）
const adviceOpen = ref(false)
const advice = ref('')
const advising = ref(false)

async function askAdvice(): Promise<void> {
  advising.value = true
  advice.value = ''
  adviceOpen.value = true
  try {
    const r = await api.post<{ advice: string }>('/ai/review-advice', {
      interviewId: props.interview.id
    })
    advice.value = r.advice
  } catch (err) {
    ElMessage.error((err as Error).message)
    adviceOpen.value = false
  } finally {
    advising.value = false
  }
}

const visible = ref(true)
function onClose(): void {
  visible.value = false
  emit('closed')
}
</script>

<template>
  <el-dialog
    :model-value="visible"
    :title="title"
    width="760px"
    top="6vh"
    destroy-on-close
    @update:model-value="onClose"
  >
    <div v-loading="loading" class="review-editor">
      <template v-if="!editMode">
        <div class="preview md-body" v-html="rendered" />
      </template>
      <template v-else>
        <div class="edit-grid">
          <el-input v-model="draft" type="textarea" :rows="20" class="edit-area" />
          <div class="preview md-body" v-html="md.render(draft)" />
        </div>
      </template>
    </div>
    <template #footer>
      <div class="footer-bar">
        <span class="hint">也可以直接用本地编辑器修改磁盘上的 md 文件</span>
        <div>
          <el-button v-if="!editMode" size="small" type="warning" plain :loading="advising" @click="askAdvice">
            ✨ AI 点评
          </el-button>
          <el-button v-if="!editMode" size="small" @click="reloadFromDisk">↻ 从磁盘刷新</el-button>
          <el-button v-if="editMode" @click="editMode = false">取消编辑</el-button>
          <el-button v-if="!editMode" type="primary" @click="startEdit">编辑</el-button>
          <el-button v-else type="primary" :loading="saving" @click="save">保存</el-button>
        </div>
      </div>
    </template>

    <el-dialog v-model="adviceOpen" title="✨ AI 点评" width="680px" append-to-body top="6vh">
      <div v-loading="advising" class="advice-body md-body" v-html="advising ? '' : md.render(advice)" />
    </el-dialog>
  </el-dialog>
</template>

<style scoped>
.edit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.edit-area :deep(textarea) { height: 100%; font-family: Consolas, monospace; }
.preview { max-height: 62vh; overflow: auto; border: 1px solid #ebeef5; border-radius: 6px; padding: 14px; }
.footer-bar { display: flex; justify-content: space-between; align-items: center; width: 100%; gap: 10px; }
.hint { font-size: 12px; color: #909399; }
.advice-body { min-height: 200px; max-height: 70vh; overflow: auto; }
.md-body { font-size: 14px; line-height: 1.7; }
.md-body :deep(h1) { font-size: 20px; }
.md-body :deep(h2) { font-size: 17px; margin-top: 18px; }
.md-body :deep(h3) { font-size: 15px; }
.md-body :deep(ul) { padding-left: 20px; }
@media (max-width: 768px) {
  .edit-grid { grid-template-columns: 1fr; }
  .el-dialog { width: 96% !important; }
}
</style>
