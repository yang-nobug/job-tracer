<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import type { Interview } from '../types'
import ReviewEditor from '../components/ReviewEditor.vue'

interface ReviewRow extends Interview {
  application_id: number
  company: string
  position: string
}

const rows = ref<ReviewRow[]>([])
const loading = ref(true)
const editing = ref<ReviewRow | null>(null)

onMounted(async () => {
  try {
    // /reviews 返回的行结构含 application_id/company/position
    rows.value = (await api.get<ReviewRow[]>('/reviews')) as ReviewRow[]
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-loading="loading">
    <el-empty v-if="!rows.length && !loading" description="还没有面试复盘，去详情里添加面试吧" />
    <div v-else class="review-list">
      <el-card v-for="row in rows" :key="row.id" shadow="never" class="review-card" @click="editing = row">
        <div class="r-row">
          <span class="r-company">{{ row.company }}</span>
          <el-tag size="small">{{ row.round }}</el-tag>
          <el-tag v-if="row.done" type="success" size="small">已完成</el-tag>
          <span class="r-spacer" />
          <span class="r-time">{{ row.scheduled_at }}</span>
        </div>
        <div class="r-position">{{ row.position }}</div>
      </el-card>
    </div>

    <ReviewEditor
      v-if="editing"
      :interview="{ ...editing, checklist: [] }"
      @closed="editing = null"
    />
  </div>
</template>

<style scoped>
.review-list { display: flex; flex-direction: column; gap: 10px; max-width: 720px; }
.review-card { cursor: pointer; }
.review-card:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
.r-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.r-company { font-weight: 600; font-size: 15px; }
.r-spacer { flex: 1; }
.r-time { color: #909399; font-size: 13px; }
.r-position { color: #606266; font-size: 13px; margin-top: 4px; }
</style>
