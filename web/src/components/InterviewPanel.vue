<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { bumpData } from '../store'
import { ROUNDS, type Interview } from '../types'
import ReviewEditor from './ReviewEditor.vue'

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
        <el-button link size="small" @click="editingInterview = iv">📝 复盘</el-button>
        <el-button link size="small" @click="toggleDone(iv)">{{ iv.done ? '标记未完成' : '标记完成' }}</el-button>
        <el-button link type="danger" size="small" @click="removeInterview(iv)">删除</el-button>
      </div>
      <div v-if="iv.location" class="iv-loc">📍 {{ iv.location }}</div>

      <div class="checklist">
        <div class="cl-title">准备清单</div>
        <div v-for="item in iv.checklist" :key="item.id" class="cl-item">
          <el-checkbox :model-value="!!item.done" @change="toggleItem(item.id, !item.done)">
            <span :class="{ done: item.done }">{{ item.content }}</span>
          </el-checkbox>
          <el-button link type="danger" size="small" @click="removeItem(item.id)">删</el-button>
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
.cl-item { display: flex; align-items: center; justify-content: space-between; }
.cl-item .done { text-decoration: line-through; color: #c0c4cc; }
.cl-add { display: flex; gap: 6px; margin-top: 4px; }
</style>
