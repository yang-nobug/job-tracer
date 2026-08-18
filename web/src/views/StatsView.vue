<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { EChartsOption } from 'echarts'
import { api } from '../api'
import type { Stats } from '../types'
import ChartBox from '../components/ChartBox.vue'

const stats = ref<Stats | null>(null)
const loading = ref(true)

onMounted(async () => {
  try {
    stats.value = await api.get<Stats>('/stats')
  } finally {
    loading.value = false
  }
})

const funnelOption = computed<EChartsOption>(() => {
  const f = stats.value?.funnel ?? []
  const max = f[0]?.value || 1
  return {
    title: { text: '转化漏斗', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: {
      trigger: 'item',
      formatter: (p: { name: string; value: number }) => {
        const rate = max ? Math.round((p.value / max) * 100) : 0
        return `${p.name}: ${p.value}（${rate}%）`
      }
    },
    series: [
      {
        type: 'funnel',
        left: '12%',
        width: '76%',
        top: 40,
        bottom: 10,
        minSize: '12%',
        label: { formatter: '{b} {c}' },
        data: f
      }
    ]
  }
})

const stageOption = computed<EChartsOption>(() => {
  // 倒序渲染：心理测评在最上、HR面在最下，相邻两根条一比就是通过率
  const s = [...(stats.value?.stages ?? [])].reverse()
  return {
    title: { text: '各环节经历岗位数', left: 'center', textStyle: { fontSize: 14 } },
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 64, right: 36, top: 36, bottom: 24 },
    xAxis: { type: 'value', minInterval: 1 },
    yAxis: { type: 'category', data: s.map((x) => x.name) },
    series: [
      {
        type: 'bar',
        data: s.map((x) => x.value),
        barMaxWidth: 18,
        itemStyle: { color: '#38bdf8', borderRadius: [0, 4, 4, 0] },
        label: { show: true, position: 'right' }
      }
    ]
  }
})

const weeklyOption = computed<EChartsOption>(() => ({
  title: { text: '近 8 周投递量', left: 'center', textStyle: { fontSize: 14 } },
  tooltip: { trigger: 'axis' },
  grid: { left: 36, right: 16, top: 40, bottom: 24 },
  xAxis: { type: 'category', data: stats.value?.weekly.map((w) => w.week) ?? [] },
  yAxis: { type: 'value', minInterval: 1 },
  series: [{ type: 'bar', data: stats.value?.weekly.map((w) => w.count) ?? [], barMaxWidth: 36, itemStyle: { color: '#409eff', borderRadius: [4, 4, 0, 0] } }]
}))

const channelOption = computed<EChartsOption>(() => ({
  title: { text: '渠道分布', left: 'center', textStyle: { fontSize: 14 } },
  tooltip: { trigger: 'item' },
  series: [
    {
      type: 'pie',
      radius: ['36%', '62%'],
      top: 30,
      data: stats.value?.channels ?? [],
      label: { formatter: '{b} {c}' }
    }
  ]
}))

const cards = computed(() => [
  { label: '总记录', value: stats.value?.cards.total ?? 0, color: '#409eff' },
  { label: '进行中', value: stats.value?.cards.active ?? 0, color: '#e6a23c' },
  { label: '已挂', value: stats.value?.cards.rejected ?? 0, color: '#909399' },
  { label: 'Offer', value: stats.value?.cards.offer ?? 0, color: '#67c23a' }
])
</script>

<template>
  <div v-loading="loading">
    <div v-if="stats && stats.cards.total === 0" class="empty-wrap">
      <el-empty description="还没有数据，先去新增投递吧" />
    </div>
    <template v-else>
      <div class="cards">
        <div v-for="c in cards" :key="c.label" class="stat-card">
          <div class="stat-value" :style="{ color: c.color }">{{ c.value }}</div>
          <div class="stat-label">{{ c.label }}</div>
        </div>
      </div>
      <div class="charts">
        <el-card shadow="never" class="chart-card"><ChartBox :option="funnelOption" /></el-card>
        <el-card shadow="never" class="chart-card"><ChartBox :option="stageOption" /></el-card>
        <el-card shadow="never" class="chart-card"><ChartBox :option="weeklyOption" /></el-card>
        <el-card shadow="never" class="chart-card"><ChartBox :option="channelOption" /></el-card>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 14px; }
.stat-card {
  background: #fff; border-radius: 8px; padding: 16px; text-align: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.stat-value { font-size: 30px; font-weight: 700; }
.stat-label { font-size: 13px; color: #909399; margin-top: 4px; }
.charts { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (max-width: 768px) {
  .cards { grid-template-columns: repeat(2, 1fr); }
  .charts { grid-template-columns: 1fr; }
}
</style>
