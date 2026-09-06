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

const TYPE_LABELS: Record<string, string> = { note: '记录', status: '状态', interview: '面试', other: '其他' }

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
        placeholder="添加动态，如：HR 说下周安排一面"
        @keyup.enter="addEvent"
      />
      <el-button type="primary" :loading="adding" @click="addEvent">添加</el-button>
    </div>

    <el-empty v-if="!events.length" description="暂无动态" :image-size="60" />

    <div v-else class="event-list">
      <div v-for="e in events" :key="e.id" class="event-item">
        <span class="event-marker" />
        <div class="event-body">
          <div class="event-meta"><span>{{ TYPE_LABELS[e.type] || '记录' }}</span><time>{{ e.event_date }}</time></div>
          <div class="event-content">{{ e.content }}</div>
        </div>
        <el-button link type="danger" size="small" @click="removeEvent(e.id)">删除</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.add-event { display: flex; gap: 8px; margin-bottom: 16px; }
.event-list { display: flex; flex-direction: column; gap: 0; }
.event-item {
  position: relative; display: flex; align-items: flex-start; gap: 11px; padding: 11px 10px 11px 0;
  border-bottom: 1px solid var(--jt-line, #e7e9ee);
}
.event-item:last-child { border-bottom: 0; }
.event-item:hover { background: #fafcff; }
.event-marker { width: 8px; height: 8px; flex: 0 0 auto; margin: 5px 0 0 6px; border: 2px solid #fff; border-radius: 50%; background: var(--jt-primary, #2563eb); box-shadow: 0 0 0 1px #a9c8ff; }
.event-body { flex: 1; min-width: 0; }
.event-meta { display: flex; align-items: center; gap: 8px; color: var(--jt-muted, #6b7280); font-size: 12px; }
.event-meta span { color: var(--jt-primary, #2563eb); font-weight: 600; }
.event-content { margin-top: 4px; color: #374151; font-size: 13px; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }
</style>
