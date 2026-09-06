<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, bumpKnowledge } from '../store'
import { createInferenceImage } from '../utils/inference-image'
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
  committed.value = false
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
      const inferenceFile = await createInferenceImage(f)
      const img = await api.uploadKnowledgeImage(sourceId, f, inferenceFile)
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
    width="920px"
    top="5vh"
    :close-on-click-modal="false"
    class="source-ingest-dialog"
    @close="onClose"
  >
    <template #header>
      <div class="dialog-heading">
        <div>
          <p class="eyebrow">KNOWLEDGE BASE</p>
          <h2>录入面经</h2>
          <p>粘贴文字或上传截图，AI 会拆分题目供你确认后入库。</p>
        </div>
        <span class="heading-step">第 {{ step }} / 2 步</span>
      </div>
    </template>

    <div class="ingest-progress" aria-label="录入进度">
      <div class="progress-step" :class="{ active: step === 1, done: step > 1 }">
        <span>1</span><b>添加材料</b><small>文字或截图</small>
      </div>
      <i :class="{ done: step > 1 }" />
      <div class="progress-step" :class="{ active: step === 2 }">
        <span>2</span><b>核对题目</b><small>确认后入库</small>
      </div>
    </div>

    <!-- 第 1 步：贴内容（Ctrl+V 粘贴 / 拖拽 / 选文件） -->
    <div
      v-if="step === 1"
      class="step-body"
      @paste="onPaste"
      @dragover.prevent
      @drop.prevent="onDrop"
    >
      <section class="entry-intro">
        <div>
          <h3>先添加面经材料</h3>
          <p>支持纯文字、截图，或两者混合。无需先整理格式。</p>
        </div>
        <span>最多 {{ MAX_IMAGES }} 张截图</span>
      </section>

      <section class="source-meta">
        <div class="meta-field">
          <label>面经来源</label>
          <el-radio-group v-model="owner">
            <el-radio-button value="others">他人的面经</el-radio-button>
            <el-radio-button value="mine">我的面试</el-radio-button>
          </el-radio-group>
        </div>
        <div class="meta-field company-field">
          <label>公司（可选）</label>
          <el-autocomplete
            v-model="companyHint"
            :fetch-suggestions="(q: string, cb: (r: { value: string }[]) => void) => cb(companyOptions.filter((c) => c.includes(q)).map((c) => ({ value: c })))"
            placeholder="留空让 AI 自动识别"
            clearable
            @select="(item: { value: string }) => pickCompanyHint(item.value)"
          />
        </div>
      </section>

      <div class="material-grid">
        <section class="material-panel text-panel">
          <div class="panel-heading">
            <div><h3>面经文字</h3><p>可直接粘贴原文</p></div>
            <span>{{ text.length }} / {{ MAX_TEXT }}</span>
          </div>
          <el-input
            v-model="text"
            type="textarea"
            :rows="11"
            :maxlength="MAX_TEXT"
            resize="none"
            class="text-area"
            placeholder="把面经内容粘贴在这里。例如题目、面试过程、回答要点……"
          />
        </section>

        <section class="material-panel image-panel">
          <div class="panel-heading">
            <div><h3>截图材料</h3><p>可拖入、选择或 Ctrl+V 粘贴</p></div>
            <span>{{ files.length }} / {{ MAX_IMAGES }}</span>
          </div>
          <div
            class="drop-zone"
            :class="{ 'drag-over': dragging, populated: files.length }"
            @dragenter="dragging = true"
            @dragleave="dragging = false"
            @drop="dragging = false"
          >
            <div v-if="!files.length" class="drop-tip">
              <strong>拖入截图到这里</strong>
              <span>或从剪贴板直接粘贴</span>
            </div>
            <div v-else class="file-list">
              <div v-for="(f, i) in files" :key="i" class="file-chip">
                <img v-if="fileThumb(i)" :src="fileThumb(i)" class="file-thumb" :alt="f.name" />
                <div class="file-copy"><span class="file-name">{{ f.name }}</span><small>截图 {{ i + 1 }}</small></div>
                <el-button circle plain size="small" aria-label="删除截图" @click="removeFile(i)">×</el-button>
              </div>
            </div>
            <el-button size="small" plain @click="fileInput?.click()">选择截图</el-button>
            <input ref="fileInput" type="file" accept=".jpg,.jpeg,.png,.webp,.bmp" multiple hidden @change="pickFiles" />
          </div>
        </section>
      </div>
      <p class="privacy-note">识别时会发送文字和适配后的图片副本；原图仅保存在本机。请先移除无关个人信息。</p>
      <div class="step-actions">
        <span v-if="!hasContent" class="action-hint">添加任意一种材料后即可继续</span>
        <el-button type="primary" size="large" :loading="extracting" :disabled="!hasContent" @click="extract">
          {{ extracting ? '正在拆分题目…' : '开始 AI 识别' }}
        </el-button>
      </div>
    </div>

    <!-- 第 2 步：确认识别结果 -->
    <div v-else class="step-body">
      <section class="review-intro">
        <div><h3>核对 AI 识别结果</h3><p>修改公司信息和题目内容，只会保存勾选的题目。</p></div>
        <span>已识别 {{ candidates.length }} 条</span>
      </section>
      <el-form label-width="52px" label-position="left" class="confirm-form">
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
        <span class="cand-count">将入库 <b>{{ checkedCount }}</b> / {{ candidates.length }} 条</span>
        <el-button size="small" plain @click="addRow">新增题目</el-button>
      </div>
      <div v-if="!candidates.length" class="cand-empty">AI 没拆出题目，点「手动加一条」自己录入</div>
      <div v-else class="cand-list">
        <div v-for="(c, i) in candidates" :key="c.key" class="cand-row">
          <el-checkbox v-model="c.checked" class="cand-check" />
          <div class="cand-main">
            <div class="question-label">题目 {{ i + 1 }}</div>
            <el-input v-model="c.question" placeholder="输入问题" size="small" />
            <el-input
              v-model="c.answer"
              type="textarea"
              :rows="2"
              placeholder="答案（可留空，之后让 AI 生成）"
              size="small"
              class="cand-answer"
            />
          </div>
          <el-select v-model="c.category" size="small" class="category-select">
            <el-option v-for="cat in KNOWLEDGE_CATEGORIES" :key="cat" :value="cat" :label="cat" />
          </el-select>
          <el-button link type="danger" size="small" class="remove-row" @click="removeRow(i)">删除</el-button>
        </div>
      </div>
      <div class="step-actions">
        <el-button :disabled="extracting || saving" @click="step = 1">上一步</el-button>
        <el-button type="primary" :loading="saving" :disabled="!checkedCount" @click="commit">确认入库 {{ checkedCount }} 条</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<style scoped>
.dialog-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding: 2px 8px 0 0; }
.dialog-heading h2, .dialog-heading p, .entry-intro h3, .entry-intro p, .panel-heading h3, .panel-heading p, .review-intro h3, .review-intro p { margin: 0; }
.dialog-heading h2 { color: var(--jt-ink, #19202d); font-size: 22px; line-height: 1.25; letter-spacing: -.04em; }
.dialog-heading > div > p:last-child { margin-top: 7px; color: var(--jt-muted, #697386); font-size: 13px; }
.eyebrow { color: var(--jt-primary, #2563eb); font-size: 10px; font-weight: 800; letter-spacing: .14em; margin-bottom: 5px !important; }
.heading-step { flex: none; border: 1px solid #dbe7ff; border-radius: 999px; background: #f5f8ff; color: #3567c9; padding: 5px 10px; font-size: 12px; font-weight: 700; }

.ingest-progress { display: grid; grid-template-columns: 1fr 48px 1fr; align-items: center; margin: 0 0 22px; padding: 14px 16px; border: 1px solid var(--jt-line, #e7e9ee); border-radius: 12px; background: #fbfcfe; }
.progress-step { display: grid; grid-template-columns: 26px auto; column-gap: 9px; align-items: center; color: #98a2b3; }
.progress-step span { grid-row: span 2; display: grid; place-items: center; width: 25px; height: 25px; border-radius: 50%; background: #e9edf3; color: #7b8494; font-size: 12px; font-weight: 800; }
.progress-step b { font-size: 13px; line-height: 1.3; }.progress-step small { font-size: 11px; line-height: 1.35; }
.progress-step.active, .progress-step.done { color: var(--jt-ink, #1e293b); }.progress-step.active span { background: var(--jt-primary, #2563eb); color: #fff; }.progress-step.done span { background: #dff4e7; color: #25824e; }
.ingest-progress > i { height: 1px; background: #e2e7ef; }.ingest-progress > i.done { background: #96d5ad; }

.step-body { min-height: 380px; display: flex; flex-direction: column; }.entry-intro, .review-intro { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; }.entry-intro h3, .review-intro h3 { color: var(--jt-ink, #1e293b); font-size: 16px; }.entry-intro p, .review-intro p { margin-top: 5px; color: var(--jt-muted, #697386); font-size: 12px; }.entry-intro > span, .review-intro > span { border-radius: 999px; background: #f0f4fa; color: #667085; padding: 4px 9px; font-size: 11px; white-space: nowrap; }
.source-meta { display: grid; grid-template-columns: 1fr minmax(250px, .88fr); gap: 14px; margin-bottom: 14px; }.meta-field { min-width: 0; }.meta-field label { display: block; margin: 0 0 7px; color: #526077; font-size: 12px; font-weight: 700; }.company-field :deep(.el-autocomplete), .company-field :deep(.el-input) { width: 100%; }
.material-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(270px, .9fr); gap: 14px; }.material-panel { min-width: 0; border: 1px solid var(--jt-line, #e7e9ee); border-radius: 12px; background: #fff; padding: 14px; }.text-panel { display: flex; flex-direction: column; }.panel-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 11px; }.panel-heading h3 { color: #334155; font-size: 14px; }.panel-heading p { margin-top: 3px; color: #8490a3; font-size: 11px; }.panel-heading > span { color: #8b95a7; font-size: 11px; white-space: nowrap; }.text-area { flex: 1; }.text-area :deep(textarea) { min-height: 220px !important; border-color: transparent; background: #f7f9fc; color: #27364b; line-height: 1.65; }.text-area :deep(textarea:focus) { background: #fff; border-color: var(--el-color-primary); box-shadow: 0 0 0 2px rgb(37 99 235 / 10%); }
.drop-zone { min-height: 220px; border: 1.5px dashed #ccd6e4; border-radius: 9px; background: #fafcff; padding: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; transition: border-color .2s, background .2s; }.drop-zone.drag-over { border-color: var(--jt-primary, #2563eb); background: #f0f6ff; }.drop-zone.populated { justify-content: space-between; align-items: stretch; }.drop-tip { display: flex; flex-direction: column; align-items: center; gap: 5px; color: #7b8799; font-size: 12px; text-align: center; }.drop-tip strong { color: #4c5c73; font-size: 13px; }.file-list { display: flex; flex-direction: column; gap: 7px; overflow: auto; max-height: 172px; }.file-chip { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid #e7ebf1; border-radius: 7px; background: #fff; padding: 5px; }.file-thumb { width: 44px; height: 36px; flex: none; object-fit: cover; border-radius: 4px; }.file-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }.file-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #4a576b; font-size: 12px; }.file-copy small { color: #9aa4b3; font-size: 10px; }
.privacy-note { margin: 12px 0 0; color: #8590a0; font-size: 11px; line-height: 1.55; }.step-actions { min-height: 40px; margin-top: 18px; display: flex; align-items: center; justify-content: flex-end; gap: 9px; }.action-hint { margin-right: auto; color: #8a94a4; font-size: 12px; }

.confirm-form { padding: 13px 14px 1px; border: 1px solid var(--jt-line, #e7e9ee); border-radius: 10px; background: #fbfcfe; margin-bottom: 17px; }.confirm-row { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; }.confirm-form :deep(.el-form-item) { margin-bottom: 12px; }.cand-toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }.cand-count { color: #697386; font-size: 12px; }.cand-count b { color: var(--jt-primary, #2563eb); font-size: 15px; }.cand-empty { border: 1px dashed #d8e0ea; border-radius: 10px; color: #8490a1; font-size: 13px; padding: 36px 0; text-align: center; }.cand-list { max-height: 42vh; overflow: auto; display: flex; flex-direction: column; gap: 9px; padding-right: 4px; }.cand-row { display: flex; gap: 10px; align-items: flex-start; padding: 11px; border: 1px solid #e6ebf1; border-radius: 10px; background: #fff; transition: border-color .16s, box-shadow .16s; }.cand-row:has(.el-checkbox.is-checked) { border-color: #c9dcff; box-shadow: 0 2px 8px rgb(39 92 181 / 5%); }.cand-check { padding-top: 23px; }.cand-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }.question-label { color: #76839a; font-size: 11px; font-weight: 700; }.cand-answer :deep(textarea) { font-size: 12px; line-height: 1.5; }.category-select { width: 104px; margin-top: 19px; }.remove-row { margin-top: 21px; }
@media (max-width: 680px) { .dialog-heading { padding-right: 28px; }.heading-step { display: none; }.ingest-progress { grid-template-columns: 1fr 20px 1fr; padding: 12px; }.material-grid, .source-meta, .confirm-row { grid-template-columns: 1fr; }.image-panel { min-height: 230px; }.category-select { width: 86px; }.cand-row { gap: 7px; }.remove-row { font-size: 0; }.remove-row::after { content: '×'; font-size: 16px; }.entry-intro > span { display: none; } }
</style>
