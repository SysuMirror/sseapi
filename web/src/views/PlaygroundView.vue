<template>
  <div class="pg" :class="{ 'pg-side-open': sideOpen }">
    <!-- 会话列表 -->
    <aside class="pg-side card">
      <div class="pg-side-h">
        <span>会话</span>
        <button class="btn btn-sm btn-primary" type="button" @click="newConv">＋ 新建</button>
      </div>
      <div class="pg-convs">
        <div
          v-for="c in convs"
          :key="c.id"
          class="pg-conv"
          :class="{ active: c.id === activeId }"
          @click="selectConv(c.id)"
        >
          <div class="pg-conv-t" :title="c.title" @dblclick.stop="renameConv(c)">{{ c.title }}</div>
          <div class="pg-conv-m muted">{{ c.messages.length }} 条</div>
          <button class="pg-conv-x" type="button" title="删除会话" @click.stop="removeConv(c.id)">×</button>
        </div>
        <div v-if="!convs.length" class="empty-inline">还没有会话</div>
      </div>
      <div class="pg-side-f muted">
        会话只存在本机浏览器（localStorage），不会同步到服务器。
      </div>
    </aside>

    <!-- 对话主区 -->
    <section class="pg-main card">
      <div class="pg-h">
        <button class="btn btn-sm btn-ghost pg-side-toggle" type="button" @click="sideOpen = !sideOpen">
          ☰
        </button>
        <div class="field pg-model">
          <label>模型</label>
          <select v-model="model" @change="onModelChange">
            <option v-for="m in chatModels" :key="m.slug" :value="m.slug" :disabled="m.devOnly">
              {{ m.displayName || m.slug }}{{ m.devOnly ? '（仅开发者）' : '' }}
            </option>
          </select>
        </div>
        <div class="pg-h-right">
          <button class="btn btn-sm btn-ghost" type="button" @click="settingsOpen = !settingsOpen">
            ⚙ 参数
          </button>
          <button class="btn btn-sm btn-ghost" type="button" :disabled="!activeConv?.messages.length" @click="clearMessages">
            清空消息
          </button>
          <button class="btn btn-sm btn-ghost" type="button" :disabled="!activeConv?.messages.length" @click="exportMd">
            导出 MD
          </button>
          <button class="btn btn-sm btn-ghost" type="button" :disabled="!activeConv?.messages.length" @click="exportJson">
            导出 JSON
          </button>
        </div>
      </div>

      <!-- 参数面板 -->
      <div v-if="settingsOpen && activeConv" class="pg-settings">
        <div class="field">
          <label>temperature（留空 = 上游默认）</label>
          <input v-model="activeConv.temperature" type="number" min="0" max="2" step="0.1" placeholder="0.7" />
        </div>
        <div class="field">
          <label>max_tokens（留空 = 上游默认）</label>
          <input v-model="activeConv.maxTokens" type="number" min="1" step="1" placeholder="1024" />
        </div>
        <div class="field pg-sys">
          <label>系统提示词 System</label>
          <textarea v-model="activeConv.system" rows="2" placeholder="（可选）例如：你是一个简洁的中文助手"></textarea>
        </div>
        <div class="pg-settings-note muted">
          该模型的上下文上限为 <b>{{ activeModel?.contextLength || '—' }}</b> tokens，超出会被平台直接拒（400）。
          当前上下文约 <b>{{ approxTokens }}</b> tokens。<template v-if="activeModel?.contextLimitEnabled">对话太长时请「新建」一个会话。</template>
        </div>
      </div>

      <!-- 消息流 -->
      <div ref="scrollEl" class="pg-msgs">
        <div v-if="!activeConv" class="empty">还没有会话，点左上「＋ 新建」开始。</div>
        <template v-else>
          <div v-if="!activeConv.messages.length" class="empty">
            <div>输入一句话开始对话。</div>
            <div class="muted pg-tip">当前模型：{{ activeModel?.displayName || model }}</div>
          </div>
          <div
            v-for="(m, i) in activeConv.messages"
            :key="i"
            class="pg-msg"
            :class="[m.role, m.error ? 'err' : '']"
          >
            <div class="pg-role">
              {{ m.role === 'user' ? '我' : '助手' }}
              <button
                class="btn btn-sm btn-ghost pg-copy"
                type="button"
                title="复制"
                @click="copyText(m.content)"
              >
                复制
              </button>
              <button
                v-if="m.role === 'assistant' && i === activeConv.messages.length - 1 && !streaming"
                class="btn btn-sm btn-ghost"
                type="button"
                title="重新生成"
                @click="regenerate"
              >
                重新生成
              </button>
            </div>
            <div v-if="m.role === 'user'" class="pg-bubble">{{ m.content }}</div>
            <!-- 助手正文来自模型输出 → 先转义再渲染（见 utils/markdown.ts） -->
            <div v-else class="pg-bubble md" v-html="renderMarkdown(m.content)"></div>
            <span v-if="m.role === 'assistant' && m.streaming" class="pg-caret"></span>
          </div>
        </template>
      </div>

      <!-- 输入区 -->
      <div class="pg-composer">
        <textarea
          v-model="input"
          rows="2"
          :disabled="!activeConv"
          placeholder="输入消息，Enter 发送 / Shift+Enter 换行"
          @keydown.enter.exact.prevent="send()"
        ></textarea>
        <div class="pg-composer-btns">
          <button v-if="streaming" class="btn btn-sm btn-danger" type="button" @click="stop">停止</button>
          <button v-else class="btn btn-primary" type="button" :disabled="!activeConv || !input.trim()" @click="send()">
            发送
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { streamChat, type StreamHandlers } from '../api/playground'
import { renderMarkdown } from '../utils/markdown'

interface Msg {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
  streaming?: boolean
}
interface Conv {
  id: string
  title: string
  model: string
  system: string
  temperature: string
  maxTokens: string
  messages: Msg[]
  updatedAt: number
}

const STORE_KEY = 'sseapi_playground_v1'
const route = useRoute()

const convs = ref<Conv[]>([])
const activeId = ref('')
const models = ref<any[]>([])
const model = ref('')
const input = ref('')
const streaming = ref(false)
const sideOpen = ref(false)
const settingsOpen = ref(false)
const scrollEl = ref<HTMLElement | null>(null)
let abortCtl: AbortController | null = null

const chatModels = computed(() => models.value.filter((m) => (m.modelType || 'chat') === 'chat'))
const activeConv = computed(() => convs.value.find((c) => c.id === activeId.value) || null)
const activeModel = computed(() => chatModels.value.find((m) => m.slug === model.value) || null)
const approxTokens = computed(() => {
  const c = activeConv.value
  if (!c) return 0
  const payload = c.system ? [{ role: 'system', content: c.system }, ...c.messages] : c.messages
  return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4))
})

/* ---------- 持久化 ---------- */

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}')
    if (Array.isArray(raw?.convs)) convs.value = raw.convs
    if (typeof raw?.activeId === 'string') activeId.value = raw.activeId
  } catch {
    /* 坏数据就重来 */
  }
  // 上次打开时的流式占位不能留着
  for (const c of convs.value) {
    for (const m of c.messages) m.streaming = false
  }
}
function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ convs: convs.value, activeId: activeId.value }))
  } catch {
    /* 超配额就算了 */
  }
}
watch([convs, activeId], persist, { deep: true })
// 切会话时若模型不同，顶部下拉跟着切
watch(activeId, () => {
  const c = activeConv.value
  if (c && c.model) model.value = c.model
})

/* ---------- 会话管理 ---------- */

function newConv() {
  const c: Conv = {
    id: `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    title: '新会话',
    model: model.value || chatModels.value[0]?.slug || '',
    system: '',
    temperature: '',
    maxTokens: '',
    messages: [],
    updatedAt: Date.now(),
  }
  convs.value.unshift(c)
  activeId.value = c.id
  model.value = c.model
  sideOpen.value = false
}
function selectConv(id: string) {
  activeId.value = id
  sideOpen.value = false
}
function renameConv(c: Conv) {
  const t = window.prompt('会话名称', c.title)
  if (t && t.trim()) c.title = t.trim()
}
function removeConv(id: string) {
  const idx = convs.value.findIndex((c) => c.id === id)
  if (idx < 0) return
  if (!window.confirm(`删除会话「${convs.value[idx].title}」？`)) return
  convs.value.splice(idx, 1)
  if (activeId.value === id) activeId.value = convs.value[0]?.id || ''
}
function clearMessages() {
  const c = activeConv.value
  if (!c) return
  if (!window.confirm('清空这个会话的所有消息？')) return
  c.messages = []
}
function onModelChange() {
  if (activeConv.value) activeConv.value.model = model.value
}

/* ---------- 发送 / 流式 ---------- */

function scrollToBottom() {
  nextTick(() => {
    const el = scrollEl.value
    if (el) el.scrollTop = el.scrollHeight
  })
}

function errText(message: string, status: number, retryAfter?: string): string {
  const tail = retryAfter ? `（约 ${retryAfter} 秒后可重试）` : ''
  if (status === 401) return `⚠ 登录已失效，请重新登录。`
  if (status === 402) return `⚠ 余额不足，请联系管理员充值。`
  if (status === 403) return `⚠ 无权调用该模型：${message}`
  if (status === 429) return `⚠ 触发限流：${message}${tail}`
  if (status === 400) return `⚠ 请求被拒：${message}`
  return `⚠ ${message}`
}

async function run(conv: Conv, history: { role: string; content: string }[]) {
  const holder: Msg = { role: 'assistant', content: '', streaming: true }
  conv.messages.push(holder)
  // push 进去的是原始对象，取回响应式代理才能触发视图更新
  const msg = conv.messages[conv.messages.length - 1]
  streaming.value = true
  abortCtl = new AbortController()
  scrollToBottom()

  const handlers: StreamHandlers = {
    onDelta: (t) => {
      msg.content += t
      scrollToBottom()
    },
    onDone: () => {},
    onError: (message, status, retryAfter) => {
      msg.error = true
      msg.content = (msg.content ? msg.content + '\n\n' : '') + errText(message, status, retryAfter)
    },
  }

  try {
    await streamChat(
      {
        model: conv.model,
        messages: history,
        system: conv.system || undefined,
        temperature: toNum(conv.temperature),
        max_tokens: toNum(conv.maxTokens),
      },
      handlers,
      abortCtl.signal,
    )
  } finally {
    msg.streaming = false
    streaming.value = false
    abortCtl = null
    conv.updatedAt = Date.now()
    persist()
    scrollToBottom()
  }
}

function toNum(v: string): number | undefined {
  const s = String(v ?? '').trim()
  if (!s) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

async function send(text?: string) {
  const conv = activeConv.value
  if (!conv || streaming.value) return
  const content = (text ?? input.value).trim()
  if (!content) return
  input.value = ''
  conv.messages.push({ role: 'user', content })
  if (conv.title === '新会话') conv.title = content.slice(0, 24)
  const history = conv.messages.filter((m) => !m.error).map((m) => ({ role: m.role, content: m.content }))
  await run(conv, history)
}

function stop() {
  abortCtl?.abort()
}

async function regenerate() {
  const conv = activeConv.value
  if (!conv || streaming.value) return
  // 丢掉最后一条助手消息（含错误提示），用现有历史重发
  while (conv.messages.length && conv.messages[conv.messages.length - 1].role === 'assistant') {
    conv.messages.pop()
  }
  if (!conv.messages.length) return
  const history = conv.messages.map((m) => ({ role: m.role, content: m.content }))
  await run(conv, history)
}

/* ---------- 杂项 ---------- */

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t)
  } catch {
    window.prompt('复制下面的内容', t)
  }
}
function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
function exportMd() {
  const c = activeConv.value
  if (!c) return
  const lines: string[] = [`# ${c.title}`, '', `- 模型：\`${c.model}\``]
  if (c.system) lines.push(`- 系统提示词：${c.system}`)
  lines.push('')
  for (const m of c.messages) {
    lines.push(m.role === 'user' ? '## 我' : '## 助手', '', m.content, '')
  }
  download(`${safeName(c.title)}.md`, lines.join('\n'))
}
function exportJson() {
  const c = activeConv.value
  if (!c) return
  download(`${safeName(c.title)}.json`, JSON.stringify(c, null, 2))
}
function safeName(s: string) {
  return s.replace(/[^\w一-龥-]+/g, '_').slice(0, 40) || 'chat'
}

onMounted(async () => {
  load()
  try {
    models.value = await api.models()
  } catch {
    models.value = []
  }
  const q = String(route.query.model || '')
  if (q && chatModels.value.some((m) => m.slug === q)) model.value = q
  if (!activeId.value || !activeConv.value) {
    if (convs.value.length) activeId.value = convs.value[0].id
    else if (chatModels.value.length) {
      model.value = model.value || chatModels.value[0].slug
      newConv()
    }
  }
  if (!model.value) model.value = activeConv.value?.model || chatModels.value[0]?.slug || ''
  scrollToBottom()
})
</script>

<style scoped>
.pg {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 12px;
  height: calc(100vh - 150px);
  min-height: 460px;
}
.pg-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px;
}
.pg-side-h {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
  padding-bottom: 8px;
}
.pg-convs {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
}
.pg-conv {
  position: relative;
  padding: 7px 24px 7px 9px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid transparent;
}
.pg-conv:hover {
  background: rgba(127, 127, 127, 0.08);
}
.pg-conv.active {
  background: rgba(127, 127, 127, 0.14);
  border-color: rgba(127, 127, 127, 0.25);
}
.pg-conv-t {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pg-conv-m {
  font-size: 11px;
}
.pg-conv-x {
  position: absolute;
  top: 5px;
  right: 5px;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  opacity: 0.45;
  font-size: 15px;
  line-height: 1;
}
.pg-conv-x:hover {
  opacity: 1;
}
.pg-side-f {
  font-size: 11px;
  padding-top: 8px;
  line-height: 1.5;
}
.pg-main {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 10px 12px;
}
.pg-h {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}
.pg-model {
  min-width: 190px;
  margin: 0;
}
.pg-h-right {
  margin-left: auto;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.pg-side-toggle {
  display: none;
}
.pg-settings {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 12px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(127, 127, 127, 0.18);
}
.pg-sys,
.pg-settings-note {
  grid-column: 1 / -1;
}
.pg-settings-note {
  font-size: 12px;
  line-height: 1.6;
}
.pg-msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 4px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.pg-msg {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pg-msg.user {
  align-items: flex-end;
}
.pg-role {
  font-size: 11px;
  opacity: 0.65;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pg-msg.user .pg-role {
  flex-direction: row-reverse;
}
.pg-copy {
  padding: 1px 6px;
  font-size: 11px;
  opacity: 0;
}
.pg-msg:hover .pg-copy {
  opacity: 1;
}
.pg-bubble {
  max-width: min(78ch, 88%);
  padding: 9px 12px;
  border-radius: 10px;
  background: rgba(127, 127, 127, 0.1);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.65;
  font-size: 14px;
}
.pg-msg.user .pg-bubble {
  background: rgba(90, 150, 255, 0.16);
}
.pg-msg.err .pg-bubble {
  background: rgba(255, 90, 90, 0.14);
}
.pg-bubble.md {
  white-space: normal;
}
.pg-bubble.md :deep(p) {
  margin: 0 0 8px;
}
.pg-bubble.md :deep(p:last-child) {
  margin-bottom: 0;
}
.pg-bubble.md :deep(.md-h) {
  font-weight: 600;
  margin: 10px 0 6px;
}
.pg-bubble.md :deep(.md-h1) {
  font-size: 18px;
}
.pg-bubble.md :deep(.md-h2) {
  font-size: 16px;
}
.pg-bubble.md :deep(ul),
.pg-bubble.md :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 22px;
}
.pg-bubble.md :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  background: rgba(127, 127, 127, 0.18);
  padding: 1px 5px;
  border-radius: 4px;
}
.pg-bubble.md :deep(.md-pre) {
  position: relative;
  margin: 8px 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.35);
  overflow-x: auto;
}
.pg-bubble.md :deep(.md-pre code) {
  background: transparent;
  padding: 0;
  white-space: pre;
}
.pg-bubble.md :deep(.md-pre code[data-lang])::before {
  content: attr(data-lang);
  position: absolute;
  top: 2px;
  right: 8px;
  font-size: 10px;
  opacity: 0.5;
}
.pg-caret {
  display: inline-block;
  width: 7px;
  height: 14px;
  background: currentColor;
  opacity: 0.6;
  animation: pg-blink 1s steps(2, start) infinite;
}
@keyframes pg-blink {
  to {
    visibility: hidden;
  }
}
.pg-composer {
  display: flex;
  gap: 8px;
  align-items: flex-end;
  padding-top: 8px;
  border-top: 1px solid rgba(127, 127, 127, 0.18);
}
.pg-composer textarea {
  flex: 1;
  resize: vertical;
  min-height: 44px;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(127, 127, 127, 0.3);
  background: transparent;
  color: inherit;
  font: inherit;
}
.pg-composer-btns {
  display: flex;
  gap: 6px;
}
.pg-tip {
  margin-top: 6px;
  font-size: 12px;
}
@media (max-width: 820px) {
  .pg {
    grid-template-columns: 1fr;
    height: calc(100vh - 190px);
  }
  .pg-side {
    display: none;
  }
  .pg-side-open .pg-side {
    display: flex;
    max-height: 40vh;
  }
  .pg-side-toggle {
    display: inline-block;
  }
  .pg-h-right .btn {
    padding: 2px 8px;
  }
  .pg-settings {
    grid-template-columns: 1fr;
  }
  .pg-bubble {
    max-width: 100%;
  }
}
</style>
