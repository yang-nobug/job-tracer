<script setup lang="ts">
import { ref, watch } from 'vue'
import { STATUS_LABEL_LIST, DEFAULT_CHANNELS, type Status } from '../types'

const status = ref<Status | ''>('')
const channel = ref('')
const keyword = ref('')

const emit = defineEmits<{
  (e: 'change', filters: { status?: string; channel?: string; keyword?: string }): void
}>()

let debounceTimer: ReturnType<typeof setTimeout> | null = null
watch([status, channel, keyword], () => {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    emit('change', {
      status: status.value || undefined,
      channel: channel.value || undefined,
      keyword: keyword.value || undefined
    })
  }, 300)
})
</script>

<template>
  <div class="filter-bar">
    <el-select v-model="status" placeholder="状态" clearable style="width: 120px">
      <el-option v-for="s in STATUS_LABEL_LIST" :key="s.value" :label="s.label" :value="s.value" />
    </el-select>
    <el-select v-model="channel" placeholder="渠道" clearable filterable style="width: 120px">
      <el-option v-for="c in DEFAULT_CHANNELS" :key="c" :label="c" :value="c" />
    </el-select>
    <el-input v-model="keyword" placeholder="搜索公司 / 职位" clearable style="width: 200px" />
  </div>
</template>

<style scoped>
.filter-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
@media (max-width: 768px) {
  .filter-bar { gap: 6px; }
  .filter-bar .el-select, .filter-bar .el-input { width: calc(50% - 3px) !important; }
}
</style>
