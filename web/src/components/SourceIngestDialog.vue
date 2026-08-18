<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, bumpKnowledge } from '../store'
import {
  ROUNDS,
  KNOWLEDGE_CATEGORIES,
  type Application,
  type KnowledgeCandidate,
  type KnowledgeImage
} from '../types'

// 录入面经弹窗（需求 3.9.2）：填信息 -> 贴内容（文本/截图）-> AI 拆题 -> 勾选入库
const visible = ref(false)

watch(
  () => store.knowledgeIngestOpen,
  (open) => {
    if (open) {
      visible.value = true
      store.knowledgeIngestOpen = false
    }
  }
)

// ---- 第 1 步：基本信息 ----
const owner = ref<'others' | 'mine'>('others')
const form = ref({ company: '', position: '', round: '', note: '' })
const applications = ref<Application[]>([])

async function loadApplications(): Promise<void> {
  try {
    applications.value = await api.get<Application[]>('/applications')
  } catch {
    /* 自动补全可选 */
  }
}

const companyOptions = computed(() => Array.from(new Set(applications.value.map((a) => a.company))))

function pickCompany(company: string): void {
  const app = applications.value.find((a) => a.company === company)
  if (app && !form.value.position) form.value.position = app.position
}

// ---- 第 2 步：内容 ----
const text = ref('')
const files = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const MAX_IMAGES = 9
const MAX_TEXT = 10000

function pickFiles(event: Event): void {
  const list = Array.from((event.target as HTMLInputElement).files ?? [])
  const imgs = list.filter((f) => /\.(jpe?g|png|webp|bmp)$/i.test(f.name))
  files.value = [...files.value, ...imgs].slice(0, MAX_IMAGES)
  ;(event.target as HTMLInputElement).value = ''
}

function removeFile(idx: number): void {
  files.value.splice(idx, 1)
}

// ---- 第 3 步：候选题目 ----
interface CandidateRow extends KnowledgeCandidate {
  key: number
  checked: boolean
}
const candidates = ref<CandidateRow[]>([])
let keySeq = 0
const step = ref(1)
const extracting = ref(false)
const saving = ref(false)
// 已创建的面经 id（AI 拆题前先建源，截图要挂上去）
let sourceId: number | null = null
let uploadedImages: KnowledgeImage[] = []

const canExtract = computed(
  () => step.value === 2 && (text.value.trim().length > 0 || files.value.length > 0)
)
const checkedCount = computed(() => candidates.value.filter((c) => c.checked).length)

function reset(): void {
  step.value = 1
  owner.value = 'others'
  form.value = { company: '', position: '', round: '', note: '' }
  text.value = ''
  files.value = []
  candidates.value = []
  sourceId = null
  uploadedImages = []
  extracting.value = false
  saving.value = false
}

function onClose(): void {
  if (saving.value || extracting.value) return
  const dirty =
    step.value > 1 || candidates.value.length > 0 || (sourceId !== null && uploadedImages.length > 0)
  if (dirty) {
    ElMessageBox.confirm('录入还没完成，确定关闭吗？（未入库的内容会丢弃）', '提示', { type: 'warning' })
      .then(closeForReal)
      .catch(() => {})
  } else {
    closeForReal()
  }
}

async function closeForReal(): Promise<void> {
  // 已建源但一条题目都没入库 -> 删掉空源（连截图一起清）
  if (sourceId !== null && !committed.value) {
    try {
      await api.delete(`/knowledge/sources/${sourceId}`)
    } catch {
      /* 静默 */
    }
  }
  visible.value = false
  reset()
}

const committed = ref(false)

// AI 拆题：建源 -> 传截图 -> 文本/逐图提取 -> 合并去重
async function extract(): Promise<void> {
  if (!form.value.company.trim()) {
    ElMessage.warning('公司不能为空')
    step.value = 1
    return
  }
  extracting.value = true
  try {
    // 建面经源
    const src = await api.post<{ id: number }>('/knowledge/sources', {
      owner: owner.value,
      company: form.value.company.trim(),
      position: form.value.position.trim() || null,
      round: form.value.round || null,
      note: form.value.note.trim() || null,
      source_type: text.value.trim() && files.value.length ? 'text' : files.value.length ? 'image' : 'text'
    })
    sourceId = src.id

    // 传截图（先落库留底，AI 从磁盘读）
    uploadedImages = []
    for (const f of files.value) {
      const img = await api.uploadKnowledgeImage(sourceId, f)
      uploadedImages.push(img)
    }

    // 文本拆题 + 逐图拆题
    const merged: KnowledgeCandidate[] = []
    const seen = new Set<string>()
    const push = (list: KnowledgeCandidate[]) => {
      for (const q of list) {
        const key = q.question.replace(/\s+/g, '').toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        merged.push(q)
      }
    }
    if (text.value.trim()) {
      const r = await api.post<{ questions: KnowledgeCandidate[] }>('/ai/knowledge/extract-text', {
        text: text.value.slice(0, MAX_TEXT)
      })
      push(r.questions)
    }
    for (const img of uploadedImages) {
      const r = await api.post<{ questions: KnowledgeCandidate[] }>('/ai/knowledge/extract-image', {
        image_id: img.id
      })
      push(r.questions)
    }

    candidates.value = merged.map((q) => ({ ...q, key: ++keySeq, checked: true }))
    if (candidates.value.length === 0) {
      ElMessage.warning('AI 没拆出题目，可以手动添加，或换个内容再试')
    }
    step.value = 3
  } catch (err) {
    ElMessage.error((err as Error).message)
    // 失败时回滚刚建的空源
    if (sourceId !== null) {
      try {
        await api.delete(`/knowledge/sources/${sourceId}`)
      } catch {
        /* 静默 */
      }
      sourceId = null
    }
  } finally {
    extracting.value = false
  }
}

function addRow(): void {
  candidates.value.push({ key: ++keySeq, checked: true, question: '', answer: '', category: '八股' })
}

function removeRow(idx: number): void {
  candidates.value.splice(idx, 1)
}

async function commit(): Promise<void> {
  const items = candidates.value
    .filter((c) => c.checked && c.question.trim())
    .map((c) => ({ question: c.question.trim(), answer: c.answer?.trim() || null, category: c.category }))
  if (items.length === 0) {
    ElMessage.warning('至少勾选一条题目')
    return
  }
  saving.value = true
  try {
    await api.post('/knowledge/items/batch', { source_id: sourceId, items })
    committed.value = true
    bumpKnowledge()
    ElMessage.success(`已入库 ${items.length} 条题目`)
    visible.value = false
    reset()
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    saving.value = false
  }
}

watch(visible, (open) => {
  if (open) loadApplications()
})
</script>

<template>
  <el-dialog
    v-model="visible"
    title="录入面经"
    width="860px"
    top="5vh"
    :close-on-click-modal="false"
    @close="onClose"
  >
    <el-steps :active="step - 1" align-center finish-status="success" class="ingest-steps">
      <el-step title="基本信息" />
      <el-step title="粘贴内容" />
      <el-step title="确认入库" />
    </el-steps>

    <!-- 第 1 步：基本信息 -->
    <div v-if="step === 1" class="step-body">
      <el-form label-width="90px" label-position="left">
        <el-form-item label="来源">
          <el-radio-group v-model="owner">
            <el-radio-button value="others">他人的面经</el-radio-button>
            <el-radio-button value="mine">我的面试</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="公司" required>
          <el-autocomplete
            v-model="form.company"
            :fetch-suggestions="(q: string, cb: (r: { value: string }[]) => void) => cb(companyOptions.filter((c) => c.includes(q)).map((c) => ({ value: c })))"
            placeholder="公司名"
            style="width: 260px"
            @select="(item: { value: string }) => pickCompany(item.value)"
          />
        </el-form-item>
        <el-form-item label="岗位">
          <el-input v-model="form.position" placeholder="如：前端开发工程师" style="width: 260px" />
        </el-form-item>
        <el-form-item label="轮次">
          <el-select v-model="form.round" placeholder="第几面" clearable style="width: 160px">
            <el-option v-for="r in ROUNDS" :key="r" :value="r" :label="r" />
          </el-select>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.note" placeholder="如：牛客 2024 秋招面经" />
        </el-form-item>
      </el-form>
      <div class="step-actions">
        <el-button type="primary" :disabled="!form.company.trim()" @click="step = 2">下一步</el-button>
      </div>
    </div>

    <!-- 第 2 步：粘贴内容 -->
    <div v-else-if="step === 2" class="step-body">
      <el-input
        v-model="text"
        type="textarea"
        :rows="10"
        :maxlength="MAX_TEXT"
        show-word-limit
        placeholder="把面经文字粘贴到这里（≤1 万字），AI 会自动拆出题目。也可以只用截图。"
      />
      <div class="upload-row">
        <el-button @click="fileInput?.click()">＋ 添加截图（{{ files.length }}/{{ MAX_IMAGES }}）</el-button>
        <input ref="fileInput" type="file" accept=".jpg,.jpeg,.png,.webp,.bmp" multiple hidden @change="pickFiles" />
        <span class="upload-hint">面试题截图 ≤9 张，入库后长期保留，可随时删除</span>
      </div>
      <div v-if="files.length" class="file-list">
        <div v-for="(f, i) in files" :key="i" class="file-chip">
          <span class="file-name">{{ f.name }}</span>
          <el-button link type="danger" size="small" @click="removeFile(i)">删除</el-button>
        </div>
      </div>
      <div class="step-actions">
        <el-button @click="step = 1">上一步</el-button>
        <el-button type="primary" :loading="extracting" :disabled="!canExtract" @click="extract">
          {{ extracting ? 'AI 拆题中…' : '✨ AI 拆题' }}
        </el-button>
      </div>
    </div>

    <!-- 第 3 步：候选题目确认 -->
    <div v-else class="step-body">
      <div class="cand-toolbar">
        <span class="cand-count">已勾选 {{ checkedCount }} / {{ candidates.length }} 条</span>
        <el-button size="small" @click="addRow">＋ 手动加一条</el-button>
      </div>
      <div v-if="!candidates.length" class="cand-empty">AI 没拆出题目，点「手动加一条」自己录入</div>
      <div v-else class="cand-list">
        <div v-for="(c, i) in candidates" :key="c.key" class="cand-row">
          <el-checkbox v-model="c.checked" />
          <div class="cand-main">
            <el-input v-model="c.question" placeholder="问题" size="small" />
            <el-input
              v-model="c.answer"
              type="textarea"
              :rows="2"
              placeholder="答案（可留空，之后让 AI 生成）"
              size="small"
              class="cand-answer"
            />
          </div>
          <el-select v-model="c.category" size="small" style="width: 104px">
            <el-option v-for="cat in KNOWLEDGE_CATEGORIES" :key="cat" :value="cat" :label="cat" />
          </el-select>
          <el-button link type="danger" size="small" @click="removeRow(i)">删</el-button>
        </div>
      </div>
      <div class="step-actions">
        <el-button :disabled="extracting || saving" @click="step = 2">上一步</el-button>
        <el-button type="primary" :loading="saving" :disabled="!checkedCount" @click="commit">入库</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.ingest-steps { margin-bottom: 18px; }
.step-body { min-height: 260px; display: flex; flex-direction: column; }
.step-actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.upload-row { margin-top: 12px; display: flex; align-items: center; gap: 10px; }
.upload-hint { font-size: 12px; color: #909399; }
.file-list { margin-top: 10px; display: flex; flex-wrap: wrap; gap: 8px; }
.file-chip {
  display: flex; align-items: center; gap: 6px; padding: 3px 10px;
  background: #f4f6fa; border-radius: 4px; font-size: 13px;
}
.file-name { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cand-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.cand-count { font-size: 13px; color: #606266; }
.cand-empty { color: #909399; font-size: 13px; padding: 30px 0; text-align: center; }
.cand-list { max-height: 52vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.cand-row { display: flex; gap: 8px; align-items: flex-start; }
.cand-main { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.cand-answer :deep(textarea) { font-size: 12px; }
@media (max-width: 768px) {
  .el-dialog { width: 96% !important; }
}
</style>
