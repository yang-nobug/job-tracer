<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store } from '../store'
import {
  KNOWLEDGE_CATEGORIES,
  MASTERY_LABELS,
  MASTERY_TAG_TYPES,
  type KnowledgeItem,
  type KnowledgeSource,
  type Mastery
} from '../types'
import SourceDetailDialog from '../components/SourceDetailDialog.vue'

const md = new MarkdownIt()

// ---- 视图状态 ----
const viewMode = ref<'items' | 'sources'>('items')
const owner = ref<'all' | 'others' | 'mine'>('all')
const keyword = ref('')
const category = ref('')
const masteryFilter = ref<number | ''>('')
const loading = ref(false)

const items = ref<KnowledgeItem[]>([])
const sources = ref<KnowledgeSource[]>([])
const expanded = ref<Set<number>>(new Set())
const detailId = ref<number | null>(null)
const selected = ref<Set<number>>(new Set())
const generating = ref(false)

// 统计摘要
const summary = computed(() => ({
  total: items.value.length,
  weak: items.value.filter((i) => i.mastery === 0).length,
  noAnswer: items.value.filter((i) => !i.answer || !i.answer.trim()).length
}))

const itemsQuery = computed(() => {
  const p = new URLSearchParams()
  if (owner.value !== 'all') p.set('owner', owner.value)
  if (category.value) p.set('category', category.value)
  if (masteryFilter.value !== '') p.set('mastery', String(masteryFilter.value))
  if (keyword.value.trim()) p.set('keyword', keyword.value.trim())
  return p.toString()
})

async function load(): Promise<void> {
  loading.value = true
  try {
    if (viewMode.value === 'items') {
      items.value = await api.get<KnowledgeItem[]>(`/knowledge/items?${itemsQuery.value}`)
    } else {
      const p = new URLSearchParams()
      if (owner.value !== 'all') p.set('owner', owner.value)
      if (keyword.value.trim()) p.set('keyword', keyword.value.trim())
      sources.value = await api.get<KnowledgeSource[]>(`/knowledge/sources?${p.toString()}`)
    }
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch([viewMode, owner, category, masteryFilter, keyword], () => {
  selected.value = new Set()
  load()
})
watch(
  () => store.knowledgeVersion,
  load
)

// ---- 按题目视图 ----
function toggleExpand(id: number): void {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function toggleSelect(id: number): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

const unansweredSelected = computed(
  () => items.value.filter((i) => selected.value.has(i.id) && !i.answer?.trim()).length
)

async function setMastery(item: KnowledgeItem, mastery: Mastery): Promise<void> {
  try {
    const updated = await api.patch(`/knowledge/items/${item.id}/mastery`, { mastery })
    item.mastery = updated.mastery
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function generateAnswers(ids: number[]): Promise<void> {
  if (!ids.length) return
  generating.value = true
  try {
    const r = await api.post<{ items: KnowledgeItem[] }>('/ai/knowledge/generate-answers', { ids })
    for (const updated of r.items) {
      const item = items.value.find((i) => i.id === updated.id)
      if (item) {
        item.answer = updated.answer
        item.mastery = updated.mastery
        expanded.value = new Set([...expanded.value, updated.id])
      }
    }
    ElMessage.success(`已生成 ${r.items.filter((i) => i.answer).length} 条答案`)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    generating.value = false
  }
}

async function removeItem(item: KnowledgeItem): Promise<void> {
  try {
    await ElMessageBox.confirm('删除这条题目？', '提示', { type: 'warning' })
    await api.delete(`/knowledge/items/${item.id}`)
    items.value = items.value.filter((i) => i.id !== item.id)
    ElMessage.success('已删除')
  } catch {
    /* 取消 */
  }
}

function openSource(sourceId: number | null): void {
  if (sourceId) detailId.value = sourceId
}
</script>

<template>
  <div class="knowledge-view">
    <!-- 工具栏 -->
    <div class="kb-toolbar">
      <el-radio-group v-model="viewMode" size="small">
        <el-radio-button value="items">按题目</el-radio-button>
        <el-radio-button value="sources">按面经</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="owner" size="small">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="others">他人面经</el-radio-button>
        <el-radio-button value="mine">我的面试</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        placeholder="搜问题 / 答案 / 公司"
        clearable
        size="small"
        style="width: 200px"
      />
      <template v-if="viewMode === 'items'">
        <el-select v-model="category" placeholder="分类" clearable size="small" style="width: 110px">
          <el-option v-for="c in KNOWLEDGE_CATEGORIES" :key="c" :value="c" :label="c" />
        </el-select>
        <el-select v-model="masteryFilter" placeholder="掌握度" clearable size="small" style="width: 110px">
          <el-option :value="0" label="未掌握" />
          <el-option :value="1" label="模糊" />
          <el-option :value="2" label="已掌握" />
        </el-select>
      </template>
      <span class="kb-summary">
        {{ summary.total }} 题 · <span class="weak">{{ summary.weak }} 未掌握</span> · {{ summary.noAnswer }} 缺答案
      </span>
      <span class="kb-spacer" />
      <el-button
        v-if="viewMode === 'items'"
        size="small"
        type="warning"
        plain
        :loading="generating"
        :disabled="!unansweredSelected"
        @click="generateAnswers(items.filter((i) => selected.has(i.id) && !i.answer?.trim()).map((i) => i.id))"
      >
        ✨ 生成答案（{{ unansweredSelected }}）
      </el-button>
    </div>

    <div v-loading="loading">
      <!-- 按题目 -->
      <template v-if="viewMode === 'items'">
        <el-empty v-if="!items.length && !loading" description="还没有题目，点右上角「录入面经」开始" />
        <div v-else class="kb-items">
          <div v-for="item in items" :key="item.id" class="kb-item">
            <el-checkbox
              :model-value="selected.has(item.id)"
              class="kb-check"
              @change="toggleSelect(item.id)"
            />
            <div class="kb-item-body">
              <div class="kb-item-head" @click="toggleExpand(item.id)">
                <el-tag size="small" effect="plain">{{ item.category }}</el-tag>
                <span class="kb-question">{{ item.question }}</span>
                <span class="kb-spacer" />
                <span v-if="item.source_company" class="kb-source" @click.stop="openSource(item.source_id)">
                  {{ item.source_company }}<template v-if="item.source_round"> · {{ item.source_round }}</template>
                  <el-tag v-if="item.source_owner === 'mine'" size="small" type="primary">我的</el-tag>
                </span>
                <el-tag
                  size="small"
                  :type="MASTERY_TAG_TYPES[item.mastery as Mastery]"
                  style="cursor: pointer"
                  title="点击切换掌握度"
                  @click.stop="setMastery(item, (((item.mastery as Mastery) + 1) % 3) as Mastery)"
                >
                  {{ MASTERY_LABELS[item.mastery as Mastery] }}
                </el-tag>
                <el-tag v-if="!item.answer" size="small" type="info">无答案</el-tag>
                <el-button v-else-if="!item.answer.trim()" size="small" link type="warning" @click.stop="generateAnswers([item.id])">
                  ✨ 生成
                </el-button>
                <el-button link type="danger" size="small" @click.stop="removeItem(item)">删</el-button>
              </div>
              <div
                v-if="expanded.has(item.id) && item.answer"
                class="kb-answer md-body"
                v-html="md.render(item.answer)"
              />
              <div v-else-if="expanded.has(item.id)" class="kb-answer kb-noanswer">还没有答案</div>
            </div>
          </div>
        </div>
      </template>

      <!-- 按面经 -->
      <template v-else>
        <el-empty v-if="!sources.length && !loading" description="还没有面经，点右上角「录入面经」开始" />
        <div v-else class="kb-sources">
          <el-card
            v-for="src in sources"
            :key="src.id"
            shadow="never"
            class="kb-source-card"
            @click="detailId = src.id"
          >
            <div class="kb-src-row">
              <span class="kb-src-company">{{ src.company }}</span>
              <el-tag v-if="src.owner === 'mine'" type="primary" size="small">我的</el-tag>
              <el-tag v-else type="info" size="small">他人</el-tag>
              <el-tag v-if="src.round" size="small" effect="plain">{{ src.round }}</el-tag>
              <span class="kb-spacer" />
              <span class="kb-src-count">{{ src.item_count }} 题 · {{ src.image_count }} 图</span>
            </div>
            <div class="kb-src-sub">
              <span v-if="src.position">{{ src.position }}</span>
              <span v-if="src.note" class="kb-src-note">{{ src.note }}</span>
              <span class="kb-src-date">{{ src.created_at?.slice(0, 10) }}</span>
            </div>
          </el-card>
        </div>
      </template>
    </div>

    <SourceDetailDialog :source-id="detailId" @close="detailId = null" @changed="load" />
  </div>
</template>

<style scoped>
.knowledge-view { max-width: 1100px; }
.kb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.kb-summary { font-size: 13px; color: #606266; }
.kb-summary .weak { color: #f56c6c; }
.kb-spacer { flex: 1; }

.kb-items { display: flex; flex-direction: column; gap: 8px; }
.kb-item { display: flex; gap: 10px; border: 1px solid #ebeef5; border-radius: 6px; padding: 10px 12px; background: #fff; }
.kb-item-body { flex: 1; min-width: 0; }
.kb-item-head { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.kb-question { font-size: 14px; flex: 0 1 auto; }
.kb-source { font-size: 12px; color: #909399; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
.kb-source:hover { color: #409eff; }
.kb-answer { margin-top: 8px; border-top: 1px dashed #ebeef5; padding-top: 8px; font-size: 13px; line-height: 1.7; }
.kb-noanswer { color: #909399; }
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { font-size: 15px; margin: 10px 0 6px; }
.md-body :deep(ul) { padding-left: 20px; }
.md-body :deep(pre) { background: #f4f6fa; padding: 8px; border-radius: 4px; overflow: auto; }
.md-body :deep(code) { font-size: 12px; }

.kb-sources { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; }
.kb-source-card { cursor: pointer; }
.kb-source-card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
.kb-src-row { display: flex; align-items: center; gap: 8px; }
.kb-src-company { font-weight: 600; font-size: 15px; }
.kb-src-count { font-size: 12px; color: #909399; white-space: nowrap; }
.kb-src-sub { margin-top: 4px; display: flex; gap: 10px; color: #606266; font-size: 13px; }
.kb-src-note { color: #909399; }
.kb-src-date { margin-left: auto; color: #c0c4cc; font-size: 12px; }
</style>
