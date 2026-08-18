<script setup lang="ts">
import { ref, reactive, watch, computed } from 'vue'
import draggable from 'vuedraggable'
import { ElMessage } from 'element-plus'
import { api } from '../api'
import { store, openDetail } from '../store'
import { avatarColor } from '../utils/avatar'
import { STATUS_ORDER, STATUS_LABELS, ASSESSMENT_STATUSES, INTERVIEW_STATUSES, type Application, type Status } from '../types'

const apps = ref<Application[]>([])

async function load(): Promise<void> {
  try {
    apps.value = await api.get<Application[]>('/applications')
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

watch(() => store.dataVersion, () => load(), { immediate: true })

const activeApps = computed(() => apps.value.filter((a) => !a.rejected_at))
const rejectedApps = computed(() => apps.value.filter((a) => a.rejected_at))

interface KanbanColumn {
  key: Status | 'rejected'
  label: string
  list: Application[]
}

// 看板分四段：前段（未投递/已投递）、考核组（心理测评/笔试/AI面）、面试组（一面~HR面）、后段（Offer/已挂）
const columns = computed<{ before: KanbanColumn[]; assessment: KanbanColumn[]; interview: KanbanColumn[]; after: KanbanColumn[] }>(() => {
  const mk = (key: Status | 'rejected', label: string): KanbanColumn => ({
    key,
    label,
    list:
      key === 'rejected'
        ? [...rejectedApps.value].sort((x, y) => (y.rejected_at ?? '').localeCompare(x.rejected_at ?? ''))
        : activeApps.value
            .filter((a) => a.status === key)
            .sort((x, y) => (y.applied_at ?? '').localeCompare(x.applied_at ?? ''))
  })

  const all: KanbanColumn[] = STATUS_ORDER.map((s) => mk(s, STATUS_LABELS[s]))
  all.push(mk('rejected', '已挂'))

  const assessmentKeys: readonly string[] = ASSESSMENT_STATUSES
  const interviewKeys: readonly string[] = INTERVIEW_STATUSES
  return {
    before: all.filter((c) => c.key === 'unsent' || c.key === 'applied'),
    assessment: all.filter((c) => assessmentKeys.includes(c.key)),
    interview: all.filter((c) => interviewKeys.includes(c.key)),
    after: all.filter((c) => c.key === 'offer' || c.key === 'rejected')
  }
})

const assessmentTotal = computed(() => columns.value.assessment.reduce((n, c) => n + c.list.length, 0))
const interviewTotal = computed(() => columns.value.interview.reduce((n, c) => n + c.list.length, 0))

function getListRef(key: string): Application[] {
  const all = [
    ...columns.value.before,
    ...columns.value.assessment,
    ...columns.value.interview,
    ...columns.value.after
  ]
  return all.find((c) => c.key === key)?.list ?? []
}

// 拖拽落地：按目标列同步状态（已挂列 <-> 状态列之间拖动时同步 rejected 标记）
async function onChange(key: Status | 'rejected'): Promise<void> {
  const list = getListRef(key)
  for (const app of list) {
    const wantRejected = key === 'rejected'
    const rejectChanged = wantRejected !== !!app.rejected_at
    const statusChanged = !wantRejected && app.status !== key
    if (!rejectChanged && !statusChanged) continue

    // 从未投递拖入已投递 -> 先弹窗，顺手填投递链接（职位页/进度查询页）
    if (!wantRejected && key === 'applied' && app.status === 'unsent') {
      pendingApplied.value = app
      appliedForm.jd_link = app.jd_link || ''
      return
    }

    // 拖入考核/面试子列且该环节还没有记录 -> 先弹窗补时间
    const roundLabel = ROUND_COL_KEYS.includes(key as Status) ? STATUS_LABELS[key as Status] : null
    if (!wantRejected && roundLabel && app.last_round !== roundLabel) {
      pendingInterview.value = { app, key: key as Status }
      ivForm.scheduled_at = ''
      ivForm.location = ''
      return
    }

    try {
      if (rejectChanged) {
        await api.patch(`/applications/${app.id}/reject`, { reject_type: 'company' })
      }
      if (statusChanged) {
        await api.put(`/applications/${app.id}`, { ...app, status: key })
      }
      store.dataVersion++
    } catch (err) {
      ElMessage.error((err as Error).message)
      load()
    }
    break
  }
}

// 拖入面试列时的补充信息弹窗
const pendingInterview = ref<{ app: Application; key: Status } | null>(null)
const ivForm = reactive({ scheduled_at: '', location: '' })

async function confirmInterview(): Promise<void> {
  const p = pendingInterview.value
  if (!p) return
  if (!ivForm.scheduled_at) {
    ElMessage.warning('请选择面试时间')
    return
  }
  try {
    // 先改状态再补面试记录：状态已到位后，面试接口就不会重复写状态事件
    if (p.app.status !== p.key) {
      await api.put(`/applications/${p.app.id}`, { ...p.app, status: p.key })
    }
    await api.post(`/applications/${p.app.id}/interviews`, {
      round: STATUS_LABELS[p.key],
      scheduled_at: ivForm.scheduled_at,
      location: ivForm.location
    })
    ElMessage.success(`已记录${STATUS_LABELS[p.key]}安排`)
    store.dataVersion++
  } catch (err) {
    ElMessage.error((err as Error).message)
    load()
  }
  pendingInterview.value = null
}

function cancelInterview(): void {
  pendingInterview.value = null
  load() // 撤销拖拽造成的视觉变化
}

// 拖入已投递时补投递链接
const pendingApplied = ref<Application | null>(null)
const appliedForm = reactive({ jd_link: '' })

async function confirmApplied(withLink: boolean): Promise<void> {
  const app = pendingApplied.value
  if (!app) return
  try {
    const link = withLink ? appliedForm.jd_link.trim() : (app.jd_link || '')
    await api.put(`/applications/${app.id}`, { ...app, status: 'applied', jd_link: link })
    store.dataVersion++
  } catch (err) {
    ElMessage.error((err as Error).message)
    load()
  }
  pendingApplied.value = null
}

function cancelApplied(): void {
  pendingApplied.value = null
  load() // 撤销拖拽造成的视觉变化
}

function dragDisabled(): boolean {
  return window.innerWidth <= 768
}

// 可折叠列：未投递 / 已挂（边缘池子，默认折叠省宽度）
const COLLAPSIBLE_KEYS = ['unsent', 'rejected']
const collapsed = reactive<Record<string, boolean>>(loadCollapsed())

function loadCollapsed(): Record<string, boolean> {
  try {
    return { unsent: true, rejected: true, ...JSON.parse(localStorage.getItem('kanban-collapsed') || '{}') }
  } catch {
    return { unsent: true, rejected: true }
  }
}

function collapsible(key: string): boolean {
  return COLLAPSIBLE_KEYS.includes(key)
}

function toggleCollapse(key: string): void {
  collapsed[key] = !collapsed[key]
  localStorage.setItem('kanban-collapsed', JSON.stringify(collapsed))
}

// 拖入这些列视为一个环节，需要补时间并生成记录（考核组 + 面试组）
const ROUND_COL_KEYS: readonly Status[] = [...ASSESSMENT_STATUSES, ...INTERVIEW_STATUSES]

// 头像取色逻辑在 utils/avatar.ts，与详情弹窗共用

// 每列的身份色：考核组蓝青系，面试组橙色渐变，Offer 绿，已挂灰
const COLUMN_COLORS: Record<string, string> = {
  unsent: '#94a3b8',
  applied: '#5b8def',
  assessment: '#8fa3bf',
  testing: '#38bdf8',
  ai: '#2dd4bf',
  round1: '#f5a623',
  round2: '#f97316',
  round3: '#ef4444',
  hr: '#a855f7',
  offer: '#22c55e',
  rejected: '#b6bcc8'
}
const ASSESSMENT_GROUP_COLOR = '#38bdf8'
const GROUP_COLOR = '#f5a623'
</script>

<template>
  <div class="kanban">
    <!-- 前段：未投递（可折叠）/ 已投递 -->
    <template v-for="col in columns.before" :key="col.key">
      <div
        v-if="collapsible(col.key) && collapsed[col.key]"
        class="kanban-col col-collapsed"
        :title="`点击展开「${col.label}」`"
        @click="toggleCollapse(col.key)"
      >
        <span class="col-count">{{ col.list.length }}</span>
        <span class="collapsed-label">{{ col.label }}</span>
        <span class="collapsed-arrow">»</span>
      </div>
      <div v-else class="kanban-col">
        <div class="col-head">
          <span class="col-title">
            <span class="col-dot" :style="{ background: COLUMN_COLORS[col.key] }" />
            {{ col.label }}
          </span>
          <span class="col-count">{{ col.list.length }}</span>
          <span
            v-if="collapsible(col.key)"
            class="fold-btn"
            title="折叠此列"
            @click.stop="toggleCollapse(col.key)"
          >«</span>
        </div>
      <draggable
        :list="col.list"
        :group="'apps'"
        item-key="id"
        :disabled="dragDisabled()"
        class="col-body"
        ghost-class="card-ghost"
        @change="onChange(col.key)"
      >
        <template #item="{ element }">
          <div
            class="card"
            :class="{ 'card-offer': element.status === 'offer', 'card-dead': !!element.rejected_at }"
            :style="{ borderColor: COLUMN_COLORS[col.key] + '66' }"
            @click="openDetail(element.id)"
          >
            <div class="card-top">
              <span class="card-avatar" :style="{ background: avatarColor(element.company) }">
                {{ element.company.slice(0, 1) }}
              </span>
              <span class="card-company">{{ element.company }}</span>
              <span v-if="element.rejected_at" class="card-rejected">
                {{ element.reject_type === 'me' ? '我拒' : '挂' }}
              </span>
              <a v-if="element.jd_link" class="card-link" :href="element.jd_link" target="_blank" @click.stop>🔗</a>
            </div>
            <div class="card-position">{{ element.position }}</div>
            <div class="card-meta">
              <span>{{ element.applied_at?.slice(5) || '未投' }}</span>
              <span v-if="element.next_interview_at" class="card-next">
                🎤 {{ element.next_interview_at.slice(5, 11) }}
              </span>
              <span v-else-if="element.channel" class="card-channel">{{ element.channel }}</span>
            </div>
          </div>
        </template>
      </draggable>
      </div>
    </template>

    <!-- 考核组：心理测评 / 笔试 / AI面 -->
    <div class="kanban-group assessment-group">
      <div class="col-head">
        <span class="col-title">
          <span class="col-dot" :style="{ background: ASSESSMENT_GROUP_COLOR }" />
          考核
        </span>
        <span class="col-count">{{ assessmentTotal }}</span>
      </div>
      <div class="group-body">
        <div v-for="col in columns.assessment" :key="col.key" class="kanban-subcol">
          <div class="sub-head">
            <span class="sub-title">
              <span class="col-dot" :style="{ background: COLUMN_COLORS[col.key] }" />
              {{ col.label }}
            </span>
            <span class="sub-count">{{ col.list.length }}</span>
          </div>
          <draggable
            :list="col.list"
            :group="'apps'"
            item-key="id"
            :disabled="dragDisabled()"
            class="col-body"
            ghost-class="card-ghost"
            @change="onChange(col.key)"
          >
            <template #item="{ element }">
              <div
                class="card"
                :class="{ 'card-offer': element.status === 'offer', 'card-dead': !!element.rejected_at }"
                :style="{ borderColor: COLUMN_COLORS[col.key] + '66' }"
                @click="openDetail(element.id)"
              >
                <div class="card-top">
                  <span class="card-avatar" :style="{ background: avatarColor(element.company) }">
                    {{ element.company.slice(0, 1) }}
                  </span>
                  <span class="card-company">{{ element.company }}</span>
                  <span v-if="element.rejected_at" class="card-rejected">
                    {{ element.reject_type === 'me' ? '我拒' : '挂' }}
                  </span>
                  <a v-if="element.jd_link" class="card-link" :href="element.jd_link" target="_blank" @click.stop>🔗</a>
                </div>
                <div class="card-position">{{ element.position }}</div>
                <div class="card-meta">
                  <span>{{ element.applied_at?.slice(5) || '未投' }}</span>
                  <span v-if="element.next_interview_at" class="card-next">
                    🎤 {{ element.next_interview_at.slice(5, 11) }}
                  </span>
                  <span v-else-if="element.channel" class="card-channel">{{ element.channel }}</span>
                </div>
              </div>
            </template>
          </draggable>
        </div>
      </div>
    </div>

    <!-- 面试组：内含各轮次子列 -->
    <div class="kanban-group">
      <div class="col-head">
        <span class="col-title">
          <span class="col-dot" :style="{ background: GROUP_COLOR }" />
          面试
        </span>
        <span class="col-count">{{ interviewTotal }}</span>
      </div>
      <div class="group-body">
        <div v-for="col in columns.interview" :key="col.key" class="kanban-subcol">
          <div class="sub-head">
            <span class="sub-title">
              <span class="col-dot" :style="{ background: COLUMN_COLORS[col.key] }" />
              {{ col.label }}
            </span>
            <span class="sub-count">{{ col.list.length }}</span>
          </div>
          <draggable
            :list="col.list"
            :group="'apps'"
            item-key="id"
            :disabled="dragDisabled()"
            class="col-body"
            ghost-class="card-ghost"
            @change="onChange(col.key)"
          >
            <template #item="{ element }">
              <div
                class="card"
                :class="{ 'card-offer': element.status === 'offer', 'card-dead': !!element.rejected_at }"
                :style="{ borderColor: COLUMN_COLORS[col.key] + '66' }"
                @click="openDetail(element.id)"
              >
                <div class="card-top">
                  <span class="card-avatar" :style="{ background: avatarColor(element.company) }">
                    {{ element.company.slice(0, 1) }}
                  </span>
                  <span class="card-company">{{ element.company }}</span>
                  <span v-if="element.rejected_at" class="card-rejected">
                    {{ element.reject_type === 'me' ? '我拒' : '挂' }}
                  </span>
                  <a v-if="element.jd_link" class="card-link" :href="element.jd_link" target="_blank" @click.stop>🔗</a>
                </div>
                <div class="card-position">{{ element.position }}</div>
                <div class="card-meta">
                  <span>{{ element.applied_at?.slice(5) || '未投' }}</span>
                  <span v-if="element.next_interview_at" class="card-next">
                    🎤 {{ element.next_interview_at.slice(5, 11) }}
                  </span>
                  <span v-else-if="element.channel" class="card-channel">{{ element.channel }}</span>
                </div>
              </div>
            </template>
          </draggable>
        </div>
      </div>
    </div>

    <!-- 后段：Offer / 已挂（可折叠） -->
    <template v-for="col in columns.after" :key="col.key">
      <div
        v-if="collapsible(col.key) && collapsed[col.key]"
        class="kanban-col col-collapsed"
        :title="`点击展开「${col.label}」`"
        @click="toggleCollapse(col.key)"
      >
        <span class="col-count">{{ col.list.length }}</span>
        <span class="collapsed-label">{{ col.label }}</span>
        <span class="collapsed-arrow">«</span>
      </div>
      <div v-else class="kanban-col">
        <div class="col-head">
          <span class="col-title">
            <span class="col-dot" :style="{ background: COLUMN_COLORS[col.key] }" />
            {{ col.label }}
          </span>
          <span class="col-count">{{ col.list.length }}</span>
          <span
            v-if="collapsible(col.key)"
            class="fold-btn"
            title="折叠此列"
            @click.stop="toggleCollapse(col.key)"
          >»</span>
        </div>
      <draggable
        :list="col.list"
        :group="'apps'"
        item-key="id"
        :disabled="dragDisabled()"
        class="col-body"
        ghost-class="card-ghost"
        @change="onChange(col.key)"
      >
        <template #item="{ element }">
          <div
            class="card"
            :class="{ 'card-offer': element.status === 'offer', 'card-dead': !!element.rejected_at }"
            :style="{ borderColor: COLUMN_COLORS[col.key] + '66' }"
            @click="openDetail(element.id)"
          >
            <div class="card-top">
              <span class="card-avatar" :style="{ background: avatarColor(element.company) }">
                {{ element.company.slice(0, 1) }}
              </span>
              <span class="card-company">{{ element.company }}</span>
              <span v-if="element.rejected_at" class="card-rejected">
                {{ element.reject_type === 'me' ? '我拒' : '挂' }}
              </span>
              <a v-if="element.jd_link" class="card-link" :href="element.jd_link" target="_blank" @click.stop>🔗</a>
            </div>
            <div class="card-position">{{ element.position }}</div>
            <div class="card-meta">
              <span>{{ element.applied_at?.slice(5) || '未投' }}</span>
              <span v-if="element.next_interview_at" class="card-next">
                🎤 {{ element.next_interview_at.slice(5, 11) }}
              </span>
              <span v-else-if="element.channel" class="card-channel">{{ element.channel }}</span>
            </div>
          </div>
        </template>
      </draggable>
      </div>
    </template>

    <!-- 拖入已投递时补投递链接 -->
    <el-dialog
      :model-value="!!pendingApplied"
      title="标记为已投递"
      width="460px"
      append-to-body
      destroy-on-close
      @update:model-value="(v: boolean) => !v && cancelApplied()"
    >
      <div v-if="pendingApplied">
        <p class="iv-prompt-tip">
          「{{ pendingApplied.company }}」进入 <b>已投递</b>，顺手填上投递链接（职位页 / 进度查询页），以后点卡片上的 🔗 就能回来看进度：
        </p>
        <el-input v-model="appliedForm.jd_link" placeholder="https://…（可留空，稍后在编辑里补）" clearable />
      </div>
      <template #footer>
        <el-button @click="cancelApplied">取消</el-button>
        <el-button @click="confirmApplied(false)">暂不填写</el-button>
        <el-button type="primary" @click="confirmApplied(true)">保存</el-button>
      </template>
    </el-dialog>

    <!-- 拖入考核/面试列时补充时间 -->
    <el-dialog
      :model-value="!!pendingInterview"
      title="安排环节"
      width="420px"
      append-to-body
      destroy-on-close
      @update:model-value="(v: boolean) => !v && cancelInterview()"
    >
      <div v-if="pendingInterview" class="iv-prompt">
        <p class="iv-prompt-tip">
          「{{ pendingInterview.app.company }}」进入 <b>{{ STATUS_LABELS[pendingInterview.key] }}</b>，补充时间后会自动生成复盘文档：
        </p>
        <el-date-picker
          v-model="ivForm.scheduled_at"
          type="datetime"
          value-format="YYYY-MM-DD HH:mm"
          placeholder="环节时间"
          style="width: 100%"
        />
        <el-input v-model="ivForm.location" placeholder="地点 / 会议链接（可选）" style="margin-top: 10px" />
      </div>
      <template #footer>
        <el-button @click="cancelInterview">取消</el-button>
        <el-button type="primary" @click="confirmInterview">确定</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.kanban {
  display: flex; gap: 8px; overflow-x: auto; align-items: stretch;
  padding: 12px 0 12px; min-height: calc(100vh - 150px);
}
.kanban-col {
  background: #e9edf4; border-radius: 10px;
  flex: 1 1 0; min-width: 128px;
  display: flex; flex-direction: column; max-height: calc(100vh - 150px);
}
/* 面试组：占 4 个子列的宽度，容器样式与普通列一致 */
.kanban-group {
  background: #e9edf4; border-radius: 10px;
  flex: 3.6 3.6 0; min-width: 420px;
  display: flex; flex-direction: column; max-height: calc(100vh - 150px);
}
/* 考核组：3 个子列 */
.assessment-group { flex: 2.7 2.7 0; min-width: 320px; }
.group-body {
  flex: 1; display: flex; gap: 6px; padding: 0 8px 8px;
  min-height: 0; overflow-x: auto;
}
.kanban-subcol {
  flex: 1 1 0; min-width: 96px;
  background: #f4f6fa; border-radius: 8px;
  display: flex; flex-direction: column;
}
.sub-head {
  display: flex; justify-content: center; align-items: center; gap: 7px;
  padding: 9px 8px 7px; white-space: nowrap;
}
.sub-title {
  display: flex; align-items: center; gap: 5px;
  font-weight: 600; font-size: 13px; color: #3c4353;
}
.sub-count {
  background: #d3d9e4; color: #59637a; border-radius: 9px;
  padding: 0 7px; font-size: 12px; font-weight: 600; line-height: 18px;
}
.kanban-subcol .col-body { padding: 0 5px 6px; min-height: 50px; }
.col-head {
  display: flex; justify-content: center; align-items: center; gap: 8px;
  padding: 13px 10px 11px; white-space: nowrap;
}
.col-title {
  display: flex; align-items: center; gap: 6px;
  font-weight: 600; font-size: 15px; color: #3c4353;
}
.col-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.fold-btn {
  color: #9aa2b1; font-size: 13px; line-height: 1; cursor: pointer;
  padding: 2px 5px; border-radius: 4px; user-select: none;
}
.fold-btn:hover { color: #409eff; background: #ecf5ff; }
/* 折叠列：窄条 + 竖排文字 + 数量角标 */
.col-collapsed {
  flex: 0 0 44px; min-width: 44px;
  align-items: center; justify-content: flex-start;
  padding: 12px 0 10px; gap: 10px; cursor: pointer;
  transition: background 0.15s;
}
.col-collapsed:hover { background: #e2e8f2; }
.collapsed-label {
  writing-mode: vertical-rl; letter-spacing: 3px;
  font-weight: 600; font-size: 13px; color: #3c4353;
}
.collapsed-arrow { color: #9aa2b1; font-size: 14px; line-height: 1; margin-top: auto; }
.col-count {
  background: #d3d9e4; color: #59637a; border-radius: 10px;
  padding: 0 8px; font-size: 13px; font-weight: 600; line-height: 20px;
}
.col-body { flex: 1; overflow-y: auto; padding: 0 6px 8px; min-height: 60px; }
.card {
  background: #fff; border-radius: 8px; padding: 8px 9px; margin-bottom: 6px;
  border: 1px solid rgba(28, 36, 52, 0.05);
  box-shadow: 0 1px 2px rgba(28, 36, 52, 0.04);
  cursor: pointer;
  transition: box-shadow 0.15s, transform 0.15s, border-color 0.15s;
}
.card:hover {
  box-shadow: 0 6px 16px rgba(28, 36, 52, 0.1);
  transform: translateY(-1px);
  border-color: rgba(28, 36, 52, 0.1);
}
.card-offer {
  border-color: #bfe8cd;
  background: linear-gradient(180deg, #f5fcf8 0%, #ffffff 70%);
}
.card-dead { opacity: 0.72; }
.card-dead .card-avatar { filter: grayscale(0.8); }
.card-ghost { opacity: 0.4; }
.card-top { display: flex; align-items: center; gap: 6px; min-width: 0; }
.card-avatar {
  width: 22px; height: 22px; border-radius: 6px; flex-shrink: 0;
  color: #fff; font-size: 13px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.card-company {
  font-weight: 600; font-size: 15px; color: #1f2637; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-link {
  margin-left: auto; flex-shrink: 0;
  color: #9aa2b1; text-decoration: none; font-size: 13px;
  padding: 1px 4px; border-radius: 4px; line-height: 1.4;
}
.card-link:hover { color: #409eff; background: #ecf5ff; }
.card-rejected {
  background: #f1f3f7; color: #909399; border-radius: 4px; padding: 0 4px;
  font-size: 12px; flex-shrink: 0;
}
.card-position {
  font-size: 14px; color: #6b7385; margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.card-meta {
  display: flex; justify-content: space-between; align-items: center; margin-top: 5px;
  font-size: 13px; color: #9aa2b1;
}
.card-channel { background: #f1f3f7; border-radius: 4px; padding: 0 4px; }
.card-round {
  background: #fef3e2; color: #d97a0d; border-radius: 4px; padding: 0 5px;
  font-weight: 600;
}
.card-next { color: #d97a0d; font-weight: 500; }
.iv-prompt-tip { margin: 0 0 12px; font-size: 14px; color: #3c4353; line-height: 1.6; }
@media (max-width: 768px) {
  .kanban-col { flex: 0 0 160px; min-width: 160px; }
  .kanban-group { flex: 0 0 440px; min-width: 440px; }
  .assessment-group { flex: 0 0 330px; min-width: 330px; }
}
</style>
