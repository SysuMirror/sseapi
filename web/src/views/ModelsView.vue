<template>
  <div>
    <h1 class="page-title">模型</h1>
    <p class="page-sub">可调用模型与单价；详情与 API 文档可按需展开。</p>

    <div class="cards" v-if="models.length">
      <article
        v-for="m in models"
        :key="m.id"
        class="card model"
        :style="{ '--accent': m.cardColor || '#3370ff' }"
      >
        <div class="head">
          <div class="head-main">
            <h3>{{ m.displayName }}</h3>
            <button
              class="copy-btn"
              type="button"
              title="复制 model id"
              @click="copySlug(m.slug)"
            >
              {{ m.slug }}
              <span aria-hidden="true">⧉</span>
            </button>
          </div>
          <span v-if="m.badge" class="badge">{{ m.badge }}</span>
        </div>

        <div class="desc-block" v-if="m.description">
          <p class="desc" :class="{ open: expanded[m.id] }">{{ m.description }}</p>
          <button
            v-if="needExpand(m.description)"
            class="link-btn"
            type="button"
            @click="toggle(m.id)"
          >
            {{ expanded[m.id] ? '收起' : '展开' }}
          </button>
        </div>
        <p v-else class="desc muted">暂无描述</p>

        <div class="tags">
          <span class="tag tag-type">{{ m.modelTypeLabel || m.modelType || '对话' }}</span>
          <span v-if="m.multimodalEnabled" class="tag tag-mm">多模态</span>
          <span v-if="m.thinkingEnabled" class="tag tag-think">思考</span>
          <span v-if="m.capabilities?.claude" class="tag tag-claude">Claude</span>
          <span v-if="m.capabilities?.anthropic" class="tag tag-claude">Anthropic</span>
          <span v-if="m.capabilities?.responses" class="tag tag-responses">Responses</span>
          <span v-if="m.hasOriginRestriction" class="tag tag-warn">限域名</span>
          <span class="tag" :class="m.enabled ? 'tag-ok' : 'tag-off'">
            {{ m.enabled ? '可用' : '已下线' }}
          </span>
        </div>

        <div class="actions">
          <button class="btn btn-primary btn-doc" type="button" @click="openDocs">
            API 文档
          </button>
        </div>

        <div class="price-box">
          <div class="price-h">
            <span>价格信息</span>
            <span class="unit">{{
              m.modelType === 'image_generation'
                ? '生图'
                : m.modelType === 'embedding'
                  ? '向量'
                  : m.modelType === 'rerank'
                    ? '重排'
                    : '¥ / 1M Tokens'
            }}</span>
          </div>
          <p v-if="m.apiPath" class="api-path mono">{{ m.apiPath }}</p>
          <template v-if="m.chatProtocols?.length">
            <p v-for="p in m.chatProtocols" :key="p.protocol" class="api-path mono">
              {{ p.label }}: <span class="mono">{{ p.path }}</span>
              <span v-if="!p.viaOwnUpstream" class="hint-inline">(转换兜底)</span>
            </p>
          </template>
          <p v-else-if="m.capabilities?.claude" class="api-path mono">Claude: /v1/messages</p>
          <table class="price-table">
            <thead>
              <tr>
                <th>功能</th>
                <th>价格</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="m.modelType === 'embedding'">
                <td>输入 tokens</td>
                <td class="mono">¥ {{ formatPrice(m.inputPricePer1m) }}</td>
              </tr>
              <tr v-if="m.modelType === 'image_generation' && m.imagePricePerImage">
                <td>生成图片</td>
                <td class="mono">¥ {{ formatPrice(m.imagePricePerImage) }} / 张</td>
              </tr>
              <tr v-if="m.modelType !== 'embedding' && m.modelType !== 'image_generation'">
                <td>输入 tokens</td>
                <td class="mono">¥ {{ formatPrice(m.inputPricePer1m) }}</td>
              </tr>
              <tr v-if="m.modelType === 'chat'">
                <td>缓存命中 tokens</td>
                <td class="mono">¥ {{ formatPrice(m.cachePricePer1m) }}</td>
              </tr>
              <tr v-if="m.modelType !== 'embedding'">
                <td>{{ m.modelType === 'image_generation' ? '输出（无按张价时）' : '输出 tokens' }}</td>
                <td class="mono">¥ {{ formatPrice(m.outputPricePer1m) }}</td>
              </tr>
              <tr v-if="m.multimodalEnabled">
                <td>
                  图片
                  <span class="hint-inline">
                    {{ m.imageBillingMode === 'per_image' ? '按张' : '按 token' }}
                  </span>
                </td>
                <td class="mono">
                  {{
                    m.imageBillingMode === 'per_image'
                      ? `¥ ${formatPrice(m.imagePricePerImage)} / 张`
                      : m.imagePricePer1m
                        ? `¥ ${formatPrice(m.imagePricePer1m)}`
                        : '随输入价'
                  }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </article>
    </div>

    <div v-else class="empty card">暂无模型，请管理员在管理台添加。</div>
    <p v-if="copied" class="toast">已复制 model id</p>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { api } from '../api'
import { openDocs } from '../store/docs'

const models = ref<any[]>([])
const expanded = reactive<Record<number, boolean>>({})
const copied = ref(false)

function formatPrice(v: unknown) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '0'
  return String(parseFloat(n.toFixed(6)))
}

function needExpand(text: string) {
  return String(text || '').trim().length > 72
}

function toggle(id: number) {
  expanded[id] = !expanded[id]
}

async function copySlug(slug: string) {
  try {
    await navigator.clipboard.writeText(slug)
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1600)
  } catch {
    window.prompt('复制 model id', slug)
  }
}

onMounted(async () => {
  models.value = await api.models()
})
</script>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: var(--sp-4);
}
.model {
  padding: var(--sp-5);
  border-top: 3px solid var(--accent, var(--brand));
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  transition: box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.model:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 10px;
}
.head-main {
  min-width: 0;
}
h3 {
  margin: 0 0 6px;
  font-size: var(--fs-lg);
  font-weight: 650;
  letter-spacing: -0.02em;
  line-height: 1.3;
}
.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  border: 1px solid var(--line);
  background: var(--n-50);
  color: var(--ink-soft);
  font-family: var(--mono);
  font-size: var(--fs-sm);
  padding: 4px 9px;
  border-radius: var(--radius-xs);
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease);
}
.copy-btn:hover {
  background: var(--brand-soft);
  color: var(--brand-ink);
  border-color: #cfe0ff;
}
.desc-block {
  position: relative;
}
.desc {
  margin: 0;
  color: var(--ink-soft);
  font-size: var(--fs-base);
  line-height: 1.6;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  white-space: pre-wrap;
  word-break: break-word;
}
.desc.open {
  display: block;
  -webkit-line-clamp: unset;
  overflow: visible;
}
.desc.muted {
  min-height: auto;
}
.link-btn {
  margin-top: 4px;
  border: none;
  background: none;
  padding: 0;
  color: var(--brand);
  font-size: var(--fs-sm);
  font-weight: 600;
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.tag {
  font-size: var(--fs-xs);
  font-weight: 600;
  padding: 3px 9px;
  border-radius: var(--radius-pill);
  background: var(--n-100);
  color: var(--ink-soft);
  line-height: 1.4;
}
.tag-mm {
  background: var(--info-soft);
  color: var(--info-ink);
}
.tag-type {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.tag-think {
  background: var(--violet-soft);
  color: var(--violet-ink);
}
.tag-claude {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.tag-responses {
  background: #fdeef6;
  color: #b02a72;
}
.tag-warn {
  background: var(--warn-soft);
  color: var(--warn-ink);
}
.tag-ok {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.tag-off {
  background: var(--n-100);
  color: var(--ink-soft);
}
.actions {
  display: flex;
  gap: var(--sp-2);
}
.btn-doc {
  width: 100%;
}
.price-box {
  margin-top: 2px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--n-25);
}
.price-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 13px;
  font-size: var(--fs-base);
  font-weight: 650;
  border-bottom: 1px solid var(--line);
  background: var(--n-0);
  color: var(--ink-strong);
}
.unit {
  font-size: var(--fs-xs);
  font-weight: 500;
  color: var(--ink-faint);
}
.api-path {
  margin: 0;
  padding: 8px 13px;
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  border-bottom: 1px solid var(--line);
  background: var(--n-0);
}
.price-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-base);
}
.price-table th,
.price-table td {
  padding: 9px 13px;
  text-align: left;
  border-bottom: 1px solid var(--line);
}
.price-table th {
  font-size: var(--fs-xs);
  font-weight: 600;
  color: var(--ink-faint);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--n-0);
}
.price-table tbody tr:hover {
  background: var(--n-25);
}
.price-table tr:last-child td {
  border-bottom: none;
}
.price-table td:last-child {
  text-align: right;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--ink-strong);
}
.hint-inline {
  margin-left: 6px;
  font-size: var(--fs-xs);
  color: var(--ink-faint);
  font-weight: 400;
}
.toast {
  position: fixed;
  bottom: var(--sp-6);
  left: 50%;
  transform: translateX(-50%);
  background: var(--n-900);
  color: #fff;
  padding: 9px 16px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-base);
  font-weight: 500;
  box-shadow: var(--shadow-lg);
  z-index: 40;
  animation: fade-up 0.2s var(--ease) both;
}
</style>
