<template>
  <div>
    <section class="hero">
      <div class="hero-text">
        <h1 class="page-title">概览</h1>
        <p class="page-sub">账户余额、近期用量与快捷入口。</p>
      </div>
      <div class="hero-orb" aria-hidden="true">
        <OrbCanvas :size="200" :points="84" :speed="1.15" rgb="51,112,255" />
      </div>
    </section>

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

    <!-- 签到已并入首页：不再单独成页，进来就能领 -->
    <section class="card checkin" :class="{ claimed: allClaimed }">
      <div class="checkin-info">
        <span class="checkin-icon" aria-hidden="true">🎁</span>
        <div class="checkin-text">
          <div class="checkin-title">每日签到</div>
          <div class="checkin-desc">
            每日 ¥{{ status?.dailyRewardYuan ?? 5 }}；北京时间 06:30–08:30 另加 ¥{{
              status?.peakRewardYuan ?? 5
            }} 雪峰奖励
          </div>
        </div>
      </div>

      <div class="grants">
        <div class="grant">
          <span class="grant-label">每日奖励</span>
          <span class="grant-state" :class="{ ok: status?.dailyClaimed }">
            {{ status?.dailyClaimed ? '已领取' : '待领取' }}
          </span>
        </div>
        <div class="grant">
          <span class="grant-label">雪峰奖励</span>
          <span
            class="grant-state"
            :class="{ ok: status?.peakClaimed, idle: !status?.peakAvailable && !status?.peakClaimed }"
          >
            {{ status?.peakClaimed ? '已领取' : status?.peakAvailable ? '待领取' : '窗口外' }}
          </span>
        </div>
      </div>

      <button
        class="btn btn-primary checkin-btn"
        type="button"
        :disabled="loading || allClaimed"
        @click="claim"
      >
        {{ loading ? '领取中…' : allClaimed ? '今日已领取' : '领取奖励' }}
      </button>

      <p v-if="message" class="checkin-msg ok" role="status">{{ message }}</p>
      <p v-if="checkinError" class="checkin-msg err" role="alert">{{ checkinError }}</p>
    </section>

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
import { api, type CheckinStatus } from '../api'
import { patchUser } from '../store/auth'
import { openDocs } from '../store/docs'
import OrbCanvas from '../components/OrbCanvas.vue'

const days = ref(30)
const summary = ref<any>(null)

// —— 签到（原 /checkin 页面，已并入首页）——
const status = ref<CheckinStatus | null>(null)
const loading = ref(false)
const message = ref('')
const checkinError = ref('')

const allClaimed = computed(
  () => !!status.value?.dailyClaimed && (!status.value?.peakAvailable || !!status.value?.peakClaimed),
)

async function loadCheckin() {
  try {
    status.value = await api.checkinStatus()
  } catch (e) {
    checkinError.value = e instanceof Error ? e.message : '无法获取签到状态'
  }
}

async function claim() {
  loading.value = true
  message.value = ''
  checkinError.value = ''
  try {
    const r = await api.checkin()
    status.value = r
    if (r.balanceCents != null) patchUser({ balanceCents: r.balanceCents })
    message.value = r.granted?.length
      ? `奖励已到账 ¥${r.rewardYuan ?? 0}`
      : r.message || '今日可领取的奖励已领取'
  } catch (e) {
    checkinError.value = e instanceof Error ? e.message : '领取失败，请稍后重试'
  } finally {
    loading.value = false
  }
}

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

onMounted(() => {
  void load()
  void loadCheckin()
})
</script>

<style scoped>
/* —— 顶部 Hero：标题 + 运行状态 + 旋转节点球 —— */
.hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sp-4);
  margin-bottom: var(--sp-6);
}
.hero-text {
  min-width: 0;
}
.hero .page-title {
  margin-bottom: 6px;
}
.hero .page-sub {
  margin-bottom: 0;
}
.hero-orb {
  flex-shrink: 0;
  animation: fade-in 1s var(--ease) both;
}
@media (max-width: 900px) {
  .hero {
    grid-template-columns: 1fr;
  }
  .hero-orb {
    display: none;
  }
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-4);
  margin-bottom: var(--sp-4);
}
/* —— 签到（并入首页）—— */
.checkin {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1.3fr) auto auto;
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-5);
  margin-bottom: var(--sp-4);
  background-image: linear-gradient(120deg, rgba(var(--brand-rgb), 0.07), rgba(124, 92, 214, 0.06));
  overflow: hidden;
}
/* 成功领取后整卡泛起一圈绿光 */
.checkin.claimed {
  background-image: linear-gradient(120deg, rgba(18, 161, 80, 0.08), rgba(var(--brand-rgb), 0.05));
}
.checkin.claimed::before {
  content: '';
  position: absolute;
  inset: 0;
  box-shadow: inset 0 0 0 1px rgba(18, 161, 80, 0.28);
  pointer-events: none;
}
.checkin-info {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}
.checkin-icon {
  font-size: 30px;
  line-height: 1;
  flex-shrink: 0;
  animation: float-y 5s var(--ease) infinite;
}
.checkin-text {
  min-width: 0;
}
.checkin-title {
  font-size: var(--fs-lg);
  font-weight: 650;
  color: var(--ink-strong);
}
.checkin-desc {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
  margin-top: 3px;
  line-height: 1.5;
}
.grants {
  display: flex;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.grant {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.72);
  border: 1px solid var(--line);
  min-width: 96px;
}
.grant-label {
  font-size: var(--fs-xs);
  color: var(--ink-faint);
  letter-spacing: 0.02em;
}
.grant-state {
  font-size: var(--fs-base);
  font-weight: 650;
  color: var(--ink);
  white-space: nowrap;
}
.grant-state.ok {
  color: var(--ok);
}
.grant-state.idle {
  color: var(--ink-faint);
  font-weight: 500;
}
.checkin-btn {
  white-space: nowrap;
  flex-shrink: 0;
}
.checkin-msg {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--fs-base);
}
.checkin-msg.ok {
  color: var(--ok-ink);
}
.checkin-msg.err {
  color: var(--danger-ink);
}
@media (max-width: 900px) {
  .checkin {
    grid-template-columns: 1fr;
    gap: var(--sp-4);
  }
  .checkin-btn {
    width: 100%;
  }
}
.stat {
  padding: var(--sp-5);
  background-image: radial-gradient(
    120% 90% at 100% 0%,
    rgba(var(--brand-rgb), 0.07),
    transparent 62%
  );
  transition:
    transform var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease);
}
.stat:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
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
  box-shadow: 0 0 10px rgba(var(--brand-rgb), 0.55);
}
/* 顶部渐变高光条 */
.stat::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, rgba(var(--brand-rgb), 0.55), transparent);
  opacity: 0.7;
}
.stat:nth-child(2)::after {
  background: var(--violet);
  box-shadow: 0 0 10px rgba(124, 92, 214, 0.55);
}
.stat:nth-child(3)::after {
  background: var(--ok);
  box-shadow: 0 0 10px rgba(18, 161, 80, 0.5);
}
.stat:nth-child(4)::after {
  background: var(--warn);
  box-shadow: 0 0 10px rgba(224, 128, 0, 0.5);
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
