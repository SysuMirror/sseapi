<template>
  <div>
    <h1 class="page-title">概览</h1>
    <p class="page-sub">账户余额、近期用量与快捷入口。</p>

    <div class="stats">
      <div class="card stat">
        <div class="label">余额</div>
        <div class="value mono">¥{{ ((summary?.balanceCents || 0) / 100).toFixed(2) }}</div>
      </div>
      <div class="card stat">
        <div class="label">近 {{ days }} 日请求</div>
        <div class="value mono">{{ summary?.totals?.request_count ?? '—' }}</div>
      </div>
      <div class="card stat">
        <div class="label">近 {{ days }} 日 Tokens</div>
        <div class="value mono">{{ formatNum(summary?.totals?.total_tokens) }}</div>
      </div>
      <div class="card stat">
        <div class="label">近 {{ days }} 日消费</div>
        <div class="value mono">¥{{ (summary?.totals?.costYuan ?? 0).toFixed(2) }}</div>
      </div>
    </div>

    <div class="grid">
      <div class="card panel">
        <div class="panel-h">
          <h3>用量趋势</h3>
          <select v-model.number="days" @change="load">
            <option :value="7">7 天</option>
            <option :value="30">30 天</option>
            <option :value="90">90 天</option>
          </select>
        </div>
        <div v-if="!bars.length" class="empty">暂无调用记录</div>
        <div v-else class="chart">
          <div v-for="b in bars" :key="b.day" class="bar-col" :title="`${b.day}: ${b.tokens} tokens`">
            <div class="bar" :style="{ height: `${b.h}%` }" />
            <span>{{ b.day.slice(5) }}</span>
          </div>
        </div>
      </div>

      <div class="card panel">
        <h3>快捷操作</h3>
        <div class="actions">
          <RouterLink class="btn btn-primary" to="/keys">创建 API Key</RouterLink>
          <a class="btn btn-ghost" href="#" @click.prevent="openDocs">阅读文档</a>
          <RouterLink class="btn btn-ghost" to="/models">浏览模型</RouterLink>
          <RouterLink class="btn btn-ghost" to="/usage">详细用量</RouterLink>
        </div>
        <p class="muted tip">
          流程：创建 API 密钥 → 在「模型」页查看 slug 与单价 → 用密钥调用 API → 此处查看用量与扣费。
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../api'
import { patchUser } from '../store/auth'
import { openDocs } from '../store/docs'

const days = ref(30)
const summary = ref<any>(null)

const bars = computed(() => {
  const list = summary.value?.byDay || []
  const max = Math.max(1, ...list.map((x: any) => x.tokens || 0))
  return list.map((x: any) => ({
    day: x.day,
    tokens: x.tokens,
    h: Math.max(4, Math.round(((x.tokens || 0) / max) * 100)),
  }))
})

function formatNum(n?: number) {
  if (n == null) return '—'
  return n.toLocaleString()
}

async function load() {
  summary.value = await api.usageSummary(days.value)
  if (summary.value?.balanceCents != null) {
    patchUser({ balanceCents: summary.value.balanceCents })
  }
}

onMounted(load)
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
.stat {
  padding: var(--sp-5);
}
.stat::after {
  content: '';
  position: absolute;
  left: 0;
  top: 18px;
  bottom: 18px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--brand);
  opacity: 0.85;
}
.stat:nth-child(2)::after {
  background: var(--violet);
}
.stat:nth-child(3)::after {
  background: var(--ok);
}
.stat:nth-child(4)::after {
  background: var(--warn);
}
.label {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  font-weight: 500;
  margin-bottom: 10px;
}
.value {
  font-size: var(--fs-2xl);
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--ink-strong);
  font-variant-numeric: tabular-nums;
}
.grid {
  display: grid;
  grid-template-columns: 1.5fr 1fr;
  gap: var(--sp-4);
}
.panel {
  padding: var(--sp-5);
}
.panel-h {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--sp-4);
}
h3 {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-lg);
  font-weight: 650;
}
.panel-h h3 {
  margin: 0;
}
select {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  background: var(--n-0);
  font-size: var(--fs-sm);
}
.chart {
  display: flex;
  align-items: flex-end;
  gap: 5px;
  height: 180px;
  padding-top: var(--sp-2);
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
  max-width: 30px;
  min-height: 0;
  flex-shrink: 0;
  border-radius: 5px 5px 2px 2px;
  background: linear-gradient(180deg, #6f9dff 0%, var(--brand) 100%);
  transition: filter var(--dur) var(--ease), transform var(--dur) var(--ease);
}
.bar-col:hover .bar {
  filter: saturate(1.25) brightness(1.04);
  transform: scaleY(1.015);
  transform-origin: bottom;
}
.bar-col span {
  font-size: 10px;
  color: var(--ink-faint);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.actions .btn {
  width: 100%;
}
.tip {
  margin-top: var(--sp-4);
  font-size: var(--fs-sm);
  line-height: 1.6;
  padding: var(--sp-3);
  background: var(--n-50);
  border-radius: var(--radius-sm);
  border: 1px solid var(--line);
}
@media (max-width: 900px) {
  .stats,
  .grid {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 560px) {
  .stats,
  .grid,
  .actions {
    grid-template-columns: 1fr;
  }
}
</style>
