<script setup lang="ts">
import { ref, watch, computed } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, openEditForm, bumpData } from '../store'
import { STATUS_LABELS, STATUS_LABEL_LIST, type ApplicationDetail, type Status } from '../types'
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
  <el-drawer v-model="visible" size="520px" :title="detail ? `${detail.company} · ${detail.position}` : ''" destroy-on-close>
    <div v-if="detail" class="detail">
      <div class="detail-actions">
        <el-select :model-value="detail.status" style="width: 110px" @change="changeStatus">
          <el-option v-for="s in STATUS_LABEL_LIST" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <StatusTag :app="detail" />
        <el-button size="small" :type="detail.rejected_at ? 'success' : 'danger'" plain @click="toggleReject">
          {{ detail.rejected_at ? '撤销挂掉' : '标记挂掉' }}
        </el-button>
        <el-button size="small" @click="openEditForm(detail)">编辑</el-button>
        <el-button size="small" type="danger" plain @click="removeApp">删除</el-button>
      </div>

      <el-descriptions :column="2" border size="small" class="detail-desc">
        <el-descriptions-item label="状态"><StatusTag :app="detail" /></el-descriptions-item>
        <el-descriptions-item label="渠道">{{ detail.channel || '—' }}</el-descriptions-item>
        <el-descriptions-item label="投递日期">{{ fmtDate(detail.applied_at) }}</el-descriptions-item>
        <el-descriptions-item label="地点">{{ detail.location || '—' }}</el-descriptions-item>
        <el-descriptions-item label="联系人">{{ detail.contact_name || '—' }}</el-descriptions-item>
        <el-descriptions-item label="联系方式">{{ detail.contact_info || '—' }}</el-descriptions-item>
        <el-descriptions-item label="简历" :span="2">
          <a v-if="detail.resume" :href="`/api/resumes/${detail.resume.id}/file`" target="_blank" class="link">
            {{ detail.resume.filename }}
          </a>
          <span v-else>—</span>
        </el-descriptions-item>
        <el-descriptions-item label="JD 链接" :span="2">
          <a v-if="detail.jd_link" :href="detail.jd_link" target="_blank" class="link">{{ detail.jd_link }}</a>
          <span v-else>—</span>
        </el-descriptions-item>
        <el-descriptions-item v-if="detail.notes" label="备注" :span="2">{{ detail.notes }}</el-descriptions-item>
      </el-descriptions>

      <div v-if="detail.jd_text" class="jd-section">
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
  </el-drawer>
</template>

<style scoped>
.detail { display: flex; flex-direction: column; gap: 14px; }
.detail-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.detail-desc { margin-top: 0; }
.jd-section h4 { margin: 6px 0 10px; font-size: 14px; color: #303133; }
.jd-section pre.jd-text {
  white-space: pre-wrap; word-break: break-all; font-size: 13px; margin: 0;
  max-height: 260px; overflow: auto; background: #f8f9fb; padding: 10px; border-radius: 6px;
}
.section h4 { margin: 6px 0 10px; font-size: 14px; color: #303133; }
.link { color: #409eff; text-decoration: none; word-break: break-all; }
@media (max-width: 768px) {
  .el-drawer { width: 100% !important; }
}
</style>
