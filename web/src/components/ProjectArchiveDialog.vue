<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import type { ProjectArchiveSummary, ProjectCodeFile, ProjectCodeSearchResult, ProjectFact } from '../types'
import CodeReadingDialog from './CodeReadingDialog.vue'

const open = defineModel<boolean>({ default: false })
const projects = ref<ProjectArchiveSummary[]>([])
const loading = ref(false)
const creating = ref(false)
const sourcePath = ref('')
const name = ref('')
const description = ref('')
const activeId = ref<number | null>(null)
const files = ref<ProjectCodeFile[]>([])
const searchText = ref('')
const results = ref<ProjectCodeSearchResult[]>([])
const detailLoading = ref(false)
const facts = ref<ProjectFact[]>([])
const factType = ref<ProjectFact['fact_type']>('responsibility')
const factTitle = ref('')
const factContent = ref('')
const factSaving = ref(false)
const codeReadingOpen = ref(false)
const showCreate = ref(false)

const activeProject = computed(() => projects.value.find(item => item.id === activeId.value) ?? null)
function formatBytes(value?: number | null): string {
  if (!value) return '0 B'
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}
async function loadProjects(): Promise<void> {
  loading.value = true
  try {
    projects.value = await api.get<ProjectArchiveSummary[]>('/projects')
    if (!projects.value.length) showCreate.value = true
    if (!activeId.value && projects.value[0]) await selectProject(projects.value[0].id)
  } catch (error) { ElMessage.error((error as Error).message) } finally { loading.value = false }
}
async function selectProject(id: number): Promise<void> {
  activeId.value = id; results.value = []; detailLoading.value = true
  try {
    const detail = await api.get<{ project: ProjectArchiveSummary; files: ProjectCodeFile[]; facts: ProjectFact[] }>(`/projects/${id}`)
    files.value = detail.files; facts.value = detail.facts
  } catch (error) { ElMessage.error((error as Error).message) } finally { detailLoading.value = false }
}
async function createFact(): Promise<void> {
  if (!activeId.value || !factTitle.value.trim() || !factContent.value.trim()) { ElMessage.warning('请填写项目事实的标题和内容'); return }
  factSaving.value = true
  try {
    await api.post(`/projects/${activeId.value}/facts`, { fact_type: factType.value, title: factTitle.value, content: factContent.value })
    factTitle.value = ''; factContent.value = ''; await selectProject(activeId.value); ElMessage.success('已保存为用户确认的项目事实')
  } catch (error) { ElMessage.error((error as Error).message) } finally { factSaving.value = false }
}
async function create(): Promise<void> {
  if (!sourcePath.value.trim()) { ElMessage.warning('请填写本机项目根目录'); return }
  creating.value = true
  try {
    const detail = await api.post<{ project: ProjectArchiveSummary }>('/projects', { source_path: sourcePath.value, name: name.value, description: description.value })
    sourcePath.value = ''; name.value = ''; description.value = ''
    await loadProjects(); await selectProject(detail.project.id)
    ElMessage.success('项目档案已建立；请点击“建立只读索引”扫描代码')
  } catch (error) { ElMessage.error((error as Error).message) } finally { creating.value = false }
}
async function scan(): Promise<void> {
  if (!activeId.value) return
  try {
    await ElMessageBox.confirm('扫描只会读取该目录内容。不会写入代码仓库、不会修改 Git 状态，也会跳过密钥、node_modules 和构建目录。', '建立只读索引', { confirmButtonText: '开始只读扫描', cancelButtonText: '取消', type: 'warning' })
    detailLoading.value = true
    await api.post(`/projects/${activeId.value}/scan`)
    await loadProjects(); await selectProject(activeId.value)
    ElMessage.success('只读索引已更新')
  } catch (error) { if (error !== 'cancel') ElMessage.error((error as Error).message) } finally { detailLoading.value = false }
}
async function search(): Promise<void> {
  if (!activeId.value || !searchText.value.trim()) return
  try { results.value = await api.get<ProjectCodeSearchResult[]>(`/projects/${activeId.value}/search?q=${encodeURIComponent(searchText.value.trim())}`) }
  catch (error) { ElMessage.error((error as Error).message) }
}
async function remove(): Promise<void> {
  if (!activeId.value || !activeProject.value) return
  try {
    await ElMessageBox.confirm(`删除“${activeProject.value.name}”在 job-tracer 中的索引和项目事实？原代码仓库不会受影响。`, '删除项目档案', { type: 'warning' })
    await api.delete(`/projects/${activeId.value}`); activeId.value = null; files.value = []; results.value = []; await loadProjects(); ElMessage.success('已删除本地索引')
  } catch (error) { if (error !== 'cancel') ElMessage.error((error as Error).message) }
}
watch(open, value => { if (value) void loadProjects() })
</script>

<template>
  <el-dialog v-model="open" width="1080px" top="4vh" destroy-on-close class="project-archive-dialog">
    <template #header>
      <div class="archive-heading">
        <div>
          <p class="eyebrow">PROJECT EVIDENCE</p>
          <h2>项目档案</h2>
          <p>把你的项目事实和只读代码证据整理成可用于面试准备的资料。</p>
        </div>
        <span class="readonly-badge">只读访问代码仓库</span>
      </div>
    </template>

    <section class="archive-notice">
      <div><strong>代码仓库不会被修改</strong><p>不会写入缓存、配置或 Git 文件；索引和确认事实仅保存在 job-tracer。</p></div>
      <el-button plain @click="showCreate = !showCreate">{{ showCreate ? '收起接入表单' : '接入新项目' }}</el-button>
    </section>

    <el-collapse-transition>
      <section v-show="showCreate" class="project-create">
        <div class="create-heading"><div><h3>接入本机项目</h3><p>填写项目根目录后，系统只会建立独立索引。</p></div></div>
        <el-form label-position="top">
          <div class="form-grid">
            <el-form-item label="本机项目根目录"><el-input v-model="sourcePath" placeholder="例如 F:\\my-project" /></el-form-item>
            <el-form-item label="项目名称（可选）"><el-input v-model="name" placeholder="默认使用目录名" /></el-form-item>
          </div>
          <el-form-item label="项目说明（可选）"><el-input v-model="description" type="textarea" :rows="2" maxlength="2000" show-word-limit placeholder="用自己的话说明项目目标、职责或想重点准备的内容" /></el-form-item>
          <div class="create-actions"><span>接入后再单独发起“建立只读索引”扫描。</span><el-button type="primary" :loading="creating" @click="create">接入项目档案</el-button></div>
        </el-form>
      </section>
    </el-collapse-transition>

    <div class="archive-layout" v-loading="loading">
      <aside class="project-list">
        <div class="list-heading"><div><span>已接入项目</span><b>{{ projects.length }}</b></div><small>选择一个项目查看档案</small></div>
        <el-empty v-if="!projects.length" description="尚未接入项目" :image-size="62" />
        <button v-for="project in projects" :key="project.id" class="project-row" :class="{ active: project.id === activeId }" @click="selectProject(project.id)">
          <span class="project-mark">{{ project.name.slice(0, 1).toUpperCase() }}</span>
          <span class="project-row-copy"><strong>{{ project.name }}</strong><small>{{ project.files_indexed ?? 0 }} 文件 · {{ project.symbol_count ?? 0 }} 符号</small></span>
        </button>
      </aside>
      <section class="project-detail" v-loading="detailLoading">
        <el-empty v-if="!activeProject" description="选择一个项目查看索引" />
        <template v-else>
          <header class="detail-head"><div><h3>{{ activeProject.name }}</h3><p :title="activeProject.root_realpath">{{ activeProject.root_realpath }}</p></div><div class="detail-actions"><el-button @click="codeReadingOpen = true">代码理解 Agent</el-button><el-button type="primary" @click="scan">建立只读索引</el-button><el-button type="danger" text @click="remove">删除</el-button></div></header>
          <div v-if="activeProject.truncated" class="partial-alert">本次扫描达到安全上限，当前索引是部分结果。</div>
          <div class="metrics">
            <div><span>已索引文件</span><b>{{ activeProject.files_indexed ?? 0 }} <small>/ {{ activeProject.files_seen ?? 0 }}</small></b></div>
            <div><span>已读取数据</span><b>{{ formatBytes(activeProject.bytes_read) }}</b></div>
            <div><span>最近扫描</span><b class="metric-time">{{ activeProject.scanned_at ? new Date(activeProject.scanned_at).toLocaleString() : '尚未扫描' }}</b></div>
          </div>

          <section class="facts-section">
            <div class="section-heading"><div><h4>确认过的项目事实</h4><p>仅保存你愿意用于面试准备的信息，作为 Agent 的受控上下文。</p></div><span>{{ facts.length }} 条</span></div>
            <div v-if="facts.length" class="fact-list"><article v-for="fact in facts" :key="fact.id" class="fact"><el-tag size="small" effect="plain">{{ fact.fact_type }}</el-tag><div><strong>{{ fact.title }}</strong><p>{{ fact.content }}</p></div></article></div>
            <div v-else class="fact-empty">还没有确认事实。先写下你的职责、关键决策或真实结果。</div>
            <div class="fact-form"><el-select v-model="factType"><el-option label="个人职责" value="responsibility" /><el-option label="架构" value="architecture" /><el-option label="技术选型" value="technology" /><el-option label="关键决策" value="decision" /><el-option label="指标成果" value="metric" /><el-option label="风险与取舍" value="risk" /></el-select><el-input v-model="factTitle" placeholder="标题，例如：负责 RAG 检索链路" /><el-input v-model="factContent" type="textarea" :rows="2" placeholder="说明你的具体工作、依据和结果" /><el-button type="primary" :loading="factSaving" @click="createFact">保存事实</el-button></div>
          </section>

          <section class="code-section">
            <div class="section-heading"><div><h4>检索代码证据</h4><p>按函数名、技术词或代码文本查找已建立的只读索引。</p></div></div>
            <el-input v-model="searchText" placeholder="例如：retrieval、handleSubmit、鉴权" clearable @keyup.enter="search"><template #append><el-button @click="search">检索</el-button></template></el-input>
            <div v-if="results.length" class="results"><article v-for="item in results" :key="item.id"><div><code>{{ item.relative_path }}:{{ item.start_line }}-{{ item.end_line }}</code><el-tag v-if="item.symbol_name" size="small" effect="plain">{{ item.symbol_kind }} {{ item.symbol_name }}</el-tag></div><pre>{{ item.content }}</pre></article></div>
            <div v-else class="file-list"><div class="file-list-heading"><span>已索引文件</span><small>最多展示 300 个</small></div><div v-for="file in files" :key="file.id"><code>{{ file.relative_path }}</code><span>{{ file.language }} · {{ file.line_count }} 行</span></div></div>
          </section>
        </template>
      </section>
    </div>
    <CodeReadingDialog v-model="codeReadingOpen" :project="activeProject" />
  </el-dialog>
</template>

<style scoped>
.archive-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; padding-right:10px; }.archive-heading h2,.archive-heading p,.create-heading h3,.create-heading p,.section-heading h4,.section-heading p { margin:0; }.archive-heading h2 { color:var(--jt-ink,#1e293b); font-size:22px; letter-spacing:-.04em; }.archive-heading>div>p:last-child { margin-top:7px; color:var(--jt-muted,#697386); font-size:13px; }.eyebrow { margin-bottom:5px!important; color:var(--jt-primary,#2563eb); font-size:10px; font-weight:800; letter-spacing:.14em; }.readonly-badge { border:1px solid #d7eedf; border-radius:999px; background:#f2fbf5; color:#287747; padding:5px 10px; font-size:11px; font-weight:700; white-space:nowrap; }
.archive-notice { display:flex; align-items:center; justify-content:space-between; gap:18px; padding:13px 15px; border:1px solid #dfe8f5; border-radius:11px; background:#f8fbff; }.archive-notice strong { color:#34435a; font-size:13px; }.archive-notice p { margin:4px 0 0; color:#728096; font-size:12px; }.project-create { margin:14px 0; border:1px solid #dbe7f8; border-radius:11px; padding:16px; background:#fcfdff; }.create-heading { margin-bottom:12px; }.create-heading h3,.section-heading h4 { color:#35445c; font-size:14px; }.create-heading p,.section-heading p { margin-top:4px; color:#7a879a; font-size:12px; line-height:1.45; }.form-grid { display:grid; grid-template-columns:2fr 1fr; gap:14px; }.project-create :deep(.el-form-item) { margin-bottom:12px; }.create-actions { display:flex; align-items:center; justify-content:space-between; gap:12px; color:#8792a3; font-size:12px; }
.archive-layout { display:grid; grid-template-columns:244px minmax(0,1fr); min-height:500px; border:1px solid var(--jt-line,#e7e9ee); border-radius:13px; overflow:hidden; background:#fff; }.project-list { padding:15px 10px; border-right:1px solid var(--jt-line,#e7e9ee); background:#fafbfd; overflow:auto; }.list-heading { padding:0 5px 11px; border-bottom:1px solid #edf0f4; }.list-heading>div { display:flex; align-items:center; justify-content:space-between; color:#536176; font-size:12px; font-weight:700; }.list-heading b { display:grid; place-items:center; min-width:20px; height:20px; border-radius:999px; background:#e8f0ff; color:#3970cc; font-size:11px; }.list-heading small { display:block; margin-top:5px; color:#98a2b3; font-size:11px; }.project-row { display:flex; align-items:center; width:100%; border:1px solid transparent; border-radius:9px; padding:9px; margin-top:7px; background:transparent; text-align:left; gap:9px; cursor:pointer; transition:.16s ease; }.project-row:hover { border-color:#e3eaf4; background:#fff; }.project-row.active { border-color:#caddff; background:#f1f6ff; box-shadow:0 2px 6px rgb(40 84 155 / 5%); }.project-mark { display:grid; place-items:center; width:28px; height:28px; flex:none; border-radius:7px; background:#e8eef8; color:#526681; font-size:12px; font-weight:800; }.project-row.active .project-mark { background:#3774d6; color:#fff; }.project-row-copy { min-width:0; display:flex; flex-direction:column; gap:3px; }.project-row strong { overflow:hidden; color:#3c4a60; font-size:13px; text-overflow:ellipsis; white-space:nowrap; }.project-row small { color:#8a96a8; font-size:11px; }
.project-detail { min-width:0; padding:20px; overflow:auto; }.detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }.detail-head h3 { margin:0 0 6px; color:var(--jt-ink,#263246); font-size:19px; letter-spacing:-.03em; }.detail-head p { max-width:360px; overflow:hidden; margin:0; color:#8995a6; font:11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }.detail-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:7px; }.partial-alert { margin-top:14px; border-left:3px solid #e6a23c; border-radius:5px; background:#fdf6ec; color:#a56c13; padding:8px 10px; font-size:12px; }.metrics { display:grid; grid-template-columns:1fr 1fr 1.45fr; gap:9px; margin:17px 0; }.metrics>div { min-width:0; border:1px solid #e7ecf3; border-radius:9px; padding:10px 11px; background:#fbfcfe; }.metrics span { display:block; color:#8a96a7; font-size:11px; }.metrics b { display:block; margin-top:4px; overflow:hidden; color:#48566c; font-size:14px; text-overflow:ellipsis; white-space:nowrap; }.metrics b small { display:inline; color:#98a2b1; font-size:11px; font-weight:500; }.metrics .metric-time { color:#657187; font-size:11px; font-weight:600; }
.facts-section,.code-section { border-top:1px solid #ecf0f4; padding-top:16px; margin-top:17px; }.section-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; margin-bottom:11px; }.section-heading>span { border-radius:999px; background:#f0f3f8; color:#748095; padding:4px 8px; font-size:11px; white-space:nowrap; }.fact-list { display:grid; gap:7px; margin-bottom:10px; }.fact { display:grid; grid-template-columns:auto 1fr; gap:9px; align-items:flex-start; border:1px solid #e9edf3; border-radius:8px; padding:9px 10px; background:#fff; }.fact strong { color:#4a576a; font-size:13px; }.fact p { margin:4px 0 0; color:#69768a; font-size:12px; line-height:1.55; white-space:pre-wrap; }.fact-empty { margin-bottom:10px; border:1px dashed #d9e1eb; border-radius:8px; padding:13px; color:#929dad; font-size:12px; text-align:center; }.fact-form { display:grid; grid-template-columns:145px minmax(0,1fr) auto; gap:8px; padding:11px; border-radius:9px; background:#f7f9fc; }.fact-form :deep(textarea) { grid-column:1 / 3; }.fact-form .el-button { align-self:end; }.file-list { max-height:260px; overflow:auto; margin-top:13px; border:1px solid #e9edf2; border-radius:8px; }.file-list-heading,.file-list>div:not(.file-list-heading) { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:8px 10px; border-bottom:1px solid #f0f2f5; font-size:12px; }.file-list>div:last-child { border-bottom:0; }.file-list-heading { background:#fafbfd; color:#5b687b; font-weight:700; }.file-list-heading small,.file-list span { color:#97a2b1; white-space:nowrap; }.file-list code { overflow:hidden; color:#52627a; text-overflow:ellipsis; white-space:nowrap; }.results { max-height:390px; overflow:auto; margin-top:13px; }.results article { border:1px solid #e6ebf1; border-radius:8px; padding:10px; margin-bottom:9px; background:#fff; }.results article>div { display:flex; justify-content:space-between; align-items:center; gap:8px; }.results code { color:#46658d; font-size:12px; }.results pre { max-height:220px; overflow:auto; margin:9px 0 0; border-radius:6px; padding:9px; background:#f7f9fc; color:#526075; font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
@media (max-width:760px) { .archive-heading { padding-right:28px; }.readonly-badge { display:none; }.archive-notice,.create-actions,.detail-head { align-items:flex-start; flex-direction:column; }.form-grid,.archive-layout,.metrics { grid-template-columns:1fr; }.project-list { max-height:190px; border-right:0; border-bottom:1px solid var(--jt-line,#e7e9ee); }.project-detail { padding:15px; }.detail-actions { justify-content:flex-start; }.fact-form { grid-template-columns:1fr; }.fact-form :deep(textarea) { grid-column:auto; }.fact-form .el-button { justify-self:start; }.file-list>div:not(.file-list-heading) { align-items:flex-start; flex-direction:column; gap:3px; } }
</style>
