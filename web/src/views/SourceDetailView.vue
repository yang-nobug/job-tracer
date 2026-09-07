<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, askTutor, bumpKnowledge } from '../store'
import {
  MASTERY_LABELS,
  MASTERY_TAG_TYPES,
  KNOWLEDGE_CATEGORIES,
  type KnowledgeAnswerVersion,
  type KnowledgeItem,
  type KnowledgeSourceDetail,
  type Mastery
} from '../types'
import { generateAnswersChunked } from '../utils/answers'
import RichText from '../components/RichText.vue'

// 面经详情页：整页展示一个面经（题目 + 截图），替代原来的抽屉
const route = useRoute()
const router = useRouter()

const detail = ref<KnowledgeSourceDetail | null>(null)
const loading = ref(true)
const generating = ref(false)
const genProgress = ref<{ done: number; total: number } | null>(null)
const expanded = ref<Set<number>>(new Set())
const previewVisible = ref(false)
const previewUrl = ref('')
const editingItemId = ref<number | null>(null)
const editDraft = ref<{ question: string; answer: string; category: string; updatedAt: string } | null>(null)
const savingItem = ref(false)
const regeneratingItemId = ref<number | null>(null)
const versionsVisible = ref(false)
const versionItem = ref<KnowledgeItem | null>(null)
const answerVersions = ref<KnowledgeAnswerVersion[]>([])
const versionsLoading = ref(false)
const restoringVersionId = ref<number | null>(null)

const unanswered = computed(() => (detail.value?.items ?? []).filter((i) => !i.answer || !i.answer.trim()))

async function load(): Promise<void> {
  loading.value = true
  try {
    detail.value = await api.get<KnowledgeSourceDetail>(`/knowledge/sources/${route.params.id}`)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(load)

function toggleExpand(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function expandItem(id: number): void {
  if (expanded.value.has(id)) return
  expanded.value = new Set([...expanded.value, id])
}

function replaceItem(updated: KnowledgeItem): void {
  const item = detail.value?.items.find(entry => entry.id === updated.id)
  if (item) Object.assign(item, updated)
}

function editItem(item: KnowledgeItem): void {
  expandItem(item.id)
  editingItemId.value = item.id
  editDraft.value = {
    question: item.question,
    answer: item.answer ?? '',
    category: item.category,
    updatedAt: item.updated_at
  }
}

function cancelEdit(): void {
  editingItemId.value = null
  editDraft.value = null
}

async function saveItem(item: KnowledgeItem): Promise<void> {
  if (!editDraft.value) return
  if (!editDraft.value.question.trim()) {
    ElMessage.warning('问题不能为空')
    return
  }
  savingItem.value = true
  try {
    const updated = await api.put<KnowledgeItem>(`/knowledge/items/${item.id}`, {
      question: editDraft.value.question,
      answer: editDraft.value.answer,
      category: editDraft.value.category,
      expected_updated_at: editDraft.value.updatedAt
    })
    replaceItem(updated)
    cancelEdit()
    bumpKnowledge()
    ElMessage.success('题目已保存')
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    savingItem.value = false
  }
}

async function regenerateAnswer(item: KnowledgeItem): Promise<void> {
  try {
    const message = item.answer?.trim()
      ? '将生成新答案并替换当前内容；当前答案会自动保留到历史版本，可随时恢复。'
      : '将为这道题生成参考答案。'
    await ElMessageBox.confirm(message, '重新生成答案', {
      type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消'
    })
    regeneratingItemId.value = item.id
    const result = await api.post<{ items: KnowledgeItem[] }>('/ai/knowledge/generate-answers', {
      ids: [item.id],
      mode: 'replace',
      expected_updated_at: { [item.id]: item.updated_at }
    })
    const updated = result.items.find(entry => entry.id === item.id)
    if (updated) replaceItem(updated)
    expandItem(item.id)
    bumpKnowledge()
    ElMessage.success('答案已重新生成')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error((err as Error).message)
  } finally {
    regeneratingItemId.value = null
  }
}

const versionReasonLabel: Record<KnowledgeAnswerVersion['reason'], string> = {
  before_manual_edit: '编辑前备份',
  before_ai_regenerate: 'AI 重新生成前',
  before_restore: '恢复前备份'
}

async function loadAnswerVersions(item: KnowledgeItem): Promise<void> {
  versionItem.value = item
  versionsVisible.value = true
  versionsLoading.value = true
  try {
    answerVersions.value = await api.get<KnowledgeAnswerVersion[]>(`/knowledge/items/${item.id}/answer-versions`)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    versionsLoading.value = false
  }
}

async function restoreAnswerVersion(version: KnowledgeAnswerVersion): Promise<void> {
  if (!versionItem.value) return
  try {
    await ElMessageBox.confirm('恢复后当前答案会自动保存为一个历史版本。', '恢复历史答案', {
      type: 'warning', confirmButtonText: '恢复此版本', cancelButtonText: '取消'
    })
    restoringVersionId.value = version.id
    const updated = await api.post<KnowledgeItem>(
      `/knowledge/items/${versionItem.value.id}/answer-versions/${version.id}/restore`,
      { expected_updated_at: versionItem.value.updated_at }
    )
    replaceItem(updated)
    versionItem.value = updated
    await loadAnswerVersions(updated)
    expandItem(updated.id)
    bumpKnowledge()
    ElMessage.success('已恢复历史答案')
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error((err as Error).message)
  } finally {
    restoringVersionId.value = null
  }
}

async function exportMarkdown(): Promise<void> {
  if (!detail.value) return
  try {
    const response = await fetch(`/api/knowledge/sources/${detail.value.id}/export.md`)
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { message?: string }
      throw new Error(body.message || '导出失败')
    }
    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `${detail.value.company}-面经.md`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    ElMessage.success('Markdown 已下载')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
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
  genProgress.value = { done: 0, total: unanswered.value.length }
  try {
    const updatedItems = await generateAnswersChunked(
      unanswered.value.map((i) => i.id),
      (done, total) => {
        genProgress.value = { done, total }
      }
    )
    for (const updated of updatedItems) {
      const item = detail.value.items.find((i) => i.id === updated.id)
      if (item) {
        item.answer = updated.answer
        item.mastery = updated.mastery
      }
    }
    expanded.value = new Set(unanswered.value.map((i) => i.id))
    ElMessage.success(`已生成 ${updatedItems.filter((i) => i.answer?.trim()).length} 条答案`)
  } catch (err) {
    // 中途失败：已完成的批次已落库，重新拉详情
    ElMessage.error((err as Error).message)
    load()
  } finally {
    generating.value = false
    genProgress.value = null
  }
}

function previewImage(imageId: number): void {
  previewUrl.value = `/api/knowledge/images/${imageId}/file`
  previewVisible.value = true
}

// ---- 截图画廊：默认收起，支持批量/全部删除 ----
const galleryOpen = ref(false)
const selectedImages = ref<Set<number>>(new Set())

const allImagesSelected = computed(
  () => !!detail.value?.images.length && selectedImages.value.size === detail.value.images.length
)
const someImagesSelected = computed(() => selectedImages.value.size > 0)

function toggleGallery(): void {
  galleryOpen.value = !galleryOpen.value
  if (!galleryOpen.value) selectedImages.value = new Set()
}

function toggleImageSelect(imageId: number): void {
  const next = new Set(selectedImages.value)
  if (next.has(imageId)) next.delete(imageId)
  else next.add(imageId)
  selectedImages.value = next
}

function toggleAllImages(): void {
  selectedImages.value = allImagesSelected.value ? new Set() : new Set(detail.value?.images.map((i) => i.id) ?? [])
}

function dropImages(ids: number[]): void {
  if (detail.value) detail.value.images = detail.value.images.filter((i) => !ids.includes(i.id))
  selectedImages.value = new Set()
}

async function removeSelectedImages(): Promise<void> {
  const ids = [...selectedImages.value]
  if (!ids.length) return
  try {
    await ElMessageBox.confirm(`删除选中的 ${ids.length} 张截图？`, '批量删除', { type: 'warning' })
    for (const id of ids) await api.delete(`/knowledge/images/${id}`)
    dropImages(ids)
    ElMessage.success(`已删除 ${ids.length} 张`)
  } catch {
    /* 取消 */
  }
}

async function removeAllImages(): Promise<void> {
  if (!detail.value?.images.length) return
  const total = detail.value.images.length
  try {
    await ElMessageBox.confirm(`删除全部 ${total} 张截图？题目不受影响。`, '全部删除', { type: 'warning' })
    for (const img of detail.value.images) await api.delete(`/knowledge/images/${img.id}`)
    dropImages(detail.value.images.map((i) => i.id))
    galleryOpen.value = false
    ElMessage.success(`已删除 ${total} 张`)
  } catch {
    /* 取消 */
  }
}

async function removeImage(imageId: number): Promise<void> {
  try {
    await ElMessageBox.confirm('删除这张截图？', '提示', { type: 'warning' })
    await api.delete(`/knowledge/images/${imageId}`)
    if (detail.value) detail.value.images = detail.value.images.filter((i) => i.id !== imageId)
    selectedImages.value = new Set()
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

async function removeSource(): Promise<void> {
  if (!detail.value) return
  try {
    await ElMessageBox.confirm(
      `删除「${detail.value.company}」整条面经（含 ${detail.value.items.length} 条题目和截图）？`,
      '删除面经',
      { type: 'warning' }
    )
    await api.delete(`/knowledge/sources/${detail.value.id}`)
    store.knowledgeVersion++
    ElMessage.success('已删除')
    router.replace('/learn/knowledge')
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
  <div v-loading="loading" class="src-page">
    <template v-if="detail">
      <!-- 吸顶信息栏：下滑时公司/统计/操作始终可见 -->
      <div class="src-sticky">
        <el-button text class="src-back" @click="router.back()">← 返回</el-button>
        <span class="src-company">{{ detail.company }}</span>
        <el-tag v-if="detail.owner === 'mine'" type="primary" effect="dark" size="small" round>我的</el-tag>
        <el-tag v-else type="info" effect="plain" size="small" round>他人面经</el-tag>
        <el-tag v-if="detail.round" effect="plain" size="small" round>{{ detail.round }}</el-tag>
        <span class="src-mini-stats">
          {{ detail.items.length }} 题<template v-if="unanswered.length"> · <b>{{ unanswered.length }}</b> 缺答案</template>
        </span>
        <span class="src-spacer" />
        <el-button
          type="warning"
          plain
          size="small"
          :loading="generating"
          :disabled="!unanswered.length"
          @click="generateAnswers"
        >
          {{ genProgress ? `生成中 ${genProgress.done}/${genProgress.total}…` : `✨ 生成答案（${unanswered.length}）` }}
        </el-button>
        <el-button plain size="small" @click="exportMarkdown">导出 Markdown</el-button>
        <el-button type="danger" plain size="small" @click="removeSource">删除</el-button>
      </div>

      <!-- 标题区（次要信息，不吸顶） -->
      <div class="src-header">
        <div class="src-sub">
          <span v-if="detail.position">{{ detail.position }}</span>
          <span v-if="detail.note" class="src-note">{{ detail.note }}</span>
          <span class="src-date">{{ detail.created_at?.slice(0, 10) }}</span>
        </div>
      </div>

      <!-- 题目列表 -->
      <div v-if="!detail.items.length" class="src-empty">这条面经还没有题目</div>
      <div v-else class="src-items">
        <div v-for="item in detail.items" :key="item.id" class="src-item">
          <div class="src-item-head" @click="toggleExpand(item.id)">
            <el-tag size="small" effect="light" round class="src-cat">{{ item.category }}</el-tag>
            <span class="src-question">{{ item.question }}</span>
            <span class="src-spacer" />
            <span
              class="mastery-pill"
              :class="'m-' + item.mastery"
              title="点击切换掌握度"
              @click.stop="setMastery(item.id, (((item.mastery as Mastery) + 1) % 3) as Mastery)"
            >
              {{ MASTERY_LABELS[item.mastery as Mastery] }}
            </span>
            <el-tag v-if="!item.answer" size="small" type="info" effect="plain" round>无答案</el-tag>
            <el-button size="small" link title="把这道题带进 AI 助教" @click.stop="askTutor(item.question)">🎓 助教</el-button>
            <el-button size="small" link @click.stop="editItem(item)">编辑</el-button>
            <el-button size="small" link type="primary" :loading="regeneratingItemId === item.id" @click.stop="regenerateAnswer(item)">重新生成</el-button>
            <el-button v-if="item.answer" size="small" link @click.stop="loadAnswerVersions(item)">历史</el-button>
            <el-button link type="danger" size="small" @click.stop="removeItem(item.id)">删</el-button>
            <span class="src-toggle">{{ expanded.has(item.id) ? '▲' : '▼' }}</span>
          </div>
          <div v-if="expanded.has(item.id)" class="src-answer">
            <template v-if="editingItemId === item.id && editDraft">
              <div class="item-edit-head"><strong>编辑题目与答案</strong><span>答案支持 Markdown</span></div>
              <el-input v-model="editDraft.question" maxlength="2000" placeholder="问题" />
              <div class="item-edit-meta"><el-select v-model="editDraft.category" style="width: 120px"><el-option v-for="category in KNOWLEDGE_CATEGORIES" :key="category" :value="category" :label="category" /></el-select></div>
              <el-input v-model="editDraft.answer" type="textarea" :rows="10" maxlength="20000" show-word-limit placeholder="输入参考答案，支持 Markdown" />
              <div class="item-edit-actions"><el-button :disabled="savingItem" @click="cancelEdit">取消</el-button><el-button type="primary" :loading="savingItem" @click="saveItem(item)">保存修改</el-button></div>
            </template>
            <template v-else>
              <RichText v-if="item.answer" :content="item.answer" />
              <div v-else class="src-noanswer">还没有答案，可点击「重新生成」或顶部按钮补齐</div>
            </template>
          </div>
        </div>
      </div>

      <!-- 截图：默认收起，点按钮展开；支持批量/全部删除 -->
      <div v-if="detail.images.length" class="src-gallery">
        <div class="src-gallery-bar">
          <el-button size="small" @click="toggleGallery">
            📷 截图（{{ detail.images.length }}）{{ galleryOpen ? ' ▲' : ' ▼' }}
          </el-button>
          <template v-if="galleryOpen">
            <el-checkbox
              :model-value="allImagesSelected"
              :indeterminate="someImagesSelected && !allImagesSelected"
              @change="toggleAllImages"
            >
              全选
            </el-checkbox>
            <el-button
              size="small" type="danger" plain
              :disabled="!selectedImages.size"
              @click="removeSelectedImages"
            >
              删除所选（{{ selectedImages.size }}）
            </el-button>
            <el-button size="small" type="danger" plain @click="removeAllImages">全部删除</el-button>
          </template>
        </div>
        <div v-if="galleryOpen" class="src-images">
          <div v-for="img in detail.images" :key="img.id" class="src-image-box">
            <el-checkbox
              :model-value="selectedImages.has(img.id)"
              class="src-image-check"
              @change="toggleImageSelect(img.id)"
            />
            <img :src="`/api/knowledge/images/${img.id}/file`" :alt="img.filename" @click="previewImage(img.id)" />
            <el-button link type="danger" size="small" @click="removeImage(img.id)">删</el-button>
          </div>
        </div>
      </div>
    </template>
  </div>

  <el-dialog v-model="previewVisible" width="720px" top="4vh" title="截图预览">
    <img :src="previewUrl" style="width: 100%" />
  </el-dialog>

  <el-dialog v-model="versionsVisible" width="760px" top="8vh" title="答案历史版本" append-to-body>
    <div v-loading="versionsLoading" class="version-list">
      <div v-if="!versionsLoading && !answerVersions.length" class="src-noanswer">暂时没有历史版本。编辑或重新生成后会在这里保留旧答案。</div>
      <article v-for="version in answerVersions" :key="version.id" class="version-card">
        <div class="version-head"><div><el-tag size="small" effect="plain">{{ versionReasonLabel[version.reason] }}</el-tag><span>{{ version.created_at.replace('T', ' ').slice(0, 16) }}</span></div><el-button type="primary" plain size="small" :loading="restoringVersionId === version.id" @click="restoreAnswerVersion(version)">恢复此版本</el-button></div>
        <RichText :content="version.answer" />
      </article>
    </div>
  </el-dialog>
</template>

<style scoped>
.src-page { max-width: 860px; margin: 0 auto; }
/* 吸顶信息栏：贴在全局顶栏（68px）下方 */
.src-sticky {
  position: sticky; top: 68px; z-index: 50;
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  background: rgba(244, 246, 250, 0.92);
  backdrop-filter: blur(6px);
  padding: 8px 4px; margin: -6px 0 4px;
  border-bottom: 1px solid #ebeef5;
}
.src-back { padding: 4px 8px; }
.src-company { font-size: 18px; font-weight: 700; white-space: nowrap; }
.src-mini-stats { font-size: 13px; color: #909399; white-space: nowrap; }
.src-mini-stats b { color: #e6a23c; font-weight: 600; }
.src-spacer { flex: 1; }
.src-header { margin-bottom: 20px; }
.src-sub { margin-top: 8px; display: flex; gap: 12px; align-items: center; color: #606266; font-size: 14px; flex-wrap: wrap; }
.src-note { color: #909399; }
.src-date { margin-left: auto; color: #c0c4cc; font-size: 13px; }

.src-empty { color: #909399; padding: 40px 0; text-align: center; }
.src-items { display: flex; flex-direction: column; gap: 10px; }
.src-item {
  background: #fff; border: 1px solid #ebeef5; border-radius: 10px;
  padding: 14px 18px; transition: box-shadow 0.2s;
}
.src-item:hover { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06); }
.src-item-head { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.src-cat { flex-shrink: 0; }
.src-question { font-size: 15px; flex: 1; line-height: 1.6; }
.src-spacer { flex: 0; }
.src-toggle { color: #c0c4cc; font-size: 11px; }

/* 掌握度胶囊：红/黄/绿 */
.mastery-pill {
  flex-shrink: 0; cursor: pointer; user-select: none;
  font-size: 12px; padding: 2px 10px; border-radius: 999px; white-space: nowrap;
  transition: transform 0.15s;
}
.mastery-pill:hover { transform: scale(1.06); }
.m-0 { background: #fef0f0; color: #f56c6c; }
.m-1 { background: #fdf6ec; color: #e6a23c; }
.m-2 { background: #f0f9eb; color: #67c23a; }

.src-answer { margin-top: 12px; border-top: 1px dashed #ebeef5; padding-top: 12px; }
.src-noanswer { color: #909399; font-size: 13px; }
.item-edit-head { display:flex; justify-content:space-between; gap:12px; margin-bottom:8px; color:#526074; font-size:13px; }.item-edit-head span { color:#9099a7; font-size:12px; }.item-edit-meta { margin:8px 0; }.item-edit-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:10px; }
.version-list { min-height:100px; max-height:64vh; overflow:auto; }.version-card { border:1px solid #e7ebf0; border-radius:8px; padding:12px; margin-bottom:10px; background:#fff; }.version-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:9px; }.version-head>div { display:flex; align-items:center; gap:8px; color:#8792a2; font-size:12px; }.version-card :deep(.rich-text) { max-height:260px; overflow:auto; }
/* 截图画廊（默认收起） */
.src-gallery { margin-top: 28px; }
.src-gallery-bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.src-images { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; }
.src-image-box { width: 160px; text-align: center; position: relative; }
.src-image-check { position: absolute; top: 4px; left: 2px; z-index: 1; }
.src-image-box img {
  width: 160px; height: 110px; object-fit: cover; border-radius: 8px;
  cursor: zoom-in; border: 1px solid #ebeef5; transition: box-shadow 0.2s;
  display: block;
}
.src-image-box img:hover { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.12); }
</style>
