<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, openDetail, openEditForm, bumpData } from '../store'
import type { Application } from '../types'
import { avatarColor } from '../utils/avatar'
import StatusTag from '../components/StatusTag.vue'
import FilterBar from '../components/FilterBar.vue'

const apps = ref<Application[]>([])
const filters = ref<{ status?: string; channel?: string; keyword?: string; rejected?: string }>({})
const sortBy = ref<'updated' | 'applied'>('updated')

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

// 后端默认按更新时间倒序；「投递日期」排序在前端做（数据量小）
const sortedApps = computed(() => {
  if (sortBy.value === 'updated') return apps.value
  return [...apps.value].sort((x, y) => (y.applied_at ?? '').localeCompare(x.applied_at ?? ''))
})

function onFilterChange(f: { status?: string; channel?: string; keyword?: string; rejected?: string }): void {
  filters.value = f
  load()
}

function onRowClick(row: Application): void {
  openDetail(row.id)
}

function rowClass({ row }: { row: Application }): string {
  return row.rejected_at ? 'row-dead' : ''
}

async function toggleReject(app: Application): Promise<void> {
  try {
    await api.patch(`/applications/${app.id}/reject`, { reject_type: 'company' })
    ElMessage.success(app.rejected_at ? '已撤销挂掉' : '已标记挂掉')
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function remove(app: Application): Promise<void> {
  try {
    await ElMessageBox.confirm(`确定删除「${app.company} · ${app.position}」？`, '删除确认', { type: 'warning' })
    await api.delete(`/applications/${app.id}`)
    ElMessage.success('已删除')
    bumpData()
  } catch (err) {
    if ((err as { toString(): string }).toString().includes('cancel')) return
    ElMessage.error((err as Error).message)
  }
}

function onCommand(cmd: string, app: Application): void {
  if (cmd === 'detail') openDetail(app.id)
  else if (cmd === 'reject') toggleReject(app)
  else if (cmd === 'remove') remove(app)
}
</script>

<template>
  <div>
    <div class="list-head">
      <FilterBar @change="onFilterChange" />
      <div class="list-tools">
        <span class="count">共 {{ sortedApps.length }} 条</span>
        <el-select v-model="sortBy" size="small" style="width: 108px">
          <el-option label="最近更新" value="updated" />
          <el-option label="投递日期" value="applied" />
        </el-select>
      </div>
    </div>

    <!-- 投递列表 -->
    <el-table
      v-if="sortedApps.length"
      :data="sortedApps"
      class="applications-table"
      stripe
      :row-class-name="rowClass"
      @row-click="onRowClick"
    >
      <el-table-column label="公司" min-width="190">
        <template #default="{ row }">
          <div class="cell-company">
            <span class="company-avatar" :style="{ background: avatarColor(row.company) }">
              {{ row.company.slice(0, 1) }}
            </span>
            <span class="company-name">{{ row.company }}</span>
            <span v-if="row.rejected_at" class="company-rejected">
              {{ row.reject_type === 'me' ? '我拒' : '挂' }}
            </span>
            <a v-if="row.jd_link" class="company-link" :href="row.jd_link" target="_blank" @click.stop>🔗</a>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="职位" prop="position" min-width="150" show-overflow-tooltip />
      <el-table-column label="状态" width="86">
        <template #default="{ row }">
          <StatusTag :app="row" />
        </template>
      </el-table-column>
      <el-table-column label="下场面试" width="116">
        <template #default="{ row }">
          <span v-if="row.next_interview_at" class="next-iv">🎤 {{ row.next_interview_at.slice(5, 11) }}</span>
          <span v-else class="dim">-</span>
        </template>
      </el-table-column>
      <el-table-column label="渠道" width="76">
        <template #default="{ row }">{{ row.channel || '-' }}</template>
      </el-table-column>
      <el-table-column label="投递日期" width="96">
        <template #default="{ row }">{{ row.applied_at || '-' }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" size="small" @click.stop="openEditForm(row)">编辑</el-button>
          <span @click.stop>
            <el-dropdown trigger="click" @command="(cmd: string) => onCommand(cmd, row)">
              <el-button link size="small" class="more-btn">···</el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="detail">查看详情</el-dropdown-item>
                  <el-dropdown-item command="reject">
                    {{ row.rejected_at ? '撤销挂掉' : '标记挂掉' }}
                  </el-dropdown-item>
                  <el-dropdown-item command="remove" divided>删除</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </span>
        </template>
      </el-table-column>
    </el-table>
    <el-empty v-else description="没有符合条件的记录" class="applications-table" />

  </div>
</template>

<style scoped>
.list-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.list-tools { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.count { font-size: 13px; color: #909399; white-space: nowrap; }

.applications-table :deep(.el-table__row) { cursor: pointer; }
.applications-table :deep(.row-dead) { opacity: 0.55; }

.cell-company { display: flex; align-items: center; gap: 8px; min-width: 0; }
.company-avatar {
  width: 26px; height: 26px; border-radius: 6px; flex-shrink: 0;
  color: #fff; font-size: 14px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.company-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.company-rejected {
  flex-shrink: 0; font-size: 11px; line-height: 1;
  background: #f1f3f7; color: #909399; border-radius: 4px; padding: 3px 5px;
}
.company-link { flex-shrink: 0; text-decoration: none; font-size: 13px; }
.next-iv { color: #e6a23c; font-size: 13px; }
.dim { color: #c0c4cc; }
.more-btn { margin-left: 8px; font-weight: 700; letter-spacing: 1px; }

</style>
