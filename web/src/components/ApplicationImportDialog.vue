<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { IMPORT_FIELDS, IMPORT_LABELS, IMPORT_LIMITS, type ImportDraft, type ImportField, type Evidence } from '../../../shared/application-import'
import { STATUS_LABELS } from '../types'
import { createInferenceImage } from '../utils/inference-image'

const props = defineProps<{ modelValue: boolean; draft: ImportDraft | null }>()
export interface ImportChoice { draft: ImportDraft; values: Partial<Record<ImportField, string>>; date: string | null; time: string | null; manual: boolean }
const emit = defineEmits<{ 'update:modelValue': [value: boolean]; apply: [choice: ImportChoice] }>()
const text = ref('')
const textDate = ref<string | null>(null)
const files = ref<{ file: File; url: string; date: string | null; key: number }[]>([])
const fileInput = ref<HTMLInputElement>()
const staged = ref<ImportDraft | null>(null)
const dirty = ref(true)
const busy = ref(false)
const phase = ref('')
const error = ref('')
const selections = reactive<Partial<Record<ImportField, string>>>({})
const chosenDate = ref(-1)
const config = ref({ available: false, model: null as string | null, imageModel: null as string | null, maxImages: IMPORT_LIMITS.images })
let controller: AbortController | null = null
let generation = 0
let sequence = 0
const analysis = computed(() => dirty.value ? null : staged.value?.analysis)
const sources = computed(() => staged.value?.sources ?? [])
const hasContent = computed(() => !!text.value.trim() || !!files.value.length)
const selectedModel = computed(() => files.value.length ? config.value.imageModel : config.value.model)
const previewUrls = computed(() => files.value.map(item => item.url))
const visible = computed({ get: () => props.modelValue, set: value => { if (!value) close(); else emit('update:modelValue', value) } })
watch([text, textDate, files], () => { dirty.value = true; error.value = '' }, { deep: true })

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`/api/application-imports${path}`, options)
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.message || '材料处理失败')
  return result as T
}
watch(() => props.modelValue, async open => {
  if (open) {
    try { config.value = await request('/config') } catch { error.value = '无法读取模型配置；仍可保留材料并手动填写' }
  }
})

function pickFiles(event: Event) {
  void addFiles(Array.from((event.target as HTMLInputElement).files ?? []))
  ;(event.target as HTMLInputElement).value = ''
}
async function addFiles(items: File[]) {
  if (busy.value) return
  const current = generation
  for (const file of items) {
    if (files.value.length >= IMPORT_LIMITS.images) { ElMessage.warning('最多添加 9 张截图'); break }
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) { ElMessage.warning('仅支持 PNG、JPEG、WebP 截图'); continue }
    if (file.size > IMPORT_LIMITS.imageBytes || files.value.reduce((n, item) => n + item.file.size, file.size) > IMPORT_LIMITS.totalBytes) {
      ElMessage.warning('每张图片不超过 10 MB，总大小不超过 30 MB'); continue
    }
    try {
      const bitmap = await createImageBitmap(file)
      const valid = bitmap.width * bitmap.height <= IMPORT_LIMITS.pixels && bitmap.width <= 24000 && bitmap.height <= 24000
      bitmap.close()
      if (!valid) { ElMessage.warning('图片像素过大，请分段截图后上传'); continue }
      if (generation !== current) return
      files.value.push({ file, url: URL.createObjectURL(file), date: null, key: sequence++ })
    } catch { ElMessage.warning('图片无法读取，请重新截图') }
  }
}
function paste(event: ClipboardEvent) {
  const images = Array.from(event.clipboardData?.items ?? []).filter(item => item.kind === 'file').map(item => item.getAsFile()).filter((file): file is File => !!file)
  if (images.length) { event.preventDefault(); void addFiles(images) }
}
function remove(index: number) { URL.revokeObjectURL(files.value[index].url); files.value.splice(index, 1) }
function move(index: number, offset: number) { const item = files.value.splice(index, 1)[0]; files.value.splice(index + offset, 0, item) }
async function discard(id: string) {
  try { await request(`/${id}`, { method: 'DELETE' }) } catch { /* expiry cleanup is the fallback for interrupted requests */ }
}
async function upload(signal: AbortSignal): Promise<ImportDraft> {
  if (!dirty.value && staged.value) return staged.value
  const form = new FormData()
  form.append('text', text.value)
  form.append('metadata', JSON.stringify({ text_date: textDate.value, image_dates: files.value.map(file => file.date) }))
  for (const { file } of files.value) {
    form.append('images', file)
    form.append('inference_images', await createInferenceImage(file))
  }
  const previous = staged.value
  const draft = await request<ImportDraft>('', { method: 'POST', body: form, signal })
  if (previous && previous.id !== props.draft?.id) void discard(previous.id)
  staged.value = draft
  dirty.value = false
  return draft
}
async function run(manual = false) {
  if (!hasContent.value || busy.value) return
  if (!manual && (!selectedModel.value || files.value.length > config.value.maxImages)) {
    error.value = files.value.length ? `当前图片模型未配置或超过其 ${config.value.maxImages} 张上限；可减少图片或手动填写` : '尚未配置 AI，可保留材料并手动填写'; return
  }
  const current = ++generation
  controller = new AbortController()
  busy.value = true; error.value = ''; phase.value = '正在上传材料…'
  try {
    const draft = await upload(controller.signal)
    if (current !== generation) {
      if (draft.id !== props.draft?.id) void discard(draft.id)
      if (staged.value?.id === draft.id) { staged.value = null; dirty.value = true }
      return
    }
    if (manual) {
      emit('apply', { draft, values: {}, date: null, time: null, manual: true })
      emit('update:modelValue', false)
      return
    }
    phase.value = '正在联合识别截图和文字，请稍候…'
    const result = await request<ImportDraft>(`/${draft.id}/analyze`, { method: 'POST', signal: controller.signal })
    if (current !== generation) return
    staged.value = result
    dirty.value = false
    for (const key of IMPORT_FIELDS) selections[key] = result.analysis?.extraction.fields[key].value ?? undefined
    chosenDate.value = result.analysis?.applied_date.state === 'resolved' ? -2 : -1
  } catch (err) {
    if (current === generation) error.value = (err as Error).name === 'AbortError' ? '识别已取消，文字和截图仍保留' : (err as Error).message
  } finally { if (current === generation) { busy.value = false; controller = null } }
}
function cancel() { controller?.abort() }
function apply() {
  if (!staged.value || !analysis.value || analysis.value.extraction.target_state !== 'single') return
  let date: string | null = null, time: string | null = null
  if (chosenDate.value === -2 && analysis.value.applied_date.state === 'resolved') {
    date = analysis.value.applied_date.value; time = analysis.value.applied_date.time
  } else if (chosenDate.value >= 0) {
    const candidate = analysis.value.applied_date.candidates[chosenDate.value]
    date = candidate.date; time = candidate.issue ? null : candidate.time
  }
  emit('apply', { draft: staged.value, values: { ...selections }, date, time, manual: false })
  emit('update:modelValue', false)
}
function close() {
  ++generation; cancel(); busy.value = false
  if (staged.value && staged.value.id !== props.draft?.id) { void discard(staged.value.id); staged.value = null; dirty.value = true }
  emit('update:modelValue', false)
}
function dispose(committedId?: string) {
  ++generation; cancel()
  const ids = new Set([staged.value?.id, props.draft?.id])
  for (const id of ids) if (id && id !== committedId) void discard(id)
  files.value.forEach(item => URL.revokeObjectURL(item.url)); files.value = []
  text.value = ''; textDate.value = null; staged.value = null; dirty.value = true
}
defineExpose({ dispose })
onBeforeUnmount(() => { ++generation; cancel(); files.value.forEach(item => URL.revokeObjectURL(item.url)) })
function sourceLabel(id: string) { return id === 'text_1' ? '粘贴文字' : `截图 ${id.replace('image_', '')}` }
function evidenceText(items: Evidence[]) { return items.map(e => `${sourceLabel(e.source_id)}：「${e.quote}」`).join('\n') }
function valueLabel(key: ImportField, value: string) { return key === 'status' ? STATUS_LABELS[value as keyof typeof STATUS_LABELS] ?? value : value }
</script>

<template>
  <el-dialog v-model="visible" title="招聘信息智能录入" width="1120px" top="4vh" append-to-body :close-on-click-modal="false">
    <div class="import-layout" @paste="paste">
      <section class="materials">
        <h3>1. 添加同一个岗位的材料</h3>
        <p class="hint">截图、招聘软件分享文案、投递记录可一起提供。识别后核对，再保存为一条记录。</p>
        <el-input v-model="text" type="textarea" :rows="7" :maxlength="IMPORT_LIMITS.text" show-word-limit :disabled="busy" placeholder="粘贴职位介绍、HR 联系信息或投递记录；也可以在这里 Ctrl+V 粘贴截图" />
        <div class="source-date" v-if="text.trim()">
          <span>文字实际复制日期（可选）</span>
          <el-date-picker v-model="textDate" type="date" value-format="YYYY-MM-DD" :disabled="busy" placeholder="仅用于解释“昨天”等相对日期" style="width: 240px" />
        </div>
        <div class="drop-zone" tabindex="0" @dragover.prevent @drop.prevent="addFiles(Array.from($event.dataTransfer?.files ?? []))">
          <p>拖入图片，或 Ctrl+V 粘贴截图</p>
          <el-button :disabled="busy" @click="fileInput?.click()">选择截图（{{ files.length }}/9）</el-button>
          <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" multiple hidden @change="pickFiles" />
          <p class="hint">PNG / JPEG / WebP，每张 ≤10 MB，总大小 ≤30 MB；长图过大请分段截图。</p>
        </div>
        <div class="image-list">
          <div v-for="(item, index) in files" :key="item.key" class="image-row">
            <el-image :src="item.url" :preview-src-list="previewUrls" :initial-index="index" preview-teleported fit="contain" class="thumb" />
            <div class="image-info">
              <div>截图 {{ index + 1 }} · {{ item.file.name }}</div>
              <el-date-picker v-model="item.date" type="date" value-format="YYYY-MM-DD" :disabled="busy" placeholder="实际截图日期（可选）" size="small" style="width: 190px" />
              <div>
                <el-button link :disabled="busy || index === 0" @click="move(index, -1)">上移</el-button>
                <el-button link :disabled="busy || index === files.length - 1" @click="move(index, 1)">下移</el-button>
                <el-button link type="danger" :disabled="busy" @click="remove(index)">移除</el-button>
              </div>
            </div>
          </div>
        </div>
        <p class="hint">截图日期不是投递日期。不知道就留空；系统不会把上传日期当成截图日期。</p>
        <el-alert type="info" :closable="false" title="点击识别会将文字和最长边不超过 2048 像素的图片副本发送至已配置的 AI 服务。原图只保存在本机用于核对；建议仍先裁掉无关个人信息。" />
      </section>
      <section class="review">
        <h3>2. 核对字段和原文依据</h3>
        <el-alert v-if="error" type="error" :title="error" :closable="false" />
        <el-alert v-if="busy" type="info" :title="phase" :closable="false" />
        <el-empty v-if="!analysis && !busy" description="添加材料后点击“开始识别”" :image-size="80" />
        <template v-if="analysis">
          <el-alert v-if="analysis.extraction.target_state !== 'single'" type="warning" :closable="false" title="无法确定单个岗位，请移除其他岗位材料后重试，或选择手动填写。" />
          <div v-for="(candidate, i) in analysis.extraction.target_candidates" :key="i" class="hint">岗位候选：{{ candidate.company || '公司不明' }} · {{ candidate.position || '职位不明' }}</div>
          <el-alert v-for="(warning, i) in analysis.extraction.warnings" :key="i" type="warning" :closable="false" :title="warning" />
          <div v-for="key in IMPORT_FIELDS" :key="key" class="field-review">
            <b>{{ IMPORT_LABELS[key] }}</b>
            <span v-if="analysis.extraction.fields[key].state === 'missing'" class="hint">材料未提供，留空待补充</span>
            <span v-else-if="analysis.extraction.fields[key].state === 'uncertain'" class="hint">待核对，不自动填入</span>
            <pre v-else-if="analysis.extraction.fields[key].value">{{ valueLabel(key, analysis.extraction.fields[key].value!) }}</pre>
            <el-select v-if="analysis.extraction.fields[key].alternatives.length" v-model="selections[key]" clearable placeholder="冲突：请选择候选或留空手动填写" style="width: 100%">
              <el-option v-for="(alternative, i) in analysis.extraction.fields[key].alternatives" :key="i" :value="alternative.value" :label="valueLabel(key, alternative.value)" />
            </el-select>
            <details v-if="analysis.extraction.fields[key].evidence.length || analysis.extraction.fields[key].alternatives.length">
              <summary>查看原文依据</summary>
              <pre>{{ evidenceText(analysis.extraction.fields[key].evidence) }}</pre>
              <pre v-for="(alternative, i) in analysis.extraction.fields[key].alternatives" :key="i">{{ valueLabel(key, alternative.value) }} — {{ evidenceText(alternative.evidence) }}</pre>
            </details>
          </div>
          <div class="date-review">
            <b>实际投递时间</b>
            <p v-if="analysis.applied_date.state === 'missing'" class="hint">材料没有明确投递时间。若已投递，请在表单补充，系统不会填今天。</p>
            <el-radio-group v-model="chosenDate" class="date-options">
              <el-radio v-if="analysis.applied_date.state === 'resolved'" :value="-2">采用材料：{{ analysis.applied_date.value }} {{ analysis.applied_date.time }}</el-radio>
              <el-radio :value="-1">暂不填入，返回表单手动核对</el-radio>
              <div v-for="(candidate, i) in analysis.applied_date.candidates" :key="i" class="date-candidate">
                <el-radio :value="i" :disabled="!candidate.date">{{ candidate.date || '日期待确认' }} {{ candidate.issue ? '' : candidate.time }}</el-radio>
                <pre>{{ evidenceText(candidate.evidence) }}</pre>
                <p v-if="candidate.issue" class="warning">{{ candidate.issue }}；选择此候选只采用可确定的日期。</p>
              </div>
            </el-radio-group>
            <details v-if="analysis.extraction.date_facts.some(fact => fact.kind !== 'application')">
              <summary>未作为投递时间的其他日期</summary>
              <pre v-for="(fact, i) in analysis.extraction.date_facts.filter(fact => fact.kind !== 'application')" :key="i">{{ fact.kind }}：{{ fact.raw }} — {{ evidenceText(fact.evidence) }}</pre>
            </details>
          </div>
          <div v-if="analysis.duplicates.length" class="duplicate-warning">
            <b>已有相似记录，保存时会再次提醒</b>
            <div v-for="record in analysis.duplicates" :key="record.id">#{{ record.id }} {{ record.company }} · {{ record.position }} {{ record.location }}</div>
          </div>
          <div class="source-previews">
            <el-image v-for="source in sources.filter(source => source.url)" :key="source.id" :src="source.url!" :preview-src-list="sources.flatMap(source => source.url ? [source.url] : [])" :initial-index="sources.filter(source => source.url).indexOf(source)" preview-teleported fit="contain" class="thumb" />
          </div>
          <p class="hint">{{ analysis.model }} · 提示词 {{ analysis.prompt_version }}。图片证据仍需对照原图核对。</p>
        </template>
      </section>
    </div>
    <template #footer>
      <div class="import-footer">
        <el-button v-if="busy" @click="cancel">取消识别</el-button>
        <el-button v-else @click="close">返回表单</el-button>
        <el-button :disabled="busy || !hasContent" @click="run(true)">仅保留材料，手动填写</el-button>
        <el-button :loading="busy" :disabled="!hasContent" @click="run(false)">{{ analysis ? '重新识别' : '开始识别' }}</el-button>
        <el-button type="primary" :disabled="busy || !analysis || analysis.extraction.target_state !== 'single'" @click="apply">填入表单并核对保存</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.import-layout { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.materials, .review { min-width: 0; max-height: 70vh; overflow: auto; padding: 0 6px 12px; }
h3 { font-size: 16px; margin: 0 0 10px; color: #303133; }
.hint { color: #909399; font-size: 12px; line-height: 1.7; }
.source-date { margin: 10px 0; display: flex; gap: 8px; flex-wrap: wrap; font-size: 12px; align-items: center; }
.drop-zone { border: 1.5px dashed #b6c8e0; border-radius: 10px; margin-top: 14px; padding: 10px 12px; text-align: center; background: #f7faff; }
.image-list { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.image-row { display: flex; gap: 12px; padding: 8px; background: #f5f7fa; border-radius: 8px; }
.thumb { width: 78px; height: 78px; flex-shrink: 0; border: 1px solid #dce3ee; border-radius: 6px; background: white; }
.image-info { min-width: 0; display: flex; flex-direction: column; gap: 6px; font-size: 12px; overflow-wrap: anywhere; }
.field-review { border-bottom: 1px solid #ebeef5; padding: 10px 0; display: flex; flex-direction: column; gap: 4px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 4px 0; max-height: 180px; overflow: auto; }
details { font-size: 12px; color: #69788b; }
summary { cursor: pointer; color: #409eff; }
.date-review { background: #f3f8ff; padding: 12px; border-radius: 8px; margin-top: 12px; }
.date-options { display: flex; flex-direction: column; align-items: flex-start; width: 100%; }
.date-candidate { font-size: 12px; width: 100%; border-top: 1px solid #dce6f5; padding: 6px 0; }
.warning, .duplicate-warning { color: #a76914; font-size: 12px; }
.duplicate-warning { padding: 10px; background: #fff7e8; border-radius: 8px; margin-top: 12px; }
.source-previews { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
.import-footer { display: flex; justify-content: flex-end; gap: 6px; }
.el-alert { margin-bottom: 10px; }
</style>
