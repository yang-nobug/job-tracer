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
  type KnowledgeExtraction,
  type KnowledgeImage
} from '../types'

// 录入面经弹窗（需求 3.9.2）：贴内容 -> AI 识别（元信息+题目）-> 确认入库
// 公司/岗位/轮次由 AI 从内容里识别回填，用户只需确认或修改
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

// ---- 第 1 步：内容 ----
const owner = ref<'others' | 'mine'>('others')
// 已知公司时手填帮 AI 校准（可选）
const companyHint = ref('')
const applications = ref<Application[]>([])

async function loadApplications(): Promise<void> {
  try {
    applications.value = await api.get<Application[]>('/applications')
  } catch {
    /* 自动补全可选 */
  }
}

const companyOptions = computed(() => Array.from(new Set(applications.value.map((a) => a.company))))

function pickCompanyHint(company: string): void {
  companyHint.value = company
}

const text = ref('')
const files = ref<File[]>([])
const fileInput = ref<HTMLInputElement | null>(null)
const MAX_IMAGES = 9
const MAX_TEXT = 10000

function pickFiles(event: Event): void {
  const list = Array.from((event.target as HTMLInputElement).files ?? [])
  addImages(list)
  ;(event.target as HTMLInputElement).value = ''
}

function removeFile(idx: number): void {
  // 索引会移位，干脆全部重建缩略图
  revokeThumbs()
  files.value.splice(idx, 1)
}

/** 加入截图列表：过滤非图片、上限 9 张、给剪贴板粘贴的图起个可读名字 */
function addImages(list: File[]): void {
  const imgs = list.filter((f) => f.type.startsWith('image/') || /\.(jpe?g|png|webp|bmp)$/i.test(f.name))
  if (!imgs.length) return
  const remain = MAX_IMAGES - files.value.length
  if (remain <= 0) {
    ElMessage.warning(`截图最多 ${MAX_IMAGES} 张`)
    return
  }
  const added = imgs.slice(0, remain)
  files.value = [...files.value, ...added.map((f, i) => {
    if (f.name && !/^image\d*\.(png|jpe?g|webp|bmp)$/i.test(f.name)) return f
    // 剪贴板粘贴的图片名是 image.png 这种，换成可读名字
    const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg')
    return new File([f], `粘贴截图${files.value.length + i + 1}.${ext}`, { type: f.type })
  })]
  if (imgs.length > remain) ElMessage.warning(`截图最多 ${MAX_IMAGES} 张，已截断`)
  else ElMessage.success(`已添加 ${added.length} 张截图`)
}

/** Ctrl+V 粘贴截图：剪贴板里复制/截好的图直接粘进来 */
function onPaste(event: ClipboardEvent): void {
  const imgs = Array.from(event.clipboardData?.items ?? [])
    .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
  if (imgs.length) {
    event.preventDefault()
    addImages(imgs)
  }
}

/** 拖拽图片文件到录入区 */
function onDrop(event: DragEvent): void {
  addImages(Array.from(event.dataTransfer?.files ?? []))
}

const dragging = ref(false)

// 截图缩略图预览（objectURL，删除/关闭时释放）
const thumbUrls = new Map<number, string>()
function fileThumb(idx: number): string | undefined {
  if (!thumbUrls.has(idx)) thumbUrls.set(idx, URL.createObjectURL(files.value[idx]))
  return thumbUrls.get(idx)
}
function revokeThumbs(): void {
  for (const url of thumbUrls.values()) URL.revokeObjectURL(url)
  thumbUrls.clear()
}

const hasContent = computed(() => text.value.trim().length > 0 || files.value.length > 0)

// ---- 第 2 步：确认（AI 识别结果） ----
const step = ref(1)
const form = ref({ company: '', position: '', round: '', note: '' })

interface CandidateRow extends KnowledgeCandidate {
  key: number
  checked: boolean
}
const candidates = ref<CandidateRow[]>([])
let keySeq = 0
const extracting = ref(false)
const saving = ref(false)
// 已创建的面经 id（截图要先落库 AI 才能读，识别后回填元信息）
let sourceId: number | null = null
let uploadedImages: KnowledgeImage[] = []
const committed = ref(false)

const checkedCount = computed(() => candidates.value.filter((c) => c.checked).length)

function reset(): void {
  step.value = 1
  owner.value = 'others'
  companyHint.value = ''
  text.value = ''
  revokeThumbs()
  files.value = []
  form.value = { company: '', position: '', round: '', note: '' }
  candidates.value = []
  sourceId = null
  uploadedImages = []
  extracting.value = false
  saving.value = false
}

function onClose(): void {
  if (saving.value || extracting.value) return
  const dirty = step.value > 1 || candidates.value.length > 0 || (sourceId !== null && uploadedImages.length > 0)
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

/** 元信息合并：手填的公司优先，其余取第一个非空识别值 */
function mergeMeta(target: { company: string; position: string; round: string }, next: KnowledgeExtraction): void {
  if (!target.company && next.company) target.company = next.company
  if (!target.position && next.position) target.position = next.position
  if (!target.round && next.round) target.round = next.round
}

// AI 识别：建源（占位）-> 传截图 -> 文本/逐图提取 -> 合并元信息与题目 -> 回填源
async function extract(): Promise<void> {
  if (!hasContent.value) return
  extracting.value = true
  try {
    // 截图要先落库 AI 才能读，先用占位公司建源
    const src = await api.post<{ id: number }>('/knowledge/sources', {
      owner: owner.value,
      company: companyHint.value.trim() || '未命名面经',
      source_type: text.value.trim() && files.value.length ? 'text' : files.value.length ? 'image' : 'text'
    })
    sourceId = src.id

    // 传截图（先落库留底，AI 从磁盘读）
    uploadedImages = []
    for (const f of files.value) {
      const img = await api.uploadKnowledgeImage(sourceId, f)
      uploadedImages.push(img)
    }

    // 文本识别 + 逐图识别
    const meta = { company: companyHint.value.trim(), position: '', round: '' }
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
      const r = await api.post<KnowledgeExtraction>('/ai/knowledge/extract-text', {
        text: text.value.slice(0, MAX_TEXT)
      })
      mergeMeta(meta, r)
      push(r.questions)
    }
    for (const img of uploadedImages) {
      const r = await api.post<KnowledgeExtraction>('/ai/knowledge/extract-image', {
        image_id: img.id
      })
      mergeMeta(meta, r)
      push(r.questions)
    }

    // 回填元信息到源
    await api.put(`/knowledge/sources/${sourceId}`, {
      company: meta.company || '未命名面经',
      position: meta.position || null,
      round: meta.round || null
    })

    form.value = {
      company: meta.company,
      position: meta.position,
      round: meta.round,
      note: ''
    }
    candidates.value = merged.map((q) => ({ ...q, key: ++keySeq, checked: true }))
    if (candidates.value.length === 0) {
      ElMessage.warning('AI 没拆出题目，可以在下一步手动添加')
    }
    step.value = 2
  } catch (err) {
    ElMessage.error((err as Error).message)
    // 失败时回滚刚建的源
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
  const company = form.value.company.trim()
  if (!company) {
    ElMessage.warning('公司不能为空，AI 没识别出来就手动补一下')
    return
  }
  const items = candidates.value
    .filter((c) => c.checked && c.question.trim())
    .map((c) => ({ question: c.question.trim(), answer: c.answer?.trim() || null, category: c.category }))
  if (items.length === 0) {
    ElMessage.warning('至少勾选一条题目')
    return
  }
  saving.value = true
  try {
    // 用户可能在确认页改过元信息，最终以表单为准
    if (sourceId !== null) {
      await api.put(`/knowledge/sources/${sourceId}`, {
        company,
        position: form.value.position.trim() || null,
        round: form.value.round || null,
        note: form.value.note.trim() || null
      })
    } else {
      const src = await api.post<{ id: number }>('/knowledge/sources', {
        owner: owner.value,
        company,
        position: form.value.position.trim() || null,
        round: form.value.round || null,
        note: form.value.note.trim() || null,
        source_type: 'text'
      })
      sourceId = src.id
    }
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
      <el-step title="贴内容" />
      <el-step title="确认入库" />
    </el-steps>

    <!-- 第 1 步：贴内容（Ctrl+V 粘贴 / 拖拽 / 选文件） -->
    <div
      v-if="step === 1"
      class="step-body"
      @paste="onPaste"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <div class="owner-row">
        <el-radio-group v-model="owner">
          <el-radio-button value="others">他人的面经</el-radio-button>
          <el-radio-button value="mine">我的面试</el-radio-button>
        </el-radio-group>
        <el-autocomplete
          v-model="companyHint"
          :fetch-suggestions="(q: string, cb: (r: { value: string }[]) => void) => cb(companyOptions.filter((c) => c.includes(q)).map((c) => ({ value: c })))"
          placeholder="公司（可选，AI 会从内容里识别）"
          clearable
          style="width: 240px"
          @select="(item: { value: string }) => pickCompanyHint(item.value)"
        />
      </div>
      <div
        class="drop-zone"
        :class="{ 'drag-over': dragging }"
        @dragenter="dragging = true"
        @dragleave="dragging = false"
        @drop="dragging = false"
      >
        <div v-if="!files.length" class="drop-tip">📋 直接 <b>Ctrl+V</b> 粘贴截图，或把图片拖到这里</div>
        <div v-else class="file-list">
          <div v-for="(f, i) in files" :key="i" class="file-chip">
            <img v-if="fileThumb(i)" :src="fileThumb(i)" class="file-thumb" alt="" />
            <span class="file-name">{{ f.name }}</span>
            <el-button link type="danger" size="small" @click="removeFile(i)">删除</el-button>
          </div>
        </div>
        <el-button size="small" @click="fileInput?.click()">＋ 选择文件（{{ files.length }}/{{ MAX_IMAGES }}）</el-button>
        <input ref="fileInput" type="file" accept=".jpg,.jpeg,.png,.webp,.bmp" multiple hidden @change="pickFiles" />
      </div>
      <el-input
        v-model="text"
        type="textarea"
        :rows="8"
        :maxlength="MAX_TEXT"
        show-word-limit
        class="text-area"
        placeholder="面经文字粘贴到这里（≤1 万字）。公司/岗位/轮次 AI 会自动识别，也可以只用截图。"
      />
      <div class="step-actions">
        <el-button type="primary" size="large" :loading="extracting" :disabled="!hasContent" @click="extract">
          {{ extracting ? 'AI 识别中…' : '✨ AI 识别' }}
        </el-button>
      </div>
    </div>

    <!-- 第 2 步：确认识别结果 -->
    <div v-else class="step-body">
      <el-form label-width="70px" label-position="left" class="confirm-form">
        <div class="confirm-row">
          <el-form-item label="公司" required>
            <el-input v-model="form.company" placeholder="AI 没识别出来？手动补一下" />
          </el-form-item>
          <el-form-item label="岗位">
            <el-input v-model="form.position" placeholder="岗位" />
          </el-form-item>
          <el-form-item label="轮次">
            <el-select v-model="form.round" placeholder="轮次" clearable>
              <el-option v-for="r in ROUNDS" :key="r" :value="r" :label="r" />
            </el-select>
          </el-form-item>
          <el-form-item label="备注">
            <el-input v-model="form.note" placeholder="如：牛客 2024 秋招面经" />
          </el-form-item>
        </div>
      </el-form>
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
        <el-button :disabled="extracting || saving" @click="step = 1">上一步</el-button>
        <el-button type="primary" :loading="saving" :disabled="!checkedCount" @click="commit">入库</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.ingest-steps { margin-bottom: 18px; }
.step-body { min-height: 260px; display: flex; flex-direction: column; }
.step-actions { margin-top: 16px; display: flex; justify-content: flex-end; gap: 8px; }
.owner-row { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; flex-wrap: wrap; }

/* 截图拖放区 */
.drop-zone {
  border: 1.5px dashed #c0c4cc; border-radius: 8px; padding: 14px 16px;
  display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
  transition: border-color 0.2s, background 0.2s;
}
.drop-zone.drag-over { border-color: #409eff; background: #ecf5ff; }
.drop-tip { color: #909399; font-size: 13px; align-self: center; padding: 8px 0; }
.file-list { display: flex; flex-wrap: wrap; gap: 8px; }
.file-chip {
  display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 4px;
  background: #f4f6fa; border-radius: 6px; font-size: 13px;
}
.file-thumb { width: 44px; height: 34px; object-fit: cover; border-radius: 4px; }
.file-name { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.text-area { margin-top: 10px; }

/* 确认表单 */
.confirm-form { margin-bottom: 6px; }
.confirm-row { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }
.cand-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.cand-count { font-size: 13px; color: #606266; }
.cand-empty { color: #909399; font-size: 13px; padding: 30px 0; text-align: center; }
.cand-list { max-height: 42vh; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
.cand-row { display: flex; gap: 8px; align-items: flex-start; }
.cand-main { flex: 1; display: flex; flex-direction: column; gap: 6px; }
.cand-answer :deep(textarea) { font-size: 12px; }
</style>
