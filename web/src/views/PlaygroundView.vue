<template>
  <div class="pg" :class="{ 'side-open': sideOpen }">
    <!-- 会话列表 -->
    <aside class="card side">
      <div class="side-top">
        <span class="side-title">会话</span>
        <span v-if="convs.length" class="side-count">{{ convs.length }}</span>
        <button class="btn btn-sm btn-primary side-new" type="button" @click="newConv">
          <span class="ic" v-html="I.plus" />新建对话
        </button>
      </div>
      <div class="side-list">
        <button
          v-for="c in convs"
          :key="c.id"
          class="conv"
          :class="{ active: c.id === activeId }"
          type="button"
          @click="selectConv(c.id)"
        >
          <span class="conv-dot" :class="{ on: c.id === activeId }" />
          <span class="conv-main">
            <span class="conv-title" :title="c.title" @dblclick.stop="renameConv(c)">{{ c.title }}</span>
            <span class="conv-meta">{{ shortModel(c.model) }} · {{ c.messages.length }} 条 · {{ relTime(c.updatedAt) }}</span>
          </span>
          <span class="conv-x" title="删除会话" @click.stop="removeConv(c.id)">
            <span class="ic" v-html="I.trash" />
          </span>
        </button>
        <div v-if="!convs.length" class="side-empty">
          <span class="ic ic-lg" v-html="I.chat" />
          <div>还没有会话</div>
        </div>
      </div>
      <div class="side-foot">
        <span class="ic" v-html="I.lock" />
        会话只保存在本机浏览器，不会同步到服务器。
      </div>
    </aside>

    <!-- 对话主区 -->
    <section class="card main">
      <header class="bar">
        <button class="btn btn-sm btn-ghost bar-burger" type="button" title="会话列表" @click="sideOpen = !sideOpen">
          <span class="ic" v-html="I.menu" />
        </button>

        <div class="bar-model">
          <span class="bar-model-ic" :class="{ on: !!activeModel?.thinkingEnabled }">
            <span class="ic" v-html="activeModel?.thinkingEnabled ? I.think : I.chat" />
          </span>
          <select v-model="model" class="model-select" @change="onModelChange">
            <option v-for="m in chatModels" :key="m.slug" :value="m.slug" :disabled="m.devOnly">
              {{ modelLabel(m) }}
            </option>
          </select>
          <span v-if="activeModel?.thinkingEnabled" class="pill pill-think">思考</span>
          <span
            v-if="isWeakModel"
            class="pill pill-warn"
            :title="`上下文仅 ${activeModel?.contextLength} tokens，能力有限，适合联调测试`"
          >小模型</span>
        </div>

        <div class="bar-right">
          <button class="btn btn-sm btn-ghost" type="button" :class="{ on: settingsOpen }" @click="settingsOpen = !settingsOpen">
            <span class="ic" v-html="I.gear" />参数
          </button>
          <details class="menu">
            <summary class="btn btn-sm btn-ghost">
              <span class="ic" v-html="I.download" />导出
            </summary>
            <div class="menu-body">
              <button type="button" :disabled="!hasMessages" @click="exportMd()">Markdown（.md）</button>
              <button type="button" :disabled="!hasMessages" @click="exportJson()">JSON（.json）</button>
            </div>
          </details>
          <button class="btn btn-sm btn-ghost" type="button" :disabled="!hasMessages" @click="clearMessages">
            <span class="ic" v-html="I.eraser" />清空
          </button>
        </div>
      </header>

      <!-- 参数面板 -->
      <div v-if="settingsOpen && activeConv" class="settings">
        <div class="settings-head">
          <span class="settings-title">本次会话参数</span>
          <span class="muted small">留空 = 用上游默认值</span>
        </div>
        <div class="settings-grid">
          <label class="field">
            <span>temperature</span>
            <input v-model="activeConv.temperature" type="number" min="0" max="2" step="0.1" placeholder="0.7" />
          </label>
          <label class="field">
            <span>max_tokens</span>
            <input v-model="activeConv.maxTokens" type="number" min="1" step="1" placeholder="1024" />
          </label>
          <label class="field sys">
            <span>System 提示词</span>
            <textarea
              v-model="activeConv.system"
              rows="2"
              placeholder="（可选）例如：你是一个简洁的中文助手，回答控制在 3 行内"
            ></textarea>
          </label>
        </div>
        <div class="settings-note muted small">
          上下文上限 <b>{{ activeModel?.contextLength ? activeModel.contextLength : '不限' }}</b>
          <template v-if="activeModel?.contextLength"> tokens</template> ·
          当前约 <b>{{ approxTokens }}</b> tokens<template v-if="isWeakModel">，长对话会被平台拒（400），建议新建会话或换模型</template>
        </div>
      </div>

      <!-- 消息流 -->
      <div ref="scrollEl" class="msgs">
        <div v-if="!activeConv" class="blank">
          <span class="ic ic-xl" v-html="I.chat" />
          <div class="blank-t">还没有会话</div>
          <div class="blank-s">点左侧「新建对话」开始，或直接把下面的话题发给我。</div>
        </div>
        <template v-else>
          <div v-if="!activeConv.messages.length" class="blank">
            <span class="ic ic-xl" v-html="I.spark" />
            <div class="blank-t">开始一段对话</div>
            <div class="blank-s">
              当前模型 <b>{{ activeModel?.displayName || model }}</b><template v-if="activeModel?.contextLength">（上下文 {{ activeModel.contextLength }} tokens）</template>
            </div>
            <div class="chips">
              <button v-for="s in samples" :key="s" class="chip" type="button" @click="input = s">{{ s }}</button>
            </div>
          </div>

          <div
            v-for="(m, i) in activeConv.messages"
            :key="i"
            class="msg"
            :class="[m.role, m.error ? 'err' : '']"
          >
            <span class="ava" :class="m.role">{{ m.role === 'user' ? '我' : 'AI' }}</span>
            <div class="col">
              <div class="meta">
                <span class="who">{{ m.role === 'user' ? '我' : activeModel?.displayName || '助手' }}</span>
                <span class="tools">
                  <button v-if="m.reasoning" class="mini" type="button" @click="m.thinkOpen = !m.thinkOpen">
                    {{ m.thinkOpen ? '收起思考' : '思考过程' }}
                  </button>
                  <button v-if="m.content" class="mini" type="button" @click="copyText(m.content, $event)">复制</button>
                  <button
                    v-if="m.role === 'assistant' && i === activeConv.messages.length - 1 && !streaming"
                    class="mini"
                    type="button"
                    @click="regenerate"
                  >
                    重新生成
                  </button>
                </span>
              </div>

              <div v-if="m.reasoning" class="think" :class="{ open: m.thinkOpen }">
                <button class="think-head" type="button" @click="m.thinkOpen = !m.thinkOpen">
                  <span class="ic" v-html="I.think" />
                  已思考（{{ m.reasoning.length }} 字）
                  <span class="ic think-caret" v-html="I.chev" />
                </button>
                <div v-show="m.thinkOpen" class="think-body">{{ m.reasoning }}</div>
              </div>

              <div v-if="m.role === 'user'" class="bubble user">{{ m.content }}</div>
              <!-- 助手正文来自模型输出 → 先转义再渲染（见 utils/markdown.ts） -->
              <div v-else class="bubble md" v-html="renderMarkdown(m.content)"></div>

              <div v-if="m.streaming && !m.content" class="dots"><i /><i /><i /><span>{{ m.reasoning ? '思考中' : '正在生成' }}</span></div>
            </div>
          </div>
        </template>
      </div>

      <!-- 弱模型提示 -->
      <div v-if="weakTip" class="weak-tip">
        <span class="ic" v-html="I.warn" />
        <span>
          正在使用 <b>{{ activeModel?.displayName }}</b>：{{ weakReason }}。
          想要更好的回答，可以换成 <b>{{ strongModelName }}</b>。
        </span>
        <button class="btn btn-sm btn-primary" type="button" @click="switchTo(strongModelSlug)">换模型</button>
      </div>

      <!-- 输入区 -->
      <div class="composer">
        <div class="box" :class="{ focus: focused, disabled: !activeConv }">
          <textarea
            ref="inputEl"
            v-model="input"
            rows="1"
            :disabled="!activeConv"
            placeholder="输入消息…"
            @focus="focused = true"
            @blur="focused = false"
            @input="autoGrow"
            @keydown.enter.exact.prevent="send()"
          ></textarea>
          <button v-if="streaming" class="send stop" type="button" title="停止" @click="stop">
            <span class="ic" v-html="I.stop" />
          </button>
          <button
            v-else
            class="send"
            type="button"
            title="发送"
            :disabled="!activeConv || !input.trim()"
            @click="send()"
          >
            <span class="ic" v-html="I.send" />
          </button>
        </div>
        <div class="hint">
          <span>Enter 发送 · Shift+Enter 换行</span>
          <span v-if="activeConv" class="hint-right">
            约 {{ approxTokens }} tokens · 模型 {{ shortModel(model) }}
          </span>
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
  reasoning?: string
  thinkOpen?: boolean
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

const I = {
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  trash:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/></svg>',
  eraser:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20h16M7 16l9-9 3 3-9 9H7z"/></svg>',
  download:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v12M7 11l5 5 5-5M5 21h14"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1L7 17M17 7l2.1-2.1"/></svg>',
  menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3 1.2-4A8 8 0 1 1 21 12z"/><path d="M9 11h6M9 14h4"/></svg>',
  think:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z"/><path d="M18 16l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15.5l-1.9-4.6L5.5 9l4.6-1.4L12 3z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 4l9 16H3L12 4z"/><path d="M12 10v4M12 17.5v.5"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>',
}

const samples = ['用三句话解释什么是快速傅里叶变换', '把下面这段代码改成 TypeScript', '帮我润色一段英文邮件']

const convs = ref<Conv[]>([])
const activeId = ref('')
const models = ref<any[]>([])
const model = ref('')
const input = ref('')
const streaming = ref(false)
const sideOpen = ref(false)
const settingsOpen = ref(false)
const focused = ref(false)
const scrollEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
let abortCtl: AbortController | null = null

const chatModels = computed(() => models.value.filter((m) => (m.modelType || 'chat') === 'chat'))
const activeConv = computed(() => convs.value.find((c) => c.id === activeId.value) || null)
const activeModel = computed(() => chatModels.value.find((m) => m.slug === model.value) || null)
const hasMessages = computed(() => !!activeConv.value?.messages.length)
const approxTokens = computed(() => {
  const c = activeConv.value
  if (!c) return 0
  const payload = c.system ? [{ role: 'system', content: c.system }, ...c.messages] : c.messages
  return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4))
})

/** 默认模型：优先「支持思考」的非开发者模型（通常能力更强），否则第一个 */
const defaultSlug = computed(() => {
  const list = chatModels.value.filter((m) => !m.devOnly)
  return (list.find((m) => m.thinkingEnabled) || list[0] || chatModels.value[0])?.slug || ''
})
const strongModelSlug = computed(() => defaultSlug.value)
const strongModelName = computed(() => chatModels.value.find((m) => m.slug === defaultSlug.value)?.displayName || defaultSlug.value)

/** 上下文很小的模型标为「小模型」，避免被当成大模型误用 */
const isWeakModel = computed(() => {
  const m = activeModel.value
  if (!m) return false
  return !!m.contextLength && m.contextLength <= 8192
})
const weakReason = computed(() => {
  const m = activeModel.value
  const bits: string[] = []
  if (m?.contextLength && m.contextLength <= 8192) bits.push(`上下文只有 ${m.contextLength} tokens`)
  if (m && !m.thinkingEnabled) bits.push('不支持思考模式')
  return bits.join('、') || '能力相对有限'
})
const weakTip = computed(() => isWeakModel.value && !!strongModelSlug.value && strongModelSlug.value !== model.value)

function modelLabel(m: any): string {
  const name = m.displayName || m.slug
  const bits: string[] = []
  if (m.thinkingEnabled) bits.push('思考')
  if (m.contextLength) bits.push(`ctx ${formatK(m.contextLength)}`)
  if (m.contextLength && m.contextLength <= 8192) bits.push('小模型')
  return bits.length ? `${name}（${bits.join(' · ')}）` : name
}
function formatK(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}
function shortModel(slug: string): string {
  const m = chatModels.value.find((x) => x.slug === slug)
  return m?.displayName || slug || '—'
}
function relTime(ts: number): string {
  if (!ts) return ''
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  const t = new Date(ts)
  return `${t.getMonth() + 1}/${t.getDate()}`
}

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
    for (const m of c.messages) {
      m.streaming = false
      m.thinkOpen = false
    }
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
    model: model.value || defaultSlug.value || chatModels.value[0]?.slug || '',
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
  nextTick(() => inputEl.value?.focus())
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
function switchTo(slug: string) {
  if (!slug) return
  model.value = slug
  onModelChange()
}

/* ---------- 发送 / 流式 ---------- */

function scrollToBottom(force = false) {
  nextTick(() => {
    const el = scrollEl.value
    if (!el) return
    // 用户往上翻看历史时不要硬拽回底部
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    if (force || near) el.scrollTop = el.scrollHeight
  })
}
function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(el.scrollHeight, 168)}px`
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
  scrollToBottom(true)

  const handlers: StreamHandlers = {
    onDelta: (t) => {
      msg.content += t
      scrollToBottom()
    },
    onReasoning: (t) => {
      msg.reasoning = (msg.reasoning || '') + t
      // 思考中默认展开，正文一开始就收起，别喧宾夺主
      if (msg.thinkOpen === undefined) msg.thinkOpen = true
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
    if (msg.content && msg.reasoning) msg.thinkOpen = false
    streaming.value = false
    abortCtl = null
    conv.updatedAt = Date.now()
    persist()
    scrollToBottom(true)
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
  nextTick(autoGrow)
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

async function copyText(t: string, ev?: MouseEvent) {
  try {
    await navigator.clipboard.writeText(t)
    const el = ev?.target as HTMLElement | undefined
    if (el) {
      const old = el.textContent
      el.textContent = '已复制'
      window.setTimeout(() => (el.textContent = old), 1200)
    }
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
      model.value = model.value || defaultSlug.value
      newConv()
    }
  }
  if (!model.value) model.value = activeConv.value?.model || defaultSlug.value || ''
  scrollToBottom(true)
})
</script>

<style scoped>
.pg {
  display: grid;
  grid-template-columns: 258px 1fr;
  gap: var(--sp-3);
  height: calc(100vh - 148px);
  min-height: 480px;
}

/* ---------- 侧栏 ---------- */
.side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: var(--sp-3);
}
.side-top {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--line);
}
.side-title {
  font-size: var(--fs-base);
  font-weight: 650;
  color: var(--ink-strong);
}
.side-count {
  min-width: 20px;
  text-align: center;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background: var(--bg-soft);
  color: var(--ink-soft);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.side-new {
  flex: 1 0 100%;
  margin-top: var(--sp-1);
}
.side-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-2) 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.conv {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  text-align: left;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--ink);
  transition: background var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.conv:hover {
  background: var(--bg-soft);
}
.conv.active {
  background: var(--brand-soft);
  border-color: rgba(var(--brand-rgb), 0.18);
}
.conv-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--n-300);
}
.conv-dot.on {
  background: var(--brand);
  box-shadow: 0 0 0 3px rgba(var(--brand-rgb), 0.16);
}
.conv-main {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.conv-title {
  font-size: var(--fs-base);
  font-weight: 550;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv.active .conv-title {
  color: var(--brand-ink);
}
.conv-meta {
  font-size: var(--fs-xs);
  color: var(--ink-soft);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv-x {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: var(--radius-xs);
  color: var(--ink-soft);
  opacity: 0;
  transition: opacity var(--dur) var(--ease), color var(--dur) var(--ease), background var(--dur) var(--ease);
}
.conv:hover .conv-x {
  opacity: 0.7;
}
.conv-x:hover {
  opacity: 1;
  color: var(--danger-ink);
  background: var(--danger-soft);
}
.side-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-8) var(--sp-3);
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}
.side-foot {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding-top: var(--sp-3);
  border-top: 1px solid var(--line);
  font-size: var(--fs-xs);
  line-height: 1.55;
  color: var(--ink-soft);
}
.side-foot .ic {
  flex: none;
  margin-top: 1px;
}

/* ---------- 主区 ---------- */
.main {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 10px var(--sp-4);
  border-bottom: 1px solid var(--line);
  background: var(--n-25);
}
.bar-burger {
  display: none;
}
.bar-model {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  min-width: 0;
}
.bar-model-ic {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  color: var(--ink-soft);
}
.bar-model-ic.on {
  background: var(--violet-soft);
  color: var(--violet-ink);
}
.model-select {
  appearance: none;
  max-width: 320px;
  padding: 6px 30px 6px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%236f7683' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")
    no-repeat right 8px center/14px;
  color: var(--ink-strong);
  font-size: var(--fs-md);
  font-weight: 600;
  text-overflow: ellipsis;
  transition: background-color var(--dur) var(--ease), border-color var(--dur) var(--ease);
}
.model-select:hover {
  background-color: var(--bg-soft);
  border-color: var(--line-strong);
}
.model-select:focus {
  border-color: var(--brand);
  box-shadow: var(--ring);
  outline: none;
}
.pill {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-xs);
  font-weight: 600;
  line-height: 1.5;
}
.pill-think {
  background: var(--violet-soft);
  color: var(--violet-ink);
}
.pill-warn {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.bar-right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.bar-right .btn.on {
  background: var(--brand-soft);
  border-color: rgba(var(--brand-rgb), 0.25);
  color: var(--brand-ink);
}
.ic {
  display: inline-flex;
  width: 14px;
  height: 14px;
  flex: none;
}
.ic :deep(svg),
.ic svg {
  width: 100%;
  height: 100%;
}
.ic-lg {
  width: 22px;
  height: 22px;
}
.ic-xl {
  width: 30px;
  height: 30px;
}

/* 导出下拉 */
.menu {
  position: relative;
}
.menu summary {
  list-style: none;
  cursor: pointer;
}
.menu summary::-webkit-details-marker {
  display: none;
}
.menu-body {
  position: absolute;
  right: 0;
  top: calc(100% + 6px);
  z-index: 20;
  min-width: 168px;
  padding: 5px;
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-md);
}
.menu-body button {
  text-align: left;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--ink);
  font-size: var(--fs-base);
}
.menu-body button:hover:not(:disabled) {
  background: var(--bg-soft);
}
.menu-body button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

/* 参数面板 */
.settings {
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--line);
  background: var(--bg-soft);
}
.settings-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.settings-title {
  font-size: var(--fs-base);
  font-weight: 650;
  color: var(--ink-strong);
}
.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.settings-grid .sys {
  grid-column: 1 / -1;
}
.settings-grid input,
.settings-grid textarea {
  background: var(--n-0);
}
.settings-note {
  margin-top: var(--sp-2);
  line-height: 1.6;
}
.settings-note b {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

/* 消息流 */
.msgs {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--sp-5) var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
}
.blank {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-2);
  text-align: center;
  color: var(--ink-soft);
  padding: var(--sp-8) var(--sp-4);
}
.blank .ic {
  color: var(--brand);
  opacity: 0.85;
}
.blank-t {
  font-size: var(--fs-lg);
  font-weight: 650;
  color: var(--ink-strong);
}
.blank-s {
  font-size: var(--fs-base);
  max-width: 44ch;
  line-height: 1.6;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
.chip {
  padding: 6px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  background: var(--n-0);
  color: var(--ink-soft);
  font-size: var(--fs-sm);
  transition: all var(--dur) var(--ease);
}
.chip:hover {
  border-color: rgba(var(--brand-rgb), 0.4);
  background: var(--brand-softer);
  color: var(--brand-ink);
}
.msg {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}
.msg.user {
  flex-direction: row-reverse;
}
.ava {
  flex: none;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: var(--fs-xs);
  font-weight: 700;
  color: #fff;
  background: linear-gradient(180deg, var(--brand), var(--brand-hover));
  box-shadow: var(--shadow-xs);
}
.ava.assistant {
  color: var(--brand-ink);
  background: var(--brand-soft);
  border: 1px solid rgba(var(--brand-rgb), 0.2);
  box-shadow: none;
}
.col {
  min-width: 0;
  max-width: min(78ch, calc(100% - 44px));
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.msg.user .col {
  align-items: flex-end;
}
.meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-xs);
  color: var(--ink-soft);
}
.msg.user .meta {
  flex-direction: row-reverse;
}
.who {
  font-weight: 600;
  color: var(--ink-faint);
}
.tools {
  display: inline-flex;
  gap: 4px;
  opacity: 0;
  transition: opacity var(--dur) var(--ease);
}
.msg:hover .tools {
  opacity: 1;
}
.mini {
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  padding: 1px 6px;
  background: transparent;
  color: var(--ink-soft);
  font-size: var(--fs-xs);
}
.mini:hover {
  background: var(--bg-soft);
  border-color: var(--line-strong);
  color: var(--ink);
}
.bubble {
  padding: 10px 13px;
  border-radius: var(--radius-lg);
  font-size: var(--fs-md);
  line-height: 1.7;
  word-break: break-word;
  white-space: pre-wrap;
}
.bubble.user {
  border-bottom-right-radius: var(--radius-xs);
  background: linear-gradient(180deg, var(--brand), var(--brand-hover));
  color: #fff;
  box-shadow: 0 1px 2px rgba(var(--brand-rgb), 0.28);
}
.bubble.md {
  background: var(--n-0);
  border: 1px solid var(--line);
  border-bottom-left-radius: var(--radius-xs);
  box-shadow: var(--shadow-xs);
  white-space: normal;
}
.msg.err .bubble.md {
  background: var(--danger-soft);
  border-color: #f8d4d5;
  color: var(--danger-ink);
}
.bubble.md :deep(p) {
  margin: 0 0 8px;
}
.bubble.md :deep(p:last-child) {
  margin-bottom: 0;
}
.bubble.md :deep(.md-h) {
  font-weight: 650;
  margin: 12px 0 6px;
  color: var(--ink-strong);
}
.bubble.md :deep(.md-h:first-child) {
  margin-top: 0;
}
.bubble.md :deep(.md-h1) {
  font-size: var(--fs-lg);
}
.bubble.md :deep(.md-h2) {
  font-size: var(--fs-md);
}
.bubble.md :deep(ul),
.bubble.md :deep(ol) {
  margin: 4px 0 8px;
  padding-left: 22px;
}
.bubble.md :deep(li) {
  margin: 2px 0;
}
.bubble.md :deep(blockquote) {
  margin: 6px 0;
  padding: 2px 0 2px 12px;
  border-left: 3px solid var(--line-strong);
  color: var(--ink-soft);
}
.bubble.md :deep(hr) {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 12px 0;
}
.bubble.md :deep(code) {
  font-family: var(--mono);
  font-size: 12.5px;
  background: var(--bg-soft);
  border: 1px solid var(--line);
  padding: 1px 5px;
  border-radius: var(--radius-xs);
}
.bubble.md :deep(.md-pre) {
  position: relative;
  margin: 8px 0;
  padding: 11px 13px;
  border-radius: var(--radius-sm);
  background: var(--n-900);
  overflow-x: auto;
}
.bubble.md :deep(.md-pre code) {
  background: transparent;
  border: 0;
  padding: 0;
  white-space: pre;
  color: var(--n-100);
}
.bubble.md :deep(.md-pre code[data-lang])::before {
  content: attr(data-lang);
  position: absolute;
  top: 4px;
  right: 10px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--n-400);
}
.bubble.md :deep(a) {
  color: var(--brand-ink);
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* 思考过程 */
.think {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-soft);
  overflow: hidden;
}
.think-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 10px;
  border: 0;
  background: transparent;
  color: var(--violet-ink);
  font-size: var(--fs-xs);
  font-weight: 600;
}
.think-head .ic {
  width: 13px;
  height: 13px;
}
.think-caret {
  margin-left: auto;
  transition: transform var(--dur) var(--ease);
}
.think.open .think-caret {
  transform: rotate(180deg);
}
.think-body {
  padding: 0 10px 9px;
  font-size: var(--fs-sm);
  line-height: 1.65;
  color: var(--ink-soft);
  white-space: pre-wrap;
  max-height: 220px;
  overflow-y: auto;
}
.dots {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-xs);
  color: var(--ink-soft);
}
.dots i {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--brand);
  opacity: 0.5;
  animation: pg-bounce 1.1s var(--ease) infinite;
}
.dots i:nth-child(2) {
  animation-delay: 0.16s;
}
.dots i:nth-child(3) {
  animation-delay: 0.32s;
}
.dots span {
  margin-left: 3px;
}
@keyframes pg-bounce {
  0%,
  100% {
    transform: translateY(0);
    opacity: 0.35;
  }
  40% {
    transform: translateY(-3px);
    opacity: 1;
  }
}

/* 弱模型提示 */
.weak-tip {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin: 0 var(--sp-4) var(--sp-2);
  padding: 7px 10px;
  border: 1px solid #f2d9a8;
  border-radius: var(--radius-sm);
  background: var(--warn-soft);
  color: var(--warn-ink);
  font-size: var(--fs-sm);
}
.weak-tip .ic {
  width: 15px;
  height: 15px;
  flex: none;
}
.weak-tip b {
  font-weight: 650;
}
.weak-tip > span:nth-child(2) {
  flex: 1;
  min-width: 0;
}

/* 输入区 */
.composer {
  padding: var(--sp-3) var(--sp-4) 10px;
  border-top: 1px solid var(--line);
  background: var(--n-25);
}
.box {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  padding: 6px 6px 6px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius);
  background: var(--n-0);
  box-shadow: var(--shadow-xs);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
.box.focus {
  border-color: var(--brand);
  box-shadow: var(--ring);
}
.box.disabled {
  opacity: 0.6;
}
.box textarea {
  flex: 1;
  min-height: 26px;
  max-height: 168px;
  padding: 5px 0;
  border: 0;
  background: transparent;
  resize: none;
  outline: none;
  color: var(--ink);
  font: inherit;
  line-height: 1.6;
}
.send {
  flex: none;
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--brand);
  color: #fff;
  box-shadow: 0 1px 2px rgba(var(--brand-rgb), 0.3);
  transition: background var(--dur) var(--ease), opacity var(--dur) var(--ease);
}
.send:hover:not(:disabled) {
  background: var(--brand-hover);
}
.send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.send.stop {
  background: var(--danger);
}
.send.stop:hover {
  background: var(--danger-ink);
}
.hint {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-3);
  margin-top: 6px;
  font-size: var(--fs-xs);
  color: var(--ink-soft);
}

/* ---------- 窄屏 ---------- */
@media (max-width: 860px) {
  .pg {
    grid-template-columns: 1fr;
    height: calc(100vh - 176px);
  }
  .pg .side {
    display: none;
  }
  .pg.side-open .side {
    display: flex;
    position: absolute;
    z-index: 30;
    left: var(--sp-4);
    right: var(--sp-4);
    top: 68px;
    max-height: 60vh;
    box-shadow: var(--shadow-lg);
  }
  .bar-burger {
    display: inline-flex;
  }
  .bar {
    padding: 8px 10px;
    flex-wrap: wrap;
  }
  .model-select {
    max-width: 190px;
  }
  .settings-grid {
    grid-template-columns: 1fr;
  }
  .col {
    max-width: calc(100% - 42px);
  }
  .hint-right {
    display: none;
  }
}
</style>
