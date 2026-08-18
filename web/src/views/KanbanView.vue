<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import draggable from 'vuedraggable'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { store, openDetail } from '../store'
import { STATUS_ORDER, STATUS_LABELS, type Application, type Status } from '../types'

const apps = ref<Application[]>([])

async function load(): Promise<void> {
  try {
    apps.value = await api.get<Application[]>('/applications')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

watch(() => store.dataVersion, () => load(), { immediate: true })

const activeApps = computed(() => apps.value.filter((a) => !a.rejected_at))
const rejectedApps = computed(() => apps.value.filter((a) => a.rejected_at))

const columns = computed(() => {
  const cols: { key: Status | 'rejected'; label: string; list: Application[] }[] = STATUS_ORDER.map((s) => ({
    key: s,
    label: STATUS_LABELS[s],
    list: activeApps.value
      .filter((a) => a.status === s)
      .sort((x, y) => (y.applied_at ?? '').localeCompare(x.applied_at ?? ''))
  }))
  cols.push({
    key: 'rejected',
    label: '已挂',
    list: [...rejectedApps.value].sort((x, y) => (y.rejected_at ?? '').localeCompare(x.rejected_at ?? ''))
  })
  return cols
})

function getListRef(key: string): Application[] {
  return columns.value.find((c) => c.key === key)?.list ?? []
}

// 拖拽落地：调用 PUT 更新状态（已挂列只做排序展示，不支持拖入拖出改状态）
async function onChange(key: Status | 'rejected'): Promise<void> {
  if (key === 'rejected') return
  const list = getListRef(key)
  for (const app of list) {
    if (app.status !== key) {
      // 乐观更新已由 draggable 完成，这里发请求
      try {
        await api.put(`/applications/${app.id}`, { ...app, status: key })
        store.dataVersion++
      } catch (err) {
        ElMessage.error((err as Error).message)
        load()
      }
      break
    }
  }
}

function dragDisabled(): boolean {
  return window.innerWidth <= 768
}
</script>

<template>
  <div class="kanban">
    <div v-for="col in columns" :key="col.key" class="kanban-col">
      <div class="col-head">
        <span :class="{ 'col-title-rejected': col.key === 'rejected', 'col-title-offer': col.key === 'offer' }">
          {{ col.label }}
        </span>
        <span class="col-count">{{ col.list.length }}</span>
      </div>
      <draggable
        :list="col.list"
        :group="col.key === 'rejected' ? 'rejected' : 'apps'"
        item-key="id"
        :disabled="dragDisabled()"
        class="col-body"
        ghost-class="card-ghost"
        @change="onChange(col.key)"
      >
        <template #item="{ element }">
          <div class="card" @click="openDetail(element.id)">
            <div class="card-company">{{ element.company }}</div>
            <div class="card-position">{{ element.position }}</div>
            <div class="card-meta">
              <span v-if="element.rejected_at" class="card-rejected">
                {{ element.reject_type === 'me' ? '我拒' : '挂' }}
              </span>
              <span>{{ element.applied_at?.slice(5) || '未投' }}</span>
            </div>
          </div>
        </template>
      </draggable>
    </div>
  </div>
</template>

<style scoped>
.kanban {
  display: flex; gap: 10px; overflow-x: auto; align-items: flex-start;
  padding-bottom: 12px; min-height: calc(100vh - 140px);
}
.kanban-col {
  background: #eef1f6; border-radius: 8px; width: 230px; flex-shrink: 0;
  display: flex; flex-direction: column; max-height: calc(100vh - 150px);
}
.col-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 12px; font-weight: 600; font-size: 14px;
}
.col-count {
  background: #c9cdd4; color: #fff; border-radius: 10px; padding: 0 8px; font-size: 12px;
}
.col-title-offer { color: #67c23a; }
.col-title-rejected { color: #909399; }
.col-body { flex: 1; overflow-y: auto; padding: 0 8px 8px; min-height: 60px; }
.card {
  background: #fff; border-radius: 6px; padding: 10px; margin-bottom: 8px;
  cursor: pointer; box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06);
}
.card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12); }
.card-ghost { opacity: 0.4; }
.card-company { font-weight: 600; font-size: 14px; }
.card-position { font-size: 13px; color: #606266; margin-top: 2px; }
.card-meta {
  display: flex; justify-content: space-between; margin-top: 6px;
  font-size: 12px; color: #909399;
}
.card-rejected {
  background: #f4f4f5; color: #909399; border-radius: 4px; padding: 0 5px;
}
@media (max-width: 768px) {
  .kanban-col { width: 180px; }
}
</style>
