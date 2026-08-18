import { reactive } from 'vue'
import type { Application } from './types'

// 轻量全局状态：跨组件共享的 UI 状态与数据版本号
export const store = reactive({
  formDrawerOpen: false,        // 录入/编辑抽屉
  editingApp: null as Application | null, // null = 新建
  detailId: null as number | null,        // 详情抽屉对应的记录 id
  knowledgeIngestOpen: false,   // 知识库「录入面经」弹窗
  knowledgeVersion: 0,          // 知识库数据变更计数，视图 watch 刷新
  dataVersion: 0                // 数据变更计数，各视图 watch 它来刷新
})

export function openCreateForm(): void {
  store.editingApp = null
  store.formDrawerOpen = true
}

export function openKnowledgeIngest(): void {
  store.knowledgeIngestOpen = true
}

export function bumpKnowledge(): void {
  store.knowledgeVersion++
}

export function openEditForm(app: Application): void {
  store.editingApp = app
  store.formDrawerOpen = true
}

export function openDetail(id: number): void {
  store.detailId = id
}

export function bumpData(): void {
  store.dataVersion++
}
