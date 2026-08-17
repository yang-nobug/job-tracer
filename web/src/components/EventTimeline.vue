<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { AppEvent } from '../types'

const props = defineProps<{ appId: number | null }>()

const events = ref<AppEvent[]>([])
const newContent = ref('')
const adding = ref(false)

async function load(): Promise<void> {
  if (!props.appId) return
  try {
    const detail = await api.get<{ events: AppEvent[] }>(`/applications/${props.appId}`)
    events.value = detail.events
  } catch { /* 忽略 */ }
}

watch(() => props.appId, () => load(), { immediate: true })

const TYPE_ICONS: Record<string, string> = { note: '💬', status: '🔄', interview: '📅', other: '📌' }

async function addEvent(): Promise<void> {
  if (!newContent.value.trim() || !props.appId) return
  adding.value = true
  try {
    await api.post(`/applications/${props.appId}/events`, { content: newContent.value, type: 'note' })
    newContent.value = ''
    await load()
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    adding.value = false
  }
}

async function removeEvent(id: number): Promise<void> {
  try {
    await api.delete(`/events/${id}`)
    await load()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}
</script>

<template>
  <div class="timeline">
    <div class="add-event">
      <el-input
        v-model="newContent"
        placeholder="记一笔动态，如：HR 说下周安排一面"
        @keyup.enter="addEvent"
      />
      <el-button type="primary" :loading="adding" @click="addEvent">添加</el-button>
    </div>

    <el-empty v-if="!events.length" description="暂无动态" :image-size="60" />

    <div v-else class="event-list">
      <div v-for="e in events" :key="e.id" class="event-item">
        <span class="event-icon">{{ TYPE_ICONS[e.type] || '📌' }}</span>
        <div class="event-body">
          <div class="event-date">{{ e.event_date }}</div>
          <div class="event-content">{{ e.content }}</div>
        </div>
        <el-button link type="danger" size="small" @click="removeEvent(e.id)">删除</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-event { display: flex; gap: 8px; margin-bottom: 14px; }
.event-list { display: flex; flex-direction: column; gap: 4px; }
.event-item {
  display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px;
  border-radius: 6px; background: #f8f9fb;
}
.event-item:hover { background: #ecf5ff; }
.event-icon { font-size: 15px; }
.event-body { flex: 1; min-width: 0; }
.event-date { font-size: 12px; color: #909399; }
.event-content { font-size: 14px; white-space: pre-wrap; word-break: break-all; }
</style>
