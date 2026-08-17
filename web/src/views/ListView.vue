<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, openDetail, openEditForm, bumpData } from '../store'
import type { Application } from '../types'
import StatusTag from '../components/StatusTag.vue'
import FilterBar from '../components/FilterBar.vue'

const apps = ref<Application[]>([])
const filters = ref<{ status?: string; channel?: string; keyword?: string; rejected?: string }>({})

async function load(): Promise<void> {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(filters.value)) {
    if (v) params.set(k, v)
  }
  try {
    apps.value = await api.get<Application[]>(`/applications?${params.toString()}`)
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

watch(() => store.dataVersion, () => load(), { immediate: true })

function onFilterChange(f: { status?: string; channel?: string; keyword?: string }): void {
  filters.value = f
  load()
}

async function reject(app: Application): Promise<void> {
  try {
    await api.patch(`/applications/$glm-5.3_common/reject`, { reject_type: 'company' })
    ElMessage.success('已标记')
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function remove(app: Application): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${app.company} · ${app.position}」？`, '删除确认', { type: 'warning' })
    await api.delete(`/applications/$glm-5.3_common`)
    ElMessage.success('已删除')
    bumpData()
  } catch (err) {
    if ((err as { toString(): string }).toString().includes('cancel')) return
    ElMessage.error((err as Error).message)
  }
}
</script>

<template>
  <div>
    <FilterBar @change="onFilterChange" />

    <!-- 桌面表格 -->
    <el-table :data="apps" class="desktop-table" stripe>
      <el-table-column label="公司" prop="company" min-width="140" show-overflow-tooltip />
      <el-table-column label="职位" prop="position" min-width="150" show-overflow-tooltip />
      <el-table-column label="状态" width="120">
        <template #default="{ row }">
          <StatusTag :app="row" />
        </template>
      </el-table-column>
      <el-table-column label="渠道" prop="channel" width="90" />
      <el-table-column label="投递日期" width="110">
        <template #default="{ row }">{{ row.applied_at || '-' }}</template>
      </el-table-column>
      <el-table-column label="更新时间" width="110">
        <template #default="{ row }">{{ row.updated_at.slice(5, 10) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click="openDetail(row.id)">详情</el-button>
          <el-button link size="small" @click="openEditForm(row)">编辑</el-button>
          <el-button v-if="!row.rejected_at" link type="warning" size="small" @click="reject(row)">挂</el-button>
          <el-button link type="danger" size="small" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 移动端卡片 -->
    <div class="mobile-cards">
      <div v-for="app in apps" :key="app.id" class="m-card" @click="openDetail(app.id)">
        <div class="m-row">
          <span class="m-company">{{ app.company }}</span>
          <StatusTag :app="app" />
        </div>
        <div class="m-position">{{ app.position }}</div>
        <div class="m-meta">
          <span>{{ app.channel || '-' }}</span>
          <span>{{ app.applied_at || '未投递' }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mobile-cards { display: none; }
@media (max-width: 768px) {
  .desktop-table { display: none; }
  .mobile-cards { display: flex; flex-direction: column; gap: 10px; }
  .m-card {
    background: #fff; border-radius: 8px; padding: 12px 14px;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08); cursor: pointer;
  }
  .m-row { display: flex; justify-content: space-between; align-items: center; }
  .m-company { font-weight: 600; font-size: 15px; }
  .m-position { color: #606266; font-size: 13px; margin-top: 2px; }
  .m-meta {
    display: flex; justify-content: space-between; margin-top: 6px;
    font-size: 12px; color: #909399;
  }
}
</style>
