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

const activeProject = computed(() => projects.value.find(item => item.id === activeId.value) ?? null)
function formatBytes(value?: number | null): string {
  if (!value) return '0 B'
  return value < 1024 * 1024 ? `${Math.ceil(value / 1024)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`
}
async function loadProjects(): Promise<void> {
  loading.value = true
  try {
    projects.value = await api.get<ProjectArchiveSummary[]>('/projects')
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
  <el-dialog v-model="open" title="项目档案与只读代码证据" width="1000px" top="6vh" destroy-on-close>
    <el-alert type="info" :closable="false" show-icon>
      <template #title>代码仓库保持只读：不会写入缓存、配置或 Git 文件；索引、摘要和后续确认的项目事实只存入 job-tracer。</template>
    </el-alert>
    <el-form class="project-create" label-position="top">
      <div class="form-grid">
        <el-form-item label="本机项目根目录（只读）"><el-input v-model="sourcePath" placeholder="例如 F:\\my-project" /></el-form-item>
        <el-form-item label="项目名称（可选）"><el-input v-model="name" placeholder="默认使用目录名" /></el-form-item>
      </div>
      <el-form-item label="你的项目说明（可选，建议用自己的话描述职责）"><el-input v-model="description" type="textarea" :rows="2" maxlength="2000" show-word-limit /></el-form-item>
      <el-button type="primary" :loading="creating" @click="create">接入项目档案</el-button>
    </el-form>

    <el-divider />
    <div class="archive-layout" v-loading="loading">
      <aside class="project-list">
        <div class="section-title">已接入项目</div>
        <el-empty v-if="!projects.length" description="尚未接入项目" :image-size="70" />
        <button v-for="project in projects" :key="project.id" class="project-row" :class="{ active: project.id === activeId }" @click="selectProject(project.id)">
          <strong>{{ project.name }}</strong><span>{{ project.files_indexed ?? 0 }} 个文件 · {{ project.symbol_count ?? 0 }} 个符号</span>
        </button>
      </aside>
      <section class="project-detail" v-loading="detailLoading">
        <el-empty v-if="!activeProject" description="选择一个项目查看索引" />
        <template v-else>
          <div class="detail-head"><div><h3>{{ activeProject.name }}</h3><p>{{ activeProject.root_realpath }}</p></div><div><el-button @click="codeReadingOpen = true">代码理解 Agent</el-button><el-button type="primary" @click="scan">建立只读索引</el-button><el-button type="danger" text @click="remove">删除档案</el-button></div></div>
          <el-alert v-if="activeProject.truncated" type="warning" :closable="false" show-icon title="本次扫描达到安全上限，索引是部分结果；可在后续版本按目录细化扫描范围。" />
          <div class="metrics"><span>已索引 {{ activeProject.files_indexed ?? 0 }} / {{ activeProject.files_seen ?? 0 }} 个文件</span><span>读取 {{ formatBytes(activeProject.bytes_read) }}</span><span>{{ activeProject.scanned_at ? `上次扫描：${new Date(activeProject.scanned_at).toLocaleString()}` : '尚未扫描' }}</span></div>
          <el-collapse class="facts" accordion>
            <el-collapse-item name="facts"><template #title>项目事实（会作为受控上下文提供给面试 Agent）</template>
              <p class="fact-tip">只填写你愿意用于面试准备的、自己确认无误的信息；模型不会读取整仓源码。</p>
              <div v-for="fact in facts" :key="fact.id" class="fact"><el-tag size="small">{{ fact.fact_type }}</el-tag><strong>{{ fact.title }}</strong><p>{{ fact.content }}</p></div>
              <div class="fact-form"><el-select v-model="factType"><el-option label="个人职责" value="responsibility" /><el-option label="架构" value="architecture" /><el-option label="技术选型" value="technology" /><el-option label="关键决策" value="decision" /><el-option label="指标成果" value="metric" /><el-option label="风险与取舍" value="risk" /></el-select><el-input v-model="factTitle" placeholder="例如：负责 RAG 检索链路" /><el-input v-model="factContent" type="textarea" :rows="2" placeholder="说明你的具体工作、依据和结果" /><el-button type="primary" :loading="factSaving" @click="createFact">保存确认事实</el-button></div>
            </el-collapse-item>
          </el-collapse>
          <el-input v-model="searchText" placeholder="检索函数名、技术词或代码文本" clearable @keyup.enter="search"><template #append><el-button @click="search">检索证据</el-button></template></el-input>
          <div v-if="results.length" class="results"><article v-for="item in results" :key="item.id"><div><code>{{ item.relative_path }}:{{ item.start_line }}-{{ item.end_line }}</code><el-tag v-if="item.symbol_name" size="small">{{ item.symbol_kind }} {{ item.symbol_name }}</el-tag></div><pre>{{ item.content }}</pre></article></div>
          <div v-else class="file-list"><div class="section-title">已索引文件（最多展示 300 个）</div><div v-for="file in files" :key="file.id"><code>{{ file.relative_path }}</code><span>{{ file.language }} · {{ file.line_count }} 行</span></div></div>
        </template>
      </section>
    </div>
    <CodeReadingDialog v-model="codeReadingOpen" :project="activeProject" />
  </el-dialog>
</template>

<style scoped>
.project-create { margin-top: 18px; }.form-grid { display: grid; grid-template-columns: 2fr 1fr; gap: 14px; }.project-create :deep(.el-form-item) { margin-bottom: 12px; }
.archive-layout { display:grid; grid-template-columns:250px minmax(0,1fr); min-height:440px; }.project-list { border-right:1px solid #ebeef5; padding-right:14px; overflow:auto; }.project-detail { padding-left:20px; min-width:0; }.section-title { font-size:13px; color:#909399; margin-bottom:9px; }.project-row { display:flex; width:100%; border:0; border-radius:7px; padding:10px; background:transparent; text-align:left; flex-direction:column; gap:4px; cursor:pointer; }.project-row:hover,.project-row.active { background:#ecf5ff; }.project-row span,.detail-head p,.metrics { color:#909399; font-size:12px; margin:0; }.detail-head { display:flex; justify-content:space-between; gap:16px; align-items:flex-start; }.detail-head h3 { margin:0 0 5px; }.metrics { display:flex; flex-wrap:wrap; gap:12px; margin:12px 0; }.facts { margin:12px 0; }.fact-tip { color:#909399; font-size:12px; margin-top:0; }.fact { padding:7px 0; border-bottom:1px solid #f2f6fc; display:grid; grid-template-columns:auto 1fr; gap:6px 8px; align-items:center; font-size:13px; }.fact p { grid-column:2; margin:0; white-space:pre-wrap; color:#606266; }.fact-form { display:grid; grid-template-columns:140px 1fr auto; gap:8px; margin-top:10px; }.fact-form :deep(textarea) { grid-column:1 / 3; }.file-list { margin-top:16px; max-height:260px; overflow:auto; }.file-list>div:not(.section-title) { display:flex; justify-content:space-between; gap:16px; padding:6px 2px; border-bottom:1px solid #f2f6fc; font-size:12px; }.file-list span { color:#909399; white-space:nowrap; }.results { margin-top:14px; max-height:390px; overflow:auto; }.results article { border:1px solid #ebeef5; border-radius:6px; padding:10px; margin-bottom:10px; }.results article>div { display:flex; justify-content:space-between; align-items:center; gap:8px; }.results pre { white-space:pre-wrap; overflow-wrap:anywhere; max-height:220px; overflow:auto; margin:8px 0 0; padding:9px; background:#f7f9fc; font-size:12px; line-height:1.55; }
</style>
