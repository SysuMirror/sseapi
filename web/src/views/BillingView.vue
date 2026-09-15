<template>
  <div>
    <h1 class="page-title">余额与计费</h1>
    <p class="page-sub">按 Token 用量扣费；余额不足时 API 返回 402。充值请联系管理员。</p>

    <div class="stats">
      <div class="card stat">
        <div class="label">当前余额</div>
        <div class="value mono">¥{{ balanceYuan }}</div>
      </div>
      <div class="card stat">
        <div class="label">累计充值</div>
        <div class="value mono">¥{{ summary?.totalCreditedYuan?.toFixed(2) ?? '—' }}</div>
      </div>
      <div class="card stat">
        <div class="label">累计消费</div>
        <div class="value mono">¥{{ summary?.totalSpentYuan?.toFixed(2) ?? '—' }}</div>
      </div>
      <div class="card stat">
        <div class="label">累计调用</div>
        <div class="value mono">{{ summary?.totalRequests?.toLocaleString() ?? '—' }}</div>
      </div>
    </div>

    <div class="card panel">
      <div class="panel-h">
        <h3>账户流水</h3>
        <RouterLink class="btn btn-ghost" to="/usage">查看用量明细</RouterLink>
      </div>
      <table class="table" v-if="ledger?.items?.length">
        <thead>
          <tr>
            <th>时间</th>
            <th>类型</th>
            <th>变动</th>
            <th>余额</th>
            <th>备注</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in ledger.items" :key="row.id">
            <td>{{ new Date(row.created_at).toLocaleString() }}</td>
            <td>{{ kindLabel(row.kind) }}</td>
            <td :class="row.amount_cents >= 0 ? 'pos' : 'neg'">
              {{ row.amount_cents >= 0 ? '+' : '' }}¥{{ Number(row.amountYuan).toFixed(2) }}
            </td>
            <td>¥{{ Number(row.balanceAfterYuan).toFixed(2) }}</td>
            <td>{{ row.note }}</td>
          </tr>
        </tbody>
      </table>
      <div v-else class="empty">暂无流水。管理员充值或首次 API 调用后会出现记录。</div>
      <div v-if="ledger && ledger.total > ledger.pageSize" class="pager">
        <button class="btn btn-ghost" type="button" :disabled="page <= 1" @click="goPage(page - 1)">
          上一页
        </button>
        <span class="muted">{{ page }} / {{ totalPages }}</span>
        <button
          class="btn btn-ghost"
          type="button"
          :disabled="page >= totalPages"
          @click="goPage(page + 1)"
        >
          下一页
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { api } from '../api'
import { patchUser } from '../store/auth'

const summary = ref<any>(null)
const ledger = ref<any>(null)
const page = ref(1)

const balanceYuan = computed(() => ((summary.value?.balanceCents ?? 0) / 100).toFixed(2))
const totalPages = computed(() =>
  ledger.value ? Math.max(1, Math.ceil(ledger.value.total / ledger.value.pageSize)) : 1,
)

function kindLabel(k: string) {
  return ({ credit: '充值', usage: '调用扣费', adjust: '调整' } as Record<string, string>)[k] || k
}

async function load() {
  const [sum, led] = await Promise.all([api.billingSummary(), api.ledger(page.value)])
  summary.value = sum
  ledger.value = led
  if (sum?.balanceCents != null) patchUser({ balanceCents: sum.balanceCents })
}

async function goPage(p: number) {
  page.value = p
  ledger.value = await api.ledger(p)
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
.label {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  font-weight: 500;
  margin-bottom: var(--sp-2);
}
.value {
  font-size: var(--fs-2xl);
  font-weight: 700;
  letter-spacing: -0.03em;
  color: var(--ink-strong);
  font-variant-numeric: tabular-nums;
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
  margin: 0;
  font-size: var(--fs-lg);
  font-weight: 650;
}
.pos {
  color: var(--ok-ink);
  font-weight: 600;
}
.neg {
  color: var(--danger-ink);
  font-weight: 600;
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}
@media (max-width: 900px) {
  .stats {
    grid-template-columns: 1fr 1fr;
  }
}
@media (max-width: 560px) {
  .stats {
    grid-template-columns: 1fr;
  }
}
</style>
