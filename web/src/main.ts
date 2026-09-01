import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import App from './App.vue'
import KanbanView from './views/KanbanView.vue'
import ListView from './views/ListView.vue'
import StatsView from './views/StatsView.vue'
import ReviewsView from './views/ReviewsView.vue'
import KnowledgeView from './views/KnowledgeView.vue'
import SourceDetailView from './views/SourceDetailView.vue'

// 双工作区（需求 3.10）：投递跟踪 /track/*，学习成长 /learn/*
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    // 根路径进入上次停留的工作区（默认投递跟踪）
    { path: '/', redirect: () => (localStorage.getItem('workspace') === 'learn' ? '/learn/reviews' : '/track/kanban') },
    // 投递跟踪
    { path: '/track/kanban', component: KanbanView },
    { path: '/track/list', component: ListView },
    { path: '/track/stats', component: StatsView },
    // 学习成长
    { path: '/learn/reviews', component: ReviewsView },
    { path: '/learn/knowledge', component: KnowledgeView },
    // 面经详情独立页（整页浏览，不再用抽屉）
    { path: '/learn/knowledge/:id', component: SourceDetailView },
    // 自动化暂时停用，旧链接回到看板
    { path: '/track/automation', redirect: '/track/kanban' },
    // 旧路由重定向（收藏链接不失效）
    { path: '/kanban', redirect: '/track/kanban' },
    { path: '/list', redirect: '/track/list' },
    { path: '/stats', redirect: '/track/stats' },
    { path: '/reviews', redirect: '/learn/reviews' }
  ]
})

createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount('#app')
