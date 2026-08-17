<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { Resume } from '../types'

const model = defineModel<number | null>({ default: null })
const props = defineProps<{ reloadTrigger?: number }>()

const resumes = ref<Resume[]>([])

async function load(): Promise<void> {
  try {
    resumes.value = await api.get<Resume[]>('/resumes')
  } catch { /* 忽略 */ }
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
    const r = (await api.uploadResume(file)) as Resume
    ElMessage.success('上传成功')
    await load()
    model.value = r.id
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    input.value = ''
  }
}

function preview(): void {
  if (model.value) {
    window.open(`/api/resumes/${model.value}/file`, '_blank')
  }
}
</script>

<template>
  <div class="resume-picker">
    <el-select v-model="model" placeholder="选择简历（可选）" clearable style="flex: 1">
      <el-option v-for="r in resumes" :key="r.id" :label="r.filename" :value="r.id" />
    </el-select>
    <label class="upload-btn">
      上传
      <input type="file" accept=".pdf,.doc,.docx" @change="onUpload" />
    </label>
    <el-button v-if="model" link type="primary" @click="preview">预览</el-button>
  </div>
</template>

<style scoped>
.resume-picker { display: flex; gap: 8px; width: 100%; align-items: center; }
.upload-btn {
  border: 1px solid #dcdfe6; border-radius: 4px; padding: 5px 12px; cursor: pointer;
  font-size: 13px; color: #606266; white-space: nowrap; background: #fff;
}
.upload-btn:hover { color: #409eff; border-color: #c6e2ff; }
.upload-btn input { display: none; }
</style>
