<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api } from './api'
import { store, openCreateForm, openKnowledgeIngest } from './store'
import type { UpcomingInterview } from './types'
import CountdownBar from './components/CountdownBar.vue'
import AppFormDrawer from './components/AppFormDrawer.vue'
import DetailDrawer from './components/DetailDrawer.vue'
import SourceIngestDialog from './components/SourceIngestDialog.vue'
import TutorDrawer from './components/TutorDrawer.vue'

const route = useRoute()
const router = useRouter()
const upcoming = ref<UpcomingInterview[]>([])
let timer: ReturnType<typeof setInterval> | null = null

// 双工作区（需求 3.10）：投递跟踪 / 学习成长
const workspace = computed<'track' | 'learn'>(() => (route.path.startsWith('/learn') ? 'learn' : 'track'))

function onWorkspaceChange(ws: string | number | boolean): void {
  const target = ws === 'learn' ? 'learn' : 'track'
  localStorage.setItem('workspace', target)
  router.push(target === 'learn' ? '/learn/reviews' : '/track/kanban')
}

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
        <div class="ws-switch">
          <div
            class="ws-pill"
            :class="{ active: workspace === 'track' }"
            role="tab"
            @click="onWorkspaceChange('track')"
          >
            投递
          </div>
          <div
            class="ws-pill"
            :class="{ active: workspace === 'learn' }"
            role="tab"
            @click="onWorkspaceChange('learn')"
          >
            学习
          </div>
        </div>
        <nav class="nav-desktop">
          <template v-if="workspace === 'track'">
            <router-link to="/track/kanban" class="nav-link" :class="{ active: route.path === '/track/kanban' }">看板</router-link>
            <router-link to="/track/list" class="nav-link" :class="{ active: route.path === '/track/list' }">列表</router-link>
            <router-link to="/track/stats" class="nav-link" :class="{ active: route.path === '/track/stats' }">统计</router-link>
          </template>
          <template v-else>
            <router-link to="/learn/reviews" class="nav-link" :class="{ active: route.path === '/learn/reviews' }">复盘</router-link>
            <router-link to="/learn/knowledge" class="nav-link" :class="{ active: route.path.startsWith('/learn/knowledge') }">学习</router-link>
          </template>
        </nav>
        <el-button v-if="workspace === 'track'" type="primary" round @click="openCreateForm()">+ 新增投递</el-button>
        <el-button v-else type="primary" round @click="openKnowledgeIngest">+ 录入面经</el-button>
      </div>
      <CountdownBar v-if="workspace === 'track'" :items="upcoming" />
    </header>

    <main class="main">
      <router-view />
    </main>

    <!-- 移动端底部导航：展示当前工作区的子页面 -->
    <nav class="nav-mobile">
      <template v-if="workspace === 'track'">
        <router-link to="/track/kanban" class="nav-link">看板</router-link>
        <router-link to="/track/list" class="nav-link">列表</router-link>
        <router-link to="/track/stats" class="nav-link">统计</router-link>
      </template>
      <template v-else>
        <router-link to="/learn/reviews" class="nav-link">复盘</router-link>
        <router-link to="/learn/knowledge" class="nav-link">学习</router-link>
      </template>
    </nav>

    <AppFormDrawer v-model="store.formDrawerOpen" :editing="store.editingApp" />
    <DetailDrawer :app-id="store.detailId" @close="store.detailId = null" />
    <SourceIngestDialog />
    <TutorDrawer v-if="workspace === 'learn'" />
  </div>
</template>

<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  background: #f4f6fa;
  color: #303133;
  -webkit-font-smoothing: antialiased;
}
.layout { min-height: 100vh; }

.header { background: #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08); position: sticky; top: 0; z-index: 100; padding-top: 12px; }
.header-inner {
  max-width: 1600px; margin: 0 auto; padding: 0 24px;
  display: flex; align-items: center; gap: 20px; height: 56px;
}
.brand { font-weight: 700; font-size: 18px; white-space: nowrap; }
/* 工作区切换器：胶囊底 + 选中白底浮起 */
.ws-switch {
  display: flex; gap: 4px; padding: 4px; flex-shrink: 0;
  background: #e9edf3; border-radius: 999px;
}
.ws-pill {
  padding: 7px 26px; border-radius: 999px;
  font-size: 15px; font-weight: 600; color: #909399;
  cursor: pointer; user-select: none; white-space: nowrap;
  transition: color 0.2s, background 0.2s, box-shadow 0.2s;
}
.ws-pill:hover { color: #606266; }
.ws-pill.active {
  background: #fff; color: #1f2d3d;
  box-shadow: 0 2px 8px rgba(31, 45, 61, 0.16);
}
.nav-desktop { display: flex; gap: 4px; flex: 1; }
.nav-link {
  text-decoration: none; color: #606266; padding: 6px 14px; border-radius: 6px; font-size: 15px;
}
.nav-link.active { color: #409eff; background: #ecf5ff; font-weight: 600; }
.header-inner .el-button { margin-left: auto; }

.main { max-width: 1600px; margin: 0 auto; padding: 16px 24px; padding-bottom: 72px; }

.nav-mobile { display: none; }

@media (max-width: 768px) {
  .nav-desktop, .brand { display: none; }
  .header-inner { justify-content: center; gap: 12px; }
  .header-inner .el-button { margin-left: 0; }
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
