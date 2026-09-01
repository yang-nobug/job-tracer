<script setup lang="ts">
import { reactive, ref, watch, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, ApiError } from '../api'
import { bumpData } from '../store'
import { STATUS_LABEL_LIST, DEFAULT_CHANNELS, type Application, type Resume, type Status } from '../types'
import ResumePicker from './ResumePicker.vue'
import ApplicationImportDialog, { type ImportChoice } from './ApplicationImportDialog.vue'
import { isCalendarDate, isClockTime, IMPORT_FIELDS, type ImportDraft } from '../../../shared/application-import'

const props = defineProps<{ modelValue: boolean; editing: Application | null }>()
const emit = defineEmits<(e: 'update:modelValue', v: boolean) => void>()

interface FormState {
  company: string
  position: string
  status: Status
  applied_at: string | null
  applied_time: string | null
  channel: string
  location: string
  resume_id: number | null
  jd_link: string
  jd_text: string
  contact_name: string
  contact_info: string
  notes: string
}

function emptyForm(): FormState {
  return {
    company: '', position: '', status: 'unsent', applied_at: null, applied_time: null,
    channel: '官网', location: '', resume_id: null,
    jd_link: '', jd_text: '', contact_name: '', contact_info: '', notes: ''
  }
}

const form = reactive<FormState>(emptyForm())
const saving = ref(false)
const importDialogOpen = ref(false)
const importDialog = ref<InstanceType<typeof ApplicationImportDialog>>()
const importDraft = ref<ImportDraft | null>(null)
const importConfirmed = ref(false)
const importManual = ref(false)
const formSession = ref(0)
const manuallyEdited = new Set<keyof FormState>()
const autoFilled = new Set<keyof FormState>()
let applying = false
let committedImport: string | undefined
watch(() => ({ ...form }), (value, previous) => {
  if (applying) return
  for (const key of Object.keys(value) as (keyof FormState)[]) if (value[key] !== previous[key]) manuallyEdited.add(key)
  importConfirmed.value = false
}, { flush: 'sync' })

function applyImport(choice: ImportChoice) {
  const oldId = importDraft.value?.id
  if (oldId && oldId !== choice.draft.id) void api.delete(`/application-imports/${oldId}`).catch(() => {})
  importDraft.value = choice.draft
  importManual.value = choice.manual
  importConfirmed.value = false
  const skipped: string[] = []
  applying = true
  try {
    if (!choice.manual) {
      for (const key of IMPORT_FIELDS) {
        const target = (key === 'summary' ? 'notes' : key) as keyof FormState
        if (manuallyEdited.has(target)) { if (choice.values[key]) skipped.push(target); continue }
        const value = choice.values[key]
        if (value || autoFilled.has(target) || target === 'channel') {
          // All extracted fields are text; null/missing values must not keep stale AI output.
          Object.assign(form, { [target]: value || (target === 'status' ? 'unsent' : '') })
          autoFilled.add(target)
        }
      }
      for (const [key, value] of [['applied_at', choice.date], ['applied_time', choice.time]] as const) {
        if (manuallyEdited.has(key)) { if (value) skipped.push(key); continue }
        form[key] = value; autoFilled.add(key)
      }
      if (choice.date && !choice.values.status && !manuallyEdited.has('status') && choice.draft.analysis?.extraction.fields.status.state === 'missing') form.status = 'applied'
    }
  } finally { applying = false }
  ElMessage.success(skipped.length ? '已填入识别结果；你手动修改过的字段已保留，请逐项核对' : '材料已保留，请核对表单与实际投递时间后保存')
}
function changeStatus(status: Status) {
  // Only an explicit user action can clear the date; model assignments never trigger this.
  if (status === 'unsent') { form.applied_at = null; form.applied_time = null }
}

// 公司自动补全（选中已有公司带出默认值）
interface CompanyMeta { company: string; location: string | null; channel: string | null; count: number }
const companies = ref<CompanyMeta[]>([])

async function loadCompanies(): Promise<void> {
  try {
    const meta = await api.get<{ companies: CompanyMeta[] }>('/meta')
    companies.value = meta.companies
  } catch { /* 忽略 */ }
}

function queryCompanies(queryString: string, cb: (results: CompanyMeta[]) => void): void {
  const q = queryString.trim()
  const results = q
    ? companies.value.filter((c) => c.company.toLowerCase().includes(q.toLowerCase()))
    : companies.value
  cb(results.slice(0, 10))
}

function onCompanySelected(item: CompanyMeta): void {
  if (!form.location && item.location) form.location = item.location
  // 未手动改过渠道时，选中已有公司带出其常用渠道
  if ((!form.channel || form.channel === '官网') && item.channel) form.channel = item.channel
}

function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 打开时初始化表单
watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      applying = true
      importDraft.value = null; importConfirmed.value = false; importManual.value = false
      committedImport = undefined; manuallyEdited.clear(); autoFilled.clear(); formSession.value++
      if (props.editing) {
        const e = props.editing
        Object.assign(form, {
          company: e.company, position: e.position, status: e.status,
          applied_at: e.applied_at, applied_time: e.applied_time ?? null, channel: e.channel || '', location: e.location || '',
          resume_id: e.resume_id, jd_link: e.jd_link || '', jd_text: e.jd_text || '',
          contact_name: e.contact_name || '', contact_info: e.contact_info || '', notes: e.notes || ''
        })
      } else {
        Object.assign(form, emptyForm())
      }
      applying = false
      loadCompanies()
    } else {
      importDialogOpen.value = false
      importDialog.value?.dispose(committedImport)
      importDraft.value = null
    }
  }
)

const title = computed(() => (props.editing ? `编辑：${props.editing.company}` : '新增投递'))

async function save(): Promise<void> {
  if (saving.value) return
  if (!form.company.trim() || !form.position.trim()) {
    ElMessage.warning('公司和职位为必填项')
    return
  }
  if (form.status !== 'unsent' && (!form.applied_at || !isCalendarDate(form.applied_at))) { ElMessage.warning('请填写实际投递日期；系统不会自动使用今天'); return }
  if (form.applied_time && !isClockTime(form.applied_time)) { ElMessage.warning('时刻格式应为 HH:mm 或 HH:mm:ss'); return }
  if (importDraft.value && !importConfirmed.value) { ElMessage.warning('请先勾选确认：已核对字段和投递时间'); return }
  saving.value = true
  try {
    const payload = {
      company: form.company, position: form.position, status: form.status,
      applied_at: form.applied_at, applied_time: form.applied_time || null, channel: form.channel, location: form.location,
      resume_id: form.resume_id, jd_link: form.jd_link, jd_text: form.jd_text,
      contact_name: form.contact_name, contact_info: form.contact_info, notes: form.notes,
      import_id: importDraft.value?.id, import_confirmed: importConfirmed.value, import_manual: importManual.value
    }
    if (props.editing) {
      await api.put(`/applications/${props.editing.id}`, payload)
      ElMessage.success('已保存')
    } else {
      try { await api.post('/applications', payload) }
      catch (err) {
        if (!(err instanceof ApiError) || !Array.isArray(err.body.duplicates)) throw err
        const records = err.body.duplicates as { id: number; company: string; position: string }[]
        await ElMessageBox.confirm(`已有相似记录：${records.map(record => `#${record.id} ${record.company} · ${record.position}`).join('；')}。仍要新增一条吗？`, '重复记录提醒', { type: 'warning', confirmButtonText: '确认新增', cancelButtonText: '返回检查' })
        await api.post('/applications', { ...payload, allow_duplicate: true })
      }
      committedImport = importDraft.value?.id
      ElMessage.success('已记录')
    }
    bumpData()
    emit('update:modelValue', false)
  } catch (err) {
    if (err !== 'cancel' && err !== 'close') ElMessage.error((err as Error).message)
  } finally {
    saving.value = false
  }
}

// JD 粘贴解析
const jdDialogOpen = ref(false)
const jdInput = ref('')
const parsing = ref(false)
const aiParsing = ref(false)

function openJdDialog(): void {
  jdInput.value = ''
  jdDialogOpen.value = true
}

async function parseJd(): Promise<void> {
  if (!jdInput.value.trim()) {
    ElMessage.warning('请粘贴 JD 文本')
    return
  }
  parsing.value = true
  try {
    const result = await api.post<{ company?: string; position?: string; location?: string }>('/jd-parse', {
      text: jdInput.value
    })
    if (result.company) form.company = result.company
    if (result.position) form.position = result.position
    if (result.location) form.location = result.location
    form.jd_text = jdInput.value
    jdDialogOpen.value = false
    ElMessage.success(
      `已识别${result.company ? '公司' : ''}${result.position ? '、职位' : ''}${result.location ? '、地点' : ''}，请核对`
    )
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    parsing.value = false
  }
}

// AI 解析（火山方舟，需在 config.json 配置）
async function parseJdAi(): Promise<void> {
  if (!jdInput.value.trim()) {
    ElMessage.warning('请粘贴 JD 文本')
    return
  }
  aiParsing.value = true
  try {
    const result = await api.post<{
      company?: string
      position?: string
      location?: string
      summary?: string
      jd?: string
    }>('/ai/jd-parse', { text: jdInput.value })
    if (result.company) form.company = result.company
    if (result.position) form.position = result.position
    if (result.location) form.location = result.location
    // 优先使用 AI 清洗后的 JD 正文，避免把整页复制的导航等垃圾内容存进来
    form.jd_text = result.jd || jdInput.value
    if (result.summary) {
      form.notes = form.notes ? `${form.notes}\n${result.summary}` : result.summary
    }
    jdDialogOpen.value = false
    ElMessage.success('AI 解析完成，请核对填写结果')
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    aiParsing.value = false
  }
}

const resumesReloadTrigger = ref(0)
const channels = computed(() => DEFAULT_CHANNELS)
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="720px"
    top="6vh"
    destroy-on-close
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="!editing" class="jd-parse-bar" @click="importDialogOpen = true">
      <span class="jd-parse-icon">📷</span>
      <span class="jd-parse-text">
        <b>招聘信息智能录入</b>
        <small>上传一张或多张截图，也可粘贴招聘文字；提取字段和真实投递时间</small>
      </span>
      <el-button size="small" plain @click.stop="importDialogOpen = true">{{ importDraft ? '查看材料' : '添加材料' }}</el-button>
    </div>
    <el-alert v-if="importDraft" type="info" :closable="false" :title="`已关联 ${importDraft.sources.length} 份原始材料。识别结果只是草稿，保存前请核对。`" />

    <el-form label-width="82px" label-position="left" class="app-form">
      <div class="form-grid">
        <el-form-item label="公司" required>
          <el-autocomplete
            v-model="form.company"
            :fetch-suggestions="queryCompanies"
            value-key="company"
            placeholder="公司名"
            style="width: 100%"
            @select="onCompanySelected"
          />
        </el-form-item>
        <el-form-item label="职位" required>
          <el-input v-model="form.position" placeholder="职位名" />
        </el-form-item>
        <el-form-item label="状态">
          <el-select v-model="form.status" style="width: 100%" @change="changeStatus">
            <el-option v-for="s in STATUS_LABEL_LIST" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.status !== 'unsent'" label="投递日期" required>
          <el-date-picker v-model="form.applied_at" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
          <el-button link type="primary" @click="form.applied_at = todayStr()">明确使用今天</el-button>
        </el-form-item>
        <el-form-item v-if="form.status !== 'unsent'" label="投递时刻">
          <el-input v-model="form.applied_time" placeholder="可选，如 14:35 或 14:35:20" clearable />
        </el-form-item>
        <el-form-item label="渠道">
          <el-select v-model="form.channel" allow-create filterable clearable placeholder="选择或输入" style="width: 100%">
            <el-option v-for="c in channels" :key="c" :label="c" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="地点">
          <el-input v-model="form.location" placeholder="如：北京市海淀区" />
        </el-form-item>
        <el-form-item label="联系人">
          <el-input v-model="form.contact_name" placeholder="HR / 猎头姓名" />
        </el-form-item>
        <el-form-item label="联系方式">
          <el-input v-model="form.contact_info" placeholder="电话 / 微信 / 邮箱" />
        </el-form-item>
        <el-form-item label="简历" class="span-2">
          <ResumePicker v-model="form.resume_id" :reload-trigger="resumesReloadTrigger" />
        </el-form-item>
        <el-form-item label="投递链接" class="span-2">
          <el-input v-model="form.jd_link" placeholder="https://…（职位页 / 进度查询页，可选）" />
        </el-form-item>
        <el-form-item label="JD 正文" class="span-2">
          <el-input v-model="form.jd_text" type="textarea" :rows="4" placeholder="粘贴职位描述快照（可选）" />
        </el-form-item>
        <el-form-item label="备注" class="span-2">
          <el-input v-model="form.notes" type="textarea" :rows="2" />
        </el-form-item>
      </div>
    </el-form>
    <el-checkbox v-if="importDraft" v-model="importConfirmed">我已核对公司、职位、状态及实际投递时间，确认保存</el-checkbox>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="openJdDialog">📄 粘贴 JD 解析</el-button>
        <div>
          <el-button @click="emit('update:modelValue', false)">取消</el-button>
          <el-button type="primary" :loading="saving" @click="save">保存</el-button>
        </div>
      </div>
    </template>

    <el-dialog v-model="jdDialogOpen" title="粘贴 JD 解析" width="560px" append-to-body>
      <el-input v-model="jdInput" type="textarea" :rows="10" placeholder="把招聘 JD 原文粘贴到这里，自动识别公司 / 职位 / 地点" />
      <template #footer>
        <el-button @click="jdDialogOpen = false">取消</el-button>
        <el-button :loading="parsing" @click="parseJd">本地解析</el-button>
        <el-button type="primary" :loading="aiParsing" @click="parseJdAi">✨ AI 解析</el-button>
      </template>
    </el-dialog>
    <ApplicationImportDialog :key="formSession" ref="importDialog" v-model="importDialogOpen" :draft="importDraft" @apply="applyImport" />
  </el-dialog>
</template>

<style scoped>
.jd-parse-bar {
  display: flex; align-items: center; gap: 12px;
  border: 1.5px dashed #c6d2e3; border-radius: 10px;
  padding: 12px 16px; margin-bottom: 18px; cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.jd-parse-bar:hover { border-color: #409eff; background: #f5f9ff; }
.jd-parse-icon { font-size: 20px; }
.jd-parse-text { flex: 1; display: flex; flex-direction: column; gap: 1px; }
.jd-parse-text b { font-size: 14px; color: #3c4353; }
.jd-parse-text small { font-size: 12px; color: #9aa2b1; }
.form-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 20px; }
.form-grid .span-2 { grid-column: span 2; }
.dialog-footer { display: flex; justify-content: space-between; align-items: center; width: 100%; }
</style>
