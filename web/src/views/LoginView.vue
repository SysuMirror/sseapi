<template>
  <div class="login">
    <div class="bg" aria-hidden="true" />
    <div class="orb-layer" aria-hidden="true">
      <OrbCanvas :size="560" :points="120" :speed="1" rgb="51,112,255" />
    </div>
    <main class="stage">
      <div class="logo-wrap" aria-hidden="true">
        <span class="decor-ring ring-a" />
        <span class="decor-ring dashed-soft ring-b" />
        <span class="decor-ring ring-c" />
        <img
          class="logo"
          src="/logo.png"
          alt="SSE Market"
          width="88"
          height="88"
        />
      </div>
      <h1 class="title">SSE_Market API 开发平台</h1>
      <p class="sub">使用软工集市账号（UniSSO）登录控制台</p>

      <form class="form" @submit.prevent="submit">
        <label class="field">
          <span class="label">邮箱</span>
          <input
            v-model.trim="email"
            class="input"
            type="email"
            name="email"
            autocomplete="username"
            placeholder="you@example.com"
            required
          />
        </label>
        <label class="field">
          <span class="label">密码</span>
          <input
            v-model="password"
            class="input"
            type="password"
            name="password"
            autocomplete="current-password"
            placeholder="账号密码"
            required
          />
        </label>
        <button class="btn btn-primary cta" type="submit" :disabled="loading">
          {{ loading ? '登录中…' : '登录' }}
        </button>
      </form>
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
import { useRoute, useRouter } from 'vue-router'
import { api } from '../api'
import { saveRedirect, setAuth, consumeRedirect } from '../store/auth'
import OrbCanvas from '../components/OrbCanvas.vue'

const loading = ref(false)
const error = ref('')
const email = ref('')
const password = ref('')
const route = useRoute()
const router = useRouter()

async function submit() {
  loading.value = true
  error.value = ''
  try {
    if (typeof route.query.redirect === 'string') saveRedirect(route.query.redirect)
    const data = await api.login(email.value, password.value)
    setAuth(data.token, data.user)
    await router.replace(consumeRedirect())
  } catch (e) {
    error.value = e instanceof Error ? e.message : '登录失败'
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
/* 旋转节点球：铺在整页背景上，从中心淡出，不抢前景文字 */
.orb-layer {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  pointer-events: none;
  opacity: 0.9;
  -webkit-mask-image: radial-gradient(circle at 50% 42%, #000 22%, transparent 68%);
  mask-image: radial-gradient(circle at 50% 42%, #000 22%, transparent 68%);
  animation: fade-in 1.4s var(--ease) both;
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

/* 三圈同心环，速度/方向各不相同 */
.logo-wrap {
  position: relative;
  width: 148px;
  height: 148px;
  display: grid;
  place-items: center;
  margin-bottom: var(--sp-4);
}
.ring-a {
  inset: 0;
  border-style: solid;
  border-color: rgba(var(--brand-rgb), 0.2);
  animation-duration: 26s;
}
.ring-b {
  inset: 17px;
  animation-duration: 38s;
}
.ring-c {
  inset: 33px;
  border-style: dotted;
  border-color: rgba(var(--brand-rgb), 0.32);
  animation-duration: 16s;
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
  position: relative;
  z-index: 1;
  width: 84px;
  height: 84px;
  object-fit: contain;
  display: block;
  filter: drop-shadow(0 10px 24px rgba(var(--brand-rgb), 0.3));
  animation: float-y 5.5s var(--ease) infinite;
}
.title {
  margin: 0;
  font-size: clamp(22px, 4.2vw, 28px);
  font-weight: 700;
  letter-spacing: -0.032em;
  line-height: 1.25;
  background: linear-gradient(96deg, var(--ink-strong) 22%, var(--brand) 72%);
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: var(--ink-strong);
}
.sub {
  margin: 11px 0 0;
  font-size: var(--fs-md);
  color: var(--ink-soft);
  line-height: 1.5;
}
.form {
  width: 100%;
  margin-top: var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: left;
}
.label {
  font-size: var(--fs-sm);
  color: var(--ink-soft);
}
.input {
  width: 100%;
  padding: 12px 14px;
  font-size: var(--fs-md);
  color: var(--ink-strong);
  background: rgba(255, 255, 255, 0.86);
  border: 1px solid var(--n-200);
  border-radius: var(--radius);
  outline: none;
  transition: border-color 0.15s var(--ease), box-shadow 0.15s var(--ease);
}
.input:focus {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(51, 112, 255, 0.16);
}
.cta {
  width: 100%;
  margin-top: var(--sp-2);
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
