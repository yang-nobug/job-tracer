<script setup lang="ts">
import type { UpcomingInterview } from '../types'

const props = defineProps<{ items: UpcomingInterview[] }>()

function countdown(scheduledAt: string): string {
  const target = new Date(scheduledAt.replace(' ', 'T')).getTime()
  const diff = target - Date.now()
  if (diff <= 0) return '进行中/已过'
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return `${hours} 小时后`
  return `${Math.floor(hours / 24)} 天后`
}

function urgencyType(scheduledAt: string): 'danger' | 'warning' | 'info' {
  const hours = (new Date(scheduledAt.replace(' ', 'T')).getTime() - Date.now()) / 3_600_000
  if (hours < 24) return 'danger'
  if (hours < 72) return 'warning'
  return 'info'
}
</script>

<template>
  <div v-if="props.items.length" class="countdown-bar">
    <div class="countdown-inner">
      <span class="cd-label">⏰ 面试</span>
      <div class="cd-list">
        <el-tag
          v-for="item in props.items"
          :key="item.id"
          :type="urgencyType(item.scheduled_at)"
          effect="dark"
          size="large"
          class="cd-tag"
        >
          {{ item.company }} · {{ item.round }} · {{ item.scheduled_at.slice(5, 16) }}（{{ countdown(item.scheduled_at) }}）
        </el-tag>
      </div>
    </div>
  </div>
</template>

<style scoped>
.countdown-bar { background: #fdf6ec; border-top: 1px solid #faecd8; }
.countdown-inner {
  max-width: 1200px; margin: 0 auto; padding: 8px 16px;
  display: flex; align-items: center; gap: 12px;
}
.cd-label { font-size: 14px; font-weight: 600; color: #e6a23c; white-space: nowrap; }
.cd-list {
  display: flex; gap: 8px; overflow-x: auto; scrollbar-width: thin; padding: 2px 0;
}
.cd-tag { white-space: nowrap; flex-shrink: 0; }
</style>
