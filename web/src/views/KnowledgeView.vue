<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, askTutor } from '../store'
import {
  KNOWLEDGE_CATEGORIES,
  MASTERY_LABELS,
  type KnowledgeItem,
  type KnowledgeSource,
  type Mastery
} from '../types'
import { generateAnswersChunked } from '../utils/answers'
import RichText from '../components/RichText.vue'

const router = useRouter()

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
const selected = ref<Set<number>>(new Set())
const generating = ref(false)
const genProgress = ref<{ done: number; total: number } | null>(null)

// 掌握度筛选在前端做（统计卡点击切换），请求不带 mastery 参数
const itemsQuery = computed(() => {
  const p = new URLSearchParams()
  if (owner.value !== 'all') p.set('owner', owner.value)
  if (category.value) p.set('category', category.value)
  if (keyword.value.trim()) p.set('keyword', keyword.value.trim())
  return p.toString()
})

const displayedItems = computed(() =>
  masteryFilter.value === '' ? items.value : items.value.filter((i) => i.mastery === masteryFilter.value)
)

// 统计卡：全部 / 未掌握 / 模糊 / 已掌握（点击切换筛选）
const masteryStats = computed(() => {
  const s = [0, 0, 0]
  for (const i of items.value) s[i.mastery as Mastery]++
  return s
})

const statsCards = computed(() => [
  { label: '全部题目', value: items.value.length, key: '' as number | '' },
  { label: '未掌握', value: masteryStats.value[0], key: 0 as number | '' },
  { label: '模糊', value: masteryStats.value[1], key: 1 as number | '' },
  { label: '已掌握', value: masteryStats.value[2], key: 2 as number | '' }
])

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
watch([viewMode, owner, category, keyword], () => {
  selected.value = new Set()
  load()
})
watch(
  () => store.knowledgeVersion,
  load
)

function toggleMasteryFilter(key: number | ''): void {
  masteryFilter.value = masteryFilter.value === key ? '' : key
}

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
  () => displayedItems.value.filter((i) => selected.value.has(i.id) && !i.answer?.trim()).length
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
  genProgress.value = { done: 0, total: ids.length }
  try {
    const updatedItems = await generateAnswersChunked(ids, (done, total) => {
      genProgress.value = { done, total }
    })
    for (const updated of updatedItems) {
      const item = items.value.find((i) => i.id === updated.id)
      if (item) {
        item.answer = updated.answer
        item.mastery = updated.mastery
        expanded.value = new Set([...expanded.value, updated.id])
      }
    }
    ElMessage.success(`已生成 ${updatedItems.filter((i) => i.answer?.trim()).length} 条答案`)
  } catch (err) {
    // 分批生成中途失败：已完成的批次已落库，重新拉取就能看到
    ElMessage.error((err as Error).message)
    load()
  } finally {
    generating.value = false
    genProgress.value = null
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
  if (sourceId) router.push(`/learn/knowledge/${sourceId}`)
}
</script>

<template>
  <div class="kb-view">
    <!-- 工具栏 -->
    <div class="kb-toolbar">
      <el-radio-group v-model="viewMode" size="default">
        <el-radio-button value="items">按题目</el-radio-button>
        <el-radio-button value="sources">按面经</el-radio-button>
      </el-radio-group>
      <el-radio-group v-model="owner" size="default">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="others">他人面经</el-radio-button>
        <el-radio-button value="mine">我的面试</el-radio-button>
      </el-radio-group>
      <el-input
        v-model="keyword"
        placeholder="搜问题 / 答案 / 公司"
        clearable
        style="width: 210px"
      />
      <el-select v-if="viewMode === 'items'" v-model="category" placeholder="分类" clearable style="width: 110px">
        <el-option v-for="c in KNOWLEDGE_CATEGORIES" :key="c" :value="c" :label="c" />
      </el-select>
      <span class="kb-spacer" />
      <el-button
        v-if="viewMode === 'items'"
        type="warning"
        plain
        :loading="generating"
        :disabled="!unansweredSelected"
        @click="generateAnswers(displayedItems.filter((i) => selected.has(i.id) && !i.answer?.trim()).map((i) => i.id))"
      >
        {{ genProgress ? `生成中 ${genProgress.done}/${genProgress.total}…` : `✨ 生成答案（${unansweredSelected}）` }}
      </el-button>
    </div>

    <div v-loading="loading" class="kb-body">
      <!-- 按题目 -->
      <template v-if="viewMode === 'items'">
        <!-- 掌握度统计卡（点击筛选） -->
        <div class="kb-stats">
          <div
            v-for="card in statsCards"
            :key="String(card.key)"
            class="kb-stat-card"
            :class="[{ active: masteryFilter === card.key }, 'stat-' + card.key]"
            @click="toggleMasteryFilter(card.key)"
          >
            <div class="kb-stat-value">{{ card.value }}</div>
            <div class="kb-stat-label">{{ card.label }}</div>
          </div>
        </div>

        <el-empty v-if="!displayedItems.length && !loading" description="没有题目，点右上角「录入面经」开始" />
        <div v-else class="kb-items">
          <div v-for="item in displayedItems" :key="item.id" class="kb-item">
            <el-checkbox
              :model-value="selected.has(item.id)"
              class="kb-check"
              @change="toggleSelect(item.id)"
            />
            <div class="kb-item-body">
              <div class="kb-item-head" @click="toggleExpand(item.id)">
                <el-tag size="small" effect="light" round class="kb-cat">{{ item.category }}</el-tag>
                <span class="kb-question">{{ item.question }}</span>
                <span
                  class="mastery-pill"
                  :class="'m-' + item.mastery"
                  title="点击切换掌握度"
                  @click.stop="setMastery(item, (((item.mastery as Mastery) + 1) % 3) as Mastery)"
                >
                  {{ MASTERY_LABELS[item.mastery as Mastery] }}
                </span>
                <el-tag v-if="!item.answer" size="small" type="info" effect="plain" round>无答案</el-tag>
                <el-button
                  v-else-if="!item.answer.trim()"
                  size="small" link type="warning"
                  @click.stop="generateAnswers([item.id])"
                >
                  ✨ 生成
                </el-button>
                <el-button size="small" link title="把这道题带进 AI 助教" @click.stop="askTutor(item.question)">🎓 助教</el-button>
                <el-button link type="danger" size="small" @click.stop="removeItem(item)">删</el-button>
                <span class="kb-toggle">{{ expanded.has(item.id) ? '▲' : '▼' }}</span>
              </div>
              <div v-if="expanded.has(item.id)" class="kb-answer">
                <RichText v-if="item.answer" :content="item.answer" />
                <div v-else class="kb-noanswer">还没有答案，勾选后点「生成答案」补齐</div>
              </div>
              <div v-if="item.source_company" class="kb-source" @click.stop="openSource(item.source_id)">
                📎 {{ item.source_company }}<template v-if="item.source_round"> · {{ item.source_round }}</template>
                <el-tag v-if="item.source_owner === 'mine'" size="small" type="primary" effect="plain" round>我的</el-tag>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 按面经 -->
      <template v-else>
        <el-empty v-if="!sources.length && !loading" description="还没有面经，点右上角「录入面经」开始" />
        <div v-else class="kb-sources">
          <div v-for="src in sources" :key="src.id" class="kb-source-card" @click="openSource(src.id)">
            <div class="kb-src-row">
              <span class="kb-src-company">{{ src.company }}</span>
              <el-tag v-if="src.owner === 'mine'" type="primary" effect="dark" size="small" round>我的</el-tag>
              <el-tag v-else type="info" effect="plain" size="small" round>他人</el-tag>
              <el-tag v-if="src.round" size="small" effect="light" round>{{ src.round }}</el-tag>
            </div>
            <div class="kb-src-sub">
              <span v-if="src.position">{{ src.position }}</span>
              <span v-if="src.note" class="kb-src-note">{{ src.note }}</span>
            </div>
            <div class="kb-src-foot">
              <span class="kb-src-count">{{ src.item_count }} 题 · {{ src.image_count }} 图</span>
              <span class="kb-src-date">{{ src.created_at?.slice(0, 10) }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.kb-view { max-width: 1000px; }
.kb-toolbar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
.kb-spacer { flex: 1; }
.kb-body { min-height: 300px; }

/* 掌握度统计卡 */
.kb-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.kb-stat-card {
  background: #fff; border: 1px solid #ebeef5; border-radius: 10px;
  padding: 14px 18px; cursor: pointer; text-align: center;
  transition: all 0.2s;
}
.kb-stat-card:hover { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06); }
.kb-stat-value { font-size: 26px; font-weight: 700; color: #303133; line-height: 1.2; }
.kb-stat-label { font-size: 13px; color: #909399; margin-top: 2px; }
.kb-stat-card.stat-0 .kb-stat-value { color: #f56c6c; }
.kb-stat-card.stat-1 .kb-stat-value { color: #e6a23c; }
.kb-stat-card.stat-2 .kb-stat-value { color: #67c23a; }
.kb-stat-card.active { border-color: #409eff; box-shadow: 0 0 0 1px #409eff inset; }

/* 题目卡片 */
.kb-items { display: flex; flex-direction: column; gap: 10px; }
.kb-item {
  display: flex; gap: 12px; background: #fff; border: 1px solid #ebeef5;
  border-radius: 10px; padding: 14px 18px; transition: box-shadow 0.2s;
}
.kb-item:hover { box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06); }
.kb-item-body { flex: 1; min-width: 0; }
.kb-item-head { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.kb-cat { flex-shrink: 0; }
.kb-question { font-size: 15px; flex: 1; line-height: 1.6; }
.kb-toggle { color: #c0c4cc; font-size: 11px; }
.kb-answer { margin-top: 12px; border-top: 1px dashed #ebeef5; padding-top: 12px; }
.kb-noanswer { color: #909399; font-size: 13px; }
.kb-source {
  margin-top: 8px; font-size: 12px; color: #a8abb2; cursor: pointer;
  display: inline-flex; align-items: center; gap: 4px;
}
.kb-source:hover { color: #409eff; }
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

/* 面经卡片 */
.kb-sources { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 12px; }
.kb-source-card {
  background: #fff; border: 1px solid #ebeef5; border-radius: 10px;
  padding: 16px 18px; cursor: pointer; transition: all 0.2s;
  display: flex; flex-direction: column; gap: 8px;
}
.kb-source-card:hover { box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08); transform: translateY(-1px); }
.kb-src-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kb-src-company { font-weight: 600; font-size: 16px; }
.kb-src-sub { display: flex; gap: 10px; color: #606266; font-size: 13px; flex-wrap: wrap; }
.kb-src-note { color: #909399; }
.kb-src-foot { display: flex; justify-content: space-between; align-items: center; }
.kb-src-count { font-size: 13px; color: #606266; }
.kb-src-date { color: #c0c4cc; font-size: 12px; }

</style>
