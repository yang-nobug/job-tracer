<script setup lang="ts">
import type { UpcomingItem } from '../types'

const props = defineProps<{ items: UpcomingItem[] }>()

function countdown(dueAt: string): string {
  const target = new Date(dueAt.replace(' ', 'T')).getTime()
  const diff = target - Date.now()
  if (diff <= 0) return '进行中/已过'
  const hours = Math.floor(diff / 3_600_000)
  if (hours < 24) return `${hours} 小时后`
  return `${Math.floor(hours / 24)} 天后`
}

function urgencyType(dueAt: string): 'danger' | 'warning' | 'info' {
  const hours = (new Date(dueAt.replace(' ', 'T')).getTime() - Date.now()) / 3_600_000
  if (hours < 24) return 'danger'
  if (hours < 72) return 'warning'
  return 'info'
}

function timeLabel(item: UpcomingItem): string {
  if (item.due_kind === 'deadline') return `截止 ${item.due_at.slice(5)}`
  if (item.due_kind === 'window_start') return `开放 ${item.due_at.slice(5)}`
  if (item.due_kind === 'window_end') return `关闭 ${item.due_at.slice(5)}`
  return item.due_at.slice(5)
}

function itemLabel(item: UpcomingItem): string {
  const company = item.company.trim()
  const title = item.title.trim()
  if (!company) return title || '未命名日程'
  const normalizedCompany = company.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  const normalizedTitle = title.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
  return normalizedCompany && normalizedTitle.includes(normalizedCompany)
    ? title
    : `${company} · ${title || '未命名日程'}`
}
</script>

<template>
  <div v-if="props.items.length" class="countdown-bar">
    <div class="countdown-inner">
      <span class="cd-label">⏰ 近期日程</span>
      <div class="cd-list">
        <el-tag
          v-for="item in props.items"
          :key="item.key"
          :type="urgencyType(item.due_at)"
          effect="dark"
          size="large"
          class="cd-tag"
        >
          {{ itemLabel(item) }} · {{ timeLabel(item) }}（{{ countdown(item.due_at) }}）
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
