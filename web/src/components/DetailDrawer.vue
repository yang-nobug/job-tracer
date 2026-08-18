<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, openEditForm, bumpData } from '../store'
import { STATUS_LABEL_LIST, type ApplicationDetail, type Status } from '../types'
import { avatarColor } from '../utils/avatar'
import StatusTag from './StatusTag.vue'
import EventTimeline from './EventTimeline.vue'
import InterviewPanel from './InterviewPanel.vue'

const props = defineProps<{ appId: number | null }>()
const emit = defineEmits<(e: 'close') => void>()

const detail = ref<ApplicationDetail | null>(null)

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
  try {
    await api.put(`/applications/${detail.value.id}`, { ...detail.value, status: s })
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
    await ElMessageBox.confirm(`确定删除「${detail.value.company} · ${detail.value.position}」？关联的动态、面试、清单会一并删除`, '删除确认', {
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

function fmtDate(s: string | null): string {
  return s ? s.slice(0, 10) : '—'
}
</script>

<template>
  <el-dialog v-model="visible" width="720px" top="6vh" destroy-on-close>
    <div v-if="detail" class="detail">
      <!-- 头部：公司头像 + 名称/职位 + 状态 -->
      <div class="detail-head">
        <span class="head-avatar" :style="{ background: avatarColor(detail.company) }">
          {{ detail.company.slice(0, 1) }}
        </span>
        <div class="head-info">
          <div class="head-company">{{ detail.company }}</div>
          <div class="head-position">{{ detail.position }}</div>
        </div>
        <StatusTag :app="detail" />
      </div>

      <div class="detail-actions">
        <el-select :model-value="detail.status" style="width: 118px" size="small" @change="changeStatus">
          <el-option v-for="s in STATUS_LABEL_LIST" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <el-button size="small" :type="detail.rejected_at ? 'success' : 'danger'" plain @click="toggleReject">
          {{ detail.rejected_at ? '撤销挂掉' : '标记挂掉' }}
        </el-button>
        <span class="actions-spacer" />
        <el-button size="small" @click="openEditForm(detail)">编辑</el-button>
        <el-button size="small" type="danger" plain @click="removeApp">删除</el-button>
      </div>

      <div class="info-grid">
        <div class="info-item">
          <span class="info-label">渠道</span>
          <span class="info-value">{{ detail.channel || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">投递日期</span>
          <span class="info-value">{{ fmtDate(detail.applied_at) }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">地点</span>
          <span class="info-value">{{ detail.location || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">联系人</span>
          <span class="info-value">{{ detail.contact_name || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">联系方式</span>
          <span class="info-value">{{ detail.contact_info || '-' }}</span>
        </div>
        <div class="info-item">
          <span class="info-label">简历</span>
          <span class="info-value">
            <a v-if="detail.resume" :href="`/api/resumes/${detail.resume.id}/file`" target="_blank" class="link">
              {{ detail.resume.filename }}
            </a>
            <span v-else>-</span>
          </span>
        </div>
        <div v-if="detail.jd_link" class="info-item">
          <span class="info-label">JD 链接</span>
          <span class="info-value">
            <a :href="detail.jd_link" target="_blank" class="link">{{ detail.jd_link }}</a>
          </span>
        </div>
      </div>
      <div v-if="detail.notes" class="notes">{{ detail.notes }}</div>

      <div v-if="detail.jd_text" class="section">
        <h4>📄 JD 正文</h4>
        <pre class="jd-text">{{ detail.jd_text }}</pre>
      </div>

      <section class="section">
        <h4>📅 面试</h4>
        <InterviewPanel :app-id="detail.id" :interviews="detail.interviews" />
      </section>

      <section class="section">
        <h4>🕓 动态时间线</h4>
        <EventTimeline :app-id="detail.id" />
      </section>
    </div>
  </el-dialog>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 14px; }
.detail-head {
  display: flex; align-items: center; gap: 12px;
  padding-bottom: 14px; border-bottom: 1px solid #ebeef5;
}
.head-avatar {
  width: 44px; height: 44px; border-radius: 10px; flex-shrink: 0;
  color: #fff; font-size: 22px; font-weight: 600;
  display: flex; align-items: center; justify-content: center;
}
.head-info { flex: 1; min-width: 0; }
.head-company { font-size: 18px; font-weight: 700; color: #1f2637; line-height: 1.3; }
.head-position { font-size: 13px; color: #6b7385; margin-top: 2px; }
.detail-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.actions-spacer { flex: 1; }
.info-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px 16px; background: #f7f9fc; border-radius: 10px; padding: 14px;
}
.info-item { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.info-label { font-size: 12px; color: #9aa2b1; }
.info-value { font-size: 13px; color: #3c4353; word-break: break-all; }
.notes {
  background: #fdf8ef; border-radius: 10px; padding: 12px 14px;
  font-size: 13px; color: #6b5b3e; white-space: pre-wrap;
}
.section { background: #f7f9fc; border-radius: 10px; padding: 14px; }
.section h4 { margin: 0 0 10px; font-size: 14px; color: #303133; }
pre.jd-text {
  white-space: pre-wrap; word-break: break-all; font-size: 13px; margin: 0;
  max-height: 260px; overflow: auto; background: #fff; padding: 10px; border-radius: 8px;
}
.link { color: #409eff; text-decoration: none; word-break: break-all; }
</style>
