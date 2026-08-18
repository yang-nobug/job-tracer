<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { STATUS_LABEL_LIST, DEFAULT_CHANNELS, type Status } from '../types'
import { api } from '../api'

// 范围：进行中（默认，不含已挂）/ 全部 / 已挂
type Scope = 'active' | 'all' | 'rejected'
const scope = ref<Scope>('active')
const status = ref<Status | ''>('')
const channel = ref('')
const keyword = ref('')

// 渠道选项：默认渠道 + 数据里实际用过的渠道
const channelOptions = ref<string[]>([...DEFAULT_CHANNELS])
onMounted(async () => {
  try {
    const meta = await api.get<{ companies: { channel: string | null }[] }>('/meta')
    const set = new Set<string>(DEFAULT_CHANNELS)
    for (const c of meta.companies) if (c.channel) set.add(c.channel)
    channelOptions.value = [...set]
  } catch { /* 忽略，保留默认渠道 */ }
})

const emit = defineEmits<{
  (e: 'change', filters: { status?: string; channel?: string; keyword?: string; rejected?: string }): void
}>()

let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch([scope, status, channel, keyword], () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('change', {
      status: status.value || undefined,
      channel: channel.value || undefined,
      keyword: keyword.value || undefined,
      rejected: scope.value === 'all' ? undefined : String(scope.value === 'rejected')
    })
  }, 300)
})
</script>

<template>
  <div class="filter-bar">
    <el-radio-group v-model="scope" size="small">
      <el-radio-button value="active">进行中</el-radio-button>
      <el-radio-button value="all">全部</el-radio-button>
      <el-radio-button value="rejected">已挂</el-radio-button>
    </el-radio-group>
    <el-select v-model="status" placeholder="状态" clearable style="width: 104px">
      <el-option v-for="s in STATUS_LABEL_LIST" :key="s.value" :label="s.label" :value="s.value" />
    </el-select>
    <el-select v-model="channel" placeholder="渠道" clearable filterable style="width: 110px">
      <el-option v-for="c in channelOptions" :key="c" :label="c" :value="c" />
    </el-select>
    <el-input v-model="keyword" placeholder="搜索公司 / 职位" clearable style="width: 200px" />
  </div>
</template>

<style scoped>
.filter-bar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
@media (max-width: 768px) {
  .filter-bar { gap: 6px; }
  .filter-bar .el-radio-group { width: 100%; }
  .filter-bar .el-radio-group :deep(.el-radio-button) { flex: 1; }
  .filter-bar .el-select, .filter-bar .el-input { width: calc(50% - 3px) !important; }
}
</style>
