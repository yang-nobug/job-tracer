<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from './api'
import { store, openCreateForm } from './store'
import type { UpcomingInterview } from './types'
import CountdownBar from './components/CountdownBar.vue'
import AppFormDrawer from './components/AppFormDrawer.vue'
import DetailDrawer from './components/DetailDrawer.vue'

const route = useRoute()
const upcoming = ref<UpcomingInterview[]>([])
let timer: ReturnType<typeof setInterval> | null = null

async function loadUpcoming(): Promise<void> {
  try {
    upcoming.value = await api.get<UpcomingInterview[]>('/upcoming')
  } catch {
    /* 静默失败，倒计时条非关键路径 */
  }
}

onMounted(() => {
  loadUpcoming()
  timer = setInterval(loadUpcoming, 60_000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})
</script>

<template>
  <div class="layout">
    <header class="header">
      <div class="header-inner">
        <div class="brand">📋 job-tracer</div>
        <nav class="nav-desktop">
          <router-link to="/" class="nav-link" :class="{ active: route.path === '/' }">看板</router-link>
          <router-link to="/list" class="nav-link" :class="{ active: route.path === '/list' }">列表</router-link>
          <router-link to="/stats" class="nav-link" :class="{ active: route.path === '/stats' }">统计</router-link>
          <router-link to="/reviews" class="nav-link" :class="{ active: route.path === '/reviews' }">复盘</router-link>
        </nav>
        <el-button type="primary" round @click="openCreateForm()">+ 记一笔</el-button>
      </div>
      <CountdownBar :items="upcoming" />
    </header>

    <main class="main">
      <router-view />
    </main>

    <!-- 移动端底部导航 -->
    <nav class="nav-mobile">
      <router-link to="/" class="nav-link">看板</router-link>
      <router-link to="/list" class="nav-link">列表</router-link>
      <router-link to="/stats" class="nav-link">统计</router-link>
      <router-link to="/reviews" class="nav-link">复盘</router-link>
    </nav>

    <AppFormDrawer v-model="store.formDrawerOpen" :editing="store.editingApp" />
    <DetailDrawer :app-id="store.detailId" @close="store.detailId = null" />
  </div>
</template>

<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Helvetica Neue', Helvetica, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  background: #f5f7fa;
  color: #303133;
}
.layout { min-height: 100vh; }

.header { background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08); position: sticky; top: 0; z-index: 100; }
.header-inner {
  max-width: 1200px; margin: 0 auto; padding: 0 16px;
  display: flex; align-items: center; gap: 20px; height: 56px;
}
.brand { font-weight: 700; font-size: 18px; white-space: nowrap; }
.nav-desktop { display: flex; gap: 4px; flex: 1; }
.nav-link {
  text-decoration: none; color: #606266; padding: 6px 14px; border-radius: 6px; font-size: 15px;
}
.nav-link.active { color: #409eff; background: #ecf5ff; font-weight: 600; }
.header-inner .el-button { margin-left: auto; }

.main { max-width: 1200px; margin: 0 auto; padding: 16px; padding-bottom: 72px; }

.nav-mobile { display: none; }

@media (max-width: 768px) {
  .nav-desktop, .brand { display: none; }
  .header-inner { justify-content: flex-end; }
  .nav-mobile {
    display: flex; position: fixed; bottom: 0; left: 0; right: 0; z-index: 100;
    background: #fff; box-shadow: 0 -1px 4px rgba(0, 0, 0, 0.08);
  }
  .nav-mobile .nav-link {
    flex: 1; text-align: center; padding: 10px 0; font-size: 14px; color: #909399;
  }
  .nav-mobile .nav-link.active { color: #409eff; font-weight: 600; }
}
</style>
