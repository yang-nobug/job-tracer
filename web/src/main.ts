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

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', component: KanbanView },
    { path: '/list', component: ListView },
    { path: '/stats', component: StatsView },
    { path: '/reviews', component: ReviewsView }
  ]
})

createApp(App).use(router).use(ElementPlus, { locale: zhCn }).mount('#app')
