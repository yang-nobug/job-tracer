<script setup lang="ts">
import { nextTick, ref } from 'vue'
import MarkdownIt from 'markdown-it'
import { ElMessage } from 'element-plus'
import { api } from '../api'

// AI 助教（需求 3.9.4）：带知识库检索上下文的对话
const md = new MarkdownIt()

interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

const visible = ref(false)
const messages = ref<ChatMessage[]>([])
const input = ref('')
const sending = ref(false)
const listEl = ref<HTMLElement | null>(null)

async function scrollToBottom(): Promise<void> {
  await nextTick()
  if (listEl.value) listEl.value.scrollTop = listEl.value.scrollHeight
}

async function send(): Promise<void> {
  const text = input.value.trim()
  if (!text || sending.value) return
  input.value = ''
  messages.value.push({ role: 'user', content: text })
  sending.value = true
  await scrollToBottom()
  try {
    const r = await api.post<{ reply: string }>('/ai/knowledge/tutor', {
      messages: messages.value.map((m) => ({ role: m.role, content: m.content }))
    })
    messages.value.push({ role: 'assistant', content: r.reply })
  } catch (err) {
    messages.value.pop() // 失败时把这条用户消息撤回，方便重发
    input.value = text
    ElMessage.error((err as Error).message)
  } finally {
    sending.value = false
    await scrollToBottom()
  }
}

function clearChat(): void {
  messages.value = []
}
</script>

<template>
  <!-- 悬浮按钮：学习成长工作区显示 -->
  <div class="tutor-fab" title="AI 助教" @click="visible = true">🎓<span class="tutor-fab-text">助教</span></div>

  <el-drawer v-model="visible" title="🎓 AI 助教" size="420px">
    <div class="tutor-body">
      <div ref="listEl" class="tutor-list">
        <div v-if="!messages.length" class="tutor-welcome">
          <p>我是你的面试助教，可以问我技术题、让我出题模拟面试、或者聊你的复习计划。</p>
          <p class="tutor-tip">回答会参考你知识库里已有的题目和答案。</p>
        </div>
        <div v-for="(m, i) in messages" :key="i" class="tutor-msg" :class="m.role">
          <div v-if="m.role === 'user'" class="tutor-bubble">{{ m.content }}</div>
          <div v-else class="tutor-bubble md-body" v-html="md.render(m.content)" />
        </div>
        <div v-if="sending" class="tutor-msg assistant">
          <div class="tutor-bubble tutor-typing">思考中…</div>
        </div>
      </div>
      <div class="tutor-input-bar">
        <el-input
          v-model="input"
          type="textarea"
          :rows="2"
          placeholder="输入问题，Enter 发送（Shift+Enter 换行）"
          resize="none"
          @keydown.enter.exact.prevent="send"
        />
        <div class="tutor-input-actions">
          <el-button size="small" text @click="clearChat">新对话</el-button>
          <el-button size="small" type="primary" :loading="sending" @click="send">发送</el-button>
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<style scoped>
.tutor-fab {
  position: fixed; right: 20px; bottom: 84px; z-index: 90;
  width: 52px; height: 52px; border-radius: 50%;
  background: #409eff; color: #fff; cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  font-size: 20px; box-shadow: 0 4px 12px rgba(64, 158, 255, 0.4);
}
.tutor-fab:hover { background: #66b1ff; }
.tutor-fab-text { font-size: 10px; line-height: 1; margin-top: 2px; }

.tutor-body { display: flex; flex-direction: column; height: 100%; }
.tutor-list { flex: 1; overflow: auto; display: flex; flex-direction: column; gap: 10px; padding: 4px 2px; }
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
.md-body :deep(h1), .md-body :deep(h2), .md-body :deep(h3) { font-size: 15px; margin: 8px 0 4px; }
.md-body :deep(ul) { padding-left: 18px; }
.md-body :deep(pre) { background: #fff; border: 1px solid #ebeef5; padding: 8px; border-radius: 4px; overflow: auto; }
.md-body :deep(code) { font-size: 12px; }
.md-body :deep(p) { margin: 6px 0; }

.tutor-input-bar { border-top: 1px solid #ebeef5; padding-top: 10px; }
.tutor-input-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }

@media (max-width: 768px) {
  .tutor-fab { bottom: 70px; right: 12px; }
}
</style>
