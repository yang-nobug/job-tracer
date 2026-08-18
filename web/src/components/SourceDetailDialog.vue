<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import {
  KNOWLEDGE_CATEGORIES,
  MASTERY_LABELS,
  MASTERY_TAG_TYPES,
  type KnowledgeSourceDetail,
  type Mastery
} from '../types'

const props = defineProps<{ sourceId: number | null }>()
const emit = defineEmits<{
  (e: 'close'): void
  (e: 'changed'): void
}>()

const md = new MarkdownIt()
const detail = ref<KnowledgeSourceDetail | null>(null)
const loading = ref(false)
const generating = ref(false)
const expanded = ref<Set<number>>(new Set())
const previewVisible = ref(false)
const previewUrl = ref('')

const unanswered = computed(() => (detail.value?.items ?? []).filter((i) => !i.answer || !i.answer.trim()))

async function load(): Promise<void> {
  if (!props.sourceId) return
  loading.value = true
  try {
    detail.value = await api.get<KnowledgeSourceDetail>(`/knowledge/sources/${props.sourceId}`)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
}

watch(() => props.sourceId, load, { immediate: true })

function toggleExpand(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

async function setMastery(itemId: number, mastery: Mastery): Promise<void> {
  try {
    const updated = await api.patch(`/knowledge/items/${itemId}/mastery`, { mastery })
    const item = detail.value?.items.find((i) => i.id === itemId)
    if (item) item.mastery = updated.mastery
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function generateAnswers(): Promise<void> {
  if (!detail.value || unanswered.value.length === 0) return
  generating.value = true
  try {
    const r = await api.post<{ items: (typeof detail.value.items)[number][] }>('/ai/knowledge/generate-answers', {
      ids: unanswered.value.map((i) => i.id)
    })
    // 合并回详情
    for (const updated of r.items) {
      const item = detail.value.items.find((i) => i.id === updated.id)
      if (item) {
        item.answer = updated.answer
        item.mastery = updated.mastery
      }
    }
    expanded.value = new Set(unanswered.value.map((i) => i.id))
    ElMessage.success(`已生成 ${r.items.filter((i) => i.answer).length} 条答案`)
    emit('changed')
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    generating.value = false
  }
}

function previewImage(imageId: number): void {
  previewUrl.value = `/api/knowledge/images/${imageId}/file`
  previewVisible.value = true
}

async function removeImage(imageId: number): Promise<void> {
  try {
    await ElMessageBox.confirm('删除这张截图？', '提示', { type: 'warning' })
    await api.delete(`/knowledge/images/${imageId}`)
    if (detail.value) detail.value.images = detail.value.images.filter((i) => i.id !== imageId)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

async function removeSource(): Promise<void> {
  if (!detail.value) return
  try {
    await ElMessageBox.confirm(`删除「${detail.value.company}」整条面经（含 ${detail.value.items.length} 条题目和截图）？`, '删除面经', { type: 'warning' })
    await api.delete(`/knowledge/sources/${detail.value.id}`)
    ElMessage.success('已删除')
    emit('changed')
    emit('close')
  } catch {
    /* 取消 */
  }
}

async function removeItem(itemId: number): Promise<void> {
  try {
    await ElMessageBox.confirm('删除这条题目？', '提示', { type: 'warning' })
    await api.delete(`/knowledge/items/${itemId}`)
    if (detail.value) detail.value.items = detail.value.items.filter((i) => i.id !== itemId)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}
</script>

<template>
  <el-drawer :model-value="!!sourceId" size="640px" @close="emit('close')">
    <template #header>
      <div class="sd-header">
        <span class="sd-title">
          {{ detail?.company }}
          <el-tag v-if="detail?.owner === 'mine'" size="small" type="primary">我的</el-tag>
          <el-tag v-else size="small" type="info">他人</el-tag>
        </span>
      </div>
    </template>
    <div v-loading="loading">
      <template v-if="detail">
        <div class="sd-meta">
          <span v-if="detail.position">{{ detail.position }}</span>
          <el-tag v-if="detail.round" size="small">{{ detail.round }}</el-tag>
          <span v-if="detail.note" class="sd-note">{{ detail.note }}</span>
        </div>

        <div class="sd-actions">
          <el-button
            size="small"
            type="warning"
            plain
            :loading="generating"
            :disabled="!unanswered.length"
            @click="generateAnswers"
          >
            ✨ AI 生成答案（{{ unanswered.length }} 条缺答案）
          </el-button>
          <el-button size="small" type="danger" plain @click="removeSource">删除面经</el-button>
        </div>

        <h4 class="sd-section">题目（{{ detail.items.length }}）</h4>
        <div v-if="!detail.items.length" class="sd-empty">还没有题目</div>
        <div v-else class="sd-items">
          <div v-for="item in detail.items" :key="item.id" class="sd-item">
            <div class="sd-item-head" @click="toggleExpand(item.id)">
              <el-tag size="small" effect="plain">{{ item.category }}</el-tag>
              <span class="sd-question">{{ item.question }}</span>
              <span class="sd-spacer" />
              <el-tag
                size="small"
                :type="MASTERY_TAG_TYPES[item.mastery as Mastery]"
                style="cursor: pointer"
                :title="'点击切换掌握度'"
                @click.stop="setMastery(item.id, (((item.mastery as Mastery) + 1) % 3) as Mastery)"
              >
                {{ MASTERY_LABELS[item.mastery as Mastery] }}
              </el-tag>
              <el-tag v-if="!item.answer" size="small" type="info">无答案</el-tag>
              <el-button link type="danger" size="small" @click.stop="removeItem(item.id)">删</el-button>
            </div>
            <div v-if="expanded.has(item.id) && item.answer" class="sd-answer md-body" v-html="md.render(item.answer)" />
            <div v-else-if="expanded.has(item.id)" class="sd-answer sd-noanswer">还没有答案，点上方「AI 生成答案」</div>
          </div>
        </div>

        <h4 v-if="detail.images.length" class="sd-section">截图（{{ detail.images.length }}）</h4>
        <div v-if="detail.images.length" class="sd-images">
          <div v-for="img in detail.images" :key="img.id" class="sd-image-box">
            <img :src="`/api/knowledge/images/${img.id}/file`" :alt="img.filename" @click="previewImage(img.id)" />
            <el-button link type="danger" size="small" @click="removeImage(img.id)">删</el-button>
          </div>
        </div>
      </template>
    </div>
  </el-drawer>

  <el-dialog v-model="previewVisible" width="720px" top="4vh" title="截图预览">
    <img :src="previewUrl" style="width: 100%" />
  </el-dialog>
</template>

<style scoped>
.sd-header { display: flex; align-items: center; }
.sd-title { font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 8px; }
.sd-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; color: #606266; font-size: 13px; margin-bottom: 12px; }
.sd-note { color: #909399; font-size: 12px; }
.sd-actions { display: flex; gap: 8px; margin-bottom: 16px; }
.sd-section { margin: 14px 0 8px; color: #303133; }
.sd-empty { color: #909399; font-size: 13px; }
.sd-items { display: flex; flex-direction: column; gap: 8px; }
.sd-item { border: 1px solid #ebeef5; border-radius: 6px; padding: 8px 10px; }
.sd-item-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.sd-question { font-size: 14px; flex: 1; }
.sd-spacer { flex: 0; }
.sd-answer { margin-top: 8px; border-top: 1px dashed #ebeef5; padding-top: 8px; font-size: 13px; line-height: 1.7; }
.sd-noanswer { color: #909399; }
.sd-images { display: flex; flex-wrap: wrap; gap: 10px; }
.sd-image-box { width: 140px; text-align: center; }
.sd-image-box img { width: 140px; height: 100px; object-fit: cover; border-radius: 4px; cursor: zoom-in; border: 1px solid #ebeef5; }
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { font-size: 15px; margin: 10px 0 6px; }
.md-body :deep(ul) { padding-left: 20px; }
.md-body :deep(pre) { background: #f4f6fa; padding: 8px; border-radius: 4px; overflow: auto; }
.md-body :deep(code) { font-size: 12px; }
</style>
