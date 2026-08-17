<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { EChartsOption } from 'echarts'

const props = defineProps<{ option: EChartsOption; height?: string }>()
const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let resizeHandler: (() => void) | null = null

function render(): void {
  if (!el.value) return
  if (!chart) {
    chart = echarts.init(el.value)
    resizeHandler = () => chart?.resize()
    window.addEventListener('resize', resizeHandler)
  }
  chart.setOption(props.option)
}

watch(() => props.option, () => render(), { deep: true })
onMounted(() => render())
onUnmounted(() => {
  window.removeEventListener('resize', resizeHandler ?? (() => {}))
  chart?.dispose()
})
</script>

<template>
  <div ref="el" class="chart" :style="{ height: height || '300px' }" />
</template>

<style scoped>
.chart { width: 100%; }
</style>
