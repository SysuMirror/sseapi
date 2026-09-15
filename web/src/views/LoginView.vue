<template>
  <div class="login">
    <div class="bg" aria-hidden="true" />
    <main class="stage">
      <img
        class="logo"
        src="https://image.ssemarket.cn/i/images/2026/08/26/6420979e-abce-4fc6-9034-bcb86340ee59.png"
        alt="SSE Market"
        width="88"
        height="88"
      />
      <h1 class="title">SSE_Market API 开发平台</h1>
      <p class="sub">使用软工集市账号登录控制台</p>

      <button class="btn btn-primary cta" type="button" :disabled="loading" @click="goLogin">
        {{ loading ? '跳转中…' : '软工集市登录' }}
      </button>
      <p v-if="error" class="error" role="alert">{{ error }}</p>

      <p class="meta">
        <span>控制台 platform.ssemarket.cn</span>
        <span class="dot" aria-hidden="true">·</span>
        <span>API api.ssemarket.cn</span>
      </p>
    </main>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useRoute } from 'vue-router'
import { api } from '../api'
import { saveRedirect } from '../store/auth'

const loading = ref(false)
const error = ref('')
const route = useRoute()

async function goLogin() {
  loading.value = true
  error.value = ''
  try {
    if (typeof route.query.redirect === 'string') saveRedirect(route.query.redirect)
    const data = await api.loginUrl()
    window.location.href = data.authorize_url
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法发起登录'
    loading.value = false
  }
}
</script>

<style scoped>
.login {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--sp-8) var(--sp-5);
  position: relative;
  overflow: hidden;
}
.bg {
  position: absolute;
  inset: 0;
  background:
    radial-gradient(820px 460px at 50% -12%, rgba(51, 112, 255, 0.22), transparent 62%),
    radial-gradient(680px 420px at 100% 105%, rgba(124, 92, 214, 0.14), transparent 58%),
    linear-gradient(180deg, #eef3fc 0%, #f8f9fb 48%, #eef1f6 100%);
}
.bg::after {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.4;
  background-image: linear-gradient(rgba(16, 24, 40, 0.045) 1px, transparent 1px),
    linear-gradient(90deg, rgba(16, 24, 40, 0.045) 1px, transparent 1px);
  background-size: 52px 52px;
  mask-image: radial-gradient(ellipse 68% 58% at 50% 42%, #000 18%, transparent 76%);
}
.stage {
  position: relative;
  z-index: 1;
  width: min(410px, 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  animation: rise 0.55s var(--ease) both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(14px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.logo {
  width: 84px;
  height: 84px;
  object-fit: contain;
  margin-bottom: var(--sp-5);
  display: block;
  filter: drop-shadow(0 8px 20px rgba(51, 112, 255, 0.18));
}
.title {
  margin: 0;
  font-size: clamp(22px, 4.2vw, 28px);
  font-weight: 700;
  letter-spacing: -0.032em;
  line-height: 1.25;
  color: var(--ink-strong);
}
.sub {
  margin: 11px 0 0;
  font-size: var(--fs-md);
  color: var(--ink-soft);
  line-height: 1.5;
}
.cta {
  width: 100%;
  margin-top: var(--sp-8);
  padding: 14px 20px;
  font-size: var(--fs-md);
  border-radius: var(--radius);
  box-shadow: 0 10px 26px rgba(51, 112, 255, 0.28);
}
.cta:hover:not(:disabled) {
  box-shadow: 0 14px 32px rgba(51, 112, 255, 0.34);
}
.cta:disabled {
  opacity: 0.7;
  cursor: wait;
}
.error {
  margin: 14px 0 0;
  color: var(--danger-ink);
  font-size: var(--fs-base);
  line-height: 1.5;
}
.meta {
  margin: var(--sp-8) 0 0;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px 8px;
  font-size: var(--fs-sm);
  color: var(--ink-faint);
}
.dot {
  opacity: 0.6;
}
@media (prefers-reduced-motion: reduce) {
  .stage {
    animation: none;
  }
}
</style>
