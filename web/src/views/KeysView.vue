<template>
  <div>
    <div class="head">
      <div>
        <h1 class="page-title">API Keys</h1>
        <p class="page-sub">
          个人密钥用于对外调用 OpenAI 兼容接口。创建后明文仅展示一次，请妥善保存。
        </p>
      </div>
      <button class="btn btn-primary" type="button" :disabled="creating" @click="openCreate">
        创建密钥
      </button>
    </div>

    <div class="card quick" v-if="cfg">
      <div>
        <div class="quick-label">API 根地址</div>
        <code class="mono">{{ cfg.apiHost }}</code>
        <p class="quick-hint">OpenAI SDK 的 base_url 填此地址，路径含 <code>/v1</code>（如 /chat/completions）。</p>
        <div class="endpoint-list mono" v-if="cfg.endpoints">
          <div v-if="cfg.endpoints.chatCompletions"><span>Chat</span><code>{{ cfg.endpoints.chatCompletions }}</code></div>
          <div v-if="cfg.endpoints.messages"><span>Claude</span><code>{{ cfg.endpoints.messages }}</code></div>
          <div v-if="cfg.endpoints.responses"><span>Responses</span><code>{{ cfg.endpoints.responses }}</code></div>
          <div v-if="cfg.endpoints.embeddings"><span>Embed</span><code>{{ cfg.endpoints.embeddings }}</code></div>
          <div v-if="cfg.endpoints.imagesGenerations"><span>Image</span><code>{{ cfg.endpoints.imagesGenerations }}</code></div>
        </div>
      </div>
      <div class="quick-actions">
        <button class="btn btn-ghost" type="button" @click="copy(cfg.apiHost)">复制地址</button>
        <button class="btn btn-ghost" type="button" @click="openDocs">调用文档</button>
      </div>
    </div>

    <div v-if="created" class="card reveal">
      <div class="reveal-head">
        <strong>密钥已创建 — 请立即复制</strong>
        <span class="warn">关闭后无法再次查看完整密钥</span>
      </div>
      <code class="mono key-plain">{{ created }}</code>
      <div class="reveal-actions">
        <button class="btn btn-primary" type="button" @click="copy(created)">复制密钥</button>
        <button class="btn btn-ghost" type="button" @click="copy(curlExample)">复制 curl 示例</button>
        <button class="btn btn-ghost" type="button" @click="created = ''">我已保存</button>
      </div>
      <pre class="curl mono">{{ curlExample }}</pre>
    </div>

    <!-- 创建弹层 -->
    <div v-if="showForm" class="modal-backdrop" @click.self="closeForm">
      <form class="card modal" @submit.prevent="submitCreate">
        <h3>创建 API Key</h3>
        <div class="field">
          <label>名称</label>
          <input v-model="form.name" required maxlength="64" placeholder="例如：本地开发 / 生产服务" />
        </div>
        <div class="field">
          <label>允许域名（可选）</label>
          <textarea
            v-model="form.allowedOrigins"
            rows="2"
            placeholder="浏览器调用时校验 Origin；留空不限制。例：https://app.example.com"
          />
        </div>
        <p v-if="formError" class="error">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn btn-primary" type="submit" :disabled="creating">
            {{ creating ? '创建中…' : '生成密钥' }}
          </button>
          <button class="btn btn-ghost" type="button" @click="closeForm">取消</button>
        </div>
      </form>
    </div>

    <div class="card">
      <table class="table" v-if="keys.length">
        <thead>
          <tr>
            <th>名称</th>
            <th>前缀</th>
            <th>域名限制</th>
            <th>创建时间</th>
            <th>最近使用</th>
            <th>状态</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in keys" :key="k.id">
            <td>{{ k.name }}</td>
            <td class="mono">{{ k.key_prefix }}…</td>
            <td class="small">{{ k.allowed_origins?.trim() ? '已限制' : '不限' }}</td>
            <td>{{ fmt(k.created_at) }}</td>
            <td>{{ k.last_used_at ? fmt(k.last_used_at) : '—' }}</td>
            <td>
              <span class="badge" :class="{ off: k.revoked_at }">{{
                k.revoked_at ? '已吊销' : '有效'
              }}</span>
            </td>
            <td class="actions">
              <button
                v-if="!k.revoked_at"
                class="btn btn-ghost"
                type="button"
                @click="editOrigins(k)"
              >
                域名
              </button>
              <button
                v-if="!k.revoked_at"
                class="btn btn-danger"
                type="button"
                @click="revoke(k.id)"
              >
                吊销
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">
        <p>还没有密钥。</p>
        <button class="btn btn-primary" type="button" @click="openCreate">创建第一个 API Key</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../api'
import { openDocs } from '../store/docs'

const keys = ref<any[]>([])
const cfg = ref<any>(null)
const created = ref('')
const creating = ref(false)
const showForm = ref(false)
const formError = ref('')
const form = ref({ name: 'default', allowedOrigins: '' })

const curlExample = computed(() => {
  const host = cfg.value?.apiHost || 'https://api.ssemarket.cn'
  const key = created.value || 'sk-your-api-key'
  return `curl ${host}/v1/chat/completions \\
  -H "Authorization: Bearer ${key}" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"your-model-slug","messages":[{"role":"user","content":"你好"}]}'`
})

async function load() {
  const [list, config] = await Promise.all([api.keys(), api.keysConfig()])
  keys.value = list
  cfg.value = config
}

function openCreate() {
  form.value = { name: 'default', allowedOrigins: '' }
  formError.value = ''
  showForm.value = true
}

function closeForm() {
  showForm.value = false
  formError.value = ''
}

async function submitCreate() {
  creating.value = true
  formError.value = ''
  try {
    const row = await api.createKey(form.value.name.trim(), form.value.allowedOrigins.trim())
    created.value = row.key
    closeForm()
    await load()
  } catch (e) {
    formError.value = e instanceof Error ? e.message : '创建失败'
  } finally {
    creating.value = false
  }
}

async function editOrigins(k: any) {
  const origins = window.prompt('允许域名（留空=不限制）', k.allowed_origins || '')
  if (origins == null) return
  await api.patchKey(k.id, { allowedOrigins: origins })
  await load()
}

async function revoke(id: number) {
  if (!confirm('确认吊销？吊销后该密钥立即失效，且无法恢复。')) return
  await api.revokeKey(id)
  await load()
}

function copy(text: string) {
  navigator.clipboard.writeText(text)
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString()
}

onMounted(load)
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.head .page-sub {
  margin-bottom: 0;
}
.quick {
  padding: var(--sp-4) var(--sp-5);
  margin-bottom: var(--sp-4);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.quick-label {
  font-size: var(--fs-xs);
  color: var(--ink-soft);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 5px;
}
.quick code.mono {
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--ink-strong);
}
.quick-hint {
  margin: 7px 0 0;
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  line-height: 1.5;
}
.quick-hint code {
  font-family: var(--mono);
  font-size: 11px;
  background: var(--n-75);
  border: 1px solid var(--line);
  border-radius: 5px;
  padding: 1px 5px;
}
.endpoint-list {
  margin-top: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: var(--fs-sm);
}
.endpoint-list div {
  display: flex;
  gap: 10px;
  align-items: baseline;
}
.endpoint-list span {
  min-width: 66px;
  color: var(--ink-faint);
  font-family: var(--font-sans);
  font-size: var(--fs-xs);
  font-weight: 600;
  letter-spacing: 0.03em;
  text-transform: uppercase;
}
.endpoint-list code {
  font-size: var(--fs-sm);
  word-break: break-all;
  color: var(--ink-soft);
}
.quick-actions {
  display: flex;
  gap: var(--sp-2);
}
.reveal {
  margin-bottom: var(--sp-4);
  padding: var(--sp-5);
  background: var(--brand-softer);
  border-color: #cfe0ff;
  box-shadow: 0 0 0 1px rgba(51, 112, 255, 0.04), var(--shadow-sm);
}
.reveal-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: baseline;
  margin-bottom: var(--sp-3);
}
.reveal-head strong {
  font-size: var(--fs-md);
  color: var(--brand-ink);
}
.warn {
  font-size: var(--fs-sm);
  color: var(--warn-ink);
  font-weight: 500;
}
.key-plain {
  display: block;
  word-break: break-all;
  padding: 11px 13px;
  background: var(--n-0);
  border-radius: var(--radius-sm);
  border: 1px solid #cfe0ff;
  margin-bottom: var(--sp-3);
  font-size: var(--fs-base);
  color: var(--ink-strong);
}
.reveal-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.curl {
  margin: 0;
  padding: 13px 15px;
  background: var(--n-900);
  color: #dbe4f0;
  border-radius: var(--radius-sm);
  font-size: var(--fs-sm);
  overflow-x: auto;
  white-space: pre-wrap;
  line-height: 1.6;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.5);
  backdrop-filter: blur(3px);
  display: grid;
  place-items: center;
  z-index: 50;
  padding: var(--sp-4);
  animation: fade-in 0.16s var(--ease) both;
}
@keyframes fade-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.modal {
  width: min(460px, 100%);
  padding: var(--sp-6);
  box-shadow: var(--shadow-lg);
  animation: pop 0.22s var(--ease) both;
}
@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
.modal h3 {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-lg);
}
.field {
  margin-bottom: var(--sp-4);
}
.field label {
  display: block;
  font-size: var(--fs-sm);
  font-weight: 600;
  margin-bottom: 6px;
  color: var(--ink);
}
.field input,
.field textarea {
  width: 100%;
}
.modal-actions {
  display: flex;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}
.error {
  color: var(--danger-ink);
  font-size: var(--fs-base);
  margin-bottom: var(--sp-2);
}
.badge.off {
  background: var(--n-100);
  color: var(--ink-soft);
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.small {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}
.empty {
  text-align: center;
  padding: var(--sp-10) var(--sp-4);
}
.empty p {
  margin: 0 0 var(--sp-4);
  color: var(--ink-soft);
}
</style>
