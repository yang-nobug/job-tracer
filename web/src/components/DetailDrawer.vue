<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, openEditForm, bumpData } from '../store'
import { STATUS_LABEL_LIST, STATUS_ORDER, type ApplicationDetail, type Status } from '../types'
import { avatarColor } from '../utils/avatar'
import StatusTag from './StatusTag.vue'
import EventTimeline from './EventTimeline.vue'
import InterviewPanel from './InterviewPanel.vue'

const props = defineProps<{ appId: number | null }>()
const emit = defineEmits<(e: 'close') => void>()

const detail = ref<ApplicationDetail | null>(null)
const sharingToFeishu = ref(false)

async function load(): Promise<void> {
  if (!props.appId) {
    detail.value = null
    return
  }
  try {
    detail.value = await api.get<ApplicationDetail>(`/applications/${props.appId}`)
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

watch(() => props.appId, () => load(), { immediate: true })
watch(() => store.dataVersion, () => {
  if (props.appId) load()
})

const visible = computed({
  get: () => props.appId !== null,
  set: (v: boolean) => {
    if (!v) emit('close')
  }
})

async function changeStatus(s: Status): Promise<void> {
  if (!detail.value) return
  const requiresSchedule = ['assessment', 'testing', 'ai', 'round1', 'round2', 'round3', 'hr'].includes(s)
    && STATUS_ORDER.indexOf(s) > STATUS_ORDER.indexOf(detail.value.status)
  if (requiresSchedule) {
    // 与列表编辑共用表单，必须补齐环节时间后才推进状态。
    openEditForm({ ...detail.value, status: s })
    return
  }
  if (s !== 'unsent' && !detail.value.applied_at) {
    ElMessage.info('请先确认实际投递日期，再保存状态')
    openEditForm({ ...detail.value, status: s })
    return
  }
  try {
    await api.put(`/applications/${detail.value.id}`, { ...detail.value, status: s, ...(s === 'unsent' ? { applied_at: null, applied_time: null } : {}) })
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function toggleReject(): Promise<void> {
  if (!detail.value) return
  try {
    if (detail.value.rejected_at) {
      await api.patch(`/applications/${detail.value.id}/reject`, {})
      ElMessage.success('已恢复')
    } else {
      const action = await ElMessageBox.confirm('选择挂掉的方式', '标记为已挂', {
        confirmButtonText: '被拒（公司拒我）',
        cancelButtonText: '我拒（主动放弃）',
        distinguishCancelAndClose: true,
        type: 'warning'
      }).then(
        () => 'company',
        (action) => (action === 'cancel' ? 'me' : null)
      )
      if (!action) return
      await api.patch(`/applications/${detail.value.id}/reject`, { reject_type: action })
      ElMessage.success('已标记')
    }
    bumpData()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

async function removeApp(): Promise<void> {
  if (!detail.value) return
  try {
    await ElMessageBox.confirm(`确定删除「${detail.value.company} · ${detail.value.position}」？关联的动态、面试、清单和原始招聘材料会一并删除`, '删除确认', {
      type: 'warning',
      confirmButtonText: '删除',
      cancelButtonText: '取消'
    })
    await api.delete(`/applications/${detail.value.id}`)
    ElMessage.success('已删除')
    bumpData()
    emit('close')
  } catch (err) {
    if ((err as { toString(): string }).toString().includes('cancel')) return
    ElMessage.error((err as Error).message)
  }
}

async function shareToFeishu(): Promise<void> {
  if (!detail.value || sharingToFeishu.value) return
  sharingToFeishu.value = true
  try {
    await api.post(`/feishu/applications/${detail.value.id}/share`)
    ElMessage.success('岗位信息已发送到飞书群')
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    sharingToFeishu.value = false
  }
}

function fmtDate(s: string | null): string {
  return s ? s.slice(0, 10) : '—'
}
</script>

<template>
  <el-dialog v-model="visible" width="780px" top="5vh" class="detail-dialog" destroy-on-close>
    <div v-if="detail" class="detail">
      <header class="detail-head">
        <span class="head-avatar" :style="{ background: avatarColor(detail.company) }">{{ detail.company.slice(0, 1) }}</span>
        <div class="head-info">
          <p class="detail-kicker">APPLICATION DETAIL</p>
          <h2>{{ detail.company }}</h2>
          <p>{{ detail.position }}</p>
        </div>
        <StatusTag :app="detail" />
      </header>

      <div class="detail-actions">
        <div class="action-group">
          <span class="action-label">当前状态</span>
          <el-select :model-value="detail.status" style="width: 118px" size="small" @change="changeStatus">
            <el-option v-for="s in STATUS_LABEL_LIST" :key="s.value" :label="s.label" :value="s.value" />
          </el-select>
          <el-button size="small" :type="detail.rejected_at ? 'success' : 'danger'" text @click="toggleReject">
            {{ detail.rejected_at ? '恢复投递' : '标记挂掉' }}
          </el-button>
        </div>
        <div class="action-group secondary-actions">
          <el-tooltip content="发送可复制的岗位信息到已配置的飞书群" placement="top">
            <el-button size="small" :loading="sharingToFeishu" @click="shareToFeishu">分享到飞书</el-button>
          </el-tooltip>
          <el-button size="small" @click="openEditForm(detail)">编辑</el-button>
          <el-button size="small" type="danger" text @click="removeApp">删除</el-button>
        </div>
      </div>

      <section class="meta-card">
        <div class="info-grid">
          <div class="info-item"><span class="info-label">渠道</span><span class="info-value">{{ detail.channel || '未填写' }}</span></div>
          <div class="info-item"><span class="info-label">投递时间</span><span class="info-value">{{ fmtDate(detail.applied_at) }} {{ detail.applied_time || '' }}</span></div>
          <div class="info-item"><span class="info-label">工作地点</span><span class="info-value">{{ detail.location || '未填写' }}</span></div>
          <div class="info-item"><span class="info-label">联系人</span><span class="info-value">{{ detail.contact_name || '未填写' }}</span></div>
          <div class="info-item"><span class="info-label">联系方式</span><span class="info-value">{{ detail.contact_info || '未填写' }}</span></div>
          <div class="info-item"><span class="info-label">投递简历</span><span class="info-value"><a v-if="detail.resume" :href="`/api/resumes/${detail.resume.id}/file`" target="_blank" rel="noopener noreferrer" class="link">{{ detail.resume.filename }}</a><span v-else>未关联</span></span></div>
          <div v-if="detail.jd_link" class="info-item wide"><span class="info-label">岗位 JD 链接</span><a :href="detail.jd_link" target="_blank" rel="noopener noreferrer" class="link">打开岗位来源 ↗</a></div>
          <div v-if="detail.application_link" class="info-item wide"><span class="info-label">投递进度链接</span><a :href="detail.application_link" target="_blank" rel="noopener noreferrer" class="link">查看投递进度 ↗</a></div>
        </div>
      </section>

      <section v-if="detail.notes" class="notes"><span>备注</span><p>{{ detail.notes }}</p></section>
      <details v-if="detail.jd_text" class="section jd-section">
        <summary><span><b>岗位描述</b><small>点击展开全文</small></span><span class="summary-arrow">⌄</span></summary>
        <pre class="jd-text">{{ detail.jd_text }}</pre>
      </details>

      <section class="section">
        <div class="section-title"><div><p>INTERVIEW</p><h3>面试安排</h3></div></div>
        <InterviewPanel :app-id="detail.id" :interviews="detail.interviews" />
      </section>

      <section class="section">
        <div class="section-title"><div><p>ACTIVITY</p><h3>动态记录</h3></div></div>
        <EventTimeline :app-id="detail.id" />
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 16px; color: var(--jt-ink, #1f2937); }
.detail-head {
  display: flex; align-items: center; gap: 14px;
  padding: 3px 0 18px; border-bottom: 1px solid var(--jt-line, #e7e9ee);
}
.head-avatar {
  width: 48px; height: 48px; border-radius: 14px; flex-shrink: 0;
  color: #fff; font-size: 22px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.head-info { flex: 1; min-width: 0; }
.detail-kicker { margin: 0 0 4px; color: var(--jt-primary, #2563eb); font-size: 10px; font-weight: 800; letter-spacing: .1em; }
.head-info h2 { margin: 0; font-size: 21px; line-height: 1.22; letter-spacing: -.02em; }
.head-info > p:last-child { margin: 4px 0 0; color: var(--jt-muted, #6b7280); font-size: 13px; }
.detail-actions { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; }
.action-group { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }
.action-label { color: var(--jt-muted, #6b7280); font-size: 12px; }
.secondary-actions { margin-left: auto; }
.meta-card { border: 1px solid var(--jt-line, #e7e9ee); border-radius: 13px; background: #fff; }
.info-grid {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0; overflow: hidden; border-radius: inherit;
}
.info-item { display: flex; flex-direction: column; gap: 5px; min-width: 0; padding: 13px 14px; border-right: 1px solid var(--jt-line, #e7e9ee); border-bottom: 1px solid var(--jt-line, #e7e9ee); }
.info-item:nth-child(3n) { border-right: 0; }
.info-item:nth-last-child(-n + 3) { border-bottom: 0; }
.info-item.wide { grid-column: span 3; }
.info-label { font-size: 11px; color: var(--jt-muted, #6b7280); }
.info-value { overflow: hidden; color: #374151; font-size: 13px; line-height: 1.45; text-overflow: ellipsis; white-space: nowrap; }
.notes {
  display: grid; grid-template-columns: 74px minmax(0, 1fr); gap: 10px;
  padding: 13px 14px; border: 1px solid #f3dfb0; border-radius: 11px; background: #fffaf0;
  color: #5d4b2b; font-size: 13px;
}
.notes > span { color: #9a702c; font-size: 12px; font-weight: 700; }
.notes p { margin: 0; line-height: 1.65; white-space: pre-wrap; }
.section { padding: 16px; border: 1px solid var(--jt-line, #e7e9ee); border-radius: 13px; background: #fff; }
.section-title { margin-bottom: 13px; }
.section-title p { margin: 0 0 4px; color: var(--jt-primary, #2563eb); font-size: 10px; font-weight: 800; letter-spacing: .1em; }
.section-title h3 { margin: 0; font-size: 16px; }
.jd-section { padding: 0; }
.jd-section summary { display: flex; align-items: center; justify-content: space-between; padding: 15px 16px; cursor: pointer; list-style: none; }
.jd-section summary::-webkit-details-marker { display: none; }
.jd-section summary b { display: block; font-size: 15px; }
.jd-section summary small { display: block; margin-top: 4px; color: var(--jt-muted, #6b7280); font-size: 12px; font-weight: 400; }
.summary-arrow { color: var(--jt-muted, #6b7280); font-size: 19px; transition: transform .18s ease; }
.jd-section[open] .summary-arrow { transform: rotate(180deg); }
pre.jd-text {
  max-height: 350px; margin: 0; padding: 0 16px 16px; overflow: auto;
  border-top: 1px solid var(--jt-line, #e7e9ee); color: #374151; font-family: inherit;
  font-size: 13px; line-height: 1.7; white-space: pre-wrap; word-break: break-word;
}
.link { color: var(--jt-primary, #2563eb); text-decoration: none; word-break: break-all; }
.link:hover { text-decoration: underline; }
@media (max-width: 640px) {
  .detail-head { align-items: flex-start; }
  .detail-head :deep(.status-tag) { margin-left: auto; }
  .info-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .info-item:nth-child(3n) { border-right: 1px solid var(--jt-line, #e7e9ee); }
  .info-item:nth-child(2n) { border-right: 0; }
  .info-item:nth-last-child(-n + 3) { border-bottom: 1px solid var(--jt-line, #e7e9ee); }
  .info-item:nth-last-child(-n + 2) { border-bottom: 0; }
  .info-item.wide { grid-column: span 2; }
  .secondary-actions { margin-left: 0; }
}
</style>
