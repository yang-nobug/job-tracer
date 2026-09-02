<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { bumpData } from '../store'
import { ROUNDS, type Interview, type PrepExecutionTask } from '../types'
import ReviewEditor from './ReviewEditor.vue'
import InterviewPrepAgentDialog from './InterviewPrepAgentDialog.vue'
import PrepTaskWorkspaceDialog from './PrepTaskWorkspaceDialog.vue'

const props = defineProps<{ appId: number; interviews: Interview[] }>()

const showForm = ref(false)
const form = reactive({ round: '一面', scheduled_at: '', location: '' })
const adding = ref(false)

async function addInterview(): Promise<void> {
  if (!form.scheduled_at) {
    ElMessage.warning('请选择面试时间')
    return
  }
  adding.value = true
  try {
    await api.post(`/applications/${props.appId}/interviews`, { ...form })
    ElMessage.success('已添加，复盘文档已自动生成')
    showForm.value = false
    form.round = '一面'
    form.scheduled_at = ''
    form.location = ''
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    adding.value = false
  }
}

async function toggleDone(iv: Interview): Promise<void> {
  try {
    await api.patch(`/interviews/${iv.id}`, { done: !iv.done })
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function removeInterview(iv: Interview): Promise<void> {
  try {
    await ElMessageBox.confirm(`删除「${iv.round} ${iv.scheduled_at}」的面试？其准备清单会一并删除（复盘 md 文件保留在磁盘）`, '删除确认', {
      type: 'warning'
    })
    await api.delete(`/interviews/${iv.id}`)
    bumpData()
  } catch (err) {
    if ((err as { toString(): string }).toString().includes('cancel')) return
    ElMessage.error((err as Error).message)
  }
}

// 准备清单
const newItem = reactive<Record<number, string>>({})

async function addChecklistItem(iv: Interview): Promise<void> {
  const content = (newItem[iv.id] || '').trim()
  if (!content) return
  try {
    await api.post(`/interviews/${iv.id}/checklist`, { content })
    newItem[iv.id] = ''
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function toggleItem(itemId: number, done: boolean): Promise<void> {
  try {
    await api.patch(`/checklist/${itemId}`, { done })
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function removeItem(itemId: number): Promise<void> {
  try {
    await api.delete(`/checklist/${itemId}`)
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

// 复盘编辑
const editingInterview = ref<Interview | null>(null)
const prepInterview = ref<Interview | null>(null)
const prepTask = ref<PrepExecutionTask | null>(null)
const prepTaskByChecklist = reactive<Record<number, PrepExecutionTask>>({})
const expandedTaskDetails = reactive<Record<number, boolean>>({})
let taskLoadSequence = 0

const taskCategoryLabel: Record<PrepExecutionTask['category'], string> = {
  knowledge: '知识复习',
  project: '项目表达',
  coding: '编码练习',
  communication: '沟通表达',
  mock: '模拟面试'
}

const taskPriorityLabel: Record<PrepExecutionTask['priority'], string> = {
  high: '高优先级',
  medium: '中优先级',
  low: '低优先级'
}

function priorityTagType(priority: PrepExecutionTask['priority']): 'danger' | 'warning' | 'info' {
  return priority === 'high' ? 'danger' : priority === 'medium' ? 'warning' : 'info'
}

function taskStatus(task: PrepExecutionTask): string {
  if (task.generation.status === 'running') return `课程生成中 ${task.generation.progress}%`
  if (task.generation.status === 'failed') return '课程生成失败，可重试'
  if (task.guide_ready) return `课程 v${task.guide_version} 已生成`
  return '尚未生成课程'
}

function taskActionLabel(task: PrepExecutionTask): string {
  if (task.generation.status === 'running') return '查看进度'
  return task.guide_ready ? '继续准备' : '开始准备'
}

function toggleTaskDetails(checklistId: number): void {
  expandedTaskDetails[checklistId] = expandedTaskDetails[checklistId] === false
}

async function loadPrepTasks(): Promise<void> {
  const sequence = ++taskLoadSequence
  try {
    const groups = await Promise.all(props.interviews.map(interview =>
      api.get<PrepExecutionTask[]>(`/prep-agent/interviews/${interview.id}/tasks`)
    ))
    if (sequence !== taskLoadSequence) return
    for (const key of Object.keys(prepTaskByChecklist)) delete prepTaskByChecklist[Number(key)]
    for (const task of groups.flat()) prepTaskByChecklist[task.checklist_id] = task
  } catch {
    /* AI 执行入口加载失败不影响普通清单 */
  }
}

function taskUpdated(task: PrepExecutionTask): void {
  prepTaskByChecklist[task.checklist_id] = task
  if (prepTask.value?.id === task.id) prepTask.value = task
  bumpData()
}

watch(
  () => props.interviews.map(iv => `${iv.id}:${(iv.checklist ?? []).map(item => `${item.id}-${item.done}`).join(',')}`).join('|'),
  () => { void loadPrepTasks() },
  { immediate: true }
)
</script>

<template>
  <div class="interview-panel">
    <el-button size="small" type="primary" plain @click="showForm = !showForm">+ 添加面试</el-button>

    <div v-if="showForm" class="iv-form">
      <el-select v-model="form.round" style="width: 100px">
        <el-option v-for="r in ROUNDS" :key="r" :label="r" :value="r" />
      </el-select>
      <el-date-picker
        v-model="form.scheduled_at"
        type="datetime"
        placeholder="面试时间"
        value-format="YYYY-MM-DD HH:mm"
        style="width: 200px"
      />
      <el-input v-model="form.location" placeholder="地点 / 会议链接（可选）" style="flex: 1" />
      <el-button type="primary" size="small" :loading="adding" @click="addInterview">保存</el-button>
    </div>

    <el-empty v-if="!props.interviews.length" description="暂无面试" :image-size="50" />

    <el-card v-for="iv in props.interviews" :key="iv.id" class="iv-card" shadow="never">
      <div class="iv-head">
        <span class="iv-round">{{ iv.round }}</span>
        <span class="iv-time">{{ iv.scheduled_at }}</span>
        <el-tag v-if="iv.done" type="success" size="small">已完成</el-tag>
        <span class="iv-spacer" />
        <el-button link type="primary" size="small" @click="prepInterview = iv">✨ AI 准备</el-button>
        <el-button link size="small" @click="editingInterview = iv">📝 复盘</el-button>
        <el-button link size="small" @click="toggleDone(iv)">{{ iv.done ? '标记未完成' : '标记完成' }}</el-button>
        <el-button link type="danger" size="small" @click="removeInterview(iv)">删除</el-button>
      </div>
      <div v-if="iv.location" class="iv-loc">📍 {{ iv.location }}</div>

      <div class="checklist">
        <div class="cl-title">准备清单</div>
        <div
          v-for="item in iv.checklist"
          :key="item.id"
          class="cl-item"
          :class="{ 'ai-task-card': prepTaskByChecklist[item.id], 'is-done': item.done }"
        >
          <template v-if="prepTaskByChecklist[item.id]">
            <div class="ai-task-main">
              <el-checkbox
                class="ai-task-check"
                :model-value="!!item.done"
                :aria-label="`标记${prepTaskByChecklist[item.id].title}完成`"
                @change="toggleItem(item.id, !item.done)"
              />
              <button
                type="button"
                class="ai-task-summary"
                :aria-expanded="expandedTaskDetails[item.id] !== false"
                @click="toggleTaskDetails(item.id)"
              >
                <span class="ai-task-title-row">
                  <el-tag size="small" :type="priorityTagType(prepTaskByChecklist[item.id].priority)">
                    {{ taskPriorityLabel[prepTaskByChecklist[item.id].priority] }}
                  </el-tag>
                  <el-tag size="small" effect="plain">
                    {{ taskCategoryLabel[prepTaskByChecklist[item.id].category] }}
                  </el-tag>
                  <strong :class="{ done: item.done }">{{ prepTaskByChecklist[item.id].title }}</strong>
                </span>
                <span class="ai-task-subline">
                  建议 {{ prepTaskByChecklist[item.id].estimated_minutes }} 分钟
                  <span>·</span>
                  {{ taskStatus(prepTaskByChecklist[item.id]) }}
                  <template v-if="prepTaskByChecklist[item.id].message_count">
                    <span>·</span>{{ prepTaskByChecklist[item.id].message_count }} 条陪练对话
                  </template>
                </span>
              </button>
              <div class="cl-actions">
                <el-button link type="primary" size="small" @click="prepTask = prepTaskByChecklist[item.id]">
                  {{ taskActionLabel(prepTaskByChecklist[item.id]) }}
                </el-button>
                <el-button link size="small" @click="toggleTaskDetails(item.id)">
                  {{ expandedTaskDetails[item.id] === false ? '详情' : '收起' }}
                </el-button>
                <el-button link type="danger" size="small" @click="removeItem(item.id)">删</el-button>
              </div>
            </div>

            <div v-if="expandedTaskDetails[item.id] !== false" class="ai-task-details">
              <div class="ai-task-detail">
                <span class="detail-label">安排理由</span>
                <p>{{ prepTaskByChecklist[item.id].reason }}</p>
              </div>
              <div class="ai-task-detail success-criteria">
                <span class="detail-label">完成标准</span>
                <p>{{ prepTaskByChecklist[item.id].success_criteria }}</p>
              </div>
              <div class="ai-task-foot">
                <div v-if="prepTaskByChecklist[item.id].evidence_refs.length" class="ai-task-refs">
                  <span>计划依据</span>
                  <el-tag
                    v-for="refName in prepTaskByChecklist[item.id].evidence_refs"
                    :key="refName"
                    size="small"
                    type="info"
                    effect="plain"
                  >{{ refName }}</el-tag>
                </div>
                <div
                  v-if="prepTaskByChecklist[item.id].progress.steps.length || prepTaskByChecklist[item.id].progress.checks.length"
                  class="ai-task-progress"
                >
                  已学 {{ prepTaskByChecklist[item.id].progress.steps.length }} 个模块
                  · 已完成 {{ prepTaskByChecklist[item.id].progress.checks.length }} 项课程自检
                </div>
              </div>
            </div>
          </template>

          <template v-else>
            <el-checkbox :model-value="!!item.done" @change="toggleItem(item.id, !item.done)">
              <span :class="{ done: item.done }">{{ item.content }}</span>
            </el-checkbox>
            <div class="cl-actions">
              <el-button link type="danger" size="small" @click="removeItem(item.id)">删</el-button>
            </div>
          </template>
        </div>
        <div class="cl-add">
          <el-input
            v-model="newItem[iv.id]"
            size="small"
            placeholder="添加准备项，如：复习 MySQL 索引"
            @keyup.enter="addChecklistItem(iv)"
          />
          <el-button size="small" @click="addChecklistItem(iv)">添加</el-button>
        </div>
      </div>
    </el-card>

    <ReviewEditor
      v-if="editingInterview"
      :interview="editingInterview"
      @closed="editingInterview = null"
    />
    <InterviewPrepAgentDialog
      :model-value="prepInterview !== null"
      :application-id="props.appId"
      :interview="prepInterview"
      @update:model-value="value => { if (!value) prepInterview = null }"
      @completed="bumpData"
    />
    <PrepTaskWorkspaceDialog
      :model-value="prepTask !== null"
      :task="prepTask"
      @update:model-value="value => { if (!value) prepTask = null }"
      @updated="taskUpdated"
    />
  </div>
</template>

<style scoped>
.iv-form { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.iv-card { margin-top: 10px; }
.iv-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.iv-round { font-weight: 600; }
.iv-time { color: #909399; font-size: 13px; }
.iv-spacer { flex: 1; }
.iv-loc { font-size: 13px; color: #606266; margin-top: 4px; }
.checklist { margin-top: 10px; border-top: 1px dashed #ebeef5; padding-top: 8px; }
.cl-title { font-size: 13px; color: #909399; margin-bottom: 4px; }
.cl-item { display: flex; align-items: center; justify-content: space-between; min-height: 32px; }
.cl-item > :deep(.el-checkbox) { min-width: 0; flex: 1; }
.cl-actions { display: flex; align-items: center; flex-shrink: 0; }
.cl-item .done { text-decoration: line-through; color: #c0c4cc; }
.cl-add { display: flex; gap: 6px; margin-top: 4px; }
.ai-task-card {
  display: block;
  margin: 9px 0;
  padding: 12px 14px;
  background: linear-gradient(135deg, #fbfdff 0%, #f6f9fd 100%);
  border: 1px solid #d9e7f7;
  border-radius: 10px;
}
.ai-task-card.is-done { background: #fafafa; border-color: #e4e7ed; }
.ai-task-main { display: flex; align-items: flex-start; gap: 10px; }
.ai-task-check { flex: 0 0 auto; margin-top: 3px; }
.ai-task-summary {
  flex: 1; min-width: 0; padding: 0; border: 0; color: inherit; background: transparent;
  font: inherit; text-align: left; cursor: pointer;
}
.ai-task-title-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; line-height: 1.5; }
.ai-task-title-row strong { color: #263445; font-size: 14px; }
.ai-task-subline { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 5px; color: #8492a6; font-size: 12px; }
.ai-task-details { margin: 11px 0 0 28px; padding-top: 11px; border-top: 1px dashed #d8e2ee; }
.ai-task-detail { display: grid; grid-template-columns: 76px minmax(0, 1fr); gap: 8px; margin-bottom: 8px; }
.ai-task-detail p { margin: 0; color: #52606f; font-size: 13px; line-height: 1.65; white-space: pre-wrap; overflow-wrap: anywhere; }
.detail-label { color: #8492a6; font-size: 12px; font-weight: 600; line-height: 1.8; }
.success-criteria { padding: 8px 10px; background: #f0f9eb; border-radius: 7px; }
.success-criteria .detail-label { color: #529b2e; }
.ai-task-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 10px; }
.ai-task-refs { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; color: #909399; font-size: 12px; }
.ai-task-progress { color: #67c23a; font-size: 12px; }
@media (max-width: 760px) {
  .ai-task-main { flex-wrap: wrap; }
  .ai-task-summary { flex-basis: calc(100% - 30px); }
  .ai-task-main .cl-actions { width: 100%; justify-content: flex-end; }
  .ai-task-details { margin-left: 0; }
  .ai-task-detail { grid-template-columns: 1fr; gap: 2px; }
}
</style>
