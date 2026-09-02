<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { store, toggleTutor } from '../store'
import type { TutorCitation, TutorMessage, TutorSession } from '../types'
import RichText from './RichText.vue'

// AI 助教（需求 3.9.4）：学习区右侧常驻对话栏
// 会话与消息持久化在服务端 SQLite（tutor_sessions / tutor_messages），换页面/重启都在

// 助教专用模型切换（config.json 登记多个模型；只影响助教对话，其他 AI 功能用默认模型）
interface ArkModel {
  id: string
  label: string
}
const models = ref<ArkModel[]>([])
const activeModel = ref('')

async function loadModel(): Promise<void> {
  try {
    const r = await api.get<{ models: ArkModel[]; active: string }>('/tutor/model')
    models.value = r.models
    activeModel.value = r.active
  } catch {
    /* 未配置时不显示切换器 */
  }
}

async function switchModel(model: string): Promise<void> {
  try {
    await api.put('/tutor/model', { model })
    ElMessage.success(`助教已切换到 ${models.value.find((m) => m.id === model)?.label || model}`)
  } catch (err) {
    ElMessage.error((err as Error).message)
    await loadModel()
  }
}

const sessions = ref<TutorSession[]>([])
const activeSessionId = ref<number | null>(null)
const messages = ref<TutorMessage[]>([])
const input = ref('')
const sending = ref(false)
const retryRequest = ref<{ sessionId: number | null; content: string; requestId: string } | null>(null)
const historyOpen = ref(false)
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<{ focus: () => void } | null>(null)

const activeSession = (): TutorSession | undefined =>
  sessions.value.find((s) => s.id === activeSessionId.value)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

async function loadSessions(): Promise<void> {
  try {
    sessions.value = await api.get<TutorSession[]>('/tutor/sessions')
  } catch {
    /* 静默：历史列表加载失败不阻塞对话 */
  }
}

async function selectSession(id: number): Promise<void> {
  if (sending.value) return
  historyOpen.value = false
  try {
    const r = await api.get<{ messages: TutorMessage[] }>(`/tutor/sessions/${id}`)
    activeSessionId.value = id
    messages.value = r.messages
    retryRequest.value = null
    await scrollToBottom()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}

function newChat(): void {
  if (sending.value) return
  historyOpen.value = false
  activeSessionId.value = null
  messages.value = []
  retryRequest.value = null
}

function removeSession(s: TutorSession): void {
  ElMessageBox.confirm(`删除对话「${s.title}」？`, '提示', { type: 'warning' })
    .then(async () => {
      try {
        await api.delete(`/tutor/sessions/${s.id}`)
        if (activeSessionId.value === s.id) {
          activeSessionId.value = null
          messages.value = []
        }
        await loadSessions()
      } catch (err) {
        ElMessage.error((err as Error).message)
      }
    })
    .catch(() => {})
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || sending.value) return
  const requestId = retryRequest.value?.sessionId === activeSessionId.value && retryRequest.value.content === text
    ? retryRequest.value.requestId
    : crypto.randomUUID()
  input.value = ''
  const isNew = activeSessionId.value === null
  messages.value.push({ id: 0, role: 'user', content: text, created_at: '' })
  sending.value = true
  await scrollToBottom()
  try {
    const r = await api.post<{
      session_id: number
      assistant_message_id: number
      reply: string
      request_id: string
      citations: TutorCitation[]
    }>('/ai/knowledge/tutor', {
      session_id: activeSessionId.value,
      content: text,
      request_id: requestId
    })
    retryRequest.value = null
    activeSessionId.value = r.session_id
    messages.value.push({
      id: r.assistant_message_id,
      role: 'assistant',
      content: r.reply,
      created_at: '',
      citations: r.citations,
      feedback: null
    })
    if (isNew) await loadSessions() // 新会话标题已生成，刷一下列表
  } catch (err) {
    messages.value.pop() // 失败时把这条用户消息撤回，方便重发
    input.value = text
    retryRequest.value = { sessionId: activeSessionId.value, content: text, requestId }
    ElMessage.error((err as Error).message)
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

async function setFeedback(message: TutorMessage, value: -1 | 1): Promise<void> {
  if (!message.id) return
  const next = message.feedback === value ? 0 : value
  const previous = message.feedback ?? null
  message.feedback = next === 0 ? null : next
  try {
    await api.put(`/tutor/messages/${message.id}/feedback`, { value: next })
  } catch (error) {
    message.feedback = previous
    ElMessage.error((error as Error).message)
  }
}

/** 题目卡片「问助教」带进来的题目：填入输入框并聚焦 */
watch(
  () => store.tutorAsk,
  (q) => {
    if (!q) return
    input.value = `这道题怎么答比较好：${q}`
    store.tutorAsk = null
    nextTick(() => inputEl.value?.focus())
  }
)

onMounted(async () => {
  loadModel()
  await loadSessions()
  // 回来时自动接上最近一次对话
  if (sessions.value.length) await selectSession(sessions.value[0].id)
})
</script>

<template>
  <!-- 折叠态：细条竖按钮，点击展开 -->
  <aside v-if="!store.tutorOpen" class="tutor-rail" title="展开 AI 助教" @click="toggleTutor(true)">
    <span class="tutor-rail-icon">🎓</span>
    <span class="tutor-rail-text">AI 助教</span>
  </aside>

  <!-- 展开态：常驻右栏 -->
  <aside v-else class="tutor-panel">
    <div class="tutor-head">
      <el-button size="small" text :title="historyOpen ? '收起历史' : '历史对话'" @click="historyOpen = !historyOpen">
        ☰
      </el-button>
      <span class="tutor-title">🎓 AI 助教</span>
      <div class="tutor-head-actions">
        <el-button size="small" text @click="newChat">新对话</el-button>
        <el-button size="small" text title="收起助教栏" @click="toggleTutor(false)">收起 »</el-button>
      </div>
    </div>

    <!-- 助教专用模型切换（只配了一个模型时不显示） -->
    <div v-if="models.length > 1" class="tutor-model-bar">
      <span class="tutor-model-label">模型</span>
      <el-select v-model="activeModel" size="small" class="tutor-model-select" @change="switchModel">
        <el-option v-for="m in models" :key="m.id" :value="m.id" :label="m.label" />
      </el-select>
    </div>

    <!-- 历史会话列表 -->
    <div v-if="historyOpen" class="tutor-history">
      <div v-if="!sessions.length" class="tutor-history-empty">还没有历史对话</div>
      <div
        v-for="s in sessions"
        :key="s.id"
        class="tutor-history-item"
        :class="{ active: s.id === activeSessionId }"
        @click="selectSession(s.id)"
      >
        <div class="tutor-history-title">{{ s.title }}</div>
        <div class="tutor-history-sub">{{ s.updated_at.slice(0, 16).replace('T', ' ') }} · {{ s.message_count }} 条</div>
        <span class="tutor-history-del" title="删除对话" @click.stop="removeSession(s)">✕</span>
      </div>
    </div>

    <div ref="listEl" class="tutor-list">
      <div v-if="!messages.length" class="tutor-welcome">
        <p>我是你的面试助教，可以问我技术题、让我出题模拟面试、或者聊你的复习计划。</p>
        <p class="tutor-tip">回答会参考你知识库里已有的题目和答案；题目旁的「问助教」可以把题直接带进来。对话自动保存，随时从「☰ 历史」翻看。</p>
      </div>
      <div v-for="(m, i) in messages" :key="i" class="tutor-msg" :class="m.role">
        <div v-if="m.role === 'user'" class="tutor-bubble">{{ m.content }}</div>
        <div v-else class="tutor-bubble">
          <RichText :content="m.content" compact />
          <div v-if="m.citations?.length" class="tutor-citations">
            <div class="citation-title">参考了本地知识库</div>
            <template v-for="citation in m.citations" :key="citation.item_id">
              <router-link
                v-if="citation.source_id"
                :to="`/learn/knowledge/${citation.source_id}`"
                class="citation-link"
              >[{{ citation.ref }}] {{ citation.question }}</router-link>
              <span v-else class="citation-link">[{{ citation.ref }}] {{ citation.question }}</span>
            </template>
          </div>
          <div v-if="m.id" class="tutor-feedback">
            <span>这条回答有帮助吗？</span>
            <el-button link size="small" :type="m.feedback === 1 ? 'primary' : ''" @click="setFeedback(m, 1)">👍</el-button>
            <el-button link size="small" :type="m.feedback === -1 ? 'danger' : ''" @click="setFeedback(m, -1)">👎</el-button>
          </div>
        </div>
      </div>
      <div v-if="sending" class="tutor-msg assistant">
        <div class="tutor-bubble tutor-typing">思考中…</div>
      </div>
    </div>
    <div class="tutor-input-bar">
      <el-input
        ref="inputEl"
        v-model="input"
        type="textarea"
        :rows="3"
        placeholder="输入问题，Enter 发送（Shift+Enter 换行）"
        resize="none"
        @keydown.enter.exact.prevent="send"
      />
      <div class="tutor-input-actions">
        <el-button size="small" type="primary" :loading="sending" @click="send">发送</el-button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
/* 折叠态：右缘细条 */
.tutor-rail {
  width: 36px; flex-shrink: 0;
  align-self: stretch; position: sticky; top: 84px;
  height: calc(100vh - 100px);
  background: #409eff; color: #fff; border-radius: 10px;
  cursor: pointer; display: flex; flex-direction: column;
  align-items: center; padding-top: 14px; gap: 8px;
  box-shadow: 0 2px 8px rgba(64, 158, 255, 0.3);
  transition: background 0.2s;
}
.tutor-rail:hover { background: #66b1ff; }
.tutor-rail-icon { font-size: 18px; }
.tutor-rail-text {
  writing-mode: vertical-rl; letter-spacing: 4px;
  font-size: 13px; font-weight: 600;
}

/* 展开态 */
.tutor-panel {
  width: 380px; flex-shrink: 0;
  position: sticky; top: 84px;
  height: calc(100vh - 100px);
  background: #fff; border: 1px solid #ebeef5; border-radius: 12px;
  display: flex; flex-direction: column;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  overflow: hidden;
}
.tutor-head {
  display: flex; align-items: center; gap: 4px;
  padding: 10px 10px; border-bottom: 1px solid #f0f2f5;
}
.tutor-title { font-weight: 600; font-size: 15px; flex: 1; text-align: center; }
.tutor-head-actions { display: flex; }

/* 助教模型切换条 */
.tutor-model-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 14px; border-bottom: 1px solid #f0f2f5; background: #fafbfc;
}
.tutor-model-label { font-size: 12px; color: #909399; flex-shrink: 0; }
.tutor-model-select { flex: 1; }

/* 历史会话列表 */
.tutor-history {
  border-bottom: 1px solid #f0f2f5; max-height: 45%;
  overflow-y: auto; padding: 6px;
  background: #fafbfc;
}
.tutor-history-empty { color: #909399; font-size: 12px; text-align: center; padding: 12px 0; }
.tutor-history-item {
  position: relative; padding: 8px 10px; border-radius: 8px; cursor: pointer;
}
.tutor-history-item:hover { background: #ecf5ff; }
.tutor-history-item.active { background: #ecf5ff; }
.tutor-history-title {
  font-size: 13px; color: #303133;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding-right: 18px;
}
.tutor-history-sub { font-size: 11px; color: #909399; margin-top: 2px; }
.tutor-history-del {
  position: absolute; top: 8px; right: 8px;
  color: #c0c4cc; font-size: 12px; padding: 2px;
}
.tutor-history-del:hover { color: #f56c6c; }

.tutor-list { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; }
.tutor-welcome { color: #606266; font-size: 13px; padding: 20px 8px; text-align: center; }
.tutor-tip { color: #909399; font-size: 12px; }
.tutor-msg { display: flex; }
.tutor-msg.user { justify-content: flex-end; }
.tutor-bubble {
  max-width: 88%; padding: 8px 12px; border-radius: 10px; font-size: 14px; line-height: 1.6;
}
.tutor-msg.user .tutor-bubble { background: #409eff; color: #fff; white-space: pre-wrap; }
.tutor-msg.assistant .tutor-bubble { background: #f4f6fa; }
.tutor-typing { color: #909399; }
.tutor-citations { border-top: 1px solid #dfe5ec; margin-top: 8px; padding-top: 7px; display: flex; flex-direction: column; gap: 4px; }
.citation-title { color: #909399; font-size: 11px; }
.citation-link { color: #409eff; font-size: 11px; line-height: 1.45; text-decoration: none; }
.citation-link:hover { text-decoration: underline; }
.tutor-feedback { border-top: 1px solid #e7ebf0; margin-top: 7px; padding-top: 5px; color: #909399; font-size: 11px; display: flex; align-items: center; gap: 2px; }
.tutor-input-bar { border-top: 1px solid #f0f2f5; padding: 10px 14px 12px; }
.tutor-input-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
</style>
