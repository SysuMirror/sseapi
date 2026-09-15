<template>
  <div>
    <div class="head">
      <div>
        <h1 class="page-title">用量</h1>
        <p class="page-sub">近 3 天 Token 趋势 + 每次调用明细。筛选在表格列标题内。</p>
      </div>
      <button class="btn btn-ghost" type="button" :disabled="loading" @click="refresh">刷新</button>
    </div>

    <!-- 汇总卡片 -->
    <div class="stats">
      <div class="card stat">
        <div class="label">请求</div>
        <div class="value mono">{{ formatNum(detail.total) }}</div>
      </div>
      <div class="card stat">
        <div class="label">Tokens</div>
        <div class="value mono">{{ formatNum(stats.total_tokens) }}</div>
      </div>
      <div class="card stat">
        <div class="label">缓存命中</div>
        <div class="value mono">{{ formatNum(stats.cached_tokens) }}</div>
      </div>
      <div class="card stat">
        <div class="label">消费</div>
        <div class="value mono">¥{{ (stats.costYuan ?? 0).toFixed(4) }}</div>
      </div>
      <div class="card stat">
        <div class="label">错误</div>
        <div class="value mono err">{{ stats.error_count ?? 0 }}</div>
      </div>
    </div>

    <!-- 近 3 天柱状图 -->
    <div class="card panel">
      <h3>近 3 天 Tokens</h3>
      <div class="chart" v-if="daily.length">
        <div
          v-for="b in dailyBars"
          :key="b.bucket"
          class="bar-col"
          :title="`${b.bucket}: ${b.tokens.toLocaleString()} · ¥${b.costYuan}`"
        >
          <div class="bar" :style="{ height: `${b.h}%` }" />
          <span>{{ b.label }}</span>
        </div>
      </div>
      <div v-else class="empty-inline">暂无记录</div>
    </div>

    <!-- 调用明细（筛选在表头） -->
    <div class="card panel">
      <div class="panel-h">
        <h3>调用明细</h3>
        <span class="muted">共 {{ detail.total }} 条 · 第 {{ page }} 页</span>
      </div>

      <div class="table-wrap">
        <table class="table ftable">
          <thead>
            <tr class="flt-row">
              <th>
                <div class="flt-cell">
                  <span class="flt-label">时间</span>
                  <select v-model.number="days" class="flt-select" @change="reload()">
                    <option :value="1">近 1 天</option>
                    <option :value="3">近 3 天</option>
                    <option :value="7">近 7 天</option>
                    <option :value="30">近 30 天</option>
                    <option :value="90">近 90 天</option>
                  </select>
                </div>
              </th>
              <th>
                <div class="flt-cell">
                  <span class="flt-label">模型</span>
                  <select v-model="model" class="flt-select" @change="reload()">
                    <option value="">全部</option>
                    <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
                  </select>
                </div>
              </th>
              <th>
                <div class="flt-cell">
                  <span class="flt-label">类型</span>
                  <select v-model="type" class="flt-select" @change="reload()">
                    <option value="">全部</option>
                    <option value="chat">对话</option>
                    <option value="embedding">Embedding</option>
                    <option value="image_generation">生图</option>
                    <option value="rerank">重排</option>
                  </select>
                </div>
              </th>
              <th class="flt-prompt">提示词</th>
              <th>Prompt</th>
              <th>缓存</th>
              <th>Completion</th>
              <th>费用</th>
              <th>
                <div class="flt-cell">
                  <span class="flt-label">状态</span>
                  <select v-model="status" class="flt-select" @change="reload()">
                    <option value="">全部</option>
                    <option value="ok">成功</option>
                    <option value="error">错误</option>
                  </select>
                </div>
              </th>
            </tr>
            <tr class="col-row">
              <th>时间</th>
              <th>模型</th>
              <th>类型</th>
              <th class="flt-prompt">提示词</th>
              <th>Prompt</th>
              <th>缓存</th>
              <th>Completion</th>
              <th>费用</th>
              <th>状态</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in rows" :key="row.id">
              <td>{{ fmtTime(row.created_at) }}</td>
              <td class="mono">{{ row.model_slug }}</td>
              <td><span class="type-tag">{{ typeLabel(row) }}</span></td>
              <td class="flt-prompt"><span class="prompt-preview" :title="row.prompt || ''">{{ promptPreview(row.prompt) }}</span></td>
              <td>{{ row.prompt_tokens }}</td>
              <td>{{ row.cached_tokens || 0 }}</td>
              <td>{{ row.completion_tokens }}</td>
              <td>¥{{ Number(row.costYuan ?? 0).toFixed(4) }}</td>
              <td>
                <span class="chip" :class="row.status === 'ok' ? 'chip-ok' : 'chip-err'">
                  {{ row.status }}
                </span>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="9" class="empty-inline">暂无调用记录</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="pager" v-if="detail.total > pageSize">
        <button class="btn btn-ghost" :disabled="page <= 1" @click="prevPage">上一页</button>
        <span class="muted">{{ page }} / {{ Math.ceil(detail.total / pageSize) }}</span>
        <button class="btn btn-ghost" :disabled="page * pageSize >= detail.total" @click="nextPage">下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../api'

const days = ref(3)
const model = ref('')
const type = ref('')
const status = ref('')
const page = ref(1)
const pageSize = ref(50)

const rows = ref<any[]>([])
const detail = ref<any>({ total: 0, page: 1, pageSize: 50 })
const stats = ref<any>({})
const daily = ref<any[]>([])
const modelOptions = ref<string[]>([])
const loading = ref(false)

const dailyBars = computed(() => {
  const list = daily.value
  const max = Math.max(1, ...list.map((x: any) => x.tokens || 0))
  return list.map((x: any) => ({
    ...x,
    label: x.bucket.slice(5),
    h: Math.max(4, Math.round(((x.tokens || 0) / max) * 100)),
  }))
})

const TYPE_MAP: Record<string, string> = {
  chat: '对话',
  embedding: 'Embedding',
  image_generation: '生图',
  rerank: '重排',
}

function typeLabel(row: any): string {
  const mt = String(row.model_type || '')
  if (TYPE_MAP[mt]) return TYPE_MAP[mt]
  // 兜底：用模型 slug 启发式
  const slug = String(row.model_slug || '')
  if (slug.includes('embed')) return 'Embedding'
  if (slug.includes('rerank')) return '重排'
  if (slug.includes('image') || slug.includes('dall')) return '生图'
  return '对话'
}

function formatNum(n?: number) {
  if (n == null) return '0'
  return n.toLocaleString()
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
function promptPreview(p: string): string {
  const s = String(p || '')
  if (s.length <= 40) return s || '—'
  return s.slice(0, 40) + '…'
}

function logQuery(): Record<string, string | number> {
  return {
    days: days.value,
    model: model.value,
    type: type.value,
    status: status.value,
    page: page.value,
    page_size: pageSize.value,
  }
}

async function loadLogs() {
  const res = await api.usageLogs(logQuery())
  rows.value = res?.items || []
  detail.value = { total: res?.total || 0, page: res?.page || page.value, pageSize: res?.pageSize || pageSize.value }
}

async function loadStats() {
  const res = await api.usageAggregate({
    days: days.value,
    model: model.value,
    type: type.value,
    status: status.value,
    granularity: 'day',
  })
  stats.value = res?.totals || {}
}

async function loadChart() {
  // 柱状图固定近 3 天，不受筛选影响
  const res = await api.usageAggregate({ days: 3, granularity: 'day' })
  daily.value = res?.daily || []
}

async function loadModelOptions() {
  try {
    const models = await api.models()
    modelOptions.value = models.map((x: any) => x.slug)
  } catch {
    modelOptions.value = []
  }
}

async function reload(preservePage = false) {
  if (!preservePage) page.value = 1
  loading.value = true
  try {
    await Promise.all([loadLogs(), loadStats()])
  } finally {
    loading.value = false
  }
}

async function refresh() {
  await Promise.all([reload(true), loadChart()])
}

async function prevPage() {
  if (page.value <= 1) return
  page.value -= 1
  await reload(true)
}
async function nextPage() {
  page.value += 1
  await reload(true)
}

onMounted(async () => {
  await Promise.all([refresh(), loadModelOptions()])
})
</script>

<style scoped>
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.head .page-title {
  margin-bottom: 4px;
}
.head .page-sub {
  margin: 0;
}
.stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.stat {
  padding: var(--sp-4) var(--sp-5);
}
.stat .label {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  margin-bottom: 7px;
  font-weight: 500;
}
.stat .value {
  font-size: var(--fs-xl);
  font-weight: 700;
  letter-spacing: -0.025em;
  font-variant-numeric: tabular-nums;
}
.stat .value.err {
  color: var(--danger);
}
.panel {
  padding: var(--sp-5);
  margin-bottom: var(--sp-4);
}
.panel:last-child {
  margin-bottom: 0;
}
.panel-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--sp-4);
}
.panel-h h3 {
  margin: 0;
}
h3 {
  margin: 0 0 var(--sp-3);
  font-size: var(--fs-lg);
  font-weight: 650;
}
.chart {
  display: flex;
  align-items: flex-end;
  gap: var(--sp-2);
  height: 170px;
}
.bar-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  min-width: 0;
  height: 100%;
}
.bar {
  width: 100%;
  max-width: 64px;
  min-height: 0;
  flex-shrink: 0;
  border-radius: 6px 6px 2px 2px;
  background: linear-gradient(180deg, #6f9dff 0%, var(--brand) 100%);
  transition: filter var(--dur) var(--ease);
}
.bar-col:hover .bar {
  filter: saturate(1.25) brightness(1.04);
}
.bar-col span {
  font-size: var(--fs-sm);
  color: var(--ink-faint);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.table-wrap {
  overflow-x: auto;
}
.table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--fs-base);
}
.table th,
.table td {
  padding: 9px 11px;
  text-align: left;
  border-bottom: 1px solid var(--line);
  white-space: nowrap;
}
.table th {
  color: var(--ink-soft);
  font-weight: 550;
  font-size: var(--fs-sm);
  background: var(--n-25);
}
.table tbody tr:hover {
  background: var(--n-25);
}
/* 表头筛选行（excel 风格） */
.flt-row th {
  border-bottom: 1px solid var(--line);
  padding: 7px 11px;
  background: var(--n-50);
}
.flt-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 92px;
}
.flt-label {
  font-size: var(--fs-xs);
  color: var(--ink-faint);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.flt-select {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  padding: 4px 7px;
  background: var(--n-0);
  font-size: var(--fs-sm);
  width: 100%;
  max-width: 148px;
}
.col-row th {
  font-size: var(--fs-sm);
}
.mono {
  font-family: var(--mono);
  font-size: var(--fs-sm);
}
.err {
  color: var(--danger);
}
.muted {
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}
.flt-prompt {
  width: 210px;
  min-width: 180px;
}
.prompt-preview {
  display: inline-block;
  max-width: 190px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
  font-size: var(--fs-sm);
}
.type-tag {
  display: inline-block;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  background: var(--n-100);
  color: var(--ink-soft);
  font-size: var(--fs-sm);
  font-weight: 500;
}
.chip {
  display: inline-block;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  font-size: var(--fs-sm);
  font-weight: 600;
}
.chip-ok {
  background: var(--ok-soft);
  color: var(--ok-ink);
}
.chip-err {
  background: var(--danger-soft);
  color: var(--danger-ink);
}
.pager {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  justify-content: center;
  margin-top: var(--sp-4);
}
.empty-inline {
  color: var(--ink-soft);
  font-size: var(--fs-base);
  padding: var(--sp-3) 0;
  text-align: center;
}
@media (max-width: 900px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
@media (max-width: 560px) {
  .stats {
    grid-template-columns: 1fr;
  }
  .head {
    flex-direction: column;
  }
}
</style>
